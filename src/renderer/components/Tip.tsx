/** Lightweight CSS-only tooltip — appears instantly on hover, no JS timers.
 *  `position="top"` (default) shows above; `position="bottom"` shows below.
 *  `align="center"` (default) centers; `"end"` aligns to the right edge. */
export default function Tip({ label, children, position = 'top', align = 'center' }: { label: string; children: React.ReactNode; position?: 'top' | 'bottom'; align?: 'center' | 'end' }) {
  const posClass = position === 'bottom'
    ? 'top-full mt-1.5'
    : 'bottom-full mb-1.5';
  const alignClass = align === 'end'
    ? 'right-0'
    : 'left-1/2 -translate-x-1/2';
  return (
    <span className="group/tip relative inline-flex">
      {children}
      <span className={`pointer-events-none absolute z-50 whitespace-nowrap rounded-md bg-[var(--button-dark-bg)]/90 px-2 py-1 text-[11px] text-[var(--button-primary-text)] opacity-0 transition-opacity group-hover/tip:opacity-100 ${posClass} ${alignClass}`}>
        {label}
      </span>
    </span>
  );
}
