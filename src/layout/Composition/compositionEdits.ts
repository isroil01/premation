/**
 * The composition dialogs' document edits through the engine API (B3,
 * docs/B3_PATTERNS.md): New Composition, Composition Settings, Pre-compose,
 * Auto-Orient and Layer / Solid Settings. Every function is ONE user action =
 * ONE undo entry, labelled as Edit ▸ Undo shows it.
 *
 * What the dialogs do AROUND the edit stays here too, because it is editor
 * state, not document: opening the new composition's tab, the selection after
 * a pre-compose, "Open New Composition".
 *
 * What the API cannot say yet keeps its legacy writer at the call site,
 * marked `B3-legacy` with the gap: a gradient comp background
 * (`setCompositionSettings` refuses `backgroundGradient` until FillPaint is
 * typed).
 *
 * Display reads stay direct until B4's mirror.
 */

import type { Color, Command, CompSettingsPatch, Rational } from '@motion/engine-api';
import { edit } from '@core/engine/uiEdits';
import { compTime } from '@core/engine/propRefs';
import { framesToFlicks } from '@core/engine/time';
import { labelIndexOf } from '@core/engine/model';
import { isLayer } from '@core/engine/doc';
import { parseColorChannels } from '@core/effects/effects';
import { pristineCompToAdopt } from '@core/composition/compositionOps';
import { openLayerComposition } from '@core/composition/compNavigation';
import { activeCompRootId } from '@core/scene/activeComp';
import { canAutoOrient, readAutoOrientMode, type AutoOrientMode } from '@core/scene/autoOrient';
import { canBe3D, is3DEnabled } from '@core/scene/threeD';
import { layerSettingsKind, sanitizeLayerSize, type LayerSettingsValues } from '@core/scene/layerSettings';
import { readNodeFill } from '@core/paint/fill';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useProjectStore, type CompositionSettings } from '@stores/projectStore';
import { useSelectionStore } from '@stores/selectionStore';
import { valueCommands } from '@layout/Inspector/inspectorEdits';

// ── Values at the seam ────────────────────────────────────────────────

/**
 * A typed frame rate as a Rational that reads back as the SAME float: 29.97
 * stays 29.97 (29970000/1000000), not NTSC's 30000/1001 = 29.97003 — the comp
 * record keeps what the user typed, as it always has, and the FPS chips still
 * match it.
 */
export function rateOf(fps: number): Rational {
  if (Number.isInteger(fps)) return { num: fps, den: 1 };
  return { num: Math.round(fps * 1_000_000), den: 1_000_000 };
}

/** '#rrggbb' / '#rrggbbaa' → an API colour. */
export function colorOf(hex: string): Color {
  const [r, g, b, a] = parseColorChannels(hex);
  return { r, g, b, a };
}

function playheadSeconds(): number {
  const s = useProjectStore.getState();
  return s.tabs[s.activeTabId ?? '']?.time ?? 0;
}

// ── New Composition ───────────────────────────────────────────────────

export interface NewCompositionInit {
  name: string;
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  background: string;
  transparent: boolean;
}

function newCompPatch(init: NewCompositionInit): CompSettingsPatch {
  return {
    name: init.name,
    width: init.width,
    height: init.height,
    frameRate: rateOf(init.fps),
    duration: compTime(init.durationSeconds),
    background: colorOf(init.background),
    transparent: init.transparent,
  };
}

/**
 * Composition ▸ New Composition. Additive — except in a fresh project, whose
 * auto-minted, layerless "pristine" comp is CONFIGURED instead of stacking a
 * second one beside it (`pristineCompToAdopt`; the settings edit clears
 * `pristine`, undo restores it). Opens the comp's tab (editor state).
 * Returns the comp id, or null when the engine refused.
 */
export async function createCompositionEdit(init: NewCompositionInit): Promise<string | null> {
  const patch = newCompPatch(init);
  const adopt = pristineCompToAdopt();
  let id: string;
  if (adopt) {
    const res = await edit('New Composition', { type: 'setCompositionSettings', comp: adopt, patch });
    if (!res.ok) return null;
    id = adopt;
  } else {
    const res = await edit('New Composition', { type: 'createComposition', settings: patch, fromItems: [] });
    if (!res.ok) return null;
    id = (res.value[0] as { item: string }).item;
  }
  useProjectStore.getState().actions.openTab(id, [id], init.name);
  useSelectionStore.getState().clear();
  return id;
}

