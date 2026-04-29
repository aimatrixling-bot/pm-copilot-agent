---
name: pm-discovery
displayName: 产品探索
displayDescription: 端到端产品探索：从洞察到验证
description: "Orchestrate end-to-end product discovery from raw idea to validated opportunity with quality gates at every phase. Use this skill whenever the user needs to validate a product idea, says '产品发现', 'discovery', '从想法到验证', 'idea validation', '想法验证', '产品探索', 'opportunity assessment', '机会评估', '要不要做', '值不值得做', or wants to run a structured discovery process. Also trigger when the user says 'I have an idea', 'should we build this', 'validate this concept', 'explore this opportunity', '帮我验证一下这个想法', or '这个值不值得做'. Chains problem-framing, persona, competitive analysis, and go/no-go decision into a single four-phase pipeline."
user-invocable: true
argument-hint: "[产品/功能名称或想法描述]"
---

# 产品发现工作流

<SUBAGENT-STOP>
如果是子代理派发执行此 Skill，直接按下方指令执行，不重新加载入口 Skill。
</SUBAGENT-STOP>

从"有个想法"到"确认值得做"的端到端产品发现工作流。编排四个阶段，每阶段通过质量门控后进入下一阶段。

**输入**: 想法描述或初步问题
**输出**: 产品发现报告 + Go/No-Go 决策

## Iron Law

| 铁律 | 违反后果 |
| --- | --- |
| 问题定义未通过门控前，禁止进入方案讨论 | 立即停止——回到 Phase 1 |
| 每个阶段产出必须通过质量门控才可进入下一阶段 | 立即停止——修正当前阶段产出 |

## 反合理化

| 你可能在想的 | 真相 |
| --- | --- |
| "先做再说，不需要验证" | 没验证的想法 = 昂贵的赌博。Discovery 防止做错事 |
| "我都知道答案了" | 你知道的是假设。假设不验证 = 偏见 |
| "4 个阶段太慢了" | 跳过阶段省的时间 < 做错产品浪费的时间 |
| "竞品分析不需要" | 不知道竞品在做什么 = 不知道差异化在哪 |
| "直接写 PRD 吧" | 没有问题定义的 PRD = 没有根基的建筑 |

## Step 0: 上下文先行

在问用户任何问题之前，先搜索项目已有信息：

1. **搜索项目文档** — Glob 搜索 `docs/discovery/` 目录下的已有产出（problem-statement、personas、competitive-analysis、discovery-report 等）
2. **扫描对话历史** — 提取用户在本次会话中已提及的关键信息
3. **提取已有信息** — 列出已知信息清单，标注来源（文档/对话/推断）

然后用以下格式向用户确认：
> "我找到了以下相关信息：[已有信息清单]。我会基于这些信息继续，如果有过时的请告诉我。"

如果已有 Discovery 产出（如之前的问题定义、竞品分析），直接从对应阶段开始，不重复已完成的工作。

### 关键决策点：范围确认

启动时使用 AskUserQuestion 确认 Discovery 范围：

> **问题**: "你想走哪种 Discovery 模式？"
>
> | 选项 | 说明 |
> | --- | --- |
> | 完整 4 阶段 | 问题定义 → 用户画像 → 竞品分析 → Go/No-Go |
> | 只做问题定义 | 聚焦 Phase 1，快速验证问题是否成立 |
> | 只做竞品分析 | 已有明确问题，需要竞品数据支撑 |
> | 只做 Go/No-Go | 已有前期产出，需要最终决策 |

仅在信息不明确时使用。如果上下文已清楚表明范围，直接执行。

## 工作流阶段

### Phase 1: 问题定义
**调用 Skill**: pm-problem-frame（用 Agent 工具调用，确保在独立上下文中运行）
- 从对话上下文提取想法核心描述
- 产出结构化 Problem Statement
- **门控**: 问题有数据支撑 + 受影响用户已量化 + 根因已分析

