# PM Copilot Agent — 集中 Backlog

> **版本**: v0.2.7 | **更新日期**: 2026-05-07
>
> 所有 Pending 项的单一来源。各文档中的 Pending 引用应指向此文件。

---

## P0 — 阻塞项（必须解决）

| # | 来源 | 描述 | 状态 |
|---|------|------|------|
| B-01 | Eval 回归 | AB Eval 40% 失败率需回归验证（降级策略修复后） | 待验证 |
| B-02 | 模型兼容 | 5 个 Provider 模型兼容性矩阵（需手动测试） | 待测试 |

---

## P1 — 近期改进

| # | 来源 | 描述 | 状态 |
|---|------|------|------|
| B-03 | 诚实清单 | macOS 安装包 | 待开发 |
| B-04 | 诚实清单 | 结构化输出视图（当前 Markdown display） | 待规划 |
| B-05 | 诚实清单 | PDF/DOCX 导出 | 技术规格待写 |
| B-06 | 架构文档 | architecture.md 从 v0.1.60 更新到 v0.2.7 | 待更新 |
| B-07 | Onboarding | 首次使用引导（文档 + Agent 行为层） | 待实施 |
| B-08 | Eval | eval-v3 操作指南 | ✅ 已完成（`specs/guides/eval-v3-smoke-guide.md`） |
| B-09 | README | README_EN.md 版本号/Skill 表/eval 描述修复 | ✅ 已完成 |

---

## P2 — 中期优化

| # | 来源 | 描述 | 状态 |
|---|------|------|------|
| B-10 | 诚实清单 | 云同步 / 多设备 | 待规划 |
| B-11 | 诚实清单 | 用户注册 / 社区 | 待规划 |
| B-12 | Skill 质量 | Skill 质量反馈 GitHub issue template | 待创建 |
| B-13 | Skill 压缩 | pm-gap-analysis / pm-urgent SKILL.md 压缩评估 | 待评估 |
| B-14 | 产品评审 | 自然断点挑战的个性化增强（基于 MEMORY 偏好） | 待规划 |
| B-15 | 产品评审 | 保真度自动推断精度提升 | 待规划 |

---

## 残留引用清理（非阻塞）

Daily Briefing 已在 v0.2.0 确认为死代码并删除，但以下文件仍有残留引用：

| 文件 | 引用类型 | 影响 |
|------|---------|------|
| `validation/eval-v3/plan-registry/` | 文件名/内容 | 无功能影响 |
| `validation/eval-v3/spec-registry/` | 文件名/内容 | 无功能影响 |
| `validation/eval-v3/_index/` | 文件名/内容 | 无功能影响 |
| `validation/eval-v3/validation-registry/` | 文件名/内容 | 无功能影响 |
| `validation/eval-v3/run-client-eval.ts` | 变量/注释 | 无功能影响 |
| `validation/eval-v3/eval-v3-sidecar.test.*` | 测试内容 | 无功能影响 |

**决策**: 不主动清理（避免引入不必要的变更），仅在相关文件被修改时顺带清理。

---

## v2 规划项（不在当前迭代范围）

| 来源 | 描述 | 前置依赖 |
|------|------|---------|
| CLAUDE.md | Fork/Spawn 子 Agent 编排 | Agent SDK 多实例支持 |
| CLAUDE.md | Quality Gates L3 Coaching | Fork/Spawn 实现 |
| CLAUDE.md | BM25 知识检索 | Claude 原生能力或自建索引 |
| CHANGELOG | Onboarding 4 步引导完整版 | UI 组件 + Agent 行为 |

---

## 已完成（近期）

| 版本 | 描述 | 日期 |
|------|------|------|
| v0.2.7 | Eval Runner 稳定性（路由竞态修复 + 超时保护） | 2026-05-05 |
| v0.2.7 | SKILL.md 内容压缩（10 个 Skill） | 2026-05-05 |
| v0.2.7 | Agent AbortController 超时保护 | 2026-05-05 |
| v0.2.6 | Skill 按需加载（147K→25-30K tokens） | 2026-05-05 |
| v0.2.6 | Iron Law BM-2 信息充足性分级 | 2026-05-05 |
| v0.2.5 | 29 PM Skills 质量基础设施（Hard Bans + Source Attribution） | 2026-04-29 |
| v0.2.5 | Tier 2 深度能力增强（约束翻译/深度研究/Brand Voice） | 2026-04-29 |
| v0.2.4 | Session 切换 bug 修复 | 2026-04-29 |
| v0.2.4 | eval-v3 smoke pack 8 P0 case | 2026-04-29 |
| v0.2.3 | Auto-update 签名修复 | 2026-04-27 |
| v0.2.3 | KB 三级渐进查询 | 2026-04-27 |
| v0.2.2 | GitHub-based auto-update | 2026-04-27 |
| v0.2.1 | Skill 整合 35→29 | 2026-04-24 |
| v0.2.0 | Setup Wizard + Coco | 2026-04-22 |

---

## 使用说明

- **新增条目**: 添加到对应优先级表，标注来源
- **状态更新**: 修改状态列（待开发 → 进行中 → ✅ 已完成）
- **完成后**: 移到"已完成"表，更新日期
- **引用**: 其他文档中的 Pending 项应指向此文件 + 条目编号（如 `B-03`）
