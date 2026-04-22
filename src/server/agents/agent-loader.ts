/**
 * Agent Loader Module
 * Scans, loads, and manages agent definition files
 *
 * Agent files follow Claude Code convention: <name>/<name>.md
 * Workspace config: <cwd>/.claude/agents/_workspace.json
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { parseAgentFrontmatter, parseFullAgentContent, toSdkAgentDefinition } from '../../shared/agentCommands';
import type { AgentItem, AgentMeta, AgentWorkspaceConfig } from '../../shared/agentTypes';

/**
 * Read _meta.json for a given agent folder
 */
export function readAgentMeta(agentFolderPath: string): AgentMeta | undefined {
    const metaPath = join(agentFolderPath, '_meta.json');
    try {
        if (existsSync(metaPath)) {
            return JSON.parse(readFileSync(metaPath, 'utf-8')) as AgentMeta;
        }
    } catch {
        // _meta.json is optional, silently ignore parse errors
    }
    return undefined;
}

/**
 * Write _meta.json for a given agent folder
 */
export function writeAgentMeta(agentFolderPath: string, meta: AgentMeta): void {
    if (!existsSync(agentFolderPath)) {
        mkdirSync(agentFolderPath, { recursive: true });
    }
    const metaPath = join(agentFolderPath, '_meta.json');
    writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
}

/**
 * Scan a directory for agent definition files
 * Agent files follow the pattern: <folderName>/<folderName>.md
 */
export function scanAgents(dir: string, scope: 'user' | 'project'): AgentItem[] {
    if (!dir || !existsSync(dir)) return [];

    const agents: AgentItem[] = [];
    try {
        const folders = readdirSync(dir, { withFileTypes: true });
        for (const folder of folders) {
            if (!folder.isDirectory()) continue;
            // Skip _workspace.json's parent and hidden folders
            if (folder.name.startsWith('_') || folder.name.startsWith('.')) continue;

            const agentFolderPath = join(dir, folder.name);
            const agentMdPath = join(agentFolderPath, `${folder.name}.md`);
            if (!existsSync(agentMdPath)) continue;

            const content = readFileSync(agentMdPath, 'utf-8');
            const { name, description } = parseAgentFrontmatter(content);
            const meta = readAgentMeta(agentFolderPath);
            agents.push({
                name: meta?.displayName || name || folder.name,
                description: description || '',
                scope,
                path: agentMdPath,
                folderName: folder.name,
                meta,
                ...(meta?.author === 'claude-code-sync' ? { synced: true } : {}),
            });
        }
    } catch (error) {
        console.warn(`[agent-loader] Error scanning ${scope} agents in ${dir}:`, error);
    }
    return agents;
}

/**
 * Read workspace agent config (_workspace.json)
 */
export function readWorkspaceConfig(agentDir: string): AgentWorkspaceConfig {
    const configPath = join(agentDir, '.claude', 'agents', '_workspace.json');
    try {
        if (existsSync(configPath)) {
            const content = readFileSync(configPath, 'utf-8');
            return JSON.parse(content) as AgentWorkspaceConfig;
        }
    } catch (error) {
        console.warn('[agent-loader] Failed to read workspace config:', error);
    }
    return { local: {}, global_refs: {} };
}

/**
 * Write workspace agent config (_workspace.json)
 */
export function writeWorkspaceConfig(agentDir: string, config: AgentWorkspaceConfig): void {
    const agentsDir = join(agentDir, '.claude', 'agents');
    if (!existsSync(agentsDir)) {
        mkdirSync(agentsDir, { recursive: true });
    }
    const configPath = join(agentsDir, '_workspace.json');
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Load enabled agents and convert to SDK AgentDefinition format
 * This is the key function called before query() to inject agents
 *
 * Resolution order:
 * 1. Read _workspace.json for enable/disable config
 * 2. Scan local agents (<cwd>/.claude/agents/*)
 * 3. Scan global agents (~/.pm-copilot/agents/*)
 * 4. Filter disabled agents, merge (local takes priority)
 * 5. Convert to SDK AgentDefinition format
 */
type SdkAgentDef = ReturnType<typeof toSdkAgentDefinition>;
type EnabledAgentDef = SdkAgentDef & { scope: 'user' | 'project' };

export function loadEnabledAgents(
    projectAgentsDir: string,
    userAgentsDir: string,
): Record<string, EnabledAgentDef> {
    // Read workspace config for enable/disable state
    // Use the project root (parent of .claude/) as the config base
    const projectRoot = projectAgentsDir ? projectAgentsDir.replace(/[/\\]\.claude[/\\]agents\/?$/, '') : '';
    const wsConfig = projectRoot ? readWorkspaceConfig(projectRoot) : { local: {}, global_refs: {} };

    const result: Record<string, EnabledAgentDef> = {};

    // Scan local agents
    if (projectAgentsDir && existsSync(projectAgentsDir)) {
        const localAgents = scanAgents(projectAgentsDir, 'project');
        for (const agent of localAgents) {
            // Check if explicitly disabled in workspace config
            if (wsConfig.local[agent.folderName]?.enabled === false) continue;

            const content = readFileSync(agent.path, 'utf-8');
            const { frontmatter, body } = parseFullAgentContent(content);
            const agentName = frontmatter.name || agent.folderName;
            result[agentName] = { ...toSdkAgentDefinition(frontmatter, body), scope: 'project' };
        }
    }

    // Scan global agents (only add if not already present from local)
    if (userAgentsDir && existsSync(userAgentsDir)) {
        const globalAgents = scanAgents(userAgentsDir, 'user');
        for (const agent of globalAgents) {
            // Check if explicitly disabled in workspace config
            if (wsConfig.global_refs[agent.folderName]?.enabled === false) continue;

            const agentName = agent.name;
            // Local takes priority - skip if already loaded from local
            if (result[agentName]) continue;

            const content = readFileSync(agent.path, 'utf-8');
            const { frontmatter, body } = parseFullAgentContent(content);
            const resolvedName = frontmatter.name || agent.folderName;
            // Double check local priority with resolved name
            if (result[resolvedName]) continue;
            result[resolvedName] = { ...toSdkAgentDefinition(frontmatter, body), scope: 'user' };
        }
    }

    return result;
}
