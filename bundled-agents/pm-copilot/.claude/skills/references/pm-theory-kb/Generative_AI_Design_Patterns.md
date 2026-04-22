# Generative AI Design Patterns - 核心模型与方法论

全书 32 个设计模式提炼为 8 个跨领域可迁移的核心模型。

---

### 1. RAG 进阶谱系

**定义**：将知识注入 LLM 的五级成熟度模型，从最基础的关键词检索到最复杂的迭代深度推理，每升一级解决上一级的核心局限。

| 级别 | 模式 | 核心能力 |
|------|------|----------|
| L1 | Basic RAG | 关键词检索 + 文档分块 + BM25 |
| L2 | Semantic Indexing | Embedding 向量检索 + 语义分块 |
| L3 | Index-Aware Retrieval | HyDE + Query Expansion + Hybrid Search + GraphRAG |
| L4 | Node Postprocessing + Trustworthy Generation | Reranking + 引用 + CRAG + Self-RAG |
| L5 | Deep Search | 迭代式"检索-思考-生成"循环 |

**适用场景**：任何需要让 LLM 使用外部知识的应用——从简单的文档问答到复杂的多跳推理研究助手。选择级别取决于查询复杂度、风险等级和可用工程资源。

> 关键决策：小文档（可放入 Context Window）直接全文注入 + Prompt Caching，可能比构建 RAG 管道更简单。

**关联章节**：[Ch03.md](./Ch03.md)、[Ch04.md](./Ch04.md)

---

### 2. 模型能力扩展光谱

**定义**：四种从轻量到重量级的方法，让基础模型掌握其未经训练的新任务。按数据需求和实现复杂度递增排列。

| 模式 | 机制 | 数据需求 | 成本 |
|------|------|----------|------|
| Chain of Thought | 提示工程（"think step-by-step"） | 零到少量 | 极低 |
| Tree of Thoughts | 树搜索 + 多次 LLM 调用 | 无额外数据 | 中等 |
| Adapter Tuning | 参数高效微调（LoRA/QLoRA） | 数百到数千示例 | 中等 |
| Evol-Instruct | 指令微调 + 数据演化 | 数千到数万示例 | 高 |

**适用场景**：当基础模型在特定任务上表现不足时，从最轻量的 CoT 开始尝试，逐步升级直到找到成本与效果的平衡点。重要警告：Adapter Tuning 仅适用于调整输出风格/格式，不适用于教授新术语或新知识。

> 核心原则：先用最轻量的方案。这些模式可组合使用——如用 Evol-Instruct 构建数据集后用 LoRA 训练，再用 ToT 推理。

**关联章节**：[Ch05.md](./Ch05.md)

---

### 3. LLM-as-Judge（LLM 评审）

**定义**：利用 LLM 本身作为输出质量评审者，替代昂贵的人工评估。通过设计校准评分标准（rubric），让 LLM 按 1-5 分逐项打分并附简要理由。三种实现路径：Prompting（直接让 LLM 打分）、ML（用 LLM 评分训练分类模型）、Fine-tuning（用专家标注训练模拟模型）。

**适用场景**：任何需要系统化评估 LLM 输出质量的场景——产品迭代、A/B 测试、内容审核。尤其适合需要高频评估但人工成本不可承受的生产环境。

> 三大偏见及对策：(1) 不一致性 → 粗粒度评分 + 多次取平均；(2) 宽容偏见 → 让 LLM 比较两个候选而非打绝对分；(3) 自我偏见 → 用不同 LLM 做评估与生成。

**关联章节**：[Ch06.md](./Ch06.md)

---

### 4. Reflection（反思模式）

**定义**：在 LLM 生成初始响应后，插入"评估-批评-修正"循环。评估器生成详细批评（critique），再将批评转化为修改指令发送给 LLM 生成改进版本。实践中**恰好一轮反思**是最常见的有效变体。

**适用场景**：代码生成（编译器/沙箱可作为评估工具）、内容创作、数据分析等容许额外延迟的场景。实时聊天机器人等低延迟场景慎用。

> 核心要点：用不同 LLM 进行评估以避免自我偏见；可结合 beam search——并行生成多个候选，每轮评估后剪枝，最终择优。

**关联章节**：[Ch06.md](./Ch06.md)

---

### 5. Agent 行动能力层次

