/**
 * MonacoEditor - Lightweight Monaco Editor wrapper for file editing
 * 
 * Features:
 * - Auto language detection based on file extension
 * - Custom warm theme matching preview background
 * - Optimized for performance (minimal features enabled)
 * - Loading state handling
 * - Local bundle (no CDN) for Tauri CSP compatibility
 */
import Editor, { loader, type Monaco } from '@monaco-editor/react';
import { Loader2 } from 'lucide-react';
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
// CRITICAL: Must import Monaco CSS for styles to work in Vite bundled mode
import 'monaco-editor/min/vs/editor/editor.main.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// Configure Monaco Environment for bundled workers (required for Tauri CSP)
self.MonacoEnvironment = {
    getWorker(_: unknown, label: string) {
        if (label === 'json') {
            return new jsonWorker();
        }
        if (label === 'css' || label === 'scss' || label === 'less') {
            return new cssWorker();
        }
        if (label === 'html' || label === 'handlebars' || label === 'razor') {
            return new htmlWorker();
        }
        if (label === 'typescript' || label === 'javascript') {
            return new tsWorker();
        }
        return new editorWorker();
    }
};

// Configure Monaco to use local bundle instead of CDN
loader.config({ monaco });

// Custom theme names
const LIGHT_THEME_NAME = 'warmLight';
const DARK_THEME_NAME = 'warmDark';

// Re-export language utilities from shared module for backward compatibility
export { getMonacoLanguage, shouldShowLineNumbers } from '@/utils/languageUtils';

interface MonacoEditorProps {
    value: string;
    onChange: (value: string) => void;
    language?: string;
    readOnly?: boolean;
    className?: string;
    /** Auto focus the editor when mounted */
    autoFocus?: boolean;
    /** Cmd/Ctrl+S handler — registered as Monaco keybinding */
    onSave?: () => void;
}