// ── Composition Settings ──────────────────────────────────────────────

const WORLD_KEYS = ['defaultEnvPreset', 'groundLevel', 'showSkyBackdrop', 'ssao'] as const;

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * The dialog's draft against the comp as it was opened → the API patch of
 * exactly the fields that changed (undo restores exactly those). Null when
 * nothing changed.
 */
export function compSettingsPatch(from: CompositionSettings, to: CompositionSettings): CompSettingsPatch | null {
  const p: CompSettingsPatch = {};
  if (to.name !== from.name && to.name.trim() !== '') p.name = to.name;
  if (to.width !== from.width) p.width = to.width;
  if (to.height !== from.height) p.height = to.height;
  if ((to.pixelAspect ?? 1) !== (from.pixelAspect ?? 1)) p.pixelAspect = to.pixelAspect ?? 1;
  if (to.fps !== from.fps) p.frameRate = rateOf(to.fps);
  if (to.durationSeconds !== from.durationSeconds) p.duration = compTime(to.durationSeconds);
  if ((to.startFrame ?? 0) !== (from.startFrame ?? 0) || (p.frameRate && (to.startFrame ?? 0) !== 0)) {
    // Stored as a frame of the (new) rate; sent as the time of that frame.
    p.startTimecode = framesToFlicks(to.startFrame ?? 0, to.fps);
  }
  if (to.background.toLowerCase() !== from.background.toLowerCase()) p.background = colorOf(to.background);
  // The background PAINT (a gradient, or its removal) as the FillPaint JSON the editor stores.
  if (!same(from.backgroundPaint, to.backgroundPaint)) p.backgroundPaint = to.backgroundPaint ? JSON.stringify(to.backgroundPaint) : '';
  if (to.transparent !== from.transparent) p.transparent = to.transparent;
  const world: Record<string, unknown> = {};
  for (const k of WORLD_KEYS) if (!same(from[k], to[k])) world[k] = to[k];
  if (Object.keys(world).length > 0) p.world = JSON.stringify(world);
  return Object.keys(p).length > 0 ? p : null;
}

/** Composition Settings ▸ Save Changes: one entry, none when nothing changed. */
export async function saveCompositionSettingsEdit(
  compId: string,
  from: CompositionSettings,
  to: CompositionSettings,
): Promise<boolean> {
  const patch = compSettingsPatch(from, to);
  if (!patch) return true;
  const res = await edit('Composition Settings', { type: 'setCompositionSettings', comp: compId, patch });
  return res.ok;
}

/** The ACTIVE composition's frame rate (Start from a Video conforms to the clip's probe). */
export async function setActiveCompFrameRateEdit(fps: number, label = 'Conform to Footage'): Promise<void> {
  const comp = activeCompRootId();
  if (!useProjectStore.getState().comps[comp] || !(fps > 0)) return;
  if (useProjectStore.getState().comps[comp]!.fps === fps) return;
  await edit(label, { type: 'setCompositionSettings', comp, patch: { frameRate: rateOf(fps) } });
}

// ── Pre-compose ───────────────────────────────────────────────────────

export interface PrecomposeEditOptions {
  name: string;
  mode: 'move' | 'leave';
  adjustDuration: boolean;
  openNew: boolean;
}

/**
 * Layer ▸ Pre-compose through `precompose` (the engine restores the layers
 * exactly on undo). `targets` are the dialog's (`precomposeTargets`), all in
 * the active composition. The selection and "Open New Composition" are the
 * UI's. Returns the new comp and its layer, or null (the engine's refusal is
 * returned for the caller's own message).
 */
export async function precomposeEdit(
  targets: readonly string[],
  opts: PrecomposeEditOptions,
): Promise<{ comp: string; layer: string } | { error: string }> {
  const res = await edit('Pre-compose', {
    type: 'precompose',
    comp: activeCompRootId(),
    layers: [...targets],
    name: opts.name,
    mode: opts.mode === 'leave' ? 'leaveAttributes' : 'moveAll',
    adjustDuration: opts.mode === 'move' && opts.adjustDuration,
  }, { quiet: true });
  if (!res.ok) return { error: res.error.message || res.error.code };
  const r = res.value[0] as { comp: string; layer: string };
  useSelectionStore.getState().set([r.layer]);
  if (opts.openNew) openLayerComposition(r.layer);
  return r;
}

