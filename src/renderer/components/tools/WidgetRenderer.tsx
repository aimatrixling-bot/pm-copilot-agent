/**
 * WidgetRenderer — Sandboxed iframe container for Generative UI widgets.
 *
 * Handles:
 * - iframe lifecycle (srcdoc, ready detection, onLoad fallback)
 * - postMessage communication (update/finalize/resize/link)
 * - Streaming preview with script stripping + debounce
 * - Height synchronization with first-resize-no-transition optimization
 * - Module-level height cache to survive component remounts (CodePilot Bug #4)
 */

import { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import { openExternal } from '@/utils/openExternal';
import { buildWidgetCssVars } from './widgetCssVars';
import { buildSandboxHtml } from './widgetSandboxHtml';

// ===== Module-level height cache (survives component lifecycle) =====
// Key: first 300 chars of widget_code (past the common <style> prefix).
// Prevents height jump on streaming→final remount. Capped at 100 entries.
const HEIGHT_CACHE_MAX = 100;
const heightCache = new Map<string, number>();

function getCacheKey(widgetCode: string): string {
  return widgetCode.slice(0, 300);
}

function setCacheHeight(key: string, height: number): void {
  if (heightCache.size >= HEIGHT_CACHE_MAX && !heightCache.has(key)) {
    // Evict oldest entry (first inserted)
    const firstKey = heightCache.keys().next().value;
    if (firstKey !== undefined) heightCache.delete(firstKey);
  }
  heightCache.set(key, height);
}

// ===== Script sanitization for streaming preview =====

function sanitizeForStreaming(html: string): string {
  // Remove complete <script>...</script> blocks
  let cleaned = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  // Remove unclosed <script... tail (prevents half-script showing as visible text)
  const lastScriptOpen = cleaned.toLowerCase().lastIndexOf('<script');
  if (lastScriptOpen !== -1) {
    const hasClose = cleaned.toLowerCase().indexOf('</script>', lastScriptOpen);
    if (hasClose === -1) {
      cleaned = cleaned.substring(0, lastScriptOpen);
    }
  }
  // Remove all on* event handler attributes (quoted, single-quoted, unquoted, backtick)
  cleaned = cleaned.replace(/\s+on\w+\s*=\s*"[^"]*"/gi, '');
  cleaned = cleaned.replace(/\s+on\w+\s*=\s*'[^']*'/gi, '');
  cleaned = cleaned.replace(/\s+on\w+\s*=\s*`[^`]*`/gi, '');
  cleaned = cleaned.replace(/\s+on\w+\s*=\s*[^\s>"'`][^\s>]*/gi, '');
  // Remove javascript: URLs in href/src/action attributes
  cleaned = cleaned.replace(/\s+(href|src|action)\s*=\s*["']?\s*javascript\s*:[^"'>]*/gi, '');
  return cleaned;
}

// ===== Component =====

interface WidgetRendererProps {
  widgetCode: string;
  isStreaming: boolean;
  title: string;
}

const DEBOUNCE_MS = 120;
const MIN_HEIGHT = 60;

export default function WidgetRenderer({ widgetCode, isStreaming, title }: WidgetRendererProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const iframeReady = useRef(false);
  const lastSentHtml = useRef('');
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasFinalized = useRef(false);

  // Initialize height from cache or default
  const cacheKey = getCacheKey(widgetCode);
  const [height, setHeight] = useState(() => heightCache.get(cacheKey) ?? MIN_HEIGHT);
  const [firstResize, setFirstResize] = useState(true);

  // Build srcdoc once (CSS vars captured at mount time)
  const srcdoc = useMemo(() => {
    const cssVars = buildWidgetCssVars();
    return buildSandboxHtml(cssVars);
  }, []);

  // Send message to iframe
  const sendToIframe = useCallback((msg: Record<string, unknown>) => {
    iframeRef.current?.contentWindow?.postMessage(msg, '*');
  }, []);

  // Handle messages from iframe
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      // Only process messages from our own iframe (prevents cross-widget interference)
      if (e.source !== iframeRef.current?.contentWindow) return;
      if (!e.data?.type) return;

      switch (e.data.type) {
        case 'widget:ready':
          iframeReady.current = true;
          // If we already have content, send it immediately
          if (widgetCode && !hasFinalized.current) {
            const html = isStreaming ? sanitizeForStreaming(widgetCode) : widgetCode;
            sendToIframe({ type: isStreaming ? 'widget:update' : 'widget:finalize', html });
            lastSentHtml.current = html;
          }
          break;

        case 'widget:resize': {
          const h = Math.max(MIN_HEIGHT, Math.min(4000, Number(e.data.height) || MIN_HEIGHT));
          setHeight(h);
          setCacheHeight(cacheKey, h);
          if (e.data.first) setFirstResize(false);
          break;
        }

        case 'widget:link':
          if (e.data.href && /^https?:|^mailto:/i.test(String(e.data.href))) {
            openExternal(String(e.data.href));
          }
          break;
      }
    }

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [widgetCode, isStreaming, sendToIframe, cacheKey]);

  // Theme change observer — push updated CSS vars to iframe when dark/light mode toggles
  useEffect(() => {
    const observer = new MutationObserver(() => {
      if (iframeReady.current) {
        sendToIframe({ type: 'widget:theme', css: buildWidgetCssVars() });
      }
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    return () => observer.disconnect();
  }, [sendToIframe]);

  // iframe onLoad fallback for ready race condition (CodePilot Bug #6)
  const onIframeLoad = useCallback(() => {
    if (!iframeReady.current) {
      iframeReady.current = true;
      if (widgetCode) {
        const html = isStreaming ? sanitizeForStreaming(widgetCode) : widgetCode;
        sendToIframe({ type: isStreaming ? 'widget:update' : 'widget:finalize', html });
        lastSentHtml.current = html;
      }
    }
  }, [widgetCode, isStreaming, sendToIframe]);

  // Streaming update: debounced, script-stripped
  useEffect(() => {
    if (!isStreaming || !iframeReady.current || hasFinalized.current) return;

    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      const html = sanitizeForStreaming(widgetCode);
      if (html !== lastSentHtml.current) {
        sendToIframe({ type: 'widget:update', html });
        lastSentHtml.current = html;
      }
    }, DEBOUNCE_MS);

    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [widgetCode, isStreaming, sendToIframe]);

  // Finalize: when streaming ends, send full HTML with scripts
  useEffect(() => {
    if (!isStreaming && widgetCode && iframeReady.current && !hasFinalized.current) {
      hasFinalized.current = true;
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      sendToIframe({ type: 'widget:finalize', html: widgetCode });
      lastSentHtml.current = widgetCode;
    }
  }, [isStreaming, widgetCode, sendToIframe]);

  // Show skeleton until iframe reports real content height (> MIN_HEIGHT)
  const hasVisibleContent = height > MIN_HEIGHT;
  const showSkeleton = isStreaming && !hasVisibleContent;

  return (
    <div
      className="relative w-full overflow-hidden"
      style={{
        height: showSkeleton ? undefined : `${height}px`,
        minHeight: showSkeleton ? '48px' : undefined,
        transition: firstResize ? 'none' : 'height 0.15s ease',
      }}
    >
      {/* iframe always mounted (pre-loaded), hidden during skeleton */}
      <iframe
        ref={iframeRef}
        sandbox="allow-scripts"
        srcDoc={srcdoc}
        onLoad={onIframeLoad}
        title={title}
        className="h-full w-full border-none"
        style={{ display: showSkeleton ? 'none' : 'block' }}
      />
      {/* Skeleton: shown until iframe renders visible content */}
      {showSkeleton && (
        <div className="space-y-2.5 py-1">
          <div className="h-3 w-3/4 animate-[shimmer-slide_2s_ease-in-out_infinite] rounded bg-gradient-to-r from-[var(--paper-inset)] via-[var(--paper)] to-[var(--paper-inset)] bg-[length:200%_100%]" />
          <div className="h-3 w-1/2 animate-[shimmer-slide_2s_ease-in-out_infinite_0.2s] rounded bg-gradient-to-r from-[var(--paper-inset)] via-[var(--paper)] to-[var(--paper-inset)] bg-[length:200%_100%]" />
        </div>
      )}
    </div>
  );
}