### Phase 2: 用户画像
**调用 Skill**: pm-persona（用 Agent 工具调用）
- 输入 Phase 1 的 Target Users
- 产出 3-7 个用户画像，含痛点和场景
- **门控**: 画像有痛点 ≥ 1 个/画像 + Primary Persona 已识别

### Phase 3: 深度研究
**调用 Skill**: pm-comp（用 Agent 工具调用）

Phase 3 不是简单列竞品功能，是多源证据收集和差异化空间发现。

**研究维度（全部覆盖）**：

| 维度 | 目的 | 数据来源 | 证据强度 |
| --- | --- | --- | --- |
| 竞品功能对比 | 了解市场现有解法 | 产品官网、帮助文档、App Store | 中 |
| 用户真实反馈 | 发现未满足需求 | 用户评论（App Store/G2/Capterra）、Reddit、社区帖子 | 高 |
| 市场信号 | 判断市场时机 | 融资新闻、搜索趋势、行业报告 | 中 |
| 替代方案 | 理解用户当前怎么解决 | 论坛讨论、用户访谈记录 | 高 |

**执行步骤**：

```
3.1 竞品扫描 — 基于问题定义和画像确定竞品搜索方向
    ├── 直接竞品（相同用户 + 相同问题）
    ├── 间接竞品（相同用户 + 不同解法）
    └── 替代方案（用户当前的工作流/手动方法）
3.2 证据收集 — 每个维度收集 ≥3 条证据
    ├── 用户评价中的高频抱怨 = 差异化机会
    ├── 竞品缺失的功能 = 但必须是用户需要的才算机会
    └── 市场增长信号 = 证明市场在扩大（不是萎缩）
3.3 信号过滤 — 区分信号和噪声
    ├── 强信号：多来源交叉验证的事实
    ├── 中信号：单一可靠来源的数据
    └── 弱信号：零散的、未验证的信息
3.4 差异化空间 — 从证据推导差异化方向
    ├── 不做什么（竞品已经做得好的）
    ├── 做什么（竞品缺失 + 用户需要的）
    └── 独特角度（基于用户反馈的洞察，不是功能堆叠）
```

**门控**:
- 有差异化结论 + 每个结论有来源 + 差异化空间已识别
- ≥2 个维度有 ≥3 条证据
- 所有强信号有交叉验证来源
- 弱信号标注 [待验证]，不作为决策依据

### Phase 4: 可行性判断
**调用 Skill**: pm-decision（用 Agent 工具调用）
- 整合 Phase 1-3 全部产出
- 评估维度：用户价值 × 市场空间 × 可行性
- 产出明确的"做/不做/暂缓"建议 + 行动项
- **门控**: 决策有依据 + ≥ 2 个方案被评估 + 行动项有负责人

## 门控失败处理

门控失败时**不要静默重试**，而是向用户交互：

1. **展示失败原因** — 明确告知哪个门控未通过、缺少什么
2. **提供修正建议** — 给出具体的修正方向（不是"请补充更多信息"）
3. **让用户选择** — 修正后重试 / 跳过此阶段（标注 [跳过原因]）/ 暂停整个 Discovery

最多重试 2 次，2 次仍失败则向用户报告并暂停。

## 产出物

| 产出物 | 路径 |
| --- | --- |
| 问题定义文档 | `docs/discovery/problem-statement.md` |
| 用户画像文档 | `docs/discovery/personas.md` |
| 竞品分析报告 | `docs/discovery/competitive-analysis.md` |
| 产品发现报告 | `docs/discovery/discovery-report.md` |

## Discovery 日志

每次执行后更新 `docs/discovery/discovery-log.md`（仅在项目有 `docs/` 目录时执行）：
- 结论（Go/No-Go/暂缓）
- 关键洞察（≤ 3 条）
- 待验证假设
- 下次关注信号

### 日志格式

```markdown
# Discovery Log

## 2026-04-15 — {项目名}
- **结论**: Go / No-Go / 暂缓
- **关键洞察**: {≤ 3 条}
- **待验证假设**: {列出}
- **下次关注信号**: {列出}

---
```

