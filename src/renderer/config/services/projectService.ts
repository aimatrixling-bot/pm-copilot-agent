// Project management — CRUD, touch, sort
import { join, basename } from '@tauri-apps/api/path';

import type { Project } from '../types';
import {
    isBrowserDevMode,
    withProjectsLock,
    ensureConfigDir,
    getConfigDir,
    PROJECTS_FILE,
    safeLoadJson,
    safeWriteJson,
} from './configStore';
import {
    mockLoadProjects,
    mockSaveProjects,
    mockAddProject,
} from '@/utils/browserMock';

// ============= Helpers =============

function sortProjectsByLastOpened(projects: Project[]): Project[] {
    return [...projects].sort((a, b) => {
        const timeA = a.lastOpened ? new Date(a.lastOpened).getTime() : 0;
        const timeB = b.lastOpened ? new Date(b.lastOpened).getTime() : 0;
        return timeB - timeA;
    });
}

function isValidProjectsArray(data: unknown): data is Project[] {
    return Array.isArray(data) && data.every(
        (item) => item && typeof item === 'object' && 'id' in item && 'name' in item && 'path' in item,
    );
}

// ============= CRUD =============

export async function loadProjects(): Promise<Project[]> {
    if (isBrowserDevMode()) {
        console.log('[configService] Browser mode: loading projects from localStorage');
        const projects = mockLoadProjects();
        return sortProjectsByLastOpened(projects);
    }

    try {
        await ensureConfigDir();
        const dir = await getConfigDir();
        const projectsPath = await join(dir, PROJECTS_FILE);

        const projects = await safeLoadJson<Project[]>(projectsPath, isValidProjectsArray);
        if (projects) {
            return sortProjectsByLastOpened(projects);
        }
        console.log('[configService] No valid projects file found, returning empty array');
        return [];
    } catch (error) {
        console.error('[configService] Failed to load projects:', error);
        return [];
    }
}

export async function saveProjects(projects: Project[]): Promise<void> {
    if (isBrowserDevMode()) {
        mockSaveProjects(projects);
        return;
    }

    try {
        await ensureConfigDir();
        const dir = await getConfigDir();
        const projectsPath = await join(dir, PROJECTS_FILE);
        await safeWriteJson(projectsPath, projects);
        console.log('[configService] Projects saved successfully');
    } catch (error) {
        console.error('[configService] Failed to save projects:', error);
        throw error;
    }
}

export async function addProject(path: string): Promise<Project> {
    console.log('[configService] addProject called with path:', path);

    if (isBrowserDevMode()) {
        console.log('[configService] Browser mode: using mock addProject');
        return mockAddProject(path);
    }

    return withProjectsLock(async () => {
        const projects = await loadProjects();

        const existing = projects.find((p) => p.path === path);
        if (existing) {
            console.log('[configService] Project already exists, updating lastOpened');
            existing.lastOpened = new Date().toISOString();
            if (existing.name && (existing.name.includes('/') || existing.name.includes('\\'))) {
                const parts = existing.name.replace(/\\/g, '/').split('/').filter(Boolean);
                existing.name = parts[parts.length - 1] || existing.name;
                console.log('[configService] Fixed project name from path to:', existing.name);
            }
            await saveProjects(projects);
            return existing;
        }

        let name: string;
        try {
            name = await basename(path);
            if (!name || name.trim().length === 0) {
                throw new Error('Empty basename result');
            }
        } catch (err) {
            console.warn('[configService] basename() failed, using fallback:', err);
            const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
            name = parts[parts.length - 1] || 'Unknown';
        }

        const newProject: Project = {
            id: crypto.randomUUID(),
            name,
            path,
            lastOpened: new Date().toISOString(),
            providerId: null,
            permissionMode: null,
        };

        console.log('[configService] Creating new project:', newProject);
        projects.push(newProject);
        await saveProjects(projects);
        return newProject;
    });
}

export async function updateProject(project: Project): Promise<void> {
    return withProjectsLock(async () => {
        const projects = await loadProjects();
        const index = projects.findIndex((p) => p.id === project.id);
        if (index >= 0) {
            projects[index] = project;
            await saveProjects(projects);
        }
    });
}

export async function patchProject(projectId: string, updates: Partial<Omit<Project, 'id'>>): Promise<Project | null> {
    return withProjectsLock(async () => {
        const projects = await loadProjects();
        const index = projects.findIndex((p) => p.id === projectId);
        if (index >= 0) {
            projects[index] = { ...projects[index], ...updates };
            await saveProjects(projects);
            return projects[index];
        }
        return null;
    });
}

export async function removeProject(projectId: string): Promise<void> {
    return withProjectsLock(async () => {
        const projects = await loadProjects();
        const filtered = projects.filter((p) => p.id !== projectId);
        await saveProjects(filtered);
    });
}

export async function touchProject(projectId: string): Promise<Project | null> {
    return withProjectsLock(async () => {
        const projects = await loadProjects();
        const index = projects.findIndex((p) => p.id === projectId);
        if (index < 0) {
            console.warn('[configService] touchProject: project not found:', projectId);
            return null;
        }

        const updatedProject = {
            ...projects[index],
            lastOpened: new Date().toISOString(),
        };
        projects[index] = updatedProject;
        await saveProjects(projects);
        console.log('[configService] Project touched:', projectId);
        return updatedProject;
    });
}
