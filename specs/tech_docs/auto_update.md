# PM Copilot 自动更新系统

## 设计理念

采用类似 Chrome/VSCode 的**静默更新**机制：
- 用户无需选择是否更新
- 无下载进度显示
- 更新完全在后台静默完成
- 仅在更新就绪后显示「重启更新」按钮

## 架构概览

```
应用启动 → 延迟5秒 → 静默检查更新
                         ↓
                   有新版本? → 静默后台下载 (用户无感知)
                         ↓
                   下载完成 → 顶栏显示「重启更新」按钮
                         ↓
                   用户点击 → 重启并应用更新
                   或
                   下次启动 → 自动应用更新
```

## 技术实现

### Rust 侧

| 文件 | 说明 |
|------|------|
| `src-tauri/Cargo.toml` | 添加 `tauri-plugin-updater` 和 `tauri-plugin-process` |
| `src-tauri/tauri.conf.json` | updater 配置、endpoints、pubkey |
| `src-tauri/capabilities/default.json` | updater 权限 |
| `src-tauri/src/updater.rs` | 静默检查、下载、重启命令 |
| `src-tauri/src/lib.rs` | 插件注册、启动时触发检查 |

### 前端侧

| 文件 | 说明 |
|------|------|
| `src/renderer/hooks/useUpdater.ts` | 监听更新就绪事件、提供重启方法 |
| `src/renderer/components/CustomTitleBar.tsx` | 显示「重启更新」按钮 |

### 核心流程

```typescript
// Rust 侧 (updater.rs)
check_update_on_startup()
  → sleep(5秒)
  → check_and_download_silently()
    → 检查 https://download.ai-matrix.site/update/darwin-aarch64.json
    → 如有更新，静默下载 (只记日志，无 UI 事件)
    → 下载完成后 emit("updater:ready-to-restart", { version })

// 前端侧 (useUpdater.ts)
listen("updater:ready-to-restart")
  → setUpdateReady(true)
  → setUpdateVersion(version)

// UI (CustomTitleBar.tsx)
if (updateReady) → 显示「重启更新」按钮
onClick → restartAndUpdate() → relaunch()
```

### 更新检查策略

- **启动时检查**: 应用启动后延迟 5 秒，静默检查并下载
- **定时检查**: 每 4 小时检查一次 (如果还没有待安装的更新)
- **完全静默**: 检查和下载过程用户完全无感知

---

## CI/CD 配置

### GitHub Secrets

在 GitHub 仓库 Settings → Secrets and variables → Actions 中添加:

| Secret | 说明 | 获取方式 |
|--------|------|---------|
| `TAURI_SIGNING_PRIVATE_KEY` | Tauri 签名私钥 | `cat ~/.tauri/pm-copilot.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 私钥密码 | 生成密钥时设置的密码 |
| `R2_ACCESS_KEY_ID` | R2 Access Key ID | Cloudflare R2 API Token |
| `R2_SECRET_ACCESS_KEY` | R2 Secret Access Key | Cloudflare R2 API Token |
| `R2_ACCOUNT_ID` | Cloudflare Account ID | Dashboard URL 中的 ID |

### 生成签名密钥

```bash
cd /path/to/hermitcrab
npx tauri signer generate -w ~/.tauri/pm-copilot.key
```

生成的公钥需要更新到 `tauri.conf.json` 的 `plugins.updater.pubkey` 字段。

---

## Cloudflare R2 配置

### 1. 创建 Bucket

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com)
2. 左侧菜单 → **R2 Object Storage**
3. **Create bucket** → 名称: `pm-copilot-releases`

### 2. 创建 API Token

1. R2 页面 → **Manage R2 API Tokens**
2. **Create API token**
3. 配置:
   - Token name: `pm-copilot-release`
   - Permissions: **Object Read & Write**
   - Specify bucket: `pm-copilot-releases`
4. 复制 Access Key ID 和 Secret Access Key

### 3. 配置公开访问

**方式一: 自定义域名 (推荐)**

1. Bucket Settings → Public access → **Connect Domain**
2. 输入: `download.ai-matrix.site`
3. 在 DNS 添加 CNAME 记录指向 R2

**方式二: R2.dev 子域名**

1. Public access → 启用 **R2.dev subdomain**
2. 修改 `tauri.conf.json` 中的 endpoint URL

### 4. 获取 Account ID

- Dashboard 右上角头像 → Account Home
- URL 格式: `https://dash.cloudflare.com/{ACCOUNT_ID}`

---

## R2 目录结构 (自动创建)

```
pm-copilot-releases/
├── update/
│   ├── darwin-aarch64.json    # Apple Silicon 更新清单 (Tauri Updater)
│   ├── darwin-x86_64.json     # Intel Mac 更新清单 (Tauri Updater)
│   └── latest.json            # 网站下载页 API
└── releases/
    └── v{VERSION}/
        ├── PM Copilot_{VERSION}_aarch64.app.tar.gz  # Updater 用
        ├── PM Copilot_{VERSION}_x64.app.tar.gz      # Updater 用
        ├── PM Copilot_{VERSION}_aarch64.dmg         # 网站下载用
        └── PM Copilot_{VERSION}_x64.dmg             # 网站下载用
```

