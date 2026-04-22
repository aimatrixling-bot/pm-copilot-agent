/**
 * CustomTitleBar - Chrome-style titlebar with integrated tabs
 *
 * Key insight: data-tauri-drag-region must be on SPECIFIC draggable elements,
 * not just the parent container. Also, -webkit-app-region CSS CONFLICTS with
 * Tauri's mechanism on macOS WebKit.
 *
 * Windows: Custom window controls (minimize, maximize, close) are added since
 * we use decorations: false on Windows for custom title bar styling.
 */

import { BotMessageSquare, Minus, Square, X, RefreshCw, Settings, Copy } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { isTauri } from '@/api/tauriClient';
import FeedbackPopover from './FeedbackPopover';

interface CustomTitleBarProps {
    children: ReactNode;  // TabBar component
    onSettingsClick?: () => void;
    onOpenBugReport?: () => void;
    /** Whether an update is ready to install */
    updateReady?: boolean;
    /** Version of the update ready to install */
    updateVersion?: string | null;
    /** Callback when user clicks "Restart to Update" */
    onRestartAndUpdate?: () => void;
}

// macOS traffic lights (close/minimize/maximize) width + padding
const MACOS_TRAFFIC_LIGHTS_WIDTH = 78;

// Detect platform
const isWindows = typeof navigator !== 'undefined' && navigator.platform?.includes('Win');

