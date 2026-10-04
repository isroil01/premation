/**
 * Lift, Extract and Ripple Delete.
 *
 * The whole feature is one boolean — does the hole close — so the test that
 * matters is the one that runs the SAME range through both and shows the
 * difference in where the bar after it ends up. Everything else about these
 * three is shared code, and a test per verb would just be the same assertions
 * three times.
 *
 * The boundary predicates are tested separately and exhaustively, because they
 * are where an off-by-one leaves a one-frame sliver at every cut — which nobody
 * notices until a delivered file has a black flash in it. `Clip.end` is
 * EXCLUSIVE; both predicates are written against that and would silently
 * disagree with the engine if it were not.
 */

import { barIsInsideRange, barStraddles } from './rangeEdits';

import { useProjectStore } from '@stores/projectStore';
import { CommandSystem, setCommandSystem } from '@core/commands/CommandSystem';

describe('range boundaries', () => {
  it('counts a bar that ends exactly at the range end as inside', () => {
    // `end` is EXCLUSIVE, so a bar occupying frames 10..19 has end 20 and is
    // wholly inside [10, 20). Treating this as a straddle leaves a zero-length
    // piece behind at every cut.
    expect(barIsInsideRange({ start: 10, end: 20 }, 10, 20)).toBe(true);
  });

  it('does not count a bar that pokes out of either side', () => {
    expect(barIsInsideRange({ start: 9, end: 20 }, 10, 20)).toBe(false);
    expect(barIsInsideRange({ start: 10, end: 21 }, 10, 20)).toBe(false);
  });

  it('straddles only STRICTLY inside — a boundary that touches an edge is not a cut', () => {
    expect(barStraddles({ start: 0, end: 30 }, 15)).toBe(true);
    // Splitting at a bar's own start or end produces a zero-length piece.
    expect(barStraddles({ start: 0, end: 30 }, 0)).toBe(false);
    expect(barStraddles({ start: 0, end: 30 }, 30)).toBe(false);
  });
});

beforeEach(() => {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
  useProjectStore.getState().actions.replaceComps({
    comp_root: {
      id: 'comp_root', name: 'Main', width: 1920, height: 1080, fps: 30,
      durationSeconds: 10, background: '#101014', transparent: false, startFrame: 0,
    },
  });
  const proj = useProjectStore.getState();
  const tabId = proj.actions.openTab('comp_root', ['comp_root'], 'Main');
  proj.actions.setActiveTab(tabId);
});
