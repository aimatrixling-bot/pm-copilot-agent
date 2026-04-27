# Changelog

All notable changes to PM Copilot Agent will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> PM Copilot Agent is forked from [MyAgents](https://github.com/hAcKlyc/MyAgents).
> The upstream changelog is preserved at [UPSTREAM_CHANGELOG.md](./UPSTREAM_CHANGELOG.md).

---

## [0.2.1] - 2026-04-24

### Added
- Skill 整合：35→29 Skills（升级 2 + 合并 4 + 删除 2）
  - 升级为核心: pm-data-analysis（+Core Principle/Scope Gate/保真度/references）, pm-urgent（+紧急保真度/Q&E Entry Mode/决策记录模板）
  - 合并入核心: pm-architecture→pm-wireframe(IA Mode), pm-pricing→pm-decision(定价框架), pm-business-model→pm-strategy-session(商业模式主题), pm-strategic-planning→pm-roadmap(3H+OKR)
  - 删除: pm-leadership, pm-portfolio（内容过薄）
- Auto Memory 默认开启（types.rs enabled:true, threshold:3）
- PM Debug Guide: 四类根因 PM 场景映射（Context 缺失/饱和、指令歧义、能力边界）
- KB 场景索引: pm-theory-kb/_index.md 23 本书按 7 场景索引
- quality-gates-shared.md: 新增第七节"用户不满诊断引导"
- Agent CLAUDE.md: 新增 Natural Breakpoint Challenge + 用户不满处理 + KB 路由规则
- pmLifecycleMapping.ts: 新增 data/emergency 两个生命周期阶段
- pm-data-analysis/references/data-analysis-framework.md: 分析类型决策树 + 统计方法速查
- pm-wireframe/references/ia-analysis-guide.md: 卡片分类 + 导航模式 + IA 验证方法
- pm-decision/references/pricing-framework.md: 4 种定价模型 + 定价心理学
- pm-strategy-session/references/business-model-templates.md: 商业模式画布 + 精益画布
- pm-roadmap/references/strategic-planning.md: 3H 模型 + OKR 对齐

### Changed
- ADMIN_AGENT_VERSION: pm-13 → pm-14
- 前端/后端/Settings UI 中 "27 个 Skill" 统一更新为 "29 个 Skill"
- Agent CLAUDE.md 路由表: 新增数据分析 + 紧急响应路由
- pm-copilot.md (A 端): 移除 6 个扩展 Skill 路由，更新为核心 Skill 路由
- sync-to-claude-code.ps1: 清空 $EXTENDED_SKILLS（全部合并为核心）

### Fixed
- NSIS installer 模板: 修正 Git-Installer.exe 相对路径（适配 target/release/nsis/x64/ 布局）

---

## [0.2.0] - 2026-04-22

### Added
- Setup Wizard: 全屏引导向导（3 步：选 Provider → 验证 Key → 开始使用），无 Provider 时自动弹出
  - `SetupWizard.tsx`, `ProviderSetupCard.tsx`, `recommendedProviders.ts`
  - 4 个推荐 Provider（DeepSeek / 智谱 AI / SiliconFlow / Anthropic）
  - 5 个 Analytics 事件（setup_wizard_open/step/verified/complete/quick_start）
- doc-consistency-check skill: 通用项目文档一致性检查（增量 + 全量模式），可被 PreCompact hook 自动触发
- PreCompact hook: 上下文压缩前自动提醒文档更新检查
- Coco: 开箱即用的 PM AI 合伙人（替代 Mino 通用模板）
  - 预填 PM 专业身份（IDENTITY/SOUL/USER/MEMORY）
  - `/CUSTOMIZE` 命令替代 `/BOOTSTRAP`，轻量个性化（6 个 MECE 维度）
  - 精简 skill 至 9 个 PM 相关（移除 apple-notes、peekaboo 等 macOS-only）
  - 前端 displayName: Mino → Coco
- 对话输出格式协议（quality-gates-shared.md）
  - 按产出类型区分格式约束（文档类 Markdown / 原型类按技术栈 / 导出类按目标格式）
  - 修复 `<generative-ui-widget>` 标签出现在文本输出的问题

### Changed
- CLAUDE.md 从 302 行压缩至 165 行（保留所有 MUST/禁止规则）
  - 新增 3 条版本门控规则（ADMIN_AGENT_VERSION / CLI_VERSION / Skill cp）
  - 新增 Analytics 事件注册 + Provider ID 匹配要求
  - KB 路由改为"仅在生成 PM 交付物时查 KB"
  - 新增"文档维护"触发清单
- README.md / README_EN.md 全面重写（Beta 定位 + 27 Skill 表 + 诚实清单）
  - 诚实清单修正：移除 Daily Briefing（已确认为死代码），新增 Coco
- BrandSection.tsx 集成 SetupWizard（useRef + useEffect 防止重触发）
- CLAUDE.md (pm-copilot agent) 结构性重构：
  - Iron Law 清单合并为 10 条单一来源（消除 3 处分散定义）
  - 完全移除 Daily Briefing 死代码（58 行，代码层面从未实现）
  - pm-critique 路由分流条件明确化（轻量评审 vs 深度审查）
  - Pre-flight/Post-delivery 增加任务分级（简单/标准/复杂）
  - Entry Mode 推断规则从 5 条精简为 3 条可执行规则
  - 新增降级策略（5 种失败场景的 fallback 行为）
- pm-discovery SKILL.md 清理 Daily Briefing 引用
- ADMIN_AGENT_VERSION 升级至 pm-13

## [0.1.0] - 2026-04-10

### Added
- Initial fork from MyAgents with PM Copilot branding
- 27 PM Skill prompts (pm-prd, pm-comp, pm-prototype, etc.)
- 5 Agent prompt files (pm-spec-writer, pm-prototyper, pm-builder, pm-researcher, pm-reviewer)
- PM Copilot brand logo and app icons
- Frontend and TypeScript build verified
