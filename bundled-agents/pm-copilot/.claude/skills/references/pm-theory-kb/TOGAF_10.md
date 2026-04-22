# TOGAF 9.2 关键模型与框架提炼

> 从 532 页中提炼出 PM 最需要掌握的核心模型，按使用频率排序。

---

## 1. ADM 架构开发方法（Architecture Development Method）

**来源**: Part II, Ch 4-16 | **PM 相关度**: ⭐⭐⭐

TOGAF 的核心，一个**迭代式的架构开发闭环**，包含 8 个阶段 + 1 个需求管理贯穿线：

```
                    ┌─────────────────┐
                    │  Requirements   │ ← 贯穿所有阶段
                    │  Management     │
                    └────────┬────────┘
                             │
              ┌──────────────▼──────────────┐
              │     Preliminary Phase       │ ← 架构能力准备
              │ (原则/框架/工具/组织)        │
              └──────────────┬──────────────┘
                             │
              ┌──────────────▼──────────────┐
              │     Phase A: Vision         │ ← 业务愿景、范围、KPI
              └──────────────┬──────────────┘
                             │
     ┌───────────┬───────────▼───────────┬───────────┐
     │  Phase B  │  Phase C             │  Phase D  │
     │  Business │  Information Systems │ Technology │
     │  Arch     │  (Data + App)        │  Arch      │
     └─────┬─────┴──────────┬──────────┴─────┬──────┘
           └────────────────┼────────────────┘
                            │
              ┌─────────────▼─────────────┐
              │     Phase E: Solutions    │ ← 机会识别、Work Package
              └─────────────┬─────────────┘
                            │
              ┌─────────────▼─────────────┐
              │     Phase F: Migration    │ ← 路线图、优先级、成本/收益
              └─────────────┬─────────────┘
                            │
              ┌─────────────▼─────────────┐
              │     Phase G: Governance   │ ← 合规审查、实施监控
              └─────────────┬─────────────┘
                            │
              ┌─────────────▼─────────────┐
              │     Phase H: Change Mgmt  │ ← 变更管理、价值实现
              └──────────────────────────┘
```

**PM 映射**: ADM 的 A→B→C→D 阶段类似 PM 的「定义→设计→开发」；E→F 类似「发布规划」；G→H 类似「运营与迭代」。

---

## 2. 利益相关者管理流程（Stakeholder Management）

**来源**: Ch 21, p241-256 | **PM 相关度**: ⭐⭐⭐

4 步流程：

| 步骤 | 活动 | 产出 |
|------|------|------|
| 1. Identify | 识别所有利益相关者 | Stakeholder Map |
| 2. Classify | 按权力/影响力/兴趣分类 | Power/Interest Grid |
| 3. Determine Approach | 确定管理策略（告知/咨询/参与/授权） | Engagement Strategy |
| 4. Tailor Deliverables | 按利益相关者需求定制沟通内容 | Tailored Views |

**关键模型 — Power/Interest Grid**:
```
           High Interest
                │
    Keep       │   Manage
    Satisfied  │   Closely
                │
Low Power ─────┼───── High Power
                │
    Monitor    │   Keep
    (Minimum)  │   Informed
                │
           Low Interest
```

---

## 3. 差距分析（Gap Analysis）

**来源**: Ch 23, p263-266 | **PM 相关度**: ⭐⭐⭐

系统化识别「现状（Baseline）vs 目标（Target）」之间差距的技术：

1. **绘制现状**（Baseline Architecture）
2. **绘制目标**（Target Architecture）
3. **逐一对比**，识别 Gap
4. **分类**: 人员 gap、流程 gap、技术 gap、数据 gap
5. **排序**: 按影响和紧迫性
6. **生成**: Gap → Solution → Work Package 的映射链

**PM 应用场景**: 产品现状评估、竞品功能差距分析、团队能力差距分析。

---

## 4. 架构原则框架（Architecture Principles）

**来源**: Ch 20, p225-240 | **PM 相关度**: ⭐⭐⭐

原则的 5 个核心属性：
- **Name**: 唯一标识
- **Statement**: 清晰陈述（"业务系统应优先使用开放标准"）
- **Rationale**: 为什么需要这条原则
- **Implications**: 遵循/违反原则的后果
- **Reference**: 对应的框架/标准

TOGAF 提供了 4 类示例原则：
- **Business Principles**（21 条）— 如"企业应最大化数据共享"
- **Data Principles**（6 条）— 如"数据是资产"
- **Application Principles**（9 条）— 如"应用应可互操作"
- **Technology Principles**（9 条）— 如"基于开放标准"

**PM 应用**: 产品技术原则、设计规范、架构决策记录（ADR）。

---

## 5. Enterprise Continuum（企业连续体）

**来源**: Ch 35, p403-412 | **PM 相关度**: ⭐⭐

一条从"通用"到"特定"的连续光谱，帮助组织复用架构资产：

```
Generic ─────────────────────────────── Specific
  │                                         │
  │  Foundation Architecture                │  Organization-Specific
  │  (通用基础架构)                         │  Architecture
  │                                         │
  │  Common Systems Architectures           │  Specific Architecture
  │  (通用系统架构)                         │  (特定架构)
  │                                         │
  │  Industry Architectures                 │
  │  (行业架构)                             │
  │                                         │
  ├─────────────────┬───────────────────────┤
  │ Architecture     │    Solutions         │
  │ Continuum        │    Continuum         │
  │ (架构连续体)      │    (方案连续体)       │
  └─────────────────┴───────────────────────┘
```

