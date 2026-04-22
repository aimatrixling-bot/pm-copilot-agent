#!/bin/bash
# Download Node.js LTS binaries for bundling with PM Copilot.
#
# This script downloads the official Node.js distribution for each platform
# and extracts it into src-tauri/resources/nodejs/.
#
# The full distribution includes node, npm, and npx — everything needed
# for MCP servers and AI bash tool execution.
#
# Usage:
#   ./scripts/download_nodejs.sh              # Download for current platform only
#   ./scripts/download_nodejs.sh --target arm64|x64  # Download specific macOS arch
#   ./scripts/download_nodejs.sh --all        # Download for all platforms (CI/CD)
#   ./scripts/download_nodejs.sh --clean      # Remove existing downloads first

set -e

# ========================================
# Configuration
# ========================================
NODE_VERSION="24.14.0"  # Active LTS — moltbot 等包要求 >=24，不可降级
NODE_BASE_URL="https://nodejs.org/dist/v${NODE_VERSION}"

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RESOURCES_DIR="${PROJECT_DIR}/src-tauri/resources/nodejs"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# ========================================
# Helpers
# ========================================

log_info()  { echo -e "${BLUE}[nodejs]${NC} $1"; }
log_ok()    { echo -e "${GREEN}[nodejs]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[nodejs]${NC} $1"; }
log_error() { echo -e "${RED}[nodejs]${NC} $1"; }