**定义**：使 LLM 从"说"跨越到"做"的三层递进模型。每层扩展 Agent 的能力边界，但安全关切和工程复杂度也随之递增。

| 层级 | 模式 | 核心能力 | 安全要求 |
|------|------|----------|----------|
| L1 | Tool Calling | 调用外部 API（函数名 + JSON 参数） | Prompt Injection 防御 |
| L2 | Code Execution | 生成 DSL 代码并在沙箱中执行 | 沙箱隔离 + 资源限制 |
| L3 | Multiagent | 多 Agent 认知分工协作 | 一致性维护 + 错误累积控制 |

**适用场景**：任何需要 LLM 与外部系统交互的应用。从 L1 开始，仅在确实需要时升级。

> 务实建议：如果通过 UX 设计、Human-in-the-loop 或管理用户预期就能让单 Agent 解决问题，就不要引入 Multiagent 的复杂性。2025 年研究显示 Multiagent 系统 40%-80% 任务会失败。

**关联章节**：[Ch07.md](./Ch07.md)

---

### 6. Prompt Optimization（自动化 Prompt 管理）

**定义**：通过框架自动优化 prompt，替代手动试错的 prompt 工程。四个组件：Pipeline（步骤链）、Dataset（评估数据集）、Evaluator（自动评分器，可用 LLM-as-Judge）、Optimizer（生成变体并选出最优）。以 DSPy 框架为代表。

**适用场景**：当 prompt 数量多、基础模型频繁更新、或需要系统化维护 prompt 时。相比将 prompt 外部化到配置文件的简单方案，Prompt Optimization 的代码中不含 prompt 文本，框架根据输入输出描述自动生成和优化。

> 与简单 prompt 库的区别：Prompt Optimization 是 prompt 管理的更全面替代方案，而非简单补充。当数据集足够大时，还可扩展为对 LLM 进行 fine-tuning。

**关联章节**：[Ch06.md](./Ch06.md)

---

### 7. 安全护栏梯度

**定义**：由简到繁的四层风险控制模型。每层在安全性、灵活性和工程复杂度之间做不同取舍。

| 层级 | 模式 | 机制 | 适用场景 |
|------|------|------|----------|
| L1 | Template Generation | 预生成 + 人工审核模板 | 低风险、模板组合可控 |
| L2 | Assembled Reformat | 低风险组装 + LLM 改写 | 大规模静态内容 |
| L3 | Self-Check | Logprobs 幻觉检测 | 结构化输出、数据提取 |
| L4 | Guardrails | 输入/输出护栏层 | 面向公众的高风险应用 |

**适用场景**：任何面向终端用户的 GenAI 应用。遵循**最小防护原则**——先用最简单的模式解决核心风险，仅在必要时逐步升级。

> 关键洞察：给模型一个"退路"（如允许返回 "I don't know" 或使用 union 类型 `float | Literal["Unknown"]`）往往比构建复杂护栏更有效。

**关联章节**：[Ch09.md](./Ch09.md)

---

### 8. 可组合的 Agentic 工作流（Composable Architecture）

**定义**：将多个设计模式组合为生产级 Agent 应用的五层架构模型。核心原则是用"简单、可组合的模式"而非"复杂框架"构建系统（Unix 哲学）。

| 层级 | 职责 | 关键模式 |
|------|------|----------|
| Agent 模式层 | 每步由独立 Agent 执行 | CoT、RAG、Tool Calling、Reflection |
| 编排层 | async/await 控制流程 | Grammar、Prompt Caching |
| 治理安全层 | 输入/输出校验 | Guardrails、LLM-as-Judge |
| 学习管道 | 无感收集人类反馈 | Content Optimization、Adapter Tuning、Prompt Optimization |
| 数据计划 | 合成训练数据补充 | Evol-Instruct、Self-Check |

**适用场景**：任何需要将多个 GenAI 模式整合为端到端生产系统的场景。关键设计决策包括：LLM 三级分层（BEST/DEFAULT/SMALL）、Guardrail 并行化（零额外延迟）、隐式反馈收集。

> 核心启示：成功的 Agent 应用不需要复杂的框架，而是需要正确的模式选择、合理的架构分层、系统化的数据反馈闭环。

**关联章节**：[Ch10.md](./Ch10.md)
