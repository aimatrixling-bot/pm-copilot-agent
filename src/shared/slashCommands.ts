// Slash Commands Service
// Provides slash command discovery and management for the chat input
// Supports builtin commands, custom commands (.claude/commands/), and skills (.claude/skills/, ~/.pm-copilot/skills/)

import { load as yamlLoad } from 'js-yaml';

export interface SlashCommand {
    name: string;           // Command name without slash, e.g., "review"
    description: string;    // Human readable description
    source: 'builtin' | 'custom' | 'skill';  // Source type: builtin, custom command, or skill
    scope?: 'user' | 'project';  // Where the item is defined
    path?: string;          // File path for custom commands or skills
    folderName?: string;    // Folder name for skills (may differ from display name after rename)
    displayName?: string;   // User-facing Chinese name (overrides name in UI)
    displayDescription?: string;  // User-facing Chinese description (overrides description in UI)
}

/**
 * Complete Skill frontmatter interface
 * Matches the Agent Skills Open Standard specification
 */
export interface SkillFrontmatter {
    name: string;
    description: string;
    author?: string;
    // Advanced options
    'disable-model-invocation'?: boolean;
    'user-invocable'?: boolean;
    'allowed-tools'?: string;
    context?: 'fork' | string;
    agent?: 'Explore' | 'Plan' | 'general-purpose' | string;
    'argument-hint'?: string;
    displayName?: string;   // User-facing Chinese name
    displayDescription?: string;  // User-facing Chinese description
}

/**
 * Complete Command frontmatter interface
 */
export interface CommandFrontmatter {
    name?: string;
    description: string;
    author?: string;
}

// Built-in Claude Code slash commands with descriptions
export const BUILTIN_SLASH_COMMANDS: SlashCommand[] = [
    { name: 'compact', description: '压缩对话历史，释放上下文空间', source: 'builtin' },
    { name: 'context', description: '显示或管理当前上下文', source: 'builtin' },
    { name: 'cost', description: '查看 token 使用量和费用', source: 'builtin' },
    { name: 'init', description: '初始化项目配置 (.CLAUDE.md)', source: 'builtin' },
    { name: 'pr-comments', description: '生成 Pull Request 评论', source: 'builtin' },
    { name: 'release-notes', description: '根据最近提交生成发布说明', source: 'builtin' },
    { name: 'review', description: '对代码进行审查', source: 'builtin' },
    { name: 'security-review', description: '进行安全相关的代码审查', source: 'builtin' },
];

/**
 * Extract YAML frontmatter string from markdown content
 */
function extractFrontmatter(content: string): { frontmatterStr: string; body: string } | null {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!match) {
        return null;
    }
    return {
        frontmatterStr: match[1],
        body: match[2] || ''
    };
}

/**
 * Extract author from parsed YAML object
 * Checks both top-level (author, Author) and nested (metadata.author, metadata.Author)
 */
function extractAuthor(parsed: Record<string, unknown>): string | undefined {
    // Check top-level author/Author
    if (typeof parsed.author === 'string') return parsed.author;
    if (typeof parsed.Author === 'string') return parsed.Author;

    // Check nested metadata.author/Author
    const metadata = parsed.metadata as Record<string, unknown> | undefined;
    if (metadata && typeof metadata === 'object') {
        if (typeof metadata.author === 'string') return metadata.author;
        if (typeof metadata.Author === 'string') return metadata.Author;
    }

    return undefined;
}

/**
 * Parse YAML frontmatter from a markdown file to extract description and author
 * For custom commands (.claude/commands/*.md)
 * Author can be at top-level (author/Author) or nested (metadata.author/Author)
 * Format:
 * ---
 * description: Some description here
 * author: author-name
 * ---
 */
