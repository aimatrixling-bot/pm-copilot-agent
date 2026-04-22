import { Loader2 } from 'lucide-react';
import React, { memo, useMemo, useState, useEffect, useRef } from 'react';
import { Virtuoso } from 'react-virtuoso';
import type { VirtuosoHandle } from 'react-virtuoso';

import Message from '@/components/Message';
import { PermissionPrompt, type PermissionRequest } from '@/components/PermissionPrompt';
import { AskUserQuestionPrompt, type AskUserQuestionRequest } from '@/components/AskUserQuestionPrompt';
import { ExitPlanModePrompt } from '@/components/ExitPlanModePrompt';
import type { ExitPlanModeRequest } from '../../shared/types/planMode';
import type { Message as MessageType } from '@/types/chat';

function formatElapsedTime(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}小时${minutes}分钟${seconds}秒`;
  if (minutes > 0) return `${minutes}分钟${seconds}秒`;
  return `${seconds}秒`;
}

interface MessageListProps {
  historyMessages: MessageType[];
  streamingMessage: MessageType | null;
  isLoading: boolean;
  isSessionLoading?: boolean;
  sessionId?: string | null;
  virtuosoRef: React.RefObject<VirtuosoHandle | null>;
  onScrollerRef?: (el: HTMLElement | Window | null) => void;
  followEnabledRef: React.MutableRefObject<boolean | 'force'>;
  handleAtBottomChange: (atBottom: boolean) => void;
  pendingPermission?: PermissionRequest | null;
  onPermissionDecision?: (decision: 'deny' | 'allow_once' | 'always_allow') => void;
  pendingAskUserQuestion?: AskUserQuestionRequest | null;
  onAskUserQuestionSubmit?: (requestId: string, answers: Record<string, string>) => void;
  onAskUserQuestionCancel?: (requestId: string) => void;
  pendingExitPlanMode?: ExitPlanModeRequest | null;
  onExitPlanModeApprove?: () => void;
  onExitPlanModeReject?: () => void;
  systemStatus?: string | null;
  isStreaming?: boolean;
  onRewind?: (messageId: string) => void;
  onRetry?: (assistantMessageId: string) => void;
  onFork?: (assistantMessageId: string) => void;
}

const STREAMING_MESSAGES = [
  '苦思冥想中…', '深思熟虑中…', '灵光一闪中…', '绞尽脑汁中…', '思绪飞速运转中…',
  '小脑袋瓜转啊转…', '神经元疯狂放电中…', '灵感小火花碰撞中…', '正在努力组织语言…',
  '在知识海洋里捞答案…', '正在翻阅宇宙图书馆…', '答案正在酝酿中…', '灵感咖啡冲泡中…',
  '递归思考中，请勿打扰…', '正在遍历可能性…', '加载智慧模块中…',
  '容我想想…', '稍等，马上就好…', '别急，好饭不怕晚…', '正在认真对待你的问题…',
];
const SYSTEM_STATUS_MESSAGES: Record<string, string> = {
  compacting: '会话内容过长，智能总结中…',
  rewinding: '正在时间回溯中，请稍等…',
};

/** Resolve dynamic system status keys (e.g., api_retry:2:5 → human-readable) */
function resolveSystemStatus(status: string): string {
  if (SYSTEM_STATUS_MESSAGES[status]) return SYSTEM_STATUS_MESSAGES[status];
  // API retry: "api_retry:{attempt}:{maxAttempts}"
  if (status.startsWith('api_retry:')) {
    const parts = status.split(':');
    const attempt = parts[1] || '1';
    const max = parts[2] || '?';
    return `API 请求重试中（第 ${attempt}/${max} 次）…`;
  }
  return status;
}
function getRandomStreamingMessage(): string {
  return STREAMING_MESSAGES[Math.floor(Math.random() * STREAMING_MESSAGES.length)];
}

const StatusTimer = memo(function StatusTimer({ message }: { message: string }) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const startTimeRef = useRef(0);
  useEffect(() => {
    startTimeRef.current = Date.now();
    const id = setInterval(() => setElapsedSeconds(Math.floor((Date.now() - startTimeRef.current) / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--ink-muted)]">
      <Loader2 className="h-3 w-3 animate-spin" />
      <span>{message}{elapsedSeconds > 0 && ` (${formatElapsedTime(elapsedSeconds)})`}</span>
    </div>
  );
});

function hasExitPlanModeTool(message: MessageType): boolean {
  if (message.role !== 'assistant' || typeof message.content === 'string') return false;
  return message.content.some(
    block => (block.type === 'tool_use' || block.type === 'server_tool_use') && block.tool?.name === 'ExitPlanMode'
  );
}

// ── Virtuoso Footer — memo'd component that reads dynamic values from refs ──
// Must NOT be recreated on every render (inline arrow in `components` causes Virtuoso
// to remount the footer, resetting StatusTimer and forcing extra remeasurement).
const VirtuosoFooter = memo(function VirtuosoFooter({
  pendingPermission, onPermissionDecision,
  pendingAskUserQuestion, onAskUserQuestionSubmit, onAskUserQuestionCancel,
  showStatus, statusMessage,
}: {
  pendingPermission?: PermissionRequest | null;
  onPermissionDecision?: (decision: 'deny' | 'allow_once' | 'always_allow') => void;
  pendingAskUserQuestion?: AskUserQuestionRequest | null;
  onAskUserQuestionSubmit?: (requestId: string, answers: Record<string, string>) => void;
  onAskUserQuestionCancel?: (requestId: string) => void;
  showStatus: boolean;
  statusMessage: string;
}) {
  return (
    <div className="mx-auto max-w-3xl px-3">
      {pendingPermission && onPermissionDecision && (
        <div className="py-2">
          <PermissionPrompt request={pendingPermission} onDecision={(_id, d) => onPermissionDecision(d)} />
        </div>
      )}
      {pendingAskUserQuestion && onAskUserQuestionSubmit && onAskUserQuestionCancel && (
        <div className="py-2">
          <AskUserQuestionPrompt request={pendingAskUserQuestion} onSubmit={onAskUserQuestionSubmit} onCancel={onAskUserQuestionCancel} />
        </div>
      )}
      {showStatus && <StatusTimer message={statusMessage} />}
      <div style={{ height: 280 }} aria-hidden="true" />
    </div>
  );
});

// ── No custom Scroller/List components ──
// Tested: custom Scroller (py-3 padding) and List (mx-auto max-w-3xl) break Virtuoso's
// internal height tracking — scrollHeight diverges from totalListHeight by 12,000+ px,
// causing phantom repeated content. Styling is applied inside itemContent instead.

const MessageList = memo(function MessageList({
  historyMessages,
  streamingMessage,
  isLoading,
  isSessionLoading,
  sessionId,
  virtuosoRef,
  onScrollerRef,
  followEnabledRef,
  handleAtBottomChange,
  pendingPermission,
  onPermissionDecision,
  pendingAskUserQuestion,
  onAskUserQuestionSubmit,
  onAskUserQuestionCancel,
  pendingExitPlanMode,
  onExitPlanModeApprove,
  onExitPlanModeReject,
  systemStatus,
  isStreaming,
  onRewind,
  onRetry,
  onFork,
}: MessageListProps) {
  const allMessages = useMemo(() =>
    streamingMessage ? [...historyMessages, streamingMessage] : historyMessages,
    [historyMessages, streamingMessage]
  );

  const streamingStatusMessage = useMemo(
    () => getRandomStreamingMessage(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [historyMessages.length]
  );

  // ExitPlanMode
  const exitPlanModeAnchorId = useMemo(() => {
    if (!pendingExitPlanMode) return null;
    if (streamingMessage && hasExitPlanModeTool(streamingMessage)) return streamingMessage.id;
    for (let i = historyMessages.length - 1; i >= 0; i--) {
      if (hasExitPlanModeTool(historyMessages[i])) return historyMessages[i].id;
    }
    return null;
  }, [pendingExitPlanMode, streamingMessage, historyMessages]);
  const exitPlanModeSlot = useMemo(() => {
    if (!pendingExitPlanMode || !onExitPlanModeApprove || !onExitPlanModeReject) return undefined;
    return (
      <div className="py-2">
        <ExitPlanModePrompt request={pendingExitPlanMode} onApprove={onExitPlanModeApprove} onReject={onExitPlanModeReject} />
      </div>
    );
  }, [pendingExitPlanMode, onExitPlanModeApprove, onExitPlanModeReject]);

  const showStatus = isLoading || !!systemStatus;
  const statusMessage = systemStatus ? resolveSystemStatus(systemStatus) : streamingStatusMessage;

  // Fade-in
  const wasSessionLoadingRef = useRef(false);
  const [fadeIn, setFadeIn] = useState(false);
  useEffect(() => {
    if (isSessionLoading) { wasSessionLoadingRef.current = true; setFadeIn(false); }
    else if (wasSessionLoadingRef.current) { wasSessionLoadingRef.current = false; setFadeIn(true); }
  }, [isSessionLoading]);

  // Scroll to bottom after session load
  const lastScrolledSessionRef = useRef<string | null>(null);
  useEffect(() => {
    if (allMessages.length > 0 && sessionId && sessionId !== lastScrolledSessionRef.current) {
      lastScrolledSessionRef.current = sessionId;
      followEnabledRef.current = 'force';
      const timer = setTimeout(() => {
        const ref = virtuosoRef.current;
        if (!ref) return;
        ref.scrollToIndex({ index: 'LAST', align: 'end' });
        // Virtuoso may not render items at the new scroll position after programmatic
        // scrollToIndex — it relies on scroll events to trigger visible-range recalculation.
        // A second call in the next frame forces it to detect the position and render items.
        requestAnimationFrame(() => {
          ref.scrollToIndex({ index: 'LAST', align: 'end' });
        });
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [allMessages.length, sessionId, virtuosoRef, followEnabledRef]);

  // ── Auto-scroll during streaming — throttled to ~20fps (48ms) ──
  // followOutput only fires on count change. During streaming the last message keeps
  // growing taller. autoscrollToBottom() handles this (scrolls only if already at bottom).
  //
  // Without throttling, autoscrollToBottom() fires on every SSE chunk (~60fps via RAF).
  // Combined with Virtuoso's internal ResizeObserver + scroll correction loop, this causes
  // visible position jitter in footer elements. Throttling to 20fps reduces the correction
  // frequency while keeping scroll tracking visually smooth.
  const scrollRafRef = useRef(0);
  const lastScrollTimeRef = useRef(0);
  const trailingScrollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!streamingMessage || !followEnabledRef.current) return;

    const THROTTLE_MS = 48; // ~20fps
    const now = performance.now();
    const elapsed = now - lastScrollTimeRef.current;

    // Cancel any pending leading-edge RAF
    cancelAnimationFrame(scrollRafRef.current);

    if (elapsed >= THROTTLE_MS) {
      // Leading edge: enough time passed, scroll now
      lastScrollTimeRef.current = now;
      if (trailingScrollRef.current) { clearTimeout(trailingScrollRef.current); trailingScrollRef.current = null; }
      scrollRafRef.current = requestAnimationFrame(() => {
        virtuosoRef.current?.autoscrollToBottom();
      });
    } else if (!trailingScrollRef.current) {
      // Trailing edge: schedule scroll after remaining throttle window
      trailingScrollRef.current = setTimeout(() => {
        trailingScrollRef.current = null;
        lastScrollTimeRef.current = performance.now();
        scrollRafRef.current = requestAnimationFrame(() => {
          virtuosoRef.current?.autoscrollToBottom();
        });
      }, THROTTLE_MS - elapsed);
    }

    return () => {
      cancelAnimationFrame(scrollRafRef.current);
      if (trailingScrollRef.current) { clearTimeout(trailingScrollRef.current); trailingScrollRef.current = null; }
    };
  }, [streamingMessage, followEnabledRef, virtuosoRef]);

  // ── Refs for stable callbacks — avoid recreating itemContent/Footer on every render ──
  const streamingMessageRef = useRef(streamingMessage);
  streamingMessageRef.current = streamingMessage;
  const isLoadingRef = useRef(isLoading);
  isLoadingRef.current = isLoading;
  const exitPlanModeAnchorIdRef = useRef(exitPlanModeAnchorId);
  exitPlanModeAnchorIdRef.current = exitPlanModeAnchorId;
  const exitPlanModeSlotRef = useRef(exitPlanModeSlot);
  exitPlanModeSlotRef.current = exitPlanModeSlot;
  const onRewindRef = useRef(onRewind);
  onRewindRef.current = onRewind;
  const onRetryRef = useRef(onRetry);
  onRetryRef.current = onRetry;
  const onForkRef = useRef(onFork);
  onForkRef.current = onFork;

  const handleFollowOutput = useMemo(
    () => (isAtBottom: boolean) => {
      const mode = followEnabledRef.current;
      if (!mode) return false;
      if (mode === 'force') return 'smooth' as const;
      return isAtBottom ? 'smooth' as const : false;
    },
    [followEnabledRef]
  );

  // ── Stable itemContent — reads ALL dynamic values from refs, never recreated ──
  // eslint-disable-next-line react/display-name
  const renderItem = useMemo(() => (index: number, message: MessageType) => {
    const sm = streamingMessageRef.current;
    const isStreamingMsg = !!sm && message === sm;
    return (
      <div className="mx-auto max-w-3xl px-3 py-1 overflow-hidden">
        <Message
          message={message}
          isLoading={isStreamingMsg && isLoadingRef.current}
          onRewind={onRewindRef.current}
          onRetry={onRetryRef.current}
          onFork={onForkRef.current}
          exitPlanModeSlot={message.id === exitPlanModeAnchorIdRef.current ? exitPlanModeSlotRef.current : undefined}
        />
      </div>
    );
  }, []);

  // ── Stable computeItemKey ──
  const computeItemKey = useMemo(() => (_i: number, m: MessageType) => m.id, []);

  // ── Stable Footer wrapper — useMemo keeps component identity stable for Virtuoso ──
  const FooterComponent = useMemo(() => {
    return function Footer() {
      return (
        <VirtuosoFooter
          pendingPermission={pendingPermission}
          onPermissionDecision={onPermissionDecision}
          pendingAskUserQuestion={pendingAskUserQuestion}
          onAskUserQuestionSubmit={onAskUserQuestionSubmit}
          onAskUserQuestionCancel={onAskUserQuestionCancel}
          showStatus={showStatus}
          statusMessage={statusMessage}
        />
      );
    };
  }, [pendingPermission, onPermissionDecision, pendingAskUserQuestion, onAskUserQuestionSubmit, onAskUserQuestionCancel, showStatus, statusMessage]);

  // ── Stable components object ──
  const components = useMemo(() => ({ Footer: FooterComponent }), [FooterComponent]);

  return (
    <div
      className="relative flex-1"
      data-streaming={isStreaming || undefined}
      style={fadeIn ? { animation: 'message-list-fade-in 600ms ease-out both' } : undefined}
      onAnimationEnd={() => setFadeIn(false)}
    >
      {isSessionLoading && allMessages.length === 0 && (
        <div className="absolute inset-0 z-10 flex items-center justify-center" style={{ paddingBottom: 140 }}>
          <div className="flex items-center gap-2 text-sm text-[var(--ink-muted)]">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>加载对话记录…</span>
          </div>
        </div>
      )}

      <Virtuoso
        key={sessionId || 'pending'}
        ref={virtuosoRef}
        scrollerRef={onScrollerRef}
        data={allMessages}
        computeItemKey={computeItemKey}
        followOutput={handleFollowOutput}
        atBottomStateChange={handleAtBottomChange}
        atBottomThreshold={50}
        defaultItemHeight={200}
        className="h-full"
        style={{ overscrollBehavior: 'none' }}
        components={components}
        itemContent={renderItem}
      />
    </div>
  );
});

export default MessageList;
