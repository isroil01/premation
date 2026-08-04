/**
 * Every mutating tool's write must survive a read-back. This is the F11 guard.
 *
 * ## The defect this file was written to prove
 *
 * `SceneGraph.getNode(id).components` is a **live view rebuilt on every read**
 * (`SceneGraph.ts` — `get components() { return buildComponents(this.e); }`).
 * That is deliberate: callers all over the app do
 * `node.components.find(...).props.x = …`, and the copy is what stops those
 * writes reaching shared state. The consequence for anyone who meant the write
 * to land is that it goes into a throwaway and is silently discarded.
 *
 * Five AI tools were written that way, and a sixth pushed a whole component onto
 * the throwaway array. All six reported `ok` and changed nothing. The three
 * quick-preset chips in the assistant panel that call them — "Trim-Path Logo
 * Reveal", "Radial Repeater Burst", "Organic Path Morph" — have therefore never
 * produced their headline effect.
 *
 * ## The second defect, which the first one hid
 *
 * Every one of those handlers also wrote the **wrong shape**. `add_repeater`
 * wrote `{positionX, positionY, rotation, scaleX, scaleY, startOpacity,
 * endOpacity}`; `readRepeaterConfig` reads `{offsetX, offsetY, offsetRotation,
 * offsetScale, offsetOpacity}`. `set_trim_path` wrote three loose numbers onto
 * the *Geometry* component; `readTrimConfig` reads `fx.trim = {start, end,
 * offset}`. `add_path_operator` wrote the legacy single `fx.pathOp` slot that
 * document version 1.3.0 replaced with the `fx.pathOps` chain, using a type name
 * (`puckerBloat`) that is not in the operator enum (`pucker`).
 *
 * So fixing only the write target would have produced a layer with a repeater of
 * `copies` and nothing else — visibly a bug, but a quieter one. Both halves are
 * asserted below, per property, so neither can regress alone.
 */

import { ToolRegistry } from '@motion/ai-tools';
import type { ToolContext } from '@motion/ai-tools';
import { buildAiTools } from './toolHandlers';
import { createToolContext } from './toolContext';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { readRepeaterConfig } from '@core/scene/repeater';
import { readTrimOp } from '@core/scene/pathOps';
import { readPathOps } from '@core/scene/pathOps';
import type { SceneNode } from '@core/types';

function registry(): ToolRegistry {
  const r = new ToolRegistry();
  for (const t of buildAiTools()) r.register(t);
  return r;
}

function node(id: string, kind: string): SceneNode {
  return {
    id,
    name: id,
    parent: null,
    children: [],
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    visible: true,
    locked: false,
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: kind, x: 0, y: 0, width: 100, height: 100 } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#ffffff' } },
      { id: `${id}_g`, type: 'Geometry', props: { shapeType: 'rect' } },
    ],
  };
}

function reset(): void {
  defaultAnimation.clear();
  defaultSceneGraph.clear();
  defaultSceneGraph.addNode({
    id: 'comp_root',
    name: 'Composition 1',
    parent: null,
    children: [],
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    visible: true,
    locked: false,
    components: [{ id: 'comp_root_meta', type: 'group', props: { __kind: 'group' } }],
  });
}

const ctx = (): ToolContext => createToolContext(new AbortController().signal);

/** Read a node back from the graph — never the object handed to `addChild`. */
const back = (id: string) => defaultSceneGraph.getNode(id)!;

