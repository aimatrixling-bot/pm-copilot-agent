# The AI Product Playbook - 核心模型与框架

全书 12 章内容提炼为 7 个跨领域可迁移的核心模型。

---

### 1. AI PM 三角色模型

**定义**：AI 产品管理的三种角色分工，分别聚焦于用户体验（AI-Experiences PM）、技术基础设施（AI-Builder PM）和工作流增强（AI-Enhanced PM）。三者没有高低之分，而是在不同维度上深入——AI-Experiences PM 是"通才"角色，AI-Builder PM 需要最深的 技术栈理解，AI-Enhanced PM 以 Adaptability 为定义性能力。

| 维度 | AI-Experiences PM | AI-Builder PM | AI-Enhanced PM |
|------|-------------------|---------------|----------------|
| 核心使命 | 构建用户可感知的 AI 产品体验 | 构建组织级 AI 平台与基础设施 | 用 AI 增强 PM 自身工作流 |
| 用户 | 外部终端用户 | 内部开发者和数据团队 | PM 自己和产品团队 |
| Expert 技能 | 无单项 Expert（通才） | AI Infrastructure, MLOps, GenAI Evals | Data Analysis, Adaptability |

**适用场景**：任何组织在构建 AI 产品团队时，都需要明确这三种角色的分工。小团队可能一人身兼多角，但角色意识能避免职责模糊。

> 核心启示：AI-Enhanced PM 的本质是"AI 的战略消费者"——不是造 AI，而是用 AI；不是个人效率工具，而是团队级的力量倍增器。

**关联章节**：[Ch05.md](./Ch05.md)、[Ch06.md](./Ch06.md)、[Ch07.md](./Ch07.md)

---

### 2. AI Lifecycle（AI 生命周期）

**定义**：AI 产品从问题定义到持续运维的八阶段端到端流程：问题定义 → 数据收集 → 数据预处理 → 特征工程 → 模型选择与训练 → 模型评估与调优 → 部署与监控 → 再训练与维护。这是一个**持续闭环**而非线性流水线。

PM 在各阶段的参与深度不同：主导问题定义，深度参与特征工程和部署监控，其他阶段以监督和协作为主。

**适用场景**：任何 AI 产品项目都需要遵循此生命周期。PM 的核心价值在于：(1) 在起点和终点提供关键输入；(2) 将业务问题翻译为 AI 问题；(3) 将模型洞察翻译为产品决策。

> 核心启示：PM 不需要亲手写模型，但必须理解全流程以发挥"翻译者"和"战略引导者"的不可替代价值。

**关联章节**：[Ch04.md](./Ch04.md)

---

### 3. Precision-Recall 决策框架

**定义**：AI 分类模型评估的核心决策工具。本质问题是"哪种错误的代价更高"——False Positive（误报）成本高时优先 Precision（如垃圾邮件过滤），False Negative（漏报）成本高时优先 Recall（如医疗诊断、欺诈检测）。Accuracy 在数据不平衡时具有欺骗性。

| 场景 | 优先指标 | 原因 |
|------|----------|------|
| 垃圾邮件过滤 | High Precision | 误判正常邮件为垃圾的代价极高 |
| 医疗诊断 / 欺诈检测 | High Recall | 漏诊/漏报的代价极高 |
| 搜索引擎 | 取决于定位 | Precision 高→精准但少；Recall 高→全面但有噪声 |

**适用场景**：任何涉及分类模型的 AI 产品上线前，PM 必须基于业务场景做出 Precision vs. Recall 的取舍决策。这是**产品决策**，而非纯技术决策。

**关联章节**：[Ch02.md](./Ch02.md)、[Ch03.md](./Ch03.md)、[Ch09.md](./Ch09.md)

---

### 4. AI 机会识别框架

**定义**：系统性地从用户问题出发识别 AI 价值机会的五步方法：(1) 四类适合 AI 的问题领域（重复任务、模式识别、个性化、数据分析瓶颈）；(2) 六大 AI/ML 能力匹配（Classification、Clustering、Generation、Recommendation、Anomaly Detection、NLP）；(3) 在 User Journey Map 每一步叠加 AI Lens；(4) 增强现有功能 > 构建全新功能；(5) 五种结构化构思技术（Storming、Scenario Planning、Data Mapping、Capability Alignment、Reverse Engineering）。

**适用场景**：AI PM 日常工作中最常使用的框架。核心原则是"问题优先，技术其次"——AI 是解决问题的工具，不是目的本身。

> 核心启示：真正有影响力的 AI 产品功能通常是多种 AI 能力的分层组合（如智能 Chatbot = NLP + Classification + Generation + Sentiment Analysis），而非单点技术。

**关联章节**：[Ch08.md](./Ch08.md)

---

### 5. AI 项目 ROI 度量体系

**定义**：将模型技术性能与业务结果连接的双层度量框架。第一层是模型性能指标（Precision、Recall、F1、Accuracy、Latency、Throughput、Model Drift），第二层是业务结果指标（转化率、留存率、收入、成本节约）。两层之间需要 Baseline、A/B Testing 和端到端案例串联。

核心流程：定义业务目标 → 建立基线 → 选择指标（基于错误成本分析） → 训练与评估 → A/B Testing → ROI 计算 → 持续监控。

**适用场景**：任何需要向利益相关者展示 AI 投资回报的场景。PM 的核心角色不是计算公式，而是搭建技术指标与业务价值之间的桥梁。

> 核心启示：没有清晰的基线，就无法证明 AI 功能的增量价值。AI 功能的上线不是项目的终点，而是持续运营生命周期的起点。

**关联章节**：[Ch09.md](./Ch09.md)

---

### 6. MLOps 生产化框架

**定义**：将 AI 模型从实验室可靠、持续地运行在生产环境中的六阶段实践体系：数据工程 → 模型开发 → 模型验证与测试 → 模型部署 → 模型监控 → 模型再训练与更新。三大支柱为 CI/CD、IaC 和跨职能协作。

PM 在 MLOps 中的关键职责：定义验收标准（如最低 Recall 85%）、设计上线计划、定义监控 KPI 和告警阈值、确认 Rollback 机制、推动公平性测试、充当跨团队翻译者。

**适用场景**：任何需要将 AI 模型部署到生产环境的项目。核心认知转变是：AI 模型的生命周期在上线后才真正开始。

> 核心启示：好的模型如果不能以有用且直观的方式融入产品，再好也毫无价值。部署是起点而非终点。

**关联章节**：[Ch10.md](./Ch10.md)

---

### 7. Responsible AI 伦理框架

**定义**：从开发前到部署后的全生命周期 AI 伦理保障体系。五种偏见来源（Sample Bias、Prejudice Bias、Measurement Bias、Exclusion Bias、Algorithmic Bias）+ 六大伦理原则（Fairness、Transparency、Accountability、Privacy、Beneficence、Non-Maleficence）+ PM 十步实操清单（从开发前伦理审查到影响评估）。

特别值得关注的是 Proxy Features 问题：即使移除了受保护类别信息（如种族、性别），模型仍可能通过邮政编码等代理特征学到歧视性关联。

**适用场景**：任何面向终端用户的 AI 产品，尤其是涉及贷款审批、招聘推荐、内容分发、医疗诊断等高风险场景。Responsible AI 是核心业务诉求，而非可选附加项。

> 核心启示：偏见会随数据变化而随时间涌现——偏见检测和缓解不是一次性任务，而是持续过程。PM 是连接数据科学、伦理、法律和工程团队的桥梁。

**关联章节**：[Ch11.md](./Ch11.md)
