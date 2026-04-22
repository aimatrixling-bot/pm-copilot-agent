---
name: pm-tech-spec
displayName: 技术规格
displayDescription: 撰写连接产品需求与工程实现的技术规格
description: "Write technical specifications that bridge product requirements and engineering implementation. Use this skill whenever the user needs to define technical architecture, says 'tech spec', '技术规格', '技术方案', 'technical design', '技术文档', '架构设计', or has a PRD ready for technical breakdown. Also trigger when the user says 'how should we build this', 'what's the technical approach', or 'define the architecture for'. Converts PRD features into API designs, data models, and implementation plans that engineers can execute."
user-invocable: true
argument-hint: "[功能名称或 PRD 文件路径]"
---

# 技术规格

<SUBAGENT-STOP>
如果是子代理派发执行此 Skill，直接按下方指令执行，不重新加载入口 Skill。
</SUBAGENT-STOP>

从 PRD 提取功能需求，生成技术规格框架。帮助 PM 和开发对齐实现方案。

**输入**: PRD 文件路径或功能描述
**输出**: 技术规格文档

## Iron Law

| 铁律 | 违反后果 |
| --- | --- |
| 无 PRD 关联的技术规格是空中楼阁 | 立即停止——先确认关联的 PRD 后继续 |
| 每个技术决策必须有理由 | 立即停止——补充"为什么选这个"后继续 |
| 非功能需求不可省略 | 立即停止——补充性能/安全/可扩展性要求后继续 |

## 反合理化

| 你可能在想的 | 真相 |
| --- | --- |
| "先写代码，文档后补" | 后补的文档永远和实现不一致 |
| "架构图不需要，太明显了" | 你觉得明显 ≠ 新同事觉得明显 |
| "性能以后再优化" | 以后 = 永远不会。先定义最低要求 |
| "安全交给安全团队" | 安全是设计出来的，不是检查出来的 |
| "这个太简单不需要 spec" | 简单的东西出错时最浪费时间排查 |

## 执行流程

```
1. Read PRD 提取功能需求和非功能需求
2. 系统概述 — 定义要构建什么、范围、关键目标
3. 架构设计 — 组件关系、技术栈、交互方式
4. 数据模型 — 实体、字段、关系、索引
5. API 规范 — 端点、请求/响应、认证、错误码
6. 非功能需求 — 性能、安全、可扩展性、监控
7. 技术决策 — 选项、选择、理由（记录为什么）
8. Iron Law 检查
   ├── 有 PRD 关联？
   ├── 每个技术决策有理由？
   └── 非功能需求已定义？
9. 标注 [待开发确认] 的技术细节
10. 产出技术规格文档
```

## 交付前检查

- [ ] 关联 PRD 已标注
- [ ] 覆盖 PRD 中的所有 P0 功能
- [ ] API 设计包含端点、请求/响应格式、错误码
- [ ] 数据模型含实体、关系、索引
- [ ] 非功能需求已考虑（性能、安全、可用性）
- [ ] 技术选型有理由说明
- [ ] 风险和缓解已列出
- [ ] [待开发确认] 项已标注

## 产出格式

```markdown
# 技术规格: [功能名]

> **关联 PRD**: [PRD 路径]
> **作者**: [用户名] (AI-assisted)
> **状态**: Draft

## TL;DR
1. 目的: {一句话}
2. 核心技术: {主要技术栈}
3. 关键决策: {最重要的技术选择}

## 1. 架构概述
[组件关系描述或 Mermaid 图]

## 2. API 设计
| 端点 | 方法 | 请求 | 响应 | 说明 |
|------|------|------|------|------|

## 3. 数据模型
| 实体 | 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|------|

## 4. 非功能需求
| 需求 | 指标 | 方案 |
|------|------|------|
| 响应时间 | ≤ 200ms | [方案] |
| 安全 | [要求] | [方案] |
| 可扩展性 | [要求] | [方案] |

## 5. 技术决策
| 决策 | 选项 | 选择 | 理由 |
|------|------|------|------|

## 6. 风险
| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|

**[待开发确认]** [需要开发团队确认的技术细节]
```

详细输出模板见 `references/output-template.md`。
质量检查清单见 `references/quality-checklist.md`。

## 常见错误

| 错误 | 后果 | 正确做法 |
| --- | --- | --- |
| 过度设计 | 实施延迟 | 从简单设计开始，随需求演进 |
| 缺少非功能需求 | 只关注功能忽略性能/安全 | 始终定义性能、安全要求 |
| API 不规范 | 前后端对接困难 | 使用统一 API 规范 |
| 无迁移计划 | 现有系统切换出问题 | 包含迁移和回滚计划 |
| 无错误处理 | 异常场景未定义 | 定义所有错误码和消息 |
