<div align="center">

# PM Copilot

**From problem framing to product delivery — your full-stack PM AI partner**

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Status](https://img.shields.io/badge/Status-Beta-orange.svg)]()

English | [中文](./README.md)

</div>

---

## What is this?

PM Copilot is a **desktop AI product management tool**. It combines PM methodology (23-book knowledge base), structured workflows (27 Skills), and AI reasoning in a locally-run application, covering the full PM lifecycle from problem framing to retrospective.

**Core positioning**: Not a generic AI chatbot repackaged for PMs, but a methodology-driven professional PM tool.

**Current version**: Beta (v0.2.0)

> **Note**: PM Copilot requires users to bring their own AI API key (DeepSeek, Zhipu AI, SiliconFlow, Anthropic, etc.). The app does not include AI services. All data is stored locally.

## Key Differentiators

| Dimension | Generic AI Tools | PM Copilot |
|-----------|-----------------|-----------|
| Platform | Browser / Cloud | Desktop (local) |
| Data Privacy | Uploaded to cloud | Local storage, never uploaded |
| Methodology | Relies on prompt tricks | 23-book KB + structured Skills |
| Coverage | Single-point (e.g., PRD only) | Full PM lifecycle (13 stages) |

## 27 PM Skills

PM Copilot's 27 Skills are organized by 13 stages of the PM Main Loop:

| Stage | Skill | Capability |
|-------|-------|-----------|
| **Problem Framing** | `pm-problem-frame` | Problem framing & validation |
| **Decision** | `pm-rice` | RICE prioritization |
| | `pm-decision` | Multi-framework decision analysis |
| **Specification** | `pm-prd` | Structured PRD generation |
| | `pm-tech-spec` | Technical specification |
| | `pm-solution-brief` | 500-word solution brief |
| | `pm-eng-request` | Engineering request |
| **Research** | `pm-comp` | Multi-dimensional competitive analysis |
| | `pm-ai-patterns` | AI product pattern library |
| | `pm-strategy-session` | Strategy workshop |
| **Persona** | `pm-persona` | Evidence-graded user personas |
| **Planning** | `pm-roadmap` | Product roadmap |
| | `pm-backlog` | INVEST-standard backlog |
| **Prototype** | `pm-prototype` | High-fidelity interactive prototype |
| | `pm-wireframe` | Low-fidelity wireframe |
| **Validation** | `pm-experiment` | Experiment design |
| | `pm-metrics` | Metrics framework design |
| | `pm-testing` | Usability test plan |
| **Quality** | `pm-critique` | Dual-mode review (Review + Devil's Advocate) |
| **Delivery** | `pm-launch` | Launch checklist & strategy |
| | `pm-sync` | Project status sync |
| **Growth** | `pm-ost` | PM skill tree assessment |
| | `pm-job-search` | PM job search strategy |
| **Retrospective** | `pm-retro` | 4 retrospective methods |
| **E2E Workflow** | `pm-discovery` | Product discovery (anti-rationalization) |
| | `pm-feature-cycle` | Feature full-cycle |
| | `pm-writer-pipeline` | Content creation pipeline |

Each Skill embeds methodology references (scoring guides, output templates, quality checklists) — not just plain text prompts.

## Quick Start (Users)

### 1. Install

Download the latest installer:
- **Windows**: [PM Copilot Setup.exe](https://github.com/aimatrixling-bot/pm-copilot-agent/releases)
- **macOS**: Coming soon

System requirements: Windows 10+ (requires WebView2)

### 2. Configure AI Model

On first launch, the Setup Wizard guides you through:
1. Choose an AI provider (recommended: DeepSeek / Zhipu AI / SiliconFlow — free tier available)
2. Enter your API key
3. Verify connection

### 3. Start Using

Invoke Skills with slash commands:
```
/pm-prd Create a product requirements document for a task management app
/pm-comp Analyze competitive differences between Notion and Obsidian
/pm-prototype Generate a task management prototype
```

## Build from Source (Developers)

```bash
# Prerequisites: Node.js 18+, Bun, Rust
git clone https://github.com/aimatrixling-bot/pm-copilot-agent.git
cd pm-copilot-agent/src
bun install

# Development mode
npm run tauri:dev

# Build verification
npx tsc --noEmit
npx vite build
```

## Architecture

```
┌─────────────────────────────────────────────┐
│              PM Copilot Desktop              │
├──────────────┬──────────────┬───────────────┤
│  Tauri v2    │   React +    │   Bun +       │
│  (Rust)      │   TypeScript │   Agent SDK   │
│  Desktop     │   Frontend   │   Agent       │
│  Framework   │   UI         │   Runtime     │
├──────────────┴──────────────┴───────────────┤
│  27 PM Skills + 5 Agents + 23 Books KB      │
└─────────────────────────────────────────────┘
         │                    │
    Local Filesystem     AI API (BYOK)
    (Config/Workspace)   (DeepSeek/Zhipu/Anthropic/...)
```

| Component | Technology | Description |
|-----------|-----------|-------------|
| Desktop | Tauri v2 (Rust) | Lightweight, secure, cross-platform |
| Frontend | React + TypeScript + TailwindCSS | Responsive UI |
| Agent Runtime | Bun + Claude Agent SDK | Skill execution engine |
| Agent Orchestration | Fork (shared context) + Spawn (isolated) | Multi-agent collaboration |
| Methodology KB | 23 classic PM books | Key_Models.md local embeddings |

## Project Structure

```
pm-copilot-agent/
├── src/
│   ├── bundled-agents/pm-copilot/
│   │   ├── CLAUDE.md               # Main Agent router
│   │   ├── agents/                 # 5 sub-Agents
│   │   │   ├── pm-spec-writer/     # Specification writer
│   │   │   ├── pm-prototyper/      # Prototype generator
│   │   │   ├── pm-builder/         # Build executor
│   │   │   ├── pm-researcher/      # Research analyst
│   │   │   └── pm-reviewer/        # Quality reviewer
│   │   └── .claude/skills/         # 27 PM Skills
│   ├── src-tauri/                  # Rust desktop
│   ├── src/renderer/               # React frontend
│   └── specs/                      # Technical docs
├── site/                           # Website (ai-matrix.site)
└── validation/                     # Evaluation framework
```

## Honesty Checklist

What we **have** and **have not** implemented — no overselling:

**Implemented**:
- 27 PM Skills (with references and output templates)
- 5 Agents (prompt-level, routed through pm-copilot)
- 23-book methodology knowledge base
- Skill Browser (full-screen skill explorer)
- Setup Wizard (first-run configuration guide)
- Daily Briefing / Coaching mode / Discovery persistence
- Windows installer (NSIS)
- Evaluation framework (22 golden test cases)

**Not yet implemented**:
- macOS installer
- Structured output view (currently Markdown display)
- PDF/DOCX export
- Cloud sync / multi-device
- User registration / community

## Contributing

Contributions welcome! See [CONTRIBUTING.md](./CONTRIBUTING.md) for details.

## License

[Apache License 2.0](./LICENSE)

---

<div align="center">
  <sub>Built with Tauri + Claude Agent SDK. Forked from <a href="https://github.com/hAcKlyc/MyAgents">MyAgents</a>.</sub>
</div>