export function parseYamlFrontmatter(content: string): { description?: string; author?: string } {
    try {
        const extracted = extractFrontmatter(content);
        if (!extracted) {
            return {};
        }
        const parsed = yamlLoad(extracted.frontmatterStr) as Record<string, unknown> | null;
        if (!parsed || typeof parsed !== 'object') {
            return {};
        }
        return {
            description: typeof parsed.description === 'string' ? parsed.description : undefined,
            author: extractAuthor(parsed)
        };
    } catch (e) {
        console.warn('Failed to parse YAML frontmatter:', e);
        return {};
    }
}

/**
 * Parse YAML frontmatter from a SKILL.md file to extract name, description and author
 * Skills use 'name' and 'description' fields in frontmatter
 * Author can be at top-level (author/Author) or nested (metadata.author/Author)
 * Format:
 * ---
 * name: skill-name
 * description: "What this skill does and when to use it"
 * author: author-name
 * ---
 * or:
 * ---
 * name: skill-name
 * metadata:
 *   author: author-name
 * ---
 */
export function parseSkillFrontmatter(content: string): { name?: string; description?: string; author?: string; displayName?: string; displayDescription?: string } {
    try {
        const extracted = extractFrontmatter(content);
        let name: string | undefined;
        let description: string | undefined;
        let author: string | undefined;
        let displayName: string | undefined;
        let displayDescription: string | undefined;

        if (extracted) {
            const parsed = yamlLoad(extracted.frontmatterStr) as Record<string, unknown> | null;
            if (parsed && typeof parsed === 'object') {
                name = typeof parsed.name === 'string' ? parsed.name : undefined;
                description = typeof parsed.description === 'string' ? parsed.description : undefined;
                author = extractAuthor(parsed);
                displayName = typeof parsed.displayName === 'string' ? parsed.displayName : undefined;
                displayDescription = typeof parsed.displayDescription === 'string' ? parsed.displayDescription : undefined;
            }
        }

        // If name is not in frontmatter, try to extract from first # heading in body
        if (!name) {
            const bodyContent = extracted?.body || content;
            const headingMatch = bodyContent.match(/^#\s+(.+)$/m);
            if (headingMatch) {
                name = headingMatch[1].trim();
            }
        }

        return { name, description, author, displayName, displayDescription };
    } catch (e) {
        console.warn('Failed to parse skill frontmatter:', e);
        return {};
    }
}

/**
 * Extract command name from file path
 * e.g., "/path/to/review-code.md" -> "review-code"
 * Supports both / and \ path separators for cross-platform compatibility
 */
export function extractCommandName(filePath: string): string {
    const fileName = filePath.split(/[\\/]/).pop() || '';
    return fileName.replace(/\.md$/, '');
}

/**
 * Parse complete SKILL.md frontmatter with all fields
 * Returns both frontmatter and markdown body content
 */
export function parseFullSkillContent(content: string): {
    frontmatter: Partial<SkillFrontmatter>;
    body: string;
} {
    try {
        const extracted = extractFrontmatter(content);
        if (!extracted) {
            return { frontmatter: {}, body: content };
        }

        const parsed = yamlLoad(extracted.frontmatterStr) as Record<string, unknown> | null;
        if (!parsed || typeof parsed !== 'object') {
            return { frontmatter: {}, body: extracted.body };
        }

        const frontmatter: Partial<SkillFrontmatter> = {};

        if (typeof parsed.name === 'string') frontmatter.name = parsed.name;
        if (typeof parsed.description === 'string') frontmatter.description = parsed.description;
        if (typeof parsed['disable-model-invocation'] === 'boolean') {
            frontmatter['disable-model-invocation'] = parsed['disable-model-invocation'];
        }
        if (typeof parsed['user-invocable'] === 'boolean') {
            frontmatter['user-invocable'] = parsed['user-invocable'];
        }
        if (typeof parsed['allowed-tools'] === 'string') {
            frontmatter['allowed-tools'] = parsed['allowed-tools'];
        }
        if (typeof parsed.context === 'string') frontmatter.context = parsed.context;
        if (typeof parsed.agent === 'string') frontmatter.agent = parsed.agent;
        if (typeof parsed['argument-hint'] === 'string') {
            frontmatter['argument-hint'] = parsed['argument-hint'];
        }

        return { frontmatter, body: extracted.body };
    } catch (e) {
        console.warn('Failed to parse full skill content:', e);
        return { frontmatter: {}, body: content };
    }
}

/**
 * Parse complete Command file content
 * Returns both frontmatter and markdown body content
 * If name is not in frontmatter, tries to extract from first # heading in body
 */
export function parseFullCommandContent(content: string): {
    frontmatter: Partial<CommandFrontmatter>;
    body: string;
} {
    try {
        const extracted = extractFrontmatter(content);
        if (!extracted) {
            // No frontmatter, try to extract name from # heading
            const headingMatch = content.match(/^#\s+(.+)$/m);
            const name = headingMatch ? headingMatch[1].trim() : undefined;
            return { frontmatter: name ? { name } : {}, body: content };
        }

        const parsed = yamlLoad(extracted.frontmatterStr) as Record<string, unknown> | null;
        if (!parsed || typeof parsed !== 'object') {
            return { frontmatter: {}, body: extracted.body };
        }

        const frontmatter: Partial<CommandFrontmatter> = {};
        if (typeof parsed.name === 'string') {
            frontmatter.name = parsed.name;
        }
        if (typeof parsed.description === 'string') {
            frontmatter.description = parsed.description;
        }
        // Extract author from top-level or nested metadata
        const author = extractAuthor(parsed);
        if (author) {
            frontmatter.author = author;
        }

        // If name is not in frontmatter, try to extract from first # heading in body
        if (!frontmatter.name) {
            const headingMatch = extracted.body.match(/^#\s+(.+)$/m);
            if (headingMatch) {
                frontmatter.name = headingMatch[1].trim();
            }
        }

        return { frontmatter, body: extracted.body };
    } catch (e) {
        console.warn('Failed to parse full command content:', e);
        return { frontmatter: {}, body: content };
    }
}

/**
 * Serialize Skill frontmatter and body back to SKILL.md format
 */
export function serializeSkillContent(frontmatter: Partial<SkillFrontmatter>, body: string): string {
    const lines: string[] = ['---'];

    if (frontmatter.name) lines.push(`name: ${frontmatter.name}`);
    if (frontmatter.description) lines.push(`description: "${frontmatter.description.replace(/"/g, '\\"')}"`);
    if (frontmatter['disable-model-invocation'] !== undefined) {
        lines.push(`disable-model-invocation: ${frontmatter['disable-model-invocation']}`);
    }
    if (frontmatter['user-invocable'] !== undefined) {
        lines.push(`user-invocable: ${frontmatter['user-invocable']}`);
    }
    if (frontmatter['allowed-tools']) lines.push(`allowed-tools: ${frontmatter['allowed-tools']}`);
    if (frontmatter.context) lines.push(`context: ${frontmatter.context}`);
    if (frontmatter.agent) lines.push(`agent: ${frontmatter.agent}`);
    if (frontmatter['argument-hint']) lines.push(`argument-hint: ${frontmatter['argument-hint']}`);

    lines.push('---');
    lines.push('');
    lines.push(body.trim());

    return lines.join('\n');
}

/**
 * Serialize Command frontmatter and body back to markdown format
 */
export function serializeCommandContent(frontmatter: Partial<CommandFrontmatter>, body: string): string {
    const lines: string[] = ['---'];

    // Always quote name to handle special characters (colons, quotes, etc.)
    if (frontmatter.name) {
        lines.push(`name: "${frontmatter.name.replace(/"/g, '\\"')}"`);
    }
    if (frontmatter.description) {
        lines.push(`description: "${frontmatter.description.replace(/"/g, '\\"')}"`);
    }

    lines.push('---');
    lines.push('');
    lines.push(body.trim());

    return lines.join('\n');
}
