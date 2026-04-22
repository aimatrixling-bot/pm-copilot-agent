# The Product Book - 核心模型与框架

> 从全书提炼的核心方法论、模型和思维框架。这些是本书最有价值的可迁移知识。

---

### 1. Product Triangle（产品三角）

**定义**：PM 处于 Engineering（产品开发）、Design（设计）和 Marketing（产品营销）三个核心领域的交汇点。PM 不是任何一个领域的专家，而是能在这三个领域之间有效翻译和协调的通才。在产品开发的不同阶段，PM 需要动态调整侧重——规划阶段偏商业与用户洞察，设计阶段偏 Design 协作，构建阶段偏 Engineering 协作，上市阶段偏 Marketing。

**适用场景**：理解 PM 角色定位、跨职能沟通策略、判断当前阶段应该与谁深度协作

**关联章节**：[Ch01](./Ch01.md)

---

### 2. Product-Development Life Cycle（产品开发生命周期）

**定义**：产品持续经历的五个概念阶段：(1) 发现并规划正确的机会；(2) 设计解决方案；(3) 构建解决方案；(4) 推向市场；(5) 评估效果。这是一个持续循环而非线性流程——评估结果会触发新一轮机会发现。PM 在第一阶段主导，后续阶段逐步转为协作与贡献角色。

**适用场景**：规划产品路线图、理解当前所处阶段、团队协作节奏安排

**关联章节**：[Ch01](./Ch01.md)、[Ch09](./Ch09.md)

---

### 3. Golden Circle + 5C Analysis（战略分析框架）

**定义**：Golden Circle（Why → How → What）要求从"公司为什么存在"出发，逐层推导到具体产品决策。5C Analysis（Company、Customers、Competitors、Collaborators、Climate）提供系统化的公司战略上下文扫描方法。两者结合，帮助 PM 在"可能性的海洋"中找到与公司战略一致的产品方向。

**适用场景**：新入职快速理解公司、产品方向论证、战略对齐会议

**关联章节**：[Ch02](./Ch02.md)

---

### 4. Opinion vs. Fact（假设驱动决策）

**定义**：PM 的所有想法都是 opinions（假设）而非 facts（事实）。必须用科学方法将 opinions 转化为可验证的 Opportunity Hypothesis，通过定量数据（Metrics、Segmentation、Cohort、Funnel、AARRR）和定性洞察（Bugs、Intuition、Vision、Team、R&D、Competition）交叉验证，最终用实验而非辩论来决定产品方向。

**适用场景**：需求优先级争论、功能提案评审、避免"HIPO"（Highest Paid Person's Opinion）陷阱

**关联章节**：[Ch03](./Ch03.md)

---

### 5. 三层验证模型（Internal → External → Experimental）

**定义**：假设验证分为三个递进层次：(1) Internal Validation——内部团队用 SWOT 分析和战略一致性检验，成本低但偏见风险高；(2) External Validation——通过 Customer Interviews、Surveys 获取外部视角，成本中等但容易遭遇"说一套做一套"；(3) Experimental Validation——用 Simple MVP（Preorder / Concierge / Wizard of Oz / Fake Door）进行真实市场测试，成本最高但信号最可靠。三层递进，避免在未通过低阶验证时浪费高阶资源。

**适用场景**：任何新产品/功能想法的验证、决定投入多少资源前的前置评估

**关联章节**：[Ch04](./Ch04.md)

---

### 6. Working Backwards + PRD（逆向工作法与产品需求文档）

**定义**：Working Backwards 源自 Amazon 的产品方法论——先写 Press Release（面向客户的最终描述）和 Product Review（客户 FAQ），再倒推需要构建什么。PRD（Product Requirements Document）是"Living Document"——活的文档，随理解加深持续更新，核心组件包括 User Scenarios（用户场景叙事）而非干巴巴的功能列表。Plussing（Walt Disney 哲学）要求每次迭代都要"超越期望"而非仅仅满足需求。

**适用场景**：新功能/产品规划、需求文档撰写、避免"功能工厂"陷阱

**关联章节**：[Ch05](./Ch05.md)

---

### 7. Agile + Kanban 混合开发框架

**定义**：Agile（Scrum）提供固定节奏的迭代框架（Sprint、Stand-up、Planning、Review、Retrospective），Kanban 提供可视化工作流和 WIP 限制（源自丰田），两者可融合为 Scrum-ban。PM 在其中的核心职责不是管理工程师，而是通过 User Stories、Acceptance Criteria 和优先级排序来提供方向，同时管理 Scope Creep、处理 Technical Debt（建议预留 15-20% 容量）。

**适用场景**：与工程团队协作、Sprint 规划、远程/外包团队管理

**关联章节**：[Ch07](./Ch07.md)

---

### 8. GTM 三阶段模型（产品上市执行框架）

**定义**：Go-to-Market 分为三个阶段：(1) Pre-Launch（Beta Testing、Launch Timing、内部对齐）；(2) Launch（选择合适的 Launch Type——Soft/Full/Rolling，准备 Launch Assets）；(3) Post-Launch（监控 Customer Life Cycle 从认知到倡导的完整循环）。Product Messaging 是 GTM 的核心——用 DRI（Differentiator/Relevancy/Insight）白板法提炼产品信息，确保每个受众都能理解"为什么这个产品对我重要"。

**适用场景**：新产品/功能发布、上市策略制定、跨职能发布协调

**关联章节**：[Ch08](./Ch08.md)

---

## 模型关系图谱

```
Product Triangle（PM 角色定位）
       │
       ▼
Product-Development Life Cycle（五阶段循环）
  │         │         │         │         │
  ▼         ▼         ▼         ▼         ▼
发现机会    设计方案    构建方案    推向市场    评估效果
  │         │         │         │         │
Golden    User-     Agile +    GTM 三    Postmortem
Circle    Centered   Kanban     阶段      +
5C       Design                DRI       三策略桶
  │         │         │         │         │
  └─────┬───┘         │         │         │
        ▼             │         │
  Opinion vs. Fact     │         │
  (假设驱动)            │         │
        │             │         │
        ▼             │         │
  三层验证模型          │         │
  (Internal→External→  │         │
   Experimental)       │         │
        │             │         │
        ▼             │         │
  Working Backwards ───┘         │
  + PRD + Plussing               │
                                 │
  评估结果 ──────────────────────┘
  触发新一轮机会发现
```

**核心逻辑链**：PM 通过 Product Triangle 定位自己 → 在 Life Cycle 的"发现机会"阶段用 Golden Circle + 5C 建立战略上下文 → 用 Opinion vs. Fact 心态形成 Opportunity Hypothesis → 通过三层验证模型递进验证 → 用 Working Backwards 方法将验证通过的假设转化为 PRD → 与 Design（User-Centered）和 Engineering（Agile/Kanban）协作构建 → 用 GTM 三阶段模型推向市场 → 通过 Postmortem 复盘 → 评估结果触发新一轮循环。
