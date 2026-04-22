import type { ToolUseSimple } from '@/types/chat';

import { CollapsibleTool } from './CollapsibleTool';
import { ExpandableResult, ToolHeader } from './utils';

interface SkillToolProps {
  tool: ToolUseSimple;
}

export default function SkillTool({ tool }: SkillToolProps) {
  const collapsedContent = <ToolHeader tool={tool} toolName={tool.name} />;

  const expandedContent =
    tool.result ?
      <ExpandableResult
        content={tool.result}
        className="rounded bg-[var(--paper-inset)]/50 px-2 py-1 wrap-break-word text-[var(--ink-secondary)]"
      />
    : null;

  return <CollapsibleTool collapsedContent={collapsedContent} expandedContent={expandedContent} />;
}
