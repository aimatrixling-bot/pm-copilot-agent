---
name: pm-code-architect
displayName: Code Architect
displayDescription: 消费 PRD/Tech Spec，产出系统架构设计
description: "Design system architecture from PRD and Tech Spec. Trigger when user says 'architect', 'system design', '目录结构', '组件拆分', '架构设计', 'component design', or needs to translate requirements into code structure."
user-invocable: true
argument-hint: "[功能/模块名称]"
---

# 架构设计

<SUBAGENT-STOP>
如果是子代理派发执行此 Skill，直接按下方指令执行，不重新加载入口 Skill。
</SUBAGENT-STOP>

从 PRD/Tech Spec 到可执行的代码结构。架构是需求到工程的第一道翻译——翻译错了，后面全错。

**核心原则**：没有目录树的架构不是架构。

## Iron Law（铁律）

| 铁律 | 违反后果 |
| --- | --- |
| 没有目录树的架构不是架构 | 立即停止——产出完整目录结构后继续 |
| 架构必须兼容现有项目框架 | 立即停止——检查项目 CLAUDE.md 和已有结构后重新设计 |
| 不评估技术取舍的架构是空中楼阁 | 立即停止——每个关键决策必须有取舍分析 |

## 反合理化

| 你可能在想的 | 真相 |
| --- | --- |
| "先写代码再说架构" | 没有架构的代码 = 技术债的种子——改动越晚成本越高 |
| "这个功能很简单，不需要架构" | 简单功能也需要知道放在哪里、和谁交互、数据怎么流 |
| "用最流行的技术栈" | 技术栈选项目已有的，不引入新依赖——除非有充分的取舍论证 |
| "架构设计要覆盖所有细节" | 架构定方向和边界，细节留给实现——但边界必须清晰 |

## 输入

| 输入项 | 来源 | 必须？ |
| --- | --- | --- |
| PRD / 需求文档 | pm-prd 或用户提供 | 是 |
| Tech Spec | pm-tech-spec 或用户提供 | 推荐 |
| 现有项目代码结构 | Glob + Read | 是 |
| 项目 CLAUDE.md | Read | 是 |

## 执行流程

```
触发 pm-code-architect
    ├── 1. 读取上下文
    │     ├── 读取项目 CLAUDE.md（确认框架约束）
    │     ├── Glob 项目目录结构（理解现有架构）
    │     ├── Read 相关 PRD / Tech Spec
    │     └── 识别已有组件和依赖
    ├── 2. 架构分析
    │     ├── 确认技术栈（从项目已有，不引入新依赖）
    │     ├── 识别模块边界和数据流向
    │     └── 列出关键架构决策点
    ├── 3. 技术取舍分析
    │     ├── 每个关键决策列出 ≥ 2 个选项
    │     ├── 对比维度：复杂度/可维护性/性能/团队熟悉度
    │     └── 给出推荐 + 理由
    ├── 4. 产出架构设计
    │     ├── architecture_overview
    │     ├── directory_structure（目录树）
    │     ├── component_tree（组件/模块关系）
    │     ├── data_models（数据模型）
    │     ├── api_contracts（接口契约）
    │     └── tech_choices（技术选型 + 取舍理由）
    ├── 5. Iron Law 检查
    │     ├── 目录树是否完整？
    │     ├── 是否兼容现有框架？
    │     └── 每个技术选型是否有取舍分析？
    └── 6. 交付 + 后续推荐
          ├── pm-code-implement（执行实现）
          └── pm-code-review（代码审查）
```

## 输出规范

### 1. Architecture Overview

3-5 句话描述整体架构风格（SPA / SSR / Desktop / 微服务 / 单体等）和核心设计决策。

### 2. Directory Structure

使用树形格式展示新增/变更的目录和文件。标注每个目录的职责。

```
src/
├── features/{module}/     # 新增模块
│   ├── components/        # UI 组件
│   ├── hooks/             # 业务逻辑 hooks
│   ├── types.ts           # 类型定义
│   └── index.ts           # 模块入口
├── shared/                # 共享资源（已有）
│   └── api/               # API 层
└── ...
```

### 3. Component Tree

模块/组件间的依赖关系。用列表或 Mermaid 图表达。

### 4. Data Models

核心数据结构定义（TypeScript interface / SQL schema / 等）。

### 5. API Contracts

接口定义：路径、方法、请求/响应体、错误码。

### 6. Tech Choices

| 决策点 | 选项 A | 选项 B | 选择 | 理由 |
| --- | --- | --- | --- | --- |
| 状态管理 | Zustand | Context | ... | ... |

## 交付前检查

- [ ] 目录树完整且兼容现有项目框架
- [ ] 每个新增目录有职责说明
- [ ] 技术选型全部来自项目已有依赖（或已论证新依赖的必要性）
- [ ] 数据模型覆盖 PRD 中的核心实体
- [ ] API 契约包含错误处理
- [ ] 关键技术取舍已列出（≥ 2 选项 + 理由）
- [ ] 无模糊表述（"后续优化"、"按需添加"等）

## 后续推荐

| 场景 | 推荐 Skill |
| --- | --- |
| 开始编码实现 | pm-code-implement |
| 架构需要先验证技术可行性 | pm-tech-spec |
| 架构涉及重大取舍 | pm-decision |

## Metadata

```yaml
track: engineering
depends_on: [pm-tech-spec]
schema_type: enforced
persist_to: ["projects/{project}/docs/architecture.md"]
guardrails:
  - 目录结构必须兼容现有项目框架（Next.js / Tauri / 等）
  - 不引入项目未使用的新依赖，除非有充分论证
  - 架构设计必须包含技术取舍分析
```
