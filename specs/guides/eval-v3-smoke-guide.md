# Eval-v3 Smoke Pack 操作指南

> **版本**: v0.3.0 | **更新日期**: 2026-05-07

## 概述

Eval-v3 是 PM Copilot 的行为正确性评估框架。Smoke Pack 是最小可运行的回归测试集，包含 **8 个 P0 case**，覆盖 3 个核心 track。

### Smoke Pack 组成

| Track | Case ID | 测试内容 | 预期行为 |
|-------|---------|---------|---------|
| Intent Routing | IR_001 | `/pm-prd` 显式 Skill 调用 | 路由到 pm-prd + 产出 PRD 内容 |
| Intent Routing | IR_004 | "帮我翻译这段话" 非 PM 意图 | 不触发 Skill，直接处理 |
| Intent Routing | IR_005 | "写一个任务管理 App 的 PRD" 隐式意图 | 路由到 pm-prd |
| Intent Routing | IR_006 | "竞品分析：Notion vs Obsidian" 隐式意图 | 路由到 pm-comp |
| Intent Routing | IR_009 | "排优先级" RICE 触发 | 路由到 pm-rice |
| Intent Routing | IR_010 | "紧急！生产环境崩溃了" 紧急响应 | 路由到 pm-urgent |
| Boundary Control | BC_001 | 能力边界拒绝 | 明确说"超出能力范围" |
| Boundary Control | BC_002 | 信息不足时的追问行为 | 停下来问，不用默认值填充 |
| Artifact Quality | AQ_001 | Release 保真度产出质量 | 包含量化指标 + guardrail |

### 完整评估集

除 Smoke Pack 外，eval-v3 包含 6 个 track、26 个 case：

| Track | Case 数 | 覆盖能力 |
|-------|---------|---------|
| intent-routing | 12 | 意图识别、路由准确性、Skill 调用 |
| boundary-control | 3 | 能力边界、信息不足、历史冲突 |
| artifact-quality | 3+ | 保真度控制、输出格式、可执行性 |
| workflow-orchestration | 3+ | 工作流阶段连贯性 |
| stateful-behavior | 3+ | 跨会话记忆、决策一致性 |
| user-journey | 2+ | 端到端用户流程 |

---

## 前置条件

### 必需

1. **PM Copilot 桌面应用已启动**，开发服务器运行中
   ```bash
   cd 30_Projects/personal/pm-copilot-agent/src
   npm run tauri:dev
   ```

2. **AI Provider 已配置** — `~/.pm-copilot/config.json` 中有可用的 API key
   - 默认使用 DeepSeek (`deepseek-v4-pro`)
   - 可通过 `EVAL_MODEL` 环境变量切换

3. **依赖已安装**
   ```bash
   cd 30_Projects/personal/pm-copilot-agent
   bun install
   ```

### 可选

- `OBSERVABLE=true` — 每个 case 间隔 5 秒，便于在 UI 中观察行为
- `REAL_TASKS_ONLY=true` — 仅运行真实任务场景（跳过 synthetic case）

---

## 运行步骤

### 1. 启动 PM Copilot

在终端 A：
```bash
cd 30_Projects/personal/pm-copilot-agent/src
npm run tauri:dev
```

等待应用窗口出现，确认开发服务器就绪（默认端口 31415）。

### 2. 运行 Smoke Pack

在终端 B：
```bash
cd 30_Projects/personal/pm-copilot-agent

# 默认配置（DeepSeek, 自动检测端口）
bun run validation/eval-v3/run-client-eval.ts

# 指定模型
EVAL_MODEL=claude-sonnet-4 bun run validation/eval-v3/run-client-eval.ts

# 可观测模式（每 case 间隔 5s）
OBSERVABLE=true bun run validation/eval-v3/run-client-eval.ts

# 指定端口（如果自动检测失败）
CLIENT_PORT=31415 bun run validation/eval-v3/run-client-eval.ts
```

### 3. 查看结果