### 习惯追踪

每次 Discovery 执行时，自动检查日志并显示进度（仅在 `docs/discovery/discovery-log.md` 存在时）：

1. **读取日志** — 扫描 `docs/discovery/discovery-log.md`
2. **计算本周活跃度** — 本周完成的 Discovery 次数
3. **显示进度**：
   ```
   Discovery 本周进度: X 次发现
   上次发现: {日期} — {项目名} ({结论})
   建议: {基于当前项目阶段的下一个验证动作}
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

### pm-discovery 的 Visual Preview 场景

| 环节 | 展示内容 | 不可用时 |
| --- | --- | --- |
| 4 阶段进度 | 当前处于哪个阶段、门控通过/失败状态 | 用文字状态列表 |
| Go/No-Go 决策 | 决策矩阵（用户价值 × 市场空间 × 可行性） | 用表格 |

### 注意事项

- Visual Preview 是**辅助确认工具**，不是必须环节。不可用时绝不阻塞主流程
- 每次只展示一个决策点的内容，不要在一个页面堆砌所有信息
- 预览内容保持简洁，不做像素级设计

## 交付规范

1. **对话中直接输出** — Markdown 格式，不包裹在代码围栏中
2. **标注系统** — 所有推断用 [假设]，自动填充用 [默认]，待讨论用 [待确认]，需数据验证用 [待验证]
3. **文件保存**（可选）— 如果项目有 `docs/` 目录，询问用户是否保存为文件。没有 docs/ 目录则不问，直接在对话中输出
4. **下一步建议** — 基于当前 Main Loop 阶段，推荐 1-2 个最相关的后续 Skill

---

Discovery 方法论详解（5 Whys 根因分析、门控标准、验证技巧）见 `references/discovery-methods.md`。

## Hard Bans（硬禁令）

以下模式在所有保真度级别均禁止出现。检测到时立即修正。

| # | 禁止模式 | 修正动作 |
| --- | --------- | -------- |
| HB-1 | 跳过阶段门控直接进入下一阶段 | 回到当前阶段完成门控检查 |
| HB-2 | 前序产出未引用就启动下一阶段 | 补充前序产出摘要和引用 |
| HB-3 | Agent 替用户做最终决策（输出中包含未确认的决策声明） | 决策表述改为建议，标注 [待用户确认] |
| HB-4 | 工作流中的假设未随阶段推进而收敛 | 每阶段结束时应解决 >=1 个假设或标注为 [已知风险] |
| HB-5 | Go/No-Go 决策只有一个方案 | 补充至 >=2 个方案，每个含优劣势+风险 |

## 常见错误

| 错误 | 后果 | 正确做法 |
| --- | --- | --- |
| 跳过问题定义 | 做了没人要的东西 | 先验证问题存在 |
| 只看数据不看用户 | 错过真实动机 | 数据 + 用户访谈结合 |
| 竞品分析太浅 | 同质化竞争 | 深挖竞品策略和用户评价 |
| Discovery 无限循环 | 永远不开始做 | 最多 2 周完成全部 4 阶段 |
| 跳过 Go/No-Go | 稀里糊涂开始做 | 必须产出明确决策 |

## 与 PM Copilot Agent 的协同

本 Skill 在 PM Copilot Agent 内运行时，遵循 Agent 的执行协议：

1. **澄清轮次**：最多 2 轮追问。如果 2 轮后信息仍不足，用当前最佳判断产出，标注 [待确认]
2. **路由感知**：检查用户输入是否匹配更高优先级的 Skill（如用户说"做 Discovery"但实际只是想写 PRD → 先推荐 pm-prd）
3. **Main Loop 衔接**：产出完成后，明确建议 Main Loop 中的下一步 Skill（通常 → pm-prd 或 pm-rice）

在 Claude Code 中直接调用时（不经过 Agent），不受 2 轮限制，可按自适应流程正常展开。
