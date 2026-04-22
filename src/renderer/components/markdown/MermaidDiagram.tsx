/**
 * MermaidDiagram - Renders Mermaid diagrams with preview/code toggle
 *
 * Features:
 * - Progressive rendering: keeps last successful render while content updates
 * - Graceful degradation: shows last valid diagram if current content fails to parse
 * - Debounced updates to avoid excessive re-renders during streaming
 * - Preview/Code toggle: default to rendered preview, switchable to syntax-highlighted source
 * - Copy button: copies raw Mermaid source in both modes
 */

import { AlertCircle, Check, Code, Copy, Eye, RefreshCw } from 'lucide-react';
import mermaid from 'mermaid';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';

// Track if mermaid is initialized
let mermaidInitialized = false;

function initMermaid() {
    if (mermaidInitialized) return;

    mermaid.initialize({
        startOnLoad: false,
        theme: 'neutral',
        securityLevel: 'loose',
        suppressErrorRendering: true, // Don't show error in SVG
        fontFamily: "'Avenir Next', 'Gill Sans', sans-serif",
        flowchart: {
            useMaxWidth: true,
            htmlLabels: true,
            curve: 'basis',
        },
        themeVariables: {
            primaryColor: '#e8ddd0',
            primaryTextColor: '#1c1612',
            primaryBorderColor: '#c4b5a5',
            lineColor: '#8a7a6a',
            secondaryColor: '#f5efe8',
            tertiaryColor: '#fff8f0',
        },
    });
    mermaidInitialized = true;
}

// Reuse CodeBlock's theme for consistent code styling
const codeTheme = {
    ...oneDark,
    'pre[class*="language-"]': {
        ...oneDark['pre[class*="language-"]'],
        background: 'var(--code-bg)',
        borderRadius: 0,
        padding: '1rem',
        margin: 0,
        fontSize: '13px',
        lineHeight: '1.6',
    },
    'code[class*="language-"]': {
        ...oneDark['code[class*="language-"]'],
        background: 'transparent',
        fontSize: '13px',
        lineHeight: '1.6',
        fontFamily: 'var(--font-code)',
    },
};

interface MermaidDiagramProps {
    children: string;
}

// Timeout for stuck renders — prevents permanently blocking mermaid's internal serial queue.
// mermaid v11 already serializes render() calls internally, so no application-level queue needed.
const RENDER_TIMEOUT_MS = 15_000;

