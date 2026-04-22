---
name: pm-writer-pipeline
displayName: 文档流水线
displayDescription: 一键生成完整 PM 文档套件
description: "Generate a complete PM document suite in one pipeline — roadmap, PRD, tech spec, and launch plan — with consistency checks and Iron Law gates between every document. Use this skill whenever the user needs bulk document generation, says '文档管道', '批量文档', 'writer pipeline', '文档集', '一次性生成全部文档', '完整文档包', 'PM文档全套', or wants to produce multiple PM artifacts in sequence. Also trigger when the user says 'generate all PM docs', 'I need the full document suite', '帮我生成所有文档', '一次搞定所有文档', or '从需求到发布全套文档'. Chains roadmap → PRD → tech spec → launch plan with cross-document consistency enforcement."
user-invocable: true
argument-hint: "[产品名称或需求描述]"
---

# PM 文档编写管道

<SUBAGENT-STOP>
如果是子代理派发执行此 Skill，直接按下方指令执行，不重新加载入口 Skill。
</SUBAGENT-STOP>

批量 PM 文档管道：路线图 → PRD → 技术规格 → 发布计划。逐层精确化，每个文档通过 Iron Law 后才产出下一个。

**输入**: 对话上下文 + 项目已有文件
**输出**: 完整 PM 文档集

## Iron Law

| 铁律 | 违反后果 |
| --- | --- |
| 每个文档必须通过 Iron Law 检查后才产出下一个 | 立即停止——修正当前文档直到通过 |
| 文档间核心结论必须一致（路线图目标 = PRD Why Now = 发布范围） | 立即停止——修正矛盾文档 |

## 反合理化

| 你可能在想的 | 真相 |
| --- | --- |
| "5 个文档一次生成太快了" | 逐层精确化 = 每个文档基于上一个的输出。不是重复劳动 |
| "一致性检查太麻烦" | 不一致 = 团队按不同版本执行 = 混乱 |
| "需求收集可以跳过" | 跳过 = 文档基于假设 = 一堆废话 |
| "技术规格不重要" | 没有 tech spec 的发布 = 拿团队做赌注 |
| "文档先写完再检查" | 写完再检查 = 改 5 个文档。写一个查一个 = 改 1 个 |

## 工作流阶段

### Phase 1: 需求收集
- Glob 搜索已有文档（PRD/Roadmap/RICE/Discovery）
- Read 已有文档，提取可复用信息
- 整理对话中的关键信息
- 产出需求摘要：产品名称、功能列表、目标用户、约束条件
- 信息不足时 ≤ 3 个补充提问
- **门控**: 产品名称 + 功能列表 + 目标用户 + 约束条件已收集
  + L2 一致性检查：产出物与已有文档无矛盾（见 quality-gates-shared.md）

### Phase 2: 产出路线图
**调用 Skill**: pm-roadmap（Quick 模式）
- 基于需求摘要确定时间范围、里程碑和功能归属
- **门控**: 路线图有目标 + 优先级 + 依赖
  + L2 一致性检查：路线图与需求摘要一致（见 quality-gates-shared.md）

### Phase 3: 产出 PRD
**调用 Skill**: pm-prd（Quick 模式）
- 路线图阶段目标 → PRD Why Now
- 路线图功能列表 → PRD Feature Scope
- **门控**: PRD Iron Law 通过（Why + 验收标准 + 成功指标）
  + L2 一致性检查：PRD 与路线图无矛盾 + User Journey ⊆ In Scope（见 quality-gates-shared.md）

### Phase 4: 产出技术规格
**调用 Skill**: pm-tech-spec
- 基于 PRD 功能范围和验收标准
- 包含架构方案、数据模型、API 设计、技术风险
- 技术决策标注 [待开发确认] 或 [假设]
- **门控**: 技术方案已产出 + 风险已列出 + 关键决策已标注
  + L2 一致性检查：技术规格范围 = PRD Feature Scope + 无 Magic Step（见 quality-gates-shared.md）

### Phase 5: 产出发布计划
**调用 Skill**: pm-launch（Quick 模式）
- 发布范围与路线图里程碑 + PRD Feature Scope 对齐
- 监控指标与 PRD 成功指标对齐

## 一致性检查

每 Phase 产出后执行：
- 路线图功能列表 ⊇ PRD Feature Scope
- PRD 成功指标 ⊆ 发布计划监控指标
- 技术规格范围 = PRD Feature Scope
- 不一致时以 PRD 为基准修正

## 门控失败处理

- 标注失败原因，回到对应 Phase 修正
- 最多重试 2 次

## 产出物

| 产出物 | 说明 |
| --- | --- |
| 需求摘要 | Phase 1 |
| 产品路线图 | Phase 2 |
| PRD 文档 | Phase 3 |
| 技术规格 | Phase 4 |
| 发布计划 | Phase 5 |

---

文档管道执行指南（一致性检查规则、文档间映射、模板索引）见 `references/pipeline-guide.md`。

## 常见错误

| 错误 | 后果 | 正确做法 |
| --- | --- | --- |
| 文档间不一致 | 团队各做各的 | 每个文档产出后做一致性检查 |
| 跳过需求收集 | 文档空洞无物 | 先收集再写，信息不足时提问 |
| PRD 和路线图矛盾 | 优先级混乱 | 以 PRD 为基准修正 |
| 技术规格脱离 PRD | 开发做了不需要的 | 技术规格范围 = PRD Feature Scope |
| 发布计划缺监控 | 上线后不知道好坏 | 监控指标 ⊇ PRD 成功指标 |
