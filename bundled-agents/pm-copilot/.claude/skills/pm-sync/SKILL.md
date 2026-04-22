---
name: pm-sync
displayName: 项目同步
displayDescription: 生成结构化项目状态报告
description: "Generate structured project status reports by scanning local files and extracting key changes. Use this skill whenever the user needs a project sync, says '项目同步', 'status sync', '状态更新', '项目摘要', 'weekly update', '周报', '日报', '进度报告', 'status report', 'project summary', or wants to summarize project progress. Also trigger when the user says 'what changed this week', 'give me a status update', 'summarize project progress', '帮我写个周报', '项目最近有什么变化', or '更新一下项目状态'. Reads local project files and produces weekly/daily/milestone reports."
user-invocable: true
argument-hint: "[项目目录]"
---

# 项目同步

<SUBAGENT-STOP>
如果是子代理派发执行此 Skill，直接按下方指令执行，不重新加载入口 Skill。
</SUBAGENT-STOP>

读取项目文件，产出结构化状态报告。好的项目同步不是复制粘贴，是提炼关键变化。

**输入**: 项目目录路径
**输出**: 状态报告（weekly/daily/milestone）

## Iron Law

| 铁律 | 违反后果 |
| --- | --- |
| 报告必须有数据来源 | 立即标注——每个变化标注来源文件 |
| 无变化的文件不报告 | 删除——只报告有变化的项 |
| 超过 1 页的报告没人看 | 精简——保留关键变化和风险 |

## 反合理化

| 你可能在想的 | 真相 |
| --- | --- |
| "报告越详细越好" | 超过 1 页 = 没人看。关键变化 + 风险 = 足够 |
| "所有文件变化都要列出" | 格式变化不算变化。只报告内容变化 |
| "风险以后再说" | 现在看到的风险 = 以后爆炸的炸弹 |
| "不需要标注来源" | 没有来源 = 无法验证 = 不可信 |

## 参数

| 参数 | 类型 | 必需 | 默认值 |
| --- | --- | --- | --- |
| 项目目录 | 路径 | 是 | 当前工作区 |
| 报告类型 | weekly/daily/milestone | 否 | weekly |
| 输出语言 | 中文/英文 | 否 | 中文 |

## 执行流程

```
1. Glob 扫描项目文档（*.md, PRD*, docs/**）
2. Read 最近修改的文件（≤ 10 个）
3. 提取关键变化（新增/修改/待确认）
4. 按报告类型格式化产出
```

## 交付前检查

- [ ] 支持 weekly/daily/milestone 三种报告类型
- [ ] 从文件系统自动提取状态
- [ ] 关键变化已标注来源文件

## 产出格式

```markdown
## 项目状态报告 — [日期]

### 本周进展
- [已完成事项]

### 待处理
- [待确认/待决策事项]

### 风险
- [新识别的风险]

### 下周计划
- [计划事项]
```

---

报告生成技巧（文件扫描策略、变化识别方法、三种报告格式差异）见 `references/sync-methods.md`。

## 常见错误

| 错误 | 后果 | 正确做法 |
| --- | --- | --- |
| 复制粘贴文件内容 | 报告冗长不可读 | 提炼关键变化 |
| 不标注来源 | 无法验证信息 | 每个变化标注来源文件 |
| 报告所有文件 | 噪音太多 | 只报告有实际变化的文件 |
| 忽略风险 | 问题积累 | 主动识别并记录风险 |
| 无优先级 | 看不出重点 | 按重要程度排序 |
