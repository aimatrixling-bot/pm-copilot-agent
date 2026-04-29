---
name: pm-strategy-session
displayName: 战略工作坊
displayDescription: 30 分钟结构化战略讨论
description: "Run a focused 30-minute structured strategy session from issue definition to decision output. Use this skill whenever the user needs a strategy discussion, says '策略讨论', 'strategy session', '快速决策', '方向讨论', 'strategy meeting', '战略讨论', '方向决策', '决策会议', or wants to make a strategic decision quickly. Also trigger when the user says 'we need to decide on direction', 'let's discuss strategy', 'help me make this decision', 'I need to align the team on strategy', '帮我做个策略决策', or '快速讨论一下方向'. Chains issue definition, data collection, option generation, and decision into a time-boxed four-phase workflow."
user-invocable: true
argument-hint: "[议题描述]"
---

# 策略讨论工作流

<SUBAGENT-STOP>
如果是子代理派发执行此 Skill，直接按下方指令执行，不重新加载入口 Skill。
</SUBAGENT-STOP>

30 分钟结构化策略讨论，从议题定义到决策产出。策略的价值在于决策多清晰，不在于讨论多深入。

**输入**: 议题描述
**输出**: 策略讨论记录 + 决策 + 行动项

## Iron Law

| 铁律 | 违反后果 |
| --- | --- |
| 每个阶段必须产出 ≥ 1 个可验证结论 | 立即停止——补充结论后继续 |
| 最终决策必须由用户确认，Agent 不可替用户做决策 | 立即停止——将决策权交还用户 |

## 反合理化

| 你可能在想的 | 真相 |
| --- | --- |
| "30 分钟不够" | 大部分会议浪费在前 20 分钟的漫谈。结构化 = 高效 |
| "不需要准备数据" | 没有数据的决策 = 拍脑袋。至少要 2-3 个关键指标 |
| "一个方案就够了" | 没有对比的方案 = 没有评估标准的方案 |
| "我来做决策" | Agent 提供建议和依据，决策权永远在用户手中 |
| "记录不重要" | 没有记录的决策 = 不存在的决策 |

## 工作流阶段

### Phase 1: 议题定义（≤ 3 分钟）
- 提取核心议题，转化为结构化陈述："关于 [X]，我们需要决定 [Y]，约束是 [Z]"
- 识别议题类型：方向决策 / 优先级决策 / 资源分配 / 时间决策 / 商业模式（使用商业模式画布/精益画布分析，见 `references/business-model-templates.md`）
- 向用户确认议题陈述
- **产出结论**: 议题陈述 + 议题类型
- **门控**: 议题有明确陈述 + 类型已确定

### Phase 2: 数据收集（≤ 10 分钟）
**调用 Skill**: pm-comp（Quick 模式）+ pm-metrics
- 方向决策 → 竞品分析 + 市场指标
- 优先级决策 → 产品指标 + RICE 参考
- 资源分配 → ROI 指标 + 竞品投入参考
- 时间决策 → 市场窗口 + 团队容量
- 商业模式 → 收入模型 + 成本结构 + 客户获取渠道数据
- 产出数据摘要（≤ 1 页）
- **产出结论**: 竞品关键发现 + 2-3 个关键指标
- **门控**: ≥ 1 个竞品数据点 + ≥ 2 个指标数据点（或标注 [待补充]）

### Phase 3: 方案生成（≤ 10 分钟）
**调用 Skill**: pm-decision
- 基于 Phase 1-2 产出，生成 ≥ 2 个方案
- 每个方案：优势 + 劣势 + 风险 + 所需资源
- 关键假设标注 [假设] + 置信度
- 给出建议（非决策），用户选择
- **产出结论**: ≥ 2 个方案对比 + Agent 建议
- **门控**: ≥ 2 个方案 + 每个方案有优劣势 + 用户已选择

### Phase 4: 策略产出（≤ 7 分钟）
- 记录决策："关于 [X]，我们决定 [Y]，依据是 [Z]"
- 产出 3-5 个行动项（具体任务 + 负责人 + 截止日期）
- 如需路线图，建议运行 pm-roadmap
- **产出结论**: 1 个决策记录 + 3-5 个行动项

## 门控失败处理

- Phase 1 失败 → 追问 1-2 个问题澄清
- Phase 2 失败 → 标注 [待补充]，不阻塞
- Phase 3 失败 → 补充方案至 ≥ 2 个
- Phase 4 失败 → 追问用户确认行动项

## 产出物

| 产出物 | 说明 |
| --- | --- |
| 策略讨论记录 | 完整讨论过程 + 数据 + 方案 + 决策 |
| 决策记录 | 标准格式（可被 Memory 持久化） |
| 行动项列表 | 3-5 个行动项，含负责人和截止日期 |

---

策略讨论执行指南（议题类型处理、时间管理技巧、决策记录模板）见 `references/strategy-session-guide.md`。

## 常见错误

## Hard Bans（硬禁令）

以下模式在所有保真度级别均禁止出现。检测到时立即修正。

| # | 禁止模式 | 修正动作 |
| --- | --------- | -------- |
| HB-1 | 跳过阶段门控直接进入下一阶段 | 回到当前阶段完成门控检查 |
| HB-2 | 前序产出未引用就启动下一阶段 | 补充前序产出摘要和引用 |
| HB-3 | Agent 替用户做最终决策（输出中包含未确认的决策声明） | 决策表述改为建议，标注 [待用户确认] |
| HB-4 | 工作流中的假设未随阶段推进而收敛 | 每阶段结束时应解决 >=1 个假设或标注为 [已知风险] |
| HB-5 | 策略讨论/工作流产出只有一个方案 | 补充至 >=2 个方案，每个含优劣势+风险 |


| 错误 | 后果 | 正确做法 |
| --- | --- | --- |
| 议题太模糊 | 讨论无焦点 | 结构化为"关于 X，需要决定 Y，约束 Z" |
| 讨论发散 | 超时不决策 | 每个阶段严格时间盒 |
| 只有一个方案 | 无法对比优劣 | 至少产出 2 个方案 |
| 决策不记录 | 下次同样问题重讨论 | 标准决策记录格式 |
| 行动项无负责人 | 说了等于没说 | 每个行动项必须有负责人和截止日期 |