export default function CustomTitleBar({
    children,
    onSettingsClick,
    onOpenBugReport,
    updateReady,
    updateVersion,
    onRestartAndUpdate,
}: CustomTitleBarProps) {
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [isMaximized, setIsMaximized] = useState(false);
    const [showFeedback, setShowFeedback] = useState(false);
    const feedbackBtnRef = useRef<HTMLDivElement>(null);

    const handleOpenBugReport = useCallback(() => {
        setShowFeedback(false);
        onOpenBugReport?.();
    }, [onOpenBugReport]);

    // Listen for fullscreen changes
    useEffect(() => {
        if (!isTauri()) return;

        let mounted = true;

        const checkWindowState = async () => {
            if (!mounted) return;
            try {
                const { getCurrentWindow } = await import('@tauri-apps/api/window');
                const win = getCurrentWindow();
                const fs = await win.isFullscreen();
                const max = await win.isMaximized();
                if (mounted) {
                    setIsFullscreen(fs);
                    setIsMaximized(max);
                }
            } catch (e) {
                console.error('Failed to check window state:', e);
            }
        };

        // Initial check
        checkWindowState();

        // Use resize event listener with debounce instead of polling
        // macOS fullscreen exit animation takes ~500-700ms, so we do a
        // second delayed check to catch the final state after animation.
        let resizeTimeout: NodeJS.Timeout;
        let animationTimeout: NodeJS.Timeout;
        const onResize = () => {
            clearTimeout(resizeTimeout);
            clearTimeout(animationTimeout);
            resizeTimeout = setTimeout(checkWindowState, 150);
            animationTimeout = setTimeout(checkWindowState, 700);
        };

        window.addEventListener('resize', onResize);

        return () => {
            mounted = false;
            window.removeEventListener('resize', onResize);
            clearTimeout(resizeTimeout);
            clearTimeout(animationTimeout);
        };
    }, []);

    // Windows window control handlers
    const handleMinimize = async () => {
        if (!isTauri()) return;
        try {
            const { getCurrentWindow } = await import('@tauri-apps/api/window');
            await getCurrentWindow().minimize();
        } catch (e) {
            console.error('Failed to minimize:', e);
        }
    };

    const handleMaximize = async () => {
        if (!isTauri()) return;
        try {
            const { getCurrentWindow } = await import('@tauri-apps/api/window');
            const win = getCurrentWindow();
            if (await win.isMaximized()) {
                await win.unmaximize();
            } else {
                await win.maximize();
            }
        } catch (e) {
            console.error('Failed to toggle maximize:', e);
        }
    };

    const handleClose = async () => {
        if (!isTauri()) return;
        try {
            const { getCurrentWindow } = await import('@tauri-apps/api/window');
            await getCurrentWindow().close();
        } catch (e) {
            console.error('Failed to close:', e);
        }
    };

    return (
        <div
            className="custom-titlebar flex h-11 flex-shrink-0 items-center border-b border-[var(--line)] bg-gradient-to-b from-[var(--paper)] to-[var(--paper-inset)]/30"
        >
            {/* macOS traffic lights spacer - DRAGGABLE (hidden on Windows) */}
            {!isWindows && !isFullscreen && (
                <div
                    className="flex-shrink-0 h-full"
                    style={{ width: MACOS_TRAFFIC_LIGHTS_WIDTH }}
                    data-tauri-drag-region
                />
            )}

            {/* Windows: Small left padding for drag area */}
            {isWindows && (
                <div
                    className="flex-shrink-0 h-full w-3"
                    data-tauri-drag-region
                />
            )}

            {/* Tabs area - NOT draggable */}
            <div
                className="flex h-full items-center overflow-hidden"
                data-no-drag
            >
                {children}
            </div>

            {/* Flexible spacer - DRAGGABLE */}
            <div
                className="flex-1 h-full"
                data-tauri-drag-region
            />

            {/* Right side actions - NOT draggable */}
            <div
                className="flex flex-shrink-0 items-center gap-1 px-3 h-full"
                data-no-drag
            >
                {/* Update button - only shown when update is ready */}
                {updateReady && (
                    <button
                        onClick={onRestartAndUpdate}
                        className="flex h-7 items-center gap-1.5 px-3 rounded-full text-xs font-medium text-white bg-[var(--success)] shadow-sm transition-all hover:bg-[var(--success)] active:scale-95"
                        title={updateVersion ? `更新到 v${updateVersion}` : '重启并更新'}
                    >
                        <RefreshCw className="h-3.5 w-3.5" />
                        <span>重启更新</span>
                    </button>
                )}
                {/* Feedback button + popover */}
                <div ref={feedbackBtnRef} className="relative">
                    <button
                        onClick={() => setShowFeedback(prev => !prev)}
                        className={`flex h-7 items-center gap-1.5 rounded-md px-2.5 transition-all ${
                            showFeedback
                                ? 'bg-[var(--paper-inset)] text-[var(--ink)]'
                                : 'text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]'
                        }`}
                        title="PM 助手"
                    >
                        <BotMessageSquare className="h-4 w-4" />
                        <span className="text-[13px] font-medium">PM 助手</span>
                    </button>
                    {showFeedback && (
                        <FeedbackPopover
                            onClose={() => setShowFeedback(false)}
                            onOpenBugReport={handleOpenBugReport}
                            triggerRef={feedbackBtnRef}
                        />
                    )}
                </div>

                <button
                    onClick={onSettingsClick || undefined}
                    className="flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[var(--ink-muted)] transition-all hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                    title="设置"
                >
                    <Settings className="h-4 w-4" />
                    <span className="text-[13px] font-medium">设置</span>
                </button>
            </div>

            {/* Windows window controls */}
            {isWindows && (
                <div className="flex h-full items-stretch" data-no-drag>
                    <button
                        onClick={handleMinimize}
                        className="flex w-11 items-center justify-center text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] transition-colors"
                        title="最小化"
                    >
                        <Minus className="h-4 w-4" />
                    </button>
                    <button
                        onClick={handleMaximize}
                        className="flex w-11 items-center justify-center text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] transition-colors"
                        title={isMaximized ? "还原" : "最大化"}
                    >
                        {isMaximized ? (
                            <Copy className="h-3.5 w-3.5" />
                        ) : (
                            <Square className="h-3.5 w-3.5" />
                        )}
                    </button>
                    <button
                        onClick={handleClose}
                        className="flex w-11 items-center justify-center text-[var(--ink-muted)] hover:bg-[var(--error)] hover:text-white transition-colors"
                        title="关闭"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>
            )}
        </div>
    );
}
