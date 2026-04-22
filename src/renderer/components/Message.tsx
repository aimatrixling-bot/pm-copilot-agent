import { Fragment, memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, Copy, Check, Undo2, RotateCcw, GitBranch, CheckCircle, XCircle, AlertCircle, Download } from 'lucide-react';

import { track } from '@/analytics';
import AttachmentPreviewList from '@/components/AttachmentPreviewList';
import BlockGroup from '@/components/BlockGroup';
import Markdown from '@/components/Markdown';
import WidgetRenderer from '@/components/tools/WidgetRenderer';
import { parseWidgetTags, hasWidgetTags } from '@/components/tools/widgetTagParser';
import Tip from '@/components/Tip';
import { useImagePreview } from '@/context/ImagePreviewContext';
import type { ContentBlock, Message as MessageType } from '@/types/chat';
import { SOURCE_LABELS, type MessageSource } from '../../shared/types/im';

interface MessageProps {
  message: MessageType;
  isLoading?: boolean;
  onRewind?: (messageId: string) => void;
  onRetry?: (assistantMessageId: string) => void;
  onFork?: (assistantMessageId: string) => void;
  /** Slot rendered after the BlockGroup containing ExitPlanMode tool */
  exitPlanModeSlot?: ReactNode;
}

/**
 * Format timestamp to "YYYY-MM-DD HH:mm:ss"
 */
function formatTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * Deep compare message content for memo optimization.
 * Returns true if content is equal (skip re-render), false otherwise.
 */
function areMessagesEqual(prev: MessageProps, next: MessageProps): boolean {
  // Different loading state -> must re-render
  if (prev.isLoading !== next.isLoading) return false;
  // NOTE: isStreaming was removed from props — rewind button visibility is now
  // controlled via CSS ([data-streaming] selector on the scroll container).
  // This eliminates mass re-renders of ALL N history messages when streaming
  // state changes (~30px × N ≈ 1500+px layout-recalc in long sessions).
  // exitPlanModeSlot — useMemo in MessageList keeps reference stable during streaming
  if (prev.exitPlanModeSlot !== next.exitPlanModeSlot) return false;
  // onRewind/onRetry 不比较 — 通过 Chat.tsx useCallback([]) + ref 保证稳定

  const prevMsg = prev.message;
  const nextMsg = next.message;

  // Same reference -> definitely equal (fast path for history messages)
  if (prevMsg === nextMsg) return true;

  // Different ID -> different message
  if (prevMsg.id !== nextMsg.id) return false;

  // Metadata change -> must re-render
  if (prevMsg.metadata?.source !== nextMsg.metadata?.source) return false;

  // sdkUuid change -> must re-render (fork button depends on sdkUuid presence)
  if (prevMsg.sdkUuid !== nextMsg.sdkUuid) return false;

  // For streaming messages, check content changes
  if (typeof prevMsg.content === 'string' && typeof nextMsg.content === 'string') {
    return prevMsg.content === nextMsg.content;
  }

  // ContentBlock array - compare by reference (streaming updates create new arrays)
  // This allows streaming message to re-render while history messages stay stable
  return prevMsg.content === nextMsg.content;
}

/**
 * Parse SDK local command output tags from user message content.
 * SDK wraps local command output (like /cost, /context) in <local-command-stdout> tags.
 * Returns { isLocalCommand: true, content: string } if found, otherwise { isLocalCommand: false }.
 */
function parseLocalCommandOutput(content: string): { isLocalCommand: boolean; content: string } {
  const match = content.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
  if (match) {
    return { isLocalCommand: true, content: match[1].trim() };
  }
  return { isLocalCommand: false, content };
}

/**
 * Parse background task notification tags injected by TabProvider.
 * These synthetic messages bridge background task completion so the user
 * understands why AI continues responding (prevents "AI talking to itself" UX).
 */
function parseTaskNotification(content: string): {
  isTaskNotification: boolean;
  taskId?: string; status?: string; summary?: string; description?: string;
} {
  const match = content.match(/<task-notification>([\s\S]*?)<\/task-notification>/);
  if (match) {
    try {
      const data = JSON.parse(match[1]);
      return { isTaskNotification: true, ...data };
    } catch { /* malformed JSON — treat as normal message */ }
  }
  return { isTaskNotification: false };
}

/**
 * Format local command output for better readability.
 * SDK outputs like /cost already have proper newlines, but contain $ signs
 * that trigger LaTeX math mode in our Markdown renderer (KaTeX).
 * This function escapes $ to prevent unintended math rendering.
 */
