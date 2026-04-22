# PM Copilot CLI 架构

> 最后更新：v0.1.54 (2026-03-28)

## 概述

PM Copilot 内置了一个自配置 CLI 工具（`pm-copilot`），让 AI 和用户都能通过命令行管理应用配置。CLI 是一个轻量 TypeScript 脚本，解析命令行参数后转发为 HTTP 请求到 Sidecar 的 Admin API，所有业务逻辑都在 Sidecar 侧。

## 设计动机

GUI 能做的配置操作（MCP 管理、Provider 配置、Agent Channel 管理、定时任务等），AI 也应该能做。传统方式是让 AI 输出操作步骤让用户去 GUI 点击，但这违背了 Agent 产品的自主性原则。CLI 让 AI 通过 Bash 工具**直接执行**管理操作，能力与 GUI 对等。

## 架构图

```
┌─────────────────────────────────────────────────────────────────────┐
│ 场景 1：AI 内部调用（主要用途）                                       │
│                                                                     │
│ 用户: "帮我配个 MCP"                                                 │
│   → AI Bash 工具 → `pm-copilot mcp add --id xxx ...`                  │
│   → PATH 查找 ~/.pm-copilot/bin/pm-copilot                              │
│   → Bun 执行 pm-copilot.ts                                            │
│   → fetch(127.0.0.1:${PM_COPILOT_PORT}/api/admin/mcp/add)             │
│   → Admin API 写 config → SSE 广播 → 前端同步                        │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│ 场景 2：用户终端调用（次要用途）                                       │
│                                                                     │
│ 终端: `PM Copilot mcp list` 或 `pm-copilot mcp list`                    │
│   → cli.rs:is_cli_mode() 检测 CLI 参数                               │
│   → 不启动 GUI / 不杀 sidecar / 不触发单实例焦点                      │
│   → 找到 bundled Bun + ~/.pm-copilot/bin/pm-copilot                      │
│   → 读 ~/.pm-copilot/sidecar.port 找到 Global Sidecar 端口             │
│   → 注入 PM_COPILOT_PORT → 转发到 Admin API                            │
└─────────────────────────────────────────────────────────────────────┘
```

## 组件分层

| 层 | 文件 | 职责 |
|----|------|------|
| **Rust CLI 入口** | `src-tauri/src/cli.rs` | 检测 CLI 模式、查找 Bun 和脚本、发现端口、spawn 子进程 |
| **CLI 脚本** | `src/cli/pm-copilot.ts` | 参数解析、命令路由、HTTP 调用、输出格式化 |
| **CLI 同步** | `src-tauri/src/commands.rs` (`cmd_sync_cli`) | 版本门控拷贝脚本到用户目录 |
| **Admin API** | `src/server/admin-api.ts` | 业务逻辑：验证 → 写 config → 更新内存状态 → SSE 广播 |
| **PATH 注入** | `src/server/agent-session.ts` (`buildClaudeSessionEnv`) | 将 `~/.pm-copilot/bin` 加入 SDK 子进程 PATH |

## 文件布局

```
源码侧（开发）                              用户侧（运行时）
─────────────────                          ─────────────────
src/cli/                                   ~/.pm-copilot/
├── pm-copilot.ts   ──── cmd_sync_cli ────►  ├── bin/
└── pm-copilot.cmd                           │   ├── pm-copilot       (chmod 755, 去掉 .ts 后缀)
                                           │   ├── pm-copilot.cmd   (Windows)
src-tauri/src/                             │   └── agent-browser  (其他工具 wrapper)
├── cli.rs        (CLI 模式入口)            ├── .cli-version      ("1" — 版本门控)
└── commands.rs   (cmd_sync_cli)           └── sidecar.port       (Global Sidecar 端口)
```

## CLI 脚本设计

### 执行方式

```bash
#!/usr/bin/env bun    ← pm-copilot.ts 第一行 shebang
```

CLI 脚本有两种执行方式：
1. **AI Bash 工具调用**：SDK 子进程的 PATH 包含 `~/.pm-copilot/bin`，直接 `pm-copilot mcp list`，shebang 找到 PATH 中的 bun 执行
2. **Rust CLI 入口调用**：`cli.rs` 显式调用 `bun ~/.pm-copilot/bin/pm-copilot <args>`

### 端口发现

```
优先级：--port 标志 > PM_COPILOT_PORT 环境变量
```

