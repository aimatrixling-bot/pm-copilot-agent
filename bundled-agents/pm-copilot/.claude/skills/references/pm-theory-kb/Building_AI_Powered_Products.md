# Building AI-Powered Products — 核心模型与框架

> 从全书 8 章中提炼的 8 个核心模型/框架，按知识依赖关系排列。

---

## 1. AI 产品开发生命周期（AIPDL）

**定义**：专为 AI 驱动产品设计的五阶段迭代开发框架——**Ideation**（构思）→ **Opportunity**（机会评估）→ **Concept and Prototype**（概念与原型）→ **Testing and Analysis**（测试与分析）→ **Rollout**（上线部署）。每个阶段都可能被反复 revisit，直到产品找到 market fit。

**适用场景**：任何 AI 产品从 0 到 1 或从 1 到 n 的开发规划。尤其适合需要同时处理技术不确定性（模型性能）和市场不确定性的项目。

**关联章节**：[Ch02](./Ch02.md)

---

## 2. Product-Market Fit 三维验证模型（PMF Triad）

**定义**：AI 产品的 PMF 必须同时满足三个标准——**Business Viability**（商业可行性：市场规模、ROI、合规）、**Technical Feasibility**（技术可行性：数据、算力、人才）和 **User Desirability**（用户渴望度：付费意愿、痛点验证）。缺一不可。

**适用场景**：在 Opportunity 阶段进行 Go/No-Go 决策。任何需要判断"这个 AI 特性值不值得做"的场景。

**关联章节**：[Ch02](./Ch02.md)

---

## 3. Trade Space 六步校准框架

**定义**：AI PM 日常面临的多维度权衡不是简单的 A/B 选择，而是在一个**多维 Trade Space**中精确校准。六步流程：识别关键因素 → 排列优先级 → 映射相互依赖关系 → 可视化 Trade Space → 模拟不同决策场景 → 持续迭代调整。

**六组核心权衡**：Accuracy vs. Speed、Complexity vs. Simplicity、Data Quality vs. Quantity、Generalization vs. Specificity、Privacy vs. Personalization、Explainability vs. Performance。

**适用场景**：项目规划、技术选型、产品决策。每次需要在精度、速度、成本、隐私等维度之间做取舍时。

**关联章节**：[Ch03](./Ch03.md)、[Ch05](./Ch05.md)

---

## 4. Build vs. Buy 六维决策矩阵

**定义**：在"自建 AI 能力"与"采购第三方方案"之间做战略决策的框架。六个评估维度：Core Competency（AI 是否是产品核心）、Resources & Expertise（人才与基础设施）、Time to Market（上市速度）、Long-term Strategy（长期战略定位）、Cost（成本结构）、Risk & Uncertainty（风险管理）。

**关键洞察**：最佳实践往往是 **Hybrid Approach**——核心 AI 组件自建，非核心能力采购第三方方案。

**适用场景**：技术战略规划、供应商评估、资源分配决策。

**关联章节**：[Ch03](./Ch03.md)、[Ch05](./Ch05.md)

---

## 5. AI 产品度量混合体（AI Product Metric Blend）

**定义**：评估 AI 产品成功的三维指标框架，拒绝单一指标崇拜：
- **Product Health Metrics**：Engagement、Satisfaction (NPS)、Adoption、Conversion、Retention、Revenue
- **System Health Metrics**：Uptime、Latency、Scalability、Error Rate
- **AI Proxy Metrics**：Accuracy、Precision、Recall、ROC Curve、Confusion Matrix

**关键设计**：每个 OKR 必须包含三类指标桶中的各一个指标，并设置 **North Star**（聚焦成功指标）+ **Guardrail**（护栏指标，防止"赢了指标、输了体验"）。

**适用场景**：产品目标设定、OKR 制定、A/B 测试评估、模型升级决策。

**关联章节**：[Ch06](./Ch06.md)

---

## 6. Precision-Recall 决策框架

**定义**：基于混淆矩阵（Confusion Matrix）的四种结果（TP/TN/FP/FN），在 **Precision**（精确率，减少误报/Type I Error）和 **Recall**（召回率，减少漏报/Type II Error）之间做业务驱动的权衡。高 Precision 适合误报代价高的场景（如垃圾邮件分类），高 Recall 适合漏报代价高的场景（如医疗诊断）。

**适用场景**：模型评估、阈值设定、产品需求定义（明确"宁可错杀不可放过"还是反过来）。

**关联章节**：[Ch06](./Ch06.md)

---

## 7. AI Agent 设计框架

**定义**：从"对话工具"到"自主行动者"的产品设计框架，包含五个关键决策维度：
1. **Agent 类型**：Task-Specific（专精型）vs. General-Purpose（通用型）
2. **激活方式**：Proactive（主动式）vs. Reactive（响应式）
3. **自主程度**：低（建议）→ 中（许可执行）→ 高（自主行动）
4. **反馈机制**：Explicit（显式）+ Implicit（隐式）+ System-Driven（系统驱动）
5. **交互模式**：Side Panel / Floating Bubble / Chat Interface / Integrated UI / Pop-up / Collaborative Browser

**关键区分**：AI Agent ≠ Chatbot。Agent 的核心特征是 **Autonomy**（自主性）和 **Goal-driven Action**（目标驱动行动）。

**适用场景**：设计任何需要"主动执行任务"而非"被动回答问题"的 AI 产品。

**关联章节**：[Ch08](./Ch08.md)

---

## 8. RICE+AI 特性优先级框架

**定义**：在经典 RICE 框架（Reach × Impact × Confidence / Effort）基础上，新增 **AI Investment** 参数，代表训练或集成模型的隐性成本（数据收集、算力资源、模型维护），形成 **R × I × C / (E × A)** 的扩展公式。帮助 PM 在 AI 特性优先级排序时纳入模型相关的额外成本考量。

**适用场景**：产品路线图规划、Feature 优先级排序、资源分配决策。

**关联章节**：[Ch02](./Ch02.md)

---

## 模型关系图谱

```
AIPDL (开发框架)
├── PMF Triad (机会评估门控)
│   └── Build vs. Buy (技术可行性子决策)
├── Trade Space (全程权衡校准)
├── RICE+AI (特性优先级排序)
├── Metric Blend (目标设定与度量)
│   └── Precision-Recall (AI Proxy 子框架)
└── Agent Design (新形态产品设计)
```
