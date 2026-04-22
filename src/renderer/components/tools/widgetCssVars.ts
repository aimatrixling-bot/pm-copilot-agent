/**
 * CSS variable bridge for Generative UI widgets.
 *
 * Sandbox iframes cannot inherit parent CSS variables, so we compute
 * the current theme values and inject them into the iframe's :root.
 * Widget code uses --widget-* variables that map to PM Copilot design tokens.
 *
 * Covers: text, background, border, accent, semantic, radius.
 * Supports light/dark mode detection from the parent page.
 */

export function buildWidgetCssVars(): string {
  const style = getComputedStyle(document.documentElement);
  const get = (name: string) => style.getPropertyValue(name).trim();

  // Detect dark mode from parent page (html[data-theme="dark"] or prefers-color-scheme)
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark'
    || document.documentElement.classList.contains('dark');

  return `:root {
  /* Text */
  --widget-text: ${get('--ink')};
  --widget-text-secondary: ${get('--ink-muted')};
  --widget-text-muted: ${get('--ink-subtle')};

  /* Backgrounds */
  --widget-bg: transparent;
  --widget-bg-elevated: ${get('--paper-elevated')};
  --widget-bg-inset: ${get('--paper-inset')};

  /* Borders */
  --widget-border: ${get('--line')};
  --widget-border-strong: ${get('--line-strong')};

  /* Accent */
  --widget-accent: ${get('--accent')};
  --widget-accent-hover: ${get('--accent-warm-hover')};
  --widget-accent-subtle: ${get('--accent-warm-subtle')};

  /* Semantic */
  --widget-success: ${get('--success')};
  --widget-success-bg: ${get('--success-bg')};
  --widget-error: ${get('--error')};
  --widget-error-bg: ${get('--error-bg')};
  --widget-warning: ${get('--warning')};
  --widget-warning-bg: ${get('--warning-bg')};
  --widget-info: ${get('--info')};
  --widget-info-bg: ${get('--info-bg')};

  /* Layout */
  --widget-radius: 10px;

  color-scheme: ${isDark ? 'dark' : 'light'};
}`;
}
