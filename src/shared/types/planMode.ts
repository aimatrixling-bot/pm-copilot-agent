/**
 * PlanMode types - shared between frontend and backend
 * For ExitPlanMode and EnterPlanMode SDK tool interception
 */

export interface ExitPlanModeAllowedPrompt {
  tool: 'Bash';
  prompt: string;
}

export interface ExitPlanModeRequest {
  requestId: string;
  plan?: string;
  allowedPrompts?: ExitPlanModeAllowedPrompt[];
  resolved?: 'approved' | 'rejected';
}

export interface EnterPlanModeRequest {
  requestId: string;
  resolved?: 'approved' | 'rejected';
  autoApproved?: boolean; // SDK auto-allowed EnterPlanMode (no user confirmation needed)
}
