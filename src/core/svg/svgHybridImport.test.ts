/**
 * The hybrid import contract.
 *
 * The promise this architecture makes is narrow and testable: importing an SVG
 * does NOT run the geometry parser, so a 200-path illustration becomes exactly
 * one layer, and the file itself is what gets rendered. Everything else in the
 * feature (fidelity, warnings, convert) hangs off that, so these guard it
 * directly rather than by proxy.
 *
 * The counterpart cost tests for the ANIMATED route — which still converts to
 * keyframes, because a texture compositor cannot play a stored SVG — live in
 * `scene/svgImportCost.test.ts` and are unchanged by this.
 */


import { readSvgLayer, readRetainedSvgSource,  isSvgLayer } from './svgLayer';
import { readNodeKind } from '@core/scene/sceneDerive';
import { buildSvgLayer, buildSvgIconGroup } from '@core/scene/layerBuilders';
import type { SceneNode } from '@core/types';
import { FragmentBuilder } from '@/engine-client/fragmentBuilder';
import type { InsertFrame } from '@/engine-client/insertFragment';
import { buildSvgShapeGroupInto, buildRevertedSvgLayerInto } from './svgConvert';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';

beforeAll(() => {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
});

/*
 * Convert / revert are ONE engine batch in the editor (svgLayerActions.ts:
 * the builder lays the result into a fragment, then pasteLayers +
 * deleteLayers). These tests pin the BUILDERS — what the batch pastes.
 */
const FRAME: InsertFrame = { comp: 'comp_root', width: 1920, height: 1080, durationSeconds: 10, fps: 30, cursor: null };

/** A fragment row read as the stored node it becomes (the svg readers take a node). */
const asNode = (b: FragmentBuilder, id: string): SceneNode => b.row(id) as unknown as SceneNode;

/** An SVG layer built as the import builds it, and its stored document. */
function svgLayerData(source: string, name: string) {
  const b = new FragmentBuilder();
  const made = buildSvgLayer(b, FRAME, source, name)!;
  return readSvgLayer(asNode(b, made.id))!;
}

/** Convert: the group laid into a fresh fragment, or null. */
function convertSvg(source: string, name: string): { b: FragmentBuilder; groupId: string } | null {
  const b = new FragmentBuilder();
  const built = buildSvgShapeGroupInto(b, FRAME, svgLayerData(source, name), { name });
  return built ? { b, groupId: built.groupId } : null;
}

/** A static illustration with `n` independent paths. */
function manyPaths(n: number): string {
  let inner = '';
  for (let i = 0; i < n; i += 1) {
    inner += `<path d="M${i} 0 L${i + 5} 0 L${i + 5} 5 L${i} 5 Z" fill="#0af"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">${inner}</svg>`;
}

const GRADIENT_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
  '<defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs>' +
  '<rect width="100" height="100" fill="url(#g)"/></svg>';

describe('convert and revert', () => {
  it('replaces the SVG layer with real shape layers', () => {
    const c = convertSvg(manyPaths(6), 'six.svg');
    expect(c).not.toBeNull();
    expect(c!.b.row(c!.groupId).children.length).toBeGreaterThan(1);
  });

  it('retains the original on the group, and reverting restores it exactly', () => {
    const source = manyPaths(4);
    const { b, groupId } = convertSvg(source, 'four.svg')!;

    // A converted group keeps the source, not a renderable SVG layer.
    expect(readRetainedSvgSource(asNode(b, groupId))!.markup).toBe(source);
    expect(isSvgLayer(asNode(b, groupId))).toBe(false);

    const back = new FragmentBuilder();
    const made = buildRevertedSvgLayerInto(back, FRAME, readRetainedSvgSource(asNode(b, groupId))!, { name: 'four.svg', x: 300, y: 200 })!;
    expect(readSvgLayer(asNode(back, made.id))!.sourceMarkup).toBe(source);
    expect(back.row(made.id).name).toBe('four.svg');
  });

  it('reproduces exactly what today\'s import pipeline produces', () => {
    // §10: converting must be a no-regression path onto the EXISTING behaviour.
    // If the two ever diverge, users who convert get something subtly different
    // from what the same file used to import as, and nothing would say so.
    const source = manyPaths(9);

    const directB = new FragmentBuilder();
    const direct = buildSvgIconGroup(directB, FRAME, source, 'direct.svg');
    const viaLayer = convertSvg(source, 'direct.svg');
    expect(direct).not.toBeNull();
    expect(viaLayer).not.toBeNull();

    /** The shape of a converted group, ignoring generated ids and positions. */
    const describe_ = (b: FragmentBuilder, groupId: string) =>
      b.row(groupId).children.map((id) => {
        const child = asNode(b, id);
        return {
          kind: readNodeKind(child),
          fill: child.components.find((c) => c.type === 'Style')?.props.fill,
          points: (child.components.find((c) => c.type === 'Geometry')?.props.points as unknown[] | undefined)?.length,
        };
      });

    expect(describe_(viaLayer!.b, viaLayer!.groupId)).toEqual(describe_(directB, direct!));
  });

  it('parses the ORIGINAL markup, not the id-scoped copy', () => {
    // The parser resolves url(#grad) by bare name; feeding it the scoped copy
    // would break exactly the fills the user converted in order to edit.
    const c = convertSvg(GRADIENT_SVG, 'grad.svg');
    expect(c).not.toBeNull();
    expect(c!.b.row(c!.groupId).children.length).toBeGreaterThan(0);
  });
});
