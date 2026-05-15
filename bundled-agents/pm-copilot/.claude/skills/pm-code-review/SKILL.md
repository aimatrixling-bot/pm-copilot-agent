---
name: pm-code-review
displayName: Code Review
displayDescription: 代码审查
description: "Review code changes for security, logic, and performance. Trigger when user says 'code review', '代码审查', '代码检查', 'review code', or after code implementation is done."
user-invocable: true
argument-hint: "[代码变更描述或文件路径]"
---

# 代码审查

<SUBAGENT-STOP>
如果是子代理派发执行此 Skill，直接按下方指令执行，不重新加载入口 Skill。
</SUBAGENT-STOP>

独立审查代码变更，发现安全、逻辑和性能问题。审查是质量最后一道门——放过的 bug 会在生产环境十倍代价地回来。

**核心原则**：审查者不等于实现者。

## Iron Law（铁律）

| 铁律 | 违反后果 |
| --- | --- |
| 审查者 ≠ 实现者 | 同一人的代码必须由另一视角审查——如果只有一个人，至少隔 30 分钟后以审查者身份重新审视 |
| 每个问题必须有 severity + suggestion | 无 severity 的问题不计入审查结果——补全后重新计数 |
| 审查结论只有 APPROVE / REQUEST_CHANGES | 没有"看起来还行"——要么通过，要么打回 |

## 反合理化

| 你可能在想的 | 真相 |
| --- | --- |
| "代码能跑就行" | 能跑 ≠ 正确——边界情况、错误处理、性能坑不会在正常流程暴露 |
| "这个问题太小了不用说" | 小问题积累成大故障——severity 区分优先级，但不说 = 不存在 |
| "我不确定这是不是问题" | 不确定也要标注为 suggestion——让作者判断，比漏掉好 |
| "实现者经验丰富，应该没问题" | 经验丰富的人也会犯低级错误——审查不看人，看代码 |

## 输入

| 输入项 | 来源 | 必须？ |
| --- | --- | --- |
| 代码变更 diff | git diff / 用户提供的文件 | 是 |
| 原始需求 | PRD / 任务描述 | 推荐 |
| 项目 CLAUDE.md | Read | 推荐 |

## 审查维度

| 维度 | 检查内容 | 重点关注 |
| --- | --- | --- |
| **安全** | 注入、XSS、认证、敏感数据泄露 | 用户输入处理、API 调用、.env 引用 |
| **逻辑** | 边界情况、错误处理、空值处理 | if/else 分支覆盖、try/catch、null check |
| **性能** | N+1 查询、内存泄漏、不必要的重渲染 | 循环内查询、useEffect 依赖、大列表渲染 |
| **可维护性** | 命名、函数长度、重复代码 | 变量命名自解释、函数 ≤ 50 行、DRY |
| **一致性** | 代码风格与项目已有代码一致 | 导入顺序、命名约定、错误处理模式 |

## 执行流程

```
触发 pm-code-review
    ├── 1. 获取变更
    │     ├── 读取 git diff（或用户提供的文件）
    │     ├── 读取原始需求（理解变更意图）
    │     └── 读取项目 CLAUDE.md（理解项目约束）
    ├── 2. 逐文件审查
    │     ├── 安全扫描（注入、XSS、敏感数据）
    │     ├── 逻辑审查（边界、错误处理、空值）
    │     ├── 性能检查（N+1、内存、渲染）
    │     ├── 可维护性评估（命名、长度、重复）
    │     └── 一致性比对（与项目已有风格对比）
    ├── 3. 问题分类
    │     ├── critical — 必须修复才能合并
    │     ├── major — 强烈建议修复
    │     ├── minor — 建议修复但不阻塞
    │     └── suggestion — 改进建议，可选
    ├── 4. 产出审查报告
    │     ├── verdict（APPROVE / REQUEST_CHANGES）
    │     ├── issues 列表（severity + file + line + description + suggestion）
    │     └── summary（总体评价）
    └── 5. 交付
          ├── APPROVE → 建议后续行动
          └── REQUEST_CHANGES → 指向 pm-code-implement 修复
```

## 输出规范（enforced schema）

审查报告必须遵循以下结构：

```markdown
## 审查结论: [APPROVE / REQUEST_CHANGES]

### 问题列表

| # | Severity | 文件 | 行号 | 问题描述 | 修复建议 |
| --- | --- | --- | --- | --- | --- |
| 1 | critical | src/api/auth.ts | L42 | 密码明文存储 | 使用 bcrypt 加密后存储 |
| 2 | minor | src/hooks/useData.ts | L15 | useEffect 缺少依赖 | 添加 missing dependency |
| 3 | suggestion | src/utils/format.ts | - | 考虑提取为共享工具函数 | 移至 shared/utils/ |

### 总结

[2-3 句总体评价：变更质量、主要风险点、正面发现]
```

### Severity 定义

| Severity | 标准 | 处理要求 |
| --- | --- | --- |
| **critical** | 安全漏洞、数据丢失风险、生产故障风险 | 必须 fix 后才能合并 |
| **major** | 逻辑错误、性能问题、重要边界未处理 | 强烈建议 fix，合并前解决 |
| **minor** | 代码风格、命名、小优化 | 建议修复，不阻塞合并 |
| **suggestion** | 改进思路、架构优化方向 | 可选，供参考 |

## 交付前检查

- [ ] 每个 issue 都有 severity（critical/major/minor/suggestion 之一）
- [ ] 每个 issue 都有 suggestion（可执行的修复建议）
- [ ] 不编造代码中不存在的问题
- [ ] 审查结论是 APPROVE 或 REQUEST_CHANGES（二选一）
- [ ] summary 包含正面发现（不只列问题）
- [ ] critical 和 major 问题数量 ≥ 1 时，结论必须是 REQUEST_CHANGES

## 后续推荐

| 场景 | 推荐 Skill |
| --- | --- |
| REQUEST_CHANGES 后修复 | pm-code-implement |
| 发现架构层面问题 | pm-code-architect |
| 发现安全漏洞 | 立即告知用户，不走 Skill |

## Metadata

```yaml
track: engineering
depends_on: [pm-code-implement]
# schema_type & persist_to: v2 规划（当前运行时不读取，仅作为设计声明）
schema_type: enforced
persist_to: []
guardrails:
  - 不编造代码中不存在的问题
  - severity 必须是 critical / major / minor / suggestion 之一
  - 每个 issue 必须包含 severity + file + line + description + suggestion
  - 审查结论只有 APPROVE 或 REQUEST_CHANGES
  - critical/major ≥ 1 时结论必须为 REQUEST_CHANGES
```
