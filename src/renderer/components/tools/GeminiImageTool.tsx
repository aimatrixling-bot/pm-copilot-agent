import { useState, useCallback, useEffect, useRef } from 'react';
import type { ToolUseSimple } from '@/types/chat';
import { CollapsibleTool } from './CollapsibleTool';
import { ToolHeader, unwrapMcpResult } from './utils';
import { useImagePreview } from '@/context/ImagePreviewContext';
import { readLocalFileAsBlobUrl } from '@/utils/audioPlayer';

interface GeminiImageToolProps {
  tool: ToolUseSimple;
}

/** Parse structured fields from the tool result text */
function parseToolResult(result: string | undefined): {
  contextId?: string;
  filePath?: string;
  resolution?: string;
  aspectRatio?: string;
  model?: string;
  description?: string;
  editCount?: number;
  isEdit: boolean;
  error?: string;
} {
  if (!result) return { isEdit: false };

  // Unwrap JSON-encoded MCP content array if present
  const unwrapped = unwrapMcpResult(result);
  if (unwrapped !== result) return parseToolResult(unwrapped);

  const lines = result.split('\n');
  const fields: Record<string, string> = {};

  for (const line of lines) {
    const match = line.match(/^(\w+):\s*(.+)$/);
    if (match) {
      fields[match[1]] = match[2].trim();
    }
  }

  // Extract edit count from "图片已编辑（第 N 次修改）"
  const editMatch = result.match(/第\s*(\d+)\s*次修改/);
  const editCount = editMatch ? parseInt(editMatch[1], 10) : undefined;

  // Detect if it's an edit operation
  const isEdit = result.includes('图片已编辑');

  // Check for errors
  const isError = result.startsWith('Error');

  // Extract description after "图片描述:" line
  const descMatch = result.match(/图片描述:\s*(.+?)(?:\n\n|$)/s);
  const description = descMatch?.[1]?.trim() || fields['description'];

  return {
    contextId: fields['contextId'],
    filePath: fields['filePath'],
    resolution: fields['resolution']?.split('|')[0]?.trim(),
    aspectRatio: fields['aspectRatio'] || fields['resolution']?.split('|')[1]?.replace('aspectRatio:', '')?.trim(),
    model: fields['model'],
    description,
    editCount,
    isEdit,
    error: isError ? result : undefined,
  };
}

/** Infer MIME type from image file extension */
function imageMime(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
  return map[ext ?? ''] ?? 'image/png';
}

