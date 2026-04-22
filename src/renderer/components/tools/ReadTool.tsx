import type { ReadInput, ToolUseSimple } from '@/types/chat';

import { CollapsibleTool } from './CollapsibleTool';
import { ExpandableResult, FilePath, ToolHeader } from './utils';

interface ReadToolProps {
  tool: ToolUseSimple;
}

export default function ReadTool({ tool }: ReadToolProps) {
  const input = tool.parsedInput as ReadInput;

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
      <FilePath path={input.file_path} />
      {input.offset !== undefined && (
        <span className="rounded border border-[var(--line-subtle)] bg-[var(--paper-inset)]/50 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-[var(--ink-muted)] uppercase">
          offset {input.offset}
        </span>
      )}
      {input.limit !== undefined && (
        <span className="rounded border border-[var(--line-subtle)] bg-[var(--paper-inset)]/50 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-[var(--ink-muted)] uppercase">
          limit {input.limit}
        </span>
      )}
    </div>
  );

  // ExpandableResult internally calls unwrapSdkResult() to extract file content from SDK JSON
  const expandedContent = tool.result ? (
    <ExpandableResult
      content={tool.result}
      className="rounded bg-[var(--paper-inset)]/50 px-2 py-1 wrap-break-word text-[var(--ink-secondary)]"
    />
  ) : null;

  return <CollapsibleTool collapsedContent={collapsedContent} expandedContent={expandedContent} />;
}
