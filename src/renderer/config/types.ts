// Provider and permission configuration types

/**
 * Permission mode for agent behavior
 */
export type PermissionMode = 'auto' | 'plan' | 'fullAgency';

/**
 * Permission mode display configuration
 * Based on PRD 0.0.17 mode definitions
 */
export const PERMISSION_MODES: {
  value: PermissionMode;
  label: string;
  icon: string;
  description: string;
  sdkValue: string;
}[] = [
    {
      value: 'auto',
      label: '行动',
      icon: '⚡',
      description: 'Agent 在工作区内行动，使用工具需确认',
      sdkValue: 'acceptEdits',
    },
    {
      value: 'plan',
      label: '规划',
      icon: '📋',
      description: 'Agent 仅研究信息并与您讨论规划',
      sdkValue: 'plan',
    },
    {
      value: 'fullAgency',
      label: '自主行动',
      icon: '🚀',
      description: 'Agent 拥有完全自主权限，无需人工确认',
      sdkValue: 'bypassPermissions',
    },
  ];

/**
 * Model entity representing a single model configuration
 */
export interface ModelEntity {
  // === 核心字段（必填）===
  model: string;         // API 代码，如 "claude-sonnet-4-6"
  modelName: string;     // 显示名称，如 "Claude Sonnet 4.6"
  modelSeries: string;   // 品牌系列，如 "claude" | "deepseek" | "zhipu"

  // === 元数据字段（可选，API 发现时填充）===
  contextLength?: number;       // 上下文窗口（token 数）
  maxOutputTokens?: number;     // 最大输出 token 数
  inputModalities?: string[];   // 输入模态 ["text", "image", "video"]
  outputModalities?: string[];  // 输出模态 ["text"]

  // === 来源标记 ===
  source?: 'preset' | 'discovered' | 'manual';
}

/**
 * Model type for model selection (API code)
 */
export type ModelId = string;

/**
 * Model alias mapping for non-Anthropic providers.
 * Maps SDK model aliases (sonnet/opus/haiku) to provider-specific model IDs.
 * When Claude Agent SDK sub-agents use hardcoded model aliases like "haiku",
 * the bridge translates them to the actual provider model via this mapping.
 */
export interface ModelAliases {
  sonnet?: string;  // e.g., 'deepseek-chat'
  opus?: string;    // e.g., 'deepseek-reasoner'
  haiku?: string;   // e.g., 'deepseek-chat'
}

/**
 * Get the display name for a model
 */
export function getModelDisplayName(provider: Provider, modelId: string): string {
  const model = provider.models?.find(m => m.model === modelId);
  return model?.modelName ?? modelId;
}

/**
 * Get available models for a provider
 */
export function getProviderModels(provider: Provider): ModelEntity[] {
  return provider.models ?? [];
}

/**
 * Get effective primary model (user override > preset default)
 */
export function getEffectivePrimaryModel(
  provider: Provider,
  providerPrimaryModels?: Record<string, string>,
): string {
  const userOverride = providerPrimaryModels?.[provider.id];
  if (userOverride && provider.models?.some(m => m.model === userOverride)) {
    return userOverride;
  }
  return provider.primaryModel;
}

/**
 * Get display string for provider models (for compact UI display)
 * @param maxLength Maximum length before truncation (default 35)
 */
export function getModelsDisplay(provider: Provider, maxLength = 35): string {
  const models = provider.models?.map(m => m.model) ?? [];
  const display = models.join(', ');
  return display.length > maxLength ? display.slice(0, maxLength - 3) + '...' : display;
}

/**
 * Authentication type for API providers
 * - 'auth_token': Only set ANTHROPIC_AUTH_TOKEN
 * - 'api_key': Only set ANTHROPIC_API_KEY
 * - 'both': Set both ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY (default for backward compatibility)
 * - 'auth_token_clear_api_key': Set AUTH_TOKEN and explicitly clear API_KEY (required by OpenRouter)
 */
export type ProviderAuthType = 'auth_token' | 'api_key' | 'both' | 'auth_token_clear_api_key';

/**
 * API protocol type for provider communication
 * - 'anthropic': Native Anthropic Messages API (default)
 * - 'openai': OpenAI Chat Completions API (translated via built-in bridge)
 */
export type ApiProtocol = 'anthropic' | 'openai';

/**
 * Service provider configuration
 */
export interface Provider {
  id: string;
  name: string;
  vendor: string;           // 厂商名: 'Anthropic', 'DeepSeek', etc.
  cloudProvider: string;    // 云服务商: '模型官方', '云服务商', etc.
  type: 'subscription' | 'api';
  primaryModel: string;     // 默认模型 API 代码
  isBuiltin: boolean;

