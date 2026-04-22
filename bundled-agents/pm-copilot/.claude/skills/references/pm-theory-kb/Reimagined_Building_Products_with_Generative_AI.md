# Reimagined: Building Products with Generative AI — 核心模型提炼

> **全书精华**：AI 产品的成功仍然回归产品本质——解决真实用户问题，而非追逐技术热点。从问题识别到护城河建设，AI PM 需要掌握一套完整的方法论，同时建立 AI Literacy。核心理念：**会用 AI 的 PM 会取代不会用 AI 的 PM。**

---

## 模型 1: AI 产品全生命周期框架

**定义**: 从问题识别到护城河建设的 AI 产品完整开发路径，每个阶段都有独特的 AI 特殊考量。

| 阶段 | 核心任务 | AI 特殊考量 |
|------|----------|-------------|
| **问题识别** | 客户细分 + JTBD + 假设验证 | 技术优先的诱惑极强，需刻意回归问题本质 |
| **MVP 构建** | 快速验证核心假设 | LLM 选型（API-First → In-House）、数据需求、期望管理 |
| **产品设计** | AI-UX 交互模式 + 信任框架 | 非确定性输出、Prompt 设计、Responsible AI |
| **增长度量** | North Star + GTM 策略 | AI 特有度量维度（质量/新颖性/多样性）、定价困局 |
| **护城河** | 可持续竞争优势 | 数据飞轮、垂直工作流、Systems of Intelligence |

**适用场景**: AI 产品从 0 到 1 的全流程规划、AI PM 能力体系建设。

**关联章节**: Ch06.md、Ch07.md、Ch08.md、Ch09.md

---

## 模型 2: 问题优先 vs 技术优先决策框架

**定义**: AI 产品问题识别阶段的核心决策工具，基于 JTBD（Jobs-to-Be-Done）方法论，强调先定问题再选技术。

**三层论证结构**:
1. **找对人**: 五种客户 Segmentation 方法（Needs-Based、Demographic、Job Role、Industry、Psychographic）+ 六维评估（Market Size、Resonance、WTP、Vision Alignment、Reachability、Trust Readiness）
2. **找对问题**: JTBD 框架 + 三种 Job 类型（Functional / Emotional / Social）+ Opportunity Statement 公式
3. **验证假设**: 五维 Assumption Testing（Desirability / Feasibility / Viability / Scalability / Ethicality）

**AI Use Case 评估矩阵**（Barak Turovsky）:

| 维度 | 问题 | 评估标准 |
|------|------|----------|
| **Accuracy** | AI 输出需要多精确？ | 高精度场景（医疗/法律）vs 创意场景（营销文案） |
| **Fluency** | AI 输出需要多自然？ | 对话式场景要求高，后台处理要求低 |
| **Stakes** | 错误的代价有多大？ | 低风险可快速试错，高风险需 Human-in-the-Loop |

**适用场景**: AI 产品方向选择、Use Case 优先级排序、技术 vs 产品的资源分配决策。

**关联章节**: [Ch06.md](./Ch06.md)

---

## 模型 3: AI MVP 构建十原则 + LLM 选型策略

**定义**: AI 产品 MVP 阶段的行动指南，涵盖从团队协作到技术选型的完整方法论。

**十原则速查**:
1. Progress over Technology — 不被基础设施拖住
2. Start with a User-Centric Niche — 从细分切入
3. Define North Star Upfront — 提前定义成功指标
4. Make It a Team Sport — 跨职能团队参与
5. Iterate on Prompt Evaluation — Prompt 评估常规化
6. Seek Quick User Feedback — 真实用户真实数据
7. Iterate, Iterate, Iterate — 持续迭代
8. Set Milestones — OKR 驱动决策
9. Celebrate and Learn Together — 组织学习
10. Stay Flexible and Dream Big — 不被当前技术束缚

