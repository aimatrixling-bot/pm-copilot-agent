# PM Copilot 快速入门指南

> **版本**: v0.3.0 | **日期**: 2026-05-07
> **适用**: 首次使用 PM Copilot 的产品经理

---

## 3 分钟上手

### 第 1 步：配置 AI Provider（1 分钟）

首次启动时，Setup Wizard 会引导你：

1. 选择 AI Provider（推荐 DeepSeek — ¥1/百万 token，或智谱 AI — 注册送免费额度）
2. 填入 API Key
3. 点击"测试连接"确认可用

> **没有 API Key？** 去 [DeepSeek Platform](https://platform.deepseek.com/api_keys) 或 [智谱 AI](https://open.bigmodel.cn/usercenter/apikeys) 免费注册获取。

### 第 2 步：试一个 Skill（1 分钟）

在对话框输入以下任意一条：

```
/pm-prd 写一个任务管理 App 的 PRD
/pm-comp 分析 Notion 和 Obsidian 的竞品差异
/pm-rice 帮我排一下这 5 个功能的优先级
```

PM Copilot 会自动路由到对应的 PM Skill，产出结构化的 PM 交付物。

### 第 3 步：理解路由（1 分钟）

PM Copilot 会根据你说的话自动选择合适的 Skill：

| 你说的话 | PM Copilot 做什么 |
|---------|-----------------|
| "写一个 PRD" | 路由到 `pm-prd`，生成结构化需求文档 |
| "竞品分析" | 路由到 `pm-comp`，多维度竞品对比 |
| "紧急！生产出 bug 了" | 路由到 `pm-urgent`，快速澄清问题 |
| "帮我翻译这段话" | 直接处理，不调用 PM Skill |

**你不需要记住所有 Skill 名称**，用自然语言描述你的需求即可。

---

## 常用命令速查

### 核心 Skill（最常用）

| 命令 | 用途 | 示例 |
|------|------|------|
| `/pm-prd` | 写 PRD | `/pm-prd 写一个用户反馈系统的 PRD` |
| `/pm-comp` | 竞品分析 | `/pm-comp Notion vs Obsidian vs Logseq` |
| `/pm-rice` | 排优先级 | `/pm-rice 帮我排这 5 个功能` |
| `/pm-decision` | 做决策 | `/pm-decision 选 A 方案还是 B 方案` |
| `/pm-prototype` | 生成原型 | `/pm-prototype 根据这个 PRD 生成原型` |

### 进阶 Skill

| 命令 | 用途 |
|------|------|
| `/pm-persona` | 用户画像 |
| `/pm-roadmap` | 产品路线图 |
| `/pm-experiment` | A/B 测试设计 |
| `/pm-critique` | 产品评审 |
| `/pm-launch` | 发布检查清单 |
| `/pm-gap-analysis` | 战略偏差诊断 |
| `/pm-data-analysis` | 数据分析 |
| `/pm-urgent` | 紧急问题快速响应 |

### 工作流（端到端）

| 命令 | 用途 |
|------|------|
| `/pm-discovery` | 产品发现（从想法到验证） |
| `/pm-feature-cycle` | 功能全周期（从 PRD 到上线） |
| `/pm-writer-pipeline` | 批量文档生成 |

---

## 保真度控制

PM Copilot 的产出会根据场景自动调整检查深度：

| 你说 | 保真度 | 检查范围 |
|------|--------|---------|
| "随便写个草稿" | Draft | 基础逻辑自洽 |
| "正式文档" / "给开发" | Release | 全量检查 + 量化指标 |
| 默认 | Review | Iron Law 全部 + 质量门控 |

---

## 常见问题

**Q: PM Copilot 和 ChatGPT/Claude 有什么不同？**
A: PM Copilot 内嵌了 29 个结构化 PM Skill（含方法论、模板、质量检查），不是通用聊天机器人。每个 Skill 有明确的输入/输出规范和质量保障。

**Q: 我的数据安全吗？**
A: 所有数据存储在本地，不上传云端。API Key 只用于调用你自己的 AI Provider。

**Q: 换一个 AI Provider 会影响使用吗？**
A: 不同 Provider 的模型能力有差异，但 PM Copilot 的 Skill 和方法论是固定的。详见 `specs/guides/model-compatibility-matrix.md`。

---

## 下一步

- 试试 `/pm-discovery` 走一遍完整的产品发现流程
- 用 `/pm-gap-analysis` 检查你的产品方向是否对齐
- 用 `/pm-critique` 让 PM Copilot 评审你的现有文档
