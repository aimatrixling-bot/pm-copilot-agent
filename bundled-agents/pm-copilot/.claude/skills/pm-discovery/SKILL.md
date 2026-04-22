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

## 工作流阶段

### Phase 1: 问题定义
**调用 Skill**: pm-problem-frame
- 从对话上下文提取想法核心描述
- 产出结构化 Problem Statement
- **门控**: 问题有数据支撑 + 受影响用户已量化 + 根因已分析

### Phase 2: 用户画像
**调用 Skill**: pm-persona
- 输入 Phase 1 的 Target Users
- 产出 3-7 个用户画像，含痛点和场景
- **门控**: 画像有痛点 ≥ 1 个/画像 + Primary Persona 已识别

### Phase 3: 竞品分析
**调用 Skill**: pm-comp
- 基于问题定义和画像确定竞品搜索方向
- 产出竞品对比矩阵 + 差异化空间
- **门控**: 有差异化结论 + 每个结论有来源 + 差异化空间已识别

### Phase 4: 可行性判断
**调用 Skill**: pm-decision
- 整合 Phase 1-3 全部产出
- 评估维度：用户价值 × 市场空间 × 可行性
- 产出明确的"做/不做/暂缓"建议 + 行动项
- **门控**: 决策有依据 + ≥ 2 个方案被评估 + 行动项有负责人

## 门控失败处理

- 标注失败原因，回到对应 Phase 修正
- 最多重试 2 次，2 次仍失败则向用户报告并暂停

## 产出物

| 产出物 | 路径 |
| --- | --- |
| 问题定义文档 | `docs/discovery/problem-statement.md` |
| 用户画像文档 | `docs/discovery/personas.md` |
| 竞品分析报告 | `docs/discovery/competitive-analysis.md` |
| 产品发现报告 | `docs/discovery/discovery-report.md` |

## Discovery 日志

每次执行后更新 `docs/discovery/discovery-log.md`：
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

每次 Discovery 执行时，自动检查日志并显示进度：

1. **读取日志** — 扫描 `docs/discovery/discovery-log.md`
2. **计算本周活跃度** — 本周完成的 Discovery 次数
3. **显示进度**：
   ```
   📊 Discovery 本周进度: X 次发现
   上次发现: {日期} — {项目名} ({结论})
   建议: {基于当前项目阶段的下一个验证动作}
   ```

---

Discovery 方法论详解（5 Whys 根因分析、门控标准、验证技巧）见 `references/discovery-methods.md`。

## 常见错误

| 错误 | 后果 | 正确做法 |
| --- | --- | --- |
| 跳过问题定义 | 做了没人要的东西 | 先验证问题存在 |
| 只看数据不看用户 | 错过真实动机 | 数据 + 用户访谈结合 |
| 竞品分析太浅 | 同质化竞争 | 深挖竞品策略和用户评价 |
| Discovery 无限循环 | 永远不开始做 | 最多 2 周完成全部 4 阶段 |
| 跳过 Go/No-Go | 稀里糊涂开始做 | 必须产出明确决策 |