// ── Auto-Orient ───────────────────────────────────────────────────────

const API_AUTO_ORIENT: Record<AutoOrientMode, 'off' | 'alongPath' | 'towardsCamera'> = {
  off: 'off',
  path: 'alongPath',
  camera: 'towardsCamera',
};

/** Which modes `nodeId` can take — the inspector dropdown's rules. */
export function autoOrientModesFor(nodeId: string): ReadonlySet<AutoOrientMode> {
  const node = defaultSceneGraph.getNode(nodeId);
  const out = new Set<AutoOrientMode>();
  if (!node || !canAutoOrient(node)) return out;
  out.add('off');
  if (!is3DEnabled(node)) out.add('path');
  if (canBe3D(node) && is3DEnabled(node)) out.add('camera');
  return out;
}

/** Layer ▸ Transform ▸ Auto-Orient: `mode` on every layer that can take it, one entry. */
export async function setAutoOrientEdit(ids: readonly string[], mode: AutoOrientMode): Promise<void> {
  const cmds: Command[] = [];
  for (const id of ids) {
    const node = defaultSceneGraph.getNode(id);
    if (!node || !isLayer(id) || !autoOrientModesFor(id).has(mode) || readAutoOrientMode(node) === mode) continue;
    cmds.push({ type: 'setLayerSwitches', layers: [id], patch: { autoOrient: API_AUTO_ORIENT[mode] } });
  }
  await edit('Auto-Orient', cmds);
}

// ── Layer / Solid Settings ────────────────────────────────────────────

/**
 * Layer / Solid Settings ▸ Apply: name, label and (solids, sized nulls and
 * adjustment layers) width/height and a solid's colour (`layer/fill`, G1), one
 * entry; an off-palette label colour is a custom `labelColor` (B3z).
 */
export async function layerSettingsEdit(nodeId: string, values: LayerSettingsValues): Promise<'ok' | 'gone'> {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node || !isLayer(nodeId)) return 'gone';
  const kind = layerSettingsKind(node);
  const fill = kind === 'solid' && values.color ? readNodeFill(node) : undefined;
  const colorChanged = !!values.color && kind === 'solid' && !(fill?.type === 'solid' && fill.color.toLowerCase() === values.color.toLowerCase());
  const labelChanged = 'labelColor' in values && (values.labelColor ?? undefined) !== (node.color ?? undefined);
  const cmds: Command[] = [];
  const name = values.name.trim();
  if (name && name !== node.name) cmds.push({ type: 'renameLayer', layer: nodeId, name });
  if (labelChanged) {
    // A colour outside the palette is a custom label (B3z `labelColor`).
    const label = labelIndexOf(values.labelColor);
    const patch = values.labelColor && label === 0 ? { labelColor: values.labelColor } : { label };
    cmds.push({ type: 'setLayerSwitches', layers: [nodeId], patch });
  }
  if (kind !== 'plain') {
    const t = node.components.find((c) => c.type === 'Transform')?.props as Record<string, unknown> | undefined;
    const size: Record<string, number> = {};
    const w = values.width !== undefined ? sanitizeLayerSize(values.width) : null;
    const h = values.height !== undefined ? sanitizeLayerSize(values.height) : null;
    if (w !== null && w !== t?.width) size.width = w;
    if (h !== null && h !== t?.height) size.height = h;
    if (Object.keys(size).length > 0) cmds.push(...valueCommands([{ nodeId, values: size }], { seconds: playheadSeconds() }));
  }
  if (colorChanged && values.color) {
    const [r, g, b, a] = parseColorChannels(values.color);
    cmds.push({ type: 'setProperty', prop: { layer: nodeId, path: 'layer/fill' }, value: { kind: 'color', value: { r, g, b, a } }, time: compTime(playheadSeconds()) });
  }
  await edit(kind === 'solid' ? 'Solid Settings' : 'Layer Settings', cmds);
  return 'ok';
}
