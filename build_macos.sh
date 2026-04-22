#!/bin/bash
# PM Copilot macOS 正式发布构建脚本
# 构建签名+公证的 DMG 安装包用于分发
# 支持 ARM (M1/M2)、Intel 构建

set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSION=$(grep '"version"' "${PROJECT_DIR}/src-tauri/tauri.conf.json" | head -1 | sed 's/.*"version": "\([^"]*\)".*/\1/')
TAURI_CONF="${PROJECT_DIR}/src-tauri/tauri.conf.json"
ENV_FILE="${PROJECT_DIR}/.env"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

echo ""
echo -e "${CYAN}╔═══════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║${NC}  ${GREEN}🤖 PM Copilot macOS 签名发布构建${NC}                      ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}  ${BLUE}Version: ${VERSION}${NC}                                      ${CYAN}║${NC}"
echo -e "${CYAN}╚═══════════════════════════════════════════════════════╝${NC}"
echo ""

# ========================================
# 版本同步检查
# ========================================
PKG_VERSION=$(grep '"version"' "${PROJECT_DIR}/package.json" | head -1 | sed 's/.*"version": "\([^"]*\)".*/\1/')
TAURI_VERSION=$(grep '"version"' "${PROJECT_DIR}/src-tauri/tauri.conf.json" | head -1 | sed 's/.*"version": "\([^"]*\)".*/\1/')
CARGO_VERSION=$(grep '^version = ' "${PROJECT_DIR}/src-tauri/Cargo.toml" | head -1 | sed 's/version = "\([^"]*\)".*/\1/')

if [ "$PKG_VERSION" != "$TAURI_VERSION" ] || [ "$PKG_VERSION" != "$CARGO_VERSION" ]; then
    echo -e "${YELLOW}⚠ 版本号不一致:${NC}"
    echo -e "  package.json:      ${CYAN}${PKG_VERSION}${NC}"
    echo -e "  tauri.conf.json:   ${CYAN}${TAURI_VERSION}${NC}"
    echo -e "  Cargo.toml:        ${CYAN}${CARGO_VERSION}${NC}"
    echo ""
    read -p "是否同步版本号到 ${PKG_VERSION}? (y/N) " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        node "${PROJECT_DIR}/scripts/sync-version.js"
        VERSION="$PKG_VERSION"  # 更新显示的版本号
        echo ""
    fi
fi

# ========================================
# 加载环境变量 (签名配置)
# ========================================
echo -e "${BLUE}[1/7] 加载签名配置...${NC}"
if [ -f "$ENV_FILE" ]; then
    set -a
    source "$ENV_FILE"
    set +a
    echo -e "${GREEN}✓ 已加载 .env${NC}"
else
    echo -e "${RED}错误: .env 文件不存在!${NC}"
    echo "请创建 .env 文件并配置以下变量:"
    echo "  APPLE_SIGNING_IDENTITY"
    echo "  APPLE_TEAM_ID"
    echo "  APPLE_API_ISSUER"
    echo "  APPLE_API_KEY"
    echo "  APPLE_API_KEY_PATH"
    exit 1
fi

# 验证签名环境变量
if [ -z "$APPLE_SIGNING_IDENTITY" ]; then
    echo -e "${RED}错误: APPLE_SIGNING_IDENTITY 未设置!${NC}"
    exit 1
fi

if [ -z "$TAURI_SIGNING_PRIVATE_KEY" ]; then
    echo -e "${YELLOW}╔═══════════════════════════════════════════════════════════╗${NC}"
    echo -e "${YELLOW}║ 警告: TAURI_SIGNING_PRIVATE_KEY 未设置                     ║${NC}"
    echo -e "${YELLOW}║ 自动更新功能将不可用!                                      ║${NC}"
    echo -e "${YELLOW}║                                                           ║${NC}"
    echo -e "${YELLOW}║ 如需启用自动更新，请在 .env 中添加:                         ║${NC}"
    echo -e "${YELLOW}║   TAURI_SIGNING_PRIVATE_KEY=<私钥内容>                     ║${NC}"
    echo -e "${YELLOW}║   TAURI_SIGNING_PRIVATE_KEY_PASSWORD=<密码>                ║${NC}"
    echo -e "${YELLOW}╚═══════════════════════════════════════════════════════════╝${NC}"
    echo ""
    read -p "是否继续构建? (Y/n) " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Nn]$ ]]; then
        echo -e "${RED}构建已取消${NC}"
        exit 1
    fi
