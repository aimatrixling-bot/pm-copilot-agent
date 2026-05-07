/**
 * Unified system prompt assembly for PM Copilot.
 *
 * Three-layer prompt architecture:
 *   L1 — Base identity (always included)
 *   L2 — Interaction channel (desktop vs IM, mutually exclusive)
 *   L3 — Scenario instructions (cron-task / heartbeat, stacked as needed)
 *
 * Template content is inlined below (not loaded from filesystem) because
 * bun build hardcodes __dirname at compile time, breaking production builds.
 */

// ===== Scenario types =====

export type InteractionScenario =
  | { type: 'desktop' }
  | { type: 'im'; platform: 'telegram' | 'feishu' | 'dingtalk'; sourceType: 'private' | 'group'; botName?: string }
  | { type: 'agent-channel'; platform: string; sourceType: 'private' | 'group'; botName?: string; agentName?: string }
  | { type: 'cron'; taskId: string; intervalMinutes: number; aiCanExit: boolean };

// ===== Inline templates =====

const TMPL_BASE_IDENTITY = `<pm-copilot-identity>
你正运行在 PM Copilot —— 一款基于 Claude Agent SDK 的桌面端 AI Agent 应用中。
用户全局配置目录: ~/.pm-copilot
当对话涉及日期、时间或星期时，先用 Bash 执行 \`date\` 获取准确的当前时间再作判断——系统信息中的日期可能已过期。
</pm-copilot-identity>`;

const TMPL_CHANNEL_DESKTOP = `<pm-copilot-interaction-channel>
用户正通过 PM Copilot 桌面客户端与你对话。
</pm-copilot-interaction-channel>`;

const TMPL_CHANNEL_IM = `<pm-copilot-interaction-channel>
你正通过 {{platformLabel}} 作为 IM 聊天机器人与用户对话，{{sourceTypeLabel}}。{{#if botName}}你的昵称为「{{botName}}」。{{/if}}
</pm-copilot-interaction-channel>`;

const TMPL_CRON_TASK = `<pm-copilot-cron-task-instructions>
你正处于心跳循环任务模式 (Task ID: {{taskId}})。每隔 {{intervalText}} 系统触发唤醒你一次。
{{#if aiCanExit}}

如果任务目标已完全达成，无需继续定时执行，请调用 \`mcp__cron-tools__exit_cron_task\` 工具来结束任务。
{{/if}}
</pm-copilot-cron-task-instructions>`;

const TMPL_HEARTBEAT = `<pm-copilot-heartbeat-instructions>
You will periodically receive heartbeat messages (a user message wrapped in tags like \`<HEARTBEAT>\\nThis is a heartbeat from the system.\\n……\\n</HEARTBEAT>\`).
When you receive one, follow its instructions.
</pm-copilot-heartbeat-instructions>`;

const TMPL_GENERATIVE_UI = `<pm-copilot-generative-ui>
你可以在对话中生成交互式可视化内容（图表、架构图、流程图、交互式工具等）。
流程：先调用 widget_read_me 工具加载设计指南和输出格式说明，然后按照指南在文本中使用 <generative-ui-widget> 标签输出可视化内容。
当用户的请求适合用可视化形式呈现时，主动使用，而不是只输出纯文本描述。
不要对简单的文本回答或普通代码展示使用此功能。
</pm-copilot-generative-ui>`;

const TMPL_BROWSER_STORAGE_STATE = `<pm-copilot-browser-storage-instructions>
当你在浏览器中执行了登录操作或用户帮你完成了登录（输入账号密码、OAuth 授权、扫码登录等），必须在登录成功后**立即**调用 browser_storage_state 工具将登录状态保存到 ~/.pm-copilot/browser-storage-state.json，然后再继续执行后续任务。这样即使后续任务中断或会话异常终止，登录态也不会丢失，后续对话可以复用。
</pm-copilot-browser-storage-instructions>`;

const TMPL_SKILL_SUGGESTIONS = `<pm-copilot-skill-suggestions>
根据关键词匹配，以下 Skill 可能与当前用户意图相关：{{skillList}}
你可以自主决定是否调用这些 Skill，或选择更合适的方式处理用户请求。
</pm-copilot-skill-suggestions>`;