function formatLocalCommandOutput(content: string): string {
  // Escape $ signs that trigger LaTeX math mode
  // Example: "$0.0576" -> "\$0.0576"
  return content.replace(/\$/g, '\\$');
}

/**
 * Extract plain text from assistant message content for clipboard copy.
 * Only includes text blocks (excludes thinking/tool content).
 */
function extractAssistantText(content: MessageType['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((b): b is ContentBlock & { type: 'text' } => b.type === 'text')
    .map(b => b.text || '')
    .join('\n\n');
}

/**
 * Action bar for assistant messages: copy + retry.
 * Always visible (not hover), left-aligned icon buttons.
 */
function AssistantActions({ message, onRetry, onFork, className = '' }: {
  message: MessageType;
  onRetry?: (id: string) => void;
  onFork?: (id: string) => void;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, []);

  const text = extractAssistantText(message.content);

  const handleDownload = () => {
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pm-copilot-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
    track('message_export_md', {});
  };

  return (
    <div className={`flex items-center gap-2 -ml-1 pt-1 ${className}`}>
      <Tip label={copied ? '已复制' : '复制'}>
        <button type="button"
          aria-label="复制"
          onClick={() => {
            navigator.clipboard.writeText(text).catch(() => {});
            track('message_copy', {});
            setCopied(true);
            if (timerRef.current) clearTimeout(timerRef.current);
            timerRef.current = setTimeout(() => setCopied(false), 1500);
          }}
          className="rounded-lg p-1 text-[var(--ink-muted)] transition-all hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]">
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </button>
      </Tip>
      <Tip label="下载 Markdown">
        <button type="button"
          aria-label="下载 Markdown"
          onClick={handleDownload}
          className="rounded-lg p-1 text-[var(--ink-muted)] transition-all hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]">
          <Download className="size-3.5" />
        </button>
      </Tip>
      {onRetry && (
        <Tip label="重试">
          <button type="button"
            aria-label="重试"
            onClick={() => onRetry(message.id)}
            className="rounded-lg p-1 text-[var(--ink-muted)] transition-all hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]">
            <RotateCcw className="size-3.5" />
          </button>
        </Tip>
      )}
      {onFork && message.sdkUuid && (
        <Tip label="分支">
          <button type="button"
            aria-label="分支"
            onClick={() => onFork(message.id)}
            className="rounded-lg p-1 text-[var(--ink-muted)] transition-all hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]">
            <GitBranch className="size-3.5" />
          </button>
        </Tip>
      )}
    </div>
  );
}

/** Whitelist: system-injection tags → display label (for user message badge) */
const SYSTEM_TAG_MAP: Record<string, string> = {
  'HEARTBEAT': '心跳感知',
  'CRON_TASK': '定时任务',
};

/**
 * Message component with memo optimization.
 * History messages won't re-render when streaming message updates.
 */
const Message = memo(function Message({ message, isLoading = false, onRewind, onRetry, onFork, exitPlanModeSlot }: MessageProps) {
  const { openPreview } = useImagePreview();
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [userHovered, setUserHovered] = useState(false);
  // User message collapse: default collapsed, expand on click (no re-collapse)
  const [userExpanded, setUserExpanded] = useState(false);
  const userContentRef = useRef<HTMLDivElement>(null);
  const [userOverflows, setUserOverflows] = useState(false);

  // Delay AssistantActions rendering on the STREAMING message only.
  // Uses isLoading (not isStreaming) so that HISTORY messages (isLoading=false always)
  // keep their actions visible at all times. This prevents a massive layout shift
  // when streaming ends: previously all N history messages toggled actions simultaneously
  // (~30px × N ≈ 1500+px in long sessions), overwhelming scroll anchoring.
  const [actionsReady, setActionsReady] = useState(!isLoading);
  useEffect(() => {
    if (!isLoading) {
      const timer = setTimeout(() => setActionsReady(true), 350);
      return () => clearTimeout(timer);
    }
    setActionsReady(false); // eslint-disable-line react-hooks/set-state-in-effect -- synchronous reset is intentional: streaming just started, actions must hide immediately
  }, [isLoading]);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    };
  }, []);

  // Collapse threshold: 50vh at mount time (no resize reactivity needed — memo prevents re-render)
  const USER_COLLAPSE_HEIGHT = useMemo(() => typeof window !== 'undefined' ? window.innerHeight * 0.5 : 400, []);
  // Measure content height after DOM commit to determine if collapse is needed.
  // Uses rAF to avoid synchronous setState in effect body (react-hooks/set-state-in-effect).
  useEffect(() => {
    if (message.role !== 'user' || userExpanded) return;
    const rafId = requestAnimationFrame(() => {
      const el = userContentRef.current;
      if (el && el.scrollHeight > USER_COLLAPSE_HEIGHT) {
        setUserOverflows(true);
      }
    });
    return () => cancelAnimationFrame(rafId);
  }, [message.role, userExpanded, USER_COLLAPSE_HEIGHT]);

  if (message.role === 'user') {
    const rawUserContent = typeof message.content === 'string' ? message.content : '';

    // Detect system injection type from <system-reminder><TAG> wrapper (whitelist)
    let systemTag: string | null = null;
    const tagMatch = rawUserContent.match(/<system-reminder>\s*<(\w+)>/);
    if (tagMatch && tagMatch[1] in SYSTEM_TAG_MAP) {
      systemTag = SYSTEM_TAG_MAP[tagMatch[1]];
    }

    // Strip system injection tags that wrap delivered content. These HTML-like tags trigger
    // Markdown's HTML block mode, breaking \n rendering and Markdown syntax.
    const userContent = rawUserContent
      .replace(/<\/?system-reminder>/g, '')
      .replace(/<\/?HEARTBEAT>/g, '')
      .replace(/<\/?MEMORY_UPDATE>/g, '')
      .replace(/<\/?CRON_TASK>/g, '')
      .trim();
    const hasAttachments = Boolean(message.attachments?.length);
    const attachmentItems =
      message.attachments?.map((attachment) => ({
        id: attachment.id,
        name: attachment.name,
        size: attachment.size,
        isImage: attachment.isImage ?? attachment.mimeType.startsWith('image/'),
        previewUrl: attachment.previewUrl,
        footnoteLines: [attachment.relativePath ?? attachment.savedPath].filter(
          (line): line is string => Boolean(line)
        )
      })) ?? [];

    // Check if this is a background task notification
    const taskNotif = parseTaskNotification(userContent);
    if (taskNotif.isTaskNotification) {
      const isSuccess = taskNotif.status === 'completed';
      const StatusIcon = isSuccess ? CheckCircle : taskNotif.status === 'error' || taskNotif.status === 'failed' ? XCircle : AlertCircle;
      const statusColor = isSuccess ? 'var(--success)' : 'var(--error)';
      const statusLabel = isSuccess ? '已完成' : taskNotif.status === 'error' ? '出错' : taskNotif.status === 'failed' ? '失败' : '已停止';
      const displayText = taskNotif.description || taskNotif.summary || taskNotif.taskId || '后台任务';
      return (
        <div className="flex justify-start w-full px-4 py-1.5 select-none">
          <div className="flex items-center gap-2 rounded-lg px-3 py-2 text-[12px] text-[var(--ink-muted)]">
            <StatusIcon className="h-3.5 w-3.5 flex-shrink-0" style={{ color: statusColor }} />
            <span>后台任务</span>
            <span className="font-medium text-[var(--ink-secondary)]">&ldquo;{displayText}&rdquo;</span>
            <span>{statusLabel}</span>
            {taskNotif.summary && taskNotif.summary !== taskNotif.description && (
              <span className="text-[var(--ink-subtle)]">— {taskNotif.summary}</span>
            )}
          </div>
        </div>
      );
    }

    // Check if this is a local command output (like /cost, /context)
    const parsed = parseLocalCommandOutput(userContent);

    // Local command output - render as system info block (left-aligned)
    if (parsed.isLocalCommand) {
      const formattedContent = formatLocalCommandOutput(parsed.content);
      return (
        <div className="flex justify-start w-full px-4 py-2 select-none">
          <div className="w-full max-w-none rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)]/50 p-4">
            <div className="text-xs font-medium text-[var(--ink-muted)] mb-2">系统信息</div>
            <div className="text-sm text-[var(--ink)] select-text">
              <Markdown>{formattedContent}</Markdown>
            </div>
          </div>
        </div>
      );
    }

    const hasText = userContent.trim().length > 0;
    const imSource = message.metadata?.source;
    const isImMessage = imSource && imSource !== 'desktop';

    return (
      <div className="flex justify-end px-1 select-none"
           data-role="user" data-message-id={message.id}
           onMouseEnter={() => setUserHovered(true)}
           onMouseLeave={() => setUserHovered(false)}>
        <div className="flex w-full flex-col items-end">
          {/* IM source indicator */}
          {isImMessage && (
            <div className="mr-2 mb-1 flex items-center gap-1 text-[11px] text-[var(--ink-muted)]">
              {imSource?.includes('group') && <span>👥</span>}
              <span>via {SOURCE_LABELS[imSource as MessageSource] ?? imSource}</span>
            </div>
          )}
          <article className="relative w-fit max-w-[85%] rounded-2xl border border-[var(--line)] bg-[var(--paper-elevated)] px-4 py-3 text-base leading-relaxed text-[var(--ink)] shadow-md select-text">
            {/* System injection tag badge */}
            {systemTag && (
              <div className="mb-2 -mt-0.5">
                <span className="inline-block rounded-md bg-[var(--accent-warm-subtle)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--accent-warm)]">
                  {systemTag}
                </span>
              </div>
            )}
            {/* Collapsible content wrapper: max 50vh when collapsed */}
            <div
              ref={userContentRef}
              className={!userExpanded && userOverflows ? 'overflow-hidden' : ''}
              style={!userExpanded && userOverflows ? { maxHeight: `${USER_COLLAPSE_HEIGHT}px` } : undefined}
            >
              {hasAttachments && (
                <div className={hasText ? 'mb-2' : ''}>
                  <AttachmentPreviewList
                    attachments={attachmentItems}
                    compact
                    onPreview={openPreview}
                  />
                </div>
              )}
              {hasText && (
                <div className="text-[var(--ink)]">
                  <Markdown preserveNewlines>{userContent}</Markdown>
                </div>
              )}
            </div>
            {/* Expand button with gradient fade — gradient overlaps bottom of content */}
            {!userExpanded && userOverflows && (
              <div className="relative z-10 -mx-4 -mb-3 -mt-14">
                <div className="pointer-events-none h-14 bg-gradient-to-t from-[var(--paper-elevated)] to-transparent" />
                <button
                  type="button"
                  onClick={() => setUserExpanded(true)}
                  className="flex w-full items-center justify-center gap-1 rounded-b-2xl bg-[var(--paper-elevated)] py-1.5 text-[12px] font-medium text-[var(--ink-muted)] transition-colors hover:text-[var(--ink)]"
                >
                  <ChevronDown className="size-3.5" />
                  展开
                </button>
              </div>
            )}
          </article>
          {/* 操作栏：时间 + 图标按钮，hover 淡入 */}
          <div className={`mr-2 mt-1 flex items-center gap-2 transition-opacity ${userHovered ? 'opacity-100' : 'opacity-0'}`}>
            <span className="text-[11px] text-[var(--ink-muted)] mr-1">{formatTimestamp(message.timestamp)}</span>
            {onRewind && (
              <span data-rewind-btn>
                <Tip label="时间回溯">
                  <button type="button"
                    aria-label="时间回溯"
                    onClick={() => onRewind(message.id)}
                    className="rounded-lg p-1 text-[var(--ink-muted)] transition-all hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]">
                    <Undo2 className="size-3.5" />
                  </button>
                </Tip>
              </span>
            )}
            <Tip label={copied ? '已复制' : '复制'}>
              <button type="button"
                aria-label="复制"
                onClick={() => {
                  navigator.clipboard.writeText(userContent).catch(() => {});
                  setCopied(true);
                  if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
                  copiedTimerRef.current = setTimeout(() => setCopied(false), 1500);
                }}
                className="rounded-lg p-1 text-[var(--ink-muted)] transition-all hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]">
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              </button>
            </Tip>
          </div>
        </div>
      </div>
    );
  }

  // Assistant message
  if (typeof message.content === 'string') {
    return (
      <div className="flex justify-start w-full px-4 py-2 select-none" data-role="assistant">
        <div className="w-full max-w-none">
          <div className="text-[var(--ink)] select-text">
            <Markdown>{message.content}</Markdown>
          </div>
          {actionsReady && !isLoading && <AssistantActions message={message} onRetry={onRetry} onFork={onFork} />}
        </div>
      </div>
    );
  }

  // Group consecutive thinking/tool blocks together, merge adjacent text blocks
  const groupedBlocks: (ContentBlock | ContentBlock[])[] = [];
  let currentGroup: ContentBlock[] = [];

  for (const block of message.content) {
    if (block.type === 'text') {
      // If we have a group, add it before the text block
      if (currentGroup.length > 0) {
        groupedBlocks.push([...currentGroup]);
        currentGroup = [];
      }
      // Merge consecutive text blocks into one (defensive: prevents split rendering)
      const prev = groupedBlocks[groupedBlocks.length - 1];
      if (prev && !Array.isArray(prev) && prev.type === 'text') {
        groupedBlocks[groupedBlocks.length - 1] = {
          ...prev,
          text: (prev.text || '') + '\n\n' + (block.text || '')
        };
      } else {
        groupedBlocks.push(block);
      }
    } else if (block.type === 'thinking' || block.type === 'tool_use' || block.type === 'server_tool_use') {
      // Add to current group (server_tool_use is treated like tool_use for display)
      currentGroup.push(block);
    }
  }

  // Add any remaining group
  if (currentGroup.length > 0) {
    groupedBlocks.push(currentGroup);
  }

  // Determine which BlockGroup is the latest active section
  // Find the last BlockGroup index
  const lastBlockGroupIndex = groupedBlocks.findLastIndex((item) => Array.isArray(item));

  // Check if there are any incomplete blocks (still streaming)
  const hasIncompleteBlocks = message.content.some((block) => {
    if (block.type === 'thinking') {
      return !block.isComplete;
    }
    if (block.type === 'tool_use' || block.type === 'server_tool_use') {
      // Tool is incomplete if it doesn't have a result yet
      // server_tool_use is treated the same as tool_use for streaming state
      const subagentRunning = block.tool?.subagentCalls?.some((call) => call.isLoading);
      return Boolean(block.tool?.isLoading) || Boolean(subagentRunning) || !block.tool?.result;
    }
    return false;
  });

  const isAssistantStreaming = isLoading && hasIncompleteBlocks;

  // Find the LAST BlockGroup containing ExitPlanMode for slot placement.
  // Only the last one gets the slot — avoids duplicates when reject → re-plan
  // produces multiple ExitPlanMode tool calls in the same message.
  const exitPlanModeGroupIndex = exitPlanModeSlot
    ? groupedBlocks.findLastIndex(item =>
        Array.isArray(item) && item.some(
          block => (block.type === 'tool_use' || block.type === 'server_tool_use')
            && block.tool?.name === 'ExitPlanMode'
        )
      )
    : -1;

  return (
    <div className="flex justify-start select-none" data-role="assistant">
      <div className="w-full">
        <article className="w-full px-3 py-2">
          <div className="space-y-3">
            {groupedBlocks.map((item, index) => {
              // Single text block — may contain <widget> tags for inline rendering
              if (!Array.isArray(item)) {
                if (item.type === 'text' && item.text) {
                  // Check for <widget> tags in the text
                  if (hasWidgetTags(item.text)) {
                    const segments = parseWidgetTags(item.text);
                    return (
                      <div key={index} className="w-full space-y-3">
                        {segments.map((seg, si) => {
                          if (seg.type === 'text') {
                            return (
                              <div key={`t-${si}`} className="flex justify-start w-full px-1 py-1 select-none">
                                <div className="w-full max-w-none text-[var(--ink)] select-text">
                                  <Markdown>{seg.content}</Markdown>
                                </div>
                              </div>
                            );
                          }
                          // Widget segment — render seamlessly inline (no frame, no title header)
                          return (
                            <div key={`w-${si}`} className="w-full px-1">
                              <WidgetRenderer
                                widgetCode={seg.code}
                                isStreaming={!seg.isComplete}
                                title={seg.title || 'widget'}
                              />
                            </div>
                          );
                        })}
                      </div>
                    );
                  }
                  // Plain text — no widget tags
                  return (
                    <div
                      key={index}
                      className="flex justify-start w-full px-1 py-1 select-none"
                    >
                      <div className="w-full max-w-none text-[var(--ink)] select-text">
                        <Markdown>{item.text}</Markdown>
                      </div>
                    </div>
                  );
                }
                return null;
              }

              // Group of thinking/tool blocks
              const isLatestActiveSection = index === lastBlockGroupIndex;
              return (
                <Fragment key={`group-${index}`}>
                  <BlockGroup
                    blocks={item}
                    isLatestActiveSection={isLatestActiveSection}
                    isStreaming={isAssistantStreaming}
                  />
                  {index === exitPlanModeGroupIndex && exitPlanModeSlot}
                </Fragment>
              );
            })}
          </div>
        </article>
        {actionsReady && !isLoading && <AssistantActions className="px-4" message={message} onRetry={onRetry} onFork={onFork} />}
      </div>
    </div>
  );
}, areMessagesEqual);

export default Message;