else
    echo -e "  ${GREEN}✓ Tauri 签名私钥已配置${NC}"
fi

echo -e "  签名身份: ${CYAN}${APPLE_SIGNING_IDENTITY}${NC}"
echo ""

# ========================================
# 清理残留进程
# ========================================
echo -e "${BLUE}[准备] 清理残留进程...${NC}"
pkill -f "bun run.*server" 2>/dev/null || true
pkill -f "PM Copilot.app" 2>/dev/null || true
sleep 1
echo -e "${GREEN}✓ 进程已清理${NC}"
echo ""

# 架构选择
echo -e "${YELLOW}请选择目标架构:${NC}"
echo "  1) ARM (Apple Silicon M1/M2) [默认]"
echo "  2) Intel (x86_64)"
echo "  3) Both (同时构建两个版本)"
echo ""
read -p "请输入选项 (1/2/3) [1]: " -r ARCH_CHOICE
ARCH_CHOICE=${ARCH_CHOICE:-1}

case $ARCH_CHOICE in
    1)
        BUILD_TARGETS=("aarch64-apple-darwin")
        echo -e "${GREEN}✓ 将构建 ARM 版本${NC}"
        ;;
    2)
        BUILD_TARGETS=("x86_64-apple-darwin")
        echo -e "${GREEN}✓ 将构建 Intel 版本${NC}"
        ;;
    3)
        BUILD_TARGETS=("aarch64-apple-darwin" "x86_64-apple-darwin")
        echo -e "${GREEN}✓ 将构建 ARM 和 Intel 两个版本${NC}"
        ;;
    *)
        BUILD_TARGETS=("aarch64-apple-darwin")
        echo -e "${GREEN}✓ 将构建 ARM 版本 (默认)${NC}"
        ;;
esac
echo ""

# 检查依赖
check_dependency() {
    if ! command -v "$1" &> /dev/null; then
        echo -e "${RED}错误: $1 未安装${NC}"
        echo "$2"
        exit 1
    fi
}

echo -e "${BLUE}[2/7] 检查依赖...${NC}"
check_dependency "rustc" "请安装 Rust: https://rustup.rs"
check_dependency "npm" "请安装 Node.js: https://nodejs.org"
check_dependency "codesign" "需要 Xcode Command Line Tools"

# 检查 mino 默认工作区
if [ ! -d "${PROJECT_DIR}/mino" ] || [ ! -f "${PROJECT_DIR}/mino/CLAUDE.md" ]; then
    echo -e "${RED}错误: mino/ 目录不存在或不完整! 请先运行 ./setup.sh${NC}"
    exit 1
fi
echo -e "${GREEN}  ✓ mino 默认工作区已就绪${NC}"

# 检查并安装 Rust 交叉编译目标
for TARGET in "${BUILD_TARGETS[@]}"; do
    if ! rustup target list --installed | grep -q "$TARGET"; then
        echo -e "${YELLOW}  安装 Rust 目标: $TARGET${NC}"
        rustup target add "$TARGET"
    else
        echo -e "${GREEN}  ✓ Rust 目标已安装: $TARGET${NC}"
    fi
done

echo -e "${GREEN}✓ 依赖检查通过${NC}"
echo ""