const TMPL_SUB_AGENTS = `<pm-copilot-sub-agents>
你可以通过 Task 工具将子任务分派给专业子 Agent。每个子 Agent 运行在独立上下文中，完成后返回结构化摘要。

可用子 Agent：
{{agentList}}

使用原则：
- 研究类任务（竞品分析、市场调研、技术选型）→ 分派给 pm-researcher
- 子 Agent 完成后会返回摘要，你可以基于摘要继续主对话
- 不要手动拼装子 Agent 的输出格式，直接使用返回的摘要
- 简单查询不需要分派，直接回答即可
</pm-copilot-sub-agents>`;

// ===== Variable replacement =====
// Supports {{varName}} simple substitution + {{#if varName}}...{{else}}...{{/if}} conditional blocks

function renderTemplate(template: string, vars: Record<string, string>): string {
  let result = template;
  // Conditional blocks: {{#if key}}...{{else}}...{{/if}} or {{#if key}}...{{/if}}
  result = result.replace(
    /\{\{#if (\w+)\}\}([\s\S]*?)(?:\{\{else\}\}([\s\S]*?))?\{\{\/if\}\}/g,
    (_, key, ifBlock, elseBlock) => vars[key] ? ifBlock : (elseBlock ?? '')
  );
  // Simple variable substitution
  result = result.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
  return result;
}

// ===== Main entry =====

export interface SystemPromptOptions {
  /** Whether Playwright MCP with storage capability is enabled in this session */
  playwrightStorageEnabled?: boolean;
  /** Whether Generative UI (widget_read_me + <widget> tags) is enabled in this session */
  generativeUiEnabled?: boolean;
  /** Skill names suggested by the keyword router (hints, not hard constraints) */
  suggestedSkills?: string[];
  /** Available sub-agents for Task dispatch (name → description) */
  availableAgents?: Record<string, string>;
}

export function buildSystemPromptAppend(scenario: InteractionScenario, options?: SystemPromptOptions): string {
  const parts: string[] = [];

  // L1: Base identity (always)
  parts.push(TMPL_BASE_IDENTITY);

  // L2: Interaction channel (mutually exclusive)
  if (scenario.type === 'im' || scenario.type === 'agent-channel') {
    const platformMap: Record<string, string> = { feishu: '飞书', telegram: 'Telegram', dingtalk: '钉钉' };
    const platformLabel = platformMap[scenario.platform] ?? scenario.platform;
    const sourceTypeLabel = scenario.sourceType === 'private' ? '私聊模式' : '群聊模式';
    parts.push(renderTemplate(TMPL_CHANNEL_IM, {
      botName: scenario.botName ?? '',
      platformLabel,
      sourceTypeLabel,
    }));
  } else {
    // desktop and cron both use desktop channel
    parts.push(TMPL_CHANNEL_DESKTOP);
  }

  // L3: Scenario instructions (stacked as needed)
  if (scenario.type === 'cron') {
    const intervalText = scenario.intervalMinutes >= 60
      ? `${Math.floor(scenario.intervalMinutes / 60)} 小时${scenario.intervalMinutes % 60 > 0 ? ` ${scenario.intervalMinutes % 60} 分钟` : ''}`
      : `${scenario.intervalMinutes} 分钟`;
    parts.push(renderTemplate(TMPL_CRON_TASK, {
      taskId: scenario.taskId,
      intervalText,
      aiCanExit: scenario.aiCanExit ? 'true' : '',  // non-empty = truthy for {{#if}}
    }));
  }

  if (scenario.type === 'im' || scenario.type === 'agent-channel') {
    parts.push(TMPL_HEARTBEAT);
  }

  // L3: Generative UI instruction (desktop sessions with widget_read_me tool + <widget> tags)
  if (options?.generativeUiEnabled) {
    parts.push(TMPL_GENERATIVE_UI);
  }

  // L3: Browser storage state save instruction (when Playwright with --caps=storage is active)
  if (options?.playwrightStorageEnabled) {
    parts.push(TMPL_BROWSER_STORAGE_STATE);
  }

  // L3: Skill suggestions from keyword router (hints, not hard constraints)
  if (options?.suggestedSkills && options.suggestedSkills.length > 0) {
    const skillList = options.suggestedSkills.map(s => `「${s}」`).join('、');
    parts.push(renderTemplate(TMPL_SKILL_SUGGESTIONS, { skillList }));
  }

  // L3: Sub-agent awareness for Task dispatch
  if (options?.availableAgents && Object.keys(options.availableAgents).length > 0) {
    const agentList = Object.entries(options.availableAgents)
      .map(([name, desc]) => `- **${name}**: ${desc}`)
      .join('\n');
    parts.push(renderTemplate(TMPL_SUB_AGENTS, { agentList }));
  }

  return parts.join('\n\n');
}
