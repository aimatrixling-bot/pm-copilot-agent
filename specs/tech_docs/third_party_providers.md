# 第三方 LLM 供应商集成指南

本文档总结了在 PM Copilot 中集成第三方 LLM 供应商（DeepSeek、智谱、Moonshot、MiniMax 等）的关键技术经验。

---

## 核心原理

Claude Agent SDK 支持通过环境变量配置第三方 API：

| 环境变量 | 作用 |
|----------|------|
| `ANTHROPIC_BASE_URL` | API 端点地址 |
| `ANTHROPIC_AUTH_TOKEN` | API 认证令牌 |
| `ANTHROPIC_API_KEY` | API 密钥（SDK 可能使用此变量）|
| `ANTHROPIC_MODEL` | 默认模型 ID |

---

## 关键经验

### 1. 环境变量必须同时设置两个 Key 变量

SDK 不同版本可能使用不同的环境变量名，建议同时设置：

```typescript
env.ANTHROPIC_AUTH_TOKEN = apiKey;
env.ANTHROPIC_API_KEY = apiKey;
```

### 2. 切换回官方订阅时必须清除环境变量

问题：切换到第三方后再切回 Anthropic 订阅，如果 `ANTHROPIC_BASE_URL` 仍存在，请求会发到错误的端点。

解决：显式删除环境变量：

```typescript
if (currentProviderEnv?.baseUrl) {
  env.ANTHROPIC_BASE_URL = currentProviderEnv.baseUrl;
} else {
  delete env.ANTHROPIC_BASE_URL; // 关键！
}
```

### 3. API Key 存储与读取

- **存储位置**: `apiKeys[provider.id]`（通过 useConfig 获取）
- **常见错误**: 误用 `provider.apiKey`（始终为 undefined）
- **正确做法**: 

```typescript
const { apiKeys } = useConfig();
const apiKey = apiKeys[currentProvider.id];
```

### 4. Provider 配置结构

```typescript
interface Provider {
  id: string;
  name: string;
  config: {
    baseUrl?: string;  // 第三方 API 端点
  };
  models: ModelEntity[];
  primaryModel: string;
}
```

---

## 预设供应商 BaseURL

| 供应商 | BaseURL | 类型 | 备注 |
|--------|---------|------|------|
| DeepSeek | `https://api.deepseek.com/anthropic` | 模型官方 | Anthropic 兼容 |
| Moonshot | `https://api.moonshot.cn/anthropic` | 模型官方 | Anthropic 兼容 |
| 智谱 AI | `https://open.bigmodel.cn/api/anthropic` | 模型官方 | Anthropic 兼容 |
| MiniMax | `https://api.minimaxi.com/anthropic` | 模型官方 | Anthropic 兼容 |
| 火山方舟 Coding Plan | `https://ark.cn-beijing.volces.com/api/coding` | 云服务商 | 字节跳动 |
| 火山方舟 API调用 | `https://ark.cn-beijing.volces.com/api/compatible` | 云服务商 | 字节跳动 |
| 硅基流动 | `https://api.siliconflow.cn/` | 云服务商 | authType: api_key |
| ZenMux | `https://zenmux.ai/api/anthropic` | 云服务商 | 多模型聚合路由 |
| OpenRouter | `https://openrouter.ai/api` | 云服务商 | authType: auth_token_clear_api_key |

> **注意**：所有供应商使用 Anthropic 兼容端点。不同供应商 `authType` 可能不同，详见 `types.ts` 中的 `PRESET_PROVIDERS`。

---

## 数据流

```
┌─────────────────────────────────────────────────────────────┐
│ Chat.tsx                                                     │
│  - 从 apiKeys[provider.id] 获取 API Key                     │
│  - 从 provider.config.baseUrl 获取端点                       │
│  - 构建 providerEnv: { baseUrl, apiKey }                    │
└──────────────────────────┬──────────────────────────────────┘
                           │ POST /chat/send
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ server/index.ts                                              │
│  - 解析 providerEnv 并传递给 enqueueUserMessage             │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ agent-session.ts                                             │
│  - 存储到 currentProviderEnv 模块变量                        │
│  - buildClaudeSessionEnv() 设置环境变量                      │
│  - SDK query() 使用这些环境变量                             │
└─────────────────────────────────────────────────────────────┘
```