  // API 配置
  config: {
    baseUrl?: string;            // ANTHROPIC_BASE_URL
    timeout?: number;            // API_TIMEOUT_MS
    disableNonessential?: boolean; // CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
  };

  // 认证方式 (默认 'both' 以保持向后兼容)
  authType?: ProviderAuthType;

  // API 协议 (默认 'anthropic')
  apiProtocol?: ApiProtocol;

  // 上游 API 格式（仅 apiProtocol === 'openai' 时生效）
  // 'chat_completions' (默认): OpenAI Chat Completions API
  // 'responses': OpenAI Responses API
  upstreamFormat?: 'chat_completions' | 'responses';

  // 最大输出 token 数限制（仅 apiProtocol === 'openai' 时生效）
  // 有值时 Bridge 向上游注入此 token limit；空/undefined = 不发送
  maxOutputTokens?: number;
  // 上游 API 的 token limit 参数名（仅 apiProtocol === 'openai' 时生效）
  // 'max_tokens' (默认，兼容大多数 provider)
  // 'max_completion_tokens' (OpenAI o1/o3/GPT-5、vLLM、OpenRouter)
  // 'max_output_tokens' (OpenAI Responses API)
  maxOutputTokensParamName?: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens';

  // 官网链接 (用于"去官网"入口)
  websiteUrl?: string;

  // 模型发现端点 URL（可选覆盖）
  // 默认行为：GET {config.baseUrl}/v1/models
  // 当供应商的 Anthropic 路径不支持 /v1/models 时，指向其 OpenAI 路径
  modelListUrl?: string;

  // 模型列表 - 使用新的 ModelEntity 结构
  models: ModelEntity[];

  // SDK 模型别名映射（非 Anthropic provider 的子 Agent 模型重定向）
  // SDK 内置子 Agent (如 Explore) 会硬编码 model: "haiku"，通过此映射转为实际模型
  modelAliases?: ModelAliases;

  // 用户输入的 API Key (运行时填充，不持久化到 provider 定义)
  apiKey?: string;
}

/**
 * Project/workspace configuration
 */
export interface Project {
  id: string;
  name: string;
  path: string;
  lastOpened?: string;
  // Project-specific settings (null means use default)
  providerId: string | null;
  permissionMode: PermissionMode | null;
  model?: string | null;
  // Custom permission rules for 'custom' mode
  customPermissions?: {
    allow: string[];
    deny: string[];
  };
  // Workspace-level MCP enabled servers (IDs of globally enabled MCPs that are turned on for this workspace)
  // null/undefined = none enabled, array of IDs = those MCPs are enabled for this workspace
  mcpEnabledServers?: string[];
  /** Internal projects (e.g. ~/.pm-copilot diagnostic workspace) hidden from Launcher */
  internal?: boolean;
  /** Custom emoji icon for display, defaults to FolderOpen if absent */
  icon?: string;
  /** Custom display name, defaults to folder name extracted from path */
  displayName?: string;
  /** Whether this workspace has been upgraded to an Agent (v0.1.41) */
  isAgent?: boolean;
  /** Associated Agent ID when isAgent=true (v0.1.41) */
  agentId?: string;
}

// ===== Workspace Template Types =====

/**
 * Workspace template definition
 */
export interface WorkspaceTemplate {
  id: string;           // kebab-case unique ID
  name: string;         // Display name
  description: string;  // Description (can be empty)
  icon?: string;        // Phosphor icon ID (e.g. "sparkle") or emoji fallback; defaults to cube icon if absent
  isBuiltin: boolean;   // true = preset template bundled with app
  path?: string;        // User template: absolute path under ~/.pm-copilot/templates/
}

/**
 * Preset workspace templates bundled with the app
 */
export const PRESET_TEMPLATES: WorkspaceTemplate[] = [
  {
    id: 'pm-copilot',
    name: 'PM Copilot',
    description: 'AI 产品管理合伙人。29 个 PM Skill，从问题定义到产品上线的全流程支持。',
    icon: 'lightning',
    isBuiltin: true,
  },
  {
    id: 'prd-writer',
    name: 'PRD Writer',
    description: '产品需求文档工作区。PRD + Tech Spec，从问题定义到开发交接。',
    icon: 'fileText',
    isBuiltin: true,
  },
  {
    id: 'discovery-lab',
    name: 'Discovery Lab',
    description: '产品发现工作区。用户研究 + 实验 + 画像，验证需求真伪。',
    icon: 'magnifyingGlass',
    isBuiltin: true,
  },
  {
    id: 'strategy-room',
    name: 'Strategy Room',
    description: '策略规划工作区。决策分析 + 优先级 + 路线图。',
    icon: 'chartLine',
    isBuiltin: true,
  },
  {
    id: 'launch-pad',
    name: 'Launch Pad',
    description: '发布工作区。指标体系 + 测试方案 + 发布检查清单。',
    icon: 'rocket',
    isBuiltin: true,
  },
  {
    id: 'retro-board',
    name: 'Retro Board',
    description: '复盘评审工作区。团队回顾 + 交付物评审。',
    icon: 'arrowsClockwise',
    isBuiltin: true,
  },
];

