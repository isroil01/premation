/**
 * SVG layer actions shared by every menu that offers them.
 *
 * Both right-click menus (canvas and scene tree) and the Inspector button must
 * open the SAME confirmation with the SAME wording — a "Convert" that warns
 * about 247 layers in one place and silently converts in another is worse than
 * having only one entry point.
 */

import type { ContextMenuItem } from '@stores/contextMenuStore';
import { forgetSvgLayerSrc, type SvgLayerData } from '@core/svg/svgLayer';
import { isAnimatedSvg, type SvgCapabilities } from '@core/svg/svgCapabilities';
import { engineOwnsDocumentNow } from '@core/engine/engineOwnership';
import type { Command, DocumentFragment, SvgDocument } from '@motion/engine-api';
import { engine } from '@core/engine/engineInstance';
import {
  buildSvgShapeGroupInto,
  buildRevertedSvgLayerInto,
  describeConversion,
  mirrorCarry,
  notifyNoSvgGeometry,
  notifySvgConverted,
  type BuiltSvgShapes,
} from '@core/svg/svgConvert';
import { notifySvgWarnings } from '@core/scene/layerBuilders';
import { FragmentBuilder } from '@/engine-client/fragmentBuilder';
import { insertFrame } from '@/engine-client/insertFragment';
import { documentMirror } from '@stores/documentMirror';
import { edit, reportEngineError } from '@core/engine/uiEdits';
import { useSelectionStore } from '@stores/selectionStore';
import { childOrderOf } from '@core/mirror/layerTree';
import { customConfirm } from '@components/Modal';

/** An SVG layer's stored document as the SVG helpers take it (the engine's `getSvgDocument`), or null for any other layer. */
export function svgLayerDataOf(doc: SvgDocument | null | undefined): SvgLayerData | null {
  if (!doc || doc.role !== 'layer' || !doc.sanitizedMarkup) return null;
  let capabilities = {} as SvgCapabilities;
  try {
    capabilities = JSON.parse(doc.capabilities) as SvgCapabilities;
  } catch {
    /* an unreadable scan reads as none */
  }
  return {
    sourceMarkup: doc.sourceMarkup,
    sanitizedMarkup: doc.sanitizedMarkup,
    intrinsicWidth: doc.intrinsicWidth,
    intrinsicHeight: doc.intrinsicHeight,
    viewBox: doc.viewBox ? [doc.viewBox.x, doc.viewBox.y, doc.viewBox.width, doc.viewBox.height] : null,
    capabilities,
    fileName: doc.fileName,
    livePlayback: doc.livePlayback,
  };
}

/** The layer's SVG document, asked of the engine (null when it is not an SVG layer). */
export async function fetchSvgLayerData(nodeId: string): Promise<SvgLayerData | null> {
  const res = await engine().query({ type: 'getSvgDocument', layer: nodeId });
  return res.ok ? svgLayerDataOf(res.value) : null;
}

/** Ask what conversion costs, then do it. Resolves to the new group id or null. */
export async function confirmAndConvertSvg(nodeId: string): Promise<string | null> {
  // The capability scan for the dialog: the engine's `getSvgDocument`.
  const data = await fetchSvgLayerData(nodeId);
  if (!data) return null;
  const ok = await customConfirm(
    'Convert to Editable Shapes',
    describeConversion(data).join('\n\n'),
    { confirmLabel: 'Convert', cancelLabel: 'Cancel' },
  );
  return ok ? convertSvgToShapes(nodeId) : null;
}

/**
 * Convert to Editable Shapes — a client macro (ENGINE_API.md §15.9 B3z): the
 * SVG parser (fonts for <text>, clip intersection, CSS/SMIL → keys) runs in the
 * editor, off-document, and its RESULT — the editable group — goes to the
 * engine as ONE batch: `pasteLayers` at the SVG layer's stack slot, then
 * `deleteLayers` of the SVG layer. One undo entry, replayable in both engines.
 */
export async function convertSvgToShapes(nodeId: string): Promise<string | null> {
  const layer = documentMirror().layer(nodeId);
  if (!layer) return null;
  const data = await fetchSvgLayerData(nodeId);
  if (!data) return null;
  // A STATIC document converts in the C++ engine (its own SVG parser and
  // cascade, the picture kept where the layer draws it). Animation (keyed by
  // the editor's converter), clip paths / masks (cut into the geometry here)
  // and embedded images (image layers here) keep the editor's macro, as does
  // an engine that answers `unsupported`.
  const staticDoc = !isAnimatedSvg(data.capabilities) && !data.capabilities.hasRasterImage
    && !/clip-path|<clipPath\b|<mask\b|\bmask=/.test(data.sourceMarkup);
  if (staticDoc && engineOwnsDocumentNow()) {
    const label = 'Convert SVG to Editable Shapes';
    const res = await edit(label, { type: 'convertLayer', layer: nodeId, conversion: 'shapesFromVector' }, { quiet: true });
    if (res.ok) {
      const groupId = (res.value[0] as { layers?: string[] } | undefined)?.layers?.[0] ?? null;
      forgetSvgLayerSrc(nodeId);
      if (groupId) useSelectionStore.getState().set([groupId]);
      return groupId;
    }
    if (res.error.code !== 'unsupported') {
      reportEngineError(label, res.error);
      return null;
    }
  }
  // Built on the client into a fragment (no page replica): the layer's own
  // composition is the frame, its stored transform / appearance the carry.
  const comp = layer.comp;
  await documentMirror().loadTree(nodeId);
  const b = new FragmentBuilder({ idPrefix: 'svgconv' });
  let r: BuiltSvgShapes | null;
  try {
    r = buildSvgShapeGroupInto(b, insertFrame(comp), data, mirrorCarry(nodeId));
  } catch (err) {
    reportEngineError('Convert SVG to Editable Shapes', { code: 'internal', message: err instanceof Error ? err.message : String(err) });
    return null;
  }
  const built = b.build();
  if (!built || !r) {
    notifyNoSvgGeometry(data.fileName);
    return null;
  }
  const res = await edit('Convert SVG to Editable Shapes', [inPlacePaste(nodeId, built.fragment), { type: 'deleteLayers', layers: [nodeId] }]);
  if (!res.ok) return null;
  const groupId = (res.value[0] as { layers?: string[] } | undefined)?.layers?.[0] ?? null;
  forgetSvgLayerSrc(nodeId);
  if (groupId) useSelectionStore.getState().set([groupId]);
  notifySvgConverted(r.data, r.count);
  return groupId;
}

