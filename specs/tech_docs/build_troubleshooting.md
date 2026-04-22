# 构建问题排查指南

**最后更新**: 2026-01-31
**适用版本**: v0.1.7+

---

## 📋 目录

1. [Windows 构建脚本常见问题](#windows-构建脚本常见问题)
2. [CSP 配置错误](#csp-配置错误)
3. [Resources 缓存问题](#resources-缓存问题)
4. [代理配置问题](#代理配置问题)

---

## Windows 构建脚本常见问题

### 问题：构建后 CSP 错误仍然存在

**症状**：
```
Fetch API cannot load http://ipc.localhost/plugin...
Refused to connect because it violates the document's Content Security Policy
```

**根本原因**：

构建脚本存在两个严重 BUG（已在 v0.1.7 修复）：

#### Bug 1: 缺少 resources 目录清理

**问题**：
- 构建脚本只清理了 `bundle` 目录
- 未清理 `src-tauri/target/{arch}/{profile}/resources` 目录
- Tauri 在 resources 目录缓存了 `tauri.conf.json` 等配置文件
- 即使源文件更新，构建仍使用旧缓存

**修复**（commit a23cdf3）：
```powershell
# 清理 resources 目录确保配置重新读取
$resourcesDir = "src-tauri\target\x86_64-pc-windows-msvc\release\resources"
if (Test-Path $resourcesDir) {
    Remove-Item $resourcesDir -Recurse -Force
}
```

#### Bug 2: 错误的 CSP 覆盖

**问题**：
- `build_windows.ps1` 第 153 行强制覆盖 CSP 为旧版本
- 覆盖的 CSP 缺少关键指令：
  - ❌ `asset:` 协议
  - ❌ `http://ipc.localhost` （Windows Tauri IPC 必需）
  - ❌ `fetch-src` 指令
  - ❌ `https://download.ai-matrix.site`

**修复**（commit a23cdf3）：
- 移除错误的 CSP 覆盖逻辑
- 改为验证 CSP 配置完整性
- 检查关键部分，如果缺失则警告用户

**验证方法**：

```powershell
# 检查构建脚本版本
git log --oneline build_windows.ps1 | head -1
# 应显示 a23cdf3 或更新的 commit

# 清理构建
Remove-Item src-tauri\target\x86_64-pc-windows-msvc\release -Recurse -Force

# 重新构建
.\build_windows.ps1
```

---

## CSP 配置错误

### Windows Tauri IPC 需要特殊 CSP

**背景**：
- Windows Tauri v2 使用 `http://ipc.localhost` 进行 IPC 通信
- 需要在 CSP 中同时配置 `default-src`、`connect-src` 和 `fetch-src`

**正确配置**（`tauri.conf.json`）：
```json
{
  "app": {
    "security": {
      "csp": "default-src 'self' ipc: tauri: asset: http://ipc.localhost; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self' ipc: tauri: asset: http://ipc.localhost http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:* https://download.ai-matrix.site; fetch-src 'self' ipc: tauri: asset: http://ipc.localhost https://download.ai-matrix.site; img-src 'self' data: blob: asset: https://download.ai-matrix.site;"
    }
  }
}
```

**关键部分**：
- `default-src`: 包含 `http://ipc.localhost`
- `fetch-src`: **必须**包含 `http://ipc.localhost`（Windows Tauri IPC 使用 Fetch API）
- `connect-src`: 包含 localhost 和 WebSocket 支持
- `img-src`: 支持 data URL 和 CDN 资源

**验证 CSP 配置**：

```powershell
# 检查 tauri.conf.json 中的 CSP
$conf = Get-Content src-tauri/tauri.conf.json | ConvertFrom-Json
$csp = $conf.app.security.csp

# 验证关键部分
$requiredParts = @("http://ipc.localhost", "asset:", "fetch-src", "https://download.ai-matrix.site")
foreach ($part in $requiredParts) {
    if ($csp -notlike "*$part*") {
        Write-Host "缺少: $part" -ForegroundColor Red
    }
}
```

---

## Resources 缓存问题

### 问题：配置更新后构建仍使用旧配置

**原因**：
- Tauri 在 `target/{arch}/{profile}/resources/` 缓存配置文件
- 常规清理（`cargo clean` 或删除 `bundle`）不会清理此目录

**解决方案**：

手动清理 resources 目录：
```powershell
# Debug 构建
Remove-Item src-tauri/target/x86_64-pc-windows-msvc/debug/resources -Recurse -Force

# Release 构建
Remove-Item src-tauri/target/x86_64-pc-windows-msvc/release/resources -Recurse -Force
```

或使用构建脚本（v0.1.7+ 自动处理）：
```powershell
.\build_windows.ps1  # 自动清理 release/resources
.\build_dev_win.ps1  # 自动清理 debug/resources
```

---

## 代理配置问题

### localhost 连接失败

**症状**：
```
[proxy] Request failed: error sending request for url (http://127.0.0.1:31415/...)
```

**原因**：
- reqwest 默认使用系统代理（如 Clash: 127.0.0.1:7890）
- Windows 系统代理未正确处理 localhost 排除
- localhost 请求被发送到代理，连接失败

**解决方案**（已在 v0.1.7 修复）：

所有 localhost 请求强制禁用代理：
```rust
let client = reqwest::Client::builder()
    .no_proxy()  // 禁用所有代理（包括系统代理）
    .build()?;
```

**详见**：[proxy_config.md](./proxy_config.md)

---

## 最佳实践

### 构建前检查清单

- [ ] 版本号已同步（`package.json`, `tauri.conf.json`, `Cargo.toml`）
- [ ] TypeScript 类型检查通过（`bun run typecheck`）
- [ ] CSP 配置完整（包含 `http://ipc.localhost`, `fetch-src`）
- [ ] 清理旧的 resources 缓存
- [ ] 杀死残留进程（bun, PM Copilot）

### 构建后验证

- [ ] 安装包大小正常（~150MB）
- [ ] 安装并启动成功
- [ ] 开发者工具无 CSP 错误
- [ ] Sidecar 连接正常
- [ ] 二维码等资源加载正常

---

## 相关文档

- [Windows 构建指南](../guides/windows_build_guide.md)
- [代理配置](./proxy_config.md)
- [Windows 平台指南](./windows_platform_guide.md)