- **AI 调用场景**：`buildClaudeSessionEnv()` 注入 `PM_COPILOT_PORT` 环境变量（当前 Session Sidecar 端口）
- **终端调用场景**：`cli.rs` 从 `~/.pm-copilot/sidecar.port` 文件读取 Global Sidecar 端口，注入 `PM_COPILOT_PORT`

### 命令体系

```
pm-copilot <group> <action> [args] [flags]

Groups:
  mcp       管理 MCP 工具服务器（list/add/remove/enable/disable/env/test）
  model     管理模型供应商（list/add/remove/set-key/set-default/verify）
  agent     管理 Agent 与 Channel（list/enable/disable/set/channel/runtime-status）
  cron      管理定时任务（list/add/start/stop/remove/update/runs/status）
  plugin    管理 OpenClaw 插件（list/install/remove）
  config    读写应用配置（get/set）
  status    查看应用运行状态
  version   查看版本
  reload    热重载配置

Global flags:
  --help      帮助
  --json      JSON 输出
  --dry-run   预览不执行
  --port NUM  覆盖端口
```

### 请求-响应模式

```typescript
// CLI 脚本的所有调用都是同一个模式
const result = await fetch(`http://127.0.0.1:${PORT}/api/admin/${group}/${action}`, {
  method: 'POST',
  body: JSON.stringify(body),
});
```

Admin API 的响应格式统一：
```json
{ "success": true, "data": { ... }, "hint": "optional message" }
{ "success": false, "error": "error description" }
{ "success": true, "dryRun": true, "preview": { ... } }
```

## 版本门控同步机制

### 问题

CLI 脚本不能直接放在 app bundle 里使用，因为：
1. SDK 子进程的 PATH 不包含 app bundle 内部路径（各平台结构不同，且包含不应暴露给 AI 的二进制文件）
2. macOS app bundle 内资源文件没有可执行权限（shebang 执行需要 +x）
3. 文件名需从 `pm-copilot.ts` → `pm-copilot`（去掉 .ts 后缀，shebang 才能直接跑）

### 方案

```
app 启动 → ConfigProvider → invoke('cmd_sync_cli')
  → 读 ~/.pm-copilot/.cli-version
  → 内容 == CLI_VERSION 常量 → 跳过（return Ok(false)）
  → 不等 → 拷贝 Resources/cli/pm-copilot.ts → ~/.pm-copilot/bin/pm-copilot
        → chmod 755（Unix）
        → 拷贝 pm-copilot.cmd（Windows）
        → 写 .cli-version = CLI_VERSION
```

**开发约束**：修改 `src/cli/pm-copilot.ts` 或 `src/cli/pm-copilot.cmd` 后，MUST bump `CLI_VERSION`（`src-tauri/src/commands.rs`），否则用户端 CLI 不会更新。

### 与 ADMIN_AGENT_VERSION 的关系

| 门控 | 控制内容 | 文件 | 版本文件 |
|------|---------|------|---------|
| `CLI_VERSION` | CLI 脚本 (`pm-copilot.ts`, `pm-copilot.cmd`) | `~/.pm-copilot/.cli-version` | `src-tauri/src/commands.rs` |
| `ADMIN_AGENT_VERSION` | 小助理 CLAUDE.md + Skills | `~/.pm-copilot/.admin-agent-version` | `src-tauri/src/commands.rs` |

两个版本门控**独立运作**，修改 CLI 不需要 bump 小助理版本，反之亦然。

## Rust CLI 入口（场景 2）

`cli.rs` 让用户可以在终端直接运行 CLI 命令，无需启动 GUI：

```bash
# macOS — 直接调用 app 二进制
/Applications/PM Copilot.app/Contents/MacOS/PM Copilot mcp list

# 或者创建 alias
alias pm-copilot='/Applications/PM Copilot.app/Contents/MacOS/PM Copilot'
pm-copilot status
```

### 检测逻辑

```rust
const CLI_COMMANDS: &[&str] = &[
    "mcp", "model", "agent", "config", "status", "reload", "version",
    "cron", "plugin",
];