/**
 * Provider verification status (with expiry support)
 */
export interface ProviderVerifyStatus {
  status: 'valid' | 'invalid';
  verifiedAt: string; // ISO timestamp
  accountEmail?: string; // For subscription: detect account change
}

/** Verification expiry in days */
export const VERIFY_EXPIRY_DAYS = 30;

/** Subscription provider ID for verification caching */
export const SUBSCRIPTION_PROVIDER_ID = 'anthropic-sub';

/** Check if verification has expired */
export function isVerifyExpired(verifiedAt: string): boolean {
  const verifiedDate = new Date(verifiedAt);
  // Invalid date string returns NaN, treat as expired to trigger re-verification
  if (isNaN(verifiedDate.getTime())) {
    return true;
  }
  const now = new Date();
  const daysDiff = (now.getTime() - verifiedDate.getTime()) / (1000 * 60 * 60 * 24);
  return daysDiff > VERIFY_EXPIRY_DAYS;
}

/**
 * Network proxy protocol type
 */
export type ProxyProtocol = 'http' | 'socks5';

/**
 * Network proxy default values
 */
export const PROXY_DEFAULTS = {
  protocol: 'http' as ProxyProtocol,
  host: '127.0.0.1',
  port: 7897,
} as const;

/**
 * Validate proxy host (localhost, IP address, or hostname)
 */
export function isValidProxyHost(host: string): boolean {
  if (!host || host.length > 253) return false;
  // localhost, IPv4, or valid hostname
  return /^(localhost|(\d{1,3}\.){3}\d{1,3}|[a-zA-Z0-9][-a-zA-Z0-9]*(\.[a-zA-Z0-9][-a-zA-Z0-9]*)*)$/.test(host);
}

/**
 * Network proxy settings (General settings)
 */
export interface ProxySettings {
  enabled: boolean;
  protocol: ProxyProtocol;
  host: string;
  port: number;
}

/**
 * App-level configuration
 */
export interface AppConfig {
  // Default settings for new projects
  defaultProviderId?: string;
  defaultPermissionMode: PermissionMode;
  // UI preferences
  theme: 'light' | 'dark' | 'system';
  minimizeToTray: boolean;
  showDevTools: boolean; // 显示开发者工具 (Logs/System Info)
  multiAgentRuntime?: boolean; // 多 Agent Runtime 模式（开发者，默认关闭）
  experimentalSplitView?: boolean; // 实验性：文件预览在右侧分屏而非弹窗
  // General settings
  autoStart: boolean; // 开机启动
  cronNotifications: boolean; // 定时任务通知
  // API Keys for providers (stored separately for security)
  providerApiKeys?: Record<string, string>;
  // Provider verification status (persisted after API key validation)
  // Key is provider ID (e.g., 'anthropic-sub', 'deepseek')
  providerVerifyStatus?: Record<string, ProviderVerifyStatus>;

  // ===== Provider Custom Models =====
  // User-added custom models for preset providers (key = provider ID)
  // These are merged with preset models at runtime, allowing users to add models
  // while keeping preset definitions unchanged (updated with app releases)
  presetCustomModels?: Record<string, ModelEntity[]>;
  // Preset models explicitly removed by user (key = provider ID, value = model IDs)
  // App upgrades won't re-add these; new models NOT in this list appear automatically
  presetRemovedModels?: Record<string, string[]>;

  // ===== Provider Primary Model (user overrides) =====
  // Maps provider ID → user's preferred primary model (overrides preset primaryModel)
  providerPrimaryModels?: Record<string, string>;

  // ===== Provider Model Aliases (user overrides) =====
  // Maps provider ID → user-configured model alias overrides (merged with preset defaults)
  providerModelAliases?: Record<string, ModelAliases>;

  // ===== MCP Configuration =====
  // Custom MCP servers added by user (merged with presets)
  mcpServers?: McpServerDefinition[];
  // IDs of globally enabled MCP servers (both presets and custom)
  mcpEnabledServers?: string[];
  // Environment variables for MCP servers that require config (e.g., API keys)
  mcpServerEnv?: Record<string, Record<string, string>>;
  // Extra args for MCP servers (appended to preset args)
  // undefined = never customized, [] = user explicitly cleared
  mcpServerArgs?: Record<string, string[]>;

  // ===== Network Proxy (General) =====
  // HTTP/SOCKS5 proxy settings for external network requests
  proxySettings?: ProxySettings;

  // ===== Default Workspace =====
  // Path to the default workspace shown on Launcher
  defaultWorkspacePath?: string;

