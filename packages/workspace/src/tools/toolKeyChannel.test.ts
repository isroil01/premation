/**
 * The keyboard channel between the host and the ACTIVE TOOL.
 *
 * ── The bug this exists for ────────────────────────────────────────────
 * Tools have always declared `onKeyDown`, and the editor never called it. The
 * only route into it was `Workspace.onKeyDown`, which is the whole keyboard
 * channel — it also claims Space for the temporary hand tool and treats any
 * unmodified character as a tool shortcut — so a host with its own shortcut
 * system could not use it without every letter typed in the viewport silently
 * switching tools. It therefore called nothing, and the pen's Enter (finish the
 * outline) and Escape (abandon it) were unreachable: a half-drawn path could
 * only be committed by double-clicking, and could not be cancelled at all.
 *
 * Two properties have to hold together, which is why they are tested together:
 * the key must REACH the tool, and the tool must only CLAIM a key it acted on —
 * otherwise the pen would swallow the viewport's own Escape (clear the
 * selection) for the whole time it is merely the active tool.
 */

import { Workspace } from '../Workspace';
import { MemoryScene, MemorySelection, RecordingCommandPort } from '../adapters/memory';
import { PenTool, CurvatureTool } from './builtin';
import { WorkspaceCommandType, type CreateNodePayload } from '../commands/WorkspaceCommands';
import type { Tool, ToolContext, ToolPointerEvent } from './Tool';
import { NO_MODIFIERS, type KeyInput, type PointerInput } from '../input/events';

const key = (k: string): KeyInput => ({
  key: k, code: k, modifiers: NO_MODIFIERS, repeat: false, time: 0,
});

const at = (x: number, y: number): ToolPointerEvent => ({
  screen: { x, y }, world: { x, y }, modifiers: NO_MODIFIERS,
  pointer: {} as ToolPointerEvent['pointer'],
});

function makeCtx() {
  const created: Array<{ kind: string; points?: unknown[] }> = [];
  const ctx = {
    requestRender: () => {},
    selectionIds: () => [] as string[],
    execute: (cmd: { type: string; payload: CreateNodePayload }) => {
      if (cmd.type === WorkspaceCommandType.CreateNode) {
        created.push({ kind: cmd.payload.kind, points: cmd.payload.points });
      }
    },
  } as unknown as ToolContext;
  return { ctx, created };
}

/*
  The two pens place points through DIFFERENT pointer hooks — the bezier pen on
  pointer-down (so a press-and-drag can pull a handle out of the anchor it just
  placed), the curvature pen on click. The key contract is the same for both, so
  the fixture absorbs the difference rather than duplicating the tests.
*/
const PENS: Array<[string, () => Tool, (t: Tool, ctx: ToolContext, x: number, y: number) => void]> = [
  ['PenTool', () => new PenTool(), (t, ctx, x, y) => {
    t.onPointerDown!(at(x, y), ctx);
    t.onPointerUp!(at(x, y), ctx);
  }],
  ['CurvatureTool', () => new CurvatureTool(), (t, ctx, x, y) => {
    t.onClick!(at(x, y), ctx);
  }],
];

describe.each(PENS)('%s claims keys only while it has a draft', (_name, make, place) => {
  it('does NOT claim Escape with nothing drawn', () => {
    const { ctx } = makeCtx();
    // The viewport's own Escape (clear the selection) has to keep working for
    // the whole time the pen is merely selected but idle.
    expect(make().onKeyDown!(key('Escape'), ctx)).toBe(false);
  });

  it('does NOT claim Enter with nothing drawn', () => {
    const { ctx } = makeCtx();
    expect(make().onKeyDown!(key('Enter'), ctx)).toBe(false);
  });

  it('claims Escape mid-draw, and ABANDONS the outline', () => {
    const { ctx, created } = makeCtx();
    const t = make();
    place(t, ctx, 0, 0);
    place(t, ctx, 50, 50);

    expect(t.onKeyDown!(key('Escape'), ctx)).toBe(true);
    expect(created).toEqual([]);
    // The draft is really gone, not merely hidden: `deactivate` COMMITS an
    // in-progress outline (switching tools mid-draw must keep it), so a cancel
    // that only stopped drawing it would resurrect the path on the next tool
    // change — the opposite of what Escape means.
    t.deactivate?.(ctx);
    expect(created).toEqual([]);
  });

  it('claims Enter mid-draw, and COMMITS the outline', () => {
    const { ctx, created } = makeCtx();
    const t = make();
    place(t, ctx, 0, 0);
    place(t, ctx, 50, 50);

    expect(t.onKeyDown!(key('Enter'), ctx)).toBe(true);
    expect(created).toHaveLength(1);
    expect(created[0]!.kind).toBe('Path');
  });

  it('does not claim an unrelated key mid-draw', () => {
    const { ctx } = makeCtx();
    const t = make();
    place(t, ctx, 0, 0);
    expect(t.onKeyDown!(key('a'), ctx)).toBe(false);
  });
});

function makeWorkspace() {
  const ws = new Workspace({
    scene: new MemoryScene([]),
    selection: new MemorySelection(),
    commands: new RecordingCommandPort(),
    viewport: { width: 800, height: 600 },
  });
  ws.initialize();
  return ws;
}

let clock = 0;
const press = (x: number, y: number): PointerInput => ({
  position: { x, y }, pointerType: 'mouse', button: 'left',
  buttons: { left: true, middle: false, right: false },
  modifiers: NO_MODIFIERS, pressure: 0.5, time: (clock += 1), pointerId: 1,
});

describe('Workspace.onToolKey reaches the active tool', () => {
  it('routes the key and reports whether the tool consumed it', () => {
    const ws = makeWorkspace();
    const pen = new PenTool();
    ws.tools.register(pen);
    ws.tools.setActive(pen.id);

    // Nothing drawn: the tool declines, so the host keeps its own meaning.
    expect(ws.onToolKey(key('Escape'))).toBe(false);

    ws.onPointerDown(press(400, 300));
    ws.onPointerUp(press(400, 300));
    expect(pen.pendingPoints.length).toBeGreaterThan(0);

    // Mid-draw: claimed, and the draft is dropped.
    expect(ws.onToolKey(key('Escape'))).toBe(true);
    expect(pen.pendingPoints).toHaveLength(0);
  });

  it('does NOT switch tools the way the full keyboard channel does', () => {
    // The reason this method exists rather than reusing `onKeyDown`: a host
    // with its own shortcut system must be able to reach a tool's keyboard
    // without every letter typed in the viewport re-activating another tool.
    const ws = makeWorkspace();
    const pen = new PenTool();
    ws.tools.register(pen);
    ws.tools.setActive(pen.id);

    const other = ws.tools.list().find((t) => t.shortcut && t.id !== pen.id);
    expect(other).toBeDefined();
    ws.onToolKey(key(other!.shortcut));
    expect(ws.tools.activeToolId).toBe(pen.id);

    // The control: the FULL channel does switch, so the test above is measuring
    // `onToolKey`'s restraint rather than a shortcut table that never worked.
    ws.onKeyDown(key(other!.shortcut));
    expect(ws.tools.activeToolId).toBe(other!.id);
  });
});
