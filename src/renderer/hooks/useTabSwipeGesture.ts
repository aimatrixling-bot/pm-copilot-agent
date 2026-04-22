import { useEffect, useRef, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import type { Tab } from '@/types/tab';

interface UseTabSwipeGestureOptions {
  contentRef: RefObject<HTMLDivElement | null>;
  tabsRef: RefObject<Tab[]>;
  activeTabIdRef: RefObject<string | null>;
  onSwitchTab: (tabId: string) => void;
}

interface VelocitySample {
  delta: number;  // px (positive = rightward)
  time: number;   // performance.now()
}

interface MergedPoint {
  deltaSum: number;
  time: number;
}

interface SwipeState {
  phase: 'idle' | 'tracking' | 'animating';
  direction: 'horizontal' | 'vertical' | 'inner-scroll' | null;
  offsetX: number;              // cumulative px; positive = shifted right (previous tab)
  velocitySamples: VelocitySample[];
  generation: number;           // incremented per animation — stale listeners check this
  idleTimer: ReturnType<typeof setTimeout> | null;
  dirResetTimer: ReturnType<typeof setTimeout> | null;
  snapTimer: ReturnType<typeof setTimeout> | null;
  currentEl: HTMLElement | null;
  adjacentEl: HTMLElement | null;
  adjacentIndex: number;
  activeOnEnd: ((e?: Event) => void) | null;
  activeOnEndEl: HTMLElement | null;
  cooldownUntil: number;
  // Momentum detection (acceleration factor analysis, adapted from wheel-gestures)
  mergeCount: number;
  mergeDeltaSum: number;
  mergeTimeSum: number;
  prevMergedPoint: MergedPoint | null;
  prevMergedVelocity: number;
  accFactors: number[];
  momentumFlag: boolean;
}

// --- Tuning constants ---
const DIR_LOCK_RATIO = 1.2;
const DIR_LOCK_MIN = 2;
const DIR_RESET_TIMEOUT = 150;         // ms — reset vertical direction lock

const VELOCITY_SAMPLES = 5;
const VELOCITY_SAMPLE_MAX_AGE = 100;   // ms — discard samples older than this
const COMMIT_VELOCITY = 300;           // px/s — velocity threshold for tab switch (both proactive & idle)
const POSITION_THRESHOLD = 0.25;       // 25% of container width → switch on release
const PROACTIVE_POSITION_MAX = 0.5;    // 50% → commit regardless of velocity (clearly switching)

const IDLE_SLOW = 500;                 // ms — finger barely moving or paused
const IDLE_FAST = 200;                 // ms — was recently moving fast → decide quickly after stop
const IDLE_INERTIA_TAIL = 150;         // ms — inertia ending (small deltas + momentum confirmed)
const INERTIA_TAIL_THRESHOLD = 3;      // px — delta below this = "tail" of inertia
const IDLE_BOUNDARY = 30;              // ms — snap back quickly at boundaries

// Momentum detection (adapted from wheel-gestures library)
const ACC_FACTOR_MIN = 0.6;            // min acceleration factor for momentum
const ACC_FACTOR_MAX = 0.96;           // max acceleration factor for momentum
const EVENTS_TO_MERGE = 2;             // merge every 2 events for noise smoothing
const ACC_FACTORS_NEEDED = 5;          // need 5 consecutive factors in range (~12 events total)

// WebKit (WKWebView) non-standard wheel event phases
const WEBKIT_PHASE_ENDED = 8;          // NSEventPhaseEnded — finger lifted
const WEBKIT_PHASE_CANCELLED = 16;     // NSEventPhaseCancelled

const SNAP_DURATION = 200;             // ms
const SNAP_EASING = 'cubic-bezier(0.2, 1, 0.3, 1)';
const SNAP_SAFETY_BUFFER = 50;         // ms — fallback timeout margin
const RUBBER_BAND_MAX = 80;            // px — max boundary stretch
const COMMIT_COOLDOWN = 1200;          // ms — absorb inertial events after tab switch (covers full macOS inertia)
const BOUNCE_COOLDOWN = 500;           // ms — absorb inertial events after bounce-back

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

/**
 * Check if the wheel event target is inside a horizontally scrollable element
 * that can still scroll in the given direction. If so, the inner element should
 * handle the scroll and tab swipe should NOT intercept.
 *
 * @param target  The event target element
 * @param container  The tab content container (stop walking at this boundary)
 * @param deltaX  The wheel deltaX (positive = scroll right, negative = scroll left)
 * @returns true if an inner element should handle the horizontal scroll
 */
function hasInnerHorizontalScroll(target: EventTarget | null, container: HTMLElement, deltaX: number): boolean {
  // Narrow to HTMLElement — target may be a Text node, SVGElement, etc.
  let el: HTMLElement | null =
    target instanceof HTMLElement ? target
    : (target instanceof Node ? target.parentElement : null);
  while (el && el !== container) {
    // Check if element has horizontal overflow (auto or scroll)
    if (el.scrollWidth > el.clientWidth) {
      const style = getComputedStyle(el);
      const overflowX = style.overflowX;
      if (overflowX === 'auto' || overflowX === 'scroll') {
        // deltaX > 0 means scrolling right (content moves left)
        if (deltaX > 0 && el.scrollLeft + el.clientWidth < el.scrollWidth - 1) return true;
        // deltaX < 0 means scrolling left (content moves right)
        if (deltaX < 0 && el.scrollLeft > 1) return true;
      }
    }
    el = el.parentElement;
  }
  return false;
}

export function useTabSwipeGesture({
  contentRef,
  tabsRef,
  activeTabIdRef,
  onSwitchTab,
}: UseTabSwipeGestureOptions) {
  const stateRef = useRef<SwipeState>({
    phase: 'idle',
    direction: null,
    offsetX: 0,
    velocitySamples: [],
    generation: 0,
    idleTimer: null,
    dirResetTimer: null,
    snapTimer: null,
    currentEl: null,
    adjacentEl: null,
    adjacentIndex: -1,
    activeOnEnd: null,
    activeOnEndEl: null,
    cooldownUntil: 0,
    mergeCount: 0,
    mergeDeltaSum: 0,
    mergeTimeSum: 0,
    prevMergedPoint: null,
    prevMergedVelocity: 0,
    accFactors: [],
    momentumFlag: false,
  });

  useEffect(() => {
    const container = contentRef.current;
    if (!container) return;
    const state = stateRef.current;

    // ─── Helpers ───────────────────────────────────────────────

    function getActiveIndex(): number {
      return tabsRef.current.findIndex(t => t.id === activeTabIdRef.current);
    }

    function getTabEl(index: number): HTMLElement | null {
      return (contentRef.current?.children[index] as HTMLElement) ?? null;
    }

    function clearAllTimers() {
      if (state.idleTimer !== null) { clearTimeout(state.idleTimer); state.idleTimer = null; }
      if (state.dirResetTimer !== null) { clearTimeout(state.dirResetTimer); state.dirResetTimer = null; }
      if (state.snapTimer !== null) { clearTimeout(state.snapTimer); state.snapTimer = null; }
    }

    function detachOnEnd() {
      if (state.activeOnEnd && state.activeOnEndEl) {
        state.activeOnEndEl.removeEventListener('transitionend', state.activeOnEnd as EventListener);
      }
      state.activeOnEnd = null;
      state.activeOnEndEl = null;
    }

    function resetState() {
      clearAllTimers();
      detachOnEnd();
      state.phase = 'idle';
      state.direction = null;
      state.offsetX = 0;
      state.velocitySamples = [];
      state.currentEl = null;
      state.adjacentEl = null;
      state.adjacentIndex = -1;
      state.mergeCount = 0;
      state.mergeDeltaSum = 0;
      state.mergeTimeSum = 0;
      state.prevMergedPoint = null;
      state.prevMergedVelocity = 0;
      state.accFactors = [];
      state.momentumFlag = false;
    }

    function cleanupDOM() {
      const cont = contentRef.current;
      if (!cont) return;
      for (let i = 0; i < cont.children.length; i++) {
        const el = cont.children[i] as HTMLElement;
        el.style.transform = '';
        el.style.transition = '';
      }
      if (state.adjacentEl && state.adjacentIndex !== getActiveIndex()) {
        state.adjacentEl.classList.add('invisible', 'pointer-events-none');
        state.adjacentEl.style.contentVisibility = 'hidden';
      }
    }

    function showTab(el: HTMLElement) {
      el.classList.remove('invisible', 'pointer-events-none');
      el.style.contentVisibility = '';
    }

    function hideTab(el: HTMLElement) {
      el.style.transform = '';
      el.classList.add('invisible', 'pointer-events-none');
      el.style.contentVisibility = 'hidden';
    }

    // ─── Velocity (with sample expiry) ────────────────────────

    function addSample(delta: number) {
      const now = performance.now();
      state.velocitySamples.push({ delta, time: now });
      while (state.velocitySamples.length > VELOCITY_SAMPLES) {
        state.velocitySamples.shift();
      }
    }

    function getVelocity(): number {
      const s = state.velocitySamples;
      if (s.length < 2) return 0;
      const latest = s[s.length - 1].time;
      const recent = s.filter(v => latest - v.time <= VELOCITY_SAMPLE_MAX_AGE);
      if (recent.length < 2) return 0;
      const dt = recent[recent.length - 1].time - recent[0].time;
      if (dt < 1) return 0;
      const totalDelta = recent.reduce((sum, v) => sum + v.delta, 0);
      return (totalDelta / dt) * 1000;
    }

    // ─── Rubber band at boundaries ────────────────────────────

    function rubberBand(offset: number): number {
      const sign = Math.sign(offset);
      const abs = Math.abs(offset);
      return sign * RUBBER_BAND_MAX * (1 - Math.exp(-abs / (RUBBER_BAND_MAX * 2)));
    }

    // ─── Momentum detection (acceleration factor analysis) ────
    // Adapted from the wheel-gestures library.
    // Merges every 2 events into one data point, computes velocity between
    // consecutive points, then checks if the velocity ratio (acceleration factor)
    // is consistently in [0.6, 0.96] — the fingerprint of system-generated inertia.
    // Human finger movement produces erratic ratios outside this range.

    function feedMomentumDetector(delta: number): boolean {
      state.mergeCount++;
      state.mergeDeltaSum += delta;
      state.mergeTimeSum += performance.now();

      if (state.mergeCount < EVENTS_TO_MERGE) return false;

      // Merge complete — create a data point
      const point: MergedPoint = {
        deltaSum: state.mergeDeltaSum,
        time: state.mergeTimeSum / EVENTS_TO_MERGE,
      };
      state.mergeCount = 0;
      state.mergeDeltaSum = 0;
      state.mergeTimeSum = 0;

      if (state.prevMergedPoint) {
        const dt = point.time - state.prevMergedPoint.time;
        if (dt > 0) {
          const velocity = point.deltaSum / dt;

          if (Math.abs(state.prevMergedVelocity) > 0.001) {
            const factor = velocity / state.prevMergedVelocity;
            state.accFactors.push(factor);
            if (state.accFactors.length > ACC_FACTORS_NEEDED) {
              state.accFactors.shift();
            }
          }

          state.prevMergedVelocity = velocity;
        }
      }

      state.prevMergedPoint = point;

      // Check if we have enough factors and they're all in the momentum range
      if (state.accFactors.length >= ACC_FACTORS_NEEDED) {
        const isMomentum = state.accFactors.every(f => f >= ACC_FACTOR_MIN && f <= ACC_FACTOR_MAX);
        state.momentumFlag = isMomentum;
        return isMomentum;
      }
      return false;
    }

    // ─── Snap animation ───────────────────────────────────────
    // ALL animations are non-cancellable. Once a decision is made, it's final.

    function animateSnap(commit: boolean, swipeDir: -1 | 1) {
      state.phase = 'animating';
      state.generation++;
      const gen = state.generation;

      const cont = contentRef.current;
      if (!cont) { resetState(); return; }

      const cw = cont.clientWidth;
      const curEl = state.currentEl;
      const adjEl = state.adjacentEl;
      if (!curEl) { cleanupDOM(); resetState(); return; }

      // If offset is negligible, skip animation entirely (transitionend won't fire)
      if (!commit && Math.abs(state.offsetX) < 1 && !adjEl) {
        cleanupDOM();
        resetState();
        return;
      }

      detachOnEnd();

      if (commit && adjEl) {
        const curTarget = swipeDir * cw;
        const newTabId = tabsRef.current[state.adjacentIndex]?.id;
        const oldEl = curEl;

        // 1) Update tab bar IMMEDIATELY.
        if (newTabId) {
          flushSync(() => onSwitchTab(newTabId));
          oldEl.style.visibility = 'visible';
          oldEl.style.contentVisibility = 'visible';
        }

        // 2) Scale animation duration with remaining distance for a natural feel.
        const remainingPct = 1 - Math.abs(state.offsetX) / cw;
        const duration = Math.max(SNAP_DURATION, Math.round(remainingPct * 500));

        // 3) Set transition property NOW (tells browser "animate transform changes").
        curEl.style.transition = `transform ${duration}ms ${SNAP_EASING}`;
        adjEl.style.transition = `transform ${duration}ms ${SNAP_EASING}`;

        // 4) Defer the TARGET transform to the next frame.
        //    This guarantees the browser has painted the current tracking position
        //    as the "from" state. Setting transition + target in the same frame
        //    causes WKWebView to skip the animation entirely.
        const capturedCurEl = curEl;
        const capturedAdjEl = adjEl;
        requestAnimationFrame(() => {
          if (state.generation !== gen) return;
          capturedCurEl.style.transform = `translateX(${curTarget}px)`;
          capturedAdjEl.style.transform = 'translateX(0)';
        });

        const onEnd = (e?: Event) => {
          if (e instanceof TransitionEvent && e.propertyName !== 'transform') return;
          if (state.generation !== gen) return;
          state.generation++;
          clearAllTimers();
          detachOnEnd();
          oldEl.style.visibility = '';
          oldEl.style.contentVisibility = 'hidden';
          for (let i = 0; i < cont.children.length; i++) {
            const el = cont.children[i] as HTMLElement;
            el.style.transform = '';
            el.style.transition = '';
          }
          resetState();
          state.cooldownUntil = performance.now() + COMMIT_COOLDOWN;
        };
        adjEl.addEventListener('transitionend', onEnd as EventListener, { once: true });
        state.activeOnEnd = onEnd;
        state.activeOnEndEl = adjEl;
        // +32ms accounts for rAF delay before transition starts
        state.snapTimer = setTimeout(onEnd, duration + SNAP_SAFETY_BUFFER + 32);
      } else {
        // Bounce back — defer target to next frame for reliable transition
        curEl.style.transition = `transform ${SNAP_DURATION}ms ${SNAP_EASING}`;
        if (adjEl) {
          adjEl.style.transition = `transform ${SNAP_DURATION}ms ${SNAP_EASING}`;
        }

        const capturedCurEl = curEl;
        const capturedAdjEl = adjEl;
        const bounceAdjBase = swipeDir > 0 ? -cw : cw;
        requestAnimationFrame(() => {
          if (state.generation !== gen) return;
          capturedCurEl.style.transform = 'translateX(0)';
          if (capturedAdjEl) {
            capturedAdjEl.style.transform = `translateX(${bounceAdjBase}px)`;
          }
        });

        const listenEl = adjEl ?? curEl;
        const onEnd = (e?: Event) => {
          if (e instanceof TransitionEvent && e.propertyName !== 'transform') return;
          if (state.generation !== gen) return;
          state.generation++;
          clearAllTimers();
          detachOnEnd();
          cleanupDOM();
          resetState();
          state.cooldownUntil = performance.now() + BOUNCE_COOLDOWN;
        };
        listenEl.addEventListener('transitionend', onEnd as EventListener, { once: true });
        state.activeOnEnd = onEnd;
        state.activeOnEndEl = listenEl;
        state.snapTimer = setTimeout(onEnd, SNAP_DURATION + SNAP_SAFETY_BUFFER + 32);
      }
    }

    // ─── Snap decision ────────────────────────────────────────

    function makeSnapDecision() {
      if (state.phase !== 'tracking') return;
      const cont = contentRef.current;
      if (!cont) { resetState(); return; }

      const cw = cont.clientWidth;
      const v = getVelocity();
      const offsetDir: -1 | 1 = state.offsetX > 0 ? 1 : -1;

      const positionTriggered = Math.abs(state.offsetX) > cw * POSITION_THRESHOLD;
      const velocityTriggered = Math.abs(v) > COMMIT_VELOCITY;

      let shouldCommit = state.adjacentEl !== null && (positionTriggered || velocityTriggered);
      if (shouldCommit && velocityTriggered && !positionTriggered) {
        const velDir = v > 0 ? 1 : -1;
        if (velDir !== offsetDir) shouldCommit = false;
      }

      animateSnap(shouldCommit, offsetDir);
    }

    // ─── Main wheel handler ───────────────────────────────────

    function handleWheel(e: WheelEvent) {
      // Absorb events during cooldown (post-animation inertial events)
      if (state.cooldownUntil > 0 && performance.now() < state.cooldownUntil) {
        e.preventDefault();
        return;
      }
      state.cooldownUntil = 0;

      const tabs = tabsRef.current;
      if (tabs.length <= 1) {
        if (state.phase !== 'idle') {
          cleanupDOM();
          resetState();
        }
        return;
      }

      const cont = contentRef.current;
      if (!cont) return;

      const { deltaX, deltaY } = e;
      if (deltaX === 0 && deltaY === 0) return;

      // WebKit (Tauri WKWebView on macOS) may expose gesture phase.
      // Note: these are non-standard and may not be available in all browsers.
      const wheelPhase = (e as unknown as { phase?: number }).phase;
      const momentumPhase = (e as unknown as { momentumPhase?: number }).momentumPhase;

      // ── Direction lock ──
      if (state.direction === null && state.phase !== 'animating') {
        const ax = Math.abs(deltaX);
        const ay = Math.abs(deltaY);
        if (ax < DIR_LOCK_MIN && ay < DIR_LOCK_MIN) return;
        if (ax > ay * DIR_LOCK_RATIO) {
          // Horizontal gesture — but check if an inner element should handle it
          if (hasInnerHorizontalScroll(e.target, cont, deltaX)) {
            state.direction = 'inner-scroll';
          } else {
            state.direction = 'horizontal';
          }
        } else {
          state.direction = 'vertical';
        }
        if (state.direction === 'vertical') return;
      }

      if (state.direction === 'vertical' || state.direction === 'inner-scroll') {
        if (state.dirResetTimer !== null) clearTimeout(state.dirResetTimer);
        state.dirResetTimer = setTimeout(() => {
          state.direction = null;
          state.dirResetTimer = null;
        }, DIR_RESET_TIMEOUT);
        return;
      }

      e.preventDefault();

      // ── All animations are final — absorb events until completion + cooldown ──
      if (state.phase === 'animating') {
        return;
      }

      // ── Init tracking ──
      const activeIndex = getActiveIndex();
      if (activeIndex === -1) {
        // Tab was removed mid-gesture — clean up stale tracking state
        if (state.phase === 'tracking') { cleanupDOM(); resetState(); }
        return;
      }
      const cw = cont.clientWidth;
      if (cw === 0) return; // container hidden or not laid out yet

      if (state.phase === 'idle') {
        state.phase = 'tracking';
        state.offsetX = 0;
        state.velocitySamples = [];
        state.currentEl = getTabEl(activeIndex);
        state.adjacentEl = null;
        state.adjacentIndex = -1;
        state.mergeCount = 0;
        state.mergeDeltaSum = 0;
        state.mergeTimeSum = 0;
        state.prevMergedPoint = null;
        state.prevMergedVelocity = 0;
        state.accFactors = [];
        state.momentumFlag = false;
      }

      // ── Accumulate offset (CLAMPED to ±containerWidth) ──
      state.offsetX = clamp(state.offsetX - deltaX, -cw, cw);
      addSample(-deltaX);

      // ── Feed momentum detector (side-effect: updates state.momentumFlag) ──
      feedMomentumDetector(-deltaX);

      // ── Resolve adjacent tab ──
      const wantIdx = state.offsetX > 0
        ? activeIndex - 1
        : activeIndex + 1;
      const atBoundary = wantIdx < 0 || wantIdx >= tabs.length;

      if (!atBoundary && state.adjacentIndex !== wantIdx) {
        if (state.adjacentEl && state.adjacentIndex !== activeIndex) hideTab(state.adjacentEl);
        state.adjacentIndex = wantIdx;
        state.adjacentEl = getTabEl(wantIdx);
        if (state.adjacentEl) {
          const adjOff = state.offsetX > 0 ? -cw + state.offsetX : cw + state.offsetX;
          state.adjacentEl.style.transform = `translateX(${adjOff}px)`;
          showTab(state.adjacentEl);
        }
      }

      // ── Apply transforms ──
      let visOffset = state.offsetX;
      if (atBoundary) {
        visOffset = rubberBand(state.offsetX);
        if (state.adjacentEl && state.adjacentIndex !== activeIndex) {
          hideTab(state.adjacentEl);
          state.adjacentEl = null;
          state.adjacentIndex = -1;
        }
      }

      if (state.currentEl) {
        state.currentEl.style.transform = `translateX(${visOffset}px)`;
      }
      if (state.adjacentEl && !atBoundary) {
        const adjOff = state.offsetX > 0
          ? -cw + visOffset
          : cw + visOffset;
        state.adjacentEl.style.transform = `translateX(${adjOff}px)`;
      }

      // ── Proactive commit (prevents inertia drift / overshoot) ──
      // When content crosses threshold with clear velocity, commit IMMEDIATELY.
      // This mirrors native macOS: once the swipe is decisive, the system locks in.
      // Without this, inertia events keep drifting the content past the target.
      if (state.adjacentEl && !atBoundary) {
        const positionPct = Math.abs(state.offsetX) / cw;
        const v = getVelocity();
        const vDir = v > 0 ? 1 : -1;
        const oDir: -1 | 1 = state.offsetX > 0 ? 1 : -1;

        const fastSwipe = positionPct > POSITION_THRESHOLD
          && Math.abs(v) > COMMIT_VELOCITY
          && vDir === oDir;
        const nearTarget = positionPct > PROACTIVE_POSITION_MAX;

        if (fastSwipe || nearTarget) {
          if (state.idleTimer !== null) { clearTimeout(state.idleTimer); state.idleTimer = null; }
          animateSnap(true, oDir);
          return;
        }
      }

      // ── WebKit phase-based gesture end (if available) ──
      if (wheelPhase === WEBKIT_PHASE_ENDED || wheelPhase === WEBKIT_PHASE_CANCELLED) {
        if (state.idleTimer !== null) { clearTimeout(state.idleTimer); state.idleTimer = null; }
        makeSnapDecision();
        return;
      }

      // ── WebKit momentum phase: finger already lifted ──
      if (typeof momentumPhase === 'number' && momentumPhase > 0) {
        if (state.idleTimer !== null) { clearTimeout(state.idleTimer); state.idleTimer = null; }
        makeSnapDecision();
        return;
      }

      // ── Idle timer (velocity-aware) ──
      // Timer resets on every event; only fires when events STOP.
      // Timeout scales with recent velocity:
      //   - Inertia tail (momentum + tiny delta) → 150ms (inertia ending)
      //   - Fast movement (v > COMMIT_VELOCITY)  → 200ms (quick flick → decide fast)
      //   - Slow / paused                        → 500ms (finger might still be on pad)
      if (atBoundary) {
        if (state.idleTimer !== null) clearTimeout(state.idleTimer);
        state.idleTimer = setTimeout(makeSnapDecision, IDLE_BOUNDARY);
      } else {
        if (state.idleTimer !== null) clearTimeout(state.idleTimer);
        const absDelta = Math.abs(deltaX);
        const isInertiaTail = state.momentumFlag && absDelta < INERTIA_TAIL_THRESHOLD;
        const recentV = Math.abs(getVelocity());
        const timeout = isInertiaTail ? IDLE_INERTIA_TAIL
          : recentV > COMMIT_VELOCITY ? IDLE_FAST
          : IDLE_SLOW;
        state.idleTimer = setTimeout(makeSnapDecision, timeout);
      }
    }

    container.addEventListener('wheel', handleWheel, { passive: false });

    return () => {
      container.removeEventListener('wheel', handleWheel);
      cleanupDOM();
      resetState();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- refs are stable
  }, []);
}