---

## 调试技巧

查看后端日志确认环境变量是否正确设置：

```
[env] ANTHROPIC_BASE_URL set to: https://open.bigmodel.cn/api/anthropic
[env] ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY set from provider config
[agent] starting query with model: glm-4.7
```

如果看到 `apiKeySource: "none"`，说明 API Key 未正确传递。

---

## ⚠️ 关键陷阱：会话中途切换供应商

### 问题

环境变量（`ANTHROPIC_BASE_URL`）在 SDK 子进程启动时设置，**无法在运行时更新**。如果用户在会话中途切换供应商：

1. `currentProviderEnv` 更新 ✅
2. 正在运行的 SDK 进程仍使用旧的 baseUrl ❌
3. API 请求发往错误的端点 → 报错"模型不存在"

### 解决方案

检测供应商变化时，**终止当前 SDK 会话并重启**，根据目标 provider 类型决定是否 resume：

```typescript
if (providerChanged && querySession) {
  // Resume 策略：Anthropic 官方会校验 thinking block 签名
  // 三方 → 官方：不 resume（签名不兼容）
  // 其他组合：resume（保留上下文）
  const switchingFromThirdPartyToAnthropic = currentProviderEnv?.baseUrl && !providerEnv?.baseUrl;
  resumeSessionId = switchingFromThirdPartyToAnthropic ? undefined : systemInitInfo?.session_id;

  currentProviderEnv = providerEnv;
  abortPersistentSession();  // 统一中止：设置标志 + 唤醒 generator 门控 + interrupt

  // 等待旧会话完全终止，避免竞态条件
  if (sessionTerminationPromise) {
    await sessionTerminationPromise;
  }

  // schedulePreWarm() 会在 finally 中自动触发
}
```

### 注意事项

- **应用层 session 保留**：`sessionId`、`messages` 不变
- **SDK 层 session 重建**：`querySession` 通过 pre-warm 重新创建
- **跨回合状态清理**：`streamIndexToToolId`、`toolResultIndexToId`、`childToolToParent` 在 `handleMessageComplete()` 中自动清理
- **统一中止**：所有需要终止 session 的场景必须使用 `abortPersistentSession()`，它同时唤醒 generator 的 Promise 门控并调用 `interrupt()`

---

## ⚠️ 关键陷阱：Thinking Block 签名与 Resume

### 问题

Anthropic 官方 API 会在 thinking block 中嵌入签名，resume session 时校验签名。第三方供应商（DeepSeek、GLM 等）不校验签名。

从第三方供应商切换到 Anthropic 官方后 resume session 会报错：`Invalid signature in thinking block`

### Resume 规则

| From | To | Resume | 原因 |
|------|-----|--------|------|
| 三方（有 baseUrl） | Anthropic 官方（无 baseUrl） | ❌ 新 session | 签名不兼容 |
| Anthropic 官方 | 三方 | ✅ resume | 三方不校验签名 |
| 三方 A | 三方 B | ✅ resume | 三方不校验签名 |
| Anthropic 订阅 | Anthropic API Key | ✅ resume | 签名兼容 |

### 区分标准

```typescript
// 有 baseUrl = 第三方兼容供应商
// 无 baseUrl = Anthropic 官方（订阅或 API Key 模式）
const isThirdParty = !!providerEnv?.baseUrl;
```

---

## ⚠️ 关键陷阱：订阅模式的 providerEnv

### 原则

- `providerEnv = undefined`：使用 SDK 默认认证（Anthropic 订阅）
- `providerEnv = { baseUrl, apiKey }`：使用第三方 API

前端构建 `providerEnv` 时，**订阅模式不发送 providerEnv**：

