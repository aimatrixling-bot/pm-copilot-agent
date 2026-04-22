// IM Bot Bridge Tools — Dynamic MCP proxy for OpenClaw plugin tools
// Fetches tool definitions from Bridge's /mcp/tools endpoint at context-set time,
// then creates one MCP tool per plugin tool — transparent passthrough, no hardcoding.

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';

type CallToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

// ===== Auto-auth helper =====

/** Trigger the plugin's "feishu_auth" command to send an OAuth card to the user. */
async function triggerAutoAuth(ctx: ImBridgeToolsContext): Promise<CallToolResult> {
  console.log('[im-bridge-tools] need_user_authorization detected, triggering auto-auth via feishu_auth command');
  try {
    const resp = await fetch(`http://127.0.0.1:${ctx.bridgePort}/execute-command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: 'feishu_auth',
        args: '',
        userId: ctx.senderId || '',
        chatId: ctx.chatId || '',
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      console.warn(`[im-bridge-tools] Auto-auth command failed (${resp.status}): ${errText}`);
      return {
        content: [{ type: 'text', text: `该操作需要用户授权飞书权限。自动发送授权卡片失败 (${resp.status})，请用户使用 /feishu_auth 命令手动授权后重试。` }],
        isError: true,
      };
    }
    const result = await resp.json().catch(() => null) as { ok?: boolean; error?: string } | null;
    if (result && !result.ok) {
      console.warn(`[im-bridge-tools] Auto-auth command returned error: ${result.error}`);
      return {
        content: [{ type: 'text', text: `该操作需要用户授权飞书权限。授权流程出错: ${result.error || 'unknown'}，请用户使用 /feishu_auth 命令手动授权后重试。` }],
        isError: true,
      };
    }
  } catch (e) {
    console.warn('[im-bridge-tools] Auto-auth request failed:', e);
    return {
      content: [{ type: 'text', text: '该操作需要用户授权飞书权限。自动授权请求失败，请用户使用 /feishu_auth 命令手动授权后重试。' }],
      isError: true,
    };
  }
  return {
    content: [{ type: 'text', text: '该操作需要用户授权飞书权限。已自动发送授权卡片，请用户在飞书中点击"前往授权"完成授权后重试。' }],
  };
}

// ===== Bridge Tools Context =====

interface ImBridgeToolsContext {
  bridgePort: number;
  enabledToolGroups: string[];
  pluginId: string;
  /** Feishu sender open_id for tool calls that need user context */
  senderId?: string;
  /** Chat ID for sending messages (e.g., auth cards) back to the user */
  chatId?: string;
  /** Whether the sender is in the allowed_users whitelist (owner) */
  isOwner?: boolean;
  /** Chat type: 'private' (p2p) or 'group' */
  sourceType?: string;
  /** Feishu account ID for multi-account routing (default: 'default') */
  accountId?: string;
}

let bridgeToolsContext: ImBridgeToolsContext | null = null;

/** Cached dynamic MCP server — rebuilt when context changes */
let dynamicServer: ReturnType<typeof createSdkMcpServer> | null = null;

/**
 * Set bridge tools context and dynamically create MCP server from plugin tools.
 * Fetches actual tool definitions from Bridge and creates one MCP tool per plugin tool.
 */
export async function setImBridgeToolsContext(ctx: ImBridgeToolsContext): Promise<void> {
  bridgeToolsContext = ctx;
  console.log(`[im-bridge-tools] Context set: bridge=${ctx.bridgePort}, groups=${ctx.enabledToolGroups.join(',')}, plugin=${ctx.pluginId}`);

  // Fetch tools from Bridge and build dynamic MCP server
  try {
    // Always inject 'interaction' group for auth recovery (oauth, ask_user_question).
    const allGroups = [...new Set([...ctx.enabledToolGroups, 'interaction'])];
    const groups = allGroups.join(',');
    const url = `http://127.0.0.1:${ctx.bridgePort}/mcp/tools${groups ? `?groups=${groups}` : ''}`;
    const resp = await fetch(url, { headers: { 'Content-Type': 'application/json' } });
    if (!resp.ok) {
      console.warn(`[im-bridge-tools] Failed to fetch tools: ${resp.status}`);
      dynamicServer = null;
      return;
    }

    const data = await resp.json() as {
      ok: boolean;
      tools: Array<{ name: string; description: string; group: string; parameters: Record<string, unknown> }>;
    };

    if (!data.ok || !data.tools || data.tools.length === 0) {
      // Not an error — some plugins (e.g. WeChat) don't provide MCP tools.
      // Use console.log instead of console.warn to avoid misleading [ERROR] in unified log
      // (Bun stderr capture marks all console.warn output as ERROR level).
      console.log('[im-bridge-tools] No tools available from Bridge (plugin may not provide tools, this is normal)');
      dynamicServer = null;
      return;
    }

    // Create one MCP tool per plugin tool — transparent passthrough
    // Filter out tools with missing names, and ensure description is always a string
    const dynamicTools = data.tools.filter(t => t.name).map(pluginTool =>
      tool(
        pluginTool.name,
        pluginTool.description || '',
        // Pass through all arguments as a generic record.
        // The plugin's description already documents the expected parameters.
        { args: z.record(z.string(), z.any()).describe('Tool arguments as key-value pairs') },
        async (params: { args: Record<string, unknown> }): Promise<CallToolResult> => {
          if (!bridgeToolsContext) {
            return {
              content: [{ type: 'text', text: 'Error: No Bridge context available.' }],
              isError: true,
            };
          }

          try {
            const callUrl = `http://127.0.0.1:${bridgeToolsContext.bridgePort}/mcp/call-tool`;
            const callResp = await fetch(callUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                toolName: pluginTool.name,
                args: params.args,
                userId: bridgeToolsContext.senderId,
                isOwner: bridgeToolsContext.isOwner ?? false,
                enabledGroups: [...new Set([...bridgeToolsContext.enabledToolGroups, 'interaction'])],
                // Ticket context for LarkTicket injection (Feishu OAuth auto-auth)
                chatId: bridgeToolsContext.chatId,
                chatType: bridgeToolsContext.sourceType === 'group' ? 'group' : 'p2p',
                accountId: bridgeToolsContext.accountId,
              }),
            });

            if (!callResp.ok) {
              const text = await callResp.text();
              return {
                content: [{ type: 'text', text: `Tool call failed (${callResp.status}): ${text}` }],
                isError: true,
              };
            }

            const result = await callResp.json() as { ok: boolean; result?: unknown; error?: string };
            if (!result.ok) {
              // Auto-trigger OAuth for need_user_authorization (may come as Bridge-level error)
              if (result.error?.includes('need_user_authorization') && bridgeToolsContext?.chatId) {
                return await triggerAutoAuth(bridgeToolsContext);
              }
              return {
                content: [{ type: 'text', text: `Tool error: ${result.error || 'unknown'}` }],
                isError: true,
              };
            }

            // OpenClaw tools return {content: [{type:'text', text:'...'}], details: ...}
            // Extract content[0].text directly to avoid double-encoding JSON
            const raw = result.result as Record<string, unknown> | string | null | undefined;
            let resultText: string;
            if (typeof raw === 'string') {
              resultText = raw;
            } else if (raw != null && Array.isArray((raw as Record<string, unknown>).content)) {
              const content = (raw as { content: Array<{ type: string; text?: string }> }).content;
              resultText = content.map(c => c.text ?? '').join('\n') || 'OK (empty result)';
            } else if (raw != null) {
              resultText = JSON.stringify(raw, null, 2);
            } else {
              resultText = 'OK (no data returned)';
            }

            // Auto-trigger OAuth when Feishu returns need_user_authorization.
            if (resultText.includes('need_user_authorization') && bridgeToolsContext?.chatId) {
              return await triggerAutoAuth(bridgeToolsContext);
            }

            return { content: [{ type: 'text', text: resultText }] };
          } catch (err) {
            return {
              content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            };
          }
        },
      ),
    );

    dynamicServer = createSdkMcpServer({
      name: 'im-bridge-tools',
      version: '1.0.0',
      tools: dynamicTools,
    });

    console.log(`[im-bridge-tools] Dynamic MCP server created with ${data.tools.length} tools: ${data.tools.map(t => t.name).join(', ')}`);
  } catch (err) {
    console.warn(`[im-bridge-tools] Failed to create dynamic server: ${err}`);
    dynamicServer = null;
  }
}

export function clearImBridgeToolsContext(): void {
  bridgeToolsContext = null;
  dynamicServer = null;
  console.log('[im-bridge-tools] Context cleared');
}

export function getImBridgeToolsContext(): ImBridgeToolsContext | null {
  return bridgeToolsContext;
}

/**
 * Get the dynamically created MCP server (null if no tools available).
 * Called by buildSdkMcpServers() in agent-session.ts.
 */
export function getImBridgeToolServer(): ReturnType<typeof createSdkMcpServer> | null {
  return dynamicServer;
}
