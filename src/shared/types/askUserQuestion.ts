/**
 * AskUserQuestion types - shared between frontend and backend
 * Based on SDK's AskUserQuestionInput structure
 */

export interface AskUserQuestionOption {
  label: string;
  description: string;
  /** Optional preview content rendered when this option is focused (HTML or Markdown) */
  preview?: string;
}

export interface AskUserQuestion {
  question: string;
  header: string;
  options: AskUserQuestionOption[];
  multiSelect: boolean;
}

export interface AskUserQuestionInput {
  questions: AskUserQuestion[];
  answers?: Record<string, string>;
  metadata?: { source?: string };
}

/**
 * Request sent to frontend for user interaction
 */
export interface AskUserQuestionRequest {
  requestId: string;
  questions: AskUserQuestion[];
  /** Content format for option previews: 'html' or 'markdown' */
  previewFormat?: 'html' | 'markdown';
}