# CSP 验证（tauri.conf.json 中已包含跨平台完整 CSP，无需覆写）
echo -e "${BLUE}[3/7] 验证 CSP 配置...${NC}"
echo -e "${GREEN}✓ 使用 tauri.conf.json 中的跨平台 CSP（含 Windows 兼容指令）${NC}"
echo ""

# 清理旧构建
echo -e "${BLUE}[准备] 清理旧构建...${NC}"
rm -rf "${PROJECT_DIR}/dist"

for TARGET in "${BUILD_TARGETS[@]}"; do
    rm -rf "${PROJECT_DIR}/src-tauri/target/${TARGET}/release/bundle"
done

echo -e "${GREEN}✓ 清理完成${NC}"
echo ""

# TypeScript 类型检查
echo -e "${BLUE}[4/7] TypeScript 类型检查...${NC}"
cd "${PROJECT_DIR}"
if ! bun run typecheck; then
    echo -e "${RED}✗ TypeScript 检查失败，请修复后重试${NC}"
    exit 1
fi
echo -e "${GREEN}✓ TypeScript 检查通过${NC}"
echo ""

# 构建前端和服务端
echo -e "${BLUE}[5/7] 构建前端和服务端...${NC}"

# 打包服务端代码
echo -e "  ${CYAN}打包服务端代码...${NC}"
mkdir -p src-tauri/resources
bun build ./src/server/index.ts --outfile=./src-tauri/resources/server-dist.js --target=bun

# 打包 Plugin Bridge 代码 (OpenClaw channel plugin 支持)
echo -e "  ${CYAN}打包 Plugin Bridge...${NC}"
bun build ./src/server/plugin-bridge/index.ts --outfile=./src-tauri/resources/plugin-bridge-dist.js --target=bun