  // ===== Launcher Last-Used Settings =====
  // Persisted on send from Launcher, restored on next app launch
  // Note: workspace is NOT included — always uses defaultWorkspacePath
  launcherLastUsed?: {
    providerId?: string;
    model?: string;
    permissionMode?: PermissionMode;
    mcpEnabledServers?: string[];
  };

  // ===== Agent Configuration (v0.1.41) =====
  agents?: import('../../shared/types/agent').AgentConfig[];

  // ===== IM Bot Configuration (legacy) =====
  /** @deprecated Migrated to imBotConfigs[]. Only used for migration. */
  imBotConfig?: import('../../shared/types/im').ImBotConfig;
  /** @deprecated Migrated to agents[]. Retained for migration detection + Phase 2 Rust shim. */
  imBotConfigs?: import('../../shared/types/im').ImBotConfig[];

  // ===== Dismiss Flags =====
  dismissClaudeEnvWarning?: boolean; // 不再提示 ~/.claude/settings.json env 覆盖警告

  // ===== Global Provider Cache (v0.1.26) =====
  /** Pre-built available providers JSON for IM Bot /provider and /model commands.
   *  Written by rebuildAndPersistAvailableProviders() whenever provider config changes.
   *  Read lazily by Rust IM command handlers. */
  availableProvidersJson?: string;
}

/**
 * Project-level settings (synced to .claude/settings.json)
 * Based on PRD 0.0.4 data persistence spec
 */
export interface ProjectSettings {
  // Permission configuration
  permissions?: {
    mode: string;       // SDK permission mode value
    allow?: string[];   // Custom allowed tools
    deny?: string[];    // Custom denied tools
  };
  // Provider environment variables
  env?: Record<string, string>;
}

// Preset providers with ModelEntity structure
/** Anthropic 官方预设模型（订阅和 API 共用） */
const ANTHROPIC_MODELS: ModelEntity[] = [
  { model: 'claude-sonnet-4-6', modelName: 'Claude Sonnet 4.6', modelSeries: 'claude' },
  { model: 'claude-opus-4-6', modelName: 'Claude Opus 4.6', modelSeries: 'claude' },
  { model: 'claude-haiku-4-5', modelName: 'Claude Haiku 4.5', modelSeries: 'claude' },
];

