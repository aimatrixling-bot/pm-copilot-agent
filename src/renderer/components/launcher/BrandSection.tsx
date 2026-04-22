/**
 * BrandSection - Left panel of the Launcher page
 * Layout: Logo+Slogan pinned to upper area, input box anchored to lower area
 * with workspace selector integrated into the input toolbar
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import SimpleChatInput, { type ImageAttachment } from '@/components/SimpleChatInput';
import WorkflowCards from './WorkflowCards';
import SkillBrowserOverlay from './SkillBrowserOverlay';
import SetupWizard from './SetupWizard';
import WorkspaceSelector from './WorkspaceSelector';
import logoImage from '@/assets/logo.png';
import { type Project, type Provider, type PermissionMode, type ProviderVerifyStatus } from '@/config/types';
import type { RuntimeType, RuntimeModelInfo, RuntimePermissionMode } from '../../../shared/types/runtime';

interface BrandSectionProps {
    // Workspace
    projects: Project[];
    selectedProject: Project | null;
    defaultWorkspacePath?: string;
    onSelectWorkspace: (project: Project) => void;
    onAddFolder: () => void;
    // Input
    onSend: (text: string, images?: ImageAttachment[]) => void;
    isStarting?: boolean;
    // Provider/Model (pass-through to SimpleChatInput)
    provider?: Provider | null;
    providers?: Provider[];
    selectedModel?: string;
    onProviderChange?: (id: string, targetModel?: string) => void;
    onModelChange?: (id: string) => void;
    permissionMode?: PermissionMode;
    onPermissionModeChange?: (mode: PermissionMode) => void;
    apiKeys?: Record<string, string>;
    providerVerifyStatus?: Record<string, ProviderVerifyStatus>;
    // MCP
    workspaceMcpEnabled?: string[];
    globalMcpEnabled?: string[];
    mcpServers?: Array<{ id: string; name: string; description?: string }>;
    onWorkspaceMcpToggle?: (serverId: string, enabled: boolean) => void;
    onRefreshProviders?: () => void;
    // Navigation
    onGoToSettings?: () => void;
    // Runtime (external runtimes adapt model/permission selectors)
    runtime?: RuntimeType;
    runtimeModels?: RuntimeModelInfo[];
    runtimePermissionModes?: RuntimePermissionMode[];
}

export default memo(function BrandSection({
    projects,
    selectedProject,
    defaultWorkspacePath,
    onSelectWorkspace,
    onAddFolder,
    onSend,
    isStarting,
    provider,
    providers,
    selectedModel,
    onProviderChange,
    onModelChange,
    permissionMode,
    onPermissionModeChange,
    apiKeys,
    providerVerifyStatus,
    workspaceMcpEnabled,
    globalMcpEnabled,
    mcpServers,
    onWorkspaceMcpToggle,
    onRefreshProviders,
    onGoToSettings,
    runtime,
    runtimeModels,
    runtimePermissionModes,
}: BrandSectionProps) {
    const [showSkillBrowser, setShowSkillBrowser] = useState(false);

    // Check if any provider is available (has valid subscription or API key configured)
    // Validation status is informational — having a key is enough to be "available"
    const hasAnyProvider = useMemo(() => {
        return providers?.some(p => {
            if (p.type === 'subscription') {
                const v = providerVerifyStatus?.[p.id];
                return v?.status === 'valid' && !!v?.accountEmail;
            }
            return !!apiKeys?.[p.id];
        }) ?? false;
    }, [providers, apiKeys, providerVerifyStatus]);

    const [showSetupWizard, setShowSetupWizard] = useState(false);
    const wizardOpened = useRef(false);

    // Auto-open setup wizard when no provider is configured
    useEffect(() => {
        if (!hasAnyProvider && !wizardOpened.current) {
            wizardOpened.current = true;
            setShowSetupWizard(true);
        }
    }, [hasAnyProvider]);

    const handleSend = useCallback((text: string, images?: ImageAttachment[]) => {
        onSend(text, images);
        return undefined; // SimpleChatInput expects boolean | void
    }, [onSend]);

    // Auto-open wizard on first render when no provider available
    const handleWizardComplete = useCallback(() => {
        setShowSetupWizard(false);
        onRefreshProviders?.();
    }, [onRefreshProviders]);

    const handleWizardSkip = useCallback(() => {
        setShowSetupWizard(false);
    }, []);

    return (
        <section className="flex flex-1 flex-col items-center px-12">
            {/* Upper area: Brand Name + Slogans */}
            <div className="flex flex-1 flex-col items-center justify-center">
                <img
                    src={logoImage}
                    alt="PM Copilot"
                    className="mb-5 h-20 w-20 md:h-24 md:w-24"
                    draggable={false}
                />
                <h1 className="brand-title mb-5 text-[2.5rem] text-[var(--ink)] md:text-[3.5rem]">
                    PM Copilot
                </h1>
                <p className="brand-slogan text-center text-[15px] text-[var(--ink-muted)] md:text-[17px]">
                    从问题定义到产品交付，你的全栈 PM 合伙人
                </p>
                <WorkflowCards
                    onSend={onSend}
                    onBrowseSkills={() => setShowSkillBrowser(true)}
                    disabled={isStarting}
                />
            </div>

            {/* Lower area: Input box with workspace selector in toolbar */}
            <div className="mt-8 w-full max-w-[640px] pb-[12vh]">
                <div className="relative w-full">
                    <SimpleChatInput
                        mode="launcher"
                        onSend={handleSend}
                        isLoading={!!isStarting}
                        provider={provider}
                        providers={providers}
                        selectedModel={selectedModel}
                        onProviderChange={onProviderChange}
                        onModelChange={onModelChange}
                        permissionMode={permissionMode}
                        onPermissionModeChange={onPermissionModeChange}
                        apiKeys={apiKeys}
                        providerVerifyStatus={providerVerifyStatus}
                        workspaceMcpEnabled={workspaceMcpEnabled}
                        globalMcpEnabled={globalMcpEnabled}
                        mcpServers={mcpServers}
                        onWorkspaceMcpToggle={onWorkspaceMcpToggle}
                        onRefreshProviders={onRefreshProviders}
                        runtime={runtime}
                        runtimeModels={runtimeModels}
                        runtimePermissionModes={runtimePermissionModes}
                        toolbarPrefix={
                            <WorkspaceSelector
                                projects={projects}
                                selectedProject={selectedProject}
                                defaultWorkspacePath={defaultWorkspacePath}
                                onSelect={onSelectWorkspace}
                                onAddFolder={onAddFolder}
                            />
                        }
                    />
                </div>
                {!hasAnyProvider && !showSetupWizard && (
                    <p className="mt-6 text-center text-[13px] text-[var(--ink-muted)]">
                        <button
                            type="button"
                            onClick={() => setShowSetupWizard(true)}
                            className="text-[var(--accent-warm)] hover:underline"
                        >
                            配置 AI 模型以开始使用
                        </button>
                        <span className="mx-1">—</span>
                        <button
                            type="button"
                            onClick={onGoToSettings}
                            className="text-[var(--accent-warm)] hover:underline"
                        >
                            前往设置 →
                        </button>
                    </p>
                )}
            </div>

            {/* Skill Browser Overlay */}
            {showSkillBrowser && (
                <SkillBrowserOverlay
                    onSend={(command) => onSend(command)}
                    onClose={() => setShowSkillBrowser(false)}
                />
            )}

            {/* Setup Wizard — shown when no provider is configured */}
            {showSetupWizard && !hasAnyProvider && (
                <SetupWizard
                    providers={providers ?? []}
                    apiKeys={apiKeys ?? {}}
                    providerVerifyStatus={providerVerifyStatus}
                    onComplete={handleWizardComplete}
                    onSkip={handleWizardSkip}
                    onSendCommand={(cmd) => onSend(cmd)}
                />
            )}
        </section>
    );
});