**LLM 选型渐进路径**:
```
MVP 阶段: API-First（GPT-4/Claude API）→ 快速验证假设
PMF 之后: In-House Model → 控制数据安全、可靠性、单位经济
关键考量: 业务目标、合规要求、技术人才、产品生命周期
```

**适用场景**: AI 产品 MVP 规划、LLM 技术选型、AI 团队协作模式设计。

**关联章节**: [Ch07.md](./Ch07.md)

---

## 模型 4: AI 产品设计原则与 UX 交互模式

**定义**: 生成式 AI 产品的独特设计考量，涵盖产品原则、UX 交互模式和 Prompt 设计三大板块。

**AI 产品七条核心原则**:
1. 用户控制力（User Control）— 用户应能覆盖 AI 决策
2. 透明度（Transparency）— 明确告知 AI 能力边界
3. 可反馈性（Feedback Loop）— 持续收集用户反馈优化模型
4. 个性化（Personalization）— 基于用户数据定制输出
5. 可靠性（Reliability）— 确保输出质量和一致性
6. 可访问性（Accessibility）— 降低 AI 使用门槛
7. 负责任（Responsibility）— 内嵌伦理考量

**六大 AI-UX 交互模式**:
| 模式 | 描述 | 典型产品 |
|------|------|----------|
| **Copilot** | AI 作为副驾驶，用户主导 | GitHub Copilot |
| **Autopilot** | AI 全自动执行，用户监督 | 自动化报告生成 |
| **Chat/Conversational** | 对话式交互 | ChatGPT、Pi |
| **Embedding** | AI 无缝嵌入现有工作流 | Notion AI、Figma AI |
| **Generative UI** | AI 动态生成界面 | Vercel v0 |
| **Agent** | AI 自主完成多步任务 | AutoGPT |

**适用场景**: AI 产品 UX 设计、交互模式选择、产品设计评审。

**关联章节**: [Ch07.md](./Ch07.md)

---

## 模型 5: AI 产品度量体系

**定义**: 面向生成式 AI 产品的完整度量框架，在传统 North Star 体系上叠加 AI 特有维度。

**North Star 七特征**: 客户价值、战略反映、预测性、可行动、可理解、可量化、超越虚荣指标。

**三种价值游戏**（Amplitude）:

| 价值类型 | 核心问题 | AI 产品示例 |
|---------|---------|------------|
| **Attention** | 用户花多少时间？ | ChatGPT 累计会话时长 |
| **Transaction** | 完成多少交易？ | Midjourney 付费生成次数 |
| **Productivity** | 多高效完成任务？ | Copilot 代码采纳率 |

**AI 特有度量五维度**:
1. 输出复杂性 — "有用性"的主观性需特殊处理
2. 质量、新颖性与多样性 — 纳入路标指标
3. 可解释性与公平性 — Responsible AI 核心
4. 持续评估 — 模型迭代需指标同步
5. 用户交互体验 — 情感分析作为护栏

**适用场景**: AI 产品指标体系设计、North Star 定义、OKR 制定。

**关联章节**: [Ch08.md](./Ch08.md)

---

## 模型 6: AI 产品 GTM 与增长策略选择

**定义**: 生成式 AI 产品的 Go-to-Market 框架和增长引擎选择指南。

**GTM 六原则**:
1. 建立清晰漏斗（MQL → SQL → Opportunity → ARR）
2. GTM 是全员责任（Sales + Marketing + Product 协同）
3. 聚焦客户教育与期望管理
4. 社区即 GTM（Midjourney Discord 模式）
5. 识别 inbound → outbound 转换节点
6. 定价对齐客户价值（Value-based > Token-based > Seat-based）

**三种增长引擎选择**:

