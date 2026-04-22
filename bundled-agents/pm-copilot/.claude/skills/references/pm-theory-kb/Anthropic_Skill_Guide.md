# 核心模型与框架

从《The Complete Guide to Building Skills for Claude》中提炼的核心方法论。

---

### 1. Progressive Disclosure 三级加载模型

**定义**：Skill 的 token 效率优化核心架构。将 Skill 信息分为三个递进层级，按需加载，最小化每次交互的 token 消耗。

- **Level 1 — YAML Frontmatter**（~100 词）：始终加载在 Claude 系统提示中，仅包含 name 和 description。作用是让 Claude 知道"何时使用此 Skill"，不包含具体指令。
- **Level 2 — SKILL.md Body**（<500 行）：当 Claude 判断 Skill 与当前任务相关时加载。包含完整的工作流指令、模板引用、分支逻辑。
- **Level 3 — Linked Files**（无限制）：SKILL.md 引用的 references/、scripts/、assets/ 中的文件，Claude 按需读取。

**适用场景**：所有 Skill 设计。这是 Skill 架构的第一性原则，决定了 token 效率的上限。

**关联章节**：[Ch01-02](./Ch01-02.md)

---

### 2. Description 优化循环（Trigger Eval → Iteration）

**定义**：用结构化的 eval set 量化 Skill 的触发准确率，通过迭代优化 YAML frontmatter 中的 description 字段，解决"该触发时不触发"（undertriggering）和"不该触发时触发"（overtriggering）两类问题。

核心流程：
1. 生成 20 条 eval 查询（8-10 条 should-trigger + 8-10 条 should-not-trigger）
2. 在 60% train / 40% test 划分上评估当前 description
3. 让 Claude（extended thinking）分析失败案例并提出改进
4. 用改进后的 description 重新评估
5. 选择 test set 得分最高的版本（避免过拟合 train set）

**关键原则**：
- should-not-trigger 查询必须是"近 miss"——与 Skill 共享关键词但实际需要不同工具
- 查询必须足够具体（含文件路径、用户背景、具体场景），不能太抽象
- "简单查询不会触发 Skill"是正常行为——Claude 只有在需要帮助时才咨询 Skill

**适用场景**：Skill 上线前的质量保证。解决"Skill 写得好但没人用"的核心问题。

**关联章节**：[Ch03-04](./Ch03-04.md)

---

### 3. With-Skill vs Baseline 对照实验

**定义**：每个测试用例同时运行两个版本——使用 Skill 的版本和不使用 Skill（或使用旧版本 Skill）的版本。通过定性评审和定量 benchmark 双维度验证 Skill 的实际价值。

核心指标：
- **Pass Rate**：断言通过率（客观可验证项）
- **Duration**：执行耗时（毫秒）
- **Token Usage**：token 消耗量

定性评审通过 eval-viewer 实现（用户点击审阅每个 test case 的输出），定量 benchmark 通过 aggregation 脚本自动计算。

**关键原则**：
- Baseline 的选择取决于场景：创建新 Skill 时用"无 Skill"，改进现有 Skill 时用"旧版本"
- 不要只跑 with-skill 版本——没有对照就无法证明改进
- 优先关注定性反馈（用户觉得哪里不好）而非只看数字

**适用场景**：Skill 迭代的核心验证方法。每次修改 SKILL.md 后都应运行。

**关联章节**：[Ch05-06](./Ch05-06.md)

---

### 4. Skill 三类模式

**定义**：Skill 按复杂度和依赖关系分为三种设计模式，每种有明确的适用场景和结构特征。

| 模式 | 特征 | 适用场景 | 例子 |
|------|------|---------|------|
| **独立 Skill** | 自包含，不依赖外部工具 | 通用工作流（代码生成、文档创建、研究流程） | superpowers 的 brainstorm、commit |
| **MCP 增强 Skill** | 依赖特定 MCP server 的 connector | 已有 MCP 工具但需要工作流封装 | 在 GitHub MCP 上层封装 PR 工作流 |
| **模板 Skill** | 主要提供 assets/ 中的模板文件 | 输出需要特定格式/样式 | UI 设计模板、文档模板 |

**关键原则**：
- 独立 Skill 是起点——先用独立 Skill 验证工作流，再考虑集成 MCP
- 模板 Skill 的 description 应明确说明"提供什么模板"而非"执行什么流程"
- "问题优先"设计：先定义用户需要解决的问题，再选择工具组合（vs "工具优先"：先选工具再找用法）

**适用场景**：选择 Skill 设计架构时的决策框架。

**关联章节**：[Ch07-08](./Ch07-08.md)

---

### 5. 五种核心 Skill 模式

**定义**：从实际使用中总结出的五种高价值 Skill 设计模式，覆盖不同的工作流需求。

1. **Sequential Workflow Orchestration**：按固定顺序编排多步骤流程。适用于流程明确的场景（如 CI/CD pipeline、文档生成流程）。
2. **Multi-MCP Coordination**：协调多个 MCP server 的工具调用。适用于需要跨系统操作的复杂场景。
3. **Iterative Refinement**：通过多轮反馈循环逐步改进输出。适用于创意工作（写作、设计、架构设计）。
4. **Context-Aware Tool Selection**：根据上下文动态选择最合适的工具。适用于工具丰富、选择困难的场景。
5. **Domain-Specific Intelligence**：封装特定领域的专业知识和最佳实践。适用于需要深度领域专长的场景（法律、医疗、金融）。

**适用场景**：设计新 Skill 时的灵感来源和参考架构。

**关联章节**：[Ch07-08](./Ch07-08.md)

---

### 6. 触发陷阱与根因诊断

**定义**：Skill 开发中三个最常见的失败模式及其根因分析。

| 失败模式 | 表现 | 常见根因 |
|---------|------|---------|
| 不触发（Undertriggering） | Claude 从不使用 Skill | Description 太模糊；任务太简单（Claude 能直接处理） |
| 过度触发（Overtriggering） | Skill 在不相关场景被触发 | Description 太宽泛；关键词匹配到不相关任务 |
| 指令不被遵循 | Skill 触发了但输出不对 | 指令位置不当（被长上下文淹没）；指令过于僵化（ALWAYS/NEVER 过多） |

**诊断方法**：
- Undertriggering → 检查 description 是否包含具体场景关键词；检查任务是否足够复杂
- Overtriggering → 检查 should-not-trigger eval 的通过率；收紧 description 的适用范围
- 指令不被遵循 → 检查 SKILL.md body 是否过长（>500 行）；将关键指令前移；用"解释为什么"替代"强制要求"

**适用场景**：Skill 调试和迭代的快速诊断工具。

**关联章节**：[Ch07-08](./Ch07-08.md)

---

## 模型关系图谱

```
                    ┌─────────────────────────┐
                    │  Progressive Disclosure    │
                    │  (第一性原则，所有模型基础)   │
                    └───────────┬─────────────┘
                                │
              ┌─────────────────┼─────────────────┐
              ▼                 ▼                 ▼
     Description 优化      对照实验验证      Skill 三类模式
     (触发准确率)        (价值验证)        (架构选择)
              │                 │                 │
              └─────────┬───────┘                 │
                        ▼                          ▼
                  五种 Skill 模式          触发陷阱诊断
                  (设计灵感源)          (快速调试)
```
