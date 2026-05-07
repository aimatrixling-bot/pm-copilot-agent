# 模型兼容性矩阵

> **版本**: v0.1 | **日期**: 2026-05-07 | **状态**: 待测试
> **关联**: `backlog.md` B-02 | Eval-v3 Smoke Pack

---

## 概述

PM Copilot 支持通过 Anthropic-compatible API 接入多个 AI Provider。本文档记录各 Provider/模型与 PM Copilot 30 个 PM Skill 的兼容性测试结果。

## 测试方法

### 测试用例（3 条 Smoke）

| # | 输入 | 验证点 | 预期行为 |
|---|------|--------|---------|
| TC-1 | `/pm-prd 写一个任务管理 App 的 PRD` | 路由准确性 + Skill 执行质量 | 路由到 pm-prd，产出完整 PRD |
| TC-2 | `帮我翻译这段话：Hello World` | 非 PM 意图不误触发 | 不调用 PM Skill，直接翻译 |
| TC-3 | `紧急！生产环境崩溃了` | 紧急路由 + 响应速度 | 路由到 pm-urgent，输出澄清问题 |

### 评估维度

| 维度 | 说明 | 权重 |
|------|------|------|
| 路由准确性 | TC-1 和 TC-3 是否路由到正确 Skill | 高 |
| 输出质量 | PRD 结构完整性、方法论覆盖度 | 高 |
| 响应速度 | 首 token 时间 < 5s，完整响应 < 60s | 中 |
| 工具调用 | Skill 内的文件读写、搜索等工具是否正常 | 中 |
| Token 效率 | 不出现过度推理循环或重复输出 | 中 |

### 判定标准

| 结果 | 判定 | 说明 |
|------|------|------|
| 3/3 pass | 完全兼容 | 推荐使用 |
| 2/3 pass | 部分兼容 | 可用但有已知限制 |
| ≤1/3 pass | 不兼容 | 不推荐 |

---

## Provider 测试矩阵

### 推荐 Provider（Setup Wizard 展示）

| # | Provider | 模型 ID | API 协议 | 测试结果 | 路由 | 质量 | 速度 | 备注 |
|---|---------|---------|---------|---------|------|------|------|------|
| 1 | DeepSeek | deepseek-chat | Anthropic | 待测试 | — | — | — | 默认推荐，¥1/百万 token |
| 2 | 智谱 AI | glm-5.1 | Anthropic | 待测试 | — | — | — | 注册送免费额度 |
| 3 | SiliconFlow | Pro/deepseek-ai/DeepSeek-V3.2 | OpenAI | 待测试 | — | — | — | 多模型可选 |
| 4 | Anthropic | claude-sonnet-4-6 | Anthropic | 待测试 | — | — | — | 最强推理，成本较高 |

### 扩展 Provider

| # | Provider | 模型 ID | API 协议 | 测试结果 | 路由 | 质量 | 速度 | 备注 |
|---|---------|---------|---------|---------|------|------|------|------|
| 5 | Moonshot | kimi-k2.5 | Anthropic | 待测试 | — | — | — | Kimi 系列 |
| 6 | MiniMax | MiniMax-M2.7 | Anthropic | 待测试 | — | — | — | M2.7 最新模型 |
| 7 | Google | gemini-2.5-pro | OpenAI | 待测试 | — | — | — | maxOutputTokens: 8192 |
| 8 | 火山方舟 | doubao-seed-2.0-code | Anthropic | 待测试 | — | — | — | Coding Plan |

### 自定义 Provider

| # | Provider | 模型 ID | API 协议 | 测试结果 | 路由 | 质量 | 速度 | 备注 |
|---|---------|---------|---------|---------|------|------|------|------|
| 9 | MiMo | mimo-v2.5-pro | Anthropic | 待测试 | — | — | — | 自定义配置，见 config.json |

---

## 测试结果记录

> 以下结果需手动测试后填写。每个 Provider 执行 3 条 Smoke case，记录通过率和关键发现。

### Provider 1: DeepSeek (deepseek-chat)

**测试日期**: —
**测试环境**: —
**结果**: 待测试

| Case | 路由 | 质量 | 速度 | 通过 |
|------|------|------|------|------|
| TC-1 | — | — | — | — |
| TC-2 | — | — | — | — |
| TC-3 | — | — | — | — |

**发现**: —

### Provider 2: 智谱 AI (glm-5.1)

**测试日期**: —
**测试环境**: —
**结果**: 待测试

| Case | 路由 | 质量 | 速度 | 通过 |
|------|------|------|------|------|
| TC-1 | — | — | — | — |
| TC-2 | — | — | — | — |
| TC-3 | — | — | — | — |

**发现**: —

### Provider 3: SiliconFlow (DeepSeek-V3.2)

**测试日期**: —
**测试环境**: —
**结果**: 待测试

| Case | 路由 | 质量 | 速度 | 通过 |
|------|------|------|------|------|
| TC-1 | — | — | — | — |
| TC-2 | — | — | — | — |
| TC-3 | — | — | — | — |

**发现**: —

### Provider 4: Anthropic (claude-sonnet-4-6)

**测试日期**: —
**测试环境**: —
**结果**: 待测试

| Case | 路由 | 质量 | 速度 | 通过 |
|------|------|------|------|------|
| TC-1 | — | — | — | — |
| TC-2 | — | — | — | — |
| TC-3 | — | — | — | — |

**发现**: —

---

## 已知兼容性问题

| Provider | 问题 | 影响范围 | Workaround |
|---------|------|---------|------------|
| Google Gemini | maxOutputTokens 限制 8192 | 长文档 Skill 可能截断 | 分段输出或换 Provider |
| 火山方舟 | disableNonessential: true | 部分非核心功能可能受限 | — |
| SiliconFlow | disableNonessential: true | 同上 | — |

---

## 推荐排序

基于测试结果更新此排序（当前为默认排序）：

| 优先级 | Provider | 理由 |
|--------|---------|------|
| 1 | DeepSeek | 成本最低，推荐入门 |
| 2 | 智谱 AI | 免费额度，国产模型 |
| 3 | SiliconFlow | 多模型可选，灵活 |
| 4 | Anthropic | 最强推理，成本较高 |

---

## 测试执行指南

### 前置条件

1. PM Copilot 桌面应用已启动（`npm run tauri:dev`）
2. 目标 Provider 的 API key 已配置在 `~/.pm-copilot/config.json`

### 执行步骤

1. 在 PM Copilot 中切换到目标 Provider
2. 依次输入 3 条测试用例
3. 记录每条用例的路由结果、输出质量、响应速度
4. 填写上方对应 Provider 的测试结果表格
5. 更新推荐排序

### 自动化路径（未来）

```bash
# 使用 eval-v3 runner 测试特定 Provider
EVAL_MODEL={model_id} bun run validation/eval-v3/run-client-eval.ts
```

---

## 维护说明

- 每次新增 Provider 时添加测试条目
- 每次大版本更新后重新测试核心 Provider
- 测试结果与 `recommendedProviders.ts` 推荐顺序保持同步
