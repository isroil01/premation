/**
 * usePortal — mount children to document.body via a portal.
 * Returns a stable element ref and an `open` callback. Closes on Escape
 * and on outside click (configurable).
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface UsePortalOptions {
  /** Close on outside pointerdown. Default true. */
  closeOnOutside?: boolean;
  /** Close on Escape. Default true. */
  closeOnEscape?: boolean;
  /** Initial open state. */
  defaultOpen?: boolean;
}

export interface PortalResult {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
  bind: {
    onPointerDown: (e: React.PointerEvent) => void;
  };
  render: (children: ReactNode) => ReactNode;
}

export function usePortal(options: UsePortalOptions = {}): PortalResult {
  const { closeOnOutside = true, closeOnEscape = true, defaultOpen = false } = options;
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  const close = useCallback(() => setIsOpen(false), []);
  const open = useCallback(() => setIsOpen(true), []);
  const toggle = useCallback(() => setIsOpen((s) => !s), []);

  useEffect(() => {
    if (!isOpen) return;
    if (closeOnEscape) {
      const onKey = (e: KeyboardEvent): void => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          setIsOpen(false);
        }
      };
      window.addEventListener('keydown', onKey, true);
      return () => window.removeEventListener('keydown', onKey, true);
    }
    return undefined;
  }, [isOpen, closeOnEscape]);

  useEffect(() => {
    if (!isOpen || !closeOnOutside) return;
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Node;
      if (contentRef.current?.contains(t)) return;
      if (triggerRef.current?.contains(t)) return;
      setIsOpen(false);
    };
    // Defer so the opening click doesn't immediately close.
    const id = window.setTimeout(() => {
      window.addEventListener('pointerdown', onDown);
    }, 0);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener('pointerdown', onDown);
    };
  }, [isOpen, closeOnOutside]);

  const render = useCallback(
    (children: ReactNode): ReactNode => {
      if (!isOpen) return null;
      return createPortal(
        <div ref={contentRef} data-portal="true">
          {children}
        </div>,
        document.body,
      );
    },
    [isOpen],
  );

  return {
    isOpen,
    open,
    close,
    toggle,
    bind: {
      onPointerDown: (e: React.PointerEvent) => {
        triggerRef.current = e.currentTarget as HTMLElement;
      },
    },
    render,
  };
}