| 引擎 | 核心逻辑 | 适用条件 | AI 产品案例 |
|------|----------|----------|------------|
| **PLG** | 产品驱动增长，用户自传播 | 低门槛、高频使用、即时价值 | ChatGPT、Midjourney |
| **MLG** | 营销驱动增长，内容获客 | 需要教育市场、高 ACoC 可接受 | Copy.ai、Synthesia |
| **SLG** | 销售驱动增长，大客户深耕 | 企业级产品、高 ACV、长销售周期 | Harvey AI |

**AI 产品定价困局**: 成本结构倒挂（Copilot 月费 $10 但 Microsoft 每用户月亏 $20），Value-based 定价是早期胜出方向。

**适用场景**: AI 产品 GTM 策略制定、增长引擎选择、定价模型设计。

**关联章节**: [Ch08.md](./Ch08.md)

---

## 模型 7: AI 护城河分析框架

**定义**: 基于 Hamilton Helmer "7 Powers" 框架的 AI 公司护城河分析工具，通过红蓝对抗呈现正反观点。

**7 Powers 在 AI 领域的映射**:

| 护城河 | AI 领域体现 | 防御强度 |
|--------|------------|----------|
| **规模经济** | 模型越大，成本越低、性能越好 | 高（基础层） |
| **网络效应** | 用户越多，数据越多，模型越好 | 中高（应用层） |
| **反定位** | 采取与巨头不同的商业模式 | 中 |
| **切换成本** | 深度集成的数据和流程迁移成本 | 中高（B2B） |
| **品牌** | AI 品牌承载的信任与期望 | 中 |
| **独占资源** | 行业专属的专有数据集 | 高（垂直领域） |
| **流程优势** | 高效的运营和开发流程 | 中 |

**垂直领域制胜公式**: **Workflow + Model** — 拥有端到端的行业工作流，叠加专有数据和模型，构建竞品无法渗透的深度解决方案。

**适用场景**: AI 产品竞争策略、投资评估、长期护城河规划。

**关联章节**: [Ch09.md](./Ch09.md)

---

## 模型 8: PM 在 AI 时代的能力进化模型

**定义**: AI 时代 PM 所需的能力结构，分为软技能放大和技术素养建立两个维度。

**核心判断**: AI 不会取代 PM，但会用 AI 的 PM 会取代不会用 AI 的 PM。

**能力结构**:

| 维度 | 能力项 | AI 的影响 |
|------|--------|----------|
| **软技能放大** | 战略思维、创造力、好奇心、沟通叙事、影响力、协作、伦理 | AI 提供数据洞察和工具，但核心判断力仍是人类护城河 |
| **技术素养** | 数据分析、ML 基础、Python、数据标注、模型评估、API 交互、云计算、Responsible AI、生成模型理解、Prompt Engineering | Dr. Marily Nika: "每个 PM 都将成为 AI PM" |

**三种 AI 协作认知框架**:
- **Enabler**: AI 作为工具，辅助 PM 完成任务
- **Co-Pilot**: AI 作为搭档，与 PM 协同决策
- **Amplifier**: AI 作为放大器，指数级提升 PM 能力边界

**适用场景**: PM 职业规划、AI PM 能力评估、团队培训体系设计。

**关联章节**: [Ch10.md](./Ch10.md)、[Ch11.md](./Ch11.md)

---

## 模型关系图谱

```
                    ┌─────────────────────────────────┐
                    │    AI 产品全生命周期框架 (模型 1)    │
                    └───────────┬─────────────────────┘
                                │
          ┌─────────────────────┼─────────────────────┐
          ▼                     ▼                     ▼
    ┌───────────┐       ┌──────────────┐       ┌──────────────┐
    │ 问题识别   │       │ MVP + 设计    │       │ 增长 + 护城河 │
    │ (模型 2)  │       │ (模型 3+4)   │       │ (模型 5+6+7) │
    └───────────┘       └──────────────┘       └──────────────┘
                                                    │
                                              ┌─────┴─────┐
                                              │ PM 能力进化 │
                                              │  (模型 8)  │
                                              └───────────┘
```
