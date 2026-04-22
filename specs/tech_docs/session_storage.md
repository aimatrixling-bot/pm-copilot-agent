# Session 存储架构

## 概述

PM Copilot 使用基于文件系统的会话存储方案，采用 JSONL 格式存储消息数据，实现高效的追加写入和崩溃恢复。

> **注意**：由于 Claude Agent SDK 内置了独立的 session 持久化机制（默认开启），运行时实际存在**双重存储**——PM Copilot 在 `~/.pm-copilot/sessions/` 写入精简业务数据，SDK 在 `~/.claude/projects/` 写入完整消息树。两者各司其职，详见本文档末尾「[双重存储](#双重存储pm-copilot-与-sdk)」章节。

## 存储结构

```
~/.pm-copilot/
├── sessions.json          # 会话索引（SessionMetadata 数组）
├── sessions.lock/         # 文件锁（目录，非文件）
├── sessions/
│   ├── {session-id}.jsonl # 消息数据（JSONL 格式）
│   └── ...
└── attachments/
    └── {session-id}/      # 附件文件
```

## JSONL 格式优势

相比传统 JSON 存储，JSONL（JSON Lines）格式具有以下优势：

| 特性 | JSON | JSONL |
|------|------|-------|
| 追加消息 | O(n) 全文件重写 | O(1) 追加一行 |
| 崩溃恢复 | 文件可能损坏 | 最多丢失最后一行 |
| 并发写入 | 需要文件锁 | 追加通常是原子的 |
| 部分读取 | 需要解析整个文件 | 可以逐行读取 |

## 核心数据类型

### SessionMetadata（存储在 sessions.json）

```typescript
interface SessionMetadata {
    id: string;              // 会话 ID（v0.1.11+ 为 UUID）
    agentDir: string;        // 关联的 Agent 目录
    title: string;           // 会话标题
    createdAt: string;       // 创建时间
    lastActiveAt: string;    // 最后活跃时间
    sdkSessionId?: string;   // SDK session_id（v0.1.11+ 统一后 === id）
    unifiedSession?: boolean;// 统一 Session ID 标记（v0.1.11+）
    stats?: SessionStats;    // 统计信息
}

interface SessionStats {
    messageCount: number;        // 用户消息数
    totalInputTokens: number;    // 总输入 Token
    totalOutputTokens: number;   // 总输出 Token
    totalCacheReadTokens?: number;
    totalCacheCreationTokens?: number;
}
```

### SessionMessage（存储在 {session-id}.jsonl）

```typescript
interface SessionMessage {
    id: string;
    role: 'user' | 'assistant';
    content: string;         // JSON 字符串或纯文本
    timestamp: string;
    attachments?: MessageAttachment[];
    usage?: MessageUsage;    // 仅 assistant 消息
    toolCount?: number;      // 工具调用次数
    durationMs?: number;     // 响应耗时
}
```

## 性能优化

### 1. 行数缓存

避免每次保存消息都读取整个 JSONL 文件来计数：

```typescript
const lineCountCache = new Map<string, number>();

function getCachedLineCount(sessionId: string, filePath: string): number {
    const cached = lineCountCache.get(sessionId);
    if (cached !== undefined) return cached;

    // 冷启动时读取文件
    const count = countLinesFromFile(filePath);
    lineCountCache.set(sessionId, count);
    return count;
}

// 追加后更新缓存
function incrementLineCount(sessionId: string, delta: number): void {
    const current = lineCountCache.get(sessionId) ?? 0;
    lineCountCache.set(sessionId, current + delta);
}
```

### 2. 增量统计

只计算新增消息的统计数据，而非全量重算。统计更新在文件锁内执行，避免 TOCTOU 竞态：

```typescript
const newMessages = messages.slice(existingCount);
if (newMessages.length > 0) {
    // 追加新消息（JSONL 文件不需要锁 —— 每个 session 文件只有一个 Sidecar 写入）
    appendFileSync(filePath, linesToAppend);

    // 统计更新在锁内执行（sessions.json 被多个 Sidecar 共享）
    const incrementalStats = calculateSessionStats(newMessages);
    withSessionsLock(() => {
        const session = getSessionMetadata(sessionId);
        // 在锁内读取 metadata，计算新 stats，写入 sessions.json
        // 避免读写之间被其他 Sidecar 修改
    });
}
```

### 3. 文件锁机制

防止多 Sidecar 进程并发写入 sessions.json：

```typescript
// 使用目录创建作为原子锁操作
const SESSIONS_LOCK_FILE = join(PM_COPILOT_DIR, 'sessions.lock');

function acquireSessionsLock(): boolean {
    for (let attempt = 0; attempt <= LOCK_MAX_RETRIES; attempt++) {
        try {
            mkdirSync(SESSIONS_LOCK_FILE);  // 原子操作
            return true;
        } catch {
            // 检查陈旧锁（>30s）并释放，否则短暂等待后重试
        }
    }
}
```

**设计决策**：使用同步锁（短暂 busy-wait）而非异步锁，因为：
- 每个 Tab 独立 Sidecar 进程，跨进程竞争罕见
- 锁持有时间极短（~1ms，仅 JSON 写入）
- 最多重试 3 次 × 10ms = 30ms 阻塞，实际不可感知
- 异步锁会级联影响 `persistMessagesToStorage` → `handleMessageComplete` 调用链，重构成本高于收益

## 错误处理

### JSONL 逐行容错

单行损坏不影响其他消息的读取：

```typescript
function readMessagesFromJsonl(filePath: string): SessionMessage[] {
    const lines = content.split('\n').filter(line => line.trim());
    const messages: SessionMessage[] = [];

    for (let i = 0; i < lines.length; i++) {
        try {
            messages.push(JSON.parse(lines[i]));
        } catch {
            // 跳过损坏行，继续处理
            console.warn(`Skipping corrupted line ${i + 1}`);
        }
    }
    return messages;
}
```

### 迁移中断恢复

处理 JSON → JSONL 迁移过程中断的情况：

```typescript
function migrateToJsonl(sessionId: string): SessionMessage[] {
    // 如果两个文件都存在，说明迁移中断
    if (existsSync(jsonlPath) && existsSync(legacyPath)) {
        // 优先使用 JSONL，清理旧文件
        unlinkSync(legacyPath);
        return readMessagesFromJsonl(jsonlPath);
    }
    // 正常迁移流程...
}
```

## Session 切换

加载历史会话时，必须先正确终止旧 session，再将存储的消息加载到内存：

```typescript
export async function switchToSession(targetSessionId: string): Promise<boolean> {
    // 1. 中止持久 session（唤醒 generator 门控 + interrupt）
    abortPersistentSession();
    messageQueue.length = 0;
    if (sessionTerminationPromise) await sessionTerminationPromise;

    // 2. 重置状态
    shouldAbortSession = false;
    messageResolver = null;
    messages.length = 0;

    // 3. 加载历史消息到内存（支持增量保存）
    const sessionData = getSessionData(targetSessionId);
    if (sessionData?.messages) {
        for (const storedMsg of sessionData.messages) {
            messages.push(convertToMessageWire(storedMsg));
        }
    }

    // 4. 更新 sessionId + resume 策略
    sessionId = targetSessionId;
    // resume 逻辑见 session_id_architecture.md
}
```

## 安全考虑

### Session ID 校验

防止路径遍历攻击：

```typescript
function isValidSessionId(sessionId: string): boolean {
    return /^[a-zA-Z0-9-]+$/.test(sessionId)
        && sessionId.length > 0
        && sessionId.length < 100;
}
```

## 向后兼容

- `stats` 和 `usage` 字段均为可选
- 旧会话显示 `- 条消息 · - tokens`
- 新消息开始积累统计数据
- 支持从旧版 JSON 格式自动迁移到 JSONL

## 双重存储：PM Copilot 与 SDK

### 背景

Claude Agent SDK 内置了独立的 session 持久化机制（`persistSession` 选项，默认 `true`）。PM Copilot 调用 SDK 时，**两端各自独立写入会话数据**，形成双重存储。

### 存储位置对比

```
~/.pm-copilot/sessions/                        ← PM Copilot 写入
├── {session-id}.jsonl                       ← 精简消息格式

~/.claude/projects/{project-slug}/           ← SDK 自动写入
├── {sdk-session-id}.jsonl                   ← SDK 内部完整格式
```

其中 `{project-slug}` 由 `agentDir` 路径转换而来（例如 `/Users/zhihu/Documents/project/ai-max` → `-Users-zhihu-Documents-project-ai-max`）。

### 数据格式差异

**SDK JSONL**（每行包含完整元数据）：
```jsonc
// 消息链路：parentUuid 构建消息树，isSidechain 标记分支对话
{ "type": "user",      "parentUuid": "...", "isSidechain": false, "cwd": "...", "sessionId": "...", "version": "...", "gitBranch": "...", "message": {...}, "uuid": "...", "timestamp": "...", "permissionMode": "..." }
{ "type": "assistant",  "parentUuid": "...", "isSidechain": false, "cwd": "...", "sessionId": "...", "version": "...", "gitBranch": "...", "message": {...}, "requestId": "...", "uuid": "...", "timestamp": "..." }
// 操作记录
{ "type": "queue-operation", "operation": "...", "timestamp": "...", "sessionId": "..." }
```

**PM Copilot JSONL**（精简业务数据）：
```jsonc
{ "id": "...", "role": "user",      "content": "...", "timestamp": "..." }
{ "id": "...", "role": "assistant",  "content": "...", "timestamp": "...", "usage": {...}, "toolCount": 3, "durationMs": 4200 }
```

### 数据量对比（截至 2026-02）

| 指标 | 数值 |
|------|------|
| 同时存在于两处的 session 数 | 198 / 198 |
| SDK 存储总量 | 36.4 MB |
| PM Copilot 存储总量 | 21.1 MB |
| SDK / PM Copilot 体积比 | ~1.7x |
| 合计磁盘占用 | 57.5 MB |

SDK 数据更大是因为每条消息携带完整的上下文元数据（`cwd`、`gitBranch`、`version`、`permissionMode` 等），加上 `queue-operation` 等内部操作记录。

### 为什么不能禁用 SDK 持久化

设置 `persistSession: false` **会导致两个关键功能失效**：

1. **Session Resume**：配置变更（Provider/Model/MCP/Agent）时通过 `resumeSessionId` 恢复对话上下文，SDK resume 机制依赖其自身 JSONL 文件中的消息树（`parentUuid` 链）来重建完整的会话状态。
2. **`/insights` 报告**：SDK 内置命令，扫描 `~/.claude/projects/` 下的 session 数据生成使用分析报告，禁用后无数据源。

### 为什么不能去掉 PM Copilot 存储

PM Copilot 自身的存储服务于不同的业务场景：

1. **会话列表与历史浏览**：前端通过 `sessions.json` 索引和 `{id}.jsonl` 加载历史消息
2. **业务指标**：`usage`（Token 用量）、`toolCount`（工具调用次数）、`durationMs`（响应耗时）等 SDK 不记录的数据
3. **统一索引**：`sessions.json` 提供全局会话元数据（标题、创建时间、统计摘要），无需遍历文件系统

### 架构决策

**保留双重存储，各司其职**。两份数据的格式、用途、消费者完全不同：

| 维度 | SDK 存储 | PM Copilot 存储 |
|------|----------|---------------|
| 写入者 | SDK 内部自动写入 | PM Copilot `agent-session.ts` |
| 读取者 | SDK resume / `/insights` | PM Copilot 前端 UI |
| 格式 | 消息树 + 操作记录 | 扁平消息列表 + 业务指标 |
| 索引 | 无（按文件遍历） | `sessions.json` 全局索引 |
| 生命周期 | 跟随 SDK 项目目录 | 跟随 PM Copilot 数据目录 |

**长期优化方向**（非紧急）：
- 可定期清理过期的 SDK session 数据（例如 >30 天的已关闭 session）
- PM Copilot 侧可为归档 session 添加压缩（gzip JSONL）

## 相关文件

| 文件 | 职责 |
|------|------|
| `src/server/SessionStore.ts` | 存储层实现 |
| `src/server/types/session.ts` | 类型定义 |
| `src/server/agent-session.ts` | Session 管理与消息持久化 |
| `src/renderer/api/sessionClient.ts` | 前端 API 客户端 |
| `src/renderer/utils/formatTokens.ts` | Token/时长格式化工具 |
| `specs/tech_docs/session_id_architecture.md` | Session ID 统一架构 |
