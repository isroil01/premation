/**
 * Ctrl on a corner handle resizes the layer's SIZE, not its Scale.
 *
 * Reported: "when I grab the corner of the selected thing and expand it, the
 * width/height should change but the scale value changes instead."
 *
 * Both are defensible. A corner handle drives Scale in After Effects, which is
 * this editor's reference and the property you keyframe; it resizes the object
 * itself in Figma and Illustrator. So Scale stays the default and Ctrl (⌘ on
 * macOS) asks for the other one — the tool signals it by sending `size`, the
 * new box in the layer's OWN units.
 *
 * The two invariants that make the modifier safe to add:
 *
 *   • one gesture writes ONE of the two properties. Writing both would leave
 *     Scale and Size each holding half the drag, and a later edit to either
 *     would jump the layer by the other's share.
 *   • a layer that cannot express the drag as a size keeps SCALING rather than
 *     swallowing the gesture. Text is the live case: its box is measured from
 *     its glyphs, so a width it does not read would be a drag that visibly did
 *     nothing.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { seedDefaultScene } from '@core/scene/seedDefaultScene';
import { insertSolid, insertText } from '@core/scene/sceneInsert';
import { useSelectionStore } from '@stores/selectionStore';
import { commands } from '@motion/workspace';
import { createCommandPort } from './ports';

type Props = Record<string, unknown>;

function transformProps(id: string): Props {
  const node = defaultSceneGraph.getNode(id as never);
  if (!node) throw new Error(`no node ${id}`);
  const t = node.components.find((c) => c.type === 'Transform');
  if (!t) throw new Error(`node ${id} has no Transform`);
  return t.props as Props;
}

/** Insert a solid and return its id — solids carry an authored width/height. */
function newSolid(): string {
  insertSolid();
  const ids = useSelectionStore.getState().ids;
  const id = ids[ids.length - 1];
  if (!id) throw new Error('insertSolid selected nothing');
  return id;
}

beforeAll(() => {
  seedDefaultScene();
});

describe('Ctrl-resize writes Size instead of Scale', () => {
  it('doubles width/height and leaves scale exactly where the drag found it', () => {
    const id = newSolid();
    const before = transformProps(id);
    const w0 = before.width as number;
    const h0 = before.height as number;
    const sx0 = (before.scaleX as number) ?? 1;

    createCommandPort().execute(
      commands.resizeNode(
        id as never,
        { x: 0, y: 0, width: w0 * 2, height: h0 * 2 },
        { x: sx0, y: sx0 },
        { x: 500, y: 400 },
        { x: w0 * 2, y: h0 * 2 },
      ),
    );

    const after = transformProps(id);
    expect(after.width).toBeCloseTo(w0 * 2, 5);
    expect(after.height).toBeCloseTo(h0 * 2, 5);
    // The whole point of the modifier: Scale must not have moved.
    expect(after.scaleX).toBeCloseTo(sx0, 10);
    expect(after.scaleY).toBeCloseTo(sx0, 10);
    // Position still follows the drag, exactly as it does in scale mode.
    expect(after.x).toBeCloseTo(500, 5);
    expect(after.y).toBeCloseTo(400, 5);
  });

  it('leaves Size alone on a plain (unmodified) drag', () => {
    const id = newSolid();
    const before = transformProps(id);
    const w0 = before.width as number;
    const h0 = before.height as number;

    createCommandPort().execute(
      commands.resizeNode(
        id as never,
        { x: 0, y: 0, width: w0 * 2, height: h0 * 2 },
        { x: 2, y: 2 },
        { x: 500, y: 400 },
        // no `size` — the default, scale-mode drag
      ),
    );

    const after = transformProps(id);
    expect(after.scaleX).toBeCloseTo(2, 5);
    expect(after.scaleY).toBeCloseTo(2, 5);
    expect(after.width).toBeCloseTo(w0, 5);
    expect(after.height).toBeCloseTo(h0, 5);
  });

  it('never lets a drag collapse the layer to zero or flip it inside out', () => {
    const id = newSolid();

    createCommandPort().execute(
      commands.resizeNode(
        id as never,
        { x: 0, y: 0, width: 1, height: 1 },
        { x: 1, y: 1 },
        { x: 0, y: 0 },
        { x: -40, y: 0 },
      ),
    );

    const after = transformProps(id);
    expect(after.width).toBe(40);   // magnitude kept, flip refused
    expect(after.height).toBe(1);   // floored, never 0
  });
});

/**
 * Text is the one layer kind that must REFUSE size mode.
 *
 * A text layer's box comes from measuring its glyphs — `readGeometry` discards
 * the authored width/height for `kind === 'text'` entirely. Honouring Ctrl
 * there would move the numbers in the inspector and change nothing on canvas,
 * which reads as a dead gesture. Scaling the type is at least a visible,
 * correct answer to "make this bigger".
 */
describe('text refuses size mode and scales instead', () => {
  it('scales the type rather than writing a width nothing reads', () => {
    insertText('Headline');
    const ids = useSelectionStore.getState().ids;
    const id = ids[ids.length - 1];
    if (!id) throw new Error('insertText selected nothing');
    const w0 = transformProps(id).width as number;

    createCommandPort().execute(
      commands.resizeNode(
        id as never,
        { x: 0, y: 0, width: 200, height: 200 },
        { x: 3, y: 3 },
        { x: 100, y: 100 },
        { x: 999, y: 999 },
      ),
    );

    const after = transformProps(id);
    expect(after.scaleX).toBeCloseTo(3, 5);
    expect(after.scaleY).toBeCloseTo(3, 5);
    expect(after.width).toBe(w0);
  });
});