export const PRESET_PROVIDERS: Provider[] = [
  {
    id: 'anthropic-sub',
    name: 'Anthropic (订阅)',
    vendor: 'Anthropic',
    cloudProvider: '官方',
    type: 'subscription',
    primaryModel: 'claude-sonnet-4-6',
    isBuiltin: true,
    config: {},
    models: ANTHROPIC_MODELS,
  },
  {
    id: 'anthropic-api',
    name: 'Anthropic (API)',
    vendor: 'Anthropic',
    cloudProvider: '官方',
    type: 'api',
    primaryModel: 'claude-sonnet-4-6',
    isBuiltin: true,
    authType: 'both',
    config: {
      baseUrl: 'https://api.anthropic.com',
    },
    models: ANTHROPIC_MODELS,
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    vendor: 'DeepSeek',
    cloudProvider: '模型官方',
    type: 'api',
    primaryModel: 'deepseek-chat',
    isBuiltin: true,
    authType: 'auth_token',
    websiteUrl: 'https://platform.deepseek.com',
    modelListUrl: 'https://api.deepseek.com/v1/models',
    config: {
      baseUrl: 'https://api.deepseek.com/anthropic',
      timeout: 600000,
      disableNonessential: true,
    },
    modelAliases: { sonnet: 'deepseek-chat', opus: 'deepseek-reasoner', haiku: 'deepseek-chat' },
    models: [
      { model: 'deepseek-chat', modelName: 'DeepSeek Chat', modelSeries: 'deepseek' },
      { model: 'deepseek-reasoner', modelName: 'DeepSeek Reasoner', modelSeries: 'deepseek' },
    ],
  },
  {
    id: 'moonshot',
    name: 'Moonshot AI',
    vendor: 'Moonshot',
    cloudProvider: '模型官方',
    type: 'api',
    primaryModel: 'kimi-k2.5',
    isBuiltin: true,
    authType: 'auth_token',
    websiteUrl: 'https://platform.moonshot.cn/console',
    modelListUrl: 'https://api.moonshot.cn/v1/models',
    config: {
      baseUrl: 'https://api.moonshot.cn/anthropic',
    },
    modelAliases: { sonnet: 'kimi-k2.5', opus: 'kimi-k2.5', haiku: 'kimi-k2-thinking-turbo' },
    models: [
      { model: 'kimi-k2.5', modelName: 'Kimi K2.5', modelSeries: 'moonshot' },
      { model: 'kimi-k2-thinking-turbo', modelName: 'Kimi K2 Thinking', modelSeries: 'moonshot' },
      { model: 'kimi-k2-0711', modelName: 'Kimi K2', modelSeries: 'moonshot' },
    ],
  },
  {
    id: 'zhipu',
    name: '智谱 AI',
    vendor: 'Zhipu',
    cloudProvider: '模型官方',
    type: 'api',
    primaryModel: 'glm-4.7',
    isBuiltin: true,
    authType: 'auth_token',
    websiteUrl: 'https://bigmodel.cn/console/overview',
    modelListUrl: 'https://open.bigmodel.cn/api/paas/v4/models',
    config: {
      baseUrl: 'https://open.bigmodel.cn/api/anthropic',
      timeout: 600000,
      disableNonessential: true,
    },
    modelAliases: { sonnet: 'glm-5.1', opus: 'glm-5.1', haiku: 'glm-5.1' },
    models: [
      { model: 'glm-5.1', modelName: 'GLM 5.1', modelSeries: 'zhipu' },
      { model: 'glm-5-turbo', modelName: 'GLM 5 Turbo', modelSeries: 'zhipu' },
      { model: 'glm-4.7', modelName: 'GLM 4.7', modelSeries: 'zhipu' },
      { model: 'glm-5', modelName: 'GLM 5', modelSeries: 'zhipu' },
      { model: 'glm-4.5-air', modelName: 'GLM 4.5 Air', modelSeries: 'zhipu' },
    ],
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    vendor: 'MiniMax',
    cloudProvider: '模型官方',
    type: 'api',
    primaryModel: 'MiniMax-M2.7',
    isBuiltin: true,
    authType: 'auth_token',
    websiteUrl: 'https://platform.minimaxi.com/docs/guides/models-intro',
    config: {
      baseUrl: 'https://api.minimaxi.com/anthropic',
    },
    modelAliases: { sonnet: 'MiniMax-M2.7', opus: 'MiniMax-M2.7', haiku: 'MiniMax-M2.7' },
    models: [
      { model: 'MiniMax-M2.7', modelName: 'MiniMax M2.7', modelSeries: 'minimax' },
      { model: 'MiniMax-M2.7-highspeed', modelName: 'MiniMax M2.7 Highspeed', modelSeries: 'minimax' },
      { model: 'MiniMax-M2.5', modelName: 'MiniMax M2.5', modelSeries: 'minimax' },
      { model: 'MiniMax-M2.5-lightning', modelName: 'MiniMax M2.5 Lightning', modelSeries: 'minimax' },
      { model: 'MiniMax-M2.1', modelName: 'MiniMax M2.1', modelSeries: 'minimax' },
      { model: 'MiniMax-M2.1-lightning', modelName: 'MiniMax M2.1 Lightning', modelSeries: 'minimax' },
    ],
  },
  {
    id: 'google-gemini',
    name: 'Google Gemini',
    vendor: 'Google',
    cloudProvider: '模型官方',
    type: 'api',
    primaryModel: 'gemini-2.5-flash',
    isBuiltin: true,
    authType: 'api_key',
    apiProtocol: 'openai',
    maxOutputTokens: 8192,
    websiteUrl: 'https://aistudio.google.com/apikey',
    config: {
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    },
    modelAliases: { sonnet: 'gemini-3.1-pro-preview', opus: 'gemini-3.1-pro-preview', haiku: 'gemini-3-flash-preview' },
    models: [
      { model: 'gemini-2.5-pro', modelName: 'Gemini 2.5 Pro', modelSeries: 'google' },
      { model: 'gemini-2.5-flash', modelName: 'Gemini 2.5 Flash', modelSeries: 'google' },
      { model: 'gemini-2.5-flash-lite', modelName: 'Gemini 2.5 Flash-Lite', modelSeries: 'google' },
      { model: 'gemini-3.1-pro-preview', modelName: 'Gemini 3.1 Pro Preview', modelSeries: 'google' },
      { model: 'gemini-3-flash-preview', modelName: 'Gemini 3 Flash Preview', modelSeries: 'google' },
    ],
  },
  {
    id: 'volcengine',
    name: '火山方舟 Coding Plan',
    vendor: '字节跳动',
    cloudProvider: '云服务商',
    type: 'api',
    primaryModel: 'doubao-seed-2.0-code',
    isBuiltin: true,
    authType: 'auth_token',
    websiteUrl: 'https://console.volcengine.com/',
    config: {
      baseUrl: 'https://ark.cn-beijing.volces.com/api/coding',
      disableNonessential: true,
    },
    modelAliases: { sonnet: 'doubao-seed-2.0-code', opus: 'doubao-seed-2.0-code', haiku: 'doubao-seed-2.0-code' },
    models: [
      { model: 'doubao-seed-2.0-code', modelName: 'Doubao Seed 2.0 Code', modelSeries: 'volcengine' },
      { model: 'glm-4.7', modelName: 'GLM 4.7', modelSeries: 'volcengine' },
      { model: 'deepseek-v3.2', modelName: 'DeepSeek V3.2', modelSeries: 'volcengine' },
      { model: 'kimi-k2.5', modelName: 'Kimi K2.5', modelSeries: 'volcengine' },
    ],
  },
  {
    id: 'volcengine-api',
    name: '火山方舟 API调用',
    vendor: '字节跳动',
    cloudProvider: '云服务商',
    type: 'api',
    primaryModel: 'doubao-seed-2-0-pro-260215',
    isBuiltin: true,
    authType: 'auth_token',
    websiteUrl: 'https://console.volcengine.com/',
    config: {
      baseUrl: 'https://ark.cn-beijing.volces.com/api/compatible',
      disableNonessential: true,
    },
    modelAliases: { sonnet: 'doubao-seed-2-0-pro-260215', opus: 'doubao-seed-2-0-pro-260215', haiku: 'doubao-seed-2-0-lite-260215' },
    models: [
      { model: 'doubao-seed-2-0-pro-260215', modelName: 'Doubao Seed 2.0 Pro', modelSeries: 'volcengine' },
      { model: 'doubao-seed-2-0-code-preview-260215', modelName: 'Doubao Seed 2.0 Code Preview', modelSeries: 'volcengine' },
      { model: 'doubao-seed-2-0-lite-260215', modelName: 'Doubao Seed 2.0 Lite', modelSeries: 'volcengine' },
    ],
  },
  {
    id: 'siliconflow',
    name: '硅基流动SiliconFlow',
    vendor: 'SiliconFlow',
    cloudProvider: '云服务商',
    type: 'api',
    primaryModel: 'Pro/deepseek-ai/DeepSeek-V3.2',
    isBuiltin: true,
    authType: 'api_key',
    websiteUrl: 'https://cloud.siliconflow.cn/me/models',
    config: {
      baseUrl: 'https://api.siliconflow.cn/',
      disableNonessential: true,
    },
    modelAliases: { sonnet: 'Pro/deepseek-ai/DeepSeek-V3.2', opus: 'Pro/moonshotai/Kimi-K2.5', haiku: 'stepfun-ai/Step-3.5-Flash' },
    models: [
      { model: 'Pro/moonshotai/Kimi-K2.5', modelName: 'Kimi K2.5', modelSeries: 'siliconflow' },
      { model: 'Pro/zai-org/GLM-4.7', modelName: 'GLM 4.7', modelSeries: 'siliconflow' },
      { model: 'Pro/deepseek-ai/DeepSeek-V3.2', modelName: 'DeepSeek V3.2', modelSeries: 'siliconflow' },
      { model: 'Pro/MiniMaxAI/MiniMax-M2.1', modelName: 'MiniMax M2.1', modelSeries: 'siliconflow' },
      { model: 'stepfun-ai/Step-3.5-Flash', modelName: 'Step 3.5 Flash', modelSeries: 'siliconflow' },
    ],
  },
  {
    id: 'zenmux',
    name: 'ZenMux',
    vendor: 'ZenMux',
    cloudProvider: '云服务商',
    type: 'api',
    primaryModel: 'anthropic/claude-sonnet-4.6',
    isBuiltin: true,
    authType: 'auth_token',
    websiteUrl: 'https://zenmux.ai',
    config: {
      baseUrl: 'https://zenmux.ai/api/anthropic',
      disableNonessential: true,
    },
    modelAliases: { sonnet: 'anthropic/claude-sonnet-4.6', opus: 'anthropic/claude-opus-4.6', haiku: 'volcengine/doubao-seed-2.0-lite' },
    models: [
      { model: 'google/gemini-3.1-pro-preview', modelName: 'Gemini 3.1 Pro', modelSeries: 'google' },
      { model: 'anthropic/claude-sonnet-4.6', modelName: 'Claude Sonnet 4.6', modelSeries: 'claude' },
      { model: 'anthropic/claude-opus-4.6', modelName: 'Claude Opus 4.6', modelSeries: 'claude' },
      { model: 'volcengine/doubao-seed-2.0-pro', modelName: 'Doubao Seed 2.0 Pro', modelSeries: 'volcengine' },
      { model: 'volcengine/doubao-seed-2.0-lite', modelName: 'Doubao Seed 2.0 Lite', modelSeries: 'volcengine' },
      { model: 'minimax/minimax-m2.5', modelName: 'MiniMax M2.5', modelSeries: 'minimax' },
      { model: 'moonshotai/kimi-k2.5', modelName: 'Kimi K2.5', modelSeries: 'moonshot' },
      { model: 'z-ai/glm-5', modelName: 'GLM 5', modelSeries: 'zhipu' },
    ],
  },
  {
    id: 'aliyun-bailian-coding',
    name: '阿里云百炼 Coding Plan',
    vendor: '阿里云',
    cloudProvider: '云服务商',
    type: 'api',
    primaryModel: 'qwen3.5-plus',
    isBuiltin: true,
    authType: 'auth_token',
    websiteUrl: 'https://bailian.console.aliyun.com/',
    modelListUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/models',
    config: {
      baseUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
    },
    modelAliases: { sonnet: 'qwen3.5-plus', opus: 'qwen3.5-plus', haiku: 'qwen3.5-plus' },
    models: [
      { model: 'qwen3.5-plus', modelName: 'Qwen 3.5 Plus', modelSeries: 'aliyun' },
      { model: 'kimi-k2.5', modelName: 'Kimi K2.5', modelSeries: 'aliyun' },
      { model: 'glm-5', modelName: 'GLM 5', modelSeries: 'aliyun' },
      { model: 'MiniMax-M2.5', modelName: 'MiniMax M2.5', modelSeries: 'aliyun' },
    ],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    vendor: 'OpenRouter',
    cloudProvider: '云服务商',
    type: 'api',
    primaryModel: 'google/gemini-3.1-pro-preview',
    isBuiltin: true,
    authType: 'auth_token_clear_api_key',
    websiteUrl: 'https://openrouter.ai/',
    config: {
      baseUrl: 'https://openrouter.ai/api',
    },
    modelAliases: { sonnet: 'google/gemini-3.1-pro-preview', opus: 'google/gemini-3.1-pro-preview', haiku: 'google/gemini-3-flash-preview' },
    models: [
      { model: 'google/gemini-3.1-flash-lite-preview', modelName: 'Gemini 3.1 Flash Lite', modelSeries: 'google' },
      { model: 'google/gemini-3-flash-preview', modelName: 'Gemini 3 Flash', modelSeries: 'google' },
      { model: 'google/gemini-3.1-pro-preview', modelName: 'Gemini 3.1 Pro', modelSeries: 'google' },
      { model: 'anthropic/claude-sonnet-4.6', modelName: 'Claude Sonnet 4.6', modelSeries: 'claude' },
      { model: 'anthropic/claude-opus-4.6', modelName: 'Claude Opus 4.6', modelSeries: 'claude' },
      { model: 'anthropic/claude-haiku-4.5', modelName: 'Claude Haiku 4.5', modelSeries: 'claude' },
      { model: 'openai/gpt-5.4', modelName: 'GPT-5.4', modelSeries: 'openai' },
      { model: 'openai/gpt-5.4-pro', modelName: 'GPT-5.4 Pro', modelSeries: 'openai' },
      { model: 'openai/gpt-5.3-codex', modelName: 'GPT-5.3 Codex', modelSeries: 'openai' },
      { model: 'openai/gpt-5.3-chat', modelName: 'GPT-5.3 Chat', modelSeries: 'openai' },
    ],
  },
];

