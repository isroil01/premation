import { Workspace } from '../Workspace';
import { MemoryScene, MemorySelection, RecordingCommandPort } from '../adapters/memory';
import { WorkspaceCommandType } from '../commands/WorkspaceCommands';
import { NO_MODIFIERS, type PointerInput, type WheelInput, type KeyInput, type Modifiers } from '../input/events';
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
function wheel(x: number, y: number, deltaY: number, patch: Partial<WheelInput> = {}): WheelInput {
  clock += 1;
  return { position: { x, y }, deltaX: 0, deltaY, isZoom: false, modifiers: NO_MODIFIERS, time: clock, ...patch };
}
function key(code: string, k: string, patch: Partial<KeyInput> = {}): KeyInput {
  clock += 1;
  return { key: k, code, modifiers: NO_MODIFIERS, repeat: false, time: clock, ...patch };
}
function mods(patch: Partial<Modifiers>): Modifiers {
  return { ...NO_MODIFIERS, ...patch };
}

function makeWorkspace() {
  const scene = new MemoryScene([
    { id: 'a', bounds: R.rect(0, 0, 100, 100), zIndex: 0 },
    { id: 'b', bounds: R.rect(200, 0, 100, 100), zIndex: 1 },
  ]);
  const selection = new MemorySelection();
  const commands = new RecordingCommandPort();
  const ws = new Workspace({
    scene,
    selection,
    commands,
    viewport: { width: 800, height: 600 },
  });
  ws.initialize();
  // Camera center (0,0), zoom 1 → screen = world + (400,300).
  return { ws, scene, selection, commands };
}

// world → screen for the default camera (center 0, zoom 1, 800×600 viewport).
const toScreen = (wx: number, wy: number) => ({ x: wx + 400, y: wy + 300 });

describe('Workspace lifecycle & state', () => {
  it('starts on the select tool with sane defaults', () => {
    const { ws } = makeWorkspace();
    const state = ws.getState();
    expect(state.activeTool).toBe('select');
    expect(state.zoom).toBe(1);
    expect(state.selection).toEqual([]);
  });

  it('exposes coordinate conversion consistent with the camera', () => {
    const { ws } = makeWorkspace();
    const s = ws.worldToScreen({ x: 50, y: 50 });
    expect(s).toEqual({ x: 450, y: 350 });
    expect(ws.screenToWorld(s)).toEqual({ x: 50, y: 50 });
  });
});

describe('Workspace selection via input', () => {
  it('click selects the topmost node under the pointer', () => {
    const { ws, selection } = makeWorkspace();
    const p = toScreen(50, 50);
    ws.feedPointerDown(pointer(p.x, p.y));
    ws.feedPointerUp(pointer(p.x, p.y));
    expect(selection.get()).toEqual(['a']);
  });

  it('clicking empty space clears selection', () => {
    const { ws, selection } = makeWorkspace();
    ws.select('a');
    const p = toScreen(500, 500);
    ws.feedPointerDown(pointer(p.x, p.y));
    ws.feedPointerUp(pointer(p.x, p.y));
    expect(selection.get()).toEqual([]);
  });

  it('marquee-selects with a drag on empty canvas', () => {
    const { ws, selection } = makeWorkspace();
    const start = toScreen(-20, -20);
    const end = toScreen(320, 120); // covers a and b
    ws.feedPointerDown(pointer(start.x, start.y));
    ws.feedPointerMove(pointer(start.x + 10, start.y + 10));
    ws.feedPointerMove(pointer(end.x, end.y));
    ws.feedPointerUp(pointer(end.x, end.y));
    expect(selection.get().sort()).toEqual(['a', 'b']);
  });
});

describe('Workspace move tool emits commands', () => {
  it('drags the selection and submits move commands totaling the delta', () => {
    const { ws, selection, commands } = makeWorkspace();
    ws.setSnap({ enabled: false });
    ws.setTool('move');
    selection.set(['a']);
    const start = toScreen(50, 50);
    ws.feedPointerDown(pointer(start.x, start.y));
    ws.feedPointerMove(pointer(start.x + 20, start.y + 10)); // crosses threshold → dragStart+drag
    ws.feedPointerMove(pointer(start.x + 40, start.y + 20));
    ws.feedPointerUp(pointer(start.x + 40, start.y + 20));

    const moves = commands.log.filter((c) => c.type === WorkspaceCommandType.MoveNodes);
    expect(moves.length).toBeGreaterThan(0);
    const total = moves.reduce(
      (acc, c) => {
        const d = (c.payload as { delta: { x: number; y: number } }).delta;
        return { x: acc.x + d.x, y: acc.y + d.y };
      },
      { x: 0, y: 0 },
    );
    expect(total.x).toBeCloseTo(40);
    expect(total.y).toBeCloseTo(20);
  });
});

