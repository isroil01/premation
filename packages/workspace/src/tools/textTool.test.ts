/**
 * Type tool (AE): click = point text, click-drag = paragraph text whose box is
 * the dragged rectangle. A drag too small to mean a box is a click.
 */

import { TextTool, VerticalTextTool } from './builtin';
import { WorkspaceCommandType, type CreateNodePayload } from '../commands/WorkspaceCommands';
import type { ToolContext, ToolDragEvent, ToolPointerEvent } from './Tool';
import { NO_MODIFIERS } from '../input/events';

function makeCtx() {
  const created: CreateNodePayload[] = [];
  const ctx = {
    requestRender: () => {},
    selectionIds: () => [] as string[],
    execute: (cmd: { type: string; payload: CreateNodePayload }) => {
      if (cmd.type === WorkspaceCommandType.CreateNode) created.push(cmd.payload);
    },
  } as unknown as ToolContext;
  return { ctx, created };
}

const drag = (sx: number, sy: number, cx: number, cy: number): ToolDragEvent => ({
  startScreen: { x: sx, y: sy }, currentScreen: { x: cx, y: cy },
  startWorld: { x: sx, y: sy }, currentWorld: { x: cx, y: cy },
  deltaScreen: { x: 0, y: 0 }, totalScreen: { x: cx - sx, y: cy - sy },
  deltaWorld: { x: 0, y: 0 }, totalWorld: { x: cx - sx, y: cy - sy },
  modifiers: NO_MODIFIERS, pointer: {} as ToolDragEvent['pointer'],
});

const click = (x: number, y: number): ToolPointerEvent => ({
  screen: { x, y }, world: { x, y }, modifiers: NO_MODIFIERS, pointer: {} as ToolPointerEvent['pointer'],
});

describe('TextTool', () => {
  it('a click creates POINT text', () => {
    const { ctx, created } = makeCtx();
    new TextTool().onClick(click(40, 50), ctx);
    expect(created).toHaveLength(1);
    expect(created[0]!.kind).toBe('Text');
  });

  it('REGRESSION: point text is a POINT — no 200×40 box, origin on the click', () => {
    // The rect used to be 200×40: the host stored it as the layer's size (a box
    // point text does not have) and centred the layer 100px right of the click.
    const { ctx, created } = makeCtx();
    new TextTool().onClick(click(40, 50), ctx);
    expect(created[0]!.bounds).toEqual({ x: 40, y: 50, width: 0, height: 0 });
  });

  it('a drag creates PARAGRAPH text with the dragged rectangle as its box', () => {
    const { ctx, created } = makeCtx();
    // Dragged up-left: the box is still the normalised rectangle.
    new TextTool().onDragEnd(drag(300, 200, 100, 80), ctx);
    expect(created).toHaveLength(1);
    expect(created[0]!.kind).toBe('ParagraphText');
    expect(created[0]!.bounds).toEqual({ x: 100, y: 80, width: 200, height: 120 });
  });

  it('a sliver of a drag is a click (point text at the press)', () => {
    const { ctx, created } = makeCtx();
    new TextTool().onDragEnd(drag(10, 10, 200, 14), ctx);
    expect(created[0]!.kind).toBe('Text');
    expect(created[0]!.bounds.x).toBe(10);
  });
});

describe('VerticalTextTool', () => {
  it('has its own id and the vertical-text cursor', () => {
    const tool = new VerticalTextTool();
    expect(tool.id).toBe('vertical-text');
    expect(tool.cursor).toBe('vertical-text');
  });

  it('a click creates vertical POINT text', () => {
    const { ctx, created } = makeCtx();
    new VerticalTextTool().onClick(click(40, 50), ctx);
    expect(created.map((c) => c.kind)).toEqual(['VerticalText']);
  });

  it('a drag creates a vertical PARAGRAPH box; a sliver is a click', () => {
    const { ctx, created } = makeCtx();
    new VerticalTextTool().onDragEnd(drag(100, 80, 300, 200), ctx);
    new VerticalTextTool().onDragEnd(drag(10, 10, 14, 200), ctx);
    expect(created.map((c) => c.kind)).toEqual(['VerticalParagraphText', 'VerticalText']);
    expect(created[0]!.bounds).toEqual({ x: 100, y: 80, width: 200, height: 120 });
  });
});
