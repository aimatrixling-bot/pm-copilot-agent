---
name: pm-feature-cycle
displayName: 功能开发周期
displayDescription: 编排完整的功能开发全生命周期
description: "Orchestrate the complete feature development lifecycle from prioritization to launch with quality gates between every phase. Use this skill whenever the user needs end-to-end feature delivery, says '功能开发', 'feature cycle', '交付全流程', '从PRD到上线', '功能全流程', 'feature lifecycle', '开发流程', '交付流程', 'feature pipeline', or wants to take a feature from idea to production. Also trigger when the user says 'walk me through building this feature', 'take this from idea to launch', 'full feature workflow', 'ship this end to end', '帮我走完这个功能的全部流程', or '从需求到发布'. Chains RICE prioritization, PRD, tech spec, engineering request, testing, and launch into a six-phase pipeline."
user-invocable: true
argument-hint: "[功能列表或 PRD 路径]"
---

# 功能开发全周期工作流

<SUBAGENT-STOP>
如果是子代理派发执行此 Skill，直接按下方指令执行，不重新加载入口 Skill。
</SUBAGENT-STOP>

从"确定做什么"到"上线验证"的六阶段工作流。每个阶段通过质量门控串联。

**输入**: 功能列表或已有 PRD
**输出**: 功能交付包（6 个文档）

## Iron Law

| 铁律 | 违反后果 |
| --- | --- |
| PRD 未通过 Iron Law 检查前，禁止进入技术规格阶段 | 立即停止——回到 Phase 2 修正 PRD |
| 每个阶段产出必须通过质量门控才可进入下一阶段 | 立即停止——修正当前阶段产出 |

## 反合理化

| 你可能在想的 | 真相 |
| --- | --- |
| "6 个阶段太重了" | 每个阶段都有存在的理由——跳过 = 在后面加倍偿还 |
| "PRD 不用那么细" | 模糊的 PRD = 开发理解偏差 = 返工 |
| "测试可以跳过" | 未测试的功能上线 = 用户帮你测 = 信誉损失 |
| "发布计划不重要" | 没有发布计划 = 上线当天手忙脚乱 |
| "直接让开发做" | 没有技术规格 = 开发自作主张 = 不符合预期 |

## 工作流阶段

### Phase 1: 优先级排序
**调用 Skill**: pm-rice
- 收集待排序功能列表
- 产出 RICE 排序结果，确认 P0 功能
- **门控**: RICE 分数已计算 + P0 功能确认 + 四维度无缺失

### Phase 2: PRD 编写
**调用 Skill**: pm-prd
- P0 功能作为 PRD Feature Scope
- 读取 pm-discovery 产出（如有）作为输入
- **门控**: PRD Iron Law 全部通过 + User Journey ⊆ In Scope + L2 交叉检查通过（见 quality-gates-shared.md）

### Phase 3: 技术规格
**调用 Skill**: pm-tech-spec
- 基于 PRD 生成技术规格（架构、API、数据模型、风险）
- **门控**: 技术方案有评审 + 架构决策有依据 + 风险已列出

### Phase 4: 工程需求
**调用 Skill**: pm-eng-request
- PRD + 技术规格 → 开发可执行的任务描述
- 包含任务拆分、验收标准、依赖关系、工时参考
- **门控**: 任务已拆分 + 验收标准完整 + 依赖明确

### Phase 5: 测试验收
**调用 Skill**: pm-testing
- 基于 PRD 验收标准生成测试计划
- 覆盖全部 User Story
- **门控**: 测试计划覆盖全部 US + 验收场景可执行

### Phase 6: 发布上线
**调用 Skill**: pm-launch
- 发布范围与 PRD Feature Scope 对齐
- 包含回滚方案、监控指标、沟通计划
- **门控**: 回滚方案已定义 + 监控指标 ≥ 3 个 + 沟通计划已列出

## 门控失败处理

- 标注失败原因，回到对应 Phase 修正
- 最多重试 2 次，2 次仍失败则向用户报告并暂停

## 产出物

| 产出物 | 说明 |
| --- | --- |
| RICE 排序结果 | Phase 1 |
| PRD 文档 | Phase 2 |
| 技术规格文档 | Phase 3 |
| 工程需求文档 | Phase 4 |
| 测试计划 | Phase 5 |
| 发布计划 | Phase 6 |

---

功能开发全周期指南（阶段转换标准、门控检查项、常见卡点）见 `references/feature-cycle-guide.md`。

## 常见错误

| 错误 | 后果 | 正确做法 |
| --- | --- | --- |
| 跳过优先级排序 | 做了不重要的功能 | 先用 RICE 排序确认 P0 |
| PRD 没有验收标准 | 开发完不知道对不对 | 每个功能必须有 Given-When-Then |
| 技术规格缺失 | 架构临时决策 = 技术债 | PRD 通过后立即写技术规格 |
| 测试覆盖不足 | 上线后出 bug | 覆盖全部 User Story |
| 发布无回滚方案 | 出问题无法回退 | 发布前必须定义回滚方案 |
