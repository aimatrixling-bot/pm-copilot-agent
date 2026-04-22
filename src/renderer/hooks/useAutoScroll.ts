import { useCallback, useEffect, useRef } from 'react';
import type { RefObject } from 'react';

// Smooth scroll configuration
const SCROLL_SPEED_PX_PER_MS = 2.5;      // Base scroll speed (pixels per millisecond)
const MAX_SCROLL_SPEED_PX_PER_MS = 8;    // Maximum scroll speed when far behind
const SPEED_RAMP_DISTANCE = 200;          // Distance at which speed starts ramping up
const SNAP_THRESHOLD_PX = 3;              // Snap to bottom when this close

// Content-aware scroll constants
const MSG_TOP_GAP = 80;          // px between user message top and viewport top
const CONTENT_BOTTOM_GAP = 80;   // px between content end and viewport bottom during follow

// Idle spacer height — MUST match MessageList's idle spacer minHeight
export const IDLE_SPACER_HEIGHT = 80;

// Spacer collapse animation duration (ms)
const COLLAPSE_DURATION_MS = 400;
// Collapse guard duration — MUST be > COLLAPSE_DURATION_MS to prevent animation restart
const COLLAPSE_GUARD_MS = 600;

// ── Temporary debug logging (set true to diagnose scroll issues) ──
const SCROLL_DEBUG = false;
function dbg(...args: unknown[]) {
  if (SCROLL_DEBUG) console.warn('[autoScroll]', ...args);
}

export interface AutoScrollControls {
  containerRef: RefObject<HTMLDivElement | null>;
  /** Ref for the bottom spacer element — attach to the spacer in MessageList */
  spacerRef: RefObject<HTMLDivElement | null>;
  pauseAutoScroll: (duration?: number) => void;
  scrollToBottom: () => void;
  scrollToBottomInstant: () => void;
}