# 验证打包结果不包含开发机硬编码路径
# bun build 会将 __dirname 硬编码为编译时路径，必须使用 import.meta.url 替代
# 检查任何 "var __dirname = \"/Users/..." 模式 (覆盖所有用户名)
if grep -qE 'var __dirname = "/Users/[^"]+' ./src-tauri/resources/server-dist.js; then
    echo -e "${RED}✗ 错误: server-dist.js 包含硬编码的 __dirname 路径!${NC}"
    echo -e "${YELLOW}  检测到: $(grep -oE 'var __dirname = "[^"]+"' ./src-tauri/resources/server-dist.js | head -1)${NC}"
    echo -e "${YELLOW}  请检查代码中是否使用了 __dirname (会被 bun build 硬编码)${NC}"
    echo -e "${YELLOW}  应使用 import.meta.url + fileURLToPath 在运行时获取路径${NC}"
    exit 1
fi
echo -e "${GREEN}  ✓ 服务端代码验证通过 (无硬编码路径)${NC}"

# 复制 SDK 依赖
echo -e "  ${CYAN}复制 SDK 依赖...${NC}"
SDK_SRC="node_modules/@anthropic-ai/claude-agent-sdk"
SDK_DEST="src-tauri/resources/claude-agent-sdk"
rm -rf "${SDK_DEST}"
mkdir -p "${SDK_DEST}"
cp "${SDK_SRC}/cli.js" "${SDK_DEST}/"
cp "${SDK_SRC}/sdk.mjs" "${SDK_DEST}/"
cp "${SDK_SRC}"/*.wasm "${SDK_DEST}/"
cp -R "${SDK_SRC}/vendor" "${SDK_DEST}/"

# 预装 agent-browser CLI（使用预生成的 lockfile 避免耗时的依赖解析）
echo -e "  ${CYAN}预装 agent-browser CLI...${NC}"
AGENT_BROWSER_DIR="${PROJECT_DIR}/src-tauri/resources/agent-browser-cli"
LOCKFILE_DIR="${PROJECT_DIR}/src/server/agent-browser-lockfile"
# 版本一致性校验：index.ts 的 AGENT_BROWSER_VERSION 必须与 lockfile 的 package.json 一致
CODE_VERSION=$(grep "const AGENT_BROWSER_VERSION" "${PROJECT_DIR}/src/server/index.ts" | sed "s/.*= '//;s/'.*//" )
LOCK_VERSION=$(python3 -c "import json; print(json.load(open('${LOCKFILE_DIR}/package.json'))['dependencies']['agent-browser'])")
if [ "$CODE_VERSION" != "$LOCK_VERSION" ]; then
    echo -e "${RED}✗ 版本不一致! index.ts: ${CODE_VERSION}, lockfile: ${LOCK_VERSION}${NC}"
    echo -e "${YELLOW}  请同步更新 src/server/agent-browser-lockfile/ (参见其 README.md)${NC}"
    exit 1
fi
echo -e "  版本: ${CODE_VERSION}"
rm -rf "${AGENT_BROWSER_DIR}"
mkdir -p "${AGENT_BROWSER_DIR}"
# 复制预生成的 package.json + bun.lock（跳过依赖解析，秒级安装）
cp "${LOCKFILE_DIR}/package.json" "${AGENT_BROWSER_DIR}/"
cp "${LOCKFILE_DIR}/bun.lock" "${AGENT_BROWSER_DIR}/"
(cd "${AGENT_BROWSER_DIR}" && bun install --frozen-lockfile --ignore-scripts)
if [ $? -ne 0 ]; then
    echo -e "${RED}✗ agent-browser 预装失败${NC}"
    exit 1
fi
# npm 包内含全平台 native binary，仅保留 darwin 的（删除 linux/win32 避免公证扫描）
AB_BIN_DIR="${AGENT_BROWSER_DIR}/node_modules/agent-browser/bin"
rm -f "${AB_BIN_DIR}/agent-browser-linux-"* "${AB_BIN_DIR}/agent-browser-win32-"* 2>/dev/null || true
# 验证非 darwin 二进制已全部删除
if find "${AB_BIN_DIR}" -type f \( -name "agent-browser-linux-*" -o -name "agent-browser-win32-*" \) | grep -q .; then
    echo -e "${RED}✗ 删除非 darwin agent-browser 二进制失败${NC}"
    exit 1
fi
chmod 755 "${AB_BIN_DIR}"/agent-browser-darwin-* 2>/dev/null || true
# 验证 native binary 存在
NATIVE_BIN="${AB_BIN_DIR}/agent-browser-darwin-$(uname -m)"
if [ ! -f "$NATIVE_BIN" ]; then
    echo -e "${RED}✗ agent-browser native binary 不存在: $(basename "$NATIVE_BIN")${NC}"
    exit 1
fi
echo -e "${GREEN}  ✓ agent-browser CLI 预装完成 (含 native binary)${NC}"

# 构建前端
echo -e "  ${CYAN}构建前端...${NC}"
bun run build:web
echo -e "${GREEN}✓ 前端和服务端构建完成${NC}"
echo ""

# Node.js 运行时目录（每个构建目标在循环中按架构下载）
NODEJS_DIR="${PROJECT_DIR}/src-tauri/resources/nodejs"

# 签名 Bun 可执行文件 (重要：确保与应用使用相同签名)
# ========================================
echo -e "${BLUE}[6/7] 签名外部二进制文件...${NC}"

# 签名 Bun 可执行文件
# 重要：Bun 默认使用官方签名 (Jarred Sumner)，需要重签名为应用签名
# 否则 macOS TCC 会将 Bun 视为独立应用，每次访问受保护目录都需要单独授权
# 参考：https://developer.apple.com/forums/thread/129494
#       https://book.hacktricks.wiki/en/macos-hardening/macos-security-and-privilege-escalation/macos-security-protections/macos-tcc/
echo -e "  ${CYAN}签名 Bun 可执行文件 (使用应用签名替换官方签名)...${NC}"
BUN_BINARIES_DIR="${PROJECT_DIR}/src-tauri/binaries"
BUN_SIGNED_COUNT=0
BUN_FAILED_COUNT=0

for bun_binary in "${BUN_BINARIES_DIR}"/bun-*-apple-darwin; do
    if [ -f "$bun_binary" ]; then
        echo -e "    ${CYAN}处理: $(basename "$bun_binary")${NC}"

        # 1. 移除 quarantine 属性 (macOS 会标记下载的二进制文件)
        # 参考：https://v2.tauri.app/develop/sidecar/
        xattr -d com.apple.quarantine "$bun_binary" 2>/dev/null || true

        # 2. 重签名：使用 --force 强制重签名，--options runtime 启用 hardened runtime
        # --entitlements 使用应用的 entitlements 确保 JIT 等权限
        # 这样 Bun 将与主应用共享相同的 Team ID，TCC 权限可以正确继承
        if codesign --force --options runtime --timestamp \
            --entitlements "${PROJECT_DIR}/src-tauri/Entitlements.plist" \
            --sign "$APPLE_SIGNING_IDENTITY" "$bun_binary"; then
            echo -e "    ${GREEN}✓ $(basename "$bun_binary") 签名成功${NC}"
            ((BUN_SIGNED_COUNT++))
        else
            echo -e "    ${RED}✗ $(basename "$bun_binary") 签名失败${NC}"
            ((BUN_FAILED_COUNT++))
        fi
    fi
done

if [ $BUN_FAILED_COUNT -gt 0 ]; then
    echo -e "${RED}错误: Bun 签名失败，构建终止${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Bun 签名完成 (${BUN_SIGNED_COUNT} 个文件)${NC}"

echo ""

# ========================================
# 签名 Vendor 二进制文件 (ripgrep)
# ========================================
echo -e "  ${CYAN}签名 Vendor 二进制文件 (ripgrep, .node)...${NC}"

# 签名所有 macOS 二进制文件
VENDOR_DIR="${SDK_DEST}/vendor"
SIGNED_COUNT=0
FAILED_COUNT=0

# 使用 process substitution 避免子 shell 问题
while IFS= read -r binary; do
    echo -e "    ${CYAN}签名: $(basename "$binary")${NC}"
    if codesign --force --options runtime --timestamp \
        --sign "$APPLE_SIGNING_IDENTITY" "$binary" 2>/dev/null; then
        ((SIGNED_COUNT++))
    else
        echo -e "    ${YELLOW}警告: 签名失败 - $binary${NC}"
        ((FAILED_COUNT++))
    fi
done < <(find "$VENDOR_DIR" -type f \( -name "*.node" -o -name "rg" \) -path "*darwin*")

echo -e "${GREEN}✓ Vendor 签名完成 (成功: ${SIGNED_COUNT}, 失败: ${FAILED_COUNT})${NC}"
echo ""

# ========================================
# 签名 agent-browser-cli 原生二进制
# ========================================
echo -e "  ${CYAN}签名 agent-browser-cli 原生二进制...${NC}"

AB_CLI_DIR="${PROJECT_DIR}/src-tauri/resources/agent-browser-cli"
# 删除所有非 darwin 的 prebuilds（android/ios/linux/win32 含 Mach-O 会被 Apple 公证扫描）
find "${AB_CLI_DIR}/node_modules" -type d -name "prebuilds" 2>/dev/null | while IFS= read -r prebuild_dir; do
    for platform_dir in "${prebuild_dir}"/*/; do
        platform_name=$(basename "$platform_dir")
        case "$platform_name" in
            darwin-*) ;; # 保留 darwin
            *) rm -rf "$platform_dir" ;; # 删除其他平台
        esac
    done
done

# 签名 agent-browser native CLI binary + darwin .bare prebuilds
AB_SIGNED_COUNT=0
AB_FAILED_COUNT=0

# 1) 签名 agent-browser native binary (所有 darwin 架构)
while IFS= read -r binary; do
    echo -e "    ${CYAN}签名: agent-browser/bin/$(basename "$binary")${NC}"
    if codesign --force --options runtime --timestamp \
        --sign "$APPLE_SIGNING_IDENTITY" "$binary" 2>/dev/null; then
        ((AB_SIGNED_COUNT++))
    else
        echo -e "    ${YELLOW}警告: 签名失败 - $binary${NC}"
        ((AB_FAILED_COUNT++))
    fi
done < <(find "${AB_CLI_DIR}/node_modules/agent-browser/bin" -type f -name "agent-browser-darwin-*" 2>/dev/null)

# 2) 签名 .bare prebuilds (bare-fs/bare-os 等 Node.js native addons)
while IFS= read -r binary; do
    echo -e "    ${CYAN}签名: $(echo "$binary" | sed "s|.*/node_modules/||")${NC}"
    if codesign --force --options runtime --timestamp \
        --sign "$APPLE_SIGNING_IDENTITY" "$binary" 2>/dev/null; then
        ((AB_SIGNED_COUNT++))
    else
        echo -e "    ${YELLOW}警告: 签名失败 - $binary${NC}"
        ((AB_FAILED_COUNT++))
    fi
done < <(find "${AB_CLI_DIR}/node_modules" -type f -name "*.bare" -path "*darwin*" 2>/dev/null)

if [ $AB_FAILED_COUNT -gt 0 ]; then
    echo -e "${RED}错误: agent-browser 原生二进制签名失败 (${AB_FAILED_COUNT} 个)，公证必定失败${NC}"
    exit 1
fi
echo -e "${GREEN}✓ agent-browser 签名完成 (${AB_SIGNED_COUNT} 个文件)${NC}"
echo ""

# 构建 Tauri 应用
echo -e "${BLUE}[7/7] 构建 Tauri 应用 (Release + 签名 + 公证)...${NC}"
echo -e "${YELLOW}这可能需要 5-10 分钟 (包含公证等待时间)...${NC}"

for TARGET in "${BUILD_TARGETS[@]}"; do
    echo ""
    echo -e "${YELLOW}━━━ 构建目标: $TARGET ━━━${NC}"

    # ---- 确保 Node.js 匹配目标架构 ----
    # 将 Tauri target triple 映射为 Node.js 架构名
    if [[ "$TARGET" == "aarch64-apple-darwin" ]]; then
        NODE_TARGET_ARCH="arm64"
    else
        NODE_TARGET_ARCH="x64"
    fi

    echo -e "  ${CYAN}确保 Node.js 匹配目标架构 (${NODE_TARGET_ARCH})...${NC}"
    "${PROJECT_DIR}/scripts/download_nodejs.sh" --target "$NODE_TARGET_ARCH"

    # 签名 Node.js 二进制 (TCC / notarization 需要统一签名)
    NODE_BINARY="${NODEJS_DIR}/bin/node"
    if [ -f "$NODE_BINARY" ]; then
        xattr -d com.apple.quarantine "$NODE_BINARY" 2>/dev/null || true
        if codesign --force --options runtime --timestamp \
            --entitlements "${PROJECT_DIR}/src-tauri/Entitlements.plist" \
            --sign "$APPLE_SIGNING_IDENTITY" "$NODE_BINARY"; then
            echo -e "    ${GREEN}✓ node (${NODE_TARGET_ARCH}) 签名成功${NC}"
        else
            echo -e "    ${RED}✗ node 签名失败${NC}"
            exit 1
        fi
    fi

    bun run tauri:build -- --target "$TARGET"

    echo -e "${GREEN}✓ $TARGET 构建完成${NC}"
done

echo ""

# 检查输出
BUNDLE_DIR="${PROJECT_DIR}/src-tauri/target"

echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  🎉 签名版构建成功!${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
echo ""

# 显示构建产物
UPDATER_READY=true
for TARGET in "${BUILD_TARGETS[@]}"; do
    TARGET_BUNDLE_DIR="${BUNDLE_DIR}/${TARGET}/release/bundle"
    DMG_PATH=$(find "${TARGET_BUNDLE_DIR}/dmg" -name "*.dmg" 2>/dev/null | head -1)
    APP_PATH=$(find "${TARGET_BUNDLE_DIR}/macos" -name "*.app" 2>/dev/null | head -1)
    TAR_GZ_PATH=$(find "${TARGET_BUNDLE_DIR}/macos" -name "*.app.tar.gz" ! -name "*.sig" 2>/dev/null | head -1)
    SIG_PATH=$(find "${TARGET_BUNDLE_DIR}/macos" -name "*.app.tar.gz.sig" 2>/dev/null | head -1)

    # 架构友好名称
    if [[ "$TARGET" == "aarch64-apple-darwin" ]]; then
        ARCH_NAME="ARM (Apple Silicon)"
    else
        ARCH_NAME="Intel (x86_64)"
    fi

    echo -e "  ${CYAN}【$ARCH_NAME】${NC}"

    # DMG (官网下载用)
    if [ -n "$DMG_PATH" ]; then
        DMG_SIZE=$(du -h "$DMG_PATH" | cut -f1)
        echo -e "    📦 DMG: $(basename "$DMG_PATH") (${DMG_SIZE})"
    else
        echo -e "    ${RED}✗${NC} DMG: 未找到"
    fi

    # tar.gz (自动更新用)
    if [ -n "$TAR_GZ_PATH" ]; then
        TAR_SIZE=$(du -h "$TAR_GZ_PATH" | cut -f1)
        echo -e "    📄 tar.gz: $(basename "$TAR_GZ_PATH") (${TAR_SIZE})"
    else
        echo -e "    ${YELLOW}⚠️${NC} tar.gz: 未找到"
        UPDATER_READY=false
    fi

    # 签名文件 (自动更新验证用)
    if [ -n "$SIG_PATH" ]; then
        echo -e "    🔐 签名: $(basename "$SIG_PATH")"
    else
        echo -e "    ${YELLOW}⚠️${NC} 签名: 未找到 (自动更新将不可用)"
        UPDATER_READY=false
    fi

    if [ -n "$APP_PATH" ]; then
        # 验证 Apple 签名
        if codesign --verify --deep --strict "$APP_PATH" 2>/dev/null; then
            echo -e "    ✅ Apple 签名: ${GREEN}通过${NC}"
        else
            echo -e "    ⚠️ Apple 签名: ${YELLOW}失败${NC}"
        fi

        # 验证公证
        if spctl --assess --type exec "$APP_PATH" 2>/dev/null; then
            echo -e "    ✅ 公证验证: ${GREEN}通过${NC}"
        else
            echo -e "    ⚠️ 公证验证: ${YELLOW}未完成或失败${NC}"
        fi
    fi
    echo ""
done

# 自动更新状态总结
if [ "$UPDATER_READY" = true ]; then
    echo -e "  ${GREEN}✅ 自动更新: 所有文件就绪${NC}"
else
    echo -e "  ${YELLOW}⚠️  自动更新: 缺少必要文件 (tar.gz 或 .sig)${NC}"
    echo -e "  ${YELLOW}   请确保 .env 中配置了 TAURI_SIGNING_PRIVATE_KEY${NC}"
fi
echo ""

echo -e "  ${CYAN}正式版特性:${NC}"
echo -e "    ✅ Developer ID 签名"
echo -e "    ✅ Apple 公证 (Notarized)"
echo -e "    ✅ Hardened Runtime"
echo -e "    ✅ CSP 安全策略"
echo -e "    ✅ Release 优化"
echo ""

read -p "是否打开输出目录? (y/N) " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
    FIRST_TARGET="${BUILD_TARGETS[0]}"
    open "${BUNDLE_DIR}/${FIRST_TARGET}/release/bundle"
fi

echo ""
read -p "是否发布到 Cloudflare R2? (y/N) " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
    "${PROJECT_DIR}/publish_release.sh"
fi
