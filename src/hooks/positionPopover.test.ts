import { positionPopover, type Placement } from './positionPopover';

/** Build a fake element whose getBoundingClientRect returns the given rect. */
function el(rect: Partial<DOMRect>): HTMLElement {
  const r = { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, ...rect } as DOMRect;
  return { getBoundingClientRect: () => r } as unknown as HTMLElement;
}

const VW = 1280;
const VH = 800;

beforeAll(() => {
  Object.defineProperty(window, 'innerWidth', { value: VW, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: VH, configurable: true });
});

describe('positionPopover', () => {
  it('places a bottom-start dropdown directly under its trigger', () => {
    const trigger = el({ top: 100, bottom: 120, left: 200, right: 260, width: 60, height: 20 });
    const pop = el({ width: 160, height: 200 });
    const { top, left, placement } = positionPopover(trigger, pop, 'bottom-start');
    expect(placement).toBe('bottom-start');
    expect(top).toBe(124); // trigger.bottom + GAP(4)
    expect(left).toBe(200); // aligned to trigger.left
  });

  it('right-aligns a bottom-end dropdown to the trigger', () => {
    const trigger = el({ top: 100, bottom: 120, left: 900, right: 1000, width: 100, height: 20 });
    const pop = el({ width: 160, height: 200 });
    const { left, placement } = positionPopover(trigger, pop, 'bottom-end');
    expect(placement).toBe('bottom-end');
    expect(left).toBe(1000 - 160); // trigger.right - pop.width
  });

  it('flips to top (not to the side) when there is no room below', () => {
    // Trigger near the bottom of a tall right-sidebar; a 300px menu cannot fit below.
    const trigger = el({ top: 700, bottom: 720, left: 1100, right: 1200, width: 100, height: 20 });
    const pop = el({ width: 160, height: 300 });
    const { top, left, placement } = positionPopover(trigger, pop, 'bottom-end');
    expect(placement.startsWith('top')).toBe(true); // flipped vertically, not sideways
    expect(top).toBe(720 - 20 - 300 - 4); // above the trigger: tr.top - GAP - height
    // Still horizontally aligned to the trigger (right edge), not shoved to the left of it.
    expect(left).toBe(1200 - 160);
  });

  it('clamps horizontally so the menu never runs off the right edge', () => {
    // A wide menu on a trigger at the far right would overflow; it clamps inward.
    const trigger = el({ top: 100, bottom: 120, left: 1240, right: 1270, width: 30, height: 20 });
    const pop = el({ width: 200, height: 150 });
    const { left, placement } = positionPopover(trigger, pop, 'bottom-start');
    expect(placement).toBe('bottom-start');
    expect(left).toBe(VW - 200 - 8); // clamped to viewport minus MARGIN(8)
    expect(left + 200).toBeLessThanOrEqual(VW);
  });

  it('keeps a fitting menu on the requested bottom side', () => {
    const trigger = el({ top: 50, bottom: 70, left: 400, right: 500, width: 100, height: 20 });
    const pop = el({ width: 120, height: 100 });
    const placements: Placement[] = ['bottom', 'bottom-start', 'bottom-end'];
    for (const p of placements) {
      expect(positionPopover(trigger, pop, p).placement.startsWith('bottom')).toBe(true);
    }
  });
});
