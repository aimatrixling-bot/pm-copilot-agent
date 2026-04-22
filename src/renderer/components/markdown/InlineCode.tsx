/**
 * InlineCode - Styled inline code snippets
 *
 * When rendered inside a Chat (FileActionContext available), automatically
 * detects file/folder paths and makes them interactive (dashed underline + click menu).
 * Audio file paths get an inline play/stop button.
 */
import { useFileAction } from '@/context/FileActionContext';
import { isAudioPath } from '@/utils/audioPlayer';
import { useAudioPlayer } from '@/hooks/useAudioPlayer';
import { looksLikeFilePath } from '@/utils/pathDetection';
import { Play, Square } from 'lucide-react';

interface InlineCodeProps {
    children: React.ReactNode;
}

const BASE_CLASS = 'rounded bg-[var(--paper-inset)] px-1.5 py-0.5 font-mono text-[0.9em] text-[var(--ink)]';
const INTERACTIVE_CLASS = `${BASE_CLASS} border-b border-dashed border-[var(--ink-muted)] cursor-pointer hover:bg-[var(--accent-warm-subtle)] transition-colors`;

/** Extract plain text from React children (handles string / number / nested spans). */
function extractText(node: React.ReactNode): string {
    if (typeof node === 'string') return node;
    if (typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(extractText).join('');
    if (node && typeof node === 'object' && 'props' in node) {
        return extractText((node as { props: { children?: React.ReactNode } }).props.children);
    }
    return '';
}

/** Inline play/stop button for audio file paths */
function AudioPlayButton({ filePath }: { filePath: string }) {
    const { isActive, toggle } = useAudioPlayer(filePath);

    return (
        <button
            type="button"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggle(); }}
            className="ml-1 inline-flex size-[18px] shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-white transition-colors hover:bg-[var(--accent-warm-hover)] align-middle"
            title={isActive ? '停止播放' : '播放音频'}
        >
            {isActive
                ? <Square className="size-2 fill-current" />
                : <Play className="size-2.5 fill-current ml-px" />
            }
        </button>
    );
}

export default function InlineCode({ children }: InlineCodeProps) {
    const fileAction = useFileAction(); // null outside Chat
    const text = extractText(children);

    // Fast path: no context or not a path candidate → plain code
    if (!fileAction || !looksLikeFilePath(text)) {
        return <code className={BASE_CLASS}>{children}</code>;
    }

    // Ask context for cached result (may trigger a batched backend request)
    const pathInfo = fileAction.checkPath(text);

    if (!pathInfo?.exists) {
        // Not yet resolved or does not exist → plain code
        return <code className={BASE_CLASS}>{children}</code>;
    }

    // Check audio after existence confirmed (avoid wasted computation on non-existent paths)
    const isAudio = isAudioPath(text);

    // Path exists — render interactive
    const handleClick = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const rect = (e.target as HTMLElement).getBoundingClientRect();
        fileAction.openFileMenu(rect.left, rect.bottom + 4, text, pathInfo.type);
    };

    const handleContextMenu = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        fileAction.openFileMenu(e.clientX, e.clientY, text, pathInfo.type);
    };

    const codeEl = (
        <code
            className={INTERACTIVE_CLASS}
            onClick={handleClick}
            onContextMenu={handleContextMenu}
            title={pathInfo.type === 'dir' ? `文件夹: ${text}` : `文件: ${text}`}
        >
            {children}
        </code>
    );

    // Only wrap in span when audio button is needed, preserving DOM structure for non-audio paths
    if (isAudio) {
        return (
            <span className="inline-flex items-center">
                {codeEl}
                <AudioPlayButton filePath={text} />
            </span>
        );
    }

    return codeEl;
}
