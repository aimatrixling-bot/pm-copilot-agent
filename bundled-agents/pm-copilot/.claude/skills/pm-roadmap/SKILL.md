---
name: pm-roadmap
displayName: 产品路线图
displayDescription: 创建连接战略与执行的产品路线图
description: "Create or update product roadmaps that connect strategy to execution. Use this skill whenever the user wants to plan product timelines, says 'roadmap', '产品路线图', '规划路线', '季度规划', '排期', 'timeline', 'Now-Next-Later', '里程碑', or asks to organize features by quarter/month. Also trigger when the user says 'what are we building this quarter', 'plan next sprint cycle', or needs to align delivery with strategic goals. Converts scattered feature lists into structured, communicable roadmaps with clear milestones."
user-invocable: true
argument-hint: "[产品名称或已有 PRD/RICE 文件路径]"
---

# 产品路线图

<SUBAGENT-STOP>
如果是子代理派发执行此 Skill，直接按下方指令执行，不重新加载入口 Skill。
</SUBAGENT-STOP>

将功能列表、优先级和战略目标整合为可执行的路线图。路线图不是 Gantt 图，是沟通工具。

**核心原则**：路线图是承诺的边界，不是精确的时间表。

## Iron Law（铁律）

| 铁律 | 违反后果 |
| --- | --- |
| 没有目标的路线图不是路线图 | 立即停止——补充时间范围和阶段目标后继续 |
| 没有优先级的里程碑无法执行 | 立即停止——为每个里程碑标注 P0/P1/P2 后继续 |
| 没有依赖标注的路线图会卡住 | 立即停止——列出跨团队/系统依赖后继续 |

## 反合理化

| 你可能在想的 | 真相 |
| --- | --- |
| "先列出所有功能，再排时间" | 没有约束的排期是幻想——先确认资源和目标 |
| "路线图就是 Gantt 图" | 路线图是沟通工具，Gantt 是执行工具 |
| "每个功能都要有精确日期" | 精确日期 = 虚假的确定性。用范围（Q2、3 月） |
| "老板要看所有功能都在图上" | 全部放上 = 全部不重要。路线图必须有取舍 |
| "做完路线图就不用改了" | 路线图是活文档，市场变化会改变优先级 |

## Entry Mode

### Guided（引导模式）— 8 步

1. **路线图目标** — 目的？（对齐团队/汇报/执行计划/沟通）
2. **时间范围** — 1 季度/2 季度/1 年/自定义
3. **战略目标** — 1-3 个阶段目标
4. **功能来源** — PRD/RICE 排序/直接输入/梳理（如输入含战略规划文档，自动启用战略层模式 3H+OKR）
5. **资源约束** — 团队规模
6. **依赖识别** — 跨团队/外部依赖
7. **里程碑划分** — 自动划分 → 用户确认
8. **产出确认** — 完整路线图 → 确认交付

### Quick（快速模式）— ≤ 3 个问题

**问题 1**: "产品名称和时间范围？"
**问题 2**: "最重要的 3-5 个功能或目标？"
**问题 3**（可选）: "有什么硬约束？"

然后：自动推断里程碑 → 标注 [假设] → 产出路线图表格 + 依赖

### Expert（专家模式）— 直接产出 + 高级选项

- A. OKR 对齐模式 — 里程碑关联 Objective 和 Key Results
- B. Now-Next-Later — 轻量三段式
- C. 季度路线图 — 按季度 1-3 个主题
- D. 主题路线图 — 按主题（性能/体验/增长）组织
- E. 自定义模板
- F. 战略路线图 — 使用 3H 模型 + OKR 对齐（见 `references/strategic-planning.md`）

## 执行流程

```
触发 pm-roadmap
    ├── 1. 模式判断（Guided/Quick/Expert）
    ├── 2. 读取上下文（Glob 搜索 PRD/RICE/Roadmap）
    ├── 3. 按模式执行
    ├── 4. 里程碑划分（时间/主题/优先级分组）
    ├── 5. Iron Law 检查
    │     ├── 有时间范围和阶段目标？
    │     ├── 每个里程碑有优先级？
    │     └── 依赖已列出？
    ├── 6. 标注检查（[假设] [待确认]）
    └── 7. 交付 + 建议下一步（→ pm-launch 或 → pm-backlog）
```

## 交付前检查

- [ ] 路线图有明确的时间范围
- [ ] 每个里程碑有 1-3 个明确目标
- [ ] 每个里程碑标注优先级（P0/P1/P2）
- [ ] 功能列表来源已标注
- [ ] 跨团队/系统依赖已列出
- [ ] 资源约束已考虑
- [ ] 所有推断标注 [假设]，待确认项标注 [待确认]
- [ ] 风险已标注（高/中/低）

## 路线图视图类型

| 视图 | 适用场景 | 结构 |
| --- | --- | --- |
| **Timeline** | 沟通节奏和预期 | 按季度/月展示功能 |
| **Portfolio** | 战略对齐 | 按战略支柱分组 |
| **Now-Next-Later** | 敏捷团队 | 不承诺时间，只表达相对顺序 |

详细输出模板见 `references/output-template.md`。
质量检查清单见 `references/quality-checklist.md`。

## 交付前补充检查

- [ ] 里程碑依赖的技术路径已验证（非 Magic Step）
- [ ] 风险缓解措施具体可执行（见 `references/quality-gates-shared.md` 风险缓解格式）

## 常见错误

| 错误 | 后果 | 正确做法 |
| --- | --- | --- |
| 固定承诺 | 延期被视为失败 | 强调方向性，标注会调整 |
| 过度详细 | 丧失灵活性 | 近细远粗（Q1 月度，Q2+ 季度） |
| 缺少战略对齐 | 随机功能堆砌 | 每项追溯到战略支柱 |
| 忽略维护 | 技术债累积 | 预留 15-20% 维护容量 |
| 无缓冲 | 任何延迟导致延期 | 预留 10-20% 缓冲 |
