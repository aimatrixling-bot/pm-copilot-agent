---
name: pm-comp
displayName: 竞品分析
displayDescription: 系统化竞品分析，识别差异化机会
description: "Analyze competitors systematically. Use this skill whenever the user mentions competitors, says '竞品分析', '对标', '竞品对比', 'competitive analysis', 'benchmark', or wants to understand the competitive landscape. Also trigger when the user asks 'who are our competitors', 'what does X do differently', or mentions competitor names and wants comparison. Even casual mentions like 'how does Notion compare to Linear' should trigger this skill."
user-invocable: true
argument-hint: "[竞品名称或行业领域]"
---

# 竞品分析

<SUBAGENT-STOP>
如果是子代理派发执行此 Skill，直接按下方指令执行，不重新加载入口 Skill。
</SUBAGENT-STOP>

引导 PM 进行系统化的竞品分析——从"我觉得竞品怎么样"到"数据表明竞品的优劣"。

**核心原则**：竞品分析的目的不是模仿，是找到差异化空间。好的竞品分析告诉你"不该做什么"和"可以做得更好"。

## Iron Law（铁律）

| 铁律 | 违反后果 |
| --- | --- |
| 每个结论必须有来源 | 立即停止——补充来源后继续，无法补充的标注 [未验证] |
| 竞品信息必须标注时效 | 立即停止——补充数据收集日期后继续 |
| 不可全盘肯定或否定竞品 | 立即停止——每个竞品必须列出 ≥ 1 个优势和 ≥ 1 个劣势 |

## 反合理化

| 你可能在想的 | 真相 |
| --- | --- |
| "我了解这个竞品，不需要查" | 你了解的是印象，不是数据。印象会过时 |
| "竞品做得很好，我们学它" | 竞品的好 ≠ 适合你的用户。先验证用户需求 |
| "没有竞品数据" | 没有公开数据 ≠ 没有信息。可以分析官网、定价页、用户评价 |
| "小竞品不用看" | 今天的忽略 = 明天的威胁。小竞品可能代表趋势 |
| "这个数据足够了" | 单一来源的数据不可靠。核心结论至少 2 个来源 |

## Entry Mode

### Guided（引导模式）— 预计 6-8 个问题

**Step 1: 分析目标**
问："这次竞品分析的目的是什么？请选择：
A. 了解市场格局 B. 找到差异化空间 C. 评估新功能可行性 D. 定价参考 E. 其他"
→ 记录分析目标

**Step 2: 竞品范围**
问："你想分析哪些竞品？（建议 3-5 个，最多 8 个）
类型：A. 直接竞品 B. 间接竞品 C. 替代方案 D. 国际对标"
→ 记录竞品列表 + 类型

**Step 3: 分析维度**
问："最关注哪些维度？请选择（可多选）：
A. 功能对比 B. 定价策略 C. 用户体验 D. 技术架构 E. 市场定位 F. 用户口碑 G. 增长策略"
→ 记录分析维度（≥ 3 个）

**Step 4: 功能清单**
问："列出你想对比的核心功能（5-15 个）"
→ 建立功能对比矩阵的行

**Step 5: 数据收集**
问："你有这些竞品的第一手使用体验吗？或者需要我帮你搜索公开信息？"
→ A. 用户提供 → 标注 [用户经验] | B. AI 搜索 → 标注来源 + [搜索日期]

**Step 6: 评分对比**
基于 Step 4-5 的数据，对每个竞品×维度评分 → 展示对比矩阵 → 用户确认/修正

**Step 7: 差异化分析**
问："基于对比，你看到哪些差异化机会？"
→ 引导总结差异点 → 用户确认

**Step 8: 产出确认**
展示完整竞品分析报告 → 用户最终确认 → 交付

### Quick（快速模式）— ≤ 2 个问题后直接产出

**问题 1**: "竞品名称或行业？你的产品是什么？"
**问题 2**（可选）: "你最关心哪个维度？（功能/定价/用户体验）"

然后：
- WebSearch 搜索竞品公开信息
- 自动选择 5 个标准维度对比
- 产出竞品分析表格
- 所有来源标注引用
- 自动生成差异化建议
- AI 搜索数据标注 [搜索日期]，置信度默认"中"

## pm-researcher 调用时（Spawn 上下文）

当被 pm-researcher 在 Spawn 模式下调用时：
- **无模式**（自动执行，不交互提问）
- **不可提问**，按指令直接执行
- 输出**结构化数据**（对比矩阵 + 引用），差异化分析由 pm-researcher 整合
- Iron Law 保留，但置信度统一降一档

**Spawn 指令示例**：
```
执行 pm-comp 分析：
- 竞品：[A, B, C]
- 维度：[功能对比, 定价, 用户体验]
- 输出：对比矩阵 + 每个竞品优劣 + 引用
- 约束：不提问，直接产出
```

## Scope Gate（范围门控）

> 范围门控完整规则见 `references/scope-guide.md`

## 执行流程

```
触发 pm-comp
    ├── 1. 模式判断（Guided/Quick）
    ├── 2. 确定竞品范围（用户指定或 WebSearch 发现）
    ├── 3. 收集数据
    │     ├── WebSearch 搜索公开信息
    │     ├── WebFetch 深度阅读关键页面
    │     └── Read 项目已有竞品文档
    ├── 4. 构建对比矩阵（竞品 × 维度 评分）
    ├── 5. Iron Law 检查
    │     ├── 每个结论有来源？
    │     ├── 数据有时效标注？
    │     └── 每个竞品有优劣势？
    ├── 6. 差异化分析
    │     ├── 识别空白区域
    │     ├── 识别差异化机会
    │     └── 识别学习机会
    └── 7. 交付 + 建议下一步（→ pm-prd 或 → pm-rice）
```

> 详细检查清单和约束见 `references/delivery-checklist.md`、`references/hard-bans.md`、`references/source-attribution.md` 和 `references/scope-guide.md`

## 输出结构

**格式铁律**：竞品分析报告作为文档类产出，在对话中直接输出为 Markdown。不得包含 `<generative-ui-widget>`、`<style>` 等无法在 Markdown 渲染中正确显示的标签。不将报告包裹在代码围栏（```` ```markdown ``` ````）中。所有可视化内容（表格、列表、流程）用 Markdown 原生语法表达。若用户要求导出为 docx/pdf 等格式，按目标格式处理。

完整的竞品分析报告使用 `references/output-template.md` 中的模板。核心产出：

1. **竞品概览表** — 竞品/类型/定位/核心优势
2. **详细分析**（每个竞品）— 功能/定价/UX/SWOT
3. **对比矩阵** — 功能对比表 + 定位对比表
4. **差异化机会** — 空白区域 + 服务不足的细分
5. **战略建议** — 要构建什么 + 要避免什么
6. **残酷风险区** — 分析局限 + 过时风险

质量检查标准详见 `references/quality-checklist.md`。
