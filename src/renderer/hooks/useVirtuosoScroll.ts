/**
 * useVirtuosoScroll — thin wrapper around react-virtuoso's scroll API.
 *
 * Three-state follow model:
 *  - `'force'`: always follow (after scrollToBottom, until confirmed at bottom)
 *  - `true`:    follow when at bottom (normal streaming)
 *  - `false`:   disabled (user scrolled up, or paused for rewind/retry)
 *
 * Transitions:
 *  scrollToBottom() → 'force'
 *  atBottomStateChange(true) + force → true  (confirmed at bottom, normal follow)
 *  atBottomStateChange(false) + true → false  (user scrolled up, stop following)
 *  pauseAutoScroll() → false (temporary, restores to true only if was true/force before)
 */

import { useCallback, useEffect, useRef } from 'react';
import type { VirtuosoHandle } from 'react-virtuoso';

export interface VirtuosoScrollControls {
    virtuosoRef: React.RefObject<VirtuosoHandle | null>;
    scrollerRef: React.MutableRefObject<HTMLElement | null>;
    followEnabledRef: React.MutableRefObject<boolean | 'force'>;
    scrollToBottom: () => void;
    pauseAutoScroll: (duration?: number) => void;
    handleAtBottomChange: (atBottom: boolean) => void;
}

export function useVirtuosoScroll(): VirtuosoScrollControls {
    const virtuosoRef = useRef<VirtuosoHandle>(null);
    const scrollerRef = useRef<HTMLElement | null>(null);
    const followEnabledRef = useRef<boolean | 'force'>(true);
    const pauseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Track what followEnabled was before pause, so we can restore correctly
    const prePauseFollowRef = useRef<boolean | 'force'>(true);

    const scrollToBottom = useCallback(() => {
        followEnabledRef.current = 'force';
        virtuosoRef.current?.scrollToIndex({ index: 'LAST', behavior: 'smooth' });
    }, []);

    const pauseAutoScroll = useCallback((duration = 500) => {
        // Save current state so we restore to the RIGHT value, not unconditionally true.
        // If user had scrolled up (false), restore to false — don't snap back to bottom.
        prePauseFollowRef.current = followEnabledRef.current;
        followEnabledRef.current = false;
        if (pauseTimerRef.current) clearTimeout(pauseTimerRef.current);
        pauseTimerRef.current = setTimeout(() => {
            followEnabledRef.current = prePauseFollowRef.current;
            pauseTimerRef.current = null;
        }, duration);
    }, []);

    const handleAtBottomChange = useCallback((atBottom: boolean) => {
        if (atBottom && followEnabledRef.current === 'force') {
            followEnabledRef.current = true;
        }
        if (!atBottom && followEnabledRef.current === true) {
            followEnabledRef.current = false;
        }
    }, []);

    useEffect(() => {
        return () => {
            if (pauseTimerRef.current) clearTimeout(pauseTimerRef.current);
        };
    }, []);

    return { virtuosoRef, scrollerRef, followEnabledRef, scrollToBottom, pauseAutoScroll, handleAtBottomChange };
}
