---
name: pm-metrics
displayName: 指标体系
displayDescription: 定义北极星指标和度量体系
description: "Define product metric systems with North Star, input/output, and guardrail metrics. Use this skill whenever the user needs to define or track metrics, says 'metrics', 'KPI', '指标', '度量', 'success metrics', 'North Star', '北极星指标', '数据指标', or needs to measure product success. Also trigger when the user says 'how do we measure this', 'what should our KPIs be', or 'define success metrics for'. Converts vague 'improve engagement' into specific, measurable metrics with baselines and targets."
user-invocable: true
argument-hint: "[产品/功能名称]"
---

# 指标定义

<SUBAGENT-STOP>
如果是子代理派发执行此 Skill，直接按下方指令执行，不重新加载入口 Skill。
</SUBAGENT-STOP>

帮助定义产品指标体系——North Star Metric + 输入/输出指标 + 护栏指标。

**输入**: 产品/功能名称 + PRD 中的成功指标（如有）
**输出**: 指标定义文档

## Iron Law

| 铁律 | 违反后果 |
| --- | --- |
| 没有 NSM 的指标体系没有方向 | 立即停止——先确定 North Star Metric |
| 虚荣指标不算指标 | 剔除注册用户数、页面浏览量等虚荣指标 |
| 没有护栏的优化会翻车 | 立即停止——补充 ≥1 个护栏指标 |

## 反合理化

| 你可能在想的 | 真相 |
| --- | --- |
| "指标太多了，都追踪" | 追踪一切 = 不追踪任何事。聚焦核心 |
| "先上线再看数据" | 没有基线，无法衡量改善。上线前就定义 |
| "DAU 就是 NSM" | DAU 反映活跃但不反映价值。用户"来了"≠ 用户"获得了价值" |
| "护栏太保守了" | 护栏的存在是为了防止你优化 A 而牺牲 B |
| "目标设低一点，容易达成" | 容易达成 = 没有挑战 = 没有成长 |

## 执行流程

```
1. 读取 PRD 中的成功指标（如有）
2. 定义 North Star Metric
   ├── 反映产品核心价值？
   ├── 团队可行动？
   └── 全公司可理解？
3. 拆解输入指标（驱动 NSM 的上游，3-5 个）
4. 定义输出指标（衡量结果的下游，2-3 个）
5. 定义护栏指标（防止副作用，2-3 个）
6. 为每个指标定义：名称、定义、数据来源、计算方式、目标值
7. Iron Law 检查
   ├── NSM 存在且不是虚荣指标？
   ├── 输入指标可行动？
   └── 护栏指标 ≥1 个？
8. 产出指标定义文档
```

## 交付前检查

- [ ] North Star Metric 已定义
- [ ] 有 ≥ 2 个输入指标和 ≥ 1 个输出指标
- [ ] 有 ≥ 1 个护栏指标
- [ ] 每个指标有数据来源和计算方式
- [ ] 每个指标有当前值（或标注 [待采集]）和目标值
- [ ] 指标总数 ≤ 12（NSM + 输入 + 输出 + 护栏）

## 产出格式

```markdown
# 指标体系: [产品/功能名]

> **日期**: YYYY-MM-DD
> **North Star**: [指标名]

## North Star Metric
**[指标名]**: [定义]
- 数据来源: [来源]
- 计算方式: [公式]
- 当前值: [值] | 目标值: [值]
- 更新频率: [每日/每周/每月]

## 输入指标（驱动 NSM）
| 指标 | 定义 | 数据来源 | 计算方式 | 当前值 | 目标值 |
|------|------|----------|----------|--------|--------|

## 输出指标（衡量结果）
| 指标 | 定义 | 数据来源 | 计算方式 | 当前值 | 目标值 |
|------|------|----------|----------|--------|--------|

## 护栏指标（防止副作用）
| 指标 | 定义 | 底线值 | 告警阈值 | 超过后果 |
|------|------|--------|----------|----------|
```

详细指标框架和 NSM 选择方法见 `references/metrics-framework.md`。

## 常见错误

| 错误 | 后果 | 正确做法 |
| --- | --- | --- |
| 追踪太多 | 信息过载 | NSM + 3-5 输入 + 2-3 护栏 |
| 虚荣指标 | 误导决策 | 只用可行动指标 |
| 无基线 | 无法衡量改善 | 上线前采集基线 |
| 无护栏 | 优化 A 损害 B | 每个优化配护栏 |
| 目标模糊 | 无法判断达成 | 用具体数字和日期 |
