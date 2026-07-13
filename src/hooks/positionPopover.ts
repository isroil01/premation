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

  const candidates: Placement[] =
    baseSide === 'bottom' ? ['bottom', 'top', 'right', 'left'] :
    baseSide === 'top'    ? ['top', 'bottom', 'right', 'left'] :
    baseSide === 'left'   ? ['left', 'right', 'top', 'bottom'] :
                             ['right', 'left', 'top', 'bottom'];

  for (const p of candidates) {
    const side = p.split('-')[0] as 'top' | 'bottom' | 'left' | 'right';
    const a = (p.split('-')[1] ?? 'center') as 'start' | 'center' | 'end';
    let top = 0, left = 0;
    switch (side) {
      case 'top':
        top = tr.top - pr.height - GAP + offset.y;
        if (a === 'start') left = tr.left + offset.x;
        else if (a === 'end') left = tr.right - pr.width + offset.x;
        else left = tr.left + tr.width / 2 - pr.width / 2 + offset.x;
        break;
      case 'bottom':
        top = tr.bottom + GAP + offset.y;
        if (a === 'start') left = tr.left + offset.x;
        else if (a === 'end') left = tr.right - pr.width + offset.x;
        else left = tr.left + tr.width / 2 - pr.width / 2 + offset.x;
        break;
      case 'left':
        left = tr.left - pr.width - GAP + offset.x;
        if (a === 'start') top = tr.top + offset.y;
        else if (a === 'end') top = tr.bottom - pr.height + offset.y;
        else top = tr.top + tr.height / 2 - pr.height / 2 + offset.y;
        break;
      case 'right':
        left = tr.right + GAP + offset.x;
        if (a === 'start') top = tr.top + offset.y;
        else if (a === 'end') top = tr.bottom - pr.height + offset.y;
        else top = tr.top + tr.height / 2 - pr.height / 2 + offset.y;
        break;
    }
    if (top >= 0 && left >= 0 && top + pr.height <= vh && left + pr.width <= vw) {
      return { top, left, placement: p as Placement };
    }
  }
  // Fallback — requested placement, may overflow.
  const fallback = candidates[0]!;
  const side = fallback.split('-')[0] as 'top' | 'bottom' | 'left' | 'right';
  const a = (fallback.split('-')[1] ?? 'center') as 'start' | 'center' | 'end';
  let top = 0, left = 0;
  switch (side) {
    case 'top':
      top = tr.top - pr.height - GAP;
      if (a === 'start') left = tr.left;
      else if (a === 'end') left = tr.right - pr.width;
      else left = tr.left + tr.width / 2 - pr.width / 2;
      break;
    case 'bottom':
      top = tr.bottom + GAP;
      if (a === 'start') left = tr.left;
      else if (a === 'end') left = tr.right - pr.width;
      else left = tr.left + tr.width / 2 - pr.width / 2;
      break;
    case 'left':
      left = tr.left - pr.width - GAP;
      if (a === 'start') top = tr.top;
      else if (a === 'end') top = tr.bottom - pr.height;
      else top = tr.top + tr.height / 2 - pr.height / 2;
      break;
    case 'right':
      left = tr.right + GAP;
      if (a === 'start') top = tr.top;
      else if (a === 'end') top = tr.bottom - pr.height;
      else top = tr.top + tr.height / 2 - pr.height / 2;
      break;
  }
  return { top, left, placement: fallback as Placement };
}
