---
name: pm-eng-request
displayName: 工程需求单
displayDescription: 创建清晰无歧义的工程需求描述
description: "Create crystal-clear engineering requests that bridge product and engineering teams. Use this skill whenever the user needs to write an engineering request or ticket, says 'eng request', 'engineering ticket', '工程需求', '开发任务', 'Jira ticket', '工程需求单', '技术需求', '开发工单', '需求单', or wants to create structured engineering requests from PRDs. Also trigger when the user says 'create a ticket for this feature', 'I need to hand this off to engineering', 'write an engineering brief', '帮我写个需求单', '这个功能怎么交给开发', or '开发需要什么信息'. Translates PRD requirements into developer-executable tasks with Given-When-Then acceptance criteria."
user-invocable: true
argument-hint: "[功能名称或 PRD 路径]"
---

# 工程需求

<SUBAGENT-STOP>
如果是子代理派发执行此 Skill，直接按下方指令执行，不重新加载入口 Skill。
</SUBAGENT-STOP>

从 PRD 提取需求，生成结构化工程需求单。帮助 PM 和开发对齐工作范围。

**输入**: PRD 文件路径或功能描述
**输出**: 工程需求单（可导出为 Jira ticket）

## Iron Law

| 铁律 | 违反后果 |
| --- | --- |
| 没有"为什么做"的需求单不是需求单 | 立即补充——开发不理解 Why = 做偏 |
| 验收标准必须 Given-When-Then | 重写——"功能正常"不可测试 |
| 所有推断必须标注 [假设] | 立即标注——未标注的推断 = 误导开发 |

## 反合理化

| 你可能在想的 | 真相 |
| --- | --- |
| "开发自己知道怎么做" | 开发知道的是技术实现，不是产品需求。你的需求单是产品契约 |
| "验收标准写太细了" | 越细越不容易做偏。"功能正常" 不是验收标准 |
| "背景不用写，PRD 里有" | 开发不一定看 PRD。需求单必须自包含 |
| "估时不用写" | PM 的粗估帮助团队判断规模。精确估时由开发完成 |
| "依赖以后再说" | 依赖不标注 = 被阻塞时才知道 |

## 执行流程

```
1. Read PRD 提取功能范围和验收标准
2. 生成工程需求单
   ├── 背景（为什么做）—— 自包含，不依赖 PRD
   ├── 需求描述（做什么）—— 具体到可执行
   ├── 验收标准（Given-When-Then）—— 可直接测试
   ├── 技术约束（非功能需求）—— 性能/安全/兼容
   ├── 依赖（外部系统/团队）—— 已沟通/待沟通
   └── 估时建议（粗估）—— 标注置信度
3. 标注 [待确认] 的估算项
4. 标注 [假设] 的推断项
5. Iron Law 检查
   ├── 有"为什么做"？
   ├── 验收标准 Given-When-Then？
   └── 推断已标注？
```

## 需求类型

| 类型 | 说明 | 优先级范围 |
| --- | --- | --- |
| Feature | 新功能 | P0-P2 |
| Bugfix | 缺陷修复 | P0-P1 |
| Spike | 技术调研 | P1-P2 |
| Investigation | 问题排查 | P0-P2 |

## 交付前检查

- [ ] 背景说明清晰（为什么做）
- [ ] 需求描述具体（做什么）
- [ ] 验收标准 Given-When-Then 可直接测试
- [ ] 依赖已列出且标注沟通状态
- [ ] 推断项标注 [假设]
- [ ] 估时标注置信度

## 产出格式

```markdown
# 工程需求: [功能名]

**Request ID**: ENG-[XXX]
**Priority**: P0/P1/P2
**Type**: Feature/Bugfix/Spike/Investigation
**Requested By**: [PM]

## 元数据
| 字段 | 值 |
|------|-----|
| 优先级 | P0/P1/P2 |
| 关联 PRD | [路径] |
| Sprint | [目标 Sprint] |
| 标签 | [功能标签] |

## 背景
[为什么做这个需求，用户问题是什么。自包含，不依赖 PRD]

## 需求描述
[做什么，功能范围。具体到开发可执行]

## 验收标准
- [ ] Given [前置条件] When [操作] Then [预期结果]
- [ ] Given [前置条件] When [操作] Then [预期结果]
- [ ] Given [异常场景] When [操作] Then [预期错误处理]

## 技术约束
| 约束 | 要求 |
|------|------|
| 性能 | [响应时间/吞吐量] |
| 安全 | [认证/授权] |
| 兼容 | [浏览器/版本] |

## 依赖
| 依赖 | 团队 | 状态 |
|------|------|------|
| [依赖 1] | [团队] | 已沟通/待沟通 |

## 估时
| 任务 | 估时 | 置信度 |
|------|------|--------|
| [任务 1] | [X 天] | 高/中/低 |

**[待确认]** [需要开发确认的估时和技术方案]
**[假设]** [推断的内容，需要验证]
```

---

工程需求编写指南（AC 编写技巧、复杂度评估、跨团队协作）见 `references/eng-request-guide.md`。

## 常见错误

| 错误 | 后果 | 正确做法 |
| --- | --- | --- |
| 无背景说明 | 开发不理解 Why | 需求单自包含背景 |
| 验收标准模糊 | "功能正常"不可测试 | 用 Given-When-Then |
| 不标注依赖 | 被阻塞才知道 | 列出所有外部依赖 |
| 估时太乐观 | 排期不准 | 粗估 + 标注置信度 |
| 不标注假设 | 推断当事实 | 所有推断标 [假设] |
