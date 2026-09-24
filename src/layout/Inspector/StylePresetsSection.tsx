/**
 * StylePresetsSection — one-click composed looks for the selected layer.
 *
 * Each swatch previews the preset with the layer's OWN accent colour, so the
 * grid shows what you would actually get rather than a generic sample. Applying
 * one writes ordinary fill / stroke / layer-style props, so everything stays
 * editable in the sections below and animates through the normal keyframe path.
 */

import { useMemo } from 'react';
import type { Command, PropertyInit } from '@motion/engine-api';
import { STYLE_PRESETS, applyStylePreset, type StylePreset, type StylePresetCategory } from '@core/style/stylePresets';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useSceneRevision } from '@stores/sceneStore';
import { useUIStore } from '@stores/uiStore';
import { getTime } from '@stores/playbackClockStore';
import { sortedStops, type FillPaint } from '@core/paint/fill';
import { getNodeLayerStyles, LAYER_STYLE_COLOR_PARAMS, LAYER_STYLE_NUMBER_PARAMS } from '@core/effects/layerStyles';
import { parseColorChannels } from '@core/effects/effects';
import { STYLE_FIELDS } from '@core/engine/effectFieldSpecs';
import { isLayer } from '@core/engine/doc';
import { paths, ref, values as apiValues } from '@core/engine/propRefs';
import { edit } from '@core/engine/uiEdits';
import { fieldCommands } from '@layout/Text/textEdits';
import { strokesCommands } from './appearance/paintEdits';
import { trackRef, valueCommands } from './inspectorEdits';
import { componentPropsCommands } from './useComponentProp';
import styles from './StylePresetsSection.module.css';

/** A paint as a CSS background, for the swatch preview only — the renderer has
 *  its own rasterizer and no CSS helper existed to reuse. */
function paintToCss(paint: FillPaint): string {
  if (paint.type === 'solid') return paint.color;
  const list = sortedStops(paint.stops)
    .map((s) => `${s.color} ${(s.offset * 100).toFixed(0)}%`)
    .join(', ');
  return paint.type === 'linear'
    // CSS 0deg points up and turns clockwise; the paint model's 0° points right.
    ? `linear-gradient(${paint.angle + 90}deg, ${list})`
    : `radial-gradient(circle at ${(paint.cx * 100).toFixed(0)}% ${(paint.cy * 100).toFixed(0)}%, ${list})`;
}

/**
 * A `Record` keyed by the category union, NOT a hand-written array: a preset
 * whose category has no entry here renders nowhere, and `STYLE_PRESETS` has no
 * other consumer. That is how all six 3D material presets (Steel, Gold,
 * Plastic, Glass, Neon, Obsidian) came to be unreachable — 'material' was
 * simply missing from the list, and nothing failed to say so.
 *
 * As a Record, adding a category to `StylePresetCategory` without giving it a
 * label is a compile error instead of six silently invisible presets.
 */
const GROUP_LABELS: Record<StylePresetCategory, string> = {
  surface: 'Surfaces',
  outline: 'Outlines',
  text: 'Text',
  depth: 'Depth',
  material: 'Materials',
};

/** Display order; anything not listed still renders, after these. */
const GROUP_ORDER: StylePresetCategory[] = ['surface', 'outline', 'text', 'depth', 'material'];

const GROUPS: Array<{ id: StylePresetCategory; label: string }> = (
  Object.keys(GROUP_LABELS) as StylePresetCategory[]
)
  .sort((a, b) => {
    const ia = GROUP_ORDER.indexOf(a), ib = GROUP_ORDER.indexOf(b);
    return (ia < 0 ? Number.MAX_SAFE_INTEGER : ia) - (ib < 0 ? Number.MAX_SAFE_INTEGER : ib);
  })
  .map((id) => ({ id, label: GROUP_LABELS[id] }));

