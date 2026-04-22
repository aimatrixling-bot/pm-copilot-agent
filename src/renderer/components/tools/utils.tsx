import { cloneElement, isValidElement, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type { ToolUseSimple } from '@/types/chat';

import {
  getThinkingBadgeConfig,
  getThinkingExpandedLabel,
  getToolBadgeConfig,
  getToolExpandedLabel
} from './toolBadgeConfig';

/**
 * Unwrap MCP tool result that may be JSON-encoded content array.
 * MCP tools return `[{type:'text', text:'...'}]` which the server JSON.stringify's.
 * This extracts the plain text so component-specific parsers can work.
 */
export function unwrapMcpResult(result: string): string {
  if (!result.startsWith('[')) return result;
  try {
    const parsed = JSON.parse(result) as unknown[];
    const texts = parsed
      .filter((c): c is { text: string } =>
        typeof c === 'object' && c !== null && 'text' in c &&
        typeof (c as { text: unknown }).text === 'string')
      .map(c => c.text);
    if (texts.length > 0) return texts.join('\n');
  } catch { /* not JSON, return as-is */ }
  return result;
}

// Legacy function for backward compatibility - now uses unified config
export function getToolColors(toolName: string): {
  text: string;
  icon: string;
} {
  const config = getToolBadgeConfig(toolName);
  return {
    text: config.colors.text,
    icon: config.colors.iconColor
  };
}

interface ToolHeaderProps {
  icon?: ReactNode;
  label?: string;
  toolName?: string;
  tool?: ToolUseSimple;
}

export function ToolHeader({ icon, label, toolName, tool }: ToolHeaderProps) {
  const config = toolName ? getToolBadgeConfig(toolName) : null;
  // Always use icon from unified config if toolName is provided (single source of truth)
  // Otherwise fall back to passed icon for backward compatibility
  let displayIcon = config?.icon || icon;

  // If using config icon (size-2.5), resize it to size-3 for header visibility
  // This ensures icons match between badge and header while maintaining readability
  if (config?.icon && isValidElement(displayIcon)) {
    const element = displayIcon as React.ReactElement<{ className?: string }>;
    const existingProps = element.props as { className?: string };
    const existingClassName = existingProps?.className || '';
    // Replace size-2.5 with size-3, or add size-3 if no size class exists
    const newClassName =
      existingClassName ? existingClassName.replace(/size-\d+(\.\d+)?/g, 'size-3') : 'size-3';
    displayIcon = cloneElement(element, {
      ...existingProps,
      className: newClassName
    });
  }

  // Use unified expanded label if tool is provided, otherwise use passed label or toolName
  const displayLabel = tool ? getToolExpandedLabel(tool) : label || toolName || '';

  return (
    <div
      className={`flex items-center gap-1.5 text-sm font-medium ${config?.colors.text || 'text-[var(--ink-muted)]'}`}
    >
      {displayIcon && (
        <span
          className={`flex h-4 w-4 items-center justify-center ${config?.colors.iconColor || 'text-[var(--ink-muted)]'}`}
        >
          {displayIcon}
        </span>
      )}
      <span className="tracking-tight">{displayLabel}</span>
    </div>
  );
}

export function MonoText({
  children,
  className = ''
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <code
      className={`font-mono text-sm tracking-tight text-[var(--ink)] ${className}`}
    >
      {children}
    </code>
  );
}

export function FilePath({ path }: { path: string }) {
  return (
    <MonoText className="rounded border border-[var(--line-subtle)] bg-[var(--paper-inset)]/50 px-1.5 py-0.5">
      {path}
    </MonoText>
  );
}

export function InlineCode({ children }: { children: ReactNode }) {
  return (
    <MonoText className="rounded border border-[var(--line-subtle)] bg-[var(--paper-inset)]/50 px-1.5 py-0.5">
      {children}
    </MonoText>
  );
}

/**
 * Unwrap SDK tool result JSON wrappers into displayable plain text.
 *
 * The SDK wraps tool results in JSON with metadata:
 *   Bash:  {"stdout":"...","stderr":"...","interrupted":false}
 *   Read:  {"type":"text","file":{"filePath":"...","content":"..."}}
 *   Grep:  {"mode":"content","numFiles":0,"filenames":[],"content":"1142:function..."}
 *   Glob:  {"mode":"files_with_matches","filenames":["a.ts","b.ts"],"content":"a.ts\nb.ts"}
 *
 * This extracts the meaningful text and unescapes \n so it renders properly.
 * Falls back to the original string if it's not recognized JSON.
 */
export function unwrapSdkResult(result: string): string {
  const trimmed = result.trimStart();
  if (!trimmed.startsWith('{')) return result;
  try {
    const parsed = JSON.parse(trimmed);

    // Bash format: {"stdout":"...","stderr":"..."}
    if ('stdout' in parsed && typeof parsed.stdout === 'string') {
      let output = parsed.stdout;
      if (parsed.stderr && typeof parsed.stderr === 'string') {
        output += (output ? '\n\n' : '') + '[stderr]\n' + parsed.stderr;
      }
      return output || '(no output)';
    }

    // Read format: {"type":"text","file":{"filePath":"...","content":"..."}}
    if (parsed.type === 'text' && parsed.file?.content && typeof parsed.file.content === 'string') {
      return parsed.file.content;
    }

    // Grep/Glob format: {"mode":"...","content":"..."}
    if ('content' in parsed && typeof parsed.content === 'string') {
      return parsed.content;
    }

    // Unknown JSON — return as-is (let specialized components handle it)
    return result;
  } catch {
    return result;
  }
}

/**
 * Expandable result container with max-h-96 + gradient fade + "展开全部" button.
 * Used by tool components to wrap long <pre> output.
 */
interface ExpandableResultProps {
  content: string;
  className?: string;
  /** Additional wrapper className (e.g. for terminal-style bg) */
  wrapperClassName?: string;
  /** Gradient fade color — must match the actual background for smooth fade.
   *  Defaults to paper-inset; BashTool passes code-bg or error-bg. */
  gradientFrom?: string;
}

export function ExpandableResult({ content: rawContent, className = '', wrapperClassName = '', gradientFrom = 'from-[var(--paper-inset)]' }: ExpandableResultProps) {
  // Auto-unwrap SDK JSON wrappers so all tools display clean text
  const content = unwrapSdkResult(rawContent);
  const [isResultExpanded, setIsResultExpanded] = useState(false);
  const resultRef = useRef<HTMLPreElement>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);

  useEffect(() => {
    if (resultRef.current) {
      setIsOverflowing(resultRef.current.scrollHeight > resultRef.current.clientHeight);
    }
  }, [content]);

  return (
    <div className={`relative ${wrapperClassName}`}>
      <pre
        ref={resultRef}
        className={`overflow-x-auto font-mono text-sm whitespace-pre-wrap select-text ${isResultExpanded ? '' : 'max-h-96'} overflow-hidden ${className}`}
      >
        {content}
      </pre>
      {isOverflowing && !isResultExpanded && (
        <div className={`absolute bottom-0 left-0 right-0 flex justify-center bg-gradient-to-t ${gradientFrom} to-transparent pb-2 pt-8`}>
          <button
            type="button"
            onClick={() => setIsResultExpanded(true)}
            className="rounded-full border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-1 text-xs text-[var(--ink-muted)] shadow-sm hover:text-[var(--ink-secondary)] transition-colors"
          >
            展开全部
          </button>
        </div>
      )}
    </div>
  );
}

interface ThinkingHeaderProps {
  isComplete: boolean;
  durationMs?: number;
}

export function ThinkingHeader({ isComplete, durationMs }: ThinkingHeaderProps) {
  const config = getThinkingBadgeConfig();
  const label = getThinkingExpandedLabel(isComplete, durationMs);

  // Resize icon from size-2.5 to size-3 for header visibility
  let displayIcon = config.icon;
  if (isValidElement(displayIcon)) {
    const element = displayIcon as React.ReactElement<{ className?: string }>;
    const existingProps = element.props as { className?: string };
    const existingClassName = existingProps?.className || '';
    const newClassName =
      existingClassName ? existingClassName.replace(/size-\d+(\.\d+)?/g, 'size-3') : 'size-3';
    displayIcon = cloneElement(element, {
      ...existingProps,
      className: newClassName
    });
  }

  return (
    <div className={`flex items-center gap-1.5 text-sm font-medium ${config.colors.text}`}>
      {displayIcon && (
        <span className={`flex h-4 w-4 items-center justify-center ${config.colors.iconColor}`}>
          {displayIcon}
        </span>
      )}
      <span className="tracking-wide">{label}</span>
    </div>
  );
}
