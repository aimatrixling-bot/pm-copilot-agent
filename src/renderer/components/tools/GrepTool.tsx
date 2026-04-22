import type { GrepInput, ToolUseSimple } from '@/types/chat';

import { CollapsibleTool } from './CollapsibleTool';
import { ExpandableResult, InlineCode, ToolHeader } from './utils';

interface GrepToolProps {
  tool: ToolUseSimple;
}

export default function GrepTool({ tool }: GrepToolProps) {
  const input = tool.parsedInput as GrepInput;

  if (!input) {
    return (
      <div className="my-0.5">
        <ToolHeader tool={tool} toolName={tool.name} />
      </div>
    );
  }

  const collapsedContent = (
    <div className="flex flex-wrap items-center gap-1.5">
      <ToolHeader tool={tool} toolName={tool.name} />
      <InlineCode>{input.pattern}</InlineCode>
      {input.path && (
        <span className="text-[10px] text-[var(--ink-muted)]">in {input.path}</span>
      )}
    </div>
  );

  const expandedContent =
    tool.result ?
      <ExpandableResult
        content={tool.result}
        className="rounded bg-[var(--paper-inset)]/50 px-2 py-1 wrap-break-word text-[var(--ink-secondary)]"
      />
    : null;

  return <CollapsibleTool collapsedContent={collapsedContent} expandedContent={expandedContent} />;
}
