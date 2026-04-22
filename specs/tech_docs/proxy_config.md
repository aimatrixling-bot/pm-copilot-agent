# 代理配置说明

**更新日期**: 2026-03-27
**版本**: v0.1.54

---

## 📋 概述

PM Copilot 支持统一的代理配置，用于访问外部服务（Anthropic API、CDN 等）。代理配置存储在 `~/.pm-copilot/config.json` 中，由应用的「设置 - 通用 - 网络代理」管理。

---

## 🔧 配置文件格式

**路径**: `~/.pm-copilot/config.json`

```json
{
  "proxySettings": {
    "enabled": true,
    "protocol": "http",
    "host": "127.0.0.1",
    "port": 7890
  }
}
```

### 字段说明

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `enabled` | boolean | ✅ | false | 是否启用代理 |
| `protocol` | string | ❌ | "http" | 代理协议：`http` 或 `socks5` |
| `host` | string | ❌ | "127.0.0.1" | 代理服务器地址 |
| `port` | number | ❌ | 7890 | 代理服务器端口 _// 默认值: proxy_config.rs:7_ |

---

## 🌐 代理应用范围

### ✅ 使用代理的场景

1. **Claude Agent SDK (Bun Sidecar)**
   - 访问 Anthropic API (`api.anthropic.com`)
   - 通过环境变量 `HTTP_PROXY` / `HTTPS_PROXY` 注入
   - **实现**: `src-tauri/src/sidecar.rs:772-781`

2. **Rust Updater**
   - 检查更新 (`download.ai-matrix.site/update/*.json`)
   - 下载更新包 (`download.ai-matrix.site/releases/`)
   - **实现**: `src-tauri/src/updater.rs` + `proxy_config.rs`

3. **其他外部资源**
   - 下载二维码等 CDN 资源

### ❌ 不使用代理的场景

**所有 localhost 通信自动排除代理**：
- Rust → Bun Sidecar (`127.0.0.1:31415-31418`) _// 端口定义见 src-tauri/src/sidecar.rs:76_
- Tauri IPC (`http://ipc.localhost`)
- 内部进程间通信

排除列表：`localhost`, `127.0.0.1`, `::1`

---

## 🛠️ 技术实现

### 架构图

```
┌──────────────────────────────────────────────────────────┐
│                  PM Copilot Application                     │
├──────────────────────────────────────────────────────────┤
│                                                            │
│  ┌─────────────────┐          ┌──────────────────┐       │
│  │  Rust Updater   │          │  Bun Sidecar     │       │
│  │  (CDN 访问)     │          │  (SDK 访问 API)  │       │
│  └────────┬────────┘          └────────┬─────────┘       │
│           │                             │                  │
│           │ 读取配置                     │ 环境变量注入     │
│           ▼                             ▼                  │
│  ┌──────────────────────────────────────────────┐         │
│  │        ~/.pm-copilot/config.json               │         │
│  │  { proxySettings: { enabled, host, port } }  │         │
│  └──────────────────────────────────────────────┘         │
│           │                             │                  │
│           │ 使用用户代理                 │ 使用用户代理     │
│           ▼                             ▼                  │
│  ┌─────────────────┐          ┌──────────────────┐       │
│  │  Clash / V2Ray  │          │  Clash / V2Ray   │       │
│  │  127.0.0.1:7890 │          │  127.0.0.1:7890  │       │
│  └────────┬────────┘          └────────┬─────────┘       │
│           │                             │                  │
└───────────┼─────────────────────────────┼──────────────────┘
            │                             │
            ▼                             ▼
    download.ai-matrix.site          api.anthropic.com
```

### 代码实现

#### 1. 共享配置读取 (`proxy_config.rs`)

```rust
pub fn read_proxy_settings() -> Option<ProxySettings> {
    // 从 ~/.pm-copilot/config.json 读取
    // 仅当 enabled=true 时返回
}

pub fn build_client_with_proxy(builder: ClientBuilder) -> Client {
    if let Some(settings) = read_proxy_settings() {
        // 使用用户配置的代理，但排除 localhost
        builder.proxy(Proxy::all(url)?.no_proxy(...))
    } else {
        // 继承系统网络行为（reqwest 默认代理检测：env vars + macOS 系统代理）
        builder
    }
}
```

#### 2. 子进程代理注入 (`proxy_config::apply_to_subprocess`)

```rust
if let Some(proxy_settings) = read_proxy_settings() {
    cmd.env("HTTP_PROXY", proxy_url);
    cmd.env("HTTPS_PROXY", proxy_url);
    cmd.env("NO_PROXY", "localhost,...");
    cmd.env("PM_COPILOT_PROXY_INJECTED", "1"); // TypeScript 端区分显式注入 vs 系统继承
} else {
    // 继承系统网络行为，但始终注入 NO_PROXY 保护 Bun 的 localhost fetch 调用
    cmd.env("NO_PROXY", "localhost,...");
}
```

#### 3. Rust Updater (`updater.rs`)

```rust
let builder = reqwest::Client::builder()
    .user_agent("PM Copilot-Updater/0.1.7")
    .timeout(Duration::from_secs(30));

let client = proxy_config::build_client_with_proxy(builder)?;
```

#### 4. Rust SSE Proxy (`sse_proxy.rs`)

