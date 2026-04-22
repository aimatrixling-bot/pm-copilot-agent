#!/usr/bin/env pwsh
# PM Copilot Windows 正式发布构建脚本
# 构建 NSIS 安装包和便携版 ZIP
# 支持 Windows x64

param(
    [switch]$SkipTypeCheck,
    [switch]$SkipPortable
)

$ErrorActionPreference = "Stop"
$BuildSuccess = $false

try {
    $ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    Set-Location $ProjectDir

    # 读取版本号
    $TauriConf = Get-Content "src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json
    $Version = $TauriConf.version
    $TauriConfPath = Join-Path $ProjectDir "src-tauri\tauri.conf.json"
    $EnvFile = Join-Path $ProjectDir ".env"

    Write-Host ""
    Write-Host "=========================================" -ForegroundColor Cyan
    Write-Host "  PM Copilot Windows 发布构建" -ForegroundColor Green
    Write-Host "  Version: $Version" -ForegroundColor Blue
    Write-Host "=========================================" -ForegroundColor Cyan
    Write-Host ""

    # ========================================
    # 版本同步检查
    # ========================================
    $PkgJson = Get-Content "package.json" -Raw | ConvertFrom-Json
    $PkgVersion = $PkgJson.version

    $CargoToml = Get-Content "src-tauri\Cargo.toml" -Raw
    $CargoVersionMatch = [regex]::Match($CargoToml, 'version = "([^"]+)"')
    $CargoVersion = if ($CargoVersionMatch.Success) { $CargoVersionMatch.Groups[1].Value } else { "" }

    if ($PkgVersion -ne $Version -or $PkgVersion -ne $CargoVersion) {
        Write-Host "版本号不一致:" -ForegroundColor Yellow
        Write-Host "  package.json:    $PkgVersion" -ForegroundColor Cyan
        Write-Host "  tauri.conf.json: $Version" -ForegroundColor Cyan
        Write-Host "  Cargo.toml:      $CargoVersion" -ForegroundColor Cyan
        Write-Host ""
        $sync = Read-Host "是否同步版本号到 $PkgVersion? (y/N)"
        if ($sync -eq "y" -or $sync -eq "Y") {
            & node "$ProjectDir\scripts\sync-version.js"
            $Version = $PkgVersion
            Write-Host ""
        }
    }

    # ========================================
    # 加载环境变量
    # ========================================
    Write-Host "[1/7] 加载环境配置..." -ForegroundColor Blue

    if (Test-Path $EnvFile) {
        # 加载 .env (支持行内注释)
        Get-Content $EnvFile | ForEach-Object {
            if ($_ -match '^([^#=]+)=(.*)$') {
                $name = $Matches[1].Trim()
                $value = $Matches[2].Trim()

                # 处理带引号的值（提取引号内的内容，忽略引号外的注释）
                if ($value -match '^"([^"]*)"' -or $value -match "^'([^']*)'") {
                    $value = $Matches[1]
                } else {
                    # 无引号的值，移除行内注释
                    $value = $value -replace '\s+#.*$', ''
                    $value = $value.Trim()
                }

                [Environment]::SetEnvironmentVariable($name, $value, "Process")
            }
        }
        Write-Host "  OK - 已加载 .env" -ForegroundColor Green
    }
    else {
        Write-Host "  警告: .env 文件不存在，将使用默认配置" -ForegroundColor Yellow
    }

    # 检查 Tauri 签名密钥
    $TauriSigningKey = [Environment]::GetEnvironmentVariable("TAURI_SIGNING_PRIVATE_KEY", "Process")
    if (-not $TauriSigningKey) {
        Write-Host ""
        Write-Host "=========================================" -ForegroundColor Yellow
        Write-Host "  警告: TAURI_SIGNING_PRIVATE_KEY 未设置" -ForegroundColor Yellow
        Write-Host "  自动更新功能将不可用!" -ForegroundColor Yellow
        Write-Host "=========================================" -ForegroundColor Yellow
        Write-Host ""
        $continue = Read-Host "是否继续构建? (Y/n)"
        if ($continue -eq "n" -or $continue -eq "N") {
            Write-Host "构建已取消" -ForegroundColor Red
            throw "用户取消构建"
        }
    }
    else {
        Write-Host "  OK - Tauri 签名私钥已配置" -ForegroundColor Green
    }
    Write-Host ""

    # ========================================
    # 检查依赖
    # ========================================
    Write-Host "[2/7] 检查依赖..." -ForegroundColor Blue

    function Test-Command {
        param([string]$Command, [string]$HelpUrl)
        try {
            $null = Invoke-Expression $Command 2>&1
            return $true
        }
        catch {
            Write-Host "  X - $Command 未安装" -ForegroundColor Red
            Write-Host "      请安装: $HelpUrl" -ForegroundColor Yellow
            return $false
        }
    }

    $depOk = $true
    if (-not (Test-Command "rustc --version" "https://rustup.rs")) { $depOk = $false }
    if (-not (Test-Command "npm --version" "https://nodejs.org")) { $depOk = $false }
    if (-not (Test-Command "bun --version" "https://bun.sh")) { $depOk = $false }

    # 检查 Rust Windows 目标
    $installedTargets = & rustup target list --installed 2>$null
    if ($installedTargets -notcontains "x86_64-pc-windows-msvc") {
        Write-Host "  安装 Rust 目标: x86_64-pc-windows-msvc" -ForegroundColor Yellow
        & rustup target add x86_64-pc-windows-msvc
    }
    else {
        Write-Host "  OK - Rust 目标已安装: x86_64-pc-windows-msvc" -ForegroundColor Green
    }

    if (-not $depOk) {
        throw "请先安装缺失的依赖"
    }

    # 检查构建必需文件
    $bunBinaryPath = "src-tauri\binaries\bun-x86_64-pc-windows-msvc.exe"
    Write-Host "  检查 bundled bun... " -NoNewline
    if (Test-Path $bunBinaryPath) {
        Write-Host "OK" -ForegroundColor Green
    } else {
        Write-Host "MISSING" -ForegroundColor Red
        Write-Host "    请先运行 .\setup_windows.ps1 下载 Bun 二进制" -ForegroundColor Yellow
        $depOk = $false
    }

    $nodejsPath = "src-tauri\resources\nodejs\node.exe"
    $NodeDir = "src-tauri\resources\nodejs"
    Write-Host "  检查 bundled Node.js... " -NoNewline
    if (Test-Path $nodejsPath) {
        Write-Host "OK (exists)" -ForegroundColor Green
        # Node.js 已存在，但仍需确保 npm 已升级（首次下载后未升级的遗留情况）
        $npmDir = Join-Path $NodeDir "node_modules\npm"
        $nodeExe = Join-Path $NodeDir "node.exe"
        if (Test-Path $npmDir) {
            $npmCli = Join-Path $npmDir "bin\npm-cli.js"
            $curVer = & $nodeExe $npmCli --version 2>&1
            # npm 11.9.0 has minizlib CJS bug — must upgrade
            if ("$curVer" -match "^11\.[0-9]\.") {
                Write-Host "    npm v$curVer 需要升级..." -ForegroundColor Yellow
                try {
                    $npmTmpDir = Join-Path $env:TEMP "npm_upgrade_$(Get-Random)"
                    New-Item -ItemType Directory -Path $npmTmpDir -Force | Out-Null
                    $registryJson = Invoke-RestMethod -Uri "https://registry.npmjs.org/npm/latest" -TimeoutSec 30
                    $tarballUrl = $registryJson.dist.tarball
                    $tgzPath = Join-Path $npmTmpDir "npm.tgz"
                    Invoke-WebRequest -Uri $tarballUrl -OutFile $tgzPath -TimeoutSec 60
                    tar -xzf $tgzPath -C $npmTmpDir 2>&1 | Out-Null
                    $extractedPkg = Join-Path $npmTmpDir "package"
                    if (Test-Path $extractedPkg) {
                        Remove-Item -Recurse -Force $npmDir
                        Move-Item -Path $extractedPkg -Destination $npmDir
                        $newVer = & $nodeExe (Join-Path $npmDir "bin\npm-cli.js") --version 2>&1
                        Write-Host "    npm 升级: v$curVer → v$newVer ✓" -ForegroundColor Green
                    }
                    Remove-Item -Recurse -Force $npmTmpDir -ErrorAction SilentlyContinue
                } catch {
                    Write-Host "    npm 升级失败: $_" -ForegroundColor Red
                }
            } else {
                Write-Host "    npm v$curVer ✓" -ForegroundColor Green
            }
        }
    } else {
        Write-Host "MISSING - downloading..." -ForegroundColor Yellow
        # Auto-download Node.js if setup_windows.ps1 was not run
        try {
            $NodeVersion = "24.14.0"
            $NodeDir = "src-tauri\resources\nodejs"
            $ZipName = "node-v$NodeVersion-win-x64.zip"
            $TempZip = Join-Path $env:TEMP "node-windows.zip"
            $TempDir = Join-Path $env:TEMP "node-windows-extract"
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            Invoke-WebRequest -Uri "https://nodejs.org/dist/v$NodeVersion/$ZipName" -OutFile $TempZip -UseBasicParsing -TimeoutSec 300
            if (Test-Path $TempDir) { Remove-Item -Recurse -Force $TempDir }
            Expand-Archive -Path $TempZip -DestinationPath $TempDir -Force
            $ExtractedDir = Join-Path $TempDir "node-v$NodeVersion-win-x64"
            if (Test-Path $NodeDir) { Remove-Item -Recurse -Force $NodeDir }
            New-Item -ItemType Directory -Path $NodeDir -Force | Out-Null
            # Copy top-level files
            Copy-Item (Join-Path $ExtractedDir "node.exe") $NodeDir -Force
            Copy-Item (Join-Path $ExtractedDir "npm.cmd") $NodeDir -Force
            Copy-Item (Join-Path $ExtractedDir "npx.cmd") $NodeDir -Force
            Copy-Item (Join-Path $ExtractedDir "npm") $NodeDir -Force
            Copy-Item (Join-Path $ExtractedDir "npx") $NodeDir -Force
            # Use robocopy for node_modules — Copy-Item -Recurse silently skips
            # files beyond MAX_PATH (260 chars), corrupting npm's minizlib/minipass
            $SrcMod = Join-Path $ExtractedDir "node_modules"
            $DstMod = Join-Path $NodeDir "node_modules"
            if (Test-Path $SrcMod) {
                & robocopy $SrcMod $DstMod /E /NFL /NDL /NJH /NJS /NC /NS /NP | Out-Null
                if ($LASTEXITCODE -ge 8) { throw "robocopy failed: exit $LASTEXITCODE" }
            }
            if (Test-Path $TempZip) { Remove-Item -Force $TempZip }
            if (Test-Path $TempDir) { Remove-Item -Recurse -Force $TempDir }
            # Upgrade npm — bundled npm 11.9.0 has minizlib CJS bug on Windows.
            # CANNOT use `npm install npm@latest` (catch-22: broken npm can't upgrade itself).
            # Download npm tarball directly with Invoke-WebRequest + tar (Win10+ built-in).
            $npmDir = Join-Path $NodeDir "node_modules\npm"
            if (Test-Path $npmDir) {
                Write-Host "    升级 npm (curl + tar)..." -NoNewline
                try {
                    $nodeExe = Join-Path $NodeDir "node.exe"
                    $oldNpmCli = Join-Path $npmDir "bin\npm-cli.js"
                    $oldVer = if (Test-Path $oldNpmCli) { & $nodeExe $oldNpmCli --version 2>&1 } else { "unknown" }
                    Write-Host " 当前 v$oldVer" -NoNewline

                    $npmTmpDir = Join-Path $env:TEMP "npm_upgrade_$(Get-Random)"
                    New-Item -ItemType Directory -Path $npmTmpDir -Force | Out-Null
                    $registryJson = Invoke-RestMethod -Uri "https://registry.npmjs.org/npm/latest" -TimeoutSec 30
                    $tarballUrl = $registryJson.dist.tarball
                    Write-Host " → 下载 $($registryJson.version)..." -NoNewline
                    $tgzPath = Join-Path $npmTmpDir "npm.tgz"
                    Invoke-WebRequest -Uri $tarballUrl -OutFile $tgzPath -TimeoutSec 60
                    tar -xzf $tgzPath -C $npmTmpDir 2>&1 | Out-Null
                    $extractedPkg = Join-Path $npmTmpDir "package"
                    if (Test-Path $extractedPkg) {
                        Remove-Item -Recurse -Force $npmDir
                        Move-Item -Path $extractedPkg -Destination $npmDir
                        $newNpmCli = Join-Path $npmDir "bin\npm-cli.js"
                        $newVer = & $nodeExe $newNpmCli --version 2>&1
                        Write-Host " → v$newVer ✓" -ForegroundColor Green
                    } else {
                        Write-Host " 解压失败 (package/ 目录不存在)" -ForegroundColor Red
                    }
                    Remove-Item -Recurse -Force $npmTmpDir -ErrorAction SilentlyContinue
                } catch {
                    Write-Host " 下载失败: $_ " -ForegroundColor Red
                    Write-Host "    ⚠ npm 未升级，插件安装可能失败" -ForegroundColor Yellow
                    Remove-Item -Recurse -Force $npmTmpDir -ErrorAction SilentlyContinue
                }
            }
            Write-Host "    OK - Node.js downloaded" -ForegroundColor Green
        } catch {
            Write-Host "    下载失败，请先运行 .\setup_windows.ps1" -ForegroundColor Red
            $depOk = $false
        }
    }

    $gitInstallerPath = "src-tauri\nsis\Git-Installer.exe"
    Write-Host "  检查 Git installer... " -NoNewline
    if (Test-Path $gitInstallerPath) {
        Write-Host "OK" -ForegroundColor Green
    } else {
        Write-Host "MISSING" -ForegroundColor Red
        Write-Host "    请先运行 .\setup_windows.ps1 下载 Git 安装包" -ForegroundColor Yellow
        $depOk = $false
    }

    # VC++ Runtime DLL (app-local deployment for bun.exe)
    $resDir = "src-tauri\resources"
    $vcDlls = @("vcruntime140.dll", "vcruntime140_1.dll")
    Write-Host "  检查 VC++ Runtime DLL... " -NoNewline
    $allPresent = $true
    foreach ($dll in $vcDlls) {
        if (-not (Test-Path (Join-Path $resDir $dll))) { $allPresent = $false; break }
    }
    if ($allPresent) {
        Write-Host "OK" -ForegroundColor Green
    } else {
        # Auto-extract from system if not present (dev machine always has MSVC)
        $systemDll = "$env:SystemRoot\System32\vcruntime140.dll"
        if (Test-Path $systemDll) {
            if (-not (Test-Path $resDir)) { New-Item -ItemType Directory -Path $resDir -Force | Out-Null }
            foreach ($dll in $vcDlls) {
                $src = "$env:SystemRoot\System32\$dll"
                if (Test-Path $src) {
                    Copy-Item $src (Join-Path $resDir $dll) -Force
                }
            }
            Write-Host "OK (auto-extracted)" -ForegroundColor Green
        } else {
            Write-Host "MISSING" -ForegroundColor Red
            Write-Host "    请先运行 .\setup_windows.ps1 提取 VC++ Runtime DLL" -ForegroundColor Yellow
            $depOk = $false
        }
    }

    if (-not $depOk) {
        throw "缺少构建必需文件，请运行 .\setup_windows.ps1"
    }

    Write-Host "  OK - 依赖检查通过" -ForegroundColor Green
    Write-Host ""

    # ========================================
    # 验证 CSP 配置（不再覆盖）
    # ========================================
    Write-Host "[3/7] 验证 CSP 配置..." -ForegroundColor Blue

    $conf = Get-Content $TauriConfPath -Raw | ConvertFrom-Json
    $currentCsp = $conf.app.security.csp

    # 验证关键 CSP 指令是否存在
    $requiredCspParts = @(
        "http://ipc.localhost",
        "asset:",
        "https://download.pm-copilot.io"
    )

    $missingParts = @()
    foreach ($part in $requiredCspParts) {
        if ($currentCsp -notlike "*$part*") {
            $missingParts += $part
        }
    }

    # 特殊验证: fetch-src 指令必须包含 http://ipc.localhost (Windows Tauri IPC 关键)
    if ($currentCsp -match "fetch-src\s+([^;]+)") {
        $fetchSrcDirective = $matches[1]
        if ($fetchSrcDirective -notlike "*http://ipc.localhost*") {
            $missingParts += "fetch-src 缺少 http://ipc.localhost (Windows 必需)"
        }
    } else {
        $missingParts += "fetch-src 指令"
    }

    if ($missingParts.Count -gt 0) {
        Write-Host "  错误: CSP 配置不符合 Windows 要求:" -ForegroundColor Red
        $missingParts | ForEach-Object { Write-Host "    - $_" -ForegroundColor Red }
        Write-Host ""
        Write-Host "  Windows Tauri IPC 需要 fetch-src 包含 http://ipc.localhost" -ForegroundColor Yellow
        Write-Host "  请检查 tauri.conf.json 中的 CSP 配置" -ForegroundColor Yellow
        Write-Host ""
        throw "CSP 配置不完整，无法在 Windows 上正常运行"
    } else {
        Write-Host "  OK - CSP 配置完整 (包含 Windows IPC 支持)" -ForegroundColor Green
    }
    Write-Host ""

    # ========================================
    # 初始化 MSVC 编译环境 (link.exe / cl.exe)
    # ========================================
    if (-not (Get-Command link.exe -ErrorAction SilentlyContinue)) {
        Write-Host "[准备] 初始化 MSVC 编译环境..." -ForegroundColor Blue
        $vcFound = $false

        # Find vcvarsall.bat via vswhere
        $programFilesX86 = [Environment]::GetFolderPath("ProgramFilesX86")
        $vsWhere = Join-Path $programFilesX86 "Microsoft Visual Studio\Installer\vswhere.exe"
        if (Test-Path $vsWhere) {
            $vsPath = & $vsWhere -latest -products * -property installationPath 2>$null
            if ($vsPath) {
                $vcvarsall = Join-Path $vsPath "VC\Auxiliary\Build\vcvarsall.bat"
                if (Test-Path $vcvarsall) {
                    Write-Host "  找到: $vcvarsall" -ForegroundColor Cyan
                    # Import environment variables from vcvarsall into PowerShell
                    $tempFile = [System.IO.Path]::GetTempFileName()
                    cmd /c "`"$vcvarsall`" x64 > nul 2>&1 && set > `"$tempFile`""
                    Get-Content $tempFile | ForEach-Object {
                        if ($_ -match '^([^=]+)=(.*)$') {
                            [System.Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process')
                        }
                    }
                    Remove-Item $tempFile -ErrorAction SilentlyContinue
                    $vcFound = $true
                    Write-Host "  OK - MSVC x64 环境已加载" -ForegroundColor Green
                }
            }
        }

        if (-not $vcFound) {
            Write-Host "  未找到 vcvarsall.bat，Rust 编译可能失败" -ForegroundColor Yellow
            Write-Host "  建议从 Developer PowerShell for VS 运行此脚本" -ForegroundColor Yellow
        }
        Write-Host ""
    }

    # ========================================
    # 清理旧构建（包括缓存的 resources）
    # ========================================
    Write-Host "[准备] 清理旧构建..." -ForegroundColor Blue

    # 杀死残留进程（避免文件锁定）
    $bunProcesses = Get-Process | Where-Object { $_.ProcessName -eq "bun" }
    $appProcesses = Get-Process | Where-Object { $_.ProcessName -eq "PM Copilot" }

    if ($bunProcesses) {
        $bunProcesses | Stop-Process -Force -ErrorAction SilentlyContinue
        Write-Host "  清理了 $($bunProcesses.Count) 个 Bun 进程" -ForegroundColor Gray
    }

    if ($appProcesses) {
        $appProcesses | Stop-Process -Force -ErrorAction SilentlyContinue
        Write-Host "  清理了 $($appProcesses.Count) 个 PM Copilot 进程" -ForegroundColor Gray
    }

    # 验证进程清理完成（最多等待 2 秒）
    $maxWait = 20  # 20 * 100ms = 2s
    $waited = 0
    while ($waited -lt $maxWait) {
        $remainingBun = Get-Process -Name "bun" -ErrorAction SilentlyContinue
        $remainingApp = Get-Process -Name "PM Copilot" -ErrorAction SilentlyContinue
        if (-not $remainingBun -and -not $remainingApp) {
            break
        }
        Start-Sleep -Milliseconds 100
        $waited++
    }

    if ($waited -gt 0) {
        Write-Host "  进程清理验证完成 (耗时 $($waited * 100)ms)" -ForegroundColor Gray
    }

    # 清理构建输出目录
    $dirsToClean = @(
        @{ Path = "dist"; Name = "前端构建输出" },
        @{ Path = "src-tauri\target\x86_64-pc-windows-msvc\release\bundle"; Name = "打包输出" },
        @{ Path = "src-tauri\target\x86_64-pc-windows-msvc\release\resources"; Name = "resources 缓存 (CRITICAL)" }
    )

    foreach ($dir in $dirsToClean) {
        if (Test-Path $dir.Path) {
            try {
                Remove-Item -Recurse -Force $dir.Path -ErrorAction Stop
                Write-Host "  已清理: $($dir.Name)" -ForegroundColor Gray
            } catch {
                Write-Host "  警告: 清理 $($dir.Name) 失败: $_" -ForegroundColor Yellow
                Write-Host "  路径: $($dir.Path)" -ForegroundColor Yellow
                # 不抛出异常，继续构建
            }
        }
    }

    Write-Host "  OK - 清理完成（含 resources 缓存）" -ForegroundColor Green
    Write-Host ""

    # ========================================
    # TypeScript 类型检查
    # ========================================
    if (-not $SkipTypeCheck) {
        Write-Host "[4/7] TypeScript 类型检查..." -ForegroundColor Blue
        & bun run typecheck
        if ($LASTEXITCODE -ne 0) {
            throw "TypeScript 检查失败，请修复后重试"
        }
        Write-Host "  OK - TypeScript 检查通过" -ForegroundColor Green
        Write-Host ""
    }
    else {
        Write-Host "[4/7] 跳过 TypeScript 类型检查" -ForegroundColor Yellow
        Write-Host ""
    }

    # ========================================
    # 构建前端和服务端
    # ========================================
    Write-Host "[5/7] 构建前端和服务端..." -ForegroundColor Blue

    # 打包服务端代码
    Write-Host "  打包服务端代码..." -ForegroundColor Cyan
    $resourcesDir = Join-Path $ProjectDir "src-tauri\resources"
    if (-not (Test-Path $resourcesDir)) {
        New-Item -ItemType Directory -Path $resourcesDir -Force | Out-Null
    }

    & bun build ./src/server/index.ts --outfile=./src-tauri/resources/server-dist.js --target=bun
    if ($LASTEXITCODE -ne 0) {
        throw "服务端打包失败"
    }

    # 验证打包结果不包含硬编码路径
    $serverDist = Get-Content "src-tauri\resources\server-dist.js" -Raw
    if ($serverDist -match 'var __dirname = "/Users/[^"]+"') {
        throw "server-dist.js 包含硬编码的 __dirname 路径!"
    }
    Write-Host "    OK - 服务端代码验证通过" -ForegroundColor Green

    # 打包 Plugin Bridge 代码 (OpenClaw channel plugin 支持)
    Write-Host "  打包 Plugin Bridge..." -ForegroundColor Cyan
    & bun build ./src/server/plugin-bridge/index.ts --outfile=./src-tauri/resources/plugin-bridge-dist.js --target=bun
    if ($LASTEXITCODE -ne 0) {
        throw "Plugin Bridge 打包失败"
    }
    Write-Host "    OK - Plugin Bridge 打包完成" -ForegroundColor Green

    # 复制 SDK 依赖
    Write-Host "  复制 SDK 依赖..." -ForegroundColor Cyan
    $sdkSrc = Join-Path $ProjectDir "node_modules\@anthropic-ai\claude-agent-sdk"
    $sdkDest = Join-Path $ProjectDir "src-tauri\resources\claude-agent-sdk"

    if (-not (Test-Path $sdkSrc)) {
        throw "SDK 目录不存在: $sdkSrc"
    }

    if (Test-Path $sdkDest) {
        Remove-Item -Recurse -Force $sdkDest
    }
    New-Item -ItemType Directory -Path $sdkDest -Force | Out-Null

    Copy-Item "$sdkSrc\cli.js" $sdkDest -Force
    Copy-Item "$sdkSrc\sdk.mjs" $sdkDest -Force
    Copy-Item "$sdkSrc\*.wasm" $sdkDest -Force
    Copy-Item "$sdkSrc\vendor" $sdkDest -Recurse -Force
    Write-Host "    OK - SDK 依赖复制完成" -ForegroundColor Green

    # 预装 agent-browser CLI（使用预生成的 lockfile 避免耗时的依赖解析）
    Write-Host "  预装 agent-browser CLI..." -ForegroundColor Cyan
    $agentBrowserDir = Join-Path $ProjectDir "src-tauri\resources\agent-browser-cli"
    $lockfileDir = Join-Path $ProjectDir "src\server\agent-browser-lockfile"
    # 版本一致性校验：index.ts 的 AGENT_BROWSER_VERSION 必须与 lockfile 的 package.json 一致
    $indexTs = Get-Content (Join-Path $ProjectDir "src\server\index.ts") -Raw
    if ($indexTs -match "const AGENT_BROWSER_VERSION = '([^']+)'") {
        $codeVersion = $Matches[1]
    } else {
        throw "无法从 index.ts 读取 AGENT_BROWSER_VERSION"
    }
    $lockPkg = Get-Content (Join-Path $lockfileDir "package.json") -Raw | ConvertFrom-Json
    $lockVersion = $lockPkg.dependencies.'agent-browser'
    if ($codeVersion -ne $lockVersion) {
        throw "版本不一致! index.ts: $codeVersion, lockfile: $lockVersion — 请同步更新 src/server/agent-browser-lockfile/"
    }
    Write-Host "  版本: $codeVersion" -ForegroundColor Cyan
    if (Test-Path $agentBrowserDir) {
        Remove-Item -Recurse -Force $agentBrowserDir
    }
    New-Item -ItemType Directory -Path $agentBrowserDir -Force | Out-Null
    # 复制预生成的 package.json + bun.lock（跳过依赖解析，秒级安装）
    Copy-Item (Join-Path $lockfileDir "package.json") $agentBrowserDir -Force
    Copy-Item (Join-Path $lockfileDir "bun.lock") $agentBrowserDir -Force
    Push-Location $agentBrowserDir
    & bun install --frozen-lockfile --ignore-scripts
    Pop-Location
    if ($LASTEXITCODE -ne 0) {
        throw "agent-browser 预装失败"
    }
    # npm 包内含全平台 native binary，仅保留 win32 的（删除 darwin/linux）
    $abBinDir = Join-Path $agentBrowserDir "node_modules\agent-browser\bin"
    Get-ChildItem -Path $abBinDir -Filter "agent-browser-darwin-*" -ErrorAction SilentlyContinue | Remove-Item -Force
    Get-ChildItem -Path $abBinDir -Filter "agent-browser-linux-*" -ErrorAction SilentlyContinue | Remove-Item -Force
    # 验证非 win32 二进制已全部删除
    $leaked = Get-ChildItem -Path $abBinDir -Filter "agent-browser-*" -ErrorAction SilentlyContinue | Where-Object { $_.Name -notlike "agent-browser-win32-*" -and $_.Name -ne "agent-browser.js" }
    if ($leaked) {
        throw "删除非 win32 agent-browser 二进制失败: $($leaked.Name -join ', ')"
    }
    # 验证 native binary 存在
    $nativeBin = Join-Path $abBinDir "agent-browser-win32-x64.exe"
    if (-not (Test-Path $nativeBin)) {
        throw "agent-browser native binary 不存在: agent-browser-win32-x64.exe"
    }
    Write-Host "    OK - agent-browser CLI 预装完成 (含 native binary)" -ForegroundColor Green

    # 构建前端 (增加内存限制避免 OOM)
    Write-Host "  构建前端..." -ForegroundColor Cyan
    $env:NODE_OPTIONS = "--max-old-space-size=4096"
    & bun run build:web
    if ($LASTEXITCODE -ne 0) {
        throw "前端构建失败"
    }

    Write-Host "  OK - 前端和服务端构建完成" -ForegroundColor Green
    Write-Host ""

    # ========================================
    # 构建 Tauri 应用
    # ========================================
    Write-Host "[6/7] 构建 Tauri 应用 (Release)..." -ForegroundColor Blue
    Write-Host "  这可能需要几分钟，请耐心等待..." -ForegroundColor Yellow

    & bun run tauri:build -- --target x86_64-pc-windows-msvc --config src-tauri/tauri.windows.conf.json
    if ($LASTEXITCODE -ne 0) {
        throw "Tauri 构建失败"
    }

    Write-Host "  OK - Tauri 构建完成" -ForegroundColor Green
    Write-Host ""

    # ========================================
    # 创建便携版 ZIP
    # ========================================
    if (-not $SkipPortable) {
        Write-Host "[6.5/7] 创建便携版 ZIP..." -ForegroundColor Blue

        $targetDir = "src-tauri\target\x86_64-pc-windows-msvc\release"
        $nsisDir = "$targetDir\bundle\nsis"
        $exePath = "$targetDir\PM Copilot.exe"

        if (Test-Path $exePath) {
            $portableDir = Join-Path $targetDir "portable"
            $zipName = "PM Copilot_${Version}_x86_64-portable.zip"
            $zipPath = Join-Path $nsisDir $zipName

            if (Test-Path $portableDir) {
                Remove-Item -Recurse -Force $portableDir
            }
            New-Item -ItemType Directory -Path $portableDir -Force | Out-Null

            Copy-Item $exePath $portableDir -Force

            $bunExe = Join-Path $targetDir "bun-x86_64-pc-windows-msvc.exe"
            if (Test-Path $bunExe) {
                Copy-Item $bunExe $portableDir -Force
                # Create bun.exe alias for SDK subprocess compatibility
                # (SDK uses which("bun") which only matches bun.exe, not the triple-suffixed name)
                $bunAlias = Join-Path $portableDir "bun.exe"
                Copy-Item $bunExe $bunAlias -Force
            }

            # Copy VC++ Runtime DLLs for portable version (app-local deployment)
            foreach ($dll in @("vcruntime140.dll", "vcruntime140_1.dll")) {
                $dllSrc = Join-Path "src-tauri\resources" $dll
                if (Test-Path $dllSrc) {
                    Copy-Item $dllSrc $portableDir -Force
                }
            }

            $resourcesSource = Join-Path $targetDir "resources"
            if (Test-Path $resourcesSource) {
                Copy-Item $resourcesSource $portableDir -Recurse -Force
            }

            if (Test-Path $zipPath) {
                Remove-Item -Force $zipPath
            }
            Compress-Archive -Path "$portableDir\*" -DestinationPath $zipPath -Force

            Remove-Item -Recurse -Force $portableDir

            Write-Host "  OK - 便携版 ZIP: $zipName" -ForegroundColor Green
        }
        else {
            Write-Host "  警告: 未找到 PM Copilot.exe，跳过便携版创建" -ForegroundColor Yellow
        }
        Write-Host ""
    }

    # ========================================
    # 恢复配置
    # ========================================
    Write-Host "[7/7] 恢复开发配置..." -ForegroundColor Blue

    if (Test-Path "$TauriConfPath.bak") {
        Move-Item "$TauriConfPath.bak" $TauriConfPath -Force
        Write-Host "  OK - 配置已恢复" -ForegroundColor Green
    }
    Write-Host ""

    # ========================================
    # 显示构建产物
    # ========================================
    $bundleDir = "src-tauri\target\x86_64-pc-windows-msvc\release\bundle"
    $nsisDir = Join-Path $bundleDir "nsis"

    Write-Host "=========================================" -ForegroundColor Green
    Write-Host "  构建成功!" -ForegroundColor Green
    Write-Host "=========================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "  版本: $Version" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  构建产物:" -ForegroundColor Blue

    $nsisFiles = Get-ChildItem -Path $nsisDir -Filter "*.exe" -ErrorAction SilentlyContinue
    foreach ($file in $nsisFiles) {
        $size = "{0:N2} MB" -f ($file.Length / 1MB)
        Write-Host "    NSIS: $($file.Name) ($size)" -ForegroundColor Cyan
    }

    $zipFiles = Get-ChildItem -Path $nsisDir -Filter "*portable*.zip" -ErrorAction SilentlyContinue
    foreach ($file in $zipFiles) {
        $size = "{0:N2} MB" -f ($file.Length / 1MB)
        Write-Host "    ZIP:  $($file.Name) ($size)" -ForegroundColor Cyan
    }

    $tarFiles = Get-ChildItem -Path $nsisDir -Filter "*.nsis.zip" -ErrorAction SilentlyContinue
    foreach ($file in $tarFiles) {
        $size = "{0:N2} MB" -f ($file.Length / 1MB)
        Write-Host "    更新包: $($file.Name) ($size)" -ForegroundColor Cyan
    }

    Write-Host ""
    Write-Host "  输出目录:" -ForegroundColor Blue
    Write-Host "    $nsisDir" -ForegroundColor Cyan
    Write-Host ""

    $sigFiles = Get-ChildItem -Path $nsisDir -Filter "*.sig" -ErrorAction SilentlyContinue
    if ($sigFiles) {
        Write-Host "  OK - 自动更新签名已生成" -ForegroundColor Green
    }
    else {
        Write-Host "  警告: 未生成自动更新签名 (TAURI_SIGNING_PRIVATE_KEY 未设置)" -ForegroundColor Yellow
    }

    Write-Host ""
    Write-Host "后续步骤:" -ForegroundColor Blue
    Write-Host "  1. 测试安装包" -ForegroundColor White
    Write-Host "  2. 运行 .\publish_windows.ps1 发布到 R2" -ForegroundColor White
    Write-Host ""

    $BuildSuccess = $true

} catch {
    Write-Host ""
    Write-Host "=========================================" -ForegroundColor Red
    Write-Host "  构建失败!" -ForegroundColor Red
    Write-Host "=========================================" -ForegroundColor Red
    Write-Host ""
    Write-Host "错误: $_" -ForegroundColor Red
    Write-Host ""
    if ($_.InvocationInfo.PositionMessage) {
        Write-Host "位置: $($_.InvocationInfo.PositionMessage)" -ForegroundColor Yellow
    }
    Write-Host ""

    # 尝试恢复配置
    $TauriConfPath = Join-Path $ProjectDir "src-tauri\tauri.conf.json"
    if (Test-Path "$TauriConfPath.bak") {
        Move-Item "$TauriConfPath.bak" $TauriConfPath -Force
        Write-Host "已恢复 tauri.conf.json" -ForegroundColor Yellow
    }
}

Write-Host ""
if ($BuildSuccess) {
    Write-Host "按回车键退出..." -ForegroundColor Cyan
} else {
    Write-Host "按回车键退出..." -ForegroundColor Yellow
}
Read-Host
