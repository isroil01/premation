/**
 * Position a floating popover near a trigger element. Computes coords with
 * flip logic and viewport clamping. Returns absolute coords (top/left) plus
 * the resolved placement (which may have flipped from the requested one).
 */

export type Placement = 'top' | 'top-start' | 'top-end'
                      | 'bottom' | 'bottom-start' | 'bottom-end'
                      | 'left' | 'left-start' | 'left-end'
                      | 'right' | 'right-start' | 'right-end';

export interface ResolvedPosition {
  top: number;
  left: number;
  placement: Placement;
}

const GAP = 4;
/** Keep the popover this far from the viewport edge when clamping. */
const MARGIN = 8;

export function positionPopover(
  trigger: HTMLElement,
  pop: HTMLElement,
  requested: Placement,
  offset: { x: number; y: number } = { x: 0, y: 0 },
): ResolvedPosition {
  const tr = trigger.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const baseSide = requested.split('-')[0] as 'top' | 'bottom' | 'left' | 'right';
  const align = (requested.split('-')[1] ?? 'center') as 'start' | 'center' | 'end';

  // Horizontal position for a vertically-placed (top/bottom) popover, aligned
  // to the trigger per the requested alignment.
  const alignX = (): number => {
    if (align === 'start') return tr.left + offset.x;
    if (align === 'end') return tr.right - pr.width + offset.x;
    return tr.left + tr.width / 2 - pr.width / 2 + offset.x;
  };
  // Vertical position for a horizontally-placed (left/right) popover.
  const alignY = (): number => {
    if (align === 'start') return tr.top + offset.y;
    if (align === 'end') return tr.bottom - pr.height + offset.y;
    return tr.top + tr.height / 2 - pr.height / 2 + offset.y;
  };

  let side = baseSide;
  let top = 0;
  let left = 0;

  if (baseSide === 'bottom' || baseSide === 'top') {
    // A dropdown flips ONLY between bottom and top — never to the side, so it
    // stays vertically adjacent to (and horizontally aligned with) its trigger.
    const belowTop = tr.bottom + GAP + offset.y;
    const aboveTop = tr.top - pr.height - GAP + offset.y;
    const fitsBelow = belowTop + pr.height <= vh - MARGIN;
    const fitsAbove = aboveTop >= MARGIN;
    if (baseSide === 'bottom') side = fitsBelow || !fitsAbove ? 'bottom' : 'top';
    else side = fitsAbove || !fitsBelow ? 'top' : 'bottom';
    top = side === 'bottom' ? belowTop : aboveTop;
    left = alignX();
  } else {
    // Side popovers flip only between left and right.
    const rightLeft = tr.right + GAP + offset.x;
    const leftLeft = tr.left - pr.width - GAP + offset.x;
    const fitsRight = rightLeft + pr.width <= vw - MARGIN;
    const fitsLeft = leftLeft >= MARGIN;
    if (baseSide === 'right') side = fitsRight || !fitsLeft ? 'right' : 'left';
    else side = fitsLeft || !fitsRight ? 'left' : 'right';
    left = side === 'right' ? rightLeft : leftLeft;
    top = alignY();
  }

  // Clamp into the viewport along the cross axis so the popover never runs off
  // screen (it stays aligned to the trigger on its primary axis).
  left = Math.max(MARGIN, Math.min(left, vw - pr.width - MARGIN));
  top = Math.max(MARGIN, Math.min(top, vh - pr.height - MARGIN));

  const placement = (align !== 'center' ? `${side}-${align}` : side) as Placement;
  return { top, left, placement };
}
