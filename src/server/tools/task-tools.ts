/**
 * Task Management MCP Tools — persistent task graph for PM Copilot.
 *
 * Exposes 4 tools to the Claude Agent SDK:
 *   - task_create: Create a new task
 *   - task_update: Update task status/details
 *   - task_list: List tasks with optional filters
 *   - task_get: Get a specific task by ID
 *
 * Storage: ~/.pm-copilot/tasks/task-{id}.json (file-persisted)
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';
import {
  createTask,
  getTask,
  updateTask,
  listTasks,
  resolveBlockedBy,
  type TaskStatus,
} from '../task-manager';

// MCP Tool Result type
type CallToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

// ===== Handlers =====

async function handleTaskCreate(args: {
  subject: string;
  description?: string;
  skill?: string;
  blockedBy?: string[];
}): Promise<CallToolResult> {
  const task = createTask({
    subject: args.subject,
    description: args.description,
    skill: args.skill,
    blockedBy: args.blockedBy,
  });
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ success: true, task }, null, 2),
    }],
  };
}

async function handleTaskUpdate(args: {
  id: string;
  subject?: string;
  description?: string;
  status?: string;
  addBlockedBy?: string[];
  removeBlockedBy?: string[];
  addArtifacts?: string[];
}): Promise<CallToolResult> {
  // Auto-resolve blockedBy when completing a task
  if (args.status === 'completed') {
    const task = updateTask(args.id, {
      subject: args.subject,
      description: args.description,
      status: args.status as TaskStatus,
      addBlockedBy: args.addBlockedBy,
      removeBlockedBy: args.removeBlockedBy,
      addArtifacts: args.addArtifacts,
    });
    if (!task) {
      return {
        content: [{ type: 'text', text: `Error: Task ${args.id} not found` }],
        isError: true,
      };
    }
    // Resolve any tasks that were blocked by this one
    const allTasks = listTasks({ status: 'blocked' });
    const unblocked: string[] = [];
    for (const t of allTasks) {
      if (t.blockedBy.includes(args.id)) {
        const resolved = resolveBlockedBy(t.id);
        if (resolved && resolved.status === 'pending') {
          unblocked.push(t.id);
        }
      }
    }
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          task,
          unblockedTasks: unblocked.length > 0 ? unblocked : undefined,
        }, null, 2),
      }],
    };
  }

  const task = updateTask(args.id, {
    subject: args.subject,
    description: args.description,
    status: args.status as TaskStatus | undefined,
    addBlockedBy: args.addBlockedBy,
    removeBlockedBy: args.removeBlockedBy,
    addArtifacts: args.addArtifacts,
  });
  if (!task) {
    return {
      content: [{ type: 'text', text: `Error: Task ${args.id} not found` }],
      isError: true,
    };
  }
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ success: true, task }, null, 2),
    }],
  };
}

async function handleTaskList(args: {
  status?: string;
  skill?: string;
}): Promise<CallToolResult> {
  const tasks = listTasks({
    status: args.status as TaskStatus | undefined,
    skill: args.skill,
  });
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ success: true, count: tasks.length, tasks }, null, 2),
    }],
  };
}

async function handleTaskGet(args: { id: string }): Promise<CallToolResult> {
  const task = getTask(args.id);
  if (!task) {
    return {
      content: [{ type: 'text', text: `Error: Task ${args.id} not found` }],
      isError: true,
    };
  }
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ success: true, task }, null, 2),
    }],
  };
}

// ===== MCP Server =====

export function createTaskToolsServer() {
  return createSdkMcpServer({
    name: 'task-tools',
    version: '1.0.0',
    tools: [
      tool(
        'task_create',
        `Create a new persistent task. Tasks survive across sessions and support dependency chains via blockedBy.

Use this when:
- Starting a multi-step PM workflow (PRD → Tech Spec → Eng Request)
- Tracking work that spans multiple conversations
- Setting up task dependencies (task B blocked until task A completes)`,
        {
          subject: z.string().min(1).max(200).describe('Brief task title'),
          description: z.string().max(2000).optional().describe('Detailed description of what needs to be done'),
          skill: z.string().optional().describe('Associated PM Skill name (e.g., pm-prd, pm-comp)'),
          blockedBy: z.array(z.string()).optional().describe('Task IDs that must complete before this task can start'),
        },
        handleTaskCreate,
      ),
      tool(
        'task_update',
        `Update an existing task's status, details, or dependencies.

When marking a task as completed, any tasks blocked solely by this one are automatically unblocked.`,
        {
          id: z.string().describe('Task ID to update'),
          subject: z.string().min(1).max(200).optional().describe('New subject'),
          description: z.string().max(2000).optional().describe('New description'),
          status: z.enum(['pending', 'in_progress', 'completed', 'blocked']).optional().describe('New status'),
          addBlockedBy: z.array(z.string()).optional().describe('Task IDs to add as dependencies'),
          removeBlockedBy: z.array(z.string()).optional().describe('Task IDs to remove from dependencies'),
          addArtifacts: z.array(z.string()).optional().describe('File paths of produced artifacts to record'),
        },
        handleTaskUpdate,
      ),
      tool(
        'task_list',
        `List all tasks with optional filters. Returns tasks sorted by creation date (newest first).`,
        {
          status: z.enum(['pending', 'in_progress', 'completed', 'blocked']).optional().describe('Filter by status'),
          skill: z.string().optional().describe('Filter by associated PM Skill'),
        },
        handleTaskList,
      ),
      tool(
        'task_get',
        `Get full details of a specific task by ID, including its dependencies and artifacts.`,
        {
          id: z.string().describe('Task ID'),
        },
        handleTaskGet,
      ),
    ],
  });
}

export const taskToolsServer = createTaskToolsServer();
