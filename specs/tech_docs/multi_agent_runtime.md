# Multi-Agent Runtime 架构

> 最后更新：v0.1.60 (2026-04-07)

## 概述

Multi-Agent Runtime 允许用户选择不同的 AI Runtime 驱动 Agent 会话。除内置 Claude Agent SDK（builtin）外，支持 Claude Code CLI 和 OpenAI Codex CLI 作为外部 Runtime。

**功能门控**：设置 → 关于 → 实验室 → 「更多 Agent Runtime」开关（`config.multiAgentRuntime`），默认关闭。

## 架构总览

```
┌─────────────────────────────────────────────────────────────────┐
│                        Bun Sidecar                              │
│                                                                 │
│   index.ts ─────── shouldUseExternalRuntime()                   │
│       │                    │                                    │
│       ▼                    ▼                                    │
│   agent-session.ts    external-session.ts                       │
│   (builtin SDK)       (CC / Codex adapter)                      │
│       │                    │                                    │
│       ▼                    ▼                                    │
│  Claude Agent SDK    ┌─────────────┐   ┌──────────────┐        │
│  (内置，直接调用)     │ claude-code  │   │  codex.ts    │        │
│                      │   .ts        │   │              │        │
│                      │ NDJSON/stdio │   │ JSON-RPC 2.0 │        │
│                      └──────┬───────┘   └──────┬───────┘        │
│                             │                  │                │
│                             ▼                  ▼                │
│                         claude CLI         codex CLI            │
│                         (-p mode)         (app-server)          │
└─────────────────────────────────────────────────────────────────┘
```

## 核心抽象

### AgentRuntime 接口 (`src/server/runtimes/types.ts`)

所有外部 Runtime 实现此接口：

```typescript
interface AgentRuntime {
  type: RuntimeType;  // 'claude-code' | 'codex'
  detect(): Promise<RuntimeDetection>;       // 检测 CLI 是否安装
  queryModels(): Promise<RuntimeModelInfo[]>; // 查询可用模型
  getPermissionModes(): RuntimePermissionMode[];
  startSession(options, onEvent): Promise<RuntimeProcess>;
  sendMessage(process, message, images?): Promise<void>;
  respondPermission(process, requestId, approved, reason?): Promise<void>;
  stopSession(process): Promise<void>;
}
```

### UnifiedEvent 统一事件

Runtime 内部协议差异通过 `UnifiedEvent` 联合类型统一，`external-session.ts` 消费同一套事件：

| 类别 | 事件 | 说明 |
|------|------|------|
| 文本 | `text_delta`, `text_stop` | AI 回复流式文本 |
| 思考 | `thinking_start/delta/stop` | 推理过程 |
| 工具 | `tool_use_start`, `tool_input_delta`, `tool_use_stop`, `tool_result` | 工具调用全生命周期 |
| 权限 | `permission_request` | 委托 PM Copilot UI 审批 |
| 生命周期 | `session_init`, `turn_complete`, `session_complete` | 会话状态 |
| 元数据 | `usage`, `log` | Token 用量、日志 |

### RuntimeType (`src/shared/types/runtime.ts`)

```typescript
type RuntimeType = 'builtin' | 'claude-code' | 'codex';
```

## Claude Code Runtime (`src/server/runtimes/claude-code.ts`)

### 协议：NDJSON over stdio

CC 以 `-p` (prompt) 模式运行，每轮对话一次进程生命周期：

```bash
claude -p \
  --output-format stream-json --input-format stream-json \
  --verbose --include-partial-messages --bare \
  --append-system-prompt "..." \
  --permission-mode acceptEdits \
  --permission-prompt-tool stdio \
  --model sonnet \
  --resume <runtimeSessionId>
```

**stdin (发送消息)**：
```json
{"type":"user","message":{"role":"user","content":"hello"}}
```

**stdout (接收事件)**：NDJSON 行流，包含 `stream_event`（文本/工具 delta）、`system`（session_init）、`result`（turn 结果）、`control_request`（权限请求）。

### 多轮续接

CC `-p` 模式每轮退出。续接通过 `--resume <sessionId>` 恢复上下文：

```
Turn 1: claude -p --session-id abc → 执行 → 退出
Turn 2: claude -p --resume abc     → 恢复上下文 → 执行 → 退出
```

### 权限模式映射

| PM Copilot | CC CLI |
|----------|--------|
| `auto` | `acceptEdits` |
| `plan` | `plan` |
| `fullAgency` | `bypassPermissions` |

### SessionStart Hook

生成临时 hook 配置文件，注入 forwarder 脚本。CC 启动后通过 hook POST `session_id` 到 Sidecar HTTP 端点 `/hook/session-start`，确保 session ID 可靠追踪。

## Codex Runtime (`src/server/runtimes/codex.ts`)

### 协议：JSON-RPC 2.0 over stdio

Codex 以 `app-server` 模式运行，进程在整个 session 生命周期内持久存活：

```
Client → Server (Request):   {"jsonrpc":"2.0","id":1,"method":"thread/start","params":{...}}
Server → Client (Response):  {"jsonrpc":"2.0","id":1,"result":{...}}
Server → Client (Notification): {"jsonrpc":"2.0","method":"item/agentMessage/delta","params":{...}}
```

### Thread 模型

| RPC 方法 | 用途 |
|---------|------|
| `initialize` | 握手，交换 capability |
| `thread/start` | 创建新 thread（含 model、approvalPolicy、sandbox） |
| `thread/resume` | 恢复已有 thread（含 threadId） |
| `turn/start` | 发送用户消息到 thread |
| `turn/interrupt` | 中断当前 turn |