export default function MonacoEditor({
    value,
    onChange,
    language = 'plaintext',
    readOnly = false,
    className = '',
    autoFocus = false,
    onSave,
}: MonacoEditorProps) {
    const handleChange = useCallback((newValue: string | undefined) => {
        onChange(newValue ?? '');
    }, [onChange]);

    // Register custom theme in beforeMount using the callback's monaco instance
    // This ensures we're defining the theme on the exact instance the Editor will use
    // Colors are aligned with Prism oneLight theme for consistency between preview and edit modes
    // Detect dark mode from <html> class and watch for changes
    const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains('dark'));

    useEffect(() => {
        const htmlEl = document.documentElement;
        const observer = new MutationObserver(() => {
            setIsDark(htmlEl.classList.contains('dark'));
        });
        observer.observe(htmlEl, { attributes: true, attributeFilter: ['class'] });
        return () => observer.disconnect();
    }, []);

    const activeTheme = isDark ? DARK_THEME_NAME : LIGHT_THEME_NAME;

    const handleBeforeMount = useCallback((monacoInstance: Monaco) => {
        monacoInstance.editor.defineTheme(LIGHT_THEME_NAME, {
            base: 'vs',
            inherit: true,
            rules: [
                // Prism oneLight colors (with warm background adaptation)
                { token: 'comment', foreground: '9ea1a7', fontStyle: 'italic' },  // hsl(230, 4%, 64%)
                { token: 'keyword', foreground: 'a626a4' },                        // hsl(301, 63%, 40%) - purple
                { token: 'keyword.control', foreground: 'a626a4' },
                { token: 'storage', foreground: 'a626a4' },
                { token: 'storage.type', foreground: 'a626a4' },
                { token: 'string', foreground: '50a14f' },                         // hsl(119, 34%, 47%) - green
                { token: 'string.quoted', foreground: '50a14f' },
                { token: 'number', foreground: 'b76b01' },                         // hsl(35, 99%, 36%) - orange
                { token: 'constant', foreground: 'b76b01' },
                { token: 'constant.numeric', foreground: 'b76b01' },
                { token: 'type', foreground: 'b76b01' },                           // class-name color
                { token: 'type.identifier', foreground: 'b76b01' },
                { token: 'class', foreground: 'b76b01' },
                { token: 'function', foreground: '4078f2' },                       // hsl(221, 87%, 60%) - blue
                { token: 'function.call', foreground: '4078f2' },
                { token: 'variable', foreground: '4078f2' },
                { token: 'variable.other', foreground: '4078f2' },
                { token: 'operator', foreground: '4078f2' },
                { token: 'tag', foreground: 'e45649' },                            // hsl(5, 74%, 59%) - red
                { token: 'attribute.name', foreground: 'b76b01' },
                { token: 'attribute.value', foreground: '50a14f' },
                { token: 'delimiter', foreground: '383a42' },                      // punctuation
                { token: 'delimiter.bracket', foreground: '383a42' },
            ],
            colors: {
                // Editor background - matching preview warm tone
                'editor.background': '#f8f5ef',
                'editor.foreground': '#383a42',  // Prism oneLight foreground
                'editor.lineHighlightBackground': '#f3f0ea',
                'editor.selectionBackground': '#e5e5e6',  // hsl(230, 1%, 90%)
                'editor.inactiveSelectionBackground': '#f0ede6',
                // Line numbers
                'editorLineNumber.foreground': '#9ea1a7',  // match comment color
                'editorLineNumber.activeForeground': '#383a42',
                // Scrollbar - subtle to match preview
                'scrollbar.shadow': '#00000000',
                'scrollbarSlider.background': '#c8b8a840',
                'scrollbarSlider.hoverBackground': '#b8a08860',
                'scrollbarSlider.activeBackground': '#a0906880',
                // Gutter and margins - matching preview exactly
                'editorGutter.background': '#f8f5ef',
                // Cursor
                'editorCursor.foreground': '#383a42',
                // Indent guides
                'editorIndentGuide.background': '#e8e4db',
                'editorIndentGuide.activeBackground': '#d8d4cb',
            }
        });

        monacoInstance.editor.defineTheme(DARK_THEME_NAME, {
            base: 'vs-dark',
            inherit: true,
            rules: [
                // oneDark-inspired colors adapted for warm dark theme
                { token: 'comment', foreground: '685c52', fontStyle: 'italic' },  // --code-line-number
                { token: 'keyword', foreground: 'c678dd' },                        // purple
                { token: 'keyword.control', foreground: 'c678dd' },
                { token: 'storage', foreground: 'c678dd' },
                { token: 'storage.type', foreground: 'c678dd' },
                { token: 'string', foreground: '98c379' },                         // green
                { token: 'string.quoted', foreground: '98c379' },
                { token: 'number', foreground: 'd19a66' },                         // orange
                { token: 'constant', foreground: 'd19a66' },
                { token: 'constant.numeric', foreground: 'd19a66' },
                { token: 'type', foreground: 'e5c07b' },                           // yellow
                { token: 'type.identifier', foreground: 'e5c07b' },
                { token: 'class', foreground: 'e5c07b' },
                { token: 'function', foreground: '61afef' },                       // blue
                { token: 'function.call', foreground: '61afef' },
                { token: 'variable', foreground: 'e06c75' },                       // red
                { token: 'variable.other', foreground: 'e06c75' },
                { token: 'operator', foreground: '56b6c2' },                       // cyan
                { token: 'tag', foreground: 'e06c75' },                            // red
                { token: 'attribute.name', foreground: 'd19a66' },
                { token: 'attribute.value', foreground: '98c379' },
                { token: 'delimiter', foreground: 'abb2bf' },                      // punctuation
                { token: 'delimiter.bracket', foreground: 'abb2bf' },
            ],
            colors: {
                // Dark warm background matching --code-bg / --paper dark vars
                'editor.background': '#141210',           // --code-bg (dark)
                'editor.foreground': '#d4d4d4',           // --code-text
                'editor.lineHighlightBackground': '#1e1a16', // --code-header-bg (dark)
                'editor.selectionBackground': '#3a342c',  // muted warm selection
                'editor.inactiveSelectionBackground': '#302a22',
                // Line numbers
                'editorLineNumber.foreground': '#685c52', // --code-line-number (dark)
                'editorLineNumber.activeForeground': '#cfc5ba', // --ink-secondary (dark)
                // Scrollbar
                'scrollbar.shadow': '#00000000',
                'scrollbarSlider.background': '#4a403840',
                'scrollbarSlider.hoverBackground': '#5a504860',
                'scrollbarSlider.activeBackground': '#6a605880',
                // Gutter
                'editorGutter.background': '#141210',
                // Cursor
                'editorCursor.foreground': '#e4dcd4',     // --ink (dark)
                // Indent guides
                'editorIndentGuide.background': '#2a2420',
                'editorIndentGuide.activeBackground': '#3a342c',
            }
        });
    }, []);

    // Stable ref for onSave to avoid re-registering keybinding on every render
    const onSaveRef = useRef(onSave);
    useEffect(() => { onSaveRef.current = onSave; }, [onSave]);

    // Force apply theme after mount to ensure it takes effect
    // This handles the case where beforeMount's defineTheme might not sync immediately
    // Also registers Cmd/Ctrl+S keybinding and handles autoFocus
    const handleOnMount = useCallback((editor: monaco.editor.IStandaloneCodeEditor, monacoInstance: Monaco) => {
        monacoInstance.editor.setTheme(activeTheme);

        // Register Cmd/Ctrl+S keybinding
        editor.addCommand(
            monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyS,
            () => { onSaveRef.current?.(); }
        );

        if (autoFocus) {
            // Use setTimeout to ensure editor is fully ready
            setTimeout(() => editor.focus(), 0);
        }
    }, [autoFocus, activeTheme]);

    // Monaco editor options optimized for performance
    const options = useMemo(() => ({
        readOnly,
        minimap: { enabled: false },
        lineNumbers: 'on' as const,
        lineNumbersMinChars: 4,
        scrollBeyondLastLine: false,
        wordWrap: 'on' as const,
        wrappingStrategy: 'advanced' as const,
        // Disable accessibility support to fix CJK IME composition issues on WebKit/macOS.
        // When enabled, Monaco uses a different text measurement path that causes:
        // - Multi-line: entire line jumps right during pinyin composition
        // - Single-line: line bounces vertically during composition
        // See: https://github.com/microsoft/monaco-editor/issues/4270
        accessibilitySupport: 'off' as const,
        fontSize: 13,
        lineHeight: 20,
        // Use expanded font stack for Chinese character support in comments
        // Note: Monaco doesn't support CSS variables, so we inline the --font-code equivalent
        fontFamily: "ui-monospace, 'SF Mono', 'Cascadia Code', 'Consolas', 'Monaco', 'Fira Code', 'PingFang SC', 'Microsoft YaHei', monospace",
        tabSize: 2,
        automaticLayout: true,
        padding: { top: 16, bottom: 16 },
        scrollbar: {
            vertical: 'auto' as const,
            horizontal: 'auto' as const,
            verticalScrollbarSize: 8,
            horizontalScrollbarSize: 8,
            useShadows: false,
        },
        // Disable features for performance
        folding: true,
        foldingHighlight: false,
        showFoldingControls: 'mouseover' as const,
        renderWhitespace: 'none' as const,
        guides: {
            indentation: true,
            bracketPairs: false,
        },
        bracketPairColorization: { enabled: false },
        contextmenu: false,
        dragAndDrop: false,
        quickSuggestions: false,
        suggestOnTriggerCharacters: false,
        acceptSuggestionOnEnter: 'off' as const,
        hover: { enabled: false },
        parameterHints: { enabled: false },
        // Prevent long lines (e.g., minified JSON/JS) from freezing the tokenizer
        maxTokenizationLineLength: 10000,
    }), [readOnly]);

    return (
        <div className={`relative h-full w-full overflow-hidden ${className}`}>
            <Editor
                height="100%"
                language={language}
                value={value}
                onChange={handleChange}
                theme={activeTheme}
                options={options}
                beforeMount={handleBeforeMount}
                onMount={handleOnMount}
                loading={
                    <div className="flex h-full items-center justify-center gap-2 text-[var(--ink-muted)]">
                        <Loader2 className="h-5 w-5 animate-spin" />
                        <span className="text-sm">加载编辑器...</span>
                    </div>
                }
            />
        </div>
    );
}