/**
 * A `pasteLayers` that puts a fragment where `layerId` is (AE's conversions put
 * the result where the source was): its stack slot in its composition, inside
 * the same parent layer when it is nested.
 */
function inPlacePaste(layerId: string, fragment: DocumentFragment): Command {
  const m = documentMirror();
  const layer = m.layer(layerId)!;
  const slot = m.comp(layer.comp)?.layers.indexOf(layerId) ?? -1;
  return {
    type: 'pasteLayers',
    comp: layer.comp,
    fragment,
    ...(slot >= 0 ? { index: slot } : {}),
    // The mirror names no comp root as a parent: `parent` is absent at the top.
    ...(layer.parent ? { parent: layer.parent } : {}),
  } as Command;
}

/**
 * Revert to Original SVG — the mirror of `convertSvgToShapes`: the converted
 * group's retained source (the engine's `getSvgDocument`) rebuilt on the
 * client as an SVG layer carrying the group's transform
 * (`buildRevertedSvgLayerInto`), sent as ONE batch — `pasteLayers` at the
 * group's stack slot (inside the same parent layer when nested), then
 * `deleteLayers` of the group and its shapes. One undo entry. Resolves to the
 * SVG layer's id, or null.
 */
export async function revertSvgToLayer(nodeId: string): Promise<string | null> {
  const label = 'Revert to Original SVG';
  const layer = documentMirror().layer(nodeId);
  if (!layer) return null;
  const res0 = await engine().query({ type: 'getSvgDocument', layer: nodeId });
  const doc = res0.ok ? res0.value : null;
  if (!doc || doc.role !== 'converted' || !doc.sourceMarkup) return null;
  await documentMirror().loadTree(nodeId);
  const b = new FragmentBuilder({ idPrefix: 'svgrev' });
  let made: { id: string; warnings: string[] } | null;
  try {
    made = buildRevertedSvgLayerInto(b, insertFrame(layer.comp), { markup: doc.sourceMarkup, fileName: doc.fileName }, mirrorCarry(nodeId));
  } catch (err) {
    reportEngineError(label, { code: 'internal', message: err instanceof Error ? err.message : String(err) });
    return null;
  }
  const built = b.build();
  if (!made || !built) return null;
  const res = await edit(label, [inPlacePaste(nodeId, built.fragment), { type: 'deleteLayers', layers: subtreeOf(nodeId) }]);
  if (!res.ok) return null;
  const id = (res.value[0] as { layers?: string[] } | undefined)?.layers?.[0] ?? null;
  if (id) useSelectionStore.getState().set([id]);
  notifySvgWarnings(doc.fileName, made.warnings);
  return id;
}

/** The layer and every layer under it, from the mirror (deleteLayers takes the whole subtree). */
function subtreeOf(id: string): string[] {
  const m = documentMirror();
  const out: string[] = [];
  const walk = (x: string): void => {
    out.push(x);
    for (const c of childOrderOf(m, x)) walk(c);
  };
  walk(id);
  return out;
}

/**
 * The SVG entries for a layer's context menu — empty for a layer that is
 * neither an SVG nor converted from one, so call sites can splat unconditionally.
 */
export function svgContextMenuItems(nodeId: string): ContextMenuItem[] {
  const layer = documentMirror().layer(nodeId);
  if (!layer) return [];
  // What the layer holds of an SVG document: `LayerInfo.svg` (an SVG layer / a converted group that retains its source).
  if (layer.svg === 'layer') {
    return [
      { id: 'svg-sep', separator: true },
      {
        id: 'svg-convert',
        label: 'Convert to Editable Shapes…',
        onSelect: () => { void confirmAndConvertSvg(nodeId); },
      },
    ];
  }
  if (layer.svg === 'converted') {
    return [
      { id: 'svg-sep', separator: true },
      {
        id: 'svg-revert',
        label: 'Revert to Original SVG',
        onSelect: () => { void revertSvgToLayer(nodeId); },
      },
    ];
  }
  return [];
}
