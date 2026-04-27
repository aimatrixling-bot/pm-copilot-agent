# PM Theory KB — 三级渐进索引

> 本文件是 PM 方法论知识库的查询入口。遵循 **Layer A → Layer B → Layer C** 渐进查询，不要一次加载所有内容。

---

## Layer A: 全景目录（~20 行，零成本）

"KB 有什么？" — 定位场景后进入 Layer B。

| 场景 | 书数 | 首选书 |
| --- | --- | --- |
| 问题验证 | 2 | The Mom Test |
| 需求定义 | 4 | 俞军产品方法论 |
| 用户体验 | 3 | Don't Make Me Think |
| 数据驱动 | 4 | 增长黑客 |
| AI 产品 | 4 | Reimagined |
| 战略与架构 | 5 | The Product Book |

**跨场景参考**：The Lean Startup（问题验证+需求定义+数据驱动）、Hooked（体验+需求）、Product Operations（战略+数据）、策略产品经理（战略+需求）、Anthropic_Skill_Guide（AI产品+需求）

---

## Layer B: 场景清单（按需加载一个场景）

"这个场景有哪些书？" — 每条一行摘要，定位后进入 Layer C 读完整内容。

### 问题验证

- **The Mom Test** — 用户访谈方法论：如何问对问题、避免误导性反馈、从对话中提取真实需求信号
- **The Lean Startup** — MVP 验证、构建-测量-学习循环、创新核算、转型 vs 坚持

### 需求定义

- **俞军产品方法论** — 用户价值公式（产品价值 = 新体验 - 旧体验 - 迁移成本）、PM 能力模型、产品经理的三个发展阶段
- **About Face** — 交互设计原则、目标导向设计（Goal-Directed Design）、人物角色与场景
- **B端产品经理必修课** — B 端需求分析方法论、业务流程梳理、角色权限设计、实施交付流程
- **决胜B端** — B 端 SaaS 产品方法论、客户生命周期管理、PLG vs SLG 增长策略

### 用户体验

- **Don't Make Me Think** — 可用性原则、信息架构、导航设计、可用性测试方法
- **The Elements of User Experience** — UX 五层模型（战略→范围→结构→框架→表现）、用户体验要素系统
- **Hooked** — 上瘾模型（触发→行动→酬赏→投入）、习惯养成产品设计、用户留存机制

### 数据驱动

- **Data Science for Business** — 数据分析框架、预测模型、A/B 测试统计基础、数据驱动决策
- **增长黑客** — AARRR 模型（获取→激活→留存→变现→推荐）、增长实验方法论
- **数据产品经理实战进阶** — 数据产品设计、指标体系搭建、数据治理、BI 平台建设
- **美团数据平台及数仓建设实践** — 数据平台架构、数仓分层设计（ODS/DWD/DWS/ADS）、数据资产管理

### AI 产品

- **Building AI Powered Products** — AI 产品设计模式、人机协作框架、AI 产品经理能力要求
- **Generative AI Design Patterns** — 生成式 AI 设计模式、Prompt 工程、RAG 架构、多模态交互
- **Reimagined: Building Products with Generative AI** — AI 时代产品重构、AI-Native 产品设计原则
- **The AI Product Playbook** — AI 产品 Playbook、从模型选择到产品化的完整流程、评估体系

### 战略与架构

- **The Product Book** — 产品管理全流程（从发现到交付）、跨职能协作、产品路线图制定
- **Product Operations** — 产品运营体系、实验文化建设、产品-市场匹配度量
- **PMBOK指南第6版** — 项目管理框架、范围管理、风险管理、干系人管理
- **TOGAF_10** — 企业架构方法论、业务架构设计、IT 战略规划
- **策略产品经理** — 策略产品方法论、定价策略、市场定位、竞争博弈

---

## Layer C: 完整模型（按需，每本一个文件）

定位到具体书后，读对应文件获取完整方法论内容。文件路径格式：`references/pm-theory-kb/{BookName}/`。

每本书目录下通常有 `_index.md`（章节索引）和 `Key_Models.md`（核心模型浓缩）。优先读 `Key_Models.md`，需要案例细节时再读 `Ch*.md`。

---

## Skill → 场景快速路由

Agent 触发 Skill 时，先查此表定位应查询的 KB 场景，再按 Layer A → B → C 渐进加载。

| Skill | 首选场景 | 次选场景 |
| --- | --- | --- |
| pm-problem-frame | 问题验证 | — |
| pm-prd | 需求定义 | 用户体验 |
| pm-wireframe | 用户体验 | 需求定义 |
| pm-persona | 需求定义 | 用户体验 |
| pm-rice | 需求定义 | 数据驱动 |
| pm-testing | 问题验证 | 数据驱动 |
| pm-experiment | 数据驱动 | 问题验证 |
| pm-metrics | 数据驱动 | — |
| pm-decision | 战略与架构 | 数据驱动 |
| pm-roadmap | 战略与架构 | 需求定义 |
| pm-comp | 战略与架构 | 需求定义 |
| pm-retro | 问题验证 | 数据驱动 |
| pm-sync | 需求定义 | — |
| pm-writer-* | 按内容主题匹配 | — |