export function StylePresetsSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  const node = defaultSceneGraph.getNode(nodeId);

  const accent = useMemo(() => {
    const c = node?.components.find((x) => x.type === 'Style' || x.type === 'Text');
    const fill = c?.props.fill;
    return typeof fill === 'string' && fill.startsWith('#') ? fill.slice(0, 7) : '#2b7eff';
  }, [node]);

  if (!node) return null;

  const applied = (label: string): void => {
    useUIStore.getState().notify({ level: 'success', message: `Applied “${label}”`, durationMs: 2000 });
  };
  const apply = (id: string, label: string): void => {
    const preset = STYLE_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    const styleComp = node.components.find((c) => c.type === 'Style' || c.type === 'Text');
    const plan = stylePresetCommands(nodeId, styleComp, preset, accent, getTime());
    if (plan.unaddressed.length > 0) {
      // B3-legacy: engine gap — Style `backdropBlur` (Glass / Soft UI, and clearing it) and the Transform's `specular` / `shininess` (the 3D material presets) are not API properties; such a preset keeps the legacy writer whole rather than half-applying.
      if (applyStylePreset(nodeId, id, accent)) applied(label);
      return;
    }
    void edit(`Apply ${label} Style`, plan.cmds).then((res) => { if (res.ok) applied(label); });
  };

  return (
    <div className={styles.root}>
      {GROUPS.map((group) => {
        const items = STYLE_PRESETS.filter((p) => p.category === group.id);
        if (items.length === 0) return null;
        return (
          <div key={group.id} className={styles.group}>
            <div className={styles.groupLabel}>{group.label}</div>
            <div className={styles.grid}>
              {items.map((preset) => {
                // Preview the real fill stack — top layer wins visually, which is
                // what the swatch should show.
                const fills = preset.fills(accent);
                const top = fills[fills.length - 1];
                const strokeTop = preset.strokes?.(accent).slice(-1)[0];
                const st = preset.styles?.(accent);
                const shadow = st?.dropShadow;
                const glow = st?.outerGlow;
                const boxShadow = [
                  shadow ? `0 ${Math.min(6, Math.round(shadow.distance / 15))}px ${Math.min(8, Math.round(shadow.blur / 2))}px rgba(0,0,0,${shadow.opacity})` : '',
                  glow ? `0 0 ${Math.min(10, Math.round(glow.size / 2))}px ${glow.color}` : '',
                ].filter(Boolean).join(', ');
                return (
                  <button
                    key={preset.id}
                    type="button"
                    className={styles.swatch}
                    title={`${preset.label} — ${preset.hint}`}
                    onClick={() => apply(preset.id, preset.label)}
                  >
                    <span
                      className={styles.chip}
                      style={{
                        background: top ? paintToCss(top) : 'transparent',
                        borderRadius: Math.min(12, preset.cornerRadius ?? 6),
                        ...(strokeTop ? { border: `${Math.min(3, strokeTop.width / 3)}px solid ${strokeTop.color}` } : {}),
                        ...(boxShadow ? { boxShadow } : {}),
                      }}
                    />
                    <span className={styles.label}>{preset.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── The preset as engine commands ───────────────────────────────────────

export interface StylePresetPlan {
  cmds: Command[];
  /** What the preset writes that the engine does not address (non-empty → the caller does not send `cmds`). */
  unaddressed: string[];
}

/** A layer style's init values (stored units → the style's API properties, relative to `styles/<key>`). */
function styleInit(key: string, style: Readonly<Record<string, unknown>>, unaddressed: string[]): PropertyInit[] {
  const init: PropertyInit[] = [];
  // The preset states the WHOLE style: a switch it leaves out reads as off in
  // the stored object (`useGlobalLight` undefined = the style's own angle),
  // while a new API group starts from the style's defaults (Global Light on).
  for (const sw of STYLE_FIELDS) {
    if (sw.style === key && sw.type === 'bool' && style[sw.key] === undefined) init.push({ path: sw.key, value: apiValues.bool(false) });
  }
  for (const [field, v] of Object.entries(style)) {
    if (field === 'enabled' || v === undefined) continue;
    const sw = STYLE_FIELDS.find((f) => f.style === key && f.key === field);
    if (sw?.type === 'bool' && typeof v === 'boolean') { init.push({ path: field, value: apiValues.bool(v) }); continue; }
    if (sw?.type === 'choice' && typeof v === 'string') { init.push({ path: field, value: apiValues.choice(v) }); continue; }
    const n = LAYER_STYLE_NUMBER_PARAMS[key]?.[field];
    if (n && typeof v === 'number' && Number.isFinite(v)) { init.push({ path: n.param, value: apiValues.scalar(v * n.scale) }); continue; }
    const c = LAYER_STYLE_COLOR_PARAMS[key]?.[field];
    if (c && typeof v === 'string') {
      const [r, g, b, a] = parseColorChannels(v);
      init.push({ path: c, value: apiValues.color(r, g, b, a) });
      continue;
    }
    unaddressed.push(`styles/${key}/${field}`);
  }
  return init;
}

const CORNER_TRACKS = ['cornerRadius', 'cornerRadiusTL', 'cornerRadiusTR', 'cornerRadiusBR', 'cornerRadiusBL'] as const;

/**
 * `applyStylePreset` as commands (one batch = one undo entry). Every axis is
 * stated, as the legacy apply does: the fill stack (`layer/fills`), the stroke
 * stack (`layer/strokes`), the layer styles (every current style removed, the
 * preset's added whole), the blending mode, and — on a Style / Text layer —
 * a uniform corner radius (all four corners + Link) and the opacity. Numbers
 * write at `seconds` (a key there when the property is animated).
 */
export function stylePresetCommands(
  nodeId: string,
  styleComp: { id: string; props: Readonly<Record<string, unknown>> } | undefined,
  preset: StylePreset,
  accent: string,
  seconds: number,
): StylePresetPlan {
  const unaddressed: string[] = [];
  if (!isLayer(nodeId)) return { cmds: [], unaddressed: ['layer'] };
  const cmds: Command[] = [];

  const fills = fieldCommands(nodeId, 'layer/fills', preset.fills(accent));
  if (fills.length === 0) unaddressed.push('layer/fills');
  cmds.push(...fills);
  const strokes = strokesCommands(nodeId, preset.strokes ? preset.strokes(accent) : []);
  if (strokes.length === 0) unaddressed.push('layer/strokes');
  cmds.push(...strokes);

  const current = Object.entries(getNodeLayerStyles(nodeId)).filter(([, v]) => v !== undefined).map(([k]) => k);
  if (current.length > 0) cmds.push({ type: 'removePropertyGroups', groups: current.map((k) => ref(nodeId, paths.styleGroup(k))) });
  for (const [key, style] of Object.entries(preset.styles ? preset.styles(accent) : {})) {
    if (!style) continue;
    const s = style as unknown as Readonly<Record<string, unknown>>;
    cmds.push({ type: 'addPropertyGroup', layer: nodeId, parent: 'styles', matchName: `style:${key}`, init: styleInit(key, s, unaddressed) });
    if (s.enabled === false) cmds.push({ type: 'setGroupEnabled', groups: [ref(nodeId, paths.styleGroup(key))], enabled: false });
  }

  cmds.push({ type: 'setBlendMode', layers: [nodeId], mode: preset.blend ?? 'normal' });

  if (styleComp) {
    if (preset.cornerRadius !== undefined) {
      const r = preset.cornerRadius;
      if (CORNER_TRACKS.every((t) => trackRef(nodeId, t) !== null)) {
        cmds.push(...valueCommands([{ nodeId, values: Object.fromEntries(CORNER_TRACKS.map((t) => [t, r])) }], { seconds }));
        cmds.push(...fieldCommands(nodeId, 'layer/cornersLinked', true));
      } else unaddressed.push('cornerRadius');
    }
    if (preset.opacity !== undefined) {
      const o = componentPropsCommands(nodeId, styleComp.id, { opacity: preset.opacity }, seconds);
      unaddressed.push(...Object.keys(o.rest));
      cmds.push(...o.cmds);
    }
    // Written unconditionally by the legacy apply (switching away from Glass clears the frost).
    if (preset.backdropBlur !== undefined || styleComp.props.backdropBlur !== undefined) unaddressed.push('backdropBlur');
  }
  if (preset.specular !== undefined) unaddressed.push('specular');
  if (preset.shininess !== undefined) unaddressed.push('shininess');
  return { cmds, unaddressed };
}
