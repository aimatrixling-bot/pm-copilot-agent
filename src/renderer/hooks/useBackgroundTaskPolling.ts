import { useCallback, useEffect, useRef, useState } from 'react';
import type { BackgroundTaskStats } from '@/types/chat';

interface PollResponse {
  success: boolean;
  stats: BackgroundTaskStats | null;
  newOffset: number;
  isComplete: boolean;
  error?: string;
}

interface UseBackgroundTaskPollingParams {
  outputFile: string | null;  // null = 不轮询
  isActive: boolean;          // false = 暂停
  apiPost: <T>(path: string, body?: unknown) => Promise<T>;
}

interface UseBackgroundTaskPollingResult {
  stats: BackgroundTaskStats | null;
  isComplete: boolean;
}

const POLL_INTERVAL_MS = 3000;
const MAX_CONSECUTIVE_ERRORS = 3;
const MAX_POLL_DURATION_MS = 60 * 60 * 1000; // 60 minutes

export function useBackgroundTaskPolling({
  outputFile,
  isActive,
  apiPost
}: UseBackgroundTaskPollingParams): UseBackgroundTaskPollingResult {
  const [stats, setStats] = useState<BackgroundTaskStats | null>(null);
  const [isComplete, setIsComplete] = useState(false);

  // Stable refs to avoid useEffect dependency issues (CLAUDE.md 规则 3)
  const apiPostRef = useRef(apiPost);
  useEffect(() => {
    apiPostRef.current = apiPost;
  });

  const offsetRef = useRef(0);
  const errorCountRef = useRef(0);
  const startTimeRef = useRef(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const isCompleteRef = useRef(false);
  // Accumulate stats across polls
  const accStatsRef = useRef<BackgroundTaskStats>({
    toolCount: 0, assistantCount: 0, userCount: 0, progressCount: 0, elapsed: 0
  });

  const doPoll = useCallback(async (file: string) => {
    if (isCompleteRef.current) return;

    // Timeout check
    if (startTimeRef.current && Date.now() - startTimeRef.current > MAX_POLL_DURATION_MS) {
      return;
    }

    try {
      const resp = await apiPostRef.current('/api/task/poll-background', {
        outputFile: file,
        offset: offsetRef.current
      }) as PollResponse;

      if (!resp.success) {
        errorCountRef.current++;
        return;
      }

      // Reset error count on success
      errorCountRef.current = 0;

      if (resp.newOffset > offsetRef.current) {
        offsetRef.current = resp.newOffset;
      }

      if (resp.stats) {
        // Accumulate incremental stats
        const acc = accStatsRef.current;
        acc.toolCount += resp.stats.toolCount;
        acc.assistantCount += resp.stats.assistantCount;
        acc.userCount += resp.stats.userCount;
        acc.progressCount += resp.stats.progressCount;
        // elapsed: use the max span from backend (covers full file time range)
        if (resp.stats.elapsed > acc.elapsed) {
          acc.elapsed = resp.stats.elapsed;
        }
        setStats({ ...acc });
      }

      if (resp.isComplete) {
        isCompleteRef.current = true;
        setIsComplete(true);
      }
    } catch {
      errorCountRef.current++;
    }
  }, []);

  useEffect(() => {
    // Clear previous interval (规则 4)
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = undefined;
    }

    if (!outputFile || !isActive || isCompleteRef.current) {
      return;
    }

    // Initialize start time
    if (!startTimeRef.current) {
      startTimeRef.current = Date.now();
    }

    // Initial poll
    doPoll(outputFile);

    // Set up interval
    intervalRef.current = setInterval(() => {
      // Stop conditions
      if (isCompleteRef.current || errorCountRef.current >= MAX_CONSECUTIVE_ERRORS) {
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = undefined;
        }
        return;
      }
      doPoll(outputFile);
    }, POLL_INTERVAL_MS);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = undefined;
      }
    };
  }, [outputFile, isActive, doPoll]);

  return { stats, isComplete };
}
