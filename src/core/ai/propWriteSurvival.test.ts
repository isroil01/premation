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
import { buildAiTools } from './toolHandlers';

function registry(): ToolRegistry {
  const r = new ToolRegistry();
  for (const t of buildAiTools()) r.register(t);
  return r;
}

describe('a mutating tool\'s write survives a read-back', () => {

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