describe('a mutating tool\'s write survives a read-back', () => {
  beforeEach(reset);

  describe('set_trim_path', () => {
    it('lands where readTrimConfig looks, in the shape it expects', async () => {
      defaultSceneGraph.addChild('comp_root', node('stroke', 'shape'));
      const res = await registry().execute(
        'set_trim_path',
        { nodeId: 'stroke', start: 0, end: 40, offset: 12 },
        ctx(),
      );
      expect(res.ok).toBe(true);

      const trim = readTrimOp(back('stroke'));
      expect(trim).not.toBeNull();
      expect(trim!.start).toBe(0);
      expect(trim!.end).toBe(40);
      expect(trim!.offset).toBe(12);
    });

    it('patches rather than replaces — a partial call keeps the other two', async () => {
      defaultSceneGraph.addChild('comp_root', node('stroke2', 'shape'));
      const reg = registry();
      await reg.execute('set_trim_path', { nodeId: 'stroke2', start: 10, end: 90, offset: 5 }, ctx());
      await reg.execute('set_trim_path', { nodeId: 'stroke2', end: 55 }, ctx());

      const trim = readTrimOp(back('stroke2'))!;
      expect(trim.end).toBe(55);
      // Both survive: a second call that names one field is an edit, not a reset.
      expect(trim.start).toBe(10);
      expect(trim.offset).toBe(5);
    });
  });

  describe('add_repeater', () => {
    it('lands in the field names readRepeaterConfig actually reads', async () => {
      defaultSceneGraph.addChild('comp_root', node('dot', 'shape'));
      const res = await registry().execute(
        'add_repeater',
        {
          nodeId: 'dot',
          copies: 12,
          positionX: 42,
          positionY: 7,
          rotation: 30,
          scale: 0.9,
          startOpacity: 100,
          endOpacity: 20,
        },
        ctx(),
      );
      expect(res.ok).toBe(true);

      const rep = readRepeaterConfig(back('dot'));
      expect(rep).not.toBeNull();
      expect(rep!.copies).toBe(12);
      // Every one of these was dropped to its default before the fix, because the
      // handler's vocabulary and the reader's did not overlap past `copies`.
      expect(rep!.offsetX).toBe(42);
      expect(rep!.offsetY).toBe(7);
      expect(rep!.offsetRotation).toBe(30);
      expect(rep!.offsetScale).toBeCloseTo(0.9);
      // endOpacity 20 over 12 copies is a per-copy multiplier, not a raw percent.
      expect(rep!.offsetOpacity).toBeGreaterThan(0);
      expect(rep!.offsetOpacity).toBeLessThan(1);
    });

    it('a radial burst closes the ring — 360/copies of rotation', async () => {
      defaultSceneGraph.addChild('comp_root', node('ring', 'shape'));
      await registry().execute(
        'add_repeater',
        { nodeId: 'ring', copies: 8, rotation: 45, positionX: 40 },
        ctx(),
      );
      const rep = readRepeaterConfig(back('ring'))!;
      expect(rep.copies * rep.offsetRotation).toBe(360);
    });
  });

  describe('add_path_operator', () => {
    it('writes the pathOps CHAIN, not the legacy single slot', async () => {
      defaultSceneGraph.addChild('comp_root', node('star', 'shape'));
      const res = await registry().execute(
        'add_path_operator',
        { nodeId: 'star', op: 'puckerBloat', amount: 35 },
        ctx(),
      );
      expect(res.ok).toBe(true);

      const ops = readPathOps(back('star'));
      expect(ops).toHaveLength(1);
      // 'puckerBloat' is the tool's public name and 'pucker' is the engine's.
      // The handler is the translation point; a raw pass-through fails
      // `isPathOpType` and coerces to the default, which is `none`.
      expect(ops[0]!.type).toBe('pucker');
      expect(ops[0]!.amount).toBe(35);
      // A real id, so keyframes can bind to `pathop.<id>.amount`.
      expect(ops[0]!.id).toBeTruthy();
    });

    it('stacks rather than replaces — two operators chain', async () => {
      defaultSceneGraph.addChild('comp_root', node('star2', 'shape'));
      const reg = registry();
      await reg.execute('add_path_operator', { nodeId: 'star2', op: 'zigzag', amount: 10 }, ctx());
      await reg.execute('add_path_operator', { nodeId: 'star2', op: 'twist', amount: 20 }, ctx());

      const ops = readPathOps(back('star2'));
      expect(ops.map((o) => o.type)).toEqual(['zigzag', 'twist']);
      // Distinct ids, or the two operators' keyframes would collide on one path.
      expect(ops[0]!.id).not.toBe(ops[1]!.id);
    });
  });

  describe('recolor_lottie_vector', () => {
    it('the new fill survives a read-back', async () => {
      defaultSceneGraph.addChild('comp_root', node('vec', 'shape'));
      const res = await registry().execute(
        'recolor_lottie_vector',
        { nodeId: 'vec', color: '#ff0066' },
        ctx(),
      );
      expect(res.ok).toBe(true);
      const style = back('vec').components.find((c) => c.type === 'Style');
      expect(style?.props.fill).toBe('#ff0066');
    });
  });

  describe('set_text_on_path', () => {
    it('is not offered at all — nothing in the repo reads a text path', () => {
      // Kept as a test rather than deleted with the tool, because the capability
      // is a real gap (Phase B.5) and this is where it gets asserted when it
      // lands. Until then the tool must not exist: it reported success, wrote
      // into a throwaway, and taught the model the type had been shaped — after
      // which it moved on and never revisited it.
      expect(registry().list().map((t) => t.name)).not.toContain('set_text_on_path');
    });
  });
});