export default function GeminiImageTool({ tool }: GeminiImageToolProps) {
  const parsed = parseToolResult(tool.result);
  const { openPreview } = useImagePreview();
  // Use key-based reset instead of useEffect setState to avoid cascading renders
  const resultKey = tool.result ?? '';
  const [imageState, setImageState] = useState<{ loaded: boolean; error: boolean; key: string }>({ loaded: false, error: false, key: resultKey });
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const blobUrlRef = useRef<string | null>(null);

  // Reset when result changes (via key comparison, not effect)
  const imageLoaded = imageState.key === resultKey ? imageState.loaded : false;
  const imageError = imageState.key === resultKey ? imageState.error : false;

  // Resolve image URL (blob URL in Tauri, direct URL in browser)
  useEffect(() => {
    if (!parsed.filePath) {
      // Use rAF to avoid synchronous setState in effect body (react-hooks/set-state-in-effect)
      const id = requestAnimationFrame(() => setImageUrl(null));
      return () => cancelAnimationFrame(id);
    }
    const filePath = parsed.filePath;
    let cancelled = false;

    readLocalFileAsBlobUrl(filePath, imageMime(filePath), '/api/image')
      .then(url => {
        if (cancelled) {
          if (url.startsWith('blob:')) URL.revokeObjectURL(url);
          return;
        }
        // Revoke previous blob URL
        if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = url.startsWith('blob:') ? url : null;
        setImageUrl(url);
      })
      .catch(() => {
        if (!cancelled) setImageState({ loaded: false, error: true, key: resultKey });
      });

    return () => {
      cancelled = true;
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, [parsed.filePath, resultKey]);

  const toolLabel = tool.name.includes('edit_image') ? '编辑图片' : '生成图片';
  const isGenerating = !tool.result;

  const handleImageClick = useCallback(() => {
    if (imageUrl) {
      openPreview(imageUrl, parsed.filePath?.split('/').pop() || 'image.png');
    }
  }, [imageUrl, parsed.filePath, openPreview]);

  const collapsedContent = (
    <div className="flex items-center gap-1.5">
      <ToolHeader tool={tool} toolName={tool.name} label={toolLabel} />
      {isGenerating && (
        <span className="text-[10px] text-[var(--ink-muted)] animate-pulse">生成中...</span>
      )}
      {parsed.isEdit && parsed.editCount && (
        <span className="rounded bg-[var(--paper-inset)] px-1.5 py-0.5 text-[10px] text-[var(--ink-muted)]">
          #{parsed.editCount}
        </span>
      )}
      {parsed.description && (
        <span className="truncate text-[10px] text-[var(--ink-muted)] max-w-[300px]">
          {parsed.description}
        </span>
      )}
    </div>
  );

  const expandedContent = (
    <div className="space-y-2 mt-1">
      {/* Parameters */}
      {tool.inputJson && (
        <div className="text-[10px] text-[var(--ink-muted)] font-mono">
          {(() => {
            try {
              const input = JSON.parse(tool.inputJson);
              return (
                <div className="space-y-0.5">
                  {input.prompt && <div><span className="opacity-60">prompt:</span> {input.prompt}</div>}
                  {input.instruction && <div><span className="opacity-60">instruction:</span> {input.instruction}</div>}
                  {input.contextId && <div><span className="opacity-60">contextId:</span> {input.contextId}</div>}
                  {input.aspectRatio && <div><span className="opacity-60">aspectRatio:</span> {input.aspectRatio}</div>}
                  {input.resolution && <div><span className="opacity-60">resolution:</span> {input.resolution}</div>}
                </div>
              );
            } catch {
              return <pre className="break-words whitespace-pre-wrap">{tool.inputJson}</pre>;
            }
          })()}
        </div>
      )}

      {/* Image display */}
      {parsed.filePath && !parsed.error && (
        <div className="mt-2">
          <div
            className="relative cursor-pointer group rounded-lg overflow-hidden inline-block border border-[var(--line-subtle)]"
            onClick={handleImageClick}
          >
            {!imageLoaded && !imageError && (
              <div className="w-[300px] h-[200px] bg-[var(--paper-inset)] animate-pulse rounded-lg flex items-center justify-center">
                <span className="text-xs text-[var(--ink-muted)]">加载中...</span>
              </div>
            )}
            {imageError && (
              <div className="w-[300px] h-[200px] bg-[var(--paper-inset)] rounded-lg flex items-center justify-center">
                <span className="text-xs text-[var(--error)]">图片加载失败</span>
              </div>
            )}
            {imageUrl && (
              <img
                src={imageUrl}
                alt={parsed.description || toolLabel}
                className={`max-w-[400px] max-h-[400px] rounded-lg transition-opacity ${imageLoaded ? 'opacity-100' : 'opacity-0 absolute'}`}
                onLoad={() => setImageState({ loaded: true, error: false, key: resultKey })}
                onError={() => setImageState({ loaded: false, error: true, key: resultKey })}
              />
            )}
            {imageLoaded && (
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors rounded-lg flex items-center justify-center">
                <span className="opacity-0 group-hover:opacity-100 text-white text-xs bg-black/50 px-2 py-1 rounded transition-opacity">
                  点击放大
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Metadata */}
      {parsed.contextId && (
        <div className="text-[10px] text-[var(--ink-muted)] space-y-0.5 mt-1">
          {parsed.resolution && <div>分辨率: {parsed.resolution} {parsed.aspectRatio && `| 宽高比: ${parsed.aspectRatio}`}</div>}
          {parsed.model && <div>模型: {parsed.model}</div>}
          <div className="font-mono opacity-60">contextId: {parsed.contextId}</div>
        </div>
      )}

      {/* Error display */}
      {parsed.error && (
        <pre className="overflow-x-auto rounded bg-[var(--error-bg)] px-2 py-1 font-mono text-xs break-words whitespace-pre-wrap text-[var(--error)]">
          {parsed.error}
        </pre>
      )}

      {/* Description from Gemini */}
      {parsed.description && !parsed.error && (
        <div className="text-xs text-[var(--ink-secondary)] mt-1">
          {parsed.description}
        </div>
      )}
    </div>
  );

  return <CollapsibleTool collapsedContent={collapsedContent} expandedContent={expandedContent} />;
}
