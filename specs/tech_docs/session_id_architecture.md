# Session ID 架构

## 概述

PM Copilot 使用 Session ID 标识每次对话，用于消息存储、前端展示和 SDK 对话上下文恢复（resume）。本文档记录 Session ID 的演进历史和当前实现。

## 版本演进

### v0.1.0 ~ v0.1.10：双 ID 映射架构

早期版本维护两套独立的 Session ID：

| ID | 格式 | 生成方 | 用途 |
|----|------|--------|------|
| PM Copilot sessionId | `session-{timestamp}-{random}` | `generateSessionId()` | 消息存储、前端展示、文件命名 |
| SDK sdkSessionId | SDK 内部生成的 UUID | Claude Agent SDK | 对话上下文恢复（resume） |

```
新 session 创建流程（旧）：
1. PM Copilot 生成 sessionId = "session-1738800000-abc123"
2. 调用 query() 时不传 sessionId
3. SDK 内部生成 sdkSessionId = "213793e6-5bf8-..."
4. system-init 事件返回 session_id，存储为 sdkSessionId
5. Resume 时使用 sdkSessionId，存储时使用 sessionId
```

**问题**：需要维护两个 ID 的映射关系，增加了代码复杂度。

### v0.1.11+：统一 Session ID 架构

升级 Claude Agent SDK 到 0.2.33 后，`query()` 新增 `sessionId` 参数支持自定义会话 ID。利用此特性，新 session 创建时让 SDK 直接使用我们的 UUID，消除双 ID 映射。

| ID | 格式 | 生成方 | 用途 |
|----|------|--------|------|
| sessionId（统一） | UUID v4 | `crypto.randomUUID()` | 消息存储 + 前端展示 + SDK 上下文恢复 |

```
新 session 创建流程（新）：
1. PM Copilot 生成 sessionId = randomUUID() → "7924d439-b04f-..."
2. 调用 query({ sessionId: "7924d439-b04f-..." })
3. SDK 使用我们的 UUID 作为其 session_id
4. system-init 返回 session_id === sessionId → 确认统一
5. Resume 时直接使用 sessionId
```

## 当前实现（v0.1.18）

### 核心数据结构

```typescript
interface SessionMetadata {
    id: string;                  // 会话 ID（v0.1.11+ 为 UUID）
    agentDir: string;
    title: string;
    createdAt: string;
    lastActiveAt: string;
    sdkSessionId?: string;       // SDK session_id（统一后 === id）
    unifiedSession?: boolean;    // true = 统一架构创建的 session
    stats?: SessionStats;
    cronTaskId?: string;
}
```

### SDK `sessionId` 与 `resume` 互斥

SDK 约束：`sessionId` 和 `resume` 参数不能同时传递。

```typescript
querySession = query({
    prompt: messageGenerator(),
    options: {
        // 新 session：传 sessionId 让 SDK 使用我们的 UUID
        // Resume：传 resume 恢复对话上下文
        ...(resumeFrom
            ? { resume: resumeFrom }
            : { sessionId: sessionId }
        ),
        // 可选：rewind 截断点（与 resume 配合）
        ...(rewindResumeAt
            ? { resumeSessionAt: rewindResumeAt }
            : {}
        ),
        // ...
    }
});
```

### 持久 Session 模式（v0.1.18+）

v0.1.18 引入持久 Session 架构，`messageGenerator()` 使用 `while(true)` 循环持续 yield 消息，SDK subprocess 全程存活，不再每轮对话重启。

**`resume` 的真正用途**：仅用于以下场景，不再是每轮对话的机制：

| 场景 | 说明 |
|------|------|
| 恢复历史 session | 用户从历史记录切换到旧 session |
| Rewind 后截断历史 | `resumeSessionAt` 截断 SDK 消息树 |
| Subprocess crash 恢复 | `finally` 块触发 `schedulePreWarm()` 重建 session |
| 配置变更重启 | MCP/Agent 变更导致 session 中止后恢复 |

**核心状态变量**：

```typescript
let sessionRegistered = false;  // SDK 是否已注册此 sessionId（替代旧的 sessionIdUsedByQuery）
```

- `sessionRegistered = true`：SDK 已持久化此 session，后续只能用 `resume` 访问
- `sessionRegistered = false`：SDK 未注册，可以用 `sessionId` 创建新 session

### Session 切换 resume 逻辑

