---
name: pm-prd
displayName: PRD
displayDescription: 撰写或改进产品需求文档
description: "Write or improve Product Requirements Documents. Use this skill whenever the user wants to create, review, refine, or iterate on a PRD — including saying 'write PRD', 'help with PRD', '需求文档', '写PRD', 'product requirements', 'feature spec', or describing a product feature they want to build. Also trigger when the user shares competitive analysis, user research, or problem statements that naturally lead to PRD creation. Even if they just say 'we need to build X', this skill helps turn that into a structured PRD."
user-invocable: true
argument-hint: "[产品/功能名称或描述]"
---

# PRD 编写

<SUBAGENT-STOP>
如果是子代理派发执行此 Skill，直接按下方指令执行，不重新加载入口 Skill。
</SUBAGENT-STOP>

引导产出结构化的产品需求文档。PRD 不是文档，是合约——它连接 PM 的思考和工程的执行。

**核心原则**：模糊的 PRD 比没有 PRD 更危险。

## Iron Law（铁律）

| 铁律 | 违反后果 |
| --- | --- |
| 没有"为什么"的 PRD 不是 PRD | 立即停止——补充 Problem Statement 和 Why Now 后继续 |
| 每个 User Story 必须有验收标准 | 立即停止——补全 Given-When-Then 后继续 |
| 没有成功指标的 PRD 无法验证 | 立即停止——定义 ≥ 1 个可量化成功指标 **及其测量方法**后继续 |

## 反合理化

| 你可能在想的 | 真相 |
| --- | --- |
| "用户说了需求，直接写" | 用户说的是解决方案，不是问题——先验证问题存在 |
| "这个功能大家都需要" | "大家都需要" ≠ "大家愿意付钱/花时间"——用数据证明 |
| "PRD 写完就交" | 写完 → Iron Law 检查 → 标注 → 交付，缺一不可 |
| "技术细节让开发自己决定" | PM 必须定义约束边界，否则开发会按最容易的方式实现 |
| "竞品这么做，我们也应该" | 竞品这么做 ≠ 对你的用户正确——回归用户问题验证 |

## 保真度级别

根据使用场景选择 PRD 深度，不同保真度影响输出结构和详细程度：

| Level | 适用场景 | 预期篇幅 | 受众 |
|-------|---------|---------|------|
| **Low-fi** | 团队讨论、快速对齐、早期想法验证 | 2-4 页 | 产品、设计 |
| **High-fi** | 工程开发、正式交付、干系人评审 | 8-15 页 | 全部干系人 |

保真度选择逻辑：
- 用户明确指定 → 按指定
- 对话上下文表明在探索阶段 → Low-fi
- 对话上下文表明准备开发 → High-fi
- 不确定 → 先问

## Entry Mode

### Guided（引导模式）— 预计 8-10 个问题

**Step 1: 产品背景** — "这个产品/功能解决什么问题？谁会用它？"
→ 记录 Problem、Target User

**Step 2: 为什么是现在** — "为什么现在做这个而不是 6 个月后？有什么外部变化？"
→ 记录 Why Now、Market Context

**Step 3: 成功指标** — "你怎么知道这个产品成功了？请选择：A. 用户增长 B. 收入增长 C. 用户留存 D. 运营效率 E. 其他"
→ 记录 Success Metrics + 测量方法（数据来源、计算方式、频率）

**Step 4: 目标用户** — "核心用户是谁？他们的典型场景是什么？"
→ 记录 Target User、Use Cases

**Step 5: 功能范围** — "第一期需要哪些功能？（逐个列出，我会帮你区分 P0/P1/P2）"
→ 记录 Features、优先级

**Step 6: 非功能需求** — "有性能、安全、合规方面的特殊要求吗？（如无特殊要求，将使用默认值）"
→ 记录 NFR（默认：响应 < 2s，99.9% 可用）

**Step 7: 依赖与风险** — "这个功能依赖哪些外部系统或团队？你知道哪些风险？"
→ 记录 Dependencies、Risks

**Step 8-9: User Stories + 验收标准**
基于前 7 步自动生成 User Stories（As a... I want to... So that...）+ Given-When-Then 验收标准 → 用户确认

**Step 10: 评审确认**
展示完整 PRD → 用户最终确认 → 交付

### Quick（快速模式）— ≤ 3 个问题后直接产出

**问题 1**: "产品/功能名称和一句话描述？"
**问题 2**: "核心用户和他们的主要问题？"
**问题 3**: "第一期最重要的 3 个功能？"

然后：
- 自动推断 Problem Statement、Why Now、NFR
- 自动生成 User Stories + 验收标准
- 所有推断标注 [假设]，自动填充标注 [默认]
- 产出 PRD 草稿，包含 [待确认] 标记