// ===== MCP Server Configuration Types =====

/**
 * MCP Server type
 */
export type McpServerType = 'stdio' | 'sse' | 'http';

/**
 * MCP Server definition - unified configuration for all MCP server types
 */
export interface McpServerDefinition {
  id: string;
  name: string;            // Display name
  description?: string;    // Feature description
  type: McpServerType;

  // stdio configuration
  command?: string;        // Command to run (e.g., 'npx')
  args?: string[];         // Command arguments
  env?: Record<string, string>;  // Environment variables

  // sse/http configuration
  url?: string;
  headers?: Record<string, string>;

  // Metadata
  isBuiltin: boolean;      // Is a preset MCP
  isFree?: boolean;        // No API key / paid service required
  requiresConfig?: string[];  // Required config fields (e.g., API keys)
  websiteUrl?: string;     // Website for API key registration
  configHint?: string;     // Help text shown in settings dialog (e.g., "去官网注册获取 API Key")
}

/**
 * MCP Server status (runtime)
 */
export type McpServerStatus = 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';

/**
 * MCP enable error type (returned by /api/mcp/enable)
 */
export type McpEnableErrorType = 'command_not_found' | 'warmup_failed' | 'package_not_found' | 'runtime_error' | 'connection_failed' | 'unknown';

/**
 * MCP enable error response
 */
