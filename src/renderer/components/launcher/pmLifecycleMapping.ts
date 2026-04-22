/**
 * pmLifecycleMapping — PM Skill to lifecycle stage mapping
 * Pure data: categorizes 27 PM Skills by PM Main Loop stages
 */

import {
    CircleDot, GitBranch, FileText, Search, Users, Kanban,
    Monitor, CheckSquare, Shield, Rocket, TrendingUp, RotateCcw,
    Workflow,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface LifecycleStage {
    id: string;
    label: string;
    icon: LucideIcon;
    skillNames: string[];
}

/**
 * PM Main Loop lifecycle stages — ordered by workflow progression
 */
export const LIFECYCLE_STAGES: readonly LifecycleStage[] = [
    { id: 'problem',    label: '问题定义',   icon: CircleDot,  skillNames: ['pm-problem-frame'] },
    { id: 'decision',   label: '决策分析',   icon: GitBranch,  skillNames: ['pm-rice', 'pm-decision'] },
    { id: 'spec',       label: '产品规格',   icon: FileText,   skillNames: ['pm-prd', 'pm-tech-spec', 'pm-solution-brief', 'pm-eng-request'] },
    { id: 'research',   label: '市场研究',   icon: Search,     skillNames: ['pm-comp', 'pm-ai-patterns', 'pm-strategy-session'] },
    { id: 'persona',    label: '用户画像',   icon: Users,      skillNames: ['pm-persona'] },
    { id: 'planning',   label: '迭代规划',   icon: Kanban,     skillNames: ['pm-roadmap', 'pm-backlog'] },
    { id: 'prototype',  label: '原型设计',   icon: Monitor,    skillNames: ['pm-prototype', 'pm-wireframe'] },
    { id: 'validation', label: '验证测试',   icon: CheckSquare,skillNames: ['pm-experiment', 'pm-metrics', 'pm-testing'] },
    { id: 'quality',    label: '质量审查',   icon: Shield,     skillNames: ['pm-critique'] },
    { id: 'delivery',   label: '交付上线',   icon: Rocket,     skillNames: ['pm-launch', 'pm-sync'] },
    { id: 'growth',     label: '增长探索',   icon: TrendingUp, skillNames: ['pm-ost', 'pm-job-search'] },
    { id: 'retro',      label: '复盘回顾',   icon: RotateCcw,  skillNames: ['pm-retro'] },
    { id: 'workflow',   label: '端到端工作流', icon: Workflow,  skillNames: ['pm-discovery', 'pm-feature-cycle', 'pm-writer-pipeline'] },
] as const;

/**
 * Quick-access skills shown as chips below the browse button
 */
export const QUICK_ACCESS_SKILLS: readonly string[] = [
    'pm-prd',
    'pm-comp',
    'pm-prototype',
    'pm-backlog',
    'pm-sync',
] as const;

/**
 * Default command templates for quick-access skills
 */
export const QUICK_ACCESS_COMMANDS: Record<string, string> = {
    'pm-prd': '/pm-prd 请帮我创建一个产品需求文档',
    'pm-comp': '/pm-comp 请帮我做竞品分析',
    'pm-prototype': '/pm-prototype 请帮我生成一个高保真原型',
    'pm-backlog': '/pm-backlog 请帮我做迭代规划',
    'pm-sync': '/pm-sync 请生成本周项目状态更新',
};

/**
 * Default display labels for quick-access skills
 */
export const QUICK_ACCESS_LABELS: Record<string, string> = {
    'pm-prd': '写 PRD',
    'pm-comp': '竞品分析',
    'pm-prototype': '生成原型',
    'pm-backlog': '迭代规划',
    'pm-sync': '周报同步',
};

/**
 * Find the lifecycle stage for a given skill name
 */
export function getSkillStage(name: string): LifecycleStage | null {
    return LIFECYCLE_STAGES.find(stage => stage.skillNames.includes(name)) ?? null;
}

/**
 * Get the stage label for a given skill name
 */
export function getSkillStageLabel(name: string): string {
    return getSkillStage(name)?.label ?? '';
}
