/**
 * Popover — generic floating content anchored to a trigger.
 *
 * For pre-built menus and dropdowns, prefer <Menu> or <Dropdown>.
 * Popover is the unstyled primitive underneath them.
 */

import {
  cloneElement,
  isValidElement,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@utils/cn';
import { positionPopover, type Placement } from '@hooks/positionPopover';
import styles from './Popover.module.css';

export interface PopoverProps {
  trigger: ReactElement;
  children: ReactNode;
  placement?: Placement;
  offset?: { x: number; y: number };
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  closeOnOutside?: boolean;
  closeOnEscape?: boolean;
  /** Positioning only — no background/border/radius, for wrapping a chromed child. */
  bare?: boolean;
}

export function Popover({
  trigger,
  children,
  placement = 'bottom-start',
  offset,
  open: controlled,
  onOpenChange,
  className,
  closeOnOutside = true,
  closeOnEscape = true,
  bare = false,
}: PopoverProps): JSX.Element {
  const [internalOpen, setInternalOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number; placement: Placement } | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  const isControlled = controlled !== undefined;
  const isOpen = isControlled ? !!controlled : internalOpen;

  const setOpen = (v: boolean): void => {
    if (!isControlled) setInternalOpen(v);
    onOpenChange?.(v);
  };

  useEffect(() => {
    if (!isOpen) return;
    const trigger = triggerRef.current;
    const pop = popRef.current;
    if (!trigger || !pop) return;
    
    let rafId: number;
    const updatePosition = () => {
      setCoords(positionPopover(trigger, pop, placement, offset));
    };

    updatePosition();
    // Schedule on next frame to catch any rendering height/width updates
    rafId = requestAnimationFrame(updatePosition);

    const onScroll = (): void => updatePosition();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [isOpen, placement, offset]);

  useEffect(() => {
    if (!isOpen) return;
    if (closeOnEscape) {
      const onKey = (e: KeyboardEvent): void => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          setOpen(false);
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
      if (popRef.current?.contains(t)) return;
      if (triggerRef.current?.contains(t)) return;
      // Submenus portal to document.body outside popRef; without this a click on
      // a submenu item closes the popover before the item's click can fire.
      if ((t as Element).closest?.('[data-menu-portal]')) return;
      setOpen(false);
    };
    const id = window.setTimeout(() => window.addEventListener('pointerdown', onDown), 0);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener('pointerdown', onDown);
    };
  }, [isOpen, closeOnOutside]);

  if (!isValidElement(trigger)) return <></>;

  const cloned = cloneElement(trigger as ReactElement<Record<string, unknown>>, {
    ref: (node: HTMLElement | null) => {
      triggerRef.current = node;
      const orig = (trigger as unknown as { ref?: unknown }).ref;
      if (typeof orig === 'function') (orig as (n: HTMLElement | null) => void)(node);
      else if (orig && 'current' in (orig as { current: unknown })) {
        (orig as { current: HTMLElement | null }).current = node;
      }
    },
    onClick: (e: React.MouseEvent) => {
      setOpen(!isOpen);
      const orig = (trigger.props as { onClick?: (e: React.MouseEvent) => void }).onClick;
      orig?.(e);
    },
  });

  return (
    <>
      {cloned}
      {isOpen ? createPortal(
        <div
          ref={popRef}
          className={cn(styles.pop, bare && styles.bare, className)}
          data-placement={coords?.placement ?? placement}
          style={coords ? { top: coords.top, left: coords.left } : undefined}
        >
          {children}
        </div>,
        document.body,
      ) : null}
    </>
  );
}