describe('Workspace shape creation', () => {
  it('rectangle tool drag creates a node', () => {
    const { ws, commands } = makeWorkspace();
    ws.setTool('rectangle');
    const start = toScreen(400, 400);
    const end = toScreen(500, 460);
    ws.feedPointerDown(pointer(start.x, start.y));
    ws.feedPointerMove(pointer(start.x + 10, start.y + 10));
    ws.feedPointerMove(pointer(end.x, end.y));
    ws.feedPointerUp(pointer(end.x, end.y));
    const created = commands.log.find((c) => c.type === WorkspaceCommandType.CreateNode);
    expect(created).toBeDefined();
    const payload = created!.payload as { kind: string; bounds: R.Rect };
    expect(payload.kind).toBe('Rectangle');
    expect(payload.bounds.width).toBeCloseTo(100);
    expect(payload.bounds.height).toBeCloseTo(60);
  });
});

describe('Workspace camera via input', () => {
  it('ctrl+wheel zooms toward the cursor', () => {
    const { ws } = makeWorkspace();
    const zoomEvents: number[] = [];
    ws.events.on('ZoomChanged', ({ zoom }) => zoomEvents.push(zoom));
    ws.feedWheel(wheel(400, 300, -100, { isZoom: true, modifiers: mods({ ctrl: true, mod: true }) }));
    expect(ws.getState().zoom).toBeGreaterThan(1);
    expect(zoomEvents.length).toBeGreaterThan(0);
  });

  it('plain wheel pans the camera', () => {
    const { ws } = makeWorkspace();
    const before = ws.getState().camera.center;
    ws.feedWheel(wheel(400, 300, 50));
    const after = ws.getState().camera.center;
    expect(after.y).not.toBeCloseTo(before.y);
  });

  it('zoomToFit frames all content', () => {
    const { ws } = makeWorkspace();
    ws.zoomToFit(undefined, 0);
    // Content spans x[0,300] y[0,100]; center should be (150,50).
    expect(ws.getState().camera.center.x).toBeCloseTo(150);
    expect(ws.getState().camera.center.y).toBeCloseTo(50);
  });
});

describe('Workspace tool shortcuts & temporary hand', () => {
  it('activates a tool by its shortcut key', () => {
    const { ws } = makeWorkspace();
    ws.feedKeyDown(key('KeyR', 'r'));
    expect(ws.getTool()).toBe('rectangle');
    ws.feedKeyUp(key('KeyR', 'r'));
  });

  it('space temporarily switches to hand and restores', () => {
    const { ws } = makeWorkspace();
    expect(ws.getTool()).toBe('select');
    ws.feedKeyDown(key('Space', ' '));
    expect(ws.getTool()).toBe('hand');
    ws.feedKeyUp(key('Space', ' '));
    expect(ws.getTool()).toBe('select');
  });
});

describe('Workspace overlay', () => {
  it('reports selection bounds and handles in screen space', () => {
    const { ws, selection } = makeWorkspace();
    selection.set(['a']);
    const overlay = ws.overlay();
    expect(overlay.selectionBounds).toEqual(R.fromPoints(toScreen(0, 0), toScreen(100, 100)));
    // 8 resize + rotate + the always-visible anchor marker (AE shows the
    // pivot on any selected layer, not only under the Pan-Behind tool).
    expect(overlay.handles).toHaveLength(10);
    expect(overlay.handles.some((h) => h.kind === 'anchor')).toBe(true);
  });

  it('multi-selection draws no transform handles (they would be dead grips)', () => {
    const { ws, selection } = makeWorkspace();
    selection.set(['a', 'b']);
    const overlay = ws.overlay();
    expect(overlay.selectionBounds).not.toBeNull();
    expect(overlay.handles).toHaveLength(0);
  });

  it('emits HoverChanged as the pointer moves over a node', () => {
    const { ws } = makeWorkspace();
    const hovers: (string | null)[] = [];
    ws.events.on('HoverChanged', ({ hovered }) => hovers.push(hovered));
    const over = toScreen(250, 50); // node b
    ws.feedPointerMove(pointer(over.x, over.y));
    expect(hovers[hovers.length - 1]).toBe('b');
  });
});
