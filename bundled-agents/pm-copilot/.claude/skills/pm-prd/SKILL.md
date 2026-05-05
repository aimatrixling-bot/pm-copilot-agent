---
name: pm-prd
displayName: PRD
displayDescription: 撰写或改进产品需求文档
description: "Write or improve Product Requirements Documents. Use this skill whenever the user wants to create, review, refine, or iterate on a PRD — including saying 'write PRD', 'help with PRD', '需求文档', '写PRD', 'product requirements', 'feature spec', or describing a product feature they want to build. Also trigger when the user shares competitive analysis, user research, or problem statements that naturally lead to PRD creation. Even if they just say 'we need to build X', this skill helps turn that into a structured PRD."
user-invocable: true
argument-hint: "[产品/功能名称或描述]"
---

# PRD 编写

<SUBAGENT-STOP>
如果是子代理派发执行此 Skill，直接按下方指令执行，不重新加载入口 Skill。
</SUBAGENT-STOP>

引导产出结构化的产品需求文档。PRD 不是文档，是合约——它连接 PM 的思考和工程的执行。

**核心原则**：模糊的 PRD 比没有 PRD 更危险。

## Iron Law（铁律）

| 铁律 | 违反后果 |
| --- | --- |
| 没有"为什么"的 PRD 不是 PRD | 立即停止——补充 Problem Statement 和 Why Now 后继续 |
| 每个 User Story 必须有验收标准 | 立即停止——补全 Given-When-Then 后继续 |
| 没有成功指标的 PRD 无法验证 | 立即停止——定义 ≥ 1 个可量化成功指标 **及其测量方法**后继续 |

## 反合理化

| 你可能在想的 | 真相 |
| --- | --- |
| "用户说了需求，直接写" | 用户说的是解决方案，不是问题——先验证问题存在 |
| "这个功能大家都需要" | "大家都需要" ≠ "大家愿意付钱/花时间"——用数据证明 |
| "PRD 写完就交" | 写完 → Iron Law 检查 → 标注 → 交付，缺一不可 |
| "技术细节让开发自己决定" | PM 必须定义约束边界，否则开发会按最容易的方式实现 |
| "竞品这么做，我们也应该" | 竞品这么做 ≠ 对你的用户正确——回归用户问题验证 |

## Scope Gate（范围门控）— 在任何执行之前必须先通过

> 详细范围门控规则见 `references/scope-guide.md`。

## Step 0: 上下文先行

在问用户任何问题之前，先搜索项目已有信息：

1. **搜索项目文档** — Glob 搜索已有 PRD、roadmap、discovery 产出、problem-statement、竞品分析等
2. **扫描对话历史** — 提取用户在本次会话中已提及的关键信息
3. **提取已有信息** — 列出已知信息清单，标注来源（文档/对话/推断）

然后用以下格式向用户确认：
> "我找到了以下相关信息：[已有信息清单]。我会基于这些信息继续，如果有过时的请告诉我。"

如果已有信息足够丰富，直接跳过探索式对话，进入精准追问或直接产出。

## 自适应流程

收到用户输入后（通过 Scope Gate 后），先执行信息评估：

| 评估维度 | 高密度信号 | 低密度信号 |
| --- | --- | --- |
| 问题/产品描述 | 具体场景 + 用户群体 + 痛点 | 仅一句"写个PRD" |
| 上下文丰富度 | 项目已有相关文档、之前讨论过 | 全新话题，无历史 |
| 用户明确度 | 带具体数据/竞品名/功能列表 | 模糊想法 |

**判断规则**：
- 3 个维度都是高密度 → **直接产出**（不提问，所有推断标注 [假设]）
- 混合 → **精准追问**（只问缺失的关键维度，可一次多问有逻辑关联的问题）
- 3 个维度都是低密度 → **探索式对话**（分组提问，最多 3 轮）

**关键**：即使探索式对话，也必须先完成"上下文先行"步骤，再决定问什么。不要问用户已经回答过的问题。

### 关键决策点 1：保真度选择

当信息密度为混合或低密度时，使用 AskUserQuestion 确认保真度：

> **问题**: "这份 PRD 的用途是？"
>
> | 选项 | 说明 |
> | --- | --- |
> | 团队讨论（Low-fi） | 2-4 页，快速对齐，早期想法验证 |
> | 工程交付（High-fi） | 8-15 页，正式文档，含验收标准和技术考虑 |

