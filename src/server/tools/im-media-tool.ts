// IM Bot Media Tool — AI-driven media sending for IM Bots
// Uses Rust Management API (via PM_COPILOT_MANAGEMENT_PORT) for file upload/send

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';

// MCP Tool Result type
type CallToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

// ===== IM Media Context =====

interface ImMediaContext {
  botId: string;
  chatId: string;
  platform: string; // "telegram" | "feishu"
}

let imMediaContext: ImMediaContext | null = null;

export function setImMediaContext(ctx: ImMediaContext): void {
  imMediaContext = ctx;
  console.log(`[im-media] Context set: botId=${ctx.botId}, chatId=${ctx.chatId}, platform=${ctx.platform}`);
}

export function clearImMediaContext(): void {
  imMediaContext = null;
  console.log('[im-media] Context cleared');
}

export function getImMediaContext(): ImMediaContext | null {
  return imMediaContext;
}

// ===== Management API client =====

const MANAGEMENT_PORT = process.env.PM_COPILOT_MANAGEMENT_PORT;

async function managementApi(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown): Promise<unknown> {
  if (!MANAGEMENT_PORT) {
    throw new Error('PM_COPILOT_MANAGEMENT_PORT not set — management API unavailable');
  }

  const url = `http://127.0.0.1:${MANAGEMENT_PORT}${path}`;
  const options: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body && method === 'POST') {
    options.body = JSON.stringify(body);
  }

  const resp = await fetch(url, options);
  return resp.json();
}

// ===== Tool handler =====

async function sendMediaHandler(args: {
  file_path: string;
  caption?: string;
}): Promise<CallToolResult> {
  if (!MANAGEMENT_PORT) {
    return {
      content: [{ type: 'text', text: 'Error: Management API is not available (PM_COPILOT_MANAGEMENT_PORT not set).' }],
      isError: true,
    };
  }

  if (!imMediaContext) {
    return {
      content: [{ type: 'text', text: 'Error: No IM context available. This tool can only be used within an IM Bot session.' }],
      isError: true,
    };
  }

  try {
    const result = await managementApi('/api/im/send-media', 'POST', {
      botId: imMediaContext.botId,
      chatId: imMediaContext.chatId,
      platform: imMediaContext.platform,
      filePath: args.file_path,
      caption: args.caption,
    }) as { ok: boolean; fileName?: string; fileSize?: number; error?: string };

    if (result.ok) {
      const sizeMb = result.fileSize ? `${(result.fileSize / (1024 * 1024)).toFixed(2)} MB` : 'unknown size';
      return {
        content: [{
          type: 'text',
          text: `File sent successfully: ${result.fileName} (${sizeMb})`,
        }],
      };
    }

    return {
      content: [{ type: 'text', text: `Failed to send file: ${result.error}` }],
      isError: true,
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
}

// ===== Server creation =====

export function createImMediaToolServer() {
  return createSdkMcpServer({
    name: 'im-media',
    version: '1.0.0',
    tools: [
      tool(
        'send_media',
        `Send a file (image, document, audio, video, archive) to the current IM chat.

Use this tool when the user asks you to:
- Send a file, image, screenshot, or document to the chat
- Share a generated file (CSV, PDF, chart image, etc.)
- Upload and deliver media content

The file must exist on disk. Write it first with file tools, then call send_media.

Supported formats:
- Images: jpg, jpeg, png, gif, webp, bmp, svg (sent as native photo, max 10 MB)
- Documents: pdf, doc/docx, xls/xlsx, ppt/pptx, csv, json, xml, html, txt
- Media: mp4, mp3, ogg, wav, avi, mov, mkv
- Archives: zip, rar, 7z, tar, gz
- Files over 10 MB (images) or 50 MB (other) will be rejected.

Do NOT use this tool for intermediate work files — only for files the user explicitly wants to receive.`,
        {
          file_path: z.string().describe('Absolute path to the file on disk'),
          caption: z.string().optional().describe('Optional caption/description to send with the file'),
        },
        sendMediaHandler,
      ),
    ],
  });
}

export const imMediaToolServer = createImMediaToolServer();