> 目录由 GitHub Actions 自动创建，无需手动操作。

---

## 发布新版本

### 方式一: Git Tag 触发

**触发规则**: `v` 开头的 tag 会自动触发构建

| Tag | 是否触发 |
|-----|---------|
| `v0.1.0` | ✓ |
| `v0.2.0` | ✓ |
| `v1.0.0-beta` | ✓ |
| `0.2.0` | ✗ (没有 v 前缀) |
| `release-0.2.0` | ✗ |

```bash
# 1. 更新版本号（两个文件都要改）
# package.json: "version": "0.2.0"
# src-tauri/tauri.conf.json: "version": "0.2.0"

# 2. 提交
git add -A
git commit -m "chore: release v0.2.0"

# 3. 打 tag（必须 v 开头）
git tag v0.2.0

# 4. 推送代码和 tag
git push origin main --tags
```

推送 tag 后，GitHub Actions 自动开始构建。

### 方式二: 手动触发

1. GitHub 仓库 → **Actions** → **Release**
2. **Run workflow**
3. 输入版本号 (如 `0.2.0`)
4. 点击运行

---

## 验证发布

### 1. 检查 GitHub Release

- 应有 Draft release 包含 DMG 文件

### 2. 检查 R2 文件

```bash
# 检查更新清单
curl https://download.ai-matrix.site/update/darwin-aarch64.json
```

预期返回:
```json
{
  "version": "0.2.0",
  "notes": "PM Copilot v0.2.0",
  "pub_date": "2026-01-23T14:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "...",
      "url": "https://download.ai-matrix.site/releases/v0.2.0/PM Copilot_0.2.0_aarch64.app.tar.gz"
    }
  }
}
```

### 3. 本地测试更新

1. 构建旧版本 (如 v0.1.0)
2. 发布新版本到 R2 (如 v0.2.0)
3. 运行旧版本
4. 等待 5 秒后，顶栏应出现「重启更新」按钮

---

## 用户体验流程

```
┌─────────────────────────────────────────────────────────────┐
│  用户正常使用应用                                            │
│                                                             │
│  (后台静默: 检查更新 → 发现新版本 → 下载完成)                  │
│                                                             │
│  顶栏出现按钮:  [🔄 重启更新]  [⚙️]                          │
│                                                             │
│  用户可以:                                                   │
│  • 点击按钮 → 立即重启并更新                                  │
│  • 忽略按钮 → 下次启动时自动应用更新                          │
└─────────────────────────────────────────────────────────────┘
```

---

## 文件格式

### Tauri Updater 清单 (darwin-aarch64.json / darwin-x86_64.json)

供客户端自动更新使用：

```json
{
  "version": "0.2.0",
  "notes": "PM Copilot v0.2.0",
  "pub_date": "2026-01-23T14:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "base64编码的签名",
      "url": "https://download.ai-matrix.site/releases/v0.2.0/PM Copilot_0.2.0_aarch64.app.tar.gz"
    }
  }
}
```

### 网站下载 API (latest.json)

供官网下载页面使用：

```json
{
  "version": "0.2.0",
  "pub_date": "2026-01-23T14:00:00Z",
  "release_notes": "PM Copilot v0.2.0",
  "downloads": {
    "mac_arm64": {
      "name": "Apple Silicon",
      "url": "https://download.ai-matrix.site/releases/v0.2.0/PM Copilot_0.2.0_aarch64.dmg"
    },
    "mac_intel": {
      "name": "Intel Mac",
      "url": "https://download.ai-matrix.site/releases/v0.2.0/PM Copilot_0.2.0_x64.dmg"
    }
  }
}
```

**网站前端示例**:

```typescript
// 获取最新版本信息
const res = await fetch('https://download.ai-matrix.site/update/latest.json');
const data = await res.json();

// 显示版本号
console.log(`最新版本: v${data.version}`);

// 根据用户设备选择下载链接
const isMacARM = /* 检测 Apple Silicon */;
const downloadUrl = isMacARM
  ? data.downloads.mac_arm64.url
  : data.downloads.mac_intel.url;
```

---

## 故障排查

### 更新检查失败

1. 检查网络是否能访问 `download.ai-matrix.site`
2. 检查 CSP 配置是否允许该域名
3. 查看 Rust 日志 `[Updater]` 前缀

### 签名验证失败

1. 确认 `tauri.conf.json` 中的 pubkey 正确
2. 确认 CI 使用的私钥与 pubkey 匹配
3. 检查 .sig 文件是否正确上传

### 「重启更新」按钮不显示

1. 检查 Console 是否有 `[useUpdater] Update ready:` 日志
2. 检查 Rust 日志是否有下载完成的记录
3. 确认 `updater:ready-to-restart` 事件被正确发送