/** Race a promise against a timeout. Cleans up timer and prevents unhandled rejection on the original. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout>;
    return Promise.race([
        promise,
        new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error('Render timeout')), ms);
        }),
    ]).finally(() => {
        clearTimeout(timeoutId!);
        promise.catch(() => {}); // Swallow if original rejects after timeout
    });
}

// Check if streaming content looks complete enough to attempt a mermaid render.
// Intentionally permissive — this is only called for content already tagged as ```mermaid```,
// so we just guard against obviously incomplete streaming fragments.
function looksLikeValidMermaid(content: string): boolean {
    const trimmed = content.trim();
    // Need a diagram type declaration line + at least one definition line
    return trimmed.length >= 10 && trimmed.includes('\n');
}

export default function MermaidDiagram({ children }: MermaidDiagramProps) {
    // View mode: preview (rendered diagram) or code (syntax highlighted source)
    const [viewMode, setViewMode] = useState<'preview' | 'code'>('preview');
    const [copied, setCopied] = useState(false);

    // Store current SVG and rendering state
    const [lastValidSvg, setLastValidSvg] = useState<string>('');
    const [isRendering, setIsRendering] = useState(false);
    const [parseError, setParseError] = useState<string | null>(null);

    const id = useId().replace(/:/g, '_');
    const renderCountRef = useRef(0);
    const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Use ref to avoid re-creating tryRender on every successful render
    const lastValidContentRef = useRef('');

    const handleCopy = useCallback(async () => {
        try {
            await navigator.clipboard.writeText(children.trim());
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            console.error('Failed to copy:', err);
        }
    }, [children]);

    const tryRender = useCallback(async (content: string) => {
        const trimmedContent = content.trim();

        // Skip if content hasn't changed from last successful render
        if (trimmedContent === lastValidContentRef.current) return;
        // Skip if content doesn't look like valid mermaid
        if (!looksLikeValidMermaid(trimmedContent)) return;

        // Compute renderId before try so it's accessible in finally for DOM cleanup
        renderCountRef.current += 1;
        const renderId = `mermaid-${id}-${renderCountRef.current}`;

        try {
            initMermaid();
            setIsRendering(true);
            setParseError(null);

            // mermaid v11 has an internal serial queue — no application-level queuing needed.
            // withTimeout prevents a hung render from permanently blocking that queue.
            const { svg } = await withTimeout(mermaid.render(renderId, trimmedContent), RENDER_TIMEOUT_MS);

            lastValidContentRef.current = trimmedContent;
            setLastValidSvg(svg);
        } catch (err) {
            // Parse failed - this is expected during streaming
            // Keep showing the last valid SVG, just note the error
            const errorMsg = err instanceof Error ? err.message : 'Parse error';
            setParseError(errorMsg);
        } finally {
            setIsRendering(false);
            // Clean up orphaned DOM elements mermaid may leave on failure/timeout
            document.getElementById(renderId)?.remove();
        }
    }, [id]); // stable reference — no state dependencies

    useEffect(() => {
        // Debounce rendering - wait for content to stabilize
        if (debounceTimerRef.current) {
            clearTimeout(debounceTimerRef.current);
        }

        debounceTimerRef.current = setTimeout(() => {
            if (children.trim()) {
                tryRender(children);
            }
        }, 300); // 300ms debounce

        return () => {
            if (debounceTimerRef.current) {
                clearTimeout(debounceTimerRef.current);
            }
        };
    }, [children, tryRender]);

    const handleRetry = () => {
        tryRender(children);
    };

    // Header bar with toggle and copy button (shared across all states)
    const headerBar = (
        <div className="flex items-center justify-between bg-[var(--code-header-bg)] px-4 py-2 text-xs">
            <span className="font-mono uppercase tracking-wide text-[var(--code-line-number)]">
                mermaid
            </span>
            <div className="flex items-center gap-2">
                {/* Preview / Code toggle */}
                <div className="flex items-center rounded-md bg-[var(--code-bg)] p-0.5">
                    <button
                        type="button"
                        onClick={() => setViewMode('preview')}
                        className={`flex items-center gap-1 rounded px-2 py-0.5 transition-colors ${
                            viewMode === 'preview'
                                ? 'bg-[var(--code-header-bg)] text-[var(--code-text)]'
                                : 'text-[var(--code-line-number)] hover:text-[var(--code-text)]'
                        }`}
                    >
                        <Eye className="size-3" />
                        <span>预览</span>
                    </button>
                    <button
                        type="button"
                        onClick={() => setViewMode('code')}
                        className={`flex items-center gap-1 rounded px-2 py-0.5 transition-colors ${
                            viewMode === 'code'
                                ? 'bg-[var(--code-header-bg)] text-[var(--code-text)]'
                                : 'text-[var(--code-line-number)] hover:text-[var(--code-text)]'
                        }`}
                    >
                        <Code className="size-3" />
                        <span>代码</span>
                    </button>
                </div>
                {/* Copy button */}
                <button
                    type="button"
                    onClick={handleCopy}
                    className="flex items-center gap-1.5 rounded px-2 py-1 text-[var(--code-line-number)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                    title={copied ? '已复制' : '复制代码'}
                >
                    {copied ? (
                        <>
                            <Check className="size-3.5" />
                            <span>已复制</span>
                        </>
                    ) : (
                        <>
                            <Copy className="size-3.5" />
                            <span>复制</span>
                        </>
                    )}
                </button>
            </div>
        </div>
    );

    // Code view: syntax highlighted Mermaid source
    const codeView = (
        <SyntaxHighlighter
            language="mermaid"
            style={codeTheme}
            customStyle={{ margin: 0 }}
            showLineNumbers={children.trim().split('\n').length > 5}
            lineNumberStyle={{
                minWidth: '2.5em',
                paddingRight: '1em',
                color: 'var(--code-line-number)',
                userSelect: 'none',
            }}
            wrapLongLines={false}
        >
            {children.trim()}
        </SyntaxHighlighter>
    );

    // Preview content based on render state
    const previewContent = (() => {
        // Has valid SVG
        if (lastValidSvg) {
            return (
                <>
                    {isRendering && (
                        <div className="flex items-center gap-1.5 border-b border-[var(--line)] px-3 py-1.5 text-xs text-[var(--code-line-number)]">
                            <RefreshCw className="size-3 animate-spin" />
                            <span>更新中...</span>
                        </div>
                    )}
                    {/*
                     * SECURITY: dangerouslySetInnerHTML is safe here because:
                     * 1. SVG is generated by Mermaid library from validated diagram syntax
                     * 2. User input is parsed as Mermaid DSL, not directly injected as HTML
                     * 3. Mermaid is configured with securityLevel: 'loose' which still sanitizes
                     */}
                    <div
                        className="flex justify-center bg-[var(--paper-elevated)] p-4 [&>svg]:max-w-full"
                        dangerouslySetInnerHTML={{ __html: lastValidSvg }}
                    />
                </>
            );
        }

        // Parse error state (no valid SVG yet)
        if (parseError && looksLikeValidMermaid(children)) {
            return (
                <div className="p-4">
                    <div className="flex items-start justify-between gap-2">
                        <div className="flex items-start gap-2 text-[var(--warning)]">
                            <AlertCircle className="mt-0.5 size-4 shrink-0" />
                            <div className="min-w-0">
                                <p className="text-sm font-medium">图表渲染中...</p>
                                <p className="mt-1 truncate text-xs opacity-60">{parseError}</p>
                            </div>
                        </div>
                        <button
                            onClick={handleRetry}
                            className="shrink-0 rounded px-2 py-1 text-xs text-[var(--warning)] hover:bg-[var(--warning-bg)]"
                        >
                            重试
                        </button>
                    </div>
                </div>
            );
        }

        // Initial loading state
        return (
            <div className="flex h-20 items-center justify-center bg-[var(--paper-inset)]/50">
                <div className="flex items-center gap-2 text-sm text-[var(--ink-muted)]">
                    <RefreshCw className="size-4 animate-spin" />
                    <span>渲染图表...</span>
                </div>
            </div>
        );
    })();

    return (
        <div className="my-3 w-full overflow-hidden rounded-lg">
            {headerBar}
            {viewMode === 'code' ? codeView : previewContent}
        </div>
    );
}
