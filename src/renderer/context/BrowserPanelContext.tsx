import { createContext, useContext } from 'react';

export interface BrowserPanelContextValue {
  /** Open a URL in the embedded browser panel */
  openUrl: (url: string) => void;
}

export const BrowserPanelContext = createContext<BrowserPanelContextValue | null>(null);

/** Returns the browser panel context, or null when not inside a Chat page */
export function useBrowserPanel(): BrowserPanelContextValue | null {
  return useContext(BrowserPanelContext);
}
