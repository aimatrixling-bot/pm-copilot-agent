// Template management — load, save, add user templates
import { join } from '@tauri-apps/api/path';

import type { WorkspaceTemplate } from '../types';
import {
    isBrowserDevMode,
    ensureConfigDir,
    getConfigDir,
    safeLoadJson,
    safeWriteJson,
    createAsyncLock,
} from './configStore';

const TEMPLATES_FILE = 'templates.json';
const withTemplatesLock = createAsyncLock();

// ============= Helpers =============

function isValidTemplatesArray(data: unknown): data is WorkspaceTemplate[] {
    return Array.isArray(data) && data.every(
        (item) => item && typeof item === 'object' && 'id' in item && 'name' in item,
    );
}

// ============= CRUD =============

/** Load user-defined templates from ~/.pm-copilot/templates.json */
export async function loadUserTemplates(): Promise<WorkspaceTemplate[]> {
    if (isBrowserDevMode()) return [];

    try {
        await ensureConfigDir();
        const dir = await getConfigDir();
        const filePath = await join(dir, TEMPLATES_FILE);
        const templates = await safeLoadJson<WorkspaceTemplate[]>(filePath, isValidTemplatesArray);
        return templates ?? [];
    } catch (error) {
        console.error('[templateService] Failed to load user templates:', error);
        return [];
    }
}

/** Save user-defined templates to disk */
async function saveUserTemplates(templates: WorkspaceTemplate[]): Promise<void> {
    if (isBrowserDevMode()) return;

    try {
        await ensureConfigDir();
        const dir = await getConfigDir();
        const filePath = await join(dir, TEMPLATES_FILE);
        await safeWriteJson(filePath, templates);
    } catch (error) {
        console.error('[templateService] Failed to save user templates:', error);
        throw error;
    }
}

/** Add a user template (metadata only — folder copy is done via Rust command) */
export async function addUserTemplate(template: Omit<WorkspaceTemplate, 'isBuiltin'>): Promise<WorkspaceTemplate> {
    return withTemplatesLock(async () => {
        const templates = await loadUserTemplates();

        // Check for ID collision
        const existing = templates.findIndex(t => t.id === template.id);
        const newTemplate: WorkspaceTemplate = { ...template, isBuiltin: false };

        if (existing >= 0) {
            templates[existing] = newTemplate;
        } else {
            templates.push(newTemplate);
        }

        await saveUserTemplates(templates);
        return newTemplate;
    });
}

/** Remove a user template (metadata only — folder deletion is separate) */
export async function removeUserTemplate(templateId: string): Promise<void> {
    return withTemplatesLock(async () => {
        const templates = await loadUserTemplates();
        const filtered = templates.filter(t => t.id !== templateId);
        await saveUserTemplates(filtered);
    });
}

/** Update a user template's metadata */
export async function updateUserTemplate(
    templateId: string,
    updates: Partial<Pick<WorkspaceTemplate, 'name' | 'description' | 'icon'>>,
): Promise<void> {
    return withTemplatesLock(async () => {
        const templates = await loadUserTemplates();
        const index = templates.findIndex(t => t.id === templateId);
        if (index >= 0) {
            templates[index] = { ...templates[index], ...updates };
            await saveUserTemplates(templates);
        }
    });
}