```rust
// 访问 localhost，强制禁用代理
let client = reqwest::Client::builder()
    .no_proxy()  // 确保直连 localhost
    .build()?;
```

---

## 🔍 常见问题

### Q1: 为什么配置了代理后，localhost 还是连不上？

**A**: 不应该发生！PM Copilot 已自动排除 localhost。如果遇到此问题：
1. 检查 `NO_PROXY` 环境变量是否被覆盖
2. 查看日志是否有代理相关错误

### Q2: 代理配置不生效怎么办？

**A**: 检查步骤：
1. 确认 `~/.pm-copilot/config.json` 中 `enabled: true`
2. 重启应用（代理配置在启动时读取）
3. 查看日志：
   ```
   [proxy_config] Using proxy for external requests: http://127.0.0.1:7890
   ```

### Q3: 支持哪些代理协议？

**A**: 目前支持：
- ✅ HTTP 代理 (`http://`)
- ✅ HTTPS 代理 (`https://`)
- ✅ SOCKS5 代理 (`socks5://`) - 通过 `protocol: "socks5"` 配置

### Q4: 可以使用系统代理吗？

**A**:
- **启用应用代理** → 使用应用配置的代理
- **禁用应用代理** → 继承系统网络行为（与其他软件一致）

禁用时，应用不会主动干预网络代理设置，行为与普通软件一致：如果系统开了全局代理/TUN 模式，流量会走代理；如果系统没有代理，则直连。Localhost 通信始终直连（由 `local_http` 模块保障）。

---

## 🐛 调试

### 查看代理日志

**Rust 日志** (`~/.pm-copilot/logs/unified-*.log`):
```
[proxy_config] Using proxy for external requests: http://127.0.0.1:7890
[proxy_config] No proxy configured, inheriting system network behavior
```

**Bun Sidecar 日志**:
```bash
# 设置环境变量后查看
HTTP_PROXY=http://127.0.0.1:7890 bun src/server/index.ts
```

### 测试代理连通性

```bash
# 测试代理是否可用
curl -x http://127.0.0.1:7890 https://api.anthropic.com/v1/messages

# 测试 CDN 访问
curl -x http://127.0.0.1:7890 https://download.ai-matrix.site/update/darwin-aarch64.json
```

---

## 📝 开发注意事项

### 添加新的外部 HTTP 请求

如果需要添加新的外部 HTTP 请求，请使用 `proxy_config::build_client_with_proxy`：

```rust
use crate::proxy_config;

let builder = reqwest::Client::builder()
    .timeout(Duration::from_secs(30));

let client = proxy_config::build_client_with_proxy(builder)?;
```

### localhost 请求

访问 localhost 时**必须**禁用代理：

```rust
let client = reqwest::Client::builder()
    .no_proxy()  // 强制禁用代理
    .build()?;
```

---

## 🔄 历史问题

### v0.1.7 之前的问题

**问题**: Windows 上 Rust reqwest 默认使用系统代理，导致访问 localhost 失败。

**错误日志**:
```
[proxy] Request failed: error sending request for url (http://127.0.0.1:31415/...)
```

**根本原因**:
- reqwest 默认使用系统代理（如 Clash: 127.0.0.1:7890）
- Windows 系统代理未正确处理 localhost 排除
- 导致 localhost 请求被发送到代理，连接失败

**修复**:
- v0.1.7: 所有 localhost 请求强制 `.no_proxy()`
- v0.1.7: 外部请求统一使用应用内代理配置

---

**最后更新**: 2026-01-31
**相关 PR**: dev/prd-0.1.7
**相关文件**:
- `src-tauri/src/proxy_config.rs` - 共享代理配置
- `src-tauri/src/sidecar.rs` - Bun Sidecar 代理注入
- `src-tauri/src/updater.rs` - Updater 代理配置
- `src-tauri/src/sse_proxy.rs` - SSE 代理禁用

---

## 代理使用场景完整列表

| 组件 | 代理来源 | 特殊处理 |
|------|---------|---------|
| Rust reqwest（HTTP proxy） | `proxy_config::read_proxy_settings()` | `local_http` 内置 `.no_proxy()` |
| Bun Sidecar subprocess | env vars（`HTTP_PROXY` 等） | SDK 子进程继承 |
| OpenAI Bridge subprocess | **代理变量被剥离** | SDK→Bridge 是 loopback，Bridge→upstream 从 `process.env` 读代理 |
| Plugin Bridge | `apply_proxy_env()` 注入 | 与 Sidecar 相同逻辑 |
| Updater | Rust reqwest | 使用 `local_http` |

### SOCKS5 桥接机制

Bun/Node.js 的 `fetch()` 不支持 `socks5://` 环境变量。系统启动 HTTP-to-SOCKS5 桥接代理（`src/server/utils/socks-bridge.ts`）在本地随机端口，SDK subprocess 连接桥接代理而非直连 SOCKS5 服务器。

### OpenAI Bridge 代理剥离

当供应商使用 OpenAI 协议时，SDK subprocess 的 `ANTHROPIC_BASE_URL` 指向 sidecar loopback。此时**必须剥离所有代理变量**，否则 SDK 的 `fetchOptions.proxy` 会将 loopback 请求路由到系统代理（→ 超时/502）。Bridge handler 自身从 `process.env` 读取代理访问上游 API。
