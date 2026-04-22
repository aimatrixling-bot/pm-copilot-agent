import { Clock, Play, X } from 'lucide-react';

import type { QueuedMessageInfo } from '@/types/queue';

interface QueuedMessagesPanelProps {
  messages: QueuedMessageInfo[];
  onCancel: (queueId: string) => void;
  onForceExecute: (queueId: string) => void;
}

/**
 * A single floating panel that displays all queued messages.
 * Right-aligned, semi-transparent background, compact layout.
 */
export default function QueuedMessagesPanel({ messages, onCancel, onForceExecute }: QueuedMessagesPanelProps) {
  if (messages.length === 0) return null;

  return (
    <div className="mb-2 flex justify-end">
      <div
        className="min-w-[120px] max-w-[33%] rounded-xl border border-[var(--line)] px-3 py-2 shadow-sm backdrop-blur-sm"
        style={{ backgroundColor: 'color-mix(in srgb, var(--paper) 88%, transparent)' }}
      >
        {/* Header */}
        <div className="mb-1.5 flex items-center gap-1 text-xs text-[var(--ink-muted)]">
          <Clock size={11} />
          <span>排队中 ({messages.length})</span>
        </div>

        {/* Message list */}
        <div className="space-y-1">
          {messages.map((qm) => (
            <div key={qm.queueId} className="group flex items-center gap-1.5">
              {/* Message text */}
              <div className="min-w-0 flex-1 truncate text-sm text-[var(--ink)]">
                {qm.text.length > 60 ? qm.text.slice(0, 60) + '...' : qm.text}
              </div>

              {/* Images indicator */}
              {qm.images && qm.images.length > 0 && (
                <div className="flex shrink-0 gap-0.5">
                  {qm.images.slice(0, 2).map((img) => (
                    <div key={img.id} className="h-5 w-5 overflow-hidden rounded border border-[var(--ink-muted)]/20">
                      <img src={img.preview} alt={img.name} className="h-full w-full object-cover" />
                    </div>
                  ))}
                </div>
              )}

              {/* Action buttons — visible on hover */}
              <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                <button
                  onClick={() => onForceExecute(qm.queueId)}
                  title="立即发送"
                  className="rounded p-0.5 text-[var(--ink-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--ink)]"
                >
                  <Play size={12} />
                </button>
                <button
                  onClick={() => onCancel(qm.queueId)}
                  title="取消排队"
                  className="rounded p-0.5 text-[var(--ink-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--ink)]"
                >
                  <X size={12} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