pub fn is_cli_mode(args: &[String]) -> bool {
    args.iter().any(|a| CLI_COMMANDS.contains(&a.as_str()) || a == "--help" || a == "-h")
}
```

应用 `main()` 在 Tauri 初始化前检查 CLI 模式，提前分流：
- **CLI 模式**：不启动 GUI、不杀 sidecar、不触发单实例窗口焦点
- **GUI 模式**：正常启动 Tauri 桌面应用

### Windows 特殊处理

```rust
#[cfg(windows)]
{
    // windows_subsystem = "windows" 隐藏了控制台
    // CLI 模式需要重新附着到父控制台才能看到 stdout/stderr
    AttachConsole(ATTACH_PARENT_PROCESS);
}
```

### 端口发现

```rust
fn discover_sidecar_port() -> Option<String> {
    // 读取 ~/.pm-copilot/sidecar.port（Global Sidecar 启动时写入）
    // 校验是合法端口号（防止陈旧/损坏文件）
}
```

**前提**：PM Copilot GUI 必须已经运行（Global Sidecar 存活），CLI 才能连接。如果 app 未运行，CLI 脚本会报 `ECONNREFUSED` 并提示用户。

## Admin API

Admin API 注册在 Sidecar 的 `/api/admin/*` 路由下，提供与 GUI 对等的管理能力：

| 路由 | 能力 |
|------|------|
| `/api/admin/mcp/*` | MCP 服务器 CRUD、启用/禁用、环境变量管理、连通性测试 |
| `/api/admin/model/*` | Provider CRUD、API Key 设置、模型验证、默认供应商切换 |
| `/api/admin/agent/*` | Agent 启用/禁用、属性设置、Channel CRUD、运行时状态查询 |
| `/api/admin/cron/*` | 定时任务 CRUD、启停、执行历史、状态查询 |
| `/api/admin/plugin/*` | OpenClaw 插件安装/卸载/列表 |
| `/api/admin/config/*` | 通用配置读写 |
| `/api/admin/status` | 应用运行状态 |
| `/api/admin/version` | 版本号 |
| `/api/admin/reload` | 热重载配置 |
| `/api/admin/help` | 命令帮助文本 |

### 写入模式

所有写操作遵循相同模式：

```
CLI → Admin API → atomicModifyConfig() → 写 config.json（磁盘优先）
                → 更新 Sidecar 内存状态（setMcpServers 等）
                → broadcast() SSE 事件 → 前端 React 状态同步
```

这确保了 CLI 修改和 GUI 修改产生完全相同的效果。

## PATH 注入

`buildClaudeSessionEnv()` 构造 SDK 子进程的 PATH，决定 AI Bash 工具能找到哪些命令：

```
PATH 优先级：
  bundledBunDir          → 内置 Bun（跑我们自己的代码）
  systemNodeDirs         → 用户安装的 Node.js（npm 更可靠）
  bundledNodeDir         → 内置 Node.js（fallback）
  ~/.pm-copilot/bin        → CLI 工具（pm-copilot、agent-browser）
  系统 PATH              → 用户其他工具
```

`~/.pm-copilot/bin` 是**用户可见命令**的投放点，只放安全的工具 wrapper。内部运行时 shim（如 node→bun）放在 `~/.pm-copilot/shims/`，由各 wrapper 脚本自行 prepend，不暴露到全局 PATH。

## 安全设计

| 层面 | 措施 |
|------|------|
| **本地绑定** | Admin API 只在 `127.0.0.1` 上监听，无外部访问 |
| **端口隔离** | 每个 Sidecar 有独立端口，CLI 连接到对应 Session 的 Sidecar |
| **无持久化凭据** | CLI 脚本不存储任何 API Key，配置读写全走 Sidecar |
| **权限控制** | 脚本权限 755（owner rwx），`~/.pm-copilot/` 目录权限遵循用户 HOME 策略 |

## 排查指南

| 问题 | 排查方法 |
|------|---------|
| `ECONNREFUSED` | PM Copilot GUI 未运行，先启动应用 |
| `PM_COPILOT_PORT not set` | 在 AI Bash 环境外直接运行了脚本（缺少环境变量注入） |
| CLI 脚本不存在 | 应用未初始化过（`cmd_sync_cli` 未执行），启动一次 GUI |
| CLI 版本过旧 | `~/.pm-copilot/.cli-version` 与 `commands.rs` 的 `CLI_VERSION` 不匹配，重启应用触发同步 |
| 终端 `pm-copilot` 找不到 | 场景 2 需要用完整路径或创建 alias，`~/.pm-copilot/bin` 默认不在 shell PATH |