export function useAutoScroll(
  isLoading: boolean,
  messagesLength: number,
  sessionId?: string | null
): AutoScrollControls {
  const containerRef = useRef<HTMLDivElement>(null);
  const spacerRef = useRef<HTMLDivElement>(null);
  const isAutoScrollEnabledRef = useRef(true);
  const isPausedRef = useRef(false);
  const pauseTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastScrollHeightRef = useRef<number>(0);

  // Smooth scroll animation state
  const animationFrameRef = useRef<number | null>(null);
  const lastFrameTimeRef = useRef<number>(0);
  const isAnimatingRef = useRef(false);

  // Collapse animation state (separate from content-following animation)
  const collapseAnimFrameRef = useRef<number | null>(null);

  // Keep isLoading in a ref so animation loop can access it
  const isLoadingRef = useRef(isLoading);
  useEffect(() => {
    isLoadingRef.current = isLoading;
  }, [isLoading]);

  // Track scroll position to detect user scroll direction
  const lastScrollTopRef = useRef(0);

  // Track session ID to detect session switch
  const lastSessionIdRef = useRef<string | null | undefined>(undefined);

  // pendingScroll — set on session switch, forces instant-scroll for ALL subsequent
  // messagesLength changes until explicitly cleared. NO timer/debounce — the previous
  // 300ms debounce expired between message batches (3→46→249), causing the final
  // batch to fall through to smooth scroll (146k px animation = 10+ seconds).
  //
  // Cleared ONLY by:
  //  1. scrollToBottom()        — user sends a message
  //  2. isLoading false→true    — AI starts streaming
  //  3. user scroll-up          — user is interacting, respect their position
  const pendingScrollRef = useRef(false);

  // Store animation function in ref for recursive RAF calls
  const animateSmoothScrollRef = useRef<(() => void) | null>(null);

  // Content-aware scroll state
  const isContentAwareRef = useRef(false);
  const lastUserMsgTopRef = useRef(0);

  // Collapse guard
  const isCollapsingRef = useRef(false);
  const collapseTimerRef = useRef<NodeJS.Timeout | null>(null);
  const prevIsLoadingRef = useRef(false);

  const clearCollapseGuard = useCallback(() => {
    isCollapsingRef.current = false;
    if (collapseTimerRef.current) {
      clearTimeout(collapseTimerRef.current);
      collapseTimerRef.current = null;
    }
  }, []);

  const cancelAnimation = useCallback(() => {
    if (animationFrameRef.current !== null && typeof window !== 'undefined') {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    isAnimatingRef.current = false;
  }, []);

  const cancelCollapseAnimation = useCallback(() => {
    if (collapseAnimFrameRef.current !== null && typeof window !== 'undefined') {
      window.cancelAnimationFrame(collapseAnimFrameRef.current);
      collapseAnimFrameRef.current = null;
    }
  }, []);

  // isLoading true→false: collapse spacer. false→true: clear pendingScroll so streaming uses smooth scroll.
  useEffect(() => {
    const wasLoading = prevIsLoadingRef.current;
    prevIsLoadingRef.current = isLoading;

    if (!isLoading && wasLoading) {
      // ── Loading ended: collapse spacer ──
      isContentAwareRef.current = false;
      cancelAnimation();
      cancelCollapseAnimation();

      const container = containerRef.current;
      const spacer = spacerRef.current;

      if (container && spacer) {
        const currentHeight = parseFloat(spacer.style.minHeight) || IDLE_SPACER_HEIGHT;

        if (currentHeight <= IDLE_SPACER_HEIGHT) {
          spacer.style.minHeight = `${IDLE_SPACER_HEIGHT}px`;
        } else {
          const shouldPinToBottom = isAutoScrollEnabledRef.current;
          const fromHeight = currentHeight;
          const startTime = performance.now();

          const tick = () => {
            const elapsed = performance.now() - startTime;
            const progress = Math.min(elapsed / COLLAPSE_DURATION_MS, 1);
            const eased = 1 - (1 - progress) * (1 - progress);
            const newHeight = progress < 1
              ? Math.round(fromHeight + (IDLE_SPACER_HEIGHT - fromHeight) * eased)
              : IDLE_SPACER_HEIGHT;

            spacer.style.minHeight = `${newHeight}px`;

            if (shouldPinToBottom) {
              container.scrollTop = container.scrollHeight - container.clientHeight;
            }

            if (progress < 1) {
              collapseAnimFrameRef.current = requestAnimationFrame(tick);
            } else {
              collapseAnimFrameRef.current = null;
            }
          };

          collapseAnimFrameRef.current = requestAnimationFrame(tick);
        }
      }

      isCollapsingRef.current = true;
      if (collapseTimerRef.current) clearTimeout(collapseTimerRef.current);
      collapseTimerRef.current = setTimeout(() => {
        isCollapsingRef.current = false;
        collapseTimerRef.current = null;
      }, COLLAPSE_GUARD_MS);
    } else if (isLoading && !wasLoading) {
      // ── Loading started: session is live, clear pendingScroll so streaming
      //    can use smooth scroll. Also clean up any leftover collapse state. ──
      dbg('isLoading false→true: clearing pendingScroll, streaming can use smooth scroll');
      pendingScrollRef.current = false;
      clearCollapseGuard();
      cancelCollapseAnimation();
      const spacer = spacerRef.current;
      if (spacer) {
        const h = parseFloat(spacer.style.minHeight) || IDLE_SPACER_HEIGHT;
        if (h !== IDLE_SPACER_HEIGHT) spacer.style.minHeight = `${IDLE_SPACER_HEIGHT}px`;
      }
    }
  }, [isLoading, cancelAnimation, cancelCollapseAnimation, clearCollapseGuard]);

  /** Update cached position of the last user message in DOM */
  const updateLastUserMsgTop = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const msgs = el.querySelectorAll('[data-role="user"]');
    const last = msgs[msgs.length - 1] as HTMLElement | null;
    if (last) {
      lastUserMsgTopRef.current = last.offsetTop;
    }
  }, []);

  const pauseAutoScroll = useCallback((duration = 250) => {
    isPausedRef.current = true;
    cancelAnimation();
    if (pauseTimerRef.current) clearTimeout(pauseTimerRef.current);
    pauseTimerRef.current = setTimeout(() => {
      isPausedRef.current = false;
      pauseTimerRef.current = null;
    }, duration);
  }, [cancelAnimation]);

  /**
   * Smooth scroll animation using RAF.
   */
  const animateSmoothScroll = useCallback(() => {
    if (!isAutoScrollEnabledRef.current || isPausedRef.current) {
      isAnimatingRef.current = false;
      return;
    }

    // Kill animation loop during session load.
    if (pendingScrollRef.current) {
      isAnimatingRef.current = false;
      return;
    }

    const element = containerRef.current;
    if (!element) {
      isAnimatingRef.current = false;
      return;
    }

    let targetScrollTop: number;

    if (isContentAwareRef.current) {
      const spacer = spacerRef.current;
      const contentEnd = spacer ? spacer.offsetTop : element.scrollHeight;
      const userMsgTarget = lastUserMsgTopRef.current > 0
        ? lastUserMsgTopRef.current - MSG_TOP_GAP : 0;
      const contentFollowTarget = contentEnd - element.clientHeight + CONTENT_BOTTOM_GAP;
      const naturalTarget = Math.max(userMsgTarget, contentFollowTarget);

      // Only expand spacer when we actually need to scroll down
      if (spacer && naturalTarget > 0) {
        const requiredHeight = naturalTarget + element.clientHeight - contentEnd;
        spacer.style.minHeight = `${Math.max(IDLE_SPACER_HEIGHT, Math.ceil(requiredHeight))}px`;
      }

      const maxScrollTop = element.scrollHeight - element.clientHeight;
      targetScrollTop = Math.max(0, Math.min(naturalTarget, maxScrollTop));
    } else {
      targetScrollTop = element.scrollHeight - element.clientHeight;
    }

    const currentScrollTop = element.scrollTop;
    const distance = targetScrollTop - currentScrollTop;

    const keepAlive = () => {
      if (animateSmoothScrollRef.current) {
        animationFrameRef.current = requestAnimationFrame(animateSmoothScrollRef.current);
      }
    };

    const shouldKeepAlive = isContentAwareRef.current || isLoadingRef.current;

    if (distance < 0) {
      if (shouldKeepAlive) { keepAlive(); return; }
      isAnimatingRef.current = false;
      return;
    }

    if (distance <= SNAP_THRESHOLD_PX) {
      element.scrollTop = targetScrollTop;
      if (shouldKeepAlive) { keepAlive(); return; }
      isAnimatingRef.current = false;
      return;
    }

    const now = performance.now();
    const deltaTime = lastFrameTimeRef.current ? now - lastFrameTimeRef.current : 16;
    lastFrameTimeRef.current = now;

    let speed = SCROLL_SPEED_PX_PER_MS;
    if (distance > SPEED_RAMP_DISTANCE) {
      const speedMultiplier = Math.min(distance / SPEED_RAMP_DISTANCE, MAX_SCROLL_SPEED_PX_PER_MS / SCROLL_SPEED_PX_PER_MS);
      speed = SCROLL_SPEED_PX_PER_MS * speedMultiplier;
    }

    const scrollAmount = speed * deltaTime;
    const newScrollTop = Math.min(currentScrollTop + scrollAmount, targetScrollTop);
    element.scrollTop = newScrollTop;

    if (animateSmoothScrollRef.current) {
      animationFrameRef.current = requestAnimationFrame(animateSmoothScrollRef.current);
    }
  }, []);

  useEffect(() => {
    animateSmoothScrollRef.current = animateSmoothScroll;
  }, [animateSmoothScroll]);

  const startSmoothScroll = useCallback(() => {
    if (!isAutoScrollEnabledRef.current || isPausedRef.current) return;
    if (pendingScrollRef.current) return;
    if (isCollapsingRef.current) return;
    if (isAnimatingRef.current) return;

    isAnimatingRef.current = true;
    lastFrameTimeRef.current = performance.now();
    animationFrameRef.current = requestAnimationFrame(animateSmoothScroll);
  }, [animateSmoothScroll]);

  const scrollToBottomInstant = useCallback(() => {
    const element = containerRef.current;
    if (!element) return;

    cancelAnimation();
    cancelCollapseAnimation();
    clearCollapseGuard();

    isAutoScrollEnabledRef.current = true;
    isPausedRef.current = false;
    isContentAwareRef.current = false;

    const spacer = spacerRef.current;
    if (spacer) spacer.style.minHeight = `${IDLE_SPACER_HEIGHT}px`;

    element.scrollTop = element.scrollHeight;

    // Belt-and-suspenders: repeat scroll after next paint. Concurrent React renders
    // (e.g., fadeIn state update) can trigger a second layout pass that resets
    // scrollTop on very tall containers (100k+ px). The RAF fires after that
    // second paint, restoring the correct position.
    requestAnimationFrame(() => {
      element.scrollTop = element.scrollHeight;
    });

    dbg('scrollToBottomInstant →', element.scrollTop, '/', element.scrollHeight);
  }, [cancelAnimation, cancelCollapseAnimation, clearCollapseGuard]);

  /**
   * Smooth scroll to position user message near viewport top.
   */
  const scrollToBottom = useCallback(() => {
    const element = containerRef.current;
    if (!element) return;

    isAutoScrollEnabledRef.current = true;
    isPausedRef.current = false;
    pendingScrollRef.current = false;

    clearCollapseGuard();
    cancelAnimation();
    cancelCollapseAnimation();

    isContentAwareRef.current = true;
  }, [cancelAnimation, cancelCollapseAnimation, clearCollapseGuard]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cancelAnimation();
      cancelCollapseAnimation();
      if (pauseTimerRef.current) clearTimeout(pauseTimerRef.current);
      if (collapseTimerRef.current) clearTimeout(collapseTimerRef.current);
    };
  }, [cancelAnimation, cancelCollapseAnimation]);

  // Session switch / initial load
  useEffect(() => {
    const previousSessionId = lastSessionIdRef.current;
    const isSessionSwitch = previousSessionId !== undefined && sessionId !== previousSessionId;
    const isInitialLoad = previousSessionId === undefined && sessionId !== undefined;

    lastSessionIdRef.current = sessionId;

    if (isSessionSwitch || isInitialLoad) {
      dbg('SESSION:', isSessionSwitch ? 'switch' : 'init',
        previousSessionId?.slice(-8) ?? '∅', '→', sessionId?.slice(-8) ?? '∅');
      pendingScrollRef.current = true;
      cancelAnimation();
      isAutoScrollEnabledRef.current = true;

      // Snap to bottom of whatever is currently in DOM
      const el = containerRef.current;
      if (el && el.scrollHeight > el.clientHeight) {
        el.scrollTop = el.scrollHeight;
      }
    }
  }, [sessionId, cancelAnimation]);

  // Messages changed
  useEffect(() => {
    if (messagesLength === 0) return;

    // pendingScroll: instant-scroll for ALL batches until cleared externally.
    // No timer — the old 300ms debounce expired between message batches, letting
    // the final batch (249 msgs, 146k px) fall through to smooth scroll.
    if (pendingScrollRef.current && !isContentAwareRef.current) {
      dbg('MESSAGES:', messagesLength, '→ scrollToBottomInstant (pending)');
      scrollToBottomInstant();
      return;
    }

    if (isContentAwareRef.current && isAutoScrollEnabledRef.current) {
      updateLastUserMsgTop();

      const el = containerRef.current;
      const spacer = spacerRef.current;
      if (el && spacer) {
        const userMsgTarget = lastUserMsgTopRef.current > 0
          ? lastUserMsgTopRef.current - MSG_TOP_GAP : 0;
        const contentEnd = spacer.offsetTop;
        const contentFollowTarget = contentEnd - el.clientHeight + CONTENT_BOTTOM_GAP;
        const naturalTarget = Math.max(userMsgTarget, contentFollowTarget);
        // Only expand spacer when we actually need to scroll (naturalTarget > 0).
        // On empty→first-message transition, content fits in viewport and expanding
        // the spacer would cause an unnecessary layout shift / visual bounce.
        if (naturalTarget > 0) {
          const requiredHeight = naturalTarget + el.clientHeight - contentEnd;
          spacer.style.minHeight = `${Math.max(IDLE_SPACER_HEIGHT, Math.ceil(requiredHeight))}px`;
        }
      }

      cancelAnimation();
      startSmoothScroll();
      return;
    }

    if (isAutoScrollEnabledRef.current) {
      startSmoothScroll();
    }
  }, [messagesLength, startSmoothScroll, scrollToBottomInstant, updateLastUserMsgTop, cancelAnimation]);

  // Start smooth scroll when loading starts
  useEffect(() => {
    if (isLoading && isAutoScrollEnabledRef.current) {
      startSmoothScroll();
    }
  }, [isLoading, startSmoothScroll]);

  // User scroll detection
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    lastScrollTopRef.current = element.scrollTop;

    const handleScroll = () => {
      const currentScrollTop = element.scrollTop;
      const scrollDelta = currentScrollTop - lastScrollTopRef.current;
      lastScrollTopRef.current = currentScrollTop;

      if (scrollDelta < -5) {
        const maxST = element.scrollHeight - element.clientHeight;
        const wasClamped = Math.abs(currentScrollTop - maxST) < 2;
        if (isAutoScrollEnabledRef.current && !wasClamped) {
          isAutoScrollEnabledRef.current = false;
          pendingScrollRef.current = false; // User is interacting — respect their position
          cancelAnimation();
        }
      }
    };

    element.addEventListener('scroll', handleScroll, { passive: true });
    return () => element.removeEventListener('scroll', handleScroll);
  }, [cancelAnimation]);

  // ResizeObserver
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const element = containerRef.current;
    if (!element) return;

    lastScrollHeightRef.current = element.scrollHeight;

    const resizeObserver = new ResizeObserver(() => {
      if (!isAutoScrollEnabledRef.current || isPausedRef.current) return;

      const currentHeight = element.scrollHeight;
      const heightDelta = currentHeight - lastScrollHeightRef.current;

      if (heightDelta > 0) {
        if (pendingScrollRef.current) {
          element.scrollTop = element.scrollHeight;
        } else {
          startSmoothScroll();
        }
      }

      lastScrollHeightRef.current = currentHeight;
    });

    resizeObserver.observe(element);
    return () => resizeObserver.disconnect();
  }, [startSmoothScroll]);

  return { containerRef, spacerRef, pauseAutoScroll, scrollToBottom, scrollToBottomInstant };
}