```typescript
const providerEnv = currentProvider && currentProvider.type !== 'subscription'
  ? { baseUrl: ..., apiKey: ..., authType: ... }
  : undefined;
```

后端检测订阅切换：

```typescript
// 从 API 模式切换到订阅模式
const switchingToSubscription = !providerEnv && currentProviderEnv;
```

---

## ⚠️ 关键陷阱：智谱 GLM-4.7 的 server_tool_use

### 背景

智谱 GLM-4.7 支持服务端工具调用（如 `webReader`、`analyze_image`），返回 `server_tool_use` 类型的内容块，与 Claude 的 `tool_use`（客户端工具）不同：

| 类型 | 执行位置 | 示例工具 |
|------|----------|----------|
| `tool_use` | 客户端（本地 Sidecar） | MCP 服务器工具 |
| `server_tool_use` | 服务端（API 提供商） | webReader, analyze_image |

### 问题 1：input 是 JSON 字符串

智谱返回的 `server_tool_use.input` 是 **JSON 字符串**，而非对象：

```json
{
  "type": "server_tool_use",
  "input": "{\"url\": \"https://example.com\", \"type\": \"markdown\"}"
}
```

**解决方案**：

```typescript
let parsedInput: Record<string, unknown> = {};
if (typeof serverToolBlock.input === 'string') {
  try {
    parsedInput = JSON.parse(serverToolBlock.input);
  } catch {
    parsedInput = { raw: serverToolBlock.input };
  }
} else {
  parsedInput = serverToolBlock.input || {};
}
```

### 问题 2：装饰性文本包裹

智谱会在 `server_tool_use` 前后插入装饰性文本块，如果不过滤会显示为普通内容：

```
🌐 Z.ai Built-in Tool: mcp__web_reader__webReader
**Input:**
```json
{"url": "https://example.com", "type": "markdown"}
```
Executing on server side...
```

以及结果包裹：

```
**Output:** webReader_result_summary:[{"title":"..."}]
```

**解决方案**：在后端 `agent-session.ts` 中过滤这类文本：

```typescript
// 检测并过滤装饰性工具文本
function checkDecorativeToolText(text: string): { filtered: boolean; reason?: string } {
  if (!text || text.length < 50 || text.length > 5000) {
    return { filtered: false };
  }
  const trimmed = text.trim();

  // Pattern 1: 智谱 tool invocation wrapper - requires ALL markers
  const hasZaiToolMarker = trimmed.includes('Z.ai Built-in Tool:');
  const hasInputMarker = trimmed.includes('**Input:**');
  const hasJsonBlock = trimmed.includes('```json') || trimmed.includes('Executing on server');
  if (hasZaiToolMarker && hasInputMarker && hasJsonBlock) {
    return { filtered: true, reason: 'zhipu-tool-invocation-wrapper' };
  }

  // Pattern 2: 智谱 tool output wrapper - requires ALL markers
  if (trimmed.startsWith('**Output:**') && trimmed.includes('_result_summary:')) {
    const hasJsonContent = trimmed.includes('[{') || trimmed.includes('{"');
    if (hasJsonContent) {
      return { filtered: true, reason: 'zhipu-tool-output-wrapper' };
    }
  }

  return { filtered: false };
}
```

**注意事项**：
- 使用**多条件匹配**，避免误伤正常内容
- 添加长度限制（50-5000 字符），进一步降低误判风险
- 记录过滤日志，便于调试

---

## 自定义供应商 (v0.1.51+)

用户可通过 Settings 或 Admin API 添加自定义 OpenAI 兼容供应商。自定义供应商配置持久化到 `~/.pm-copilot/providers/{id}.json`。

### modelAliases 默认值

自定义供应商如果没有主动设置 modelAliases，`getEffectiveModelAliases()` 和 `resolveProviderEnv()` 会用 `primaryModel` 或第一个可用模型作为 sonnet/opus/haiku 的 fallback，防止子 Agent 发送 raw `claude-*` 到三方 API。

