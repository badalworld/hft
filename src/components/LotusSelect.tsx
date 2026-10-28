import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, ChevronDown } from 'lucide-react';

export interface LotusSelectOption {
  value: string;
  label: string;
  badge?: string;
}

interface LotusSelectProps {
  value: string;
  options: LotusSelectOption[];
  onChange: (nextValue: string) => void;
  disabled?: boolean;
  className?: string;
  size?: 'sm' | 'md';
  ariaLabel?: string;
}

interface MenuCoords {
  top?: number;
  bottom?: number;
  left: number;
  width: number;
  openUpward: boolean;
}

export const LotusSelect: React.FC<LotusSelectProps> = ({
  value,
  options,
  onChange,
  disabled = false,
  className = '',
  size = 'md',
  ariaLabel,
}) => {
  const [open, setOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState<number>(0);
  const [coords, setCoords] = useState<MenuCoords | null>(null);

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const selectedOption =
    options.find((opt) => opt.value === value) || options[0] || { value: '', label: '' };

  const computeCoords = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const spaceBelow = vh - rect.bottom;
    const estHeight = Math.min(280, options.length * 40 + 18);
    const openUpward = spaceBelow < estHeight + 16 && rect.top > spaceBelow;

    const menuWidth = Math.min(vw - 24, Math.max(rect.width, 210));
    const left = Math.max(12, Math.min(rect.left, vw - menuWidth - 12));

    if (openUpward) {
      setCoords({
        bottom: vh - rect.top + 6,
        left,
        width: menuWidth,
        openUpward: true,
      });
    } else {
      setCoords({
        top: rect.bottom + 6,
        left,
        width: menuWidth,
        openUpward: false,
      });
    }
  }, [options.length]);

  useLayoutEffect(() => {
    if (!open) return;
    computeCoords();
    const idx = options.findIndex((o) => o.value === value);
    setHighlightIdx(idx >= 0 ? idx : 0);
  }, [open, computeCoords, options, value]);

  useEffect(() => {
    if (!open) return;

    const handleOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        triggerRef.current &&
        !triggerRef.current.contains(target) &&
        menuRef.current &&
        !menuRef.current.contains(target)
      ) {
        setOpen(false);
      }
    };

    const handleScrollOrResize = (e: Event) => {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) {
        return;
      }
      computeCoords();
    };

    window.addEventListener('mousedown', handleOutside);
    window.addEventListener('resize', handleScrollOrResize);
    window.addEventListener('scroll', handleScrollOrResize, true);
    return () => {
      window.removeEventListener('mousedown', handleOutside);
      window.removeEventListener('resize', handleScrollOrResize);
      window.removeEventListener('scroll', handleScrollOrResize, true);
    };
  }, [open, computeCoords]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
      } else {
        setHighlightIdx((prev) => (prev + 1) % options.length);
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
      } else {
        setHighlightIdx((prev) => (prev - 1 + options.length) % options.length);
      }
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
      } else {
        const chosen = options[highlightIdx];
        if (chosen) {
          onChange(chosen.value);
          setOpen(false);
        }
      }
    } else if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        setOpen(false);
      }
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  const sizeClasses =
    size === 'sm'
      ? 'rounded-lg px-2.5 py-1 text-[11px]'
      : 'rounded-xl px-3 py-2 text-xs';

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => !disabled && setOpen((prev) => !prev)}
        onKeyDown={handleKeyDown}
        className={`skeuo-input flex items-center justify-between gap-2.5 text-left font-medium text-[#fdf6f5] transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
          open
            ? '!border-[#EBAEE6]/75 shadow-[inset_0_3px_8px_rgba(4,1,1,0.94),0_0_0_2px_rgba(235,174,230,0.24)]'
            : 'hover:border-[#EBAEE6]/45'
        } ${sizeClasses} ${className}`}
      >
        <span className="flex min-w-0 items-center gap-2 truncate">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full led-mint" />
          <span className="truncate">{selectedOption.label}</span>
        </span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-[#EBAEE6] transition-transform duration-150 ${
            open ? 'rotate-180 text-[#ADEBB3]' : ''
          }`}
        />
      </button>

      {typeof document !== 'undefined' &&
        createPortal(
          <AnimatePresence>
            {open && coords && (
              <motion.div
                ref={menuRef}
                role="listbox"
                initial={{
                  opacity: 0,
                  scale: 0.97,
                  y: coords.openUpward ? 6 : -6,
                }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{
                  opacity: 0,
                  scale: 0.97,
                  y: coords.openUpward ? 4 : -4,
                }}
                transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
                style={{
                  position: 'fixed',
                  top: coords.top,
                  bottom: coords.bottom,
                  left: coords.left,
                  width: coords.width,
                  zIndex: 130,
                }}
                className="skeuo-dropdown-menu overflow-hidden rounded-xl"
              >
                {/* Lotus Garden Top 4-Color Accent Strip */}
                <div className="lotus-ribbon h-[2.5px] w-full opacity-95" />

                <div className="max-h-64 overflow-y-auto p-1.5 space-y-0.5">
                  {options.map((opt, idx) => {
                    const isSelected = opt.value === value;
                    const isHighlighted = idx === highlightIdx;

                    return (
                      <button
                        key={opt.value}
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        onMouseEnter={() => setHighlightIdx(idx)}
                        onClick={() => {
                          onChange(opt.value);
                          setOpen(false);
                        }}
                        className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors cursor-pointer ${
                          isSelected
                            ? 'border border-[#ADEBB3]/45 bg-[#ADEBB3]/18 font-semibold text-[#ADEBB3]'
                            : isHighlighted
                            ? 'bg-[#6B403C]/75 text-white'
                            : 'text-[#f4e4e2] hover:bg-[#6B403C]/55 hover:text-white'
                        }`}
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <span
                            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                              isSelected
                                ? 'led-mint'
                                : isHighlighted
                                ? 'bg-[#EBAEE6]'
                                : 'bg-[#6B403C]'
                            }`}
                          />
                          <span className="truncate">{opt.label}</span>
                        </div>

                        <div className="flex shrink-0 items-center gap-1.5">
                          {opt.badge && (
                            <span className="rounded border border-[#EBAEE6]/35 bg-[#EBAEE6]/15 px-1.5 py-0.5 font-mono-num text-[9px] text-[#EBAEE6]">
                              {opt.badge}
                            </span>
                          )}
                          {isSelected && <Check className="h-3.5 w-3.5 text-[#ADEBB3]" />}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </motion.div>
            )}
          </AnimatePresence>,
          document.body
        )}
    </>
  );
};
