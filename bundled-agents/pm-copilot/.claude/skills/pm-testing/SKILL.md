---
name: pm-testing
displayName: 用户测试
displayDescription: 制定测试计划并执行用户测试
description: "Create test plans and conduct user testing to validate product quality. Use this skill whenever the user needs a test plan, says 'test plan', '测试计划', '验收测试', 'QA plan', '用户测试', '可用性测试', 'usability test', or needs to verify features work as expected. Also trigger when the user says 'how do we test this', 'verify it works', 'what should we test', or 'let's test with users'. Converts vague 'it should work' into structured test cases covering happy paths, edge cases, and error handling."
user-invocable: true
argument-hint: "[功能名称或 PRD 文件路径]"
---

# 测试计划

<SUBAGENT-STOP>
如果是子代理派发执行此 Skill，直接按下方指令执行，不重新加载入口 Skill。
</SUBAGENT-STOP>

从 PRD 提取验收标准，生成结构化测试用例。确保每个需求都有可验证的测试覆盖。

**输入**: PRD 文件路径或功能描述
**输出**: 测试计划 + 测试用例表格

## Iron Law

| 铁律 | 违反后果 |
| --- | --- |
| 未经测试的功能不算完成 | 返回开发——补充测试后重新评审 |
| 每个验收标准必须有对应测试 | 立即停止——补充遗漏的测试用例 |
| P0 功能必须 100% 覆盖 | 立即停止——P0 不能有测试缺口 |

## 反合理化

| 你可能在想的 | 真相 |
| --- | --- |
| "开发者自己测过了" | 开发者测的是"能跑"，不是"用户能用" |
| "时间紧，跳过测试" | 上线后发现的 bug 修复成本是测试的 10-100 倍 |
| "自动化覆盖了" | 自动化覆盖正常路径，用户走的是异常路径 |
| "用户会告诉我们问题的" | 用户不会告诉你，他们只会离开 |
| "5 个用户不够" | 5 人可发现 80% 的可用性问题（Jakob Nielsen） |

## 执行流程

```
1. 读取 PRD 中的 User Stories 和 Acceptance Criteria
2. 为每个 AC 生成测试用例
   ├── 正向测试（Happy path）— 正常使用场景
   ├── 边界测试（Edge cases）— 极端输入和状态
   └── 异常测试（Error handling）— 网络断、数据空等
3. 按优先级排序（P0 功能的测试优先）
4. 标注测试类型（手动/自动/探索性/用户测试）
5. 定义通过标准
6. Iron Law 检查
   ├── 每个 User Story 有测试？
   ├── P0 功能 100% 覆盖？
   └── 包含异常和边界？
7. 产出测试计划
```

## 测试覆盖策略

| 优先级 | 覆盖范围 | 测试类型 |
| --- | --- | --- |
| P0 | 100% 全覆盖 | 手动 + 自动 |
| P1 | 核心路径覆盖 | 手动为主 |
| P2 | 探索性抽检 | 探索性测试 |

## 交付前检查

- [ ] 每个 User Story 有对应测试用例
- [ ] 包含正向 + 边界 + 异常测试
- [ ] 测试用例有明确的前置条件和预期结果
- [ ] 按 P0/P1/P2 排序
- [ ] 通过标准已定义
- [ ] 测试环境要求已列出

## 产出格式

```markdown
# 测试计划: [功能名]

> **关联 PRD**: [PRD 路径]
> **测试范围**: P0 全覆盖，P1 核心路径，P2 抽检
> **通过标准**: P0 全通过 + P1 ≥90% 通过

## 测试用例
| # | User Story | 测试项 | 前置条件 | 测试步骤 | 预期结果 | 优先级 | 类型 |
|---|------------|--------|----------|----------|----------|--------|------|
| 1 | US-01 | 正向：正常流程 | [条件] | [步骤] | [结果] | P0 | 手动 |
| 2 | US-01 | 边界：空输入 | [条件] | [步骤] | [结果] | P0 | 自动 |
| 3 | US-01 | 异常：网络断开 | [条件] | [步骤] | [结果] | P1 | 手动 |

## 测试环境
| 环境 | 要求 |
|------|------|
| 测试数据 | [描述] |
| 账号 | [描述] |

## 风险
| 风险 | 影响 | 缓解 |
|------|------|------|
```

测试方法详解（可用性测试流程、SUS 评分等）见 `references/testing-methods.md`。

## 常见错误

| 错误 | 后果 | 正确做法 |
| --- | --- | --- |
| 只测正常流程 | 遗漏边界和异常 | 每个功能 3 类测试 |
| 测试用例太笼统 | 无法执行 | 具体：步骤+预期结果 |
| 不记录测试结果 | 不知道测了什么 | 记录每条 pass/fail |
| 测试太晚 | 发现问题来不及改 | 开发过程中就开始测试 |
| 自己测自己 | 盲点遗漏 | 交叉测试或找非开发人员 |
