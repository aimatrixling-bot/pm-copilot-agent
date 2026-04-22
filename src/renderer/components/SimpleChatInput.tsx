import { AlertCircle, ChevronDown, ChevronUp, Loader, Paperclip, Plus, Send, Square, X, FileText, AtSign, Wrench, Timer, Settings2 } from 'lucide-react';
import { memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, forwardRef } from 'react';

import Tip from '@/components/Tip';
import { useToast } from '@/components/Toast';
import { useImagePreview } from '@/context/ImagePreviewContext';
import { useTabApiOptional, type SessionState } from '@/context/TabContext';
import { type PermissionMode, PERMISSION_MODES, type Provider, type ProviderVerifyStatus, getModelDisplayName } from '@/config/types';
import SlashCommandMenu, { type SlashCommand, filterAndSortCommands } from './SlashCommandMenu';
import QueuedMessagesPanel from './QueuedMessageBubble';
import CronTaskStatusBar from './cron/CronTaskStatusBar';
import CronTaskOverlay from './cron/CronTaskOverlay';
import { useUndoStack } from '@/hooks/useUndoStack';
import { isImageFile, isImageMimeType, ALLOWED_IMAGE_MIME_TYPES } from '../../shared/fileTypes';
import type { QueuedMessageInfo } from '@/types/queue';
import { CUSTOM_EVENTS } from '../../shared/constants';
import { isDebugMode } from '@/utils/debug';
import { isProviderAvailable } from '@/config/configService';
import RuntimeSelector from '@/components/RuntimeSelector';
import type { RuntimeType, RuntimeDetections } from '../../shared/types/runtime';

// ===== Module-level pure helpers (extracted from render body) =====

/** Check if a provider has a warning (key set but verification failed) */
function isProviderWarning(
  p: Provider,
  apiKeys: Record<string, string>,
  verifyStatus: Record<string, ProviderVerifyStatus>,
): boolean {
  if (p.type === 'subscription') return false;
  return !!apiKeys[p.id] && verifyStatus[p.id]?.status === 'invalid';
}

// Image attachment type
export interface ImageAttachment {
  id: string;
  file: File;
  preview: string; // data URL for preview
}

interface SimpleChatInputProps {
  /** Optional external value for controlled scenarios (e.g., restoring draft) */
  value?: string;
  /** Optional callback when value changes - not recommended for performance reasons */
  onChange?: (value: string) => void;
  /** Called when user sends message. Text is managed internally for performance.
   *  Return false to indicate rejection (input will NOT be cleared). */
  onSend: (text: string, images?: ImageAttachment[], permissionMode?: PermissionMode) => boolean | void | Promise<boolean | void>;
  onStop?: () => void; // Called when stop button is clicked
  isLoading: boolean;
  /** Session state for stop button UI ('stopping' shows disabled spinner) */
  sessionState?: SessionState;
  /** System status (e.g., 'compacting') - when set, shows disabled send button instead of stop */
  systemStatus?: string | null;
  agentDir?: string; // For @file search
  // Provider/Model selection
  provider?: Provider | null; // Current provider for model selection
  providers?: Provider[]; // All available providers for switching
  onProviderChange?: (providerId: string, targetModel?: string) => void; // Called when provider is changed (with optional model to set atomically)
  selectedModel?: string; // Current selected model ID
  onModelChange?: (modelId: string) => void; // Called when model is changed
  // Permission modes
  permissionMode?: PermissionMode; // Current permission mode from parent
  onPermissionModeChange?: (mode: PermissionMode) => void;
  apiKeys?: Record<string, string>; // API keys for providers
  providerVerifyStatus?: Record<string, ProviderVerifyStatus>; // Persisted verification status
  /** External ref for focus control (used for Tab switching) */
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  // MCP workspace toggle
  workspaceMcpEnabled?: string[];  // IDs of MCPs enabled for this workspace
  globalMcpEnabled?: string[];     // IDs of globally enabled MCPs
  mcpServers?: Array<{ id: string; name: string; description?: string }>; // All available MCP servers
  onWorkspaceMcpToggle?: (serverId: string, enabled: boolean) => void;
  /** Callback to refresh providers data when opening model menu */
  onRefreshProviders?: () => void;
  /** Callback to open Agent settings (WorkspaceConfigPanel) */
  onOpenAgentSettings?: () => void;
  /** Callback to refresh workspace after files are added */
  onWorkspaceRefresh?: () => void;
  // Cron task props
  /** Whether cron mode is currently enabled (before task starts) */
  cronModeEnabled?: boolean;
  /** Cron task config (for status bar display) */
  cronConfig?: {
    intervalMinutes: number;
    schedule?: import('@/types/cronTask').CronSchedule;
  } | null;
  /** Active cron task (for overlay display) */
  cronTask?: {
    status: 'running' | 'paused' | 'stopped' | 'completed';
    intervalMinutes: number;
    schedule?: import('@/types/cronTask').CronSchedule;
    executionCount: number;
    lastExecutedAt?: string;
    endConditions?: {
      maxExecutions?: number;
    };
  } | null;
  /** Callback when cron button is clicked */
  onCronButtonClick?: () => void;
  /** Callback when cron settings button is clicked (from status bar or overlay) */
  onCronSettings?: () => void;
  /** Callback when cron is cancelled (from status bar X button) */
  onCronCancel?: () => void;
  /** Callback when cron task is stopped */
  onCronStop?: () => void;
  /** Callback when input text changes (for cron prompt tracking) */
  onInputChange?: (text: string) => void;
  /** Display mode: 'chat' (default) or 'launcher' (hides @/slash/cron features) */
  mode?: 'chat' | 'launcher';
  /** Optional ReactNode rendered at the start of the toolbar (e.g., workspace selector in launcher) */
  toolbarPrefix?: React.ReactNode;
  // Agent Runtime (v0.1.59)
  runtime?: RuntimeType;
  runtimeDetections?: RuntimeDetections;
  onRuntimeChange?: (runtime: RuntimeType) => void;
  runtimeModels?: import('../../shared/types/runtime').RuntimeModelInfo[];
  runtimePermissionModes?: import('../../shared/types/runtime').RuntimePermissionMode[];
  // Queued messages props
  queuedMessages?: QueuedMessageInfo[];
  onCancelQueued?: (queueId: string) => void;
  onForceExecuteQueued?: (queueId: string) => void;
}

const LINE_HEIGHT = 26; // px per line (text-base 16px * leading-relaxed 1.625 = 26px)
const MAX_LINES_COLLAPSED = 3;
const MAX_LINES_EXPANDED = 12;
const MAX_IMAGES = 5;
const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB

// Methods exposed to parent via ref
export interface SimpleChatInputHandle {
  /** Process dropped files - copies to pm_copilot_files and inserts @references */
  processDroppedFiles: (files: File[]) => Promise<void>;
  /** Process dropped file paths from Tauri - copies to pm_copilot_files and inserts @references */
  processDroppedFilePaths?: (paths: string[]) => Promise<void>;
  /** Insert @references at cursor position or end of input */
  insertReferences: (paths: string[]) => void;
  /** Insert a /slash-command at cursor position or end of input */
  insertSlashCommand: (command: string) => void;
  /** Set the input value directly (used for restoring content after cron stop) */
  setValue: (value: string) => void;
  /** Set image attachments directly (used for restoring queued message images on cancel) */
  setImages: (images: ImageAttachment[]) => void;
}

// File search result type
interface FileSearchResult {
  path: string;
  name: string;
  type: 'file' | 'dir';
}

