/**
 * Shared utilities for logging system
 */

import { existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export const PM_COPILOT_DIR = join(homedir(), '.pm-copilot');
export const LOGS_DIR = join(PM_COPILOT_DIR, 'logs');
export const LOG_RETENTION_DAYS = 30;

/**
 * Ensure logs directory exists
 */
export function ensureLogsDir(): void {
  if (!existsSync(PM_COPILOT_DIR)) {
    mkdirSync(PM_COPILOT_DIR, { recursive: true });
  }
  if (!existsSync(LOGS_DIR)) {
    mkdirSync(LOGS_DIR, { recursive: true });
  }
}