### 事件映射

| Codex Notification | UnifiedEvent |
|-------------------|-------------|
| `item/agentMessage/delta` | `text_delta` |
| `item/reasoning/summaryTextDelta` | `thinking_delta` |
| `item/started` (tool types) | `tool_use_start` |
| `item/completed` (tool types) | `[tool_use_stop, tool_result]` |
| `turn/completed` | `turn_complete` |
| `thread/tokenUsage/updated` | `usage` |

### 权限模式映射

| PM Copilot | Codex approvalPolicy | sandbox |
|----------|---------------------|---------|
| `suggest` | `untrusted` | `read-only` |
| `auto-edit` | `on-request` | `workspace-write` |
| `full-auto` | `never` | `workspace-write` |
| `no-restrictions` | `never` | `danger-full-access` |

## External Session Handler (`src/server/runtimes/external-session.ts`)

统一管理两种外部 Runtime 的会话生命周期，是 `agent-session.ts` 的精简对应物。

### 三路消息发送

```typescript
sendExternalMessage(text, images?, permissionMode?, model?, context?)
```

| Case | 条件 | 行为 |
|------|------|------|
| 1 | 无 runtimeSessionId + 不在运行 | 全新 session |
| 2 | 进程已退出（CC -p 模式） | `--resume` 恢复 |
| 3 | 进程存活（Codex 持久模式） | `sendMessage()` 到 stdin |

### 内容块持久化

流式事件在 `handleUnifiedEvent()` 中被实时广播到前端（SSE），同时累积到 `PersistContentBlock[]`：

```typescript
interface PersistContentBlock {
  type: 'text' | 'tool_use' | 'thinking';
  text?: string;
  tool?: { id, name, input, inputJson, result, isError, streamIndex };
  thinking?: string;
}
```

`turn_complete` 时序列化为 `JSON.stringify(ContentBlock[])` 写入 SessionStore——与 builtin runtime 格式一致，前端 `TabProvider.tsx` 的 JSON 解析路径直接复用。

### 配置变更

Model / Permission Mode 变更 → `setExternalModel()` / `setExternalPermissionMode()` → 停止当前进程 → 下次 `sendExternalMessage` 自动以新配置 resume。

### 安全机制

| 机制 | 说明 |
|------|------|
| **并发守卫** | `startingPromise` 序列化并发 `startExternalSession` 调用 |
| **看门狗** | 10 分钟无活动（text_delta / thinking_delta / tool_input_delta / tool_result）→ 自动 kill |
| **Stale text 防护** | `lastTurnSucceeded` 标志，cron/heartbeat 路径检查，防止崩溃后返回上一轮旧回复 |
| **用户消息即时落盘** | 发送后立即 `saveSessionMessages()`，崩溃不丢用户消息 |
| **Token 用量** | 存储 Codex `usage` 事件（running total，replace 而非 accumulate），附加到 assistant message |

## 功能门控链路

```
config.multiAgentRuntime (磁盘/React state)
  │
  ├── Rust sidecar.rs: resolve_agent_runtime_from_config()
  │     → 仅当 multiAgentRuntime=true 时读取 agent.runtime
  │     → 设置 PM_COPILOT_RUNTIME 环境变量注入 Sidecar
  │
  ├── Bun factory.ts: getCurrentRuntimeType()
  │     → 读取 process.env.PM_COPILOT_RUNTIME
  │     → 未设置 → 'builtin'
  │
  └── React Chat.tsx:
        const currentRuntime = multiAgentRuntimeEnabled
          ? (currentAgent?.runtime || 'builtin')
          : 'builtin';  // ← 源头门控，下游自动安全
```

## 跨 Runtime Session 保护

当用户关闭功能后打开外部 Runtime 创建的历史 session：

1. **服务端** (`agent-session.ts:initializeAgent`)：检测 `meta.runtime !== 'builtin'` → 设 `sessionRegistered=false` → 跳过 SDK resume（避免 "No conversation found" 崩溃）
2. **前端** (`Chat.tsx`)：检测 `isCrossRuntimeSession` → 发消息时弹 ConfirmDialog → 用户可选择新开会话或留在当前页浏览历史
3. **Fork/Rewind**：外部 Runtime session 不支持（前端隐藏按钮 + 服务端 400 守卫）

## 文件索引

| 文件 | 职责 |
|------|------|
| `src/server/runtimes/types.ts` | AgentRuntime 接口 + UnifiedEvent 类型 |
| `src/server/runtimes/factory.ts` | Runtime 工厂 + 检测 |
| `src/server/runtimes/claude-code.ts` | CC Runtime 实现（NDJSON 协议） |
| `src/server/runtimes/codex.ts` | Codex Runtime 实现（JSON-RPC 2.0） |
| `src/server/runtimes/external-session.ts` | 外部 Runtime 统一会话管理 |
| `src/server/runtimes/env-utils.ts` | 环境变量增强（PATH 补全） |
| `src/shared/types/runtime.ts` | 共享类型（RuntimeType、模型列表、权限模式） |
| `src/renderer/components/RuntimeSelector.tsx` | 前端 Runtime 选择器组件 |
| `src/server/runtimes/claude-code.ts` → `FORWARDER_SCRIPT` | CC SessionStart hook 转发脚本（运行时生成至 `~/.pm-copilot/.cc-hooks/forwarder.cjs`） |
