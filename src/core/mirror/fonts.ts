/**
 * The font families a document's text layers use, over the document MIRROR
 * (B4) — the twins of `missingFonts.collectFontUsage` / `findMissingFonts`:
 * each text layer's `text/fontFamily` and every family its per-character
 * style runs set (`text/styleRuns`). Pure: takes the mirror, never the engine.
 *
 * Text layers' property trees are loaded on demand (`loadTextTrees`); a tree
 * that has not arrived yet is skipped, so a caller that must see every layer
 * awaits `loadTextTrees` first.
 */

import type { LayerInfo } from '@motion/engine-api';
import { GENERIC_FONT_FAMILIES, primaryFamily, type FontUsage } from '@core/fonts/missingFonts';
import { plainValue, type MirrorTreeLike } from './trackIndex';
import { uiKindOf } from './layerKinds';

/** What these readers need from the mirror. `DocumentMirror` is one. */
export interface MirrorFontRead {
  layerIds(): readonly string[];
  layer(id: string): LayerInfo | undefined;
  tree(layer: string): MirrorTreeLike | undefined;
  whenIdle(): Promise<void>;
}

/** Every text layer the mirror holds. */
export function mirrorTextLayerIds(m: Pick<MirrorFontRead, 'layerIds' | 'layer'>): string[] {
  return m.layerIds().filter((id) => uiKindOf(m.layer(id)) === 'text');
}

/** Ask for every text layer's tree and wait for the answers (the in-process backend answers at once). */
export async function loadTextTrees(m: MirrorFontRead): Promise<void> {
  for (const id of mirrorTextLayerIds(m)) m.tree(id);
  await m.whenIdle();
}

/** Every family text layers use, with the layers using it. Sorted by family. */
export function mirrorFontUsage(m: Pick<MirrorFontRead, 'layerIds' | 'layer' | 'tree'>): FontUsage[] {
  const byKey = new Map<string, FontUsage>();
  const note = (raw: unknown, layer: LayerInfo, inRuns: boolean): void => {
    if (typeof raw !== 'string') return;
    const family = primaryFamily(raw);
    if (!family) return;
    const key = family.toLowerCase();
    let usage = byKey.get(key);
    if (!usage) {
      usage = { family, layers: [] };
      byKey.set(key, usage);
    }
    const existing = usage.layers.find((l) => l.id === layer.id);
    if (existing) existing.inRuns = existing.inRuns || inRuns;
    else usage.layers.push({ id: layer.id, name: layer.name || layer.id, inRuns });
  };
  for (const id of mirrorTextLayerIds(m)) {
    const layer = m.layer(id)!;
    const tree = m.tree(id);
    if (!tree) continue;
    note(plainValue(tree.nodes.get('text/fontFamily')?.value), layer, false);
    const runs = plainValue(tree.nodes.get('text/styleRuns')?.value);
    if (Array.isArray(runs)) {
      for (const r of runs) note((r as { style?: { fontFamily?: unknown } } | null)?.style?.fontFamily, layer, true);
    }
  }
  return [...byKey.values()].sort((a, b) => a.family.localeCompare(b.family));
}

/** The used families `isAvailable` says cannot be drawn (generic families never). */
export function mirrorMissingFonts(
  m: Pick<MirrorFontRead, 'layerIds' | 'layer' | 'tree'>,
  isAvailable: (family: string) => boolean,
): FontUsage[] {
  return mirrorFontUsage(m).filter((u) => !GENERIC_FONT_FAMILIES.has(u.family.toLowerCase()) && !isAvailable(u.family));
}
