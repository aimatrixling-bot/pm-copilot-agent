# PM Copilot — Desktop AI PM Agent

面向 PM 的桌面端 AI Agent（Apache-2.0）。Tauri v2 + Claude Agent SDK，29 个 PM Skill + 23 本书方法论 KB。使用 Conventional Commits，不提交敏感信息。

## PM OS — 产品行为

四个角色：意图架构师 / 全栈合伙人 / 残酷诚实 / 项目守护者

核心公理：原型优先 > 文档优先。交付物导向 > 过程导向。状态驱动 > 文档驱动。残酷诚实。专业克制。

反合理化规则见 `bundled-agents/pm-copilot/CLAUDE.md`。

Main Loop：`Problem → Decision → Spec → Prototype → Delivery → Learning`

### 知识库路由

KB 根路径：`D:\Max Brain for AI Copilot\`。仅在生成 PM 交付物（PRD/竞品分析/原型等）时查 KB，读 `_index.md` 中 `[AI-STOP]` 之前。常规代码开发、bug 修复、UI 调整等任务不加载 KB。项目决策优先于通用方法论。

### Agent 编排

- **pm-copilot**（主 Agent）— 意图路由 + Skill 调用链，当前唯一运行 Agent
- **pm-spec-writer** / **pm-prototyper** / **pm-builder**（v2 计划，Fork）— 共享上下文
- **pm-researcher**（v2 计划，Spawn）— 独立研究
- **pm-reviewer**（v2 计划，Spawn）— 质量审查

当前所有功能通过 pm-copilot 主 Agent + 29 个 PM Skill 路由实现。路由表见 `bundled-agents/pm-copilot/CLAUDE.md`。

### 交付质量自检

每次交付前：回应真实意图？/ 具备可执行性？/ 与历史决策一致？/ 检测到潜在矛盾？

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面 | Tauri v2 (Rust) |
| 前端 | React 19 + TypeScript + Vite + TailwindCSS |
| 后端 | Bun + Claude Agent SDK (多实例 Sidecar) |
| 通信 | Rust HTTP/SSE Proxy (reqwest via `local_http`) |
| 运行时 | Bun（Agent/Sidecar）+ Node.js（MCP/社区工具），均内置 |

## 项目结构

- `src/renderer/` — React 前端
- `src/server/` — Bun 后端 Sidecar
- `src-tauri/` — Rust 桌面层
- `bundled-agents/pm-copilot/` — PM Agent（CLAUDE.md 路由器 + agents/ + skills/）
- `specs/` — 设计文档

## 开发命令

```bash
bun install                         # 依赖
npm run tauri:dev                   # 完整桌面开发
./build_dev.sh                      # Windows NSIS 构建（当前主平台）
npm run typecheck && npm run lint   # 质量检查
```

## 核心架构约束

### 必须先读

新功能开发前 MUST：读 `specs/tech_docs/architecture.md` → 读 `specs/guides/design_guide.md` → 搜索已有实现再复用。架构变更 MUST 先与用户讨论。

### 开发版本门控

- 修改 `bundled-agents/pm-copilot/` → MUST bump `ADMIN_AGENT_VERSION`（`src-tauri/src/commands.rs`）
- 修改 `src/cli/pm-copilot.*` → MUST bump `CLI_VERSION`（同文件）
- 修改 Skill 源码 → MUST cp 到 `~/.pm-copilot/skills/`（源码目录 ≠ 运行时目录）

### Claude Agent SDK

禁止凭假设写 SDK 代码。涉及 `query()` 参数、`SDKMessage` 类型、环境变量等，MUST 先查 `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` 或官方文档。

### Tab-scoped 隔离

Tab 内 MUST 用 `useTabState()` 的 `apiGet`/`apiPost`，禁止用全局 `apiPostJson`/`apiGetJson`。

### Rust 代理层

前端 HTTP/SSE MUST 通过 Rust 代理（invoke → reqwest → Sidecar），禁止 WebView 直接请求。

### local_http（致命陷阱）

连接 localhost 的 reqwest MUST 用 `crate::local_http::builder()` 系列（内置 `.no_proxy()`）。禁止裸 `reqwest::Client` 连 localhost — 系统代理（Clash/V2Ray）会导致 502。

### process_cmd

Rust 子进程 MUST 用 `crate::process_cmd::new()`（内置 Windows `CREATE_NO_WINDOW`）。禁止裸 `std::process::Command::new()`。

### proxy_config

子进程 spawn 前 MUST 调用 `crate::proxy_config::apply_to_subprocess(&mut cmd)`，确保 localhost 始终在 `NO_PROXY` 中。

### 持久 Session

中止 MUST 用 `abortPersistentSession()`，禁止直接设 `shouldAbortSession = true`。配置变更先设 `resumeSessionId` 再 abort。

### Pre-warm

pre-warm 就是最终 session。新增配置同步端点时，确保 `currentXxx` 变量在 pre-warm 前已设置。Tab MCP 由前端 `/api/mcp/set` 配置，Cron MCP 从磁盘 self-resolve，禁止混用。

### Config 持久化

写入 MUST 以磁盘为准（`await loadAppConfig()` 读最新再合并），禁止直接用 React `config` 状态写盘。

### 新增功能规范

- **Analytics 事件** — MUST 在 `analytics/types.ts` 的 `EventName` 注册
- **Provider 推荐** — `recommendedProviders.ts` 的 id MUST 与 `PRESET_PROVIDERS` 匹配
- **Overlay/面板** — MUST 调用 `useCloseLayer(handler, zIndex)`
- **遮罩层** — MUST 用 `<OverlayBackdrop>`，禁止手写 onClick

## 禁止事项速查

| 禁止 | 正确做法 |
|------|---------|
| 依赖用户系统运行时 | 用内置 Bun / 内置 Node.js（`runtime.ts`） |
| 新增 SSE 事件不注册白名单 | `SseConnection.ts` 的 `JSON_EVENTS` 注册 |
| Sidecar 用 `__dirname` / `readFileSync` | 内联常量或 `getScriptDir()` |
| 日志日期用 UTC `toISOString` | `localDate()`（`src/shared/logTime.ts`） |
| Rust 日志用 `log::info!` | `ulog_info!` / `ulog_error!` |
| 裸 `which::which()` | `crate::system_binary::find()` |
| 前端 `@tauri-apps/plugin-fs` 读写工作区 | `invoke('cmd_read_workspace_file')` |
| UI 硬编码颜色 | CSS Token `var(--xxx)` |
| 表单用原生 `<select>` | `<CustomSelect>` 组件 |
| 函数参数用 `undefined` 表示业务动作 | 用自解释字面量 |

## 日志排查

统一日志 `~/.pm-copilot/logs/unified-{YYYY-MM-DD}.log`。AI 异常搜 `[agent]`/`pre-warm`/`timeout`。Rust 层额外查 `%LOCALAPPDATA%\com.ai-matrix.site\PM Copilot.log`（Windows）。

## 文档维护

以下时机 SHOULD 提醒用户"是否需要更新文档"：
- 大功能完成（新组件/新模块/新 Skill）
- 架构决策变更（新增约束/修改技术栈）
- 阶段切换（Phase 完成）

用户说"更新文档"时，按此清单检查：

| 文档 | 何时更新 | 路径 |
|------|---------|------|
| 项目 Memory | 阶段完成、架构决策、重要发现 | `~/.claude/projects/.../memory/pm-copilot-agent.md` |
| Plan 文件 | 计划执行完毕或重大变更 | `~/.claude/plans/*.md` |
| CHANGELOG | 每次有用户可见变更 | `src/CHANGELOG.md` |
| README | 功能列表/状态/版本号变化 | `src/README.md` + `src/README_EN.md` |
| CLAUDE.md | 架构约束/禁止事项/版本门控变化 | 本文件 |

原则：文档反映实际，不反映愿望。已过时的信息比没有信息更危险。

## Git 工作流

- 提交前 MUST：`npm run typecheck`，检查当前分支
- 分支：`dev/x.x.x` → `main`。MUST NOT 在 main 直接提交
- Commit：Conventional Commits

## 发布流程（MUST 每次完整执行）

用户要求发布新版本时，MUST 按以下清单完整执行，不跳步、不遗漏：

| # | 步骤 | 命令/操作 | 自动化 |
|---|------|-----------|--------|
| 1 | bump 版本 | `package.json` + `tauri.conf.json` + `Cargo.toml` + `commands.rs` (`ADMIN_AGENT_VERSION`) | 手动 |
| 2 | 更新 CHANGELOG | 添加版本条目 | 手动 |
| 3 | commit + tag | `git commit` + `git tag vX.Y.Z` + `git push` | 手动 |
| 4 | 构建安装包 | `.\scripts\publish_github.ps1` | **一键脚本** |
| 5 | 同步 Skills 到运行时 | cp `bundled-agents/pm-copilot/.claude/skills/*` → `~/.pm-copilot/skills/` | 手动 |
| 6 | 同步 Skills 到 npm | `bash sync-and-publish.sh`（pm-copilot-skills 仓库） | 手动 |

**步骤 4 已自动化**：`publish_github.ps1` 一键完成构建 → 签名 → GitHub Release → gh-pages 更新清单 → 清理旧 artifacts。

## gh-pages 更新机制

- **模式**：GitHub Pages `build_type: legacy`（直接从分支部署，无需 Actions workflow）
- **行为**：推送 `gh-pages` 分支后 GitHub 自动部署
- **清单路径**：`gh-pages` 分支 `update/windows-x86_64.json`
- **脚本自动处理**：`publish_github.ps1` 步骤 6 自动 clone gh-pages → 更新 manifest → push

## 深度文档

- 架构：`specs/tech_docs/architecture.md`
- CLI：`specs/tech_docs/cli_architecture.md`
- React 规范：`specs/tech_docs/react_stability_rules.md`
- 设计系统：`specs/guides/design_guide.md`
- 多 Agent Runtime：`specs/tech_docs/multi_agent_runtime.md`
