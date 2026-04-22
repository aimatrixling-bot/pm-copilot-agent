import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, ChevronUp, Send, ImagePlus } from 'lucide-react';

import { useCloseLayer } from '@/hooks/useCloseLayer';

import { track } from '@/analytics';
import { CUSTOM_EVENTS } from '../../shared/constants';
import type { Provider, ProviderVerifyStatus } from '@/config/types';
import type { ImageAttachment } from './SimpleChatInput';
import { ALLOWED_IMAGE_MIME_TYPES } from '../../shared/fileTypes';
import { useImagePreview } from '@/context/ImagePreviewContext';
import { isProviderAvailable } from '@/config/configService';
import OverlayBackdrop from '@/components/OverlayBackdrop';

const MAX_IMAGES = 5;
const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB

interface BugReportOverlayProps {
    onClose: () => void;
    onNavigateToProviders: () => void;
    appVersion: string;
    providers: Provider[];
    apiKeys: Record<string, string>;
    providerVerifyStatus: Record<string, ProviderVerifyStatus>;
}

export default function BugReportOverlay({
    onClose, onNavigateToProviders, appVersion, providers, apiKeys, providerVerifyStatus,
}: BugReportOverlayProps) {
    // Cmd+W dismissal: z-[250] matches the component's CSS z-index
    useCloseLayer(() => { onClose(); return true; }, 250);

    const [description, setDescription] = useState('');
    const [images, setImages] = useState<ImageAttachment[]>([]);
    const [showModelMenu, _setShowModelMenu] = useState(false);
    const [isDragging, setIsDragging] = useState(false);
    const showModelMenuRef = useRef(false);
    const setShowModelMenu = useCallback((v: boolean) => {
        showModelMenuRef.current = v;
        _setShowModelMenu(v);
    }, []);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const { openPreview } = useImagePreview();

    // Default selection: first available provider's primaryModel (computed once at mount)
    const defaultProvider = () => providers.find(p => isProviderAvailable(p, apiKeys, providerVerifyStatus));
    const [selectedProviderId, setSelectedProviderId] = useState<string>(() => defaultProvider()?.id ?? '');
    const [selectedModel, setSelectedModel] = useState<string>(() => defaultProvider()?.primaryModel ?? '');

    const selectedProvider = providers.find(p => p.id === selectedProviderId);

    // Get display name for current model
    const modelDisplayName = useMemo(() => {
        if (!selectedProvider || !selectedModel) return '未选择模型';
        const model = selectedProvider.models.find(m => m.model === selectedModel);
        return model?.modelName || selectedModel;
    }, [selectedProvider, selectedModel]);

    const hasValidModel = !!selectedProviderId && !!selectedModel;
    const hasText = description.trim().length > 0;
    const hasContent = hasText || images.length > 0;
    const canSubmit = hasContent && hasValidModel;

    const addImage = useCallback((file: File) => {
        if (images.length >= MAX_IMAGES) return;
        if (!ALLOWED_IMAGE_MIME_TYPES.includes(file.type)) return;
        if (file.size > MAX_IMAGE_SIZE) return;

        const reader = new FileReader();
        reader.onload = (e) => {
            const dataUrl = e.target?.result as string;
            setImages(prev => [...prev, {
                id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                file,
                preview: dataUrl,
            }]);
        };
        reader.readAsDataURL(file);
    }, [images.length]);

    // Focus textarea on mount
    useEffect(() => {
        textareaRef.current?.focus();
    }, []);

    // Escape to close, click outside menu to close menu
    const onCloseRef = useRef(onClose);
    useEffect(() => { onCloseRef.current = onClose; });

    useEffect(() => {
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                if (showModelMenuRef.current) {
                    setShowModelMenu(false);
                } else {
                    onCloseRef.current();
                }
            }
        };
        const handleClick = (e: MouseEvent) => {
            if (showModelMenuRef.current && menuRef.current && !menuRef.current.contains(e.target as Node)) {
                setShowModelMenu(false);
            }
        };
        document.addEventListener('keydown', handleKey);
        document.addEventListener('mousedown', handleClick);
        return () => {
            document.removeEventListener('keydown', handleKey);
            document.removeEventListener('mousedown', handleClick);
        };
    }, [setShowModelMenu]);

    const handleSubmit = useCallback(() => {
        if (!canSubmit) return;
        track('bug_report_submit', { has_screenshot: images.length > 0 });
        window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.LAUNCH_BUG_REPORT, {
            detail: {
                description: description.trim(),
                providerId: selectedProviderId,
                model: selectedModel,
                appVersion,
                images,
            },
        }));
        onClose();
    }, [canSubmit, description, selectedProviderId, selectedModel, appVersion, images, onClose]);

    // Ctrl/Cmd+Enter to submit
    const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            handleSubmit();
        }
    }, [handleSubmit]);

    const handlePaste = useCallback((e: React.ClipboardEvent) => {
        const items = e.clipboardData?.items;
        if (!items) return;
        for (const item of Array.from(items)) {
            if (item.kind === 'file') {
                const file = item.getAsFile();
                if (file && file.type.startsWith('image/')) {
                    e.preventDefault();
                    addImage(file);
                    return;
                }
            }
        }
    }, [addImage]);

    const handleDragOver = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(true);
    }, []);

    const handleDragLeave = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        // Only clear dragging when leaving the container itself, not when entering children
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
            setIsDragging(false);
        }
    }, []);

    const handleDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(false);
        for (const file of Array.from(e.dataTransfer.files)) {
            if (file.type.startsWith('image/')) addImage(file);
        }
    }, [addImage]);

    const isMac = navigator.platform.toLowerCase().includes('mac');
    const getSubmitTitle = () => {
        if (!hasContent) return '请输入问题描述或添加图片';
        if (!hasValidModel) return '请先在设置中配置模型';
        return isMac ? '发送 (⌘Enter)' : '发送 (Ctrl+Enter)';
    };

    return (
        <OverlayBackdrop onClose={onClose} className="z-[250] px-4">
            <div className="glass-panel w-full max-w-md">
                {/* Header */}
                <div className="flex items-center justify-between border-b border-[var(--line)] px-5 py-4">
                    <h2 className="text-[14px] font-semibold text-[var(--ink)]">PM 助手</h2>
                    <button
                        onClick={onClose}
                        className="rounded-lg p-1 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                {/* Input area — matches Chat input style */}
                <div className="rounded-b-[24px] bg-[var(--paper)] px-5 py-4">
                    <div
                        className={`rounded-2xl border bg-[var(--paper-elevated)] transition-colors ${isDragging ? 'border-[var(--accent)]' : 'border-[var(--line)]'}`}
                        onDragOver={handleDragOver}
                        onDragLeave={handleDragLeave}
                        onDrop={handleDrop}
                    >
                        {/* Image thumbnails */}
                        {images.length > 0 && (
                            <div className="flex gap-2 overflow-x-auto px-4 pb-1 pt-3">
                                {images.map(img => (
                                    <div key={img.id} className="group relative flex-shrink-0">
                                        <img
                                            src={img.preview}
                                            alt="attachment"
                                            className="h-16 w-16 cursor-pointer rounded-lg border border-[var(--line)] object-cover"
                                            onDoubleClick={() => openPreview(img.preview, img.file.name)}
                                        />
                                        <button
                                            type="button"
                                            onClick={() => setImages(prev => prev.filter(i => i.id !== img.id))}
                                            className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-[var(--error)] text-white opacity-0 transition-opacity group-hover:opacity-100"
                                        >
                                            <X className="h-3 w-3" />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* Textarea */}
                        <textarea
                            ref={textareaRef}
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            onKeyDown={handleKeyDown}
                            onPaste={handlePaste}
                            placeholder="描述您遇到的问题、提出您的意见或建议"
                            className="w-full resize-none border-0 bg-transparent px-4 py-3 text-[13px] text-[var(--ink)] placeholder:text-[var(--ink-muted)]/50 focus:outline-none"
                            rows={5}
                        />

                        {/* Hidden file input */}
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept="image/png,image/jpeg,image/gif,image/webp"
                            multiple
                            className="hidden"
                            onChange={(e) => {
                                for (const file of Array.from(e.target.files || [])) addImage(file);
                                e.target.value = '';
                            }}
                        />

                        {/* Bottom toolbar */}
                        <div className="flex items-center justify-between border-t border-[var(--line)] px-3 py-2">
                            <div className="flex items-center gap-1">
                                {/* Image upload button */}
                                <button
                                    type="button"
                                    onClick={() => fileInputRef.current?.click()}
                                    className="rounded-lg p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                                    title="上传图片"
                                >
                                    <ImagePlus className="h-4 w-4" />
                                </button>

                                {/* Model selector */}
                                <div className="relative" ref={menuRef}>
                                    <button
                                        type="button"
                                        onClick={() => setShowModelMenu(!showModelMenu)}
                                        className="flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                                    >
                                        <span className="max-w-[180px] truncate">{modelDisplayName}</span>
                                        <ChevronUp className="h-3 w-3" />
                                    </button>

                                    {/* Model dropdown menu — only available providers */}
                                    {showModelMenu && (() => {
                                        const availableProviders = providers.filter(p => isProviderAvailable(p, apiKeys, providerVerifyStatus));
                                        return (
                                            <div className="absolute bottom-full left-0 mb-1 max-h-[300px] w-[260px] overflow-y-auto rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] py-1 shadow-lg">
                                                {availableProviders.length === 0 ? (
                                                    <button
                                                        type="button"
                                                        onClick={() => {
                                                            setShowModelMenu(false);
                                                            onNavigateToProviders();
                                                        }}
                                                        className="w-full px-3 py-2.5 text-left text-[12px] text-[var(--accent)] transition-colors hover:bg-[var(--paper-inset)]"
                                                    >
                                                        请先配置模型 →
                                                    </button>
                                                ) : (
                                                    availableProviders.map((provider, idx) => (
                                                        <div key={provider.id}>
                                                            {idx > 0 && <div className="mx-2 my-1 border-t border-[var(--line)]" />}
                                                            <div className="px-3 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--ink-muted)]/60">
                                                                {provider.name}
                                                            </div>
                                                            {provider.models.map(model => {
                                                                const isSelected = selectedProviderId === provider.id && selectedModel === model.model;
                                                                return (
                                                                    <button
                                                                        key={model.model}
                                                                        type="button"
                                                                        onClick={() => {
                                                                            setSelectedProviderId(provider.id);
                                                                            setSelectedModel(model.model);
                                                                            setShowModelMenu(false);
                                                                        }}
                                                                        className={`w-full rounded-md px-3 py-1.5 text-left text-[12px] transition-colors ${
                                                                            isSelected
                                                                                ? 'bg-[var(--accent)]/10 font-medium text-[var(--accent)]'
                                                                                : 'text-[var(--ink)] hover:bg-[var(--paper-inset)]'
                                                                        }`}
                                                                    >
                                                                        {model.modelName}
                                                                    </button>
                                                                );
                                                            })}
                                                        </div>
                                                    ))
                                                )}
                                            </div>
                                        );
                                    })()}
                                </div>
                            </div>

                            {/* Send button */}
                            <button
                                type="button"
                                onClick={handleSubmit}
                                disabled={!canSubmit}
                                title={getSubmitTitle()}
                                className={`rounded-lg p-2 transition-colors ${
                                    canSubmit
                                        ? 'bg-[var(--accent)] text-white hover:bg-[var(--accent-warm-hover)]'
                                        : 'bg-[var(--ink-muted)]/15 text-[var(--ink-muted)]/40'
                                }`}
                            >
                                <Send className="h-4 w-4" />
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </OverlayBackdrop>
    );
}