- **Architecture Continuum**: 从通用到特定的架构模式
- **Solutions Continuum**: 从通用到特定的解决方案实现

**PM 应用**: 参考竞品/行业最佳实践来指导产品设计；复用已有方案而非重新发明。

---

## 6. 架构交付物清单（Architecture Deliverables）

**来源**: Ch 32, p377-392 | **PM 相关度**: ⭐⭐

21 个标准交付物，按用途分类：

| 类别 | 交付物 | PM 对应物 |
|------|--------|----------|
| **启动** | Statement of Architecture Work | 项目章程/任务书 |
| **定义** | Architecture Vision | 产品愿景 |
| **定义** | Architecture Definition Document | PRD/技术方案 |
| **定义** | Architecture Principles | 设计原则 |
| **规划** | Architecture Roadmap | 产品路线图 |
| **规划** | Implementation & Migration Plan | 发布计划 |
| **规划** | Implementation Governance Model | PMO 运作规范 |
| **评估** | Capability Assessment | 能力评估 |
| **评估** | Compliance Assessment | 合规审查 |
| **治理** | Architecture Contract | 团队间 SLA |
| **治理** | Change Request | 变更请求 |

---

## 7. 迁移规划矩阵（Migration Planning Matrices）

**来源**: Ch 24, p267-270 | **PM 相关度**: ⭐⭐

5 个关键工具：

| 矩阵 | 用途 | PM 对应 |
|------|------|---------|
| **Implementation Factor Assessment** | 评估实施因素（风险、成本、时间） | 发布决策矩阵 |
| **Consolidated Gaps, Solutions & Dependencies** | 汇总差距→方案→依赖 | 依赖管理 |
| **Architecture Definition Increments Table** | 定义增量交付 | Sprint/Milestone 规划 |
| **Transition Architecture Evolution Table** | 过渡状态演变 | 版本迭代计划 |
| **Business Value Assessment** | 评估业务价值 | ROI 分析 |

---

## 8. 架构成熟度模型（ACMM）

**来源**: Ch 45, p483-490 | **PM 相关度**: ⭐⭐

US Department of Commerce ACMM 框架，5 级成熟度：

| Level | 名称 | 特征 |
|-------|------|------|
| 1 | Initial | 无正式 EA 流程 |
| 2 | Under Development | EA 意识萌芽，试点项目 |
| 3 | Defined | EA 流程已定义，部分组织采纳 |
| 4 | Managed | EA 流程已管理，度量和改进 |
| 5 | Optimizing | EA 持续优化，与业务战略深度集成 |

**PM 应用**: 评估团队/组织的架构成熟度，指导改进方向。

---

## 9. 构建块（Building Blocks）

**来源**: Ch 33, p393-398 | **PM 相关度**: ⭐⭐

两种构建块：

```
Architecture Building Blocks (ABB)     Solution Building Blocks (SBB)
  概念层面                              实现层面
  "需要什么能力"                        "用什么方案实现"

  例如: "支付网关接口"                   例如: "Stripe Integration SDK"

  ABB → 选择/组合 → SBB → 集成 → 解决方案
```

**PM 应用**: 产品功能模块化设计；技术选型（从能力需求到具体方案）。

---

## 10. 架构仓库（Architecture Repository）

**来源**: Ch 37, p419-428 | **PM 相关度**: ⭐⭐

6 个组成部分：

| 组件 | 内容 | PM 对应 |
|------|------|---------|
| **Architecture Landscape** | 架构全景（所有进行中和已完成的架构） | 产品组合 |
| **Reference Library** | 参考模型（行业框架、模式） | 竞品分析库 |
| **Standards Information Base (SIB)** | 标准信息库 | 技术标准/规范 |
| **Governance Log** | 治理日志（决策记录、合规审查） | ADR / 决策日志 |
| **Requirements Repository** | 需求仓库 | 需求管理工具 |
| **Solutions Landscape** | 方案全景（已实现的解决方案） | 已上线功能清单 |

---

## 快速参考：ADM 各阶段输入输出链

| Phase | 核心输入 | 核心输出 |
|-------|---------|---------|
| Preliminary | 外部参考、组织输入 | EA 原则、组织模型、工具策略 |
| A: Vision | 业务目标、驱动力 | 架构愿景、Statement of Architecture Work |
| B: Business | 架构愿景、业务约束 | 业务架构描述、Gap Analysis |
| C: Data | 业务架构 | 数据架构描述、Gap Analysis |
| C: App | 业务/数据架构 | 应用架构描述、Gap Analysis |
| D: Tech | 应用/数据架构 | 技术架构描述、Gap Analysis |
| E: Solutions | Phase B-D Gap | Work Packages、过渡架构、路线图 |
| F: Migration | Work Packages | 实施计划、优先级排序 |
| G: Governance | 实施计划 | 合规审查、架构契约 |
| H: Change | 变更请求 | 新的架构需求、价值实现评估 |