# Upgrade npm by downloading tarball directly (bypasses broken npm — no catch-22).
# Node.js v24 bundles npm 11.9.0 whose minizlib crashes on Windows with
# "Class extends value undefined". Self-upgrade via `npm install npm@latest`
# CANNOT work when npm itself is broken. Instead we download the npm tarball
# with curl and replace the node_modules/npm directory.
#
# Usage: upgrade_npm <npm_modules_dir> <node_bin_or_empty>
#   npm_modules_dir: path containing npm/ (e.g., .../lib/node_modules or .../node_modules)
#   node_bin:        path to node binary for version check (empty string to skip check)
upgrade_npm() {
    local npm_modules_dir="$1"
    local node_bin="$2"
    local npm_dir="${npm_modules_dir}/npm"

    if [[ ! -d "$npm_dir" ]]; then
        log_warn "npm directory not found at ${npm_dir}, skipping upgrade"
        return 0
    fi

    local old_ver="unknown"
    if [[ -n "$node_bin" && -x "$node_bin" ]]; then
        old_ver=$("$node_bin" "${npm_dir}/bin/npm-cli.js" --version 2>/dev/null || echo "unknown")
    fi
    log_info "Upgrading npm (curl + tar, bypasses broken npm)... current: v${old_ver}"

    local tmp_dir
    tmp_dir=$(mktemp -d)

    # Query npm registry for latest tarball URL
    local tarball_url
    tarball_url=$(curl -sL https://registry.npmjs.org/npm/latest | grep -o '"tarball":"[^"]*"' | head -1 | cut -d'"' -f4)
    if [[ -z "$tarball_url" ]]; then
        log_error "Failed to query npm registry (no tarball URL returned)"
        rm -rf "$tmp_dir"
        return 1
    fi
    log_info "Downloading: ${tarball_url}"

    # Download and extract
    if ! curl -sL "$tarball_url" -o "${tmp_dir}/npm.tgz"; then
        log_error "Failed to download npm tarball"
        rm -rf "$tmp_dir"
        return 1
    fi

    if ! tar -xzf "${tmp_dir}/npm.tgz" -C "$tmp_dir" 2>/dev/null; then
        log_error "Failed to extract npm tarball"
        rm -rf "$tmp_dir"
        return 1
    fi

    local extracted="${tmp_dir}/package"
    if [[ ! -d "$extracted" ]]; then
        log_error "Extracted npm tarball missing 'package' directory"
        rm -rf "$tmp_dir"
        return 1
    fi

    # Replace old npm with new
    rm -rf "$npm_dir"
    mv "$extracted" "$npm_dir"

    # Verify
    local new_ver="unknown"
    if [[ -n "$node_bin" && -x "$node_bin" ]]; then
        new_ver=$("$node_bin" "${npm_dir}/bin/npm-cli.js" --version 2>/dev/null || echo "unknown")
    else
        new_ver=$(grep '"version"' "${npm_dir}/package.json" 2>/dev/null | head -1 | grep -o '"[0-9][^"]*"' | tr -d '"')
    fi
    log_ok "npm upgraded: v${old_ver} → v${new_ver}"

    rm -rf "$tmp_dir"
}

# Check if Node.js is already downloaded with correct version AND architecture
# Usage: check_existing <node_bin> [expected_arch]
#   expected_arch: "arm64" or "x64" (optional, skips arch check if omitted)
check_existing() {
    local node_bin="$1"
    local expected_arch="$2"
    if [[ -f "$node_bin" ]]; then
        # Check version
        local existing_ver
        existing_ver=$("$node_bin" --version 2>/dev/null || echo "")
        if [[ "$existing_ver" != "v${NODE_VERSION}" ]]; then
            return 1
        fi
        # Check architecture (macOS only, using `file` command)
        if [[ -n "$expected_arch" && "$(uname -s)" == "Darwin" ]]; then
            local file_info
            file_info=$(file "$node_bin" 2>/dev/null || echo "")
            if [[ "$expected_arch" == "arm64" && "$file_info" != *"arm64"* ]]; then
                log_warn "Architecture mismatch: expected arm64, got x86_64"
                return 1
            fi
            if [[ "$expected_arch" == "x64" && "$file_info" != *"x86_64"* ]]; then
                log_warn "Architecture mismatch: expected x64, got arm64"
                return 1
            fi
        fi
        return 0  # Version and arch match
    fi
    return 1
}

# Download and extract Node.js for macOS
download_macos() {
    local arch="$1"  # arm64 or x64
    local node_arch
    local tauri_triple

    if [[ "$arch" == "arm64" ]]; then
        node_arch="arm64"
        tauri_triple="aarch64-apple-darwin"
    else
        node_arch="x64"
        tauri_triple="x86_64-apple-darwin"
    fi

    local tarball="node-v${NODE_VERSION}-darwin-${node_arch}.tar.xz"
    local url="${NODE_BASE_URL}/${tarball}"
    local node_bin="${RESOURCES_DIR}/bin/node"

    # Check if already downloaded with correct architecture
    if check_existing "$node_bin" "$arch"; then
        log_ok "macOS ${arch}: Already at v${NODE_VERSION}, checking npm..."
        upgrade_npm "${RESOURCES_DIR}/lib/node_modules" "${RESOURCES_DIR}/bin/node"
        return 0
    fi

    log_info "Downloading Node.js v${NODE_VERSION} for macOS ${arch}..."

    local tmp_dir
    tmp_dir=$(mktemp -d)
    trap "rm -rf '$tmp_dir'" RETURN

    # Download
    curl -sL "$url" -o "${tmp_dir}/${tarball}"

    # Extract — strip the top-level directory
    log_info "Extracting..."
    mkdir -p "$RESOURCES_DIR"
    tar xf "${tmp_dir}/${tarball}" -C "$tmp_dir"

    # Copy full distribution (replacing any existing)
    local extracted_dir="${tmp_dir}/node-v${NODE_VERSION}-darwin-${node_arch}"
    rm -rf "$RESOURCES_DIR"
    mkdir -p "$RESOURCES_DIR"
    cp -R "${extracted_dir}/bin" "$RESOURCES_DIR/"
    cp -R "${extracted_dir}/lib" "$RESOURCES_DIR/"

    # Resolve symlinks: npm/npx are symlinks, but Tauri resource copy may not
    # preserve them. Replace with actual shell scripts.
    for cmd in npm npx; do
        local link_target
        link_target=$(readlink "${RESOURCES_DIR}/bin/${cmd}" 2>/dev/null || echo "")
        if [[ -n "$link_target" ]]; then
            local cli_name
            if [[ "$cmd" == "npm" ]]; then cli_name="npm-cli"; else cli_name="npx-cli"; fi
            rm -f "${RESOURCES_DIR}/bin/${cmd}"
            cat > "${RESOURCES_DIR}/bin/${cmd}" <<EOF
#!/bin/sh
basedir=\$(cd "\$(dirname "\$0")" && pwd)
exec "\$basedir/node" "\$basedir/../lib/node_modules/npm/bin/${cli_name}.js" "\$@"
EOF
            chmod +x "${RESOURCES_DIR}/bin/${cmd}"
        fi
    done

    # Remove unnecessary files to reduce size
    rm -rf "${RESOURCES_DIR}/bin/corepack"
    rm -rf "${RESOURCES_DIR}/include"
    rm -rf "${RESOURCES_DIR}/share"
    rm -rf "${RESOURCES_DIR}/lib/node_modules/corepack"

    chmod +x "${RESOURCES_DIR}/bin/node"

    # Upgrade npm — bundled npm 11.9.0 has minizlib bug on Windows.
    # Even for macOS builds, upgrade ensures consistency across platforms.
    upgrade_npm "${RESOURCES_DIR}/lib/node_modules" "${RESOURCES_DIR}/bin/node"

    log_ok "macOS ${arch}: Node.js v${NODE_VERSION} ready"
}

# Download Node.js for Windows (used in CI/CD cross-build)
download_windows() {
    local arch="$1"  # x64 or arm64
    local zipfile="node-v${NODE_VERSION}-win-${arch}.zip"
    local url="${NODE_BASE_URL}/${zipfile}"

    log_info "Downloading Node.js v${NODE_VERSION} for Windows ${arch}..."

    local tmp_dir
    tmp_dir=$(mktemp -d)
    trap "rm -rf '$tmp_dir'" RETURN

    curl -sL "$url" -o "${tmp_dir}/${zipfile}"

    log_info "Extracting..."
    unzip -q "${tmp_dir}/${zipfile}" -d "$tmp_dir"

    local extracted_dir="${tmp_dir}/node-v${NODE_VERSION}-win-${arch}"
    rm -rf "$RESOURCES_DIR"
    mkdir -p "$RESOURCES_DIR"

    # Windows: flat structure (node.exe, npm.cmd, npx.cmd, node_modules/)
    cp "${extracted_dir}/node.exe" "$RESOURCES_DIR/"
    cp "${extracted_dir}/npm.cmd" "$RESOURCES_DIR/" 2>/dev/null || true
    cp "${extracted_dir}/npx.cmd" "$RESOURCES_DIR/" 2>/dev/null || true
    cp "${extracted_dir}/npm" "$RESOURCES_DIR/" 2>/dev/null || true
    cp "${extracted_dir}/npx" "$RESOURCES_DIR/" 2>/dev/null || true
    cp -R "${extracted_dir}/node_modules" "$RESOURCES_DIR/" 2>/dev/null || true

    # Remove corepack
    rm -f "${RESOURCES_DIR}/corepack.cmd" "${RESOURCES_DIR}/corepack"
    rm -rf "${RESOURCES_DIR}/node_modules/corepack"

    # Upgrade npm — Windows layout uses node_modules/ (no lib/ prefix).
    # Can't run node.exe on macOS for version check, pass empty string.
    upgrade_npm "${RESOURCES_DIR}/node_modules" ""

    log_ok "Windows ${arch}: Node.js v${NODE_VERSION} ready"
}

# ========================================
# Main
# ========================================

echo ""
echo -e "${CYAN}╔═══════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║${NC}  ${GREEN}Node.js v${NODE_VERSION} Download${NC}               ${CYAN}║${NC}"
echo -e "${CYAN}╚═══════════════════════════════════════════╝${NC}"
echo ""

# Handle --clean flag
if [[ "$1" == "--clean" ]]; then
    log_warn "Cleaning existing Node.js resources..."
    rm -rf "$RESOURCES_DIR"
    mkdir -p "$RESOURCES_DIR"
    touch "$RESOURCES_DIR/.gitkeep"
    shift
fi

if [[ "$1" == "--all" ]]; then
    # Download for all platforms (CI/CD)
    log_info "Downloading for ALL platforms..."
    # Note: For cross-platform builds, each platform build downloads its own.
    # This mode is for pre-populating caches.
    download_macos "arm64"
    download_macos "x64"
    # Windows requires a separate build environment
    log_warn "Windows binaries must be downloaded on the Windows build machine"
elif [[ "$1" == "--windows" ]]; then
    download_windows "${2:-x64}"
elif [[ "$1" == "--target" ]]; then
    # Download for a specific macOS architecture (used by build_macos.sh for cross-compilation)
    TARGET_ARCH="${2:-}"
    if [[ "$TARGET_ARCH" == "arm64" || "$TARGET_ARCH" == "aarch64" ]]; then
        download_macos "arm64"
    elif [[ "$TARGET_ARCH" == "x64" || "$TARGET_ARCH" == "x86_64" ]]; then
        download_macos "x64"
    else
        log_error "Invalid target architecture: '${TARGET_ARCH}' (expected: arm64, x64, aarch64, x86_64)"
        exit 1
    fi
else
    # Download for current platform only
    ARCH=$(uname -m)
    PLATFORM=$(uname -s)

    if [[ "$PLATFORM" == "Darwin" ]]; then
        if [[ "$ARCH" == "arm64" ]]; then
            download_macos "arm64"
        else
            download_macos "x64"
        fi
    elif [[ "$PLATFORM" == "Linux" ]]; then
        log_warn "Linux support: download manually from ${NODE_BASE_URL}"
    else
        log_error "Unsupported platform: $PLATFORM"
        exit 1
    fi
fi

echo ""
log_ok "Done! Node.js resources at: ${RESOURCES_DIR}"
echo ""

# Show contents
if [[ -f "${RESOURCES_DIR}/bin/node" ]]; then
    local_ver=$("${RESOURCES_DIR}/bin/node" --version 2>/dev/null || echo "unknown")
    log_info "Bundled node version: ${local_ver}"
    log_info "Contents:"
    du -sh "${RESOURCES_DIR}" 2>/dev/null | awk '{print "  Total: " $1}'
    du -sh "${RESOURCES_DIR}/bin/node" 2>/dev/null | awk '{print "  node binary: " $1}'
    du -sh "${RESOURCES_DIR}/lib/node_modules/npm" 2>/dev/null | awk '{print "  npm: " $1}'
elif [[ -f "${RESOURCES_DIR}/node.exe" ]]; then
    log_info "Windows Node.js extracted"
fi
