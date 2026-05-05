---
name: pm-retro
displayName: 团队回顾
displayDescription: 结构化团队回顾，识别改进点
description: "Run team retrospectives to reflect and improve. Use this skill whenever the user wants to review past work, says 'retro', 'retrospective', '回顾', '复盘', 'sprint retro', 'post-mortem', or wants to analyze what went well and what didn't. Also trigger at project milestones, sprint endings, or when the user says 'let's look back at what we did'. Converts vague feelings about a project into structured, actionable improvements."
user-invocable: true
argument-hint: "[复盘的时间范围或项目名称]"
---

# 回顾复盘

<SUBAGENT-STOP>
如果是子代理派发执行此 Skill，直接按下方指令执行，不重新加载入口 Skill。
</SUBAGENT-STOP>

引导团队回顾过去的工作，产出可执行的改进行动计划。不是抱怨会，是学习会。

**输入**: 时间范围（Sprint/季度/项目周期）+ 项目名称
**输出**: 回顾报告 + 改进行动计划

## Iron Law

| 铁律 | 违反后果 |
| --- | --- |
| 不指责个人，聚焦流程 | 出现人身攻击 → 立即叫停并重申规则 |
| 每个行动项必须有负责人和截止日期 | 只有建议没有行动 = 没有复盘 |
| 持续验证上次改进是否生效 | 不验证 = 同样的问题反复出现 |

## 反合理化

| 你可能在想的 | 真相 |
| --- | --- |
| "复盘就是大家说说感受" | 说感受不是复盘，是聊天。结构化分析+行动项=复盘。没有行动项=抱怨会 |
| "上次的问题已经解决了" | "已解决"需要证据。上次行动项的执行效果必须量化验证 |
| "行动项多列一些更保险" | >5 个行动项 = 没有重点 = 都不做。<=5 个，按影响/难度排序 |
| "出了问题应该找是谁的责任" | 找人=防御模式=以后没人敢说话。找流程漏洞=学习模式=系统性改善 |
| "这次做得好，不用记录" | 不记录的好经验=重复造轮子。好做法要显式标注"继续做" |

## 回顾方法

根据团队成熟度和场景选择：

| 方法 | 适用场景 | 结构 |
| --- | --- | --- |
| **Start-Stop-Continue** | 快速复盘、新团队 | 开始做/停止做/继续做 |
| **4Ls** | 全面复盘、季度回顾 | Liked/Learned/Lacked/Longed for |
| **KPT** | 亚洲团队、简洁复盘 | Keep/Problem/Try |
| **Sailboat** | 视觉化、产品方向复盘 | 帆船/风/锚/岛/鲨鱼 |

不确定 → 默认用 Start-Stop-Continue。

详细方法指南见 `references/retro-methods.md`。

## 执行流程

```
1. 确定复盘范围
   ├── 时间段（上个 Sprint / Q1 / 项目阶段）
   ├── 参与者（列出相关人员）
   └── 回顾方法（默认 Start-Stop-Continue）

2. 收集回顾数据
   ├── Read 项目已有文档（PRD、决策记录、发布日志）
   ├── 提取关键时间节点和决策
   └── 对话中收集用户补充信息

3. 按方法执行分析
   ├── 每个维度 ≥ 2 条
   └── 用事实说话，不用感觉

4. 改进行动计划
   ├── 每个改进项：具体行动 + 负责人 + 截止日期
   ├── 按影响/难度排序
   └── 行动项数量 ≤ 5（多了等于没有）

5. 产出回顾报告
```

## 行动项标准

好的行动项必须满足：

| 标准 | 说明 |
| --- | --- |
| 具体 | 清楚要做什么 |
| 可执行 | 团队能够完成 |
| 有负责人 | 明确谁负责 |
| 有截止日期 | 明确何时完成 |
| 可衡量 | 完成时能验证 |

## 常见错误

| 错误 | 后果 | 正确做法 |
| --- | --- | --- |
| 变成抱怨会 | 消极氛围 | 聚焦解决方案 |
| 无行动跟进 | 同样问题重复出现 | 严格执行行动项 |
| 指责个人 | 防御心理，不敢发言 | 关注流程 |
| 只有少数人发言 | 遗漏重要观点 | 邀请每个人发言 |
| 行动项太多 | 无法执行 | ≤ 5 个，按优先级排序 |

> 详细检查清单和约束见 `references/delivery-checklist.md` 和 `references/hard-bans.md`

## 产出格式

```markdown
# 回顾复盘: [项目名称] - [时间范围]

> **日期**: YYYY-MM-DD
> **参与者**: [列表]
> **方法**: [Start-Stop-Continue/4Ls/KPT/Sailboat]

## 回顾分析

### [维度1: 如"做得好的"]
1. ...
2. ...

### [维度2: 如"做得不好的"]
1. ...
2. ...

### [维度3: 如"如何改进"]
1. ...

## 行动计划
| # | 改进行动 | 负责人 | 截止日期 | 优先级 |
|---|----------|--------|----------|--------|
| 1 | {具体行动} | {负责人} | {日期} | P0 |

## 下次回顾
[建议日期] | 重点关注：[上次行动项的执行情况]
```

## 持续验证模式

当用户说"验证一下上次改进是否生效"时：

1. 读取上次回顾报告
2. 逐项检查行动项执行状态
   - 已完成 → 验证效果（量化数据或定性反馈）
   - 进行中 → 评估进度
   - 未开始 → 分析阻碍因素
3. 产出验证报告（每项状态 + 有效性评分 1-5 + 调整建议）