export interface McpEnableError {
  type: McpEnableErrorType;
  message: string;
  command?: string;
  runtimeName?: string;
  downloadUrl?: string;
}

/**
 * Preset MCP servers that come bundled with the app
 */
export const PRESET_MCP_SERVERS: McpServerDefinition[] = [
  {
    id: 'playwright',
    name: 'Playwright 浏览器',
    description: '浏览器自动化能力，支持网页浏览、截图、表单填写等',
    type: 'stdio',
    command: 'npx',
    args: ['@playwright/mcp@latest'],
    isBuiltin: true,
    isFree: true,
  },
  {
    id: 'ddg-search',
    name: 'DuckDuckGo 搜索引擎',
    description: '无需 API Key。受 DuckDuckGo 频率限制（≤1次/秒，≤15000次/月），高频使用可能返回 400 错误',
    type: 'stdio',
    command: 'uvx',
    args: ['duckduckgo-mcp-server'],
    isBuiltin: true,
    isFree: true,
  },
  {
    id: 'tavily-search',
    name: 'Tavily 搜索引擎',
    description: '专为 AI 优化的全网搜索，返回结构化结果。免费 1000 次/月，无需信用卡',
    type: 'http',
    url: 'https://mcp.tavily.com/mcp/?tavilyApiKey={{TAVILY_API_KEY}}',
    isBuiltin: true,
    requiresConfig: ['TAVILY_API_KEY'],
    websiteUrl: 'https://app.tavily.com/home',
    configHint: '免费注册即可获取 API Key（1000 次/月，无需信用卡）',
  },
  {
    id: 'gemini-image',
    name: 'Nano Banana 图片生成',
    description: '支持图片生成与多轮编辑（基于 Gemini Nano Banana）',
    type: 'stdio',
    command: '__builtin__',
    args: [],
    isBuiltin: true,
    requiresConfig: ['GEMINI_API_KEY'],
    websiteUrl: 'https://aistudio.google.com/apikey',
    configHint: '在 Google AI Studio 一键创建 API Key',
  },
  {
    id: 'edge-tts',
    name: 'Edge TTS 语音合成',
    description: '免费文字转语音，支持 400+ 语音（基于 Microsoft Edge TTS，无需 API Key）',
    type: 'stdio',
    command: '__builtin__',
    args: [],
    isBuiltin: true,
    isFree: true,
  },
];