const SimpleChatInput = memo(forwardRef<SimpleChatInputHandle, SimpleChatInputProps>(function SimpleChatInput({
  value: externalValue,
  onChange: _externalOnChange,
  onSend,
  onStop,
  isLoading,
  sessionState,
  systemStatus,
  agentDir,
  provider,
  providers = [],
  onProviderChange,
  selectedModel,
  onModelChange,
  permissionMode = 'auto',
  onPermissionModeChange,
  apiKeys = {},
  providerVerifyStatus = {},
  inputRef,
  workspaceMcpEnabled = [],
  globalMcpEnabled = [],
  mcpServers = [],
  onWorkspaceMcpToggle,
  onRefreshProviders,
  onOpenAgentSettings,
  onWorkspaceRefresh,
  cronModeEnabled = false,
  cronConfig,
  cronTask,
  onCronButtonClick,
  onCronSettings,
  onCronCancel,
  onCronStop,
  onInputChange,
  mode = 'chat',
  toolbarPrefix,
  runtime = 'builtin',
  runtimeDetections,
  onRuntimeChange,
  runtimeModels,
  runtimePermissionModes,
  queuedMessages = [],
  onCancelQueued,
  onForceExecuteQueued,
}, ref) {
  const isLauncherMode = mode === 'launcher';
  const isExternalRuntime = runtime !== 'builtin';

  // Compute display modes and model name based on runtime
  const displayPermissionModes = isExternalRuntime && runtimePermissionModes
    ? runtimePermissionModes.map(m => ({ value: m.value as PermissionMode, label: m.label, icon: m.icon, description: m.description, sdkValue: m.value }))
    : PERMISSION_MODES;
  const currentModeDisplay = displayPermissionModes.find(m => m.value === permissionMode)
    ?? displayPermissionModes[0];

  // PERFORMANCE FIX: Use internal state to avoid parent re-renders on every keystroke
  // This prevents MessageList from re-rendering when typing in long conversations
  const [inputValue, setInputValue] = useState(externalValue ?? '');

  // Sync with external value when it changes (e.g., after send clears input)
  // NOTE: Intentionally only depend on externalValue - we only want to sync when
  // external value changes, not when internal inputValue changes (would cause loop)
  useEffect(() => {
    if (externalValue !== undefined && externalValue !== inputValue) {
      setInputValue(externalValue);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalValue]);

  // Notify parent of input value changes (for cron prompt tracking)
  useEffect(() => {
    onInputChange?.(inputValue);
  }, [inputValue, onInputChange]);

  // Ref for current provider availability — used in handleKeyDown without adding deps
  const isCurrentProviderAvailable = provider ? isProviderAvailable(provider, apiKeys, providerVerifyStatus) : false;
  const isCurrentProviderAvailableRef = useRef(isCurrentProviderAvailable);
  isCurrentProviderAvailableRef.current = isCurrentProviderAvailable;

  // Get Tab-scoped API functions (for @file search and file operations)
  const tabApiContext = useTabApiOptional();
  const apiGet = tabApiContext?.apiGet;
  const apiPost = tabApiContext?.apiPost;

  const toast = useToast();
  // Stabilize toast reference to avoid unnecessary effect re-runs
  const toastRef = useRef(toast);
  toastRef.current = toast;

  const { openPreview } = useImagePreview();
  // Use external ref if provided, otherwise use internal ref
  const internalRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = inputRef ?? internalRef;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isExpanded, setIsExpanded] = useState(false);

  // Image attachments - moved up for processDroppedFiles to use
  const [images, setImages] = useState<ImageAttachment[]>([]);

  // Undo stack for file reference insertions
  const undoStack = useUndoStack({ maxSize: 20 });

  // Ref for latest inputValue (for stable insertReferences callback)
  const inputValueRef = useRef(inputValue);
  inputValueRef.current = inputValue;

  // Plus menu
  const [showPlusMenu, setShowPlusMenu] = useState(false);


  // Mode and Model dropdown menus
  const [showModeMenu, setShowModeMenu] = useState(false);
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [showToolMenu, setShowToolMenu] = useState(false);

  // Derive current model ID from prop or provider default — no hardcoded fallback
  const currentModelId = selectedModel ?? provider?.primaryModel;
  // Get display name for current model (runtime-aware)
  const currentModelName = isExternalRuntime
    ? (runtimeModels?.find(m => m.value === selectedModel)?.displayName
      ?? runtimeModels?.find(m => m.isDefault)?.displayName
      ?? '默认')
    : (currentModelId
      ? (provider ? getModelDisplayName(provider, currentModelId) : currentModelId)
      : '选择模型');

  // @file search
  const [showFileSearch, setShowFileSearch] = useState(false);
  const [fileSearchQuery, setFileSearchQuery] = useState('');
  const [fileSearchResults, setFileSearchResults] = useState<FileSearchResult[]>([]);
  const [selectedFileIndex, setSelectedFileIndex] = useState(0);
  const [atPosition, setAtPosition] = useState<number | null>(null);
  const [isFileSearching, setIsFileSearching] = useState(false); // Track if actively searching

  // /slash command search
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashSearchQuery, setSlashSearchQuery] = useState('');
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
  const [selectedSlashIndex, setSelectedSlashIndex] = useState(0);
  const [slashPosition, setSlashPosition] = useState<number | null>(null);

  // Compute filtered slash commands once per render (used in both handleKeyDown and JSX)
  const filteredSlashCommands = useMemo(
    () => filterAndSortCommands(slashCommands, slashSearchQuery),
    [slashCommands, slashSearchQuery]
  );

  // Guard against double-fire of handleSend (e.g. rapid Enter + click)
  const sendingRef = useRef(false);

  // Close all dropdown menus (plus, mode, model, provider)
  const closeAllMenus = useCallback(() => {
    setShowPlusMenu(false);
    setShowModeMenu(false);
    setShowModelMenu(false);
    setShowToolMenu(false);
  }, []);

  // Close all menus when clicking outside (toolbar buttons use stopPropagation to prevent this)
  useEffect(() => {
    const handleClickOutside = () => {
      closeAllMenus();
      setShowSlashMenu(false);
      setSlashPosition(null);
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [closeAllMenus]);

  useEffect(() => {
    textareaRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- textareaRef is stable
  }, []);

  // Auto-resize textarea based on content
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    if (isExpanded) {
      textarea.style.height = `${LINE_HEIGHT * MAX_LINES_EXPANDED}px`;
    } else {
      textarea.style.height = 'auto';
      const minHeight = LINE_HEIGHT * 2;
      const maxHeight = LINE_HEIGHT * MAX_LINES_COLLAPSED;
      const scrollHeight = textarea.scrollHeight;
      textarea.style.height = `${Math.max(minHeight, Math.min(scrollHeight, maxHeight))}px`;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- textareaRef is stable
  }, [inputValue, isExpanded]);

  // Fetch slash commands function (extracted for reuse)
  // Falls back to apiGetJson when TabContext is unavailable (e.g. launcher mode)
  const fetchCommands = useCallback(async () => {
    if (!apiGet) {
      // Launcher mode: use global API directly
      try {
        const { apiGetJson } = await import('@/api/apiFetch');
        const response = await apiGetJson<{ success: boolean; commands: SlashCommand[] }>('/api/commands');
        if (response.success && response.commands.length > 0) {
          setSlashCommands(response.commands);
          return;
        }
      } catch {
        // Fall through to builtin fallback
      }
      setSlashCommands([
        { name: 'compact', description: '压缩对话历史，释放上下文空间', source: 'builtin' },
        { name: 'context', description: '显示或管理当前上下文', source: 'builtin' },
        { name: 'cost', description: '查看 token 使用量和费用', source: 'builtin' },
        { name: 'init', description: '初始化项目配置 (.CLAUDE.md)', source: 'builtin' },
        { name: 'pr-comments', description: '生成 Pull Request 评论', source: 'builtin' },
        { name: 'release-notes', description: '根据最近提交生成发布说明', source: 'builtin' },
        { name: 'review', description: '对代码进行审查', source: 'builtin' },
        { name: 'security-review', description: '进行安全相关的代码审查', source: 'builtin' },
      ]);
      return;
    }

    try {
      const response = await apiGet<{ success: boolean; commands: SlashCommand[] }>('/api/commands');
      if (response.success && response.commands.length > 0) {
        setSlashCommands(response.commands);
      } else {
        // Fallback to builtin commands imported from SlashCommandMenu
        console.warn('[slash-commands] API returned empty, using builtin fallback');
        setSlashCommands([
          { name: 'compact', description: '压缩对话历史，释放上下文空间', source: 'builtin' },
          { name: 'context', description: '显示或管理当前上下文', source: 'builtin' },
          { name: 'cost', description: '查看 token 使用量和费用', source: 'builtin' },
          { name: 'init', description: '初始化项目配置 (.CLAUDE.md)', source: 'builtin' },
          { name: 'pr-comments', description: '生成 Pull Request 评论', source: 'builtin' },
          { name: 'release-notes', description: '根据最近提交生成发布说明', source: 'builtin' },
          { name: 'review', description: '对代码进行审查', source: 'builtin' },
          { name: 'security-review', description: '进行安全相关的代码审查', source: 'builtin' },
        ]);
      }
    } catch (err) {
      console.error('Failed to fetch slash commands, using fallback:', err);
      // Fallback to builtin commands
      setSlashCommands([
        { name: 'compact', description: '压缩对话历史，释放上下文空间', source: 'builtin' },
        { name: 'context', description: '显示或管理当前上下文', source: 'builtin' },
        { name: 'cost', description: '查看 token 使用量和费用', source: 'builtin' },
        { name: 'init', description: '初始化项目配置 (.CLAUDE.md)', source: 'builtin' },
        { name: 'pr-comments', description: '生成 Pull Request 评论', source: 'builtin' },
        { name: 'release-notes', description: '根据最近提交生成发布说明', source: 'builtin' },
        { name: 'review', description: '对代码进行审查', source: 'builtin' },
        { name: 'security-review', description: '进行安全相关的代码审查', source: 'builtin' },
      ]);
    }
  }, [apiGet]);

  // Fetch slash commands on mount or when agentDir changes
  useEffect(() => {
    fetchCommands();
  }, [agentDir, fetchCommands]);

  // Listen for skill copy events to refresh commands list
  useEffect(() => {
    const handleSkillCopied = () => {
      // Delay slightly to ensure file system is updated
      setTimeout(() => {
        fetchCommands();
      }, 100);
    };
    window.addEventListener(CUSTOM_EVENTS.SKILL_COPIED_TO_PROJECT, handleSkillCopied);
    return () => window.removeEventListener(CUSTOM_EVENTS.SKILL_COPIED_TO_PROJECT, handleSkillCopied);
  }, [fetchCommands]);

  // Handle user-level skill selection
  // No-op: user-level skills/commands are synced as symlinks into project .claude/
  // by syncProjectUserConfig() at session startup. No per-invocation copy needed.
  const handleSkillSelect = useCallback((_cmd: SlashCommand) => {}, []);

  // Validate and add image (resize is handled server-side in enqueueUserMessage)
  const addImage = useCallback((file: File) => {
    if (images.length >= MAX_IMAGES) {
      toastRef.current.warning(`最多只能上传 ${MAX_IMAGES} 张图片`);
      return;
    }
    if (!ALLOWED_IMAGE_MIME_TYPES.includes(file.type)) {
      toastRef.current.warning('不支持的图片格式，请使用 PNG/JPG/GIF/WebP');
      return;
    }
    if (file.size > MAX_IMAGE_SIZE) {
      toastRef.current.warning('图片大小不能超过 5MB');
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string;
      setImages((prev) => [...prev, {
        id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        file,
        preview: dataUrl,
      }]);
    };
    reader.readAsDataURL(file);
  }, [images.length]);

  // Remove image
  const removeImage = useCallback((id: string) => {
    setImages((prev) => prev.filter((img) => img.id !== id));
  }, []);

  // Helper function to convert File to base64
  const fileToBase64 = useCallback((file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        // Remove data URL prefix (e.g., "data:application/pdf;base64,")
        const base64 = result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }, []);

  // Process dropped files - copies to pm_copilot_files and inserts @references
  const processDroppedFiles = useCallback(async (files: File[]) => {
    if (isDebugMode()) {
      console.log('[SimpleChatInput] processDroppedFiles called with', files.length, 'files:', files.map(f => f.name));
    }

    // Separate images and non-images
    const imageFiles: File[] = [];
    const otherFiles: File[] = [];

    for (const file of files) {
      if (isImageFile(file.name) || isImageMimeType(file.type)) {
        imageFiles.push(file);
      } else {
        otherFiles.push(file);
      }
    }

    // Handle image files with the original addImage logic (no API needed)
    for (const file of imageFiles) {
      addImage(file);
    }

    // Handle non-image files - upload to pm_copilot_files and insert @references
    if (otherFiles.length > 0) {
      if (!apiPost) {
        console.error('[SimpleChatInput] apiPost not available for file upload');
        toastRef.current.error('无法上传文件：API 未就绪，请在对话页面中操作');
        return;
      }
      try {
        // Convert files to base64 for JSON upload (works in Tauri)
        const base64Files = await Promise.all(
          otherFiles.map(async (file) => ({
            name: file.name,
            content: await fileToBase64(file),
          }))
        );

        // Upload via base64 API endpoint
        const result = await apiPost<{ success: boolean; files: string[]; error?: string }>(
          '/api/files/import-base64',
          { files: base64Files, targetDir: 'pm_copilot_files' }
        );

        if (!result.success || !result.files || result.files.length === 0) {
          throw new Error(result.error || '上传失败');
        }

        // Add .gitignore rule for pm_copilot_files folder
        try {
          await apiPost('/api/files/add-gitignore', { pattern: 'pm_copilot_files/' });
        } catch {
          // Non-fatal, continue silently
        }

        // Insert @references into input
        const cursorPos = textareaRef.current?.selectionStart ?? inputValue.length;
        const references = result.files.map(path => `@${path}`).join(' ');

        const before = inputValue.slice(0, cursorPos);
        const after = inputValue.slice(cursorPos);
        const insertedText = references + ' ';
        const newValue = before + insertedText + after;

        setInputValue(newValue);

        // Generate batch ID for this operation (all files in one drop share same batch)
        const batchId = undoStack.generateBatchId();

        // Push to undo stack for each file with same batchId
        for (const filePath of result.files) {
          undoStack.push({
            type: 'file-reference',
            batchId,
            insertedText: `@${filePath} `,
            insertPosition: cursorPos,
            copiedFilePath: filePath,
          });
        }

        toastRef.current.success(`已添加 ${result.files.length} 个文件到工作区`);

        // Refresh workspace to show new files
        onWorkspaceRefresh?.();
      } catch (err) {
        console.error('[SimpleChatInput] File upload error:', err);
        toastRef.current.error(err instanceof Error ? err.message : '文件上传失败');
      }
    }
  }, [apiPost, addImage, inputValue, textareaRef, undoStack, fileToBase64, onWorkspaceRefresh]);

  // Process file paths from Tauri drag-drop (uses /api/files/copy)
  const processDroppedFilePaths = useCallback(async (paths: string[]) => {
    if (isDebugMode()) {
      console.log('[SimpleChatInput] processDroppedFilePaths called with', paths.length, 'paths:', paths);
    }

    if (!apiPost) {
      console.error('[SimpleChatInput] apiPost not available');
      toastRef.current.error('无法处理文件：API 未就绪');
      return;
    }

    // Separate images and non-images based on extension
    const imagePaths: string[] = [];
    const otherPaths: string[] = [];

    for (const path of paths) {
      // Support both / and \ path separators
      const filename = path.split(/[\\/]/).pop() || path;
      if (isImageFile(filename)) {
        imagePaths.push(path);
      } else {
        otherPaths.push(path);
      }
    }

    // Handle image files - read via backend API and add as image attachments
    if (imagePaths.length > 0) {
      try {
        const readResult = await apiPost<{
          success: boolean;
          files: Array<{
            path: string;
            name: string;
            mimeType: string;
            data: string;
            error?: string;
          }>;
        }>('/api/files/read-as-base64', { paths: imagePaths });

        if (readResult.success && readResult.files) {
          for (const fileData of readResult.files) {
            if (fileData.data && !fileData.error) {
              // Create a File object from base64 data
              const byteString = atob(fileData.data);
              const ab = new ArrayBuffer(byteString.length);
              const ia = new Uint8Array(ab);
              for (let i = 0; i < byteString.length; i++) {
                ia[i] = byteString.charCodeAt(i);
              }
              const blob = new Blob([ab], { type: fileData.mimeType });
              const file = new File([blob], fileData.name, { type: fileData.mimeType });
              addImage(file);
            }
          }
        }
      } catch (err) {
        // If image reading fails, fall back to treating them as regular files
        if (isDebugMode()) {
          console.warn('[SimpleChatInput] Failed to read images, treating as regular files:', err);
        }
        otherPaths.push(...imagePaths);
        imagePaths.length = 0;
      }
    }

    // Handle non-image files - copy to pm_copilot_files and insert @references
    if (otherPaths.length > 0) {
      try {
        // Copy files to pm_copilot_files using /api/files/copy
        const result = await apiPost<{
          success: boolean;
          copiedFiles: Array<{ sourcePath: string; targetPath: string; renamed: boolean }>;
          error?: string;
        }>('/api/files/copy', {
          sourcePaths: otherPaths,
          targetDir: 'pm_copilot_files',
          autoRename: true,
        });

        if (!result.success) {
          throw new Error(result.error || '复制失败');
        }

        // Handle partial success - some files may have been copied
        const successfulCopies = result.copiedFiles || [];
        if (successfulCopies.length === 0) {
          throw new Error('没有文件被成功复制');
        }

        // Add .gitignore rule for pm_copilot_files folder
        try {
          await apiPost('/api/files/add-gitignore', { pattern: 'pm_copilot_files/' });
        } catch {
          // Non-fatal, continue silently
        }

        // Insert @references into input
        const cursorPos = textareaRef.current?.selectionStart ?? inputValue.length;
        const references = successfulCopies.map(f => `@${f.targetPath}`).join(' ');

        const before = inputValue.slice(0, cursorPos);
        const after = inputValue.slice(cursorPos);
        const insertedText = references + ' ';
        const newValue = before + insertedText + after;

        setInputValue(newValue);

        // Generate batch ID for this operation
        const batchId = undoStack.generateBatchId();

        // Push to undo stack for each file with same batchId
        for (const file of successfulCopies) {
          undoStack.push({
            type: 'file-reference',
            batchId,
            insertedText: `@${file.targetPath} `,
            insertPosition: cursorPos,
            copiedFilePath: file.targetPath,
          });
        }

        // Show appropriate message
        if (successfulCopies.length < otherPaths.length) {
          toastRef.current.warning(`已添加 ${successfulCopies.length}/${otherPaths.length} 个文件到工作区`);
        } else {
          toastRef.current.success(`已添加 ${successfulCopies.length} 个文件到工作区`);
        }

        // Refresh workspace to show new files
        onWorkspaceRefresh?.();
      } catch (err) {
        console.error('[SimpleChatInput] Tauri file copy error:', err);
        toastRef.current.error(err instanceof Error ? err.message : '文件复制失败');
      }
    }
  }, [apiPost, addImage, inputValue, textareaRef, undoStack, onWorkspaceRefresh]);

  // Insert @references at cursor position or end of input
  // Uses inputValueRef for stable callback (avoids rebuilding on every input change)
  const insertReferences = useCallback((paths: string[]) => {
    if (paths.length === 0) return;

    const currentInput = inputValueRef.current;

    // Build reference string with @paths separated by spaces
    const references = paths.map(p => `@${p}`).join(' ');

    // Get cursor position (or end if no focus)
    const cursorPos = textareaRef.current?.selectionStart ?? currentInput.length;
    const before = currentInput.slice(0, cursorPos);
    const after = currentInput.slice(cursorPos);

    // Add space before if needed (not at start, not after space/newline)
    const needsSpaceBefore = before.length > 0 && !/[\s]$/.test(before);
    // Add space after if needed (not at end, not before space/newline)
    const needsSpaceAfter = after.length > 0 && !/^[\s]/.test(after);

    const newValue = `${before}${needsSpaceBefore ? ' ' : ''}${references}${needsSpaceAfter ? ' ' : ''}${after}`;
    setInputValue(newValue);

    // Focus textarea and set cursor after the inserted references
    const newCursorPos = cursorPos + (needsSpaceBefore ? 1 : 0) + references.length + (needsSpaceAfter ? 1 : 0);
    setTimeout(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(newCursorPos, newCursorPos);
    }, 0);
  }, [textareaRef]);

  // Insert /slash-command at cursor position or end of input
  const insertSlashCommand = useCallback((command: string) => {
    if (!command.trim()) return;
    const currentInput = inputValueRef.current;
    const slashCmd = `/${command}`;
    const cursorPos = textareaRef.current?.selectionStart ?? currentInput.length;
    const before = currentInput.slice(0, cursorPos);
    const after = currentInput.slice(cursorPos);
    const needsSpaceBefore = before.length > 0 && !/[\s]$/.test(before);
    const needsSpaceAfter = after.length > 0 && !/^[\s]/.test(after);
    const newValue = `${before}${needsSpaceBefore ? ' ' : ''}${slashCmd}${needsSpaceAfter ? ' ' : ''}${after}`;
    setInputValue(newValue);
    const newCursorPos = cursorPos + (needsSpaceBefore ? 1 : 0) + slashCmd.length + (needsSpaceAfter ? 1 : 0);
    setTimeout(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(newCursorPos, newCursorPos);
    }, 0);
  }, [textareaRef]);

  // Set input value directly (for restoring content after cron stop)
  const setValue = useCallback((value: string) => {
    setInputValue(value);
    // Also focus the textarea
    textareaRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- textareaRef is stable
  }, []);

  // Expose methods to parent via ref
  useImperativeHandle(ref, () => ({
    processDroppedFiles,
    processDroppedFilePaths,
    insertReferences,
    insertSlashCommand,
    setValue,
    setImages,
  }), [processDroppedFiles, processDroppedFilePaths, insertReferences, insertSlashCommand, setValue]);

  // Handle file input change
  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      void processDroppedFiles(Array.from(files));
    }
    // Reset input so same file can be selected again
    e.target.value = '';
    setShowPlusMenu(false);
  }, [processDroppedFiles]);

  // Handle paste for images and files
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) {
      return;
    }

    const files: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) {
          files.push(file);
        }
      }
    }

    if (files.length > 0) {
      if (isDebugMode()) {
        console.log('[SimpleChatInput] Processing', files.length, 'pasted files');
      }
      e.preventDefault();
      // Use processDroppedFiles to handle all file types
      void processDroppedFiles(files);
    }
  }, [processDroppedFiles]);

  // @file search logic
  const searchFiles = useCallback(async (query: string) => {
    if (!agentDir || query.length < 1 || !apiGet) {
      setFileSearchResults([]);
      setIsFileSearching(false);
      return;
    }

    setIsFileSearching(true);
    try {
      const results = await apiGet<FileSearchResult[]>(`/agent/search-files?q=${encodeURIComponent(query)}`);
      setFileSearchResults(results.slice(0, 10)); // Limit to 10 results
      setSelectedFileIndex(0);
    } catch (err) {
      console.error('File search error:', err);
      setFileSearchResults([]);
    } finally {
      setIsFileSearching(false);
    }
  }, [agentDir, apiGet]);

  // Debounced file search
  useEffect(() => {
    if (!showFileSearch) return;

    // Set searching state immediately when query changes (to avoid flash of 'not found')
    if (fileSearchQuery.length > 0) {
      setIsFileSearching(true);
    }

    const timer = setTimeout(() => {
      searchFiles(fileSearchQuery);
    }, 150);

    return () => clearTimeout(timer);
  }, [fileSearchQuery, showFileSearch, searchFiles]);

  // Handle text input change (detect @ and / and backspace)
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    const cursorPos = e.target.selectionStart;

    // Track current state locally to avoid stale closure issues
    let currentShowFileSearch = showFileSearch;
    let currentAtPosition = atPosition;
    let currentShowSlashMenu = showSlashMenu;
    let currentSlashPosition = slashPosition;

    // Detect new @ or / character (only when adding)
    if (newValue.length > inputValue.length) {
      const addedChar = newValue[cursorPos - 1];
      if (addedChar === '@' && !isLauncherMode) {
        currentShowFileSearch = true;
        currentAtPosition = cursorPos - 1;
        setShowFileSearch(true);
        setAtPosition(cursorPos - 1);
        setFileSearchQuery('');
        setFileSearchResults([]);
        // Close slash menu if open
        currentShowSlashMenu = false;
        currentSlashPosition = null;
        setShowSlashMenu(false);
        setSlashPosition(null);
      } else if (addedChar === '/') {
        currentShowSlashMenu = true;
        currentSlashPosition = cursorPos - 1;
        setShowSlashMenu(true);
        setSlashPosition(cursorPos - 1);
        setSlashSearchQuery('');
        setSelectedSlashIndex(0);
        // Close file search if open
        currentShowFileSearch = false;
        currentAtPosition = null;
        setShowFileSearch(false);
        setAtPosition(null);
      }
    }

    // Update file search query if @ is active (handles both add and delete)
    if (currentShowFileSearch && currentAtPosition !== null) {
      // Check if @ was deleted
      if (currentAtPosition >= newValue.length || newValue[currentAtPosition] !== '@') {
        setShowFileSearch(false);
        setAtPosition(null);
      } else {
        const textAfterAt = newValue.slice(currentAtPosition + 1, cursorPos);
        // If there's a space or newline after @, close search
        if (textAfterAt.includes(' ') || textAfterAt.includes('\n')) {
          setShowFileSearch(false);
          setAtPosition(null);
        } else {
          setFileSearchQuery(textAfterAt);
        }
      }
    }

    // Update slash search query if / is active (handles both add and delete)
    if (currentShowSlashMenu && currentSlashPosition !== null) {
      // Check if / was deleted
      if (currentSlashPosition >= newValue.length || newValue[currentSlashPosition] !== '/') {
        setShowSlashMenu(false);
        setSlashPosition(null);
      } else {
        const textAfterSlash = newValue.slice(currentSlashPosition + 1, cursorPos);
        // If there's a space or newline after /, close menu
        if (textAfterSlash.includes(' ') || textAfterSlash.includes('\n')) {
          setShowSlashMenu(false);
          setSlashPosition(null);
        } else {
          setSlashSearchQuery(textAfterSlash);
          setSelectedSlashIndex(0);
        }
      }
    }

    setInputValue(newValue);
  }, [inputValue, showFileSearch, atPosition, showSlashMenu, slashPosition, isLauncherMode]);

  // Cycle permission mode: auto → plan → fullAgency → auto
  const cyclePermissionMode = useCallback(() => {
    const modeOrder: PermissionMode[] = ['auto', 'plan', 'fullAgency'];
    const currentIndex = modeOrder.indexOf(permissionMode);
    const nextIndex = (currentIndex + 1) % modeOrder.length;
    const nextMode = modeOrder[nextIndex];

    // Show warning toast for fullAgency mode (10 seconds)
    if (nextMode === 'fullAgency') {
      toastRef.current.warning('自主行动已启用：Agent 可能做出不可挽回的操作，请谨慎使用', 5000);
    }
    onPermissionModeChange?.(nextMode);
  }, [permissionMode, onPermissionModeChange]);

  // Global Shift+Tab handler with capture phase to prevent default Tab behavior
  useEffect(() => {
    const handleShiftTab = (e: KeyboardEvent) => {
      if (e.key === 'Tab' && e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        cyclePermissionMode();
      }
    };
    // Use capture phase to intercept before default Tab behavior
    document.addEventListener('keydown', handleShiftTab, { capture: true });
    return () => document.removeEventListener('keydown', handleShiftTab, { capture: true });
  }, [cyclePermissionMode]);

  // Send message - defined before handleKeyDown to avoid circular dependency
  // Note: isLoading guard removed to allow queuing messages while AI is responding
  const handleSend = useCallback(async () => {
    const text = inputValue.trim();
    if (!text && images.length === 0) return;

    // Prevent double-fire (rapid Enter + click, or concurrent async sends)
    if (sendingRef.current) return;
    sendingRef.current = true;

    try {
      const result = onSend(text, images.length > 0 ? images : undefined);
      // If onSend returns a promise, await it; if sync, use directly
      const accepted = result instanceof Promise ? await result : result;
      // Only clear input if not explicitly rejected (false)
      if (accepted !== false) {
        setInputValue('');
        setImages([]);
      }
    } finally {
      sendingRef.current = false;
    }
  }, [onSend, images, inputValue]);

  // Handle keyboard navigation in file search and slash menu
  const handleKeyDown = useCallback(async (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Shift+Tab to cycle permission mode
    if (event.key === 'Tab' && event.shiftKey) {
      event.preventDefault();
      cyclePermissionMode();
      return;
    }

    // Cmd+Z (Mac) or Ctrl+Z (Windows) to undo file reference insertion
    if ((event.metaKey || event.ctrlKey) && event.key === 'z' && !event.shiftKey) {
      const action = undoStack.peek();
      if (action?.type === 'file-reference') {
        event.preventDefault();

        // Pop all actions in the same batch (multi-file drop)
        const batchActions = undoStack.popBatch();
        if (batchActions.length === 0) return;

        // Remove all @references from input
        let newInputValue = inputValue;
        for (const a of batchActions) {
          if (newInputValue.includes(a.insertedText)) {
            newInputValue = newInputValue.replace(a.insertedText, '');
          }
        }
        setInputValue(newInputValue);

        // Delete all copied files
        if (apiPost) {
          let successCount = 0;
          let failCount = 0;

          for (const a of batchActions) {
            try {
              await apiPost('/agent/delete', { path: a.copiedFilePath });
              successCount++;
            } catch {
              failCount++;
            }
          }

          // Show appropriate message
          if (failCount === 0) {
            toastRef.current.success(`已撤销 ${successCount} 个文件的添加`);
          } else if (successCount > 0) {
            toastRef.current.warning(`已撤销 ${successCount} 个文件，${failCount} 个文件删除失败`);
          } else {
            toastRef.current.warning('已移除引用，但文件删除失败');
          }
        }
        return;
      }
      // If no file reference in undo stack, let browser handle default undo
    }

    // Slash menu navigation (filteredSlashCommands computed via useMemo at component level)
    if (showSlashMenu && filteredSlashCommands.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedSlashIndex((i) => Math.min(i + 1, filteredSlashCommands.length - 1));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedSlashIndex((i) => Math.max(i - 1, 0));
        return;
      }
      // Tab or Enter to select
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const selected = filteredSlashCommands[selectedSlashIndex];
        if (selected && slashPosition !== null) {
          // Trigger skill copy if user-level skill
          handleSkillSelect(selected);
          // Replace /query with /command
          const before = inputValue.slice(0, slashPosition);
          const after = inputValue.slice(textareaRef.current?.selectionStart || slashPosition + slashSearchQuery.length + 1);
          setInputValue(`${before}/${selected.name} ${after}`);
          setShowSlashMenu(false);
          setSlashPosition(null);
        }
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setShowSlashMenu(false);
        setSlashPosition(null);
        return;
      }
    }

    // File search navigation
    if (showFileSearch && fileSearchResults.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedFileIndex((i) => Math.min(i + 1, fileSearchResults.length - 1));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedFileIndex((i) => Math.max(i - 1, 0));
        return;
      }
      // Tab or Enter to select file
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const selected = fileSearchResults[selectedFileIndex];
        if (selected && atPosition !== null) {
          // Replace @query with @path
          const before = inputValue.slice(0, atPosition);
          const after = inputValue.slice(textareaRef.current?.selectionStart || atPosition + fileSearchQuery.length + 1);
          setInputValue(`${before}@${selected.path} ${after}`);
          setShowFileSearch(false);
          setAtPosition(null);
        }
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setShowFileSearch(false);
        setAtPosition(null);
        return;
      }
    }

    // Normal send - but NOT during IME composition (e.g., Chinese input)
    // Check both event.nativeEvent.isComposing (standard) and event.keyCode === 229 (legacy)
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      if ((inputValue.trim() || images.length > 0) && isCurrentProviderAvailableRef.current) {
        handleSend();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- textareaRef is stable
  }, [cyclePermissionMode, undoStack, apiPost, showSlashMenu, filteredSlashCommands, slashSearchQuery, selectedSlashIndex, slashPosition, showFileSearch, fileSearchResults, selectedFileIndex, inputValue, atPosition, fileSearchQuery, images.length, handleSend, handleSkillSelect]);

  // Handler for selecting a slash command from the menu
  const handleSlashSelect = useCallback((cmd: SlashCommand) => {
    if (slashPosition !== null) {
      handleSkillSelect(cmd);
      const before = inputValue.slice(0, slashPosition);
      const after = inputValue.slice(textareaRef.current?.selectionStart || slashPosition + slashSearchQuery.length + 1);
      setInputValue(`${before}/${cmd.name} ${after}`);
      setShowSlashMenu(false);
      setSlashPosition(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- textareaRef is a stable ref
  }, [slashPosition, inputValue, slashSearchQuery, handleSkillSelect]);

  const toggleExpand = () => setIsExpanded((prev) => !prev);

  return (
    <div className={isLauncherMode
      ? 'relative flex w-full justify-center'
      : 'pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center px-4 pb-4'
    }>
      {/* Gradient fade overlay (chat mode only) */}
      {!isLauncherMode && (
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 h-32"
          style={{
            background: 'linear-gradient(to bottom, transparent, var(--paper-elevated) 60%)'
          }}
        />
      )}

      {/* Input container */}
      <div className={isLauncherMode
        ? 'relative w-full'
        : 'pointer-events-auto relative w-full max-w-3xl'
      }>
        {/* Queued messages floating above the input */}
        {!isLauncherMode && (
          <QueuedMessagesPanel
            messages={queuedMessages}
            onCancel={(queueId) => onCancelQueued?.(queueId)}
            onForceExecute={(queueId) => onForceExecuteQueued?.(queueId)}
          />
        )}

        {/* Cron task status bar - shows when cron mode enabled but task not started (always directly above input) */}
        {!isLauncherMode && cronModeEnabled && !cronTask && cronConfig && (
          <CronTaskStatusBar
            intervalMinutes={cronConfig.intervalMinutes}
            schedule={cronConfig.schedule}
            onSettings={() => onCronSettings?.()}
            onCancel={() => onCronCancel?.()}
          />
        )}

        <div className={`relative border border-[var(--line)] bg-[var(--paper-elevated)] shadow-md ${
          cronModeEnabled && !cronTask && cronConfig
            ? 'rounded-b-2xl rounded-t-none border-t-0'  // StatusBar visible: no top rounded, no top border
            : 'rounded-2xl'  // Normal: fully rounded
        }`}>
          {/* Cron task overlay - shows when task is running */}
          {!isLauncherMode && cronTask && cronTask.status === 'running' && (
            <CronTaskOverlay
              status={cronTask.status}
              intervalMinutes={cronTask.intervalMinutes}
              schedule={cronTask.schedule}
              executionCount={cronTask.executionCount}
              maxExecutions={cronTask.endConditions?.maxExecutions}
              nextExecutionTime={cronTask.lastExecutedAt
                ? new Date(new Date(cronTask.lastExecutedAt).getTime() + cronTask.intervalMinutes * 60000)
                : undefined}
              onStop={() => onCronStop?.()}
              onSettings={() => onCronSettings?.()}
            />
          )}
          {/* Clickable area for focus - covers input area but not toolbar */}
          <div
            className="cursor-text"
            onClick={(e) => {
              // Only focus if not clicking on a button or interactive element
              const target = e.target as HTMLElement;
              if (!target.closest('button') && !target.closest('input') && target.tagName !== 'TEXTAREA') {
                textareaRef.current?.focus();
              }
            }}
          >
          {/* Image attachments preview */}
          {images.length > 0 && (
            <div className="flex gap-2 px-4 pt-3 pb-1 overflow-x-auto">
              {images.map((img) => (
                <div key={img.id} className="relative group flex-shrink-0">
                  <img
                    src={img.preview}
                    alt="attachment"
                    className="h-16 w-16 rounded-lg object-cover border border-[var(--line)] cursor-pointer"
                    onDoubleClick={() => openPreview(img.preview, img.file.name)}
                  />
                  <button
                    type="button"
                    onClick={() => removeImage(img.id)}
                    className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-[var(--error)] text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                    title="删除图片"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Textarea area */}
          <div className="relative px-4 pt-3">
            <textarea
              ref={textareaRef}
              value={inputValue}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={isLauncherMode ? '输入 / 浏览 PM 技能，或直接描述任务...' : '输入消息，使用 @ 引用文件，/ 使用技能...'}
              rows={2}
              className="block w-full resize-none bg-transparent pr-8 text-base leading-relaxed text-[var(--ink)] outline-none placeholder:text-[var(--ink-muted)]"
              style={{
                minHeight: `${LINE_HEIGHT * 2}px`,
                maxHeight: `${LINE_HEIGHT * (isExpanded ? MAX_LINES_EXPANDED : MAX_LINES_COLLAPSED)}px`,
                overflowY: 'auto'
              }}
            />

            {/* @file search popup */}
            {showFileSearch && (
              <div className="absolute left-4 bottom-full mb-2 w-80 max-h-64 overflow-auto rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] shadow-xl">
                {fileSearchQuery.length === 0 ? (
                  <div className="px-3 py-2 text-sm text-[var(--ink-muted)]">
                    输入文件名搜索...
                  </div>
                ) : isFileSearching ? (
                  <div className="px-3 py-2 text-sm text-[var(--ink-muted)]">
                    搜索中...
                  </div>
                ) : fileSearchResults.length === 0 ? (
                  <div className="px-3 py-2 text-sm text-[var(--ink-muted)]">
                    未找到文件
                  </div>
                ) : (
                  fileSearchResults.map((file, idx) => (
                    <div
                      key={file.path}
                      className={`flex items-center gap-2 px-3 py-2 cursor-pointer text-sm ${idx === selectedFileIndex
                        ? 'bg-[var(--accent)]/10 text-[var(--ink)]'
                        : 'text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]'
                        }`}
                      onClick={() => {
                        if (atPosition !== null) {
                          const before = inputValue.slice(0, atPosition);
                          const after = inputValue.slice(textareaRef.current?.selectionStart || atPosition + fileSearchQuery.length + 1);
                          setInputValue(`${before}@${file.path} ${after}`);
                          setShowFileSearch(false);
                          setAtPosition(null);
                        }
                      }}
                    >
                      <FileText className="h-4 w-4 flex-shrink-0" />
                      <span className="truncate">{file.path}</span>
                    </div>
                  ))
                )}
              </div>
            )}

            {/* /slash command popup */}
            {showSlashMenu && (
              <SlashCommandMenu
                commands={filteredSlashCommands}
                selectedIndex={selectedSlashIndex}
                isEmpty={slashSearchQuery.length > 0 && filteredSlashCommands.length === 0}
                onSelect={handleSlashSelect}
              />
            )}

            {/* Expand/Collapse button - larger click area */}
            <button
              type="button"
              onClick={toggleExpand}
              className="absolute right-2 top-1.5 rounded-lg p-2 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
              title={isExpanded ? '收起' : '展开'}
            >
              {isExpanded ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronUp className="h-4 w-4" />
              )}
            </button>
          </div>
          </div>

          {/* Toolbar row — container query: hides text labels when narrow */}
          <div className="toolbar-menus flex items-center justify-between px-3 pb-2 pt-1 flex-nowrap min-w-0" style={{ containerType: 'inline-size' }}>
            {/* Left side - action buttons */}
            <div className="flex items-center gap-1 min-w-0 flex-nowrap">
              {/* Optional prefix (e.g., workspace selector in launcher mode) */}
              {toolbarPrefix}

              {/* Plus menu */}
              <div className="relative">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    // Close other menus first
                    setShowModeMenu(false);
                    setShowModelMenu(false);
                    setShowToolMenu(false);
                    setShowPlusMenu(!showPlusMenu);
                  }}
                  className="rounded-lg p-2 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                  title="添加上下文"
                >
                  <Plus className="h-4 w-4" />
                </button>
                {showPlusMenu && (
                  <div className="absolute left-0 bottom-full mb-1 w-48 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] shadow-xl py-1">
                    {!isLauncherMode && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        // Insert @ at cursor position and trigger file search
                        const textarea = textareaRef.current;
                        if (textarea) {
                          const cursorPos = textarea.selectionStart;
                          const before = inputValue.slice(0, cursorPos);
                          const after = inputValue.slice(cursorPos);
                          setInputValue(`${before}@${after}`);
                          setShowFileSearch(true);
                          setAtPosition(cursorPos);
                          setFileSearchQuery('');
                          textarea.focus();
                        }
                        setShowPlusMenu(false);
                      }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-sm text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                    >
                      <AtSign className="h-4 w-4" />
                      引用文件
                    </button>
                    )}
                    {!isLauncherMode && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        // Insert / at cursor position and trigger slash menu
                        const textarea = textareaRef.current;
                        if (textarea) {
                          const cursorPos = textarea.selectionStart;
                          const before = inputValue.slice(0, cursorPos);
                          const after = inputValue.slice(cursorPos);
                          setInputValue(`${before}/${after}`);
                          setShowSlashMenu(true);
                          setSlashPosition(cursorPos);
                          setSlashSearchQuery('');
                          setSelectedSlashIndex(0);
                          textarea.focus();
                        }
                        setShowPlusMenu(false);
                      }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-sm text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                    >
                      <span className="inline-flex h-4 w-4 items-center justify-center font-medium text-[var(--ink-muted)]">/</span>
                      使用技能
                    </button>
                    )}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        fileInputRef.current?.click();
                      }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-sm text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                    >
                      <Paperclip className="h-4 w-4" />
                      上传文件
                    </button>
                  </div>
                )}
              </div>

              {/* Hidden file input */}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={handleFileChange}
              />

              {/* Runtime Selector (v0.1.59) */}
              {runtimeDetections && onRuntimeChange && !isLauncherMode && (
                <RuntimeSelector
                  value={runtime}
                  detections={runtimeDetections}
                  onChange={onRuntimeChange}
                  variant="toolbar"
                  onOpenSettings={onOpenAgentSettings}
                />
              )}

              {/* Mode Dropdown */}
              <div className="relative">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowModeMenu(!showModeMenu);
                    setShowModelMenu(false);
                    setShowPlusMenu(false);
                    setShowToolMenu(false);
                  }}
                  className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-[13px] font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                  title="切换执行模式"
                >
                  <span>{currentModeDisplay?.icon}</span>
                  <span className="toolbar-label">{currentModeDisplay?.label}</span>
                  <ChevronUp className="h-3 w-3" />
                </button>
                {showModeMenu && (
                  <div className="absolute left-0 bottom-full mb-1 w-72 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] shadow-xl py-1">
                    <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--line)]">
                      <span className="text-xs font-medium text-[var(--ink-muted)]">会话模式</span>
                      {onOpenAgentSettings && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setShowModeMenu(false);
                            onOpenAgentSettings();
                          }}
                          className="text-xs font-medium text-[var(--accent)] hover:text-[var(--accent-warm-hover)] transition-colors"
                        >
                          Agent 设置
                        </button>
                      )}
                    </div>
                    {displayPermissionModes.map((mode) => (
                      <button
                        key={mode.value}
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (mode.value === 'fullAgency' || (mode.value as string) === 'bypassPermissions') {
                            toastRef.current.warning('自主行动已启用：Agent 可能做出不可挽回的操作，请谨慎使用', 5000);
                          }
                          onPermissionModeChange?.(mode.value);
                          setShowModeMenu(false);
                        }}
                        className={`flex w-full flex-col items-start px-3 py-2 text-left ${permissionMode === mode.value
                          ? 'bg-[var(--accent)]/10'
                          : 'hover:bg-[var(--hover-bg)]'
                          }`}
                      >
                        <span className={`text-sm font-medium flex items-center gap-1.5 ${permissionMode === mode.value ? 'text-[var(--accent)]' : 'text-[var(--ink)]'
                          }`}>
                          <span>{mode.icon}</span>
                          {mode.label}
                        </span>
                        <span className="text-xs text-[var(--ink-muted)] mt-0.5">{mode.description}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Tool/MCP Dropdown - hidden for external runtimes (they use their own tools) */}
              {!isExternalRuntime && (
              <div className="relative">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowToolMenu(!showToolMenu);
                    setShowModeMenu(false);
                    setShowModelMenu(false);
                    setShowPlusMenu(false);
                  }}
                  className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-[13px] font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                  title="使用工具"
                >
                  <Wrench className="h-3.5 w-3.5" />
                  <span className="toolbar-label">工具</span>
                  {workspaceMcpEnabled.length > 0 && (
                    <span className="text-[11px] text-[var(--ink-muted)]">
                      {workspaceMcpEnabled.length}
                    </span>
                  )}
                </button>
                {showToolMenu && (
                  <div className="absolute left-0 bottom-full mb-1 w-64 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] shadow-xl py-1">
                    <div className="px-3 py-2 text-xs font-medium text-[var(--ink-muted)] border-b border-[var(--line)]">
                      工具 (在此对话中启用)
                    </div>
                    {globalMcpEnabled.length > 0 ? (
                      mcpServers
                        .filter(s => globalMcpEnabled.includes(s.id))
                        .map((server) => {
                          const isEnabled = workspaceMcpEnabled.includes(server.id);
                          return (
                            <div
                              key={server.id}
                              className="flex items-center justify-between px-3 py-2"
                            >
                              <div className="flex-1 min-w-0">
                                <div className="text-sm font-medium text-[var(--ink)] truncate">
                                  {server.name}
                                </div>
                                {server.description && (
                                  <div className="text-xs text-[var(--ink-muted)] truncate">
                                    {server.description}
                                  </div>
                                )}
                              </div>
                              <button
                                type="button"
                                title="设置"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setShowToolMenu(false);
                                  window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_SETTINGS, { detail: { section: 'mcp', mcpServerId: server.id } }));
                                }}
                                className="ml-2 shrink-0 rounded p-0.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                              >
                                <Settings2 className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onWorkspaceMcpToggle?.(server.id, !isEnabled);
                                }}
                                className={`relative ml-2 inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors hover:opacity-80 focus:outline-none ${isEnabled ? 'bg-[var(--accent)]' : 'bg-[var(--line-strong)]'
                                  }`}
                              >
                                <span
                                  className={`pointer-events-none inline-block h-3.5 w-3.5 rounded-full bg-[var(--toggle-thumb)] shadow-sm ring-0 transition-transform ${isEnabled ? 'translate-x-4' : 'translate-x-0.5'
                                    }`}
                                />
                              </button>
                            </div>
                          );
                        })
                    ) : (
                      <div className="px-3 py-3 text-sm text-[var(--ink-muted)]">
                        在
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setShowToolMenu(false);
                            // Dispatch custom event to open Settings with MCP section
                            window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_SETTINGS, { detail: { section: 'mcp' } }));
                          }}
                          className="mx-1 text-[var(--accent)] hover:underline"
                        >
                          设置页面
                        </button>
                        安装开启 MCP 工具，即可使用浏览器等更多功能
                      </div>
                    )}
                  </div>
                )}
              </div>
              )}

              {/* Heartbeat Loop Button */}
              {!isLauncherMode && onCronButtonClick && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCronButtonClick();
                  }}
                  className={`flex items-center gap-1 rounded-lg px-2 py-1.5 text-[13px] font-medium transition-colors ${
                    cronModeEnabled
                      ? 'bg-[var(--heartbeat-bg)] text-[var(--heartbeat)] hover:bg-[var(--heartbeat)]/20'
                      : 'text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]'
                  }`}
                  title={cronModeEnabled ? '定时已启用' : '定时'}
                >
                  <Timer className="h-3.5 w-3.5" />
                  <span className="toolbar-label">定时</span>
                </button>
              )}
            </div>

            {/* Right side - model selector + send/stop button */}
            <div className="flex items-center gap-2 shrink-0">
              {/* Model Dropdown with Provider Selector */}
              <div className="relative">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    const willOpen = !showModelMenu;
                    setShowModelMenu(willOpen);
                    setShowModeMenu(false);
                    setShowPlusMenu(false);
                    setShowToolMenu(false);
                    // Refresh providers data when opening menu
                    if (willOpen && onRefreshProviders) {
                      onRefreshProviders();
                    }
                  }}
                  className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-[13px] font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                  title="切换模型"
                >
                  <span className="max-w-[140px] truncate">{currentModelName}</span>
                  <ChevronUp className="h-3 w-3 shrink-0" />
                </button>
                {showModelMenu && (isExternalRuntime && runtimeModels ? (
                  /* External Runtime model selector — shows CC/Codex models */
                  <div className="absolute right-0 bottom-full mb-1 w-64 max-h-[300px] overflow-y-auto rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] py-1 shadow-xl">
                    <div className="px-3 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--ink-muted)]/60">
                      {runtime === 'claude-code' ? 'CLAUDE CODE' : runtime?.toUpperCase()} 模型
                    </div>
                    {runtimeModels.map(model => {
                      const isSelected = selectedModel === model.value || (!selectedModel && model.isDefault);
                      return (
                        <button
                          key={model.value}
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onModelChange?.(model.value);
                            setShowModelMenu(false);
                          }}
                          className={`w-full rounded-md px-3 py-1.5 text-left text-[13px] transition-colors ${
                            isSelected
                              ? 'bg-[var(--accent)]/10 font-medium text-[var(--accent)]'
                              : 'text-[var(--ink)] hover:bg-[var(--hover-bg)]'
                          }`}
                        >
                          {model.displayName}
                        </button>
                      );
                    })}
                  </div>
                ) : showModelMenu && (() => {
                  /* Builtin Runtime model selector — original provider-based */
                  const availableProviders = (providers ?? []).filter(p => isProviderAvailable(p, apiKeys, providerVerifyStatus));
                  return (
                    <div className="absolute right-0 bottom-full mb-1 w-64 max-h-[300px] overflow-y-auto rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] py-1 shadow-xl">
                      {availableProviders.length === 0 ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setShowModelMenu(false);
                            window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_SETTINGS, {
                              detail: { section: 'providers' }
                            }));
                          }}
                          className="w-full px-3 py-2.5 text-left text-[13px] text-[var(--accent)] transition-colors hover:bg-[var(--hover-bg)]"
                        >
                          请先设置模型服务 →
                        </button>
                      ) : (
                        availableProviders.map((p, idx) => (
                          <div key={p.id}>
                            {idx > 0 && <div className="mx-2 my-1 border-t border-[var(--line)]" />}
                            <div className="group/provider relative flex items-center gap-1 px-3 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--ink-muted)]/60">
                              {p.name}{p.type === 'subscription' ? ' (订阅)' : ''}
                              {isProviderWarning(p, apiKeys, providerVerifyStatus) && (
                                <Tip label="验证未通过，部分模型可能不可用" position="bottom">
                                  <AlertCircle className="h-3 w-3 shrink-0 text-[var(--warning)]" />
                                </Tip>
                              )}
                            </div>
                            {p.models.map(model => {
                              const isSelected = provider?.id === p.id && currentModelId === model.model;
                              return (
                                <button
                                  key={model.model}
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (provider?.id !== p.id) {
                                      onProviderChange?.(p.id, model.model);
                                    } else {
                                      onModelChange?.(model.model);
                                    }
                                    setShowModelMenu(false);
                                  }}
                                  className={`w-full rounded-md px-3 py-1.5 text-left text-[13px] transition-colors ${
                                    isSelected
                                      ? 'bg-[var(--accent)]/10 font-medium text-[var(--accent)]'
                                      : 'text-[var(--ink)] hover:bg-[var(--hover-bg)]'
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
                })())}
              </div>

              {/* Button states: system task (disabled send) → stopping (disabled spinner) → AI responding (stop) → normal (send) */}
              {systemStatus ? (
                // System task running (e.g., compacting, api_retry) - not interruptible
                <button
                  type="button"
                  disabled
                  className="rounded-lg bg-[var(--ink-muted)]/15 p-2 text-[var(--ink-muted)]/60"
                  title={systemStatus.startsWith('api_retry:') ? 'API 请求重试中，请稍等' : '正在执行系统任务，请稍等'}
                >
                  <Send className="h-4 w-4" />
                </button>
              ) : isLoading && sessionState === 'stopping' ? (
                // Stop in progress - waiting for confirmation
                <button
                  type="button"
                  disabled
                  className="rounded-lg bg-[var(--ink-muted)]/15 p-2 text-[var(--ink-muted)]"
                  title="正在停止..."
                >
                  <Loader className="h-4 w-4 animate-spin" />
                </button>
              ) : isLoading ? (
                // AI responding - can be stopped
                <button
                  type="button"
                  onClick={onStop}
                  className="rounded-lg bg-[var(--error)] p-2 text-white transition-colors hover:brightness-110"
                  title="停止"
                >
                  <Square className="h-4 w-4" />
                </button>
              ) : (
                // Normal state - can send
                <button
                  type="button"
                  onClick={handleSend}
                  disabled={!isCurrentProviderAvailable || (!inputValue.trim() && images.length === 0)}
                  className="rounded-lg bg-[var(--accent)] p-2 text-white transition-colors hover:bg-[var(--accent-warm-hover)] disabled:bg-[var(--ink-muted)]/15 disabled:text-[var(--ink-muted)]/60"
                  title={!isCurrentProviderAvailable ? '请前往设置页面设置模型供应商' : '发送'}
                >
                  <Send className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}));

export default SimpleChatInput;