能从上下文推断时不问。高密度直接产出时，根据上下文自动选择。

### 关键决策点 2：方法论骨架

当信息密度高（直接产出）时，使用 AskUserQuestion 确认方法论：

> **问题**: "这个产品/功能最适合哪种分析框架？"
>
> | 选项 | 说明 |
> | --- | --- |
> | Working Backwards | B2B，从客户新闻稿倒推需求 |
> | JTBD | B2C，从用户"任务"出发 |
> | Lean Canvas | 平台/基础设施，验证商业逻辑先于功能设计 |
> | 标准 PRD | 通用模板，包含所有最小必要字段 |

信息密度低时不展示此选项（先用标准 PRD，等后续再调整）。

### 方法论骨架定义

| 产品类型 | 推理骨架 | 推理逻辑 |
| --- | --- | --- |
| B2B 企业功能 | Working Backwards | 从客户新闻稿 → FAQ → User Stories。强迫先想客户怎么描述价值 |
| B2C 消费端功能 | JTBD | 从用户要完成的"任务"出发。防止"功能堆砌" |
| 平台/基础设施 | Lean Canvas | 从问题-解决方案-独特价值开始。验证商业逻辑先于功能设计 |
| AI 原生功能 | 假设驱动 | 先列"如果 AI 能做 X"的假设 → 验证方法 → 再写需求 |
| 不确定 | 标准 PRD | 默认模板，包含所有最小必要字段 |

推理骨架如何影响产出：
- Working Backwards → PRD 先写 Press Release 和 FAQ，User Stories 从 FAQ 衍生
- JTBD → PRD 先写 Job Statements，功能列表是 Job 的解决方案
- Lean Canvas → PRD 以 9 格画布为骨架，填充后再展开
- 假设驱动 → PRD 嵌入假设列表和验证计划，每个功能关联一个假设

每种骨架的详细定义和使用方法，见 `references/methodology-skeletons.md`。

## 提问纪律

- 允许一条消息中问多个问题，但必须**按逻辑分组**（如：关于用户的 3 个问题放一起，关于场景的 2 个问题放一起）
- 优先问"最可能改变方向"的问题（如核心用户、核心问题），而非"最方便填充模板"的问题（如 NFR 默认值）
- 能从上下文推断的信息，不问。标注为 [假设] 并请用户确认
- 每轮追问后，复述你理解的内容，让用户确认或纠正
- 避免超过 5 个问题的追问轰炸——如果需要更多信息，考虑分 2 轮

## 执行流程

```
触发 pm-prd
    ├── 0. Scope Gate（范围门控）
    │     ├── 硬拒绝 → 立即拒绝 + 替代方向 → 结束
    │     ├── 软质疑 → AskUserQuestion → 用户确认后继续
    │     └── 通过 → 继续
    ├── 1. 上下文先行
    │     ├── 搜索已有 PRD/Roadmap/Discovery/Research 文档
    │     ├── 扫描对话历史中已提及的关键信息
    │     └── 向用户确认已有信息
    ├── 2. 信息密度评估
    │     ├── 高密度 → 直接产出（AskUserQuestion 确认方法论骨架）
    │     ├── 混合 → 精准追问 + AskUserQuestion 确认保真度
    │     └── 低密度 → 探索式对话（分组提问，≤ 3 轮）
    ├── 3. 核心分析 + 产出
    │     ├── Problem Statement + Why Now
    │     ├── 成功指标（指标/基线/目标/时间框架/测量方式）
    │     ├── 解决方案概述 + 功能列表（P0/P1/P2）
    │     ├── User Stories + Given-When-Then 验收标准
    │     ├── 范围边界（In/Out/Future）
    │     └── 风险与依赖
    ├── 4. Iron Law 检查
    │     ├── Problem Statement + Why Now 是否存在？
    │     ├── 每个 User Story 是否有验收标准？
    │     └── 是否有可量化成功指标？
    ├── 5. 标注检查（[默认] [假设] [待确认]）
    └── 6. 交付 + 后续推荐
```

## Visual Preview（视觉化预览）

### 原则：先看再做

在输出正式内容前，对涉及视觉判断的环节提供预览。用户确认方向后再执行。

### 检测机制

