/**
 * Shared types for Sub-Agent management
 * Agents are custom sub-agents that can be invoked via the Task tool
 * Agent definition files use Markdown + YAML Frontmatter format
 */

/**
 * Agent frontmatter interface
 * Matches the Claude Agent SDK AgentDefinition fields
 */
export interface AgentFrontmatter {
    name: string;
    description: string;
    tools?: string;           // Comma-separated tool names
    disallowedTools?: string; // Comma-separated tool names
    model?: 'sonnet' | 'opus' | 'haiku' | 'inherit';
    permissionMode?: string;
    skills?: string[];
    memory?: string;          // Persistent memory: 'user' | 'project' | 'local'
    maxTurns?: number;
    hooks?: Record<string, unknown>; // Lifecycle hooks (PreToolUse, PostToolUse, Stop)
}

/**
 * PM Copilot extension metadata (_meta.json)
 * Stored alongside the .md file, not inside it (preserves Claude Code compatibility)
 */
export interface AgentMeta {
    displayName?: string;     // UI display name (falls back to frontmatter.name)
    icon?: string;            // lucide icon name
    color?: string;           // Theme color hex
    author?: string;
    createdAt?: string;       // ISO 8601
    updatedAt?: string;       // ISO 8601
}

/**
 * Agent item in list view
 */
export interface AgentItem {
    name: string;
    description: string;
    scope: 'user' | 'project';
    path: string;
    folderName: string;
    meta?: AgentMeta;
    synced?: boolean;         // true if synced from Claude Code
}

/**
 * Full agent detail with frontmatter and body
 */
export interface AgentDetail {
    name: string;
    folderName: string;
    path: string;
    scope: 'user' | 'project';
    frontmatter: Partial<AgentFrontmatter>;
    body: string;
    meta?: AgentMeta;
}

/**
 * Workspace-level agent config
 * Controls which agents are enabled for a specific project
 */
export interface AgentWorkspaceConfig {
    local: Record<string, { enabled: boolean }>;
    global_refs: Record<string, { enabled: boolean }>;
}

/**
 * API response types
 */
export interface AgentsListResponse {
    success: boolean;
    agents: AgentItem[];
    error?: string;
}

export interface AgentDetailResponse {
    success: boolean;
    agent: AgentDetail;
    error?: string;
}

export interface AgentSyncCheckResponse {
    canSync: boolean;
    count: number;
    folders: string[];
    error?: string;
}
