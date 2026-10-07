/**
 * Properties ▸ Crop (AE parity 5.6): Left / Top / Right / Bottom insets and an
 * edge feather for a picture layer. The crop IS a rectangle mask named "Crop"
 * (AE crops with masks too), so it draws on the GPU path, keys like a mask
 * path, and shows in Properties ▸ Masks: the first edit adds it (Add when it is
 * the layer's only mask, Intersect after others), later edits reshape it; Reset
 * removes it. One entry per edit.
 */

import { ValueField } from '@components/ValueField';
import { PropertyRow } from '@components/PropertyRow';
import { Button } from '@components/Button';
import { useActiveWorkspace } from '@stores/projectStore';
import { documentMirror } from '@stores/documentMirror';
import { MAIN_VIEWPORT, overlayLayer, requestOverlayLayers } from '@stores/overlayGeometry';
import { useMirrorKeys, useMirrorLayer, useMirrorTree } from '@hooks/useMirror';
import { secondsToFlicks } from '@motion/engine-api';
import { mirrorMasksAt, mirrorMaskWatchKeys } from '@core/mirror/masks';
import { uiKindOf } from '@core/mirror/layerKinds';
import { SIZE } from '@core/scene/layerKindSize';
import { edit } from '@core/engine/uiEdits';
import { compTime, paths, ref } from '@core/engine/propRefs';
import { maskToBezier } from '@core/engine/props';
import { rectangleMask, type MaskPath } from '@core/effects/mask';
import { useEffect } from 'react';
import { addMaskEdit, maskValueCommands, removeMaskEdit } from '@layout/Effects/effectEdits';

export const CROP_MASK_NAME = 'Crop';

export interface CropInsets {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The insets a crop mask's outline describes in a w × h box (centred layer space). */
export function insetsOf(mask: Pick<MaskPath, 'points'>, w: number, h: number): CropInsets {
  const xs = mask.points.map((p) => p.x);
  const ys = mask.points.map((p) => p.y);
  return {
    left: Math.max(0, Math.min(...xs) + w / 2),
    top: Math.max(0, Math.min(...ys) + h / 2),
    right: Math.max(0, w / 2 - Math.max(...xs)),
    bottom: Math.max(0, h / 2 - Math.max(...ys)),
  };
}

/** The crop rectangle for insets in a w × h box (clamped so it never inverts). */
export function cropMask(insets: CropInsets, w: number, h: number): MaskPath {
  const l = Math.max(0, Math.min(w - 1, insets.left));
  const r = Math.max(0, Math.min(w - 1 - l, insets.right));
  const t = Math.max(0, Math.min(h - 1, insets.top));
  const b = Math.max(0, Math.min(h - 1 - t, insets.bottom));
  const m = rectangleMask(w - l - r, h - t - b);
  const dx = (l - r) / 2;
  const dy = (t - b) / 2;
  return { ...m, name: CROP_MASK_NAME, points: m.points.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy })) };
}

/** Whether a layer kind takes the Crop section (pictures: image, video, precomp, shape / solid, text, SVG). */
export function hasCropSection(nodeId: string): boolean {
  const k = uiKindOf(documentMirror().layer(nodeId));
  return k === 'image' || k === 'video' || k === 'comp' || k === 'shape' || k === 'text' || k === 'svg';
}

export function CropSection({ nodeId }: { nodeId: string }): JSX.Element {
  const time = useActiveWorkspace()?.time ?? 0;
  const layer = useMirrorLayer(nodeId);
  const tree = useMirrorTree(nodeId);
  useMirrorKeys(mirrorMaskWatchKeys(tree, nodeId));
  useEffect(() => {
    void requestOverlayLayers(MAIN_VIEWPORT, 'cropSection', [nodeId], ['bounds'], ['active']);
    return () => { void requestOverlayLayers(MAIN_VIEWPORT, 'cropSection', [], ['bounds']); };
  }, [nodeId]);
  const kind = uiKindOf(layer) ?? 'shape';
  const box = overlayLayer(MAIN_VIEWPORT, nodeId, secondsToFlicks(time))?.box;
  const fallback = SIZE[kind === 'text' || kind === 'image' || kind === 'video' ? kind : 'shape'];
  const w = box && box.length >= 4 && box[2]! > 0 ? box[2]! : fallback.w;
  const h = box && box.length >= 4 && box[3]! > 0 ? box[3]! : fallback.h;
  const masks = mirrorMasksAt(documentMirror(), nodeId, secondsToFlicks(time));
  const crop = masks.find((m) => (m.name ?? '').trim() === CROP_MASK_NAME);
  const insets = crop ? insetsOf(crop, w, h) : { left: 0, top: 0, right: 0, bottom: 0 };

  const setInset = (key: keyof CropInsets, v: number): void => {
    const next = cropMask({ ...insets, [key]: v }, w, h);
    if (!crop) {
      void addMaskEdit(nodeId, { ...next, mode: masks.length > 0 ? 'intersect' : 'add' }, 'Crop');
      return;
    }
    void edit('Crop', {
      type: 'setProperty', prop: ref(nodeId, paths.mask(crop.id, 'path')), value: { kind: 'path', value: maskToBezier(next) }, time: compTime(time),
    });
  };
  const row = (label: string, key: keyof CropInsets, max: number) => (
    <PropertyRow label={label} compact>
      <ValueField value={Math.round(insets[key])} min={0} max={Math.round(max)} precision={0} unit="px"
        onChange={(v) => setInset(key, v)} aria-label={`Crop ${label.toLowerCase()}`} />
    </PropertyRow>
  );
  return (
    <div data-crop-section="">
      {row('Left', 'left', w)}
      {row('Top', 'top', h)}
      {row('Right', 'right', w)}
      {row('Bottom', 'bottom', h)}
      <PropertyRow label="Edge Feather" compact>
        <ValueField value={crop ? Math.round(crop.feather) : 0} min={0} max={500} precision={0} unit="px" aria-label="Crop edge feather"
          onChange={(v) => {
            if (!crop) return;
            const cmds = maskValueCommands(nodeId, crop.id, 'feather', v, time);
            if (cmds) void edit('Crop Feather', cmds);
          }} />
      </PropertyRow>
      {crop && (
        <PropertyRow label="" compact>
          <Button size="sm" variant="secondary" onClick={() => { void removeMaskEdit(nodeId, crop.id, 'Reset Crop'); }}>Reset Crop</Button>
        </PropertyRow>
      )}
    </div>
  );
}

export default CropSection;
