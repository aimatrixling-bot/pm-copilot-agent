---
name: pm-code-implement
displayName: Code Implement
displayDescription: 执行代码实现
description: "Execute code implementation from architecture design and task breakdown. Trigger when user says 'implement', 'code', '写代码', '开发', '代码实现', or needs to write actual code for a specific task."
user-invocable: true
argument-hint: "[任务描述]"
---

# 代码实现

<SUBAGENT-STOP>
如果是子代理派发执行此 Skill，直接按下方指令执行，不重新加载入口 Skill。
</SUBAGENT-STOP>

从架构设计到可运行的代码。实现是架构的精确执行——偏差越小，返工越少。

**核心原则**：没有架构设计的代码不写。

## Iron Law（铁律）

| 铁律 | 违反后果 |
| --- | --- |
| 没有架构设计的代码不写 | 立即停止——先执行 pm-code-architect 或确认架构存在 |
| 变更文件数 ≤ 10 | 超过时拆分为多次实现，每次聚焦一个子任务 |
| 不修改 .env / 不 force push | 触发全局安全红线——必须用户确认 |

## 反合理化

| 你可能在想的 | 真相 |
| --- | --- |
| "顺手多改几个文件" | 每个额外变更都是风险——聚焦当前任务，其余记入 backlog |
| "这个 bug 顺手修了" | 修 bug 是独立任务——先记录，不混入当前实现 |
| "代码写完就行，测试之后再说" | 写完 → typecheck/lint → 验证 → 报告完成，缺一不可 |
| "先让代码跑起来，之后重构" | 跑起来 + 代码质量不矛盾——写的时候就该对齐项目规范 |

## 输入

| 输入项 | 来源 | 必须？ |
| --- | --- | --- |
| 架构设计 | pm-code-architect 产出 | 是 |
| 单个任务描述 | 用户指定 | 是 |
| 项目代码结构 | Glob + Read | 是 |
| 项目 CLAUDE.md | Read | 是 |

## 执行流程

```
触发 pm-code-implement
    ├── 1. 前置检查
    │     ├── 架构设计是否存在？
    │     │     └── 不存在 → 建议先执行 pm-code-architect → 停止
    │     ├── 读取项目 CLAUDE.md（确认框架约束和验证命令）
    │     └── 确认任务范围（单次实现 ≤ 10 个文件）
    ├── 2. 读取上下文
    │     ├── Read 架构设计文档
    │     ├── Glob 项目目录结构
    │     └── Read 相关已有代码（理解现有模式）
    ├── 3. 实现规划
    │     ├── 列出本次变更的文件清单（≤ 10）
    │     ├── 每个文件的变更类型（新增/修改）
    │     └── 变更顺序（减少依赖冲突）
    ├── 4. 执行代码变更
    │     ├── 按规划顺序逐文件修改
    │     ├── 遵循项目已有代码风格
    │     └── 关键变更加行内注释说明意图
    ├── 5. 验证
    │     ├── 运行 typecheck（如有配置）
    │     ├── 运行 lint（如有配置）
    │     └── 构建通过（如有配置）
    └── 6. 交付报告
          ├── 变更文件清单 + 每个文件的变更摘要
          ├── 验证结果
          └── 后续推荐
```

## 输出规范

### 变更报告（Markdown）

每次实现完成后产出变更报告：

```markdown
## 变更摘要

### 变更文件

| 文件 | 类型 | 变更说明 |
| --- | --- | --- |
| src/features/xxx/index.ts | 新增 | 模块入口，导出公共 API |
| src/features/xxx/hooks.ts | 新增 | 业务逻辑 hook |
| src/app/xxx/page.tsx | 修改 | 集成新模块到页面 |

### 验证结果

- typecheck: ✅ 通过
- lint: ✅ 通过
- build: ✅ 通过

### 注意事项

- [如有需要用户关注的点]
```

### 代码变更（实际文件修改）

直接修改/创建文件，不将代码包裹在代码块中作为输出。

## 交付前检查

- [ ] 变更文件数 ≤ 10
- [ ] 无 .env 修改
- [ ] 无 force push
- [ ] typecheck 通过（或项目无此配置）
- [ ] lint 通过（或项目无此配置）
- [ ] 代码风格与项目已有代码一致
- [ ] 无硬编码值（应提取为常量的已提取）
- [ ] 错误已处理（不静默吞错）
- [ ] 变更报告已产出

## 后续推荐

| 场景 | 推荐 Skill |
| --- | --- |
| 实现完成，需要审查 | pm-code-review |
| 发现架构需要调整 | pm-code-architect |
| 发现技术决策需要记录 | pm-decision |

## Metadata

```yaml
track: engineering
depends_on: [pm-code-architect]
schema_type: free
persist_to: []
guardrails:
  - 变更文件数 ≤ 10
  - 不修改 .env 文件
  - 不执行 force push
  - 代码变更后必须运行 typecheck / lint（如有配置）
  - 无架构设计时拒绝执行
```