结果保存在 `validation/eval-v3/results-client-{model}/` 目录：

```
results-client-deepseek-v4-pro/
├── IR_001_result.json       # 每个 case 的详细结果
├── IR_004_result.json
├── ...
├── _summary.json            # 汇总报告
└── _run_meta.json           # 运行元信息（模型、时间、配置）
```

`_summary.json` 结构：
```json
{
  "total": 8,
  "passed": 7,
  "failed": 1,
  "passRate": "87.5%",
  "byTrack": {
    "intent-routing": { "passed": 5, "total": 6 },
    "boundary-control": { "passed": 2, "total": 2 },
    "artifact-quality": { "passed": 1, "total": 1 }
  },
  "byBM": {
    "BM-1": { "passed": 5, "total": 6 },
    "BM-2": { "passed": 2, "total": 2 },
    "BM-3": { "passed": 0, "total": 0 }
  }
}
```

---

## 判定标准

| 结果 | 判定 | 行动 |
|------|------|------|
| **8/8 pass** | 通过 | 可发布 |
| **7/8 pass** | 可接受 | 检查失败 case，评估是否为已知限制 |
| **≤6/8 pass** | 需修复 | 不能发布，先修复失败 case |

### 单 case 判定

每个 case 的 `_result.json` 包含：
- `passed`: boolean
- `verdict`: "pass" | "fail" | "partial"
- `details`: 具体评分依据
- `messages`: 完整对话记录

失败 case 需关注：
- **路由错误** → 检查 `skill-router.ts` 规则
- **输出质量不足** → 检查对应 SKILL.md 和 references/
- **超时** → 检查模型响应速度、网络状况

---

## 环境变量参考

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `EVAL_MODEL` | `deepseek-v4-pro` | 评估使用的模型 ID |
| `CLIENT_PORT` | 自动检测 | PM Copilot 开发服务器端口 |
| `PROVIDER_BASE` | `https://api.deepseek.com/anthropic` | Provider API 地址 |
| `PROVIDER_KEY` | 从 config.json 读取 | Provider API key |
| `OBSERVABLE` | `false` | 可观测模式（case 间隔 5s） |
| `REAL_TASKS_ONLY` | `false` | 仅运行真实任务场景 |

---

## 常见问题

### Q: 端口自动检测失败

**症状**: `Could not auto-detect client port, defaulting to 31415`

**解决**: 手动指定端口：
```bash
CLIENT_PORT=31415 bun run validation/eval-v3/run-client-eval.ts
```

确认 PM Copilot 已启动且开发服务器就绪。

### Q: API key 读取失败

**症状**: Provider key 为空，请求 401

**解决**: 确认 `~/.pm-copilot/config.json` 存在且包含有效的 provider 配置。或手动指定：
```bash
PROVIDER_KEY=sk-xxx bun run validation/eval-v3/run-client-eval.ts
```

### Q: case 超时

**症状**: 单 case 运行超过 10 分钟被强制终止

**可能原因**:
- 模型响应慢（DeepSeek 高峰期）
- Agent 进入推理循环
- 网络不稳定

**解决**: 检查网络，或换用更快的模型（如 `claude-haiku-4-5-20251001`）。

### Q: 路由不命中

**症状**: IR_001 等路由 case 失败，Agent 没有调用预期的 Skill

**排查**:
1. 检查 `src/server/skill-router.ts` 路由规则是否覆盖该 case
2. 检查 SKILL.md 的触发信号是否与 case 输入匹配
3. 检查 Agent 是否因 context 压力而降级

---

## 扩展：运行完整评估集

```bash
# 运行全部 26 个 case（Smoke + Full）
bun run validation/eval-v3/run-client-eval.ts

# 仅运行真实任务场景
REAL_TASKS_ONLY=true bun run validation/eval-v3/run-client-eval.ts
```

完整评估集的结果目录与 Smoke Pack 相同，`_summary.json` 会包含所有 track 的汇总。
