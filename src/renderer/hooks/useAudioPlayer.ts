import { useCallback, useSyncExternalStore } from 'react';
import { subscribeAudio, toggleAudio, seekTo } from '@/utils/audioPlayer';
import type { AudioState } from '@/utils/audioPlayer';

const defaultState: AudioState = { playing: false, currentPath: null, progress: 0, duration: 0 };
let latestState: AudioState = defaultState;

// Single shared subscription that updates latestState
const subscribers = new Set<() => void>();
let unsubGlobal: (() => void) | null = null;

function ensureGlobalSub() {
  if (!unsubGlobal) {
    unsubGlobal = subscribeAudio((state) => {
      latestState = state;
      for (const fn of subscribers) fn();
    });
  }
}

function subscribe(onStoreChange: () => void): () => void {
  ensureGlobalSub();
  subscribers.add(onStoreChange);
  return () => {
    subscribers.delete(onStoreChange);
  };
}

function getSnapshot(): AudioState {
  return latestState;
}

/**
 * React hook for audio playback.
 * Returns the global audio state and toggle function for a specific file.
 */
export function useAudioPlayer(filePath: string) {
  const state = useSyncExternalStore(subscribe, getSnapshot);

  const isActive = state.currentPath === filePath && state.playing;

  // toggleAudio/seekTo read internal singleton state, so no dependency on isActive
  const toggle = useCallback(() => toggleAudio(filePath), [filePath]);
  const seek = useCallback((time: number) => seekTo(time), []);

  return { isActive, progress: isActive ? state.progress : 0, duration: isActive ? state.duration : 0, toggle, seek };
}