```typescript
// switchToSession() 中根据 session 类型决定 resume 策略
if (sessionMeta.unifiedSession && sessionMeta.sdkSessionId) {
    // 统一后的 session：sdkSessionId === id，直接用 id
    resumeSessionId = sessionMeta.id;
} else if (sessionMeta.sdkSessionId) {
    // 统一前的旧 session：用存储的 SDK ID
    resumeSessionId = sessionMeta.sdkSessionId;
} else {
    // 无 SDK ID 的老旧 session 或从未 query 过的 session
    resumeSessionId = undefined;
}
```

### 统一验证

system-init 事件中验证 SDK 是否确认使用了我们的 UUID：

```typescript
if (nextSystemInit.session_id) {
    const isUnified = nextSystemInit.session_id === sessionId;
    sessionRegistered = true;  // SDK 已注册此 session
    updateSessionMetadata(sessionId, {
        sdkSessionId: nextSystemInit.session_id,
        unifiedSession: isUnified,
    });
}
```

### sdkUuid 追踪（v0.1.18+）

每条消息的 SDK UUID 用于 `rewindFiles()` 和 `resumeSessionAt` 截断。

**关键规则**：assistant 的 `sdkUuid` 必须存储**最后一条**消息（text）的 UUID，而非第一条（thinking）。SDK 对一轮 assistant 回复输出多条 `type=assistant` 消息——先 thinking（UUID "A"），再 text（UUID "B"）。`resumeSessionAt` 保留指定 UUID 及之前的所有消息，若使用 thinking UUID 会丢失 text 部分。

```typescript
// 每次 type=assistant 都更新，确保最终值是最后一条（text）的 UUID
if (sdkMessage.uuid) {
    currentAssistant.sdkUuid = sdkMessage.uuid;
}
```

### Session ID 前缀约定

| 前缀 | 格式 | 用途 | 何时生成 |
|------|------|------|---------|
| 无 | UUID v4 | 标准 session | `createSessionMetadata()` / 首条消息 |
| `pending-` | `pending-{tabId}` | 新 Tab 占位符 | Tab 创建时，等待首条消息产生真实 UUID |
| `cron-standalone-` | `cron-standalone-{uuid}` | 独立定时任务 | 创建不绑定 Tab 的定时任务 |

### currentSessionUuids 追踪机制

每个 Sidecar 进程维护 `currentSessionUuids: Set<string>`，记录当前 SDK session 分配的所有消息 UUID。

| 操作 | 时机 |
|------|------|
| 清空 | 非 resume 的新 session 启动时 |
| 从磁盘 seed | `switchToSession` / `loadMessagesFromStorage` 时 |
| 追加 | SDK 返回 assistant/user 消息时 |
| 校验 | rewind/fork 时判断 UUID 是否属于当前 session |

**UUID 新鲜度规则**：若 `lastAssistantUuid ∉ currentSessionUuids`（旧 UUID，来自其他 session），rewind 拒绝使用 `resumeSessionAt`，改为新建 session。

### awaitSessionTermination 超时防护 (v0.1.53)

所有等待 session 终止的操作通过 `awaitSessionTermination(10_000, label)` 执行，带 10 秒超时。超时后强制清理状态（`querySession = null`、`isProcessing = false`、`isStreamingMessage = false`），防止死锁。

调用场景：`resetSession`、`switchToSession`、`rewindSession`、`enqueueUserMessage`（provider change）、`startStreamingSession`、`forceAbortCurrentTurnAndRecover`。

## 旧 Session 兼容

旧版本创建的 session 无 `unifiedSession` 标记，系统自动兼容：

| 场景 | `unifiedSession` | `sdkSessionId` | Resume 行为 |
|------|-------------------|----------------|-------------|
| v0.1.11+ 新 session | `true` | 等于 `id` | 使用 `id` |
| v0.1.10 及之前的 session | `undefined` | SDK 生成的 UUID | 使用 `sdkSessionId` |
| 从未 query 过的 session | `true`/`undefined` | `undefined` | 不 resume，重新开始 |

## 相关文件

| 文件 | 职责 |
|------|------|
| `src/server/types/session.ts` | `SessionMetadata` 类型定义、`createSessionMetadata()` |
| `src/server/SessionStore.ts` | `updateSessionMetadata()` 持久化 |
| `src/server/agent-session.ts` | `query()` 调用、`switchToSession()`、system-init 处理 |

## 相关文档

- [Session 存储架构](./session_storage.md) — 存储格式、JSONL、文件锁
- [SSE 状态同步](./session_state_sync.md) — 前后端状态同步、新会话机制
