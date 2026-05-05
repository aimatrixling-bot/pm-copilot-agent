<div align="center">

# PM Copilot

**从问题定义到产品交付，你的全栈 PM AI 合伙人**

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Status](https://img.shields.io/badge/状态-Beta-orange.svg)]()

[English](./README_EN.md) | 中文

</div>

---

## 这是什么

PM Copilot 是一款**桌面端 AI 产品管理工具**。它将经典产品方法论知识库、结构化 PM 工作流和 AI 推理能力结合在一个本地运行的应用中，覆盖从问题定义到复盘回顾的完整 PM 生命周期。

**核心定位**：基于方法论深度的专业 PM 工具。

**当前版本**：Beta（v0.2.6）

> **注意**：PM Copilot 需要用户自备 AI API Key（支持 DeepSeek、智谱 AI、SiliconFlow、Anthropic 等）。应用不内置 AI 服务，所有数据本地存储。

## 核心差异化

| 维度 | 通用 AI 工具 | PM Copilot |
|------|------------|-----------|
| 运行环境 | 浏览器 / 云端 | 桌面端（本地） |
| 数据隐私 | 上传到云端 | 本地存储，不上传 |
| 方法论深度 | 依赖 prompt 技巧 | 内嵌经典方法论 + 结构化 Skill |
| 覆盖范围 | 单点（如 PRD 生成） | 全 PM 生命周期（13 个阶段） |

## PM Skills

PM Copilot 的 Skills 按 PM 主循环的阶段组织，覆盖从问题定义到复盘回顾的完整流程：

| 阶段 | Skill | 能力 |
|------|-------|------|
| **问题定义** | `pm-problem-frame` | 问题框架化与验证 |
| **决策分析** | `pm-rice` | RICE 优先级排序 |
| | `pm-decision` | 多框架决策分析 |
| **产品规格** | `pm-prd` | 结构化 PRD 生成 |
| | `pm-tech-spec` | 技术规格文档 |
| | `pm-solution-brief` | 500 字方案概要 |
| | `pm-eng-request` | 工程需求文档 |
| **市场研究** | `pm-comp` | 多维度竞品分析 |
| | `pm-ai-patterns` | AI 产品模式库 |
| | `pm-strategy-session` | 战略研讨 |
| **用户画像** | `pm-persona` | 证据分级用户画像 |
| **迭代规划** | `pm-roadmap` | 产品路线图 |
| | `pm-backlog` | INVEST 标准 Backlog |
| **原型设计** | `pm-prototype` | 高保真可交互原型 |
| | `pm-wireframe` | 低保真线框图 |
| **验证测试** | `pm-experiment` | 实验设计 |
| | `pm-metrics` | 指标体系设计 |
| | `pm-testing` | 可用性测试计划 |
| **质量审查** | `pm-critique` | 双模式评审（Review + Devil's Advocate） |
| **交付上线** | `pm-launch` | 发布清单与策略 |
| | `pm-sync` | 项目状态同步 |
| **增长探索** | `pm-ost` | PM 技能树评估 |
| | `pm-job-search` | PM 求职策略 |
| **数据分析** | `pm-data-analysis` | 7 合 1 数据分析（快照/漏斗/归因/留存/诊断/根因） |
| **紧急响应** | `pm-urgent` | 紧急场景快速澄清与决策 |
| **复盘回顾** | `pm-retro` | 4 种回顾方法 |
| **端到端工作流** | `pm-discovery` | 产品发现（反合理化） |
| | `pm-feature-cycle` | 功能全周期 |
| | `pm-writer-pipeline` | 内容创作流水线 |

每个 Skill 内嵌方法论 references（如评分校准指南、输出模板、质量清单），而非纯文本 prompt。

## 快速开始（用户）

### 1. 安装

下载最新安装包：
- **Windows**：[PM Copilot Setup.exe](https://github.com/aimatrixling-bot/pm-copilot-agent/releases)
- **macOS**：即将推出

系统要求：Windows 10+（需 WebView2）

### 2. 配置 AI 模型

首次启动时，Setup Wizard 会引导你完成配置：
1. 选择 AI 服务商（推荐 DeepSeek / 智谱 AI / SiliconFlow — 注册即有免费额度）
2. 输入 API Key
3. 验证连接

### 3. 开始使用

输入斜杠命令调用 Skill：
```
/pm-prd 请帮我创建一个产品需求文档
/pm-comp 分析 Notion 和 Obsidian 的竞品差异
/pm-prototype 生成一个任务管理的原型
```

## 从源码构建（开发者）

```bash
# 前置依赖：Node.js 18+, Bun, Rust
git clone https://github.com/aimatrixling-bot/pm-copilot-agent.git
cd pm-copilot-agent/src
bun install

# 开发模式
npm run tauri:dev

# 构建验证
npx tsc --noEmit
npx vite build
```

## 技术架构

```
┌─────────────────────────────────────────────┐
│                PM Copilot 桌面端              │
├──────────────┬──────────────┬───────────────┤
│  Tauri v2    │   React +    │   Bun +       │
│  (Rust)      │   TypeScript │   Agent SDK   │
│  桌面框架     │   前端 UI    │   Agent 运行时  │
├──────────────┴──────────────┴───────────────┤
│  PM Skills + Agents + 方法论知识库           │
└─────────────────────────────────────────────┘
         │                    │
    本地文件系统          AI API (用户自备)
    (配置/工作区)     (DeepSeek/智谱/Anthropic/...)
```

| 组件 | 技术 | 说明 |
|------|------|------|
| 桌面框架 | Tauri v2 (Rust) | 轻量、安全、跨平台 |
| 前端 | React + TypeScript + TailwindCSS | 响应式 UI |
| Agent 运行时 | Bun + Claude Agent SDK | Skill 执行引擎 |
| Agent 编排 | Fork (共享上下文) + Spawn (独立上下文) | 多 Agent 协作 |
| 方法论知识库 | PM 经典著作提炼 | Key_Models.md 本地嵌入 |

## 项目结构

```
pm-copilot-agent/
├── src/
│   ├── bundled-agents/pm-copilot/
│   │   ├── CLAUDE.md               # 主 Agent 路由器
│   │   ├── agents/                 # 5 个子 Agent
│   │   │   ├── pm-spec-writer/     # 规格撰写
│   │   │   ├── pm-prototyper/      # 原型生成
│   │   │   ├── pm-builder/         # 构建执行
│   │   │   ├── pm-researcher/      # 研究分析
│   │   │   └── pm-reviewer/        # 质量审查
│   │   └── .claude/skills/         # PM Skills
│   ├── src-tauri/                  # Rust 桌面端
│   ├── src/renderer/               # React 前端
│   └── specs/                      # 技术文档
├── site/                           # 官网 (ai-matrix.site)
└── validation/                     # 评估体系
```

## 诚实清单

以下是我们**已经实现**和**尚未实现**的功能，避免误导：

**已实现**：
- PM Skills 覆盖 13 个阶段（带 references 和输出模板）
- 多 Agent 协作（prompt 级别，通过 pm-copilot 路由调用）
- 方法论知识库（经典 PM 著作提炼）
- Skill Browser 全屏技能浏览器
- Setup Wizard 首次配置引导
- Coco — 开箱即用的 PM AI 合伙人（预填身份 + 可个性化）
- Windows 安装包（NSIS）
- 评估体系（22 个黄金测试用例）

**尚未实现**：
- macOS 安装包
- 结构化输出视图（当前以 Markdown 展示）
- 导出为 PDF/DOCX
- 云端同步 / 多设备
- 用户注册 / 社区

## 贡献

欢迎贡献！详见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 许可证

[Apache License 2.0](./LICENSE)

---

<div align="center">
  <sub>Built with Tauri + Claude Agent SDK. Forked from <a href="https://github.com/hAcKlyc/MyAgents">MyAgents</a>.</sub>
</div>
