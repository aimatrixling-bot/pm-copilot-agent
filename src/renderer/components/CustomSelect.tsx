/**
 * CustomSelect - Custom dropdown select component
 * Replaces native <select> with styled dropdown matching design system.
 * Uses fixed positioning so dropdown is never clipped by overflow:hidden parents.
 */

import { Check, ChevronDown } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

export interface SelectOption {
    value: string;
    label: string;
    icon?: ReactNode;
    /** Right-aligned suffix content (e.g., status badge) */
    suffix?: ReactNode;
    /** Renders as a non-selectable section header/divider */
    isSeparator?: boolean;
}

interface CustomSelectProps {
    value: string;
    options: SelectOption[];
    onChange: (value: string) => void;
    placeholder?: string;
    triggerIcon?: ReactNode;
    className?: string;
    compact?: boolean;
    footerAction?: {
        label: string;
        icon?: ReactNode;
        onClick: () => void;
    };
}

export default function CustomSelect({
    value,
    options,
    onChange,
    placeholder = '请选择',
    triggerIcon,
    className,
    compact,
    footerAction,
}: CustomSelectProps) {
    const [isOpen, setIsOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});

    // Compute dropdown position from trigger's bounding rect
    // Auto-detect: open upward when not enough space below
    const updatePosition = useCallback(() => {
        if (!triggerRef.current) return;
        const rect = triggerRef.current.getBoundingClientRect();
        const maxDropdownHeight = 240; // max-h-60 = 15rem = 240px
        const spaceBelow = window.innerHeight - rect.bottom;
        const openUpward = spaceBelow < maxDropdownHeight && rect.top > spaceBelow;
        setDropdownStyle({
            position: 'fixed',
            left: rect.left,
            width: rect.width,
            ...(openUpward
                ? { bottom: window.innerHeight - rect.top + 4 }
                : { top: rect.bottom + 4 }),
        });
    }, []);

    useEffect(() => {
        if (!isOpen) return;
        updatePosition();
    }, [isOpen, updatePosition]);

    // Reposition dropdown on scroll/resize to prevent detachment from trigger
    useEffect(() => {
        if (!isOpen) return;
        const handleRepositionOrClose = () => updatePosition();
        window.addEventListener('scroll', handleRepositionOrClose, true);
        window.addEventListener('resize', handleRepositionOrClose);
        return () => {
            window.removeEventListener('scroll', handleRepositionOrClose, true);
            window.removeEventListener('resize', handleRepositionOrClose);
        };
    }, [isOpen, updatePosition]);

    // Close on click outside
    useEffect(() => {
        if (!isOpen) return;
        const handleClickOutside = (e: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [isOpen]);

    const selectedOption = options.find(o => o.value === value);

    const handleSelect = useCallback((optionValue: string) => {
        onChange(optionValue);
        setIsOpen(false);
    }, [onChange]);

    return (
        <div ref={containerRef} className={`relative ${className ?? ''}`}>
            {/* Trigger */}
            <button
                ref={triggerRef}
                type="button"
                onClick={() => setIsOpen(!isOpen)}
                className={`flex w-full items-center gap-2 rounded-lg border border-[var(--line)] bg-[var(--paper)] text-left transition-colors hover:border-[var(--ink-subtle)] ${compact ? 'px-2 py-1 text-[11px]' : 'px-3 py-2 text-xs'}`}
            >
                {triggerIcon && (
                    <span className="shrink-0 text-[var(--ink-muted)]">{triggerIcon}</span>
                )}
                <span className={`min-w-0 flex-1 truncate ${selectedOption ? 'text-[var(--ink)]' : 'text-[var(--ink-muted)]'}`}>
                    {selectedOption?.label ?? placeholder}
                </span>
                <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-[var(--ink-muted)] transition-transform ${isOpen ? 'rotate-180' : ''}`} />
            </button>

            {/* Dropdown panel — fixed position to escape overflow clipping */}
            {isOpen && (
                <div
                    className="z-[300] max-h-60 overflow-auto rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] py-1 shadow-md"
                    style={dropdownStyle}
                >
                    {options.map(option =>
                        option.isSeparator ? (
                            <div key={option.value} className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--ink-muted)]/50">
                                {option.label}
                            </div>
                        ) : (
                        <button
                            key={option.value}
                            type="button"
                            onClick={() => handleSelect(option.value)}
                            className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
                                option.value === value
                                    ? 'text-[var(--accent-warm)]'
                                    : 'text-[var(--ink)] hover:bg-[var(--paper-inset)]'
                            }`}
                        >
                            {option.icon && (
                                <span className="shrink-0">{option.icon}</span>
                            )}
                            <span className="min-w-0 flex-1 truncate">{option.label}</span>
                            {option.suffix && (
                                <span className="shrink-0">{option.suffix}</span>
                            )}
                            {option.value === value && (
                                <Check className="h-3 w-3 shrink-0" />
                            )}
                        </button>
                        )
                    )}

                    {/* Footer action */}
                    {footerAction && (
                        <>
                            <div className="my-1 border-t border-[var(--line)]" />
                            <button
                                type="button"
                                onClick={() => {
                                    setIsOpen(false);
                                    footerAction.onClick();
                                }}
                                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                            >
                                {footerAction.icon && (
                                    <span className="shrink-0">{footerAction.icon}</span>
                                )}
                                <span>{footerAction.label}</span>
                            </button>
                        </>
                    )}
                </div>
            )}
        </div>
    );
}
