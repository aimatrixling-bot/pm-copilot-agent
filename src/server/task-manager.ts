/**
 * Persistent Task Manager — file-based task graph with dependency edges.
 *
 * Storage: ~/.pm-copilot/tasks/task-{id}.json
 * Each task is a standalone JSON file. No central DB — the filesystem IS the database.
 *
 * Design inspired by learn-claude-code s07: file-persisted task graph.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { getPmCopilotUserDir } from './agent-session';

// ===== Types =====

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'blocked';

export interface Task {
  id: string;
  subject: string;
  description: string;
  status: TaskStatus;
  skill?: string;           // Associated PM Skill (e.g., 'pm-prd')
  blockedBy: string[];      // Task IDs that must complete before this one
  createdAt: string;         // ISO 8601
  updatedAt: string;         // ISO 8601
  completedAt?: string;      // ISO 8601
  artifacts: string[];       // File paths of produced artifacts
  context: {
    trigger?: string;        // What triggered this task
    sessionId?: string;      // Session that created it
  };
}

export interface TaskCreateInput {
  subject: string;
  description?: string;
  skill?: string;
  blockedBy?: string[];
  context?: Task['context'];
}

export interface TaskUpdateInput {
  subject?: string;
  description?: string;
  status?: TaskStatus;
  addBlockedBy?: string[];
  removeBlockedBy?: string[];
  addArtifacts?: string[];
}

// ===== Storage =====

function getTasksDir(): string {
  const dir = join(getPmCopilotUserDir(), 'tasks');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function taskPath(id: string): string {
  return join(getTasksDir(), `task-${id}.json`);
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ===== CRUD =====

export function createTask(input: TaskCreateInput): Task {
  const id = generateId();
  const now = new Date().toISOString();
  const task: Task = {
    id,
    subject: input.subject,
    description: input.description ?? '',
    status: input.blockedBy && input.blockedBy.length > 0 ? 'blocked' : 'pending',
    skill: input.skill,
    blockedBy: input.blockedBy ?? [],
    createdAt: now,
    updatedAt: now,
    artifacts: [],
    context: input.context ?? {},
  };
  writeFileSync(taskPath(id), JSON.stringify(task, null, 2));
  console.log(`[task-manager] created: ${id} "${task.subject}"`);
  return task;
}

export function getTask(id: string): Task | null {
  const p = taskPath(id);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf-8')) as Task;
}

export function updateTask(id: string, input: TaskUpdateInput): Task | null {
  const task = getTask(id);
  if (!task) return null;

  if (input.subject !== undefined) task.subject = input.subject;
  if (input.description !== undefined) task.description = input.description;
  if (input.status !== undefined) {
    task.status = input.status;
    if (input.status === 'completed') {
      task.completedAt = new Date().toISOString();
    }
  }
  if (input.addBlockedBy) {
    for (const dep of input.addBlockedBy) {
      if (!task.blockedBy.includes(dep)) task.blockedBy.push(dep);
    }
    if (task.blockedBy.length > 0 && task.status === 'pending') {
      task.status = 'blocked';
    }
  }
  if (input.removeBlockedBy) {
    task.blockedBy = task.blockedBy.filter(d => !input.removeBlockedBy!.includes(d));
    if (task.blockedBy.length === 0 && task.status === 'blocked') {
      task.status = 'pending';
    }
  }
  if (input.addArtifacts) {
    for (const a of input.addArtifacts) {
      if (!task.artifacts.includes(a)) task.artifacts.push(a);
    }
  }

  task.updatedAt = new Date().toISOString();
  writeFileSync(taskPath(id), JSON.stringify(task, null, 2));
  console.log(`[task-manager] updated: ${id} status=${task.status}`);
  return task;
}

export function deleteTask(id: string): boolean {
  const p = taskPath(id);
  if (!existsSync(p)) return false;
  unlinkSync(p);
  // Remove this task from other tasks' blockedBy lists
  for (const other of listTasks()) {
    if (other.blockedBy.includes(id)) {
      updateTask(other.id, { removeBlockedBy: [id] });
    }
  }
  console.log(`[task-manager] deleted: ${id}`);
  return true;
}

export function listTasks(filter?: { status?: TaskStatus; skill?: string }): Task[] {
  const dir = getTasksDir();
  const files = readdirSync(dir).filter(f => f.startsWith('task-') && f.endsWith('.json'));
  const tasks: Task[] = [];
  for (const f of files) {
    try {
      const task = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as Task;
      if (filter?.status && task.status !== filter.status) continue;
      if (filter?.skill && task.skill !== filter.skill) continue;
      tasks.push(task);
    } catch {
      // Skip corrupted files
    }
  }
  tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return tasks;
}

/**
 * Check if all blocking dependencies of a task are completed.
 * If so, auto-transition from 'blocked' to 'pending'.
 */
export function resolveBlockedBy(id: string): Task | null {
  const task = getTask(id);
  if (!task || task.status !== 'blocked') return task;

  const unresolved = task.blockedBy.filter(depId => {
    const dep = getTask(depId);
    return !dep || dep.status !== 'completed';
  });

  if (unresolved.length === 0) {
    return updateTask(id, { status: 'pending', removeBlockedBy: task.blockedBy });
  }
  return task;
}
