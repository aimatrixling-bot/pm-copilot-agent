/**
 * Widget Tag Parser — Extracts <generative-ui-widget> tags from streaming text.
 *
 * Splits text content into segments: plain text and widget blocks.
 * Used by Message.tsx to render widgets inline with Markdown content.
 *
 * Handles:
 * - Complete widgets: <generative-ui-widget title="xxx">HTML</generative-ui-widget>
 * - Partial/streaming widgets: <generative-ui-widget title="xxx">partial HTML...
 * - Multiple widgets in a single text block
 * - Text before, between, and after widgets
 * - Tags inside code fences are ignored (not treated as real widgets)
 * - Single or double quotes for title attribute
 * - Extra attributes on the tag (ignored, only title extracted)
 */

export interface WidgetSegment {
  type: 'widget';
  title: string;
  code: string;
  isComplete: boolean;
}

export interface TextSegment {
  type: 'text';
  content: string;
}

export type Segment = TextSegment | WidgetSegment;

// Tag name used for widget output — unique enough to avoid accidental collisions
const TAG_NAME = 'generative-ui-widget';

// Match opening tag: <generative-ui-widget> or <generative-ui-widget title="xxx">
// Title is optional — captured if present (group 1), empty string if absent
const WIDGET_OPEN_RE = new RegExp(
  `<${TAG_NAME}(?:\\s+[^>]*?title\\s*=\\s*["']([^"']+)["'][^>]*|\\s*)>`, 'i'
);
// Match closing tag
const WIDGET_CLOSE_STR = `</${TAG_NAME}>`;

/**
 * Strip code fences (``` blocks) from text before scanning for widget tags.
 * Returns text with code fence contents replaced by placeholder.
 * This prevents false-positive widget tag detection inside code examples.
 */
function maskCodeFences(text: string): { masked: string; fences: Array<{ start: number; end: number }> } {
  const fences: Array<{ start: number; end: number }> = [];
  const masked = text.replace(/```[\s\S]*?```/g, (match, offset: number) => {
    fences.push({ start: offset, end: offset + match.length });
    return '\x00'.repeat(match.length); // Same-length placeholder preserves indices
  });
  return { masked, fences };
}

/**
 * Parse text into segments of plain text and widget blocks.
 * Supports streaming: if text ends mid-widget (no closing tag), returns
 * the widget with isComplete=false.
 * Tags inside code fences (```) are ignored.
 */
export function parseWidgetTags(text: string): Segment[] {
  const { masked } = maskCodeFences(text);
  const segments: Segment[] = [];
  let remaining = text;
  let maskedRemaining = masked;

  while (remaining.length > 0) {
    // Search in masked text (code fences replaced) to avoid false positives
    const openMatch = WIDGET_OPEN_RE.exec(maskedRemaining);

    if (!openMatch) {
      if (remaining.trim()) {
        segments.push({ type: 'text', content: remaining });
      }
      break;
    }

    // Text before the widget tag
    const textBefore = remaining.slice(0, openMatch.index);
    if (textBefore.trim()) {
      segments.push({ type: 'text', content: textBefore });
    }

    const title = openMatch[1] || '';
    const afterOpenIdx = openMatch.index + openMatch[0].length;
    const afterOpen = remaining.slice(afterOpenIdx);

    // Look for closing tag — use lastIndexOf for robustness
    // (prevents premature close if widget HTML contains the closing tag string in JS/comments)
    const closeLower = afterOpen.toLowerCase();
    const closeStr = WIDGET_CLOSE_STR.toLowerCase();
    const closeIdx = closeLower.lastIndexOf(closeStr);

    if (closeIdx !== -1) {
      const widgetCode = afterOpen.slice(0, closeIdx);
      segments.push({
        type: 'widget',
        title,
        code: widgetCode,
        isComplete: true,
      });
      const afterClose = afterOpenIdx + closeIdx + WIDGET_CLOSE_STR.length;
      remaining = remaining.slice(afterClose);
      maskedRemaining = masked.slice(afterClose);
    } else {
      // Partial widget (still streaming)
      segments.push({
        type: 'widget',
        title,
        code: afterOpen,
        isComplete: false,
      });
      break;
    }
  }

  return segments;
}

/**
 * Quick check: does the text contain any widget tags (outside code fences)?
 */
export function hasWidgetTags(text: string): boolean {
  const { masked } = maskCodeFences(text);
  return WIDGET_OPEN_RE.test(masked);
}