### Expert（专家模式）— 直接产出 + 方法论推理骨架

基于上下文直接产出完整 PRD。根据产品类型自动选择推理骨架：

| 产品类型 | 推理骨架 | 推理逻辑 |
| --- | --- | --- |
| B2B 企业功能 | Working Backwards | 从客户新闻稿 → FAQ → User Stories。强迫先想客户怎么描述价值 |
| B2C 消费端功能 | JTBD | 从用户要完成的"任务"出发。防止"功能堆砌" |
| 平台/基础设施 | Lean Canvas | 从问题-解决方案-独特价值开始。验证商业逻辑先于功能设计 |
| AI 原生功能 | 假设驱动 | 先列"如果 AI 能做 X"的假设 → 验证方法 → 再写需求 |
| 不确定 | 标准 PRD | 默认模板，包含所有最小必要字段 |

**高级选项**（用户可覆盖自动选择）：
A. Amazon Working Backwards | B. Lean Canvas PRD | C. JTBD PRD | D. 假设驱动 PRD | E. 标准 PRD | F. 自定义模板

推理骨架如何影响产出：
- Working Backwards → PRD 先写 Press Release 和 FAQ，User Stories 从 FAQ 衍生
- JTBD → PRD 先写 Job Statements，功能列表是 Job 的解决方案
- Lean Canvas → PRD 以 9 格画布为骨架，填充后再展开
- 假设驱动 → PRD 嵌入假设列表和验证计划，每个功能关联一个假设

每种骨架的详细定义和使用方法，见 `references/methodology-skeletons.md`。

## Scope Gate（范围门控）— ⚠️ 在任何执行之前必须先通过

**此检查在模式判断、保真度选择、任何输出之前执行。违反以下任一规则时，不得进入任何模式，不得生成任何 PRD 内容。**

### 硬拒绝（立即停止，不生成任何 PRD 内容）

| 请求类型 | 信号词/特征 | 正确响应 |
| --- | --- | --- |
| 用 AI 替代某个职业的全部工作 | "替代PM"、"替代产品经理"、"AI取代"、"不要PM了"、"全自动" | **硬拒绝**："这个请求超出了 PRD 的范畴。AI 无法替代产品经理的全部工作——PM 的核心价值在于理解用户、做取舍决策、跨团队协调。我可以帮你设计'AI辅助PM提升效率'的具体功能，但不能帮你设计'让PM下岗'的系统。" |
| 从零设计完整系统（前端+后端+数据库+支付+…） | 10+ 功能模块 + "一期全部上线" | **硬拒绝**："这个范围不是单个PRD能覆盖的——这是一个完整产品矩阵。14个模块一期上线在工程和商业上都不现实。我帮你从最核心的3个模块开始定义MVP，其余进入backlog分阶段规划。" |
| 荒谬/不现实的前提 | "火星上的"、"永动机"、"预测股票"、"读心术" | **硬拒绝**：指出前提不现实，回到可行的产品定义范围 |
| 生成代码、部署系统、黑客攻击 | "写代码"、"部署"、"攻击" | 拒绝 → 回到产品定义层面讨论 |
| 包含违法、不道德内容的请求 | | 明确拒绝 |

**硬拒绝的执行方式**：
1. **第一句话就拒绝**，不说"我来帮你"或"好的"
2. 解释为什么拒绝（1-2句话）
3. 提供替代方向（1个可行的重新框定）
4. **不生成任何 PRD 内容**

### 软质疑（先质疑，用户确认后才继续）

| 请求类型 | 质疑方向 |
| --- | --- |
| 功能多但范围合理（5-9个模块） | 质疑是否可以分阶段，建议MVP聚焦 |
| 小规模场景用重型 AI 方案 | 质疑 ROI，提供替代方案 |
| 没有明确用户/场景的"帮我写个PRD" | 反问澄清，不直接假设 |

### 判断流程

```
收到请求
  → 硬拒绝检查（第1优先级）
    → 匹配硬拒绝 → 立即拒绝 + 解释 + 替代方向 → 结束（不进入任何模式）
    → 不匹配 → 软质疑检查
      → 匹配软质疑 → 先质疑 → 用户确认后才继续
      → 不匹配 → 正常进入模式判断
```

**关键原则**：
- **先拒绝再讨论**，不是"先说好的再质疑"
- 拒绝的第一句话必须是否定，不能以肯定开头
- 每次拒绝后提供 1 个可行的替代方向

## 执行流程

