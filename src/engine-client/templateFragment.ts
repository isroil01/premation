/**
 * A template's layers as an ENGINE CLIENT fragment: the template's `layout`
 * (which lays node literals into a SceneGraph-like target: `addNode` for the
 * composition root, `addChild` for each layer) and its `animate`
 * choreography (a keyframe setter) run against a {@link FragmentBuilder}
 * instead of the scratch TypeScript scene graph — the result is the
 * `pasteLayers` fragment templateStore.apply sends, with no off-document run.
 * Pinned against the off-document build of every registered template
 * (templateFragment.test.ts).
 */

import type SceneGraph from '@core/scene/SceneGraph';
import type { TemplateDefinition } from '@core/template/templateTypes';
import { FragmentBuilder, type BuiltFragment } from './fragmentBuilder';

/**
 * The template's layers under the composition `comp` (the root the layout
 * declares), keyed in seconds — a new layer starts at 0, so composition and
 * layer time agree. Null when the layout makes no layer.
 */
export function buildTemplateFragment(t: Pick<TemplateDefinition, 'layout' | 'animate'>, comp: string): BuiltFragment | null {
  const b = new FragmentBuilder({ idPrefix: 'tpl' });
  // The layouts only call addNode (the root) and addChild (the layers), both of
  // which the builder implements with SceneGraph's semantics.
  (t.layout as (g: SceneGraph, rootId: string) => void)(b as unknown as SceneGraph, comp);
  t.animate?.(b.keyframeSetter('easeInOut'));
  return b.build();
}
