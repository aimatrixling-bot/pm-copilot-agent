// Image content block translation

import type { AnthropicImageBlock } from '../types/anthropic';
import type { OpenAIContentPart } from '../types/openai';

/** Anthropic image block → OpenAI image_url content part */
export function translateImageBlock(block: AnthropicImageBlock): OpenAIContentPart {
  if (block.source.type === 'url' && block.source.url) {
    return {
      type: 'image_url',
      image_url: { url: block.source.url },
    };
  }
  // base64 → data URI
  const mediaType = block.source.media_type || 'image/png';
  const data = block.source.data || '';
  return {
    type: 'image_url',
    image_url: { url: `data:${mediaType};base64,${data}` },
  };
}