```
触发 pm-prd
    ├── 0. Scope Gate（范围门控）
    │     ├── 检测请求是否在 PM 工作范畴内
    │     ├── 超范围 → 拒绝并解释原因，建议替代路径
    │     └── 在范围内 → 继续
    ├── 1. 模式判断（Guided/Quick/Expert）
    │     └── 根据用户输入量和明确度自动判断
    ├── 2. 确定保真度（Low-fi/High-fi）
    │     └── 根据使用场景和受众判断
    ├── 3. 读取上下文
    │     ├── Glob 搜索项目已有文档
    │     ├── Read 相关 PRD/Roadmap/Research
    │     └── 提取对话中的关键信息
    ├── 4. 按模式 × 保真度执行引导/产出
    │     ├── Low-fi: 使用精简模板（见 references/prd-template.md）
    │     └── High-fi: 使用完整模板
    ├── 5. Iron Law 检查
    │     ├── Problem Statement + Why Now 是否存在？
    │     ├── 每个 User Story 是否有验收标准？
    │     └── 是否有可量化成功指标？
    ├── 6. 标注检查（[默认] [假设] [待确认]）
    └── 7. 交付 + 后续推荐
          ├── pm-comp（竞品分析）、pm-rice（优先级细化）
          └── pm-wireframe（线框图）、pm-prototype（原型）
```

## 输出规范

**格式铁律**：PRD 作为文档类产出，在对话中直接输出为 Markdown。不得包含 `<generative-ui-widget>`、`<style>` 等无法在 Markdown 渲染中正确显示的标签。不将 PRD 包裹在代码围栏（```` ```markdown ``` ````）中。所有可视化内容用 Markdown 原生语法（表格、列表、引用块）表达。Agent 的解释性说明放在 PRD 内容之前或之后，与 PRD 正文明确分隔。若用户要求导出为 docx/pdf 等格式，按目标格式处理。

PRD 必须使用 `references/prd-template.md` 中的模板结构。核心章节：

### 必填章节（所有保真度）

1. **TL;DR** — 3 句话：核心问题、解决方案、成功指标
2. **问题陈述** — 谁、什么、为什么现在、不解决的后果
3. **目标和成功指标** — 指标表格（指标/基线/目标/时间框架/测量方式）+ 护栏指标
4. **解决方案概述** — 方案描述 + 关键功能列表 + 用户旅程
5. **范围边界** — In Scope / Out Scope / 未来迭代
6. **残酷风险区** — 牺牲了什么 + 最大失败风险 + 防御方案

### 高保真额外章节

7. **功能需求** — 用户故事 + Given-When-Then 验收标准 + 边缘情况
8. **技术考虑** — 性能/平台/集成/数据要求
9. **依赖和风险** — 依赖表 + 风险缓解表
10. **时间线和里程碑** — 分阶段里程碑
11. **FAQ** — 挑战关键假设的问答

### 标注系统

| 标注 | 含义 |
|------|------|
| `[假设]` | 基于推断的内容，需要用户确认 |
| `[默认]` | 自动填充的默认值，用户可覆盖 |
| `[待确认]` | 需要进一步讨论的开放问题 |

## 交付前检查

- [ ] Problem Statement 清晰且基于用户问题（非解决方案）
- [ ] Why Now 有具体的外部变化或数据支撑
- [ ] 成功指标可量化（数字 + 时间范围）且有明确测量方法
- [ ] User Stories 使用标准格式（As a... I want to... So that...）
- [ ] 每个 User Story 有 ≥ 1 个 Given-When-Then 验收标准
- [ ] 功能范围有明确的 P0/P1/P2 优先级
- [ ] 依赖和风险已列出
- [ ] 所有推断已标注 [假设]，自动填充已标注 [默认]
- [ ] 后续推荐已列出（基于 PRD 内容的上下文感知推荐）
- [ ] **User Journey / 使用流程中每个步骤都在 In Scope 有对应功能**
- [ ] **输出中无 Magic Step**（对照 `references/quality-gates-shared.md` 触发词表检查）
- [ ] **如有触发词，【技术实现猜想】已补充**
- [ ] **每个风险项的缓解措施 ≥ 1 句可执行描述**（不是"持续监控"）

更完整的质量检查标准见 `references/quality-checklist.md`。
实际 PRD 案例参考见 `references/examples.md`。

## 后续推荐

根据 PRD 内容推荐下一步行动：

| 场景 | 推荐 Skill |
|------|-----------|
| 需要竞品参考 | pm-comp |
| 需要优先级排序 | pm-rice |
| 需要可视化 | pm-wireframe → pm-prototype |
| 需要技术方案 | pm-tech-spec |
| 需要决策记录 | pm-decision |
