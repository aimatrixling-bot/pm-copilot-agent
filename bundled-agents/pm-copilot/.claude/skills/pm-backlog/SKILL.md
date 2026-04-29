---
name: pm-backlog
displayName: 需求池管理
displayDescription: Sprint 规划与需求池优先级管理
description: "Manage product backlogs and Sprint planning with structured prioritization. Use this skill whenever the user needs to organize work items, says 'backlog', '待办', '需求池', 'sprint planning', '迭代规划', '需求管理', '任务拆分', or needs to break down features into executable tasks. Also trigger when the user says 'organize these features', 'plan next sprint', 'what should we work on next', or 'break this into tasks'. Converts PRDs and roadmaps into prioritized, sized Sprint backlogs ready for execution."
user-invocable: true
argument-hint: "[产品名称或功能列表]"
---

# 待办管理

<SUBAGENT-STOP>
如果是子代理派发执行此 Skill，直接按下方指令执行，不重新加载入口 Skill。
</SUBAGENT-STOP>

从 PRD/RICE/Roadmap 提取需求，拆分为 Sprint backlog。帮助 PM 组织迭代计划。

**输入**: PRD/RICE/Roadmap 文件路径或功能列表
**输出**: Sprint backlog + 迭代计划

## Iron Law

| 铁律 | 违反后果 |
| --- | --- |
| 任务 > 2 天工作量 = 拆分不够 | 立即拆分——每个任务必须 ≤ 2 天 |
| 无来源的需求不是需求 | 立即标注——每个需求必须注明来源 |
| Sprint 过度承诺 = 必定失败 | 只承诺 80% 容量——留缓冲给意外 |

## 反合理化

| 你可能在想的 | 真相 |
| --- | --- |
| "这个任务大概 3-5 天" | "大概" = 你没想清楚。拆到 ≤2 天 |
| "所有 P0 都这周做" | 容量不够时，P0 里也要排优先级 |
| "先排进去，做不完延后" | 每次都延后 = 计划不可信 |
| "不需要写依赖" | 没标注依赖 = 被阻塞时才知道 |
| "Sprint 不需要目标" | 没目标的 Sprint = 做了很多但没有方向 |

## 执行流程

```
1. 读取 PRD/RICE/Roadmap 中的需求项
2. 按优先级排序（P0 → P1 → P2）
3. 拆分为可执行的任务
   ├── 每个任务 ≤ 2 天工作量
   ├── 符合 INVEST 原则
   └── 有明确完成标准
4. 识别依赖关系
5. 估算 Sprint 容量（人数 × 天数 × 70% 有效 × 80% 承诺）
6. 分配到 Sprint（按容量）
7. Iron Law 检查
   ├── 所有任务 ≤ 2 天？
   ├── 来源已标注？
   └── 承诺 ≤ 80% 容量？
8. 产出 Sprint backlog
```

## INVEST 原则

| 字母 | 含义 | 检查 |
| --- | --- | --- |
| I | Independent | 可独立交付 |
| N | Negotiable | 实现方式可讨论 |
| V | Valuable | 对用户有价值 |
| E | Estimable | 团队能估算 |
| S | Small | ≤ 2 天 |
| T | Testable | 有完成标准 |
## 交付前检查

## Hard Bans（硬禁令）

以下模式在所有保真度级别均禁止出现。检测到时立即修正。

| # | 禁止模式 | 修正动作 |
| --- | --------- | -------- |
| HB-1 | 发布/方案无回滚方案 | 定义回滚触发条件+步骤+预计时间 |
| HB-2 | 指标体系无护栏指标（只优化不防副作用） | 补充 >=1 个护栏指标，定义底线和告警阈值 |
| HB-3 | 里程碑有精确日期但无缓冲 | 改为日期范围或预留 10-20% 缓冲 |
| HB-4 | 实验无原假设和备择假设 | 补充 H0（原假设）和 H1（备择假设） |
| HB-5 | P0 功能测试覆盖不完整 | P0 功能必须有正向+边界+异常测试覆盖 |


- [ ] 需求来源已标注（PRD/RICE/Roadmap）
- [ ] 每个任务 ≤ 2 天工作量
- [ ] 依赖关系已标注
- [ ] Sprint 容量估算合理（承诺 ≤ 80%）
- [ ] Sprint 有明确目标（1-3 个）
- [ ] 所有推断标注 [假设]

## 产出格式

```markdown
# Sprint Backlog: [产品名] - Sprint [N]

> **Sprint 周期**: [起止日期]
> **Sprint 目标**: [1-3 个目标]
> **容量**: [X] 人天（承诺 [Y] 人天）

## Sprint 目标
1. [目标 1]
2. [目标 2]

## Backlog
| # | 任务 | 来源 | 优先级 | 估算(天) | 依赖 | 状态 |
|---|------|------|--------|----------|------|------|
| 1 | [任务描述] | PRD-US01 | P0 | 1 | 无 | Todo |

## 依赖关系
| 任务 | 依赖 | 阻塞风险 |
|------|------|----------|

## 风险
| 风险 | 缓解 |
|------|------|
```

需求状态流转、拆分技巧、容量估算方法见 `references/backlog-methods.md`。

## 常见错误

| 错误 | 后果 | 正确做法 |
| --- | --- | --- |
| 任务太大 | 无法跟踪进度 | 拆分为 ≤2 天 |
| Sprint 过度承诺 | 总是完不成 | 只承诺 80% |
| 无依赖标注 | 任务互相阻塞 | 列出所有依赖 |
| 不更新状态 | 看不到真实进度 | 每日更新 |
| 无 Sprint 目标 | 没有方向 | 定义 1-3 个目标 |