// ===== MCP OAuth 2.0 Types =====

/**
 * OAuth 2.0 configuration — see ManualOAuthConfig for manual mode,
 * McpOAuthState (mcp-oauth/types.ts) for backend state.
 */

/** OAuth status for display in the UI */
export type McpOAuthStatus = 'disconnected' | 'connecting' | 'connected' | 'expired' | 'error';

/** Result of probing an MCP server for OAuth requirements */
export type OAuthProbeResult =
  | { required: false }
  | { required: true; supportsDynamicRegistration: boolean; scopes?: string[] };

/** Manual OAuth config (advanced fallback when dynamic registration unavailable) */
export interface ManualOAuthConfig {
  clientId: string;
  clientSecret?: string;
  callbackPort?: number;
  scopes?: string[];
  authorizationUrl?: string;
  tokenUrl?: string;
}

/**
 * MCP discovery links
 */
export const MCP_DISCOVERY_LINKS = [
  { name: 'MCP.SO', url: 'https://mcp.so/' },
  { name: '智谱MCP', url: 'https://bigmodel.cn/marketplace/index/mcp' },
];

/**
 * Get preset MCP server by ID
 */
export function getPresetMcpServer(id: string): McpServerDefinition | undefined {
  return PRESET_MCP_SERVERS.find(s => s.id === id);
}

/**
 * Get effective model aliases for a provider (preset defaults merged with user overrides).
 * Anthropic providers don't need aliases (SDK natively supports their models).
 */
export function getEffectiveModelAliases(
  provider: Provider,
  userOverrides?: Record<string, ModelAliases>,
): ModelAliases | undefined {
  // Anthropic providers don't need alias mapping
  if (provider.id === 'anthropic-sub' || provider.id === 'anthropic-api') return undefined;
  const defaults = provider.modelAliases ?? {};
  const overrides = userOverrides?.[provider.id];
  if (overrides) {
    // User has explicit overrides — merge with defaults (overrides win, including empty strings)
    return { ...defaults, ...overrides };
  }
  // No user overrides — return preset defaults if any
  if (defaults.sonnet || defaults.opus || defaults.haiku) return defaults;
  // Fallback: no preset aliases and no user overrides — use provider's first model or primaryModel
  // so sub-agents (model: "sonnet"/"opus"/"haiku") don't send raw claude-* to the third-party API.
  const fallbackModel = provider.primaryModel || provider.models?.[0]?.model;
  if (fallbackModel) {
    return { sonnet: fallbackModel, opus: fallbackModel, haiku: fallbackModel };
  }
  return undefined;
}

export const DEFAULT_CONFIG: AppConfig = {
  defaultProviderId: undefined, // No default — resolved at runtime from first available provider
  defaultPermissionMode: 'auto',
  theme: 'system',
  minimizeToTray: true,   // 默认开启最小化到托盘
  showDevTools: false,
  autoStart: false,       // 默认不开启开机启动
  cronNotifications: true,
};
