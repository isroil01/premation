/**
 * Wave-B viewport UX contracts:
 *   • Shift = axis lock on a 2D move (dominant axis, live re-evaluated,
 *     survives snapping) — the single biggest AE-parity gap in 2D manipulation.
 *   • The drag HUD: a move publishes its Δ as overlay.dragHud, cleared on
 *     release — the 2D twin of the 3D gizmo's measurement badge.
 *   • Hover: the grip under an idle cursor is flagged `hovered` so the painter
 *     can light it (cursor-only hover feedback was the old behaviour).
 */

import { Workspace } from '../Workspace';
import { MemoryScene, MemorySelection, RecordingCommandPort } from '../adapters/memory';
import { WorkspaceCommandType } from '../commands/WorkspaceCommands';
import { NO_MODIFIERS, type PointerInput, type Modifiers } from '../input/events';
import * as R from '../math/Rect';

let clock = 0;
function pointer(x: number, y: number, patch: Partial<PointerInput> = {}): PointerInput {
  clock += 1;
  return {
    position: { x, y },
    pointerType: 'mouse',
    button: 'left',
    buttons: { left: true, middle: false, right: false },
    modifiers: NO_MODIFIERS,
    pressure: 0.5,
    time: clock,
    pointerId: 1,
    ...patch,
  };
}
const hover = (x: number, y: number): PointerInput =>
  pointer(x, y, { buttons: { left: false, middle: false, right: false } });
const mods = (patch: Partial<Modifiers>): Modifiers => ({ ...NO_MODIFIERS, ...patch });

function makeWorkspace() {
  const scene = new MemoryScene([
    { id: 'a', bounds: R.rect(0, 0, 100, 100), zIndex: 0 },
  ]);
  const selection = new MemorySelection();
  const commands = new RecordingCommandPort();
  const ws = new Workspace({ scene, selection, commands, viewport: { width: 800, height: 600 } });
  ws.initialize();
  ws.setSnap({ enabled: false });
  return { ws, scene, selection, commands };
}

const toScreen = (wx: number, wy: number) => ({ x: wx + 400, y: wy + 300 });

function totalMoveDelta(commands: RecordingCommandPort): { x: number; y: number } {
  return commands.log
    .filter((c) => c.type === WorkspaceCommandType.MoveNodes)
    .reduce(
      (acc, c) => {
        const d = (c.payload as { delta: { x: number; y: number } }).delta;
        return { x: acc.x + d.x, y: acc.y + d.y };
      },
      { x: 0, y: 0 },
    );
}

describe('Shift axis lock on 2D move (SelectTool)', () => {
  it('locks a mostly-horizontal shift-drag to x — y ends at zero', () => {
    const { ws, selection, commands } = makeWorkspace();
    selection.set(['a']);
    const start = toScreen(50, 50);
    const shift = { modifiers: mods({ shift: true }) };
    ws.feedPointerDown(pointer(start.x, start.y, shift));
    ws.feedPointerMove(pointer(start.x + 30, start.y + 12, shift));
    ws.feedPointerMove(pointer(start.x + 60, start.y + 25, shift));
    ws.feedPointerUp(pointer(start.x + 60, start.y + 25, shift));
    const total = totalMoveDelta(commands);
    expect(total.x).toBeCloseTo(60);
    expect(total.y).toBeCloseTo(0);
  });

  it('flips the lock live when the drag crosses the diagonal', () => {
    const { ws, selection, commands } = makeWorkspace();
    selection.set(['a']);
    const start = toScreen(50, 50);
    const shift = { modifiers: mods({ shift: true }) };
    ws.feedPointerDown(pointer(start.x, start.y, shift));
    ws.feedPointerMove(pointer(start.x + 30, start.y + 5, shift)); // x-dominant
    ws.feedPointerMove(pointer(start.x + 10, start.y + 80, shift)); // now y-dominant
    ws.feedPointerUp(pointer(start.x + 10, start.y + 80, shift));
    const total = totalMoveDelta(commands);
    expect(total.x).toBeCloseTo(0);
    expect(total.y).toBeCloseTo(80);
  });

  it('an unmodified drag still moves freely on both axes', () => {
    const { ws, selection, commands } = makeWorkspace();
    selection.set(['a']);
    const start = toScreen(50, 50);
    ws.feedPointerDown(pointer(start.x, start.y));
    ws.feedPointerMove(pointer(start.x + 30, start.y + 12));
    ws.feedPointerUp(pointer(start.x + 30, start.y + 12));
    const total = totalMoveDelta(commands);
    expect(total.x).toBeCloseTo(30);
    expect(total.y).toBeCloseTo(12);
  });
});

describe('drag HUD', () => {
  it('a move publishes its running Δ and clears on release', () => {
    const { ws, selection } = makeWorkspace();
    selection.set(['a']);
    const start = toScreen(50, 50);
    ws.feedPointerDown(pointer(start.x, start.y));
    ws.feedPointerMove(pointer(start.x + 25, start.y + 10));
    const hud = ws.overlay().dragHud;
    expect(hud).toBeTruthy();
    expect(hud!.lines[0]).toBe('+25, +10');
    ws.feedPointerUp(pointer(start.x + 25, start.y + 10));
    expect(ws.overlay().dragHud ?? null).toBeNull();
  });
});

describe('grip hover flag', () => {
  it('flags the grip under an idle cursor and clears when the cursor leaves', () => {
    const { ws, selection } = makeWorkspace();
    selection.set(['a']);
    const grips = ws.overlay().handles.filter((h) => h.kind === 'resize');
    expect(grips.length).toBeGreaterThan(0);
    const target = grips[0]!;
    ws.feedPointerMove(hover(target.position.x, target.position.y));
    const after = ws.overlay().handles.find((h) => h.id === target.id);
    expect(after?.hovered).toBe(true);
    // Everything else stays unlit.
    expect(ws.overlay().handles.filter((h) => h.hovered).length).toBe(1);
    ws.feedPointerMove(hover(target.position.x + 200, target.position.y + 200));
    expect(ws.overlay().handles.some((h) => h.hovered)).toBe(false);
  });
});