执行 Visual Preview 前检查：
1. Superpowers 插件是否已安装（检查 `~/.claude/plugins/cache/claude-plugins-official/superpowers/` 是否存在）
2. Visual Companion server 脚本是否存在（`skills/brainstorming/scripts/start-server.sh`）
3. 当前环境是否支持后台 server（Windows 需 `run_in_background: true`）

**可用** → 启动 Visual Companion，在浏览器中展示方案
**不可用** → Fallback 到文字输出，不影响主流程

### pm-prd 的 Visual Preview 场景

| 环节 | 展示内容 | 不可用时 |
| --- | --- | --- |
| User Journey | 流程图/状态机可视化 | 用编号步骤列表 |
| 功能范围 | P0/P1/P2 功能分层可视化（卡片式） | 用分组列表 |
| 架构概览 | 系统组件关系图 | 用文字描述 |

### 注意事项

- Visual Preview 是**辅助确认工具**，不是必须环节。不可用时绝不阻塞主流程
- 每次只展示一个决策点的内容，不要在一个页面堆砌所有信息
- 预览内容保持简洁，不做像素级设计

## 交付规范

1. **对话中直接输出** — Markdown 格式，不包裹在代码围栏中
2. **标注系统** — 所有推断用 [假设]，自动填充用 [默认]，待讨论用 [待确认]，需数据验证用 [待验证]
3. **文件保存**（可选）— 如果项目有 `docs/` 目录，询问用户是否保存为文件。没有 docs/ 目录则不问，直接在对话中输出
4. **下一步建议** — 基于当前 Main Loop 阶段，推荐 1-2 个最相关的后续 Skill

## 输出规范

**格式铁律**：PRD 作为文档类产出，在对话中直接输出为 Markdown。不得包含 `<generative-ui-widget>`、`<style>` 等无法在 Markdown 渲染中正确显示的标签。不将 PRD 包裹在代码围栏中。所有可视化内容用 Markdown 原生语法（表格、列表、引用块）表达。Agent 的解释性说明放在 PRD 内容之前或之后，与 PRD 正文明确分隔。若用户要求导出为 docx/pdf 等格式，按目标格式处理。

PRD 必须使用 `references/prd-template.md` 中的模板结构。核心章节：

### 必填章节（所有保真度）

1. **TL;DR** — 3 句话：核心问题、解决方案、成功指标
2. **问题陈述** — 谁、什么、为什么现在、不解决的后果
3. **目标和成功指标** — 指标表格（指标/基线/目标/时间框架/测量方式）+ 护栏指标
4. **解决方案概述** — 方案描述 + 关键功能列表 + 用户旅程
5. **范围边界** — In Scope / Out Scope / 未来迭代
6. **残酷风险区** — 牺牲了什么 + 最大失败风险 + 防御方案

### 高保真额外章节

7. **功能需求** — 用户故事 + Given-When-Then 验收标准 + 边缘情况
8. **技术考虑** — 性能/平台/集成/数据要求
9. **依赖和风险** — 依赖表 + 风险缓解表
10. **时间线和里程碑** — 分阶段里程碑
11. **FAQ** — 挑战关键假设的问答

### 标注系统

| 标注 | 含义 |
|------|------|
| `[假设]` | 基于推断的内容，需要用户确认 |
| `[默认]` | 自动填充的默认值，用户可覆盖 |
| `[待确认]` | 需要进一步讨论的开放问题 |

> 详细检查清单和约束见 `references/delivery-checklist.md` 和 `references/hard-bans.md`

## 后续推荐

根据 PRD 内容推荐下一步行动：

| 场景 | 推荐 Skill |
|------|-----------|
| 需要竞品参考 | pm-comp |
| 需要优先级排序 | pm-rice |
| 需要可视化 | pm-wireframe → pm-prototype |
| 需要技术方案 | pm-tech-spec |
| 需要决策记录 | pm-decision |

## 与 PM Copilot Agent 的协同

本 Skill 在 PM Copilot Agent 内运行时，遵循 Agent 的执行协议：

1. **澄清轮次**：最多 2 轮追问。如果 2 轮后信息仍不足，用当前最佳判断产出，标注 [待确认]
2. **路由感知**：检查用户输入是否匹配更高优先级的 Skill（如用户说"写 PRD"但实际需要先定义问题 → 先推荐 pm-problem-frame）
3. **Main Loop 衔接**：产出完成后，明确建议 Main Loop 中的下一步 Skill

在 Claude Code 中直接调用时（不经过 Agent），不受 2 轮限制，可按自适应流程正常展开。
