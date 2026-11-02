/**
 * LayerStylesControls (Prompt E8) — Photoshop-style layer styles for a layer.
 *
 * Every numeric and colour field carries a STOPWATCH, so a style animates the
 * same way an effect parameter does. That is what makes "shadow here, no shadow
 * there" expressible: keyframe the style's Opacity (or Size) rather than trying
 * to animate its on/off checkbox, which is also how it is done in After Effects.
 *
 * The tracks live on the compiled effect's path — `effect.layerstyle:<style>.
 * <param>` — because `layerStylesToEffects` is what the renderer samples. The
 * style field and the effect param are often named differently (a shadow's
 * `blur` is the effect's `softness`), so the mapping comes from
 * LAYER_STYLE_NUMBER_PARAMS / LAYER_STYLE_COLOR_PARAMS rather than being
 * guessed here; a test asserts those name params that really are emitted.
 *
 * Glass is the exception: it resolves through `glassResolve`, not the effect
 * chain, so its fields animate under `glass.<field>` and in STORED units (0..1
 * opacities) rather than the 0..100 the field displays — hence `trackFactor`.
 *
 * AE's model (2026-10-07): only APPLIED styles are listed, in AE's order (Drop
 * Shadow, Inner Shadow, Outer Glow, Inner Glow, Bevel and Emboss, Satin, Colour
 * Overlay, Gradient Overlay, Stroke, then our Glass). The rest are added from
 * the "Add layer style" menu; unticking an applied style removes it.
 *
 * Writes go through the engine API (B3, effectEdits.ts): adding a style or
 * unticking it is `addPropertyGroup` / `removePropertyGroups` on `styles/<key>`, its numbers and
 * colours `styles/<key>/<param>` (a scrub or colour drag is one gesture), Glass
 * `styles/glass/<param>`, the switches (Use Global Light, Invert, Carve, Stroke
 * Position) field writes on the style, the Global Light a composition setting.
 * Editing or animating an angle still bound to the Global Light unbinds it in
 * the same undo entry.
 */

import { useState } from 'react';
import { ValueField } from '@components/ValueField';
import { Button } from '@components/Button';
import { Icon } from '@components/Icon';
import { Popover } from '@components/Popover';
import { Menu, MenuItem, MenuSeparator } from '@components/Menu';
import { useThrottledTime } from '@stores/playbackClockStore';
import { ColorPicker } from '@components/ColorPicker';
import { Checkbox } from '@components/Checkbox';
import { AngleDial } from '@components/AngleDial';
import { StopwatchButton, KeyframeNavigator } from '@components/PropertyRow';
import { useTrackNavigator } from '@layout/Inspector/AnimToggle';
import { useEngineEdit } from '@layout/Inspector/useEngineEdit';
import type { Command } from '@motion/engine-api';
import { stopwatchCommands, scalarValueCommands, valueCommands } from '@layout/Inspector/inspectorEdits';
import { useActiveWorkspace, resolveGlobalLight } from '@stores/projectStore';
import { documentMirror } from '@stores/documentMirror';
import { useActiveMirrorComp, useMirrorTrackWatch, useMirrorTreeGroups } from '@hooks/useMirror';
import { isTrackAnimated, readTrack, trackRef, valueNumbersAt } from '@core/mirror/selection';
import { Color } from '@core/paint/color';
import { effectPropPath, resolveChannelColor } from '@core/inspector/effectCatalog';
import { glassPropPath, type GlassParam } from '@core/effects/glassResolve';
import { mirrorLayerStyles } from '@core/mirror/layerFacts';
import {
  layerStyleEffectId,
  LAYER_STYLE_NUMBER_PARAMS,
  LAYER_STYLE_COLOR_PARAMS,
  type GlassStyle,
  type LayerStyles,
  type StrokeStylePosition,
} from '@core/effects/layerStyles';
import {
  globalLightCommands,
  patchLayerStyleEdit,
  setLayerStyleOnEdit,
  styleTrackOnEngine,
  unbindGlobalLightCommands,
} from './effectEdits';
import styles from './EffectsPanel.module.css';
import { t } from '@core/i18n';

function strokePositions(): { id: StrokeStylePosition; label: string }[] {
  return [
    { id: 'outside', label: t('effects.styles.outside', 'Outside') },
    { id: 'inside', label: t('effects.styles.inside', 'Inside') },
    { id: 'center', label: t('effects.styles.center', 'Center') },
  ];
}

/** Liquid glass (stream D): where the glass surface's normal comes from. */
function glassSurfaces(): { id: NonNullable<GlassStyle['surface']>; label: string }[] {
  return [
    { id: 'edge', label: t('effects.styles.glassSurfaceEdge', 'Edge') },
    { id: 'dome', label: t('effects.styles.glassSurfaceDome', 'Dome') },
    { id: 'luma', label: t('effects.styles.glassSurfaceLuma', 'Luminance') },
    { id: 'layer', label: t('effects.styles.glassSurfaceLayer', 'Layer') },
  ];
}

/** The comp's OTHER layers at the same level, top first (the glass Bump layer picker). */
function siblingLayerOptions(nodeId: string): Array<{ id: string; name: string }> {
  const m = documentMirror();
  const self = m.layer(nodeId);
  const comp = self ? m.comp(self.comp) : undefined;
  if (!self || !comp) return [];
  const out: Array<{ id: string; name: string }> = [];
  for (let i = comp.layers.length - 1; i >= 0; i--) {
    const id = comp.layers[i]!;
    if (id === nodeId) continue;
    const l = m.layer(id);
    if (l && l.parent === self.parent) out.push({ id, name: l.name });
  }
  return out;
}

/** Animation prop path for one numeric layer-style field. */
function stylePath(style: keyof LayerStyles, field: string): string | null {
  const b = LAYER_STYLE_NUMBER_PARAMS[style as string]?.[field];
  return b ? effectPropPath(layerStyleEffectId(style), b.param) : null;
}

/** Animation prop path for one colour layer-style field. */
function styleColorPath(style: keyof LayerStyles, field: string): string | null {
  const p = LAYER_STYLE_COLOR_PARAMS[style as string]?.[field];
  return p ? effectPropPath(layerStyleEffectId(style), p) : null;
}

/**
 * A numeric style field with a stopwatch.
 *
 * `value` and `onChange` are in DISPLAY units (opacity as 0..100, matching what
 * the field shows). `trackFactor` converts display → track units: 1 for layer
 * styles, whose compiled effect params share the display scale, and 0.01 for
 * Glass, whose tracks are read back in stored 0..1.
 */
function StyleNum({
  nodeId, path, label, value, onChange, trackFactor = 1, unbind, bare = false,
  min, max, step, precision = 0, unit,
}: {
  nodeId: string;
  /** Null → not animatable; renders without a stopwatch. */
  path: string | null;
  label: string;
  value: number;
  onChange: (v: number) => void;
  trackFactor?: number;
  /**
   * Set while the field shows the composition's Global Light: the style whose
   * `useGlobalLight` an edit or a first keyframe switches off, in the same undo
   * entry. The binding overrides the style's own angle at render time, so a
   * value or a track written while still bound would be ignored.
   */
  unbind?: keyof LayerStyles;
  /** Render stopwatch + field only, with no label wrapper — for the horizontal
   *  rows (Tint, Rim) where the label already sits beside the colour swatch. */
  bare?: boolean;
  min?: number; max?: number; step?: number; precision?: number; unit?: string;
}): JSX.Element {
  const time = useActiveWorkspace()?.time ?? 0;
  // B4: the track's info, keys and value at the playhead from the document mirror.
  useMirrorTrackWatch([nodeId], path ? [path] : []);
  const m = documentMirror();
  const e = useEngineEdit();
  const animated = !!path && isTrackAnimated(m, nodeId, path);
  const display = animated
    ? (readTrack(m, nodeId, path!, time) ?? value * trackFactor) / trackFactor
    : value;
  // `styles/<key>/<param>` (Glass `styles/glass/<param>`) through the engine.
  const onEngine = styleTrackOnEngine(nodeId, path);
  const unbound = (): Command[] => (unbind ? unbindGlobalLightCommands(nodeId, unbind) : []);

  const set = (v: number): void => {
    if (onEngine) {
      e.send(`Set ${label}`, [...unbound(), ...scalarValueCommands(path!, [{ nodeId, value: v * trackFactor }], { seconds: time })]);
    } else {
      onChange(v);
    }
  };
  const toggle = (): void => {
    if (!path || !onEngine) return;
    if (animated) {
      e.send(`Remove ${label} animation`, stopwatchCommands([nodeId], [path], time));
    } else {
      // A bound field keys the angle it shows (the Global Light's), not the style's own.
      const shown = unbind ? scalarValueCommands(path, [{ nodeId, value: value * trackFactor }], { seconds: time }) : [];
      e.send(`Animate ${label}`, [...unbound(), ...shown, ...stopwatchCommands([nodeId], [path], time)]);
    }
  };

  const field = (
    <ValueField
      {...e.scrub(`Set ${label}`, () => onEngine)}
      value={display}
      min={min} max={max} step={step} precision={precision} unit={unit}
      onChange={set}
      aria-label={label}
    />
  );
  const nav = useTrackNavigator(nodeId, path ? [path] : [], label, () => [display * trackFactor]);
  const watch = path ? (
    <>
      <StopwatchButton animated={animated} label={label} onToggle={toggle} />
      {animated && <KeyframeNavigator label={label} {...nav} />}
    </>
  ) : null;

  if (bare) return <>{watch}{field}</>;
  return (
    <label className={styles.maskField}>
      <span className={styles.styleFieldHead}>{watch}{label}</span>
      {field}
    </label>
  );
}

/**
 * A colour style field with a stopwatch.
 *
 * Colours animate through the decomposed `_r/_g/_b/_a` channel tracks that
 * `resolveEffectParams` recomposes per frame — the same mechanism an effect's
 * colour uses, so an animated shadow colour needs nothing new in the engine.
 */
function StyleColor({
  nodeId, path, label, value, onChange,
}: {
  nodeId: string;
  path: string | null;
  label: string;
  value: string;
  onChange: (hex: string) => void;
}): JSX.Element {
  const time = useActiveWorkspace()?.time ?? 0;
  // B4: the colour's info, keys and value at the playhead from the document mirror.
  useMirrorTrackWatch([nodeId], path ? [`${path}_r`] : []);
  const m = documentMirror();
  const e = useEngineEdit();
  const animated = !!path && isTrackAnimated(m, nodeId, `${path}_r`);

  // Same rule the RENDERER uses — see `resolveChannelColor`. An unanimated
  // channel falls back to the STORED colour's channel; defaulting it to 255 made
  // the swatch show a colour the render never used.
  const colorRef = animated ? trackRef(m, nodeId, `${path}_r`) : null;
  const sampled = colorRef ? valueNumbersAt(m, nodeId, colorRef.path, time) : [];
  const CH = { _r: 0, _g: 1, _b: 2, _a: 3 } as const;
  const displayed = animated
    ? resolveChannelColor(value, (s) => sampled[CH[s]])
    : value;
  // One colour property `styles/<key>/<param>` (Glass `styles/glass/<param>`) through the engine.
  const onEngine = styleTrackOnEngine(nodeId, path ? `${path}_r` : null);
  const channels = (hex: string): Record<string, number> => {
    const c = Color.fromHex(hex);
    return { [`${path}_r`]: c.r, [`${path}_g`]: c.g, [`${path}_b`]: c.b, [`${path}_a`]: c.a ?? 1 };
  };

  const set = (hex: string): void => {
    if (onEngine) e.send(`Set ${label}`, valueCommands([{ nodeId, values: channels(hex) }], { seconds: time }));
    else onChange(hex);
  };
  const toggle = (): void => {
    if (!path || !onEngine) return;
    e.send(animated ? `Remove ${label} animation` : `Animate ${label}`, stopwatchCommands([nodeId], [`${path}_r`], time));
  };

  const nav = useTrackNavigator(
    nodeId,
    path ? [`${path}_r`, `${path}_g`, `${path}_b`, `${path}_a`] : [],
    label,
    () => { const c = Color.fromHex(displayed); return [c.r, c.g, c.b, c.a ?? 1]; },
  );
  return (
    <>
      {path ? <StopwatchButton animated={animated} label={label} onToggle={toggle} /> : null}
      {path && animated ? <KeyframeNavigator label={label} {...nav} /> : null}
      {/* A picker drag (press → release) is one gesture on the engine route. */}
      <span style={{ display: 'contents' }} {...e.press(`Set ${label}`, () => onEngine)}>
        <ColorPicker value={displayed} onChange={set} aria-label={label} />
      </span>
    </>
  );
}

/** The root group of the layer's property tree the style set is read from. */
const STYLES_ROOT: readonly string[] = ['styles'];

/**
 * AE's Layer > Layer Styles menu, in AE's order, then Glass (ours). Only the
 * styles a layer does NOT have are offered; an applied style is listed below
 * with its checkbox, and unticking it removes it. Bevel and Emboss is
 * unavailable while the layer has a geometric 3D bevel: both would draw a
 * bevel on the front face.
 */
/** `label` is shown; `undo` names the undo entry (kept English, like every undo label). */
function addableStyles(): ReadonlyArray<{ key: keyof LayerStyles; label: string; undo: string } | 'sep'> {
  return [
    { key: 'dropShadow', label: t('effects.styles.menuDropShadow', 'Drop Shadow'), undo: 'Drop Shadow' },
    { key: 'innerShadow', label: t('effects.styles.menuInnerShadow', 'Inner Shadow'), undo: 'Inner Shadow' },
    { key: 'outerGlow', label: t('effects.styles.menuOuterGlow', 'Outer Glow'), undo: 'Outer Glow' },
    { key: 'innerGlow', label: t('effects.styles.menuInnerGlow', 'Inner Glow'), undo: 'Inner Glow' },
    { key: 'bevel', label: t('effects.styles.menuBevel', 'Bevel and Emboss'), undo: 'Bevel and Emboss' },
    { key: 'satin', label: t('effects.styles.menuSatin', 'Satin'), undo: 'Satin' },
    { key: 'colorOverlay', label: t('effects.styles.menuColorOverlay', 'Color Overlay'), undo: 'Color Overlay' },
    { key: 'gradientOverlay', label: t('effects.styles.menuGradientOverlay', 'Gradient Overlay'), undo: 'Gradient Overlay' },
    { key: 'stroke', label: t('effects.styles.menuStroke', 'Stroke'), undo: 'Stroke' },
    'sep',
    { key: 'glass', label: t('effects.styles.menuGlass', 'Glass'), undo: 'Glass' },
  ];
}

function AddLayerStyleMenu({
  nodeId,
  applied,
  geometricBevel,
}: {
  nodeId: string;
  applied: LayerStyles;
  geometricBevel: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const items = addableStyles().filter((it) => it === 'sep' || !applied[it.key]);
  const none = items.every((it) => it === 'sep');
  return (
    <div className={styles.blendRow}>
      <Popover
        open={open}
        onOpenChange={setOpen}
        placement="bottom-start"
        trigger={(
          <Button
            size="xs"
            variant="ghost"
            leftIcon={<Icon name="plus" size="sm" />}
            disabled={none}
            aria-label={t('effects.styles.addLayerStyle', 'Add layer style')}
          >
            {t('effects.styles.addLayerStyle', 'Add layer style')}
          </Button>
        )}
      >
        <Menu ariaLabel={t('effects.styles.addLayerStyle', 'Add layer style')} onItemActivate={() => setOpen(false)}>
          {items.map((it, i) => (it === 'sep'
            ? <MenuSeparator key={`sep${i}`} />
            : (
              <MenuItem
                key={it.key}
                id={it.key}
                label={it.key === 'bevel' && geometricBevel ? t('effects.styles.bevelDisabled', '{name} (3D bevel is on)', { name: it.label }) : it.label}
                disabled={it.key === 'bevel' && geometricBevel}
                onSelect={() => { void setLayerStyleOnEdit(nodeId, it.key, true, it.undo); }}
              />
            )))}
        </Menu>
      </Popover>
    </div>
  );
}

/** The geometry tracks that decide whether Bevel and Emboss is offered. */
const BEVEL_TRACKS: readonly string[] = ['extrusionDepth', 'bevelDepth'];

export function LayerStylesControls({ nodeId }: { nodeId: string }): JSX.Element {
  // B4: the style set from the mirror's `styles/<key>` groups (static values).
  // Only the `styles/*` groups are read (plus the tree's shape): a drag of Position leaves this alone.
  const ls = mirrorLayerStyles(useMirrorTreeGroups(nodeId, STYLES_ROOT));
  const gl = ls.glass;
  const ds = ls.dropShadow;
  const og = ls.outerGlow;
  const ish = ls.innerShadow;
  const igl = ls.innerGlow;
  const sat = ls.satin;
  const bev = ls.bevel;
  const co = ls.colorOverlay;
  const go = ls.gradientOverlay;
  const stk = ls.stroke;
  // B4: the composition's Global Light from the document mirror.
  const settings = useActiveMirrorComp()?.settings;
  const comp = { a: settings?.globalLightAngle, alt: settings?.globalLightAltitude };
  const e = useEngineEdit();
  const setLight = (patch: { globalLightAngle?: number; globalLightAltitude?: number }): void =>
    e.send('Global Light', globalLightCommands(patch));
  const light = resolveGlobalLight({ globalLightAngle: comp.a, globalLightAltitude: comp.alt });
  const boundToLight = ds?.useGlobalLight !== false;
  const anyApplied = !!(gl || ds || og || ish || igl || sat || bev || co || go || stk);
  // A geometric bevel (Geometry Options) already shapes the front face.
  useMirrorTrackWatch([nodeId], BEVEL_TRACKS);
  const time = useThrottledTime();
  const m = documentMirror();
  const geometricBevel = m.layer(nodeId)?.switches.threeD === true
    && (readTrack(m, nodeId, 'extrusionDepth', time) ?? 0) > 0
    && (readTrack(m, nodeId, 'bevelDepth', time) ?? 0) > 0;

  return (
    <>
      <AddLayerStyleMenu nodeId={nodeId} applied={ls} geometricBevel={geometricBevel} />

      {anyApplied && (
        <>
        {/* GLOBAL LIGHT — one direction for every style in the composition that
            opts in. This is what a layer style has and the equivalent effect does
            not: re-light the whole scene from one control. */}
        <div className={styles.blendRow}>
          <span className={styles.blendLabel}>{t('effects.styles.globalLight', 'Global light')}</span>
          <span style={{ display: 'contents' }} {...e.press('Global Light')}>
            <AngleDial
              value={light.angle}
              onChange={(angle) => setLight({ globalLightAngle: angle })}
              aria-label={t('effects.styles.globalLightAngle', 'Global light angle')}
            />
          </span>
          <ValueField
            {...e.scrub('Global Light')}
            value={light.angle}
            precision={0}
            unit="°"
            onChange={(angle) => setLight({ globalLightAngle: angle })}
            aria-label={t('effects.styles.globalLightAngleValue', 'Global light angle value')}
          />
          <span className={styles.blendLabel} style={{ marginLeft: 8 }}>{t('effects.styles.altitude', 'Altitude')}</span>
          <ValueField
            {...e.scrub('Global Light')}
            value={light.altitude}
            min={0}
            max={90}
            precision={0}
            unit="°"
            onChange={(altitude) => setLight({ globalLightAltitude: altitude })}
            aria-label={t('effects.styles.globalLightAltitude', 'Global light altitude')}
          />
        </div>
        </>
      )}

      {ds ? (
      <div className={styles.blendRow}>
        <Checkbox
          checked
          onChange={() => { void setLayerStyleOnEdit(nodeId, 'dropShadow', !ds, 'Drop Shadow'); }}
          label={<span className={styles.blendLabel} style={{ marginLeft: 6 }}>{t('effects.styles.dropShadow', 'Drop shadow')}</span>}
          aria-label={t('effects.styles.dropShadow', 'Drop shadow')}
        />
      </div>
      ) : null}
      {ds ? (
        <>
          <div className={styles.blendRow}>
            <span className={styles.blendLabel}>{t('effects.styles.color', 'Color')}</span>
            <StyleColor nodeId={nodeId} path={styleColorPath('dropShadow', 'color')}
              label={t('effects.styles.shadowColor', 'Shadow color')} value={ds.color}
              onChange={(color) => void patchLayerStyleEdit(nodeId, 'dropShadow', { color })} />
          </div>
          <div className={styles.blendRow}>
            <Checkbox
              checked={boundToLight}
              onChange={() => void patchLayerStyleEdit(nodeId, 'dropShadow', { useGlobalLight: !boundToLight })}
              label={<span className={styles.blendLabel} style={{ marginLeft: 6 }}>{t('effects.styles.useGlobalLight', 'Use global light')}</span>}
              aria-label={t('effects.styles.useGlobalLight', 'Use global light')}
            />
          </div>
          <div className={styles.maskControls}>
            <StyleNum nodeId={nodeId} path={stylePath('dropShadow', 'distance')}
              label={t('effects.styles.distance', 'Distance')} value={ds.distance} min={0} max={200} unit="px"
              onChange={(v) => void patchLayerStyleEdit(nodeId, 'dropShadow', { distance: v })} />
            <StyleNum nodeId={nodeId} path={stylePath('dropShadow', 'angle')}
              label={t('effects.styles.angle', 'Angle')} value={boundToLight ? light.angle : ds.angle} unit="°"
              unbind={boundToLight ? 'dropShadow' : undefined}
              onChange={(v) => void patchLayerStyleEdit(nodeId, 'dropShadow', { angle: v, useGlobalLight: false })} />
          </div>
          <div className={styles.maskControls}>
            <StyleNum nodeId={nodeId} path={stylePath('dropShadow', 'blur')}
              label={t('effects.styles.blur', 'Blur')} value={ds.blur} min={0} max={200} unit="px"
              onChange={(v) => void patchLayerStyleEdit(nodeId, 'dropShadow', { blur: v })} />
            <StyleNum nodeId={nodeId} path={stylePath('dropShadow', 'spread')}
              label={t('effects.styles.spread', 'Spread')} value={ds.spread ?? 0} min={0} max={100} unit="%"
              onChange={(v) => void patchLayerStyleEdit(nodeId, 'dropShadow', { spread: v })} />
          </div>
          <div className={styles.maskControls}>
            <StyleNum nodeId={nodeId} path={stylePath('dropShadow', 'opacity')}
              label={t('effects.styles.opacity', 'Opacity')} value={Math.round(ds.opacity * 100)} min={0} max={100} unit="%"
              onChange={(v) => void patchLayerStyleEdit(nodeId, 'dropShadow', { opacity: v / 100 })} />
          </div>
        </>
      ) : null}

      {/* ── Inner shadow ───────────────────────────────────────── */}
      {ish ? (
      <div className={styles.blendRow}>
        <Checkbox
          checked
          onChange={() => { void setLayerStyleOnEdit(nodeId, 'innerShadow', !ish, 'Inner Shadow'); }}
          label={<span className={styles.blendLabel} style={{ marginLeft: 6 }}>{t('effects.styles.innerShadow', 'Inner shadow')}</span>}
          aria-label={t('effects.styles.innerShadow', 'Inner shadow')}
        />
      </div>
      ) : null}
      {ish ? (
        <>
          <div className={styles.blendRow}>
            <span className={styles.blendLabel}>{t('effects.styles.color', 'Color')}</span>
            <StyleColor nodeId={nodeId} path={styleColorPath('innerShadow', 'color')}
              label={t('effects.styles.innerShadowColor', 'Inner shadow color')} value={ish.color}
              onChange={(color) => void patchLayerStyleEdit(nodeId, 'innerShadow', { color })} />
          </div>
          <div className={styles.maskControls}>
            <StyleNum nodeId={nodeId} path={stylePath('innerShadow', 'distance')}
              label={t('effects.styles.distance', 'Distance')} value={ish.distance} min={0} max={200} unit="px"
              onChange={(v) => void patchLayerStyleEdit(nodeId, 'innerShadow', { distance: v })} />
            <StyleNum nodeId={nodeId} path={stylePath('innerShadow', 'angle')}
              label={t('effects.styles.angle', 'Angle')} value={ish.useGlobalLight ? light.angle : ish.angle} unit="°"
              unbind={ish.useGlobalLight ? 'innerShadow' : undefined}
              onChange={(v) => void patchLayerStyleEdit(nodeId, 'innerShadow', { angle: v, useGlobalLight: false })} />
          </div>
          <div className={styles.maskControls}>
            <StyleNum nodeId={nodeId} path={stylePath('innerShadow', 'size')}
              label={t('effects.styles.size', 'Size')} value={ish.size} min={0} max={200} unit="px"
              onChange={(v) => void patchLayerStyleEdit(nodeId, 'innerShadow', { size: v })} />
            <StyleNum nodeId={nodeId} path={stylePath('innerShadow', 'opacity')}
              label={t('effects.styles.opacity', 'Opacity')} value={Math.round(ish.opacity * 100)} min={0} max={100} unit="%"
              onChange={(v) => void patchLayerStyleEdit(nodeId, 'innerShadow', { opacity: v / 100 })} />
          </div>
          <div className={styles.blendRow}>
            <Checkbox
              checked={ish.useGlobalLight !== false}
              onChange={() => void patchLayerStyleEdit(nodeId, 'innerShadow', { useGlobalLight: ish.useGlobalLight === false })}
              label={<span className={styles.blendLabel} style={{ marginLeft: 6 }}>{t('effects.styles.useGlobalLight', 'Use global light')}</span>}
              aria-label={t('effects.styles.innerShadowUseGlobalLight', 'Inner shadow use global light')}
            />
          </div>
        </>
      ) : null}

      {og ? (
      <div className={styles.blendRow}>
        <Checkbox
          checked
          onChange={() => { void setLayerStyleOnEdit(nodeId, 'outerGlow', !og, 'Outer Glow'); }} 
          label={<span className={styles.blendLabel} style={{ marginLeft: 6 }}>{t('effects.styles.outerGlow', 'Outer glow')}</span>} 
          aria-label={t('effects.styles.outerGlow', 'Outer glow')} 
        />
      </div>
      ) : null}
      {og ? (
        <>
          <div className={styles.blendRow}>
            <span className={styles.blendLabel}>{t('effects.styles.color', 'Color')}</span>
            <StyleColor nodeId={nodeId} path={styleColorPath('outerGlow', 'color')}
              label={t('effects.styles.glowColor', 'Glow color')} value={og.color}
              onChange={(color) => void patchLayerStyleEdit(nodeId, 'outerGlow', { color })} />
          </div>
          <div className={styles.maskControls}>
            <StyleNum nodeId={nodeId} path={stylePath('outerGlow', 'size')}
              label={t('effects.styles.size', 'Size')} value={og.size} min={0} max={200} unit="px"
              onChange={(v) => void patchLayerStyleEdit(nodeId, 'outerGlow', { size: v })} />
            <StyleNum nodeId={nodeId} path={stylePath('outerGlow', 'spread')}
              label={t('effects.styles.spread', 'Spread')} value={og.spread ?? 0} min={0} max={100} unit="%"
              onChange={(v) => void patchLayerStyleEdit(nodeId, 'outerGlow', { spread: v })} />
          </div>
          <div className={styles.maskControls}>
            <StyleNum nodeId={nodeId} path={stylePath('outerGlow', 'opacity')}
              label={t('effects.styles.opacity', 'Opacity')} value={Math.round(og.opacity * 100)} min={0} max={100} unit="%"
              onChange={(v) => void patchLayerStyleEdit(nodeId, 'outerGlow', { opacity: v / 100 })} />
          </div>
        </>
      ) : null}

      {/* ── Inner glow ─────────────────────────────────────────── */}
      {igl ? (
      <div className={styles.blendRow}>
        <Checkbox
          checked
          onChange={() => { void setLayerStyleOnEdit(nodeId, 'innerGlow', !igl, 'Inner Glow'); }}
          label={<span className={styles.blendLabel} style={{ marginLeft: 6 }}>{t('effects.styles.innerGlow', 'Inner glow')}</span>}
          aria-label={t('effects.styles.innerGlow', 'Inner glow')}
        />
      </div>
      ) : null}
      {igl ? (
        <div className={styles.maskControls}>
          <label className={styles.maskField}>
            <span>{t('effects.styles.color', 'Color')}</span>
            <StyleColor nodeId={nodeId} path={styleColorPath('innerGlow', 'color')}
              label={t('effects.styles.innerGlowColor', 'Inner glow color')} value={igl.color}
              onChange={(color) => void patchLayerStyleEdit(nodeId, 'innerGlow', { color })} />
          </label>
          <StyleNum nodeId={nodeId} path={stylePath('innerGlow', 'size')}
            label={t('effects.styles.size', 'Size')} value={igl.size} min={0} max={200} unit="px"
            onChange={(v) => void patchLayerStyleEdit(nodeId, 'innerGlow', { size: v })} />
          <StyleNum nodeId={nodeId} path={stylePath('innerGlow', 'opacity')}
            label={t('effects.styles.opacity', 'Opacity')} value={Math.round(igl.opacity * 100)} min={0} max={100} unit="%"
            onChange={(v) => void patchLayerStyleEdit(nodeId, 'innerGlow', { opacity: v / 100 })} />
        </div>
      ) : null}

      {/* ── Bevel & emboss ─────────────────────────────────────── */}
      {bev ? (
      <div className={styles.blendRow}>
        <Checkbox
          checked
          onChange={() => { void setLayerStyleOnEdit(nodeId, 'bevel', !bev, 'Bevel & Emboss'); }}
          label={<span className={styles.blendLabel} style={{ marginLeft: 6 }}>{t('effects.styles.bevelAmpEmboss', 'Bevel & emboss')}</span>}
          aria-label={t('effects.styles.bevelAndEmboss', 'Bevel and emboss')}
        />
      </div>
      ) : null}
      {bev ? (
        <>
          <div className={styles.maskControls}>
            <StyleNum nodeId={nodeId} path={stylePath('bevel', 'size')}
              label={t('effects.styles.size', 'Size')} value={bev.size} min={1} max={100} unit="px"
              onChange={(v) => void patchLayerStyleEdit(nodeId, 'bevel', { size: v })} />
            <StyleNum nodeId={nodeId} path={stylePath('bevel', 'depth')}
              label={t('effects.styles.depth', 'Depth')} value={bev.depth} min={0} max={500} unit="%"
              onChange={(v) => void patchLayerStyleEdit(nodeId, 'bevel', { depth: v })} />
          </div>
          <div className={styles.maskControls}>
            <StyleNum nodeId={nodeId} path={stylePath('bevel', 'angle')}
              label={t('effects.styles.angle', 'Angle')} value={bev.useGlobalLight ? light.angle : bev.angle} unit="°"
              unbind={bev.useGlobalLight ? 'bevel' : undefined}
              onChange={(v) => void patchLayerStyleEdit(nodeId, 'bevel', { angle: v, useGlobalLight: false })} />
            <StyleNum nodeId={nodeId} path={stylePath('bevel', 'altitude')}
              label={t('effects.styles.altitude', 'Altitude')} value={bev.useGlobalLight ? light.altitude : bev.altitude} min={0} max={90} unit="°"
              unbind={bev.useGlobalLight ? 'bevel' : undefined}
              onChange={(v) => void patchLayerStyleEdit(nodeId, 'bevel', { altitude: v, useGlobalLight: false })} />
          </div>
          <div className={styles.blendRow}>
            <span className={styles.blendLabel}>{t('effects.styles.highlight', 'Highlight')}</span>
            <StyleColor nodeId={nodeId} path={styleColorPath('bevel', 'highlightColor')}
              label={t('effects.styles.bevelHighlightColor', 'Bevel highlight color')} value={bev.highlightColor}
              onChange={(highlightColor) => void patchLayerStyleEdit(nodeId, 'bevel', { highlightColor })} />
            <StyleNum nodeId={nodeId} path={stylePath('bevel', 'highlightOpacity')} bare
              label={t('effects.styles.bevelHighlightOpacity', 'Bevel highlight opacity')} value={Math.round(bev.highlightOpacity * 100)}
              min={0} max={100} unit="%"
              onChange={(v) => void patchLayerStyleEdit(nodeId, 'bevel', { highlightOpacity: v / 100 })} />
          </div>
          <div className={styles.blendRow}>
            <span className={styles.blendLabel}>{t('effects.styles.shadow', 'Shadow')}</span>
            <StyleColor nodeId={nodeId} path={styleColorPath('bevel', 'shadowColor')}
              label={t('effects.styles.bevelShadowColor', 'Bevel shadow color')} value={bev.shadowColor}
              onChange={(shadowColor) => void patchLayerStyleEdit(nodeId, 'bevel', { shadowColor })} />
            <StyleNum nodeId={nodeId} path={stylePath('bevel', 'shadowOpacity')} bare
              label={t('effects.styles.bevelShadowOpacity', 'Bevel shadow opacity')} value={Math.round(bev.shadowOpacity * 100)}
              min={0} max={100} unit="%"
              onChange={(v) => void patchLayerStyleEdit(nodeId, 'bevel', { shadowOpacity: v / 100 })} />
          </div>
          <div className={styles.blendRow}>
            <Checkbox
              checked={bev.direction === 'down'}
              onChange={() => void patchLayerStyleEdit(nodeId, 'bevel', { direction: bev.direction === 'down' ? 'up' : 'down' })}
              label={<span className={styles.blendLabel} style={{ marginLeft: 6 }}>{t('effects.styles.carveDown', 'Carve (down)')}</span>}
              aria-label={t('effects.styles.bevelDirectionDown', 'Bevel direction down')}
            />
          </div>
          <div className={styles.blendRow}>
            <Checkbox
              checked={bev.useGlobalLight !== false}
              onChange={() => void patchLayerStyleEdit(nodeId, 'bevel', { useGlobalLight: bev.useGlobalLight === false })}
              label={<span className={styles.blendLabel} style={{ marginLeft: 6 }}>{t('effects.styles.useGlobalLight', 'Use global light')}</span>}
              aria-label={t('effects.styles.bevelUseGlobalLight', 'Bevel use global light')}
            />
          </div>
        </>
      ) : null}

      {/* ── Satin ──────────────────────────────────────────────── */}
      {sat ? (
      <div className={styles.blendRow}>
        <Checkbox
          checked
          onChange={() => { void setLayerStyleOnEdit(nodeId, 'satin', !sat, 'Satin'); }}
          label={<span className={styles.blendLabel} style={{ marginLeft: 6 }}>{t('effects.styles.satin', 'Satin')}</span>}
          aria-label={t('effects.styles.satin', 'Satin')}
        />
      </div>
      ) : null}
      {sat ? (
        <>
          <div className={styles.blendRow}>
            <span className={styles.blendLabel}>{t('effects.styles.color', 'Color')}</span>
            <StyleColor nodeId={nodeId} path={styleColorPath('satin', 'color')}
              label={t('effects.styles.satinColor', 'Satin color')} value={sat.color}
              onChange={(color) => void patchLayerStyleEdit(nodeId, 'satin', { color })} />
          </div>
          <div className={styles.maskControls}>
            <StyleNum nodeId={nodeId} path={stylePath('satin', 'distance')}
              label={t('effects.styles.distance', 'Distance')} value={sat.distance} min={0} max={200} unit="px"
              onChange={(v) => void patchLayerStyleEdit(nodeId, 'satin', { distance: v })} />
            <StyleNum nodeId={nodeId} path={stylePath('satin', 'angle')}
              label={t('effects.styles.angle', 'Angle')} value={sat.angle} unit="°"
              onChange={(v) => void patchLayerStyleEdit(nodeId, 'satin', { angle: v })} />
          </div>
          <div className={styles.maskControls}>
            <StyleNum nodeId={nodeId} path={stylePath('satin', 'size')}
              label={t('effects.styles.size', 'Size')} value={sat.size} min={0} max={200} unit="px"
              onChange={(v) => void patchLayerStyleEdit(nodeId, 'satin', { size: v })} />
            <StyleNum nodeId={nodeId} path={stylePath('satin', 'opacity')}
              label={t('effects.styles.opacity', 'Opacity')} value={Math.round(sat.opacity * 100)} min={0} max={100} unit="%"
              onChange={(v) => void patchLayerStyleEdit(nodeId, 'satin', { opacity: v / 100 })} />
          </div>
          <div className={styles.blendRow}>
            <Checkbox
              checked={sat.invert === true}
              onChange={() => void patchLayerStyleEdit(nodeId, 'satin', { invert: !sat.invert })}
              label={<span className={styles.blendLabel} style={{ marginLeft: 6 }}>{t('effects.styles.invert', 'Invert')}</span>}
              aria-label={t('effects.styles.satinInvert', 'Satin invert')}
            />
          </div>
        </>
      ) : null}

      {/* ── Colour overlay ─────────────────────────────────────── */}
      {co ? (
      <div className={styles.blendRow}>
        <Checkbox
          checked
          onChange={() => { void setLayerStyleOnEdit(nodeId, 'colorOverlay', !co, 'Color Overlay'); }}
          label={<span className={styles.blendLabel} style={{ marginLeft: 6 }}>{t('effects.styles.colorOverlay', 'Color overlay')}</span>}
          aria-label={t('effects.styles.colorOverlay', 'Color overlay')}
        />
      </div>
      ) : null}
      {co ? (
        <div className={styles.maskControls}>
          <label className={styles.maskField}>
            <span>{t('effects.styles.color', 'Color')}</span>
            <StyleColor nodeId={nodeId} path={styleColorPath('colorOverlay', 'color')}
              label={t('effects.styles.overlayColor', 'Overlay color')} value={co.color}
              onChange={(color) => void patchLayerStyleEdit(nodeId, 'colorOverlay', { color })} />
          </label>
          <StyleNum nodeId={nodeId} path={stylePath('colorOverlay', 'opacity')}
            label={t('effects.styles.opacity', 'Opacity')} value={Math.round(co.opacity * 100)} min={0} max={100} unit="%"
            onChange={(v) => void patchLayerStyleEdit(nodeId, 'colorOverlay', { opacity: v / 100 })} />
        </div>
      ) : null}

      {/* ── Gradient overlay ───────────────────────────────────── */}
      {go ? (
      <div className={styles.blendRow}>
        <Checkbox
          checked
          onChange={() => { void setLayerStyleOnEdit(nodeId, 'gradientOverlay', !go, 'Gradient Overlay'); }}
          label={<span className={styles.blendLabel} style={{ marginLeft: 6 }}>{t('effects.styles.gradientOverlay', 'Gradient overlay')}</span>}
          aria-label={t('effects.styles.gradientOverlay', 'Gradient overlay')}
        />
      </div>
      ) : null}
      {go ? (
        <>
          <div className={styles.maskControls}>
            <label className={styles.maskField}>
              <span>{t('effects.styles.from', 'From')}</span>
              <StyleColor nodeId={nodeId} path={styleColorPath('gradientOverlay', 'from')}
                label={t('effects.styles.gradientFrom', 'Gradient from')} value={go.from}
                onChange={(from) => void patchLayerStyleEdit(nodeId, 'gradientOverlay', { from })} />
            </label>
            <label className={styles.maskField}>
              <span>{t('effects.styles.to', 'To')}</span>
              <StyleColor nodeId={nodeId} path={styleColorPath('gradientOverlay', 'to')}
                label={t('effects.styles.gradientTo', 'Gradient to')} value={go.to}
                onChange={(to) => void patchLayerStyleEdit(nodeId, 'gradientOverlay', { to })} />
            </label>
          </div>
          <div className={styles.maskControls}>
            <StyleNum nodeId={nodeId} path={stylePath('gradientOverlay', 'angle')}
              label={t('effects.styles.angle', 'Angle')} value={go.useGlobalLight ? light.angle : go.angle} unit="°"
              unbind={go.useGlobalLight ? 'gradientOverlay' : undefined}
              onChange={(v) => void patchLayerStyleEdit(nodeId, 'gradientOverlay', { angle: v, useGlobalLight: false })} />
            <StyleNum nodeId={nodeId} path={stylePath('gradientOverlay', 'opacity')}
              label={t('effects.styles.opacity', 'Opacity')} value={Math.round(go.opacity * 100)} min={0} max={100} unit="%"
              onChange={(v) => void patchLayerStyleEdit(nodeId, 'gradientOverlay', { opacity: v / 100 })} />
          </div>
          <div className={styles.blendRow}>
            <Checkbox
              checked={go.useGlobalLight === true}
              onChange={() => void patchLayerStyleEdit(nodeId, 'gradientOverlay', { useGlobalLight: !go.useGlobalLight })}
              label={<span className={styles.blendLabel} style={{ marginLeft: 6 }}>{t('effects.styles.useGlobalLight', 'Use global light')}</span>}
              aria-label={t('effects.styles.gradientUseGlobalLight', 'Gradient use global light')}
            />
          </div>
        </>
      ) : null}

      {/* ── Stroke ─────────────────────────────────────────────── */}
      {stk ? (
      <div className={styles.blendRow}>
        <Checkbox
          checked
          onChange={() => { void setLayerStyleOnEdit(nodeId, 'stroke', !stk, 'Stroke'); }}
          label={<span className={styles.blendLabel} style={{ marginLeft: 6 }}>{t('effects.styles.stroke', 'Stroke')}</span>}
          aria-label={t('effects.styles.strokeStyle', 'Stroke style')}
        />
      </div>
      ) : null}
      {stk ? (
        <>
          <div className={styles.maskControls}>
            <label className={styles.maskField}>
              <span>{t('effects.styles.color', 'Color')}</span>
              <StyleColor nodeId={nodeId} path={styleColorPath('stroke', 'color')}
                label={t('effects.styles.strokeStyleColor', 'Stroke style color')} value={stk.color}
                onChange={(color) => void patchLayerStyleEdit(nodeId, 'stroke', { color })} />
            </label>
            <StyleNum nodeId={nodeId} path={stylePath('stroke', 'size')}
              label={t('effects.styles.size', 'Size')} value={stk.size} min={0} max={200} unit="px"
              onChange={(v) => void patchLayerStyleEdit(nodeId, 'stroke', { size: v })} />
            <StyleNum nodeId={nodeId} path={stylePath('stroke', 'opacity')}
              label={t('effects.styles.opacity', 'Opacity')} value={Math.round(stk.opacity * 100)} min={0} max={100} unit="%"
              onChange={(v) => void patchLayerStyleEdit(nodeId, 'stroke', { opacity: v / 100 })} />
          </div>
          <div className={styles.blendRow}>
            <span className={styles.blendLabel}>{t('effects.styles.position', 'Position')}</span>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {strokePositions().map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={styles.blendLabel}
                  aria-pressed={(stk.position ?? 'outside') === p.id}
                  style={{
                    opacity: (stk.position ?? 'outside') === p.id ? 1 : 0.55,
                    textDecoration: (stk.position ?? 'outside') === p.id ? 'underline' : 'none',
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    padding: '0 2px',
                  }}
                  onClick={() => void patchLayerStyleEdit(nodeId, 'stroke', { position: p.id })}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        </>
      ) : null}

      {/* GLASS — last: AE has no Glass style, so it follows AE's nine. It is a
          MATERIAL rather than a decoration: the others sit on top of the layer,
          this replaces what you see through it.
          One style with a real parameter set, not the dozen-effect stack AE
          makes you assemble (see core/effects/layerStyles.ts). */}
      {gl ? (
      <div className={styles.blendRow}>
        <Checkbox
          checked
          onChange={() => { void setLayerStyleOnEdit(nodeId, 'glass', !gl, 'Glass'); }}
          label={<span className={styles.blendLabel} style={{ marginLeft: 6 }}>{t('effects.styles.glass', 'Glass')}</span>}
          aria-label={t('effects.styles.glass', 'Glass')}
        />
      </div>
      ) : null}
      {gl ? (
        <>
          <div className={styles.maskControls}>
            <StyleNum nodeId={nodeId} path={glassPropPath('blur' as GlassParam)}
              label={t('effects.styles.blur', 'Blur')} value={gl.blur} min={0} max={200} unit="px"
              onChange={(v) => void patchLayerStyleEdit(nodeId, 'glass', { blur: v })} />
            <StyleNum nodeId={nodeId} path={glassPropPath('saturation' as GlassParam)}
              label={t('effects.styles.saturation', 'Saturation')} value={gl.saturation} min={0} max={4} step={0.05} precision={2}
              onChange={(v) => void patchLayerStyleEdit(nodeId, 'glass', { saturation: v })} />
          </div>
          <div className={styles.blendRow}>
            <span className={styles.blendLabel}>{t('effects.styles.tint', 'Tint')}</span>
            <StyleColor nodeId={nodeId} path={glassPropPath('tintColor')}
              label={t('effects.styles.glassTint', 'Glass tint')} value={gl.tintColor}
              onChange={(tintColor) => void patchLayerStyleEdit(nodeId, 'glass', { tintColor })} />
            <StyleNum nodeId={nodeId} path={glassPropPath('tintOpacity')} bare
              label={t('effects.styles.glassTintOpacity', 'Glass tint opacity')} value={Math.round(gl.tintOpacity * 100)}
              min={0} max={100} unit="%" trackFactor={0.01}
              onChange={(v) => void patchLayerStyleEdit(nodeId, 'glass', { tintOpacity: v / 100 })} />
          </div>

          <div className={styles.maskControls}>
            <StyleNum nodeId={nodeId} path={glassPropPath('refraction' as GlassParam)}
              label={t('effects.styles.refraction', 'Refraction')} value={gl.refraction} min={-200} max={200} unit="px"
              onChange={(v) => void patchLayerStyleEdit(nodeId, 'glass', { refraction: v })} />
            <StyleNum nodeId={nodeId} path={glassPropPath('edgeWidth' as GlassParam)}
              label={t('effects.styles.edgeWidth', 'Edge width')} value={gl.edgeWidth} min={0} max={64} unit="px"
              onChange={(v) => void patchLayerStyleEdit(nodeId, 'glass', { edgeWidth: v })} />
          </div>
          <div className={styles.maskControls}>
            <StyleNum nodeId={nodeId} path={glassPropPath('chromaticAberration' as GlassParam)}
              label={t('effects.styles.aberration', 'Aberration')} value={gl.chromaticAberration} min={-32} max={32} unit="px"
              onChange={(v) => void patchLayerStyleEdit(nodeId, 'glass', { chromaticAberration: v })} />
            <StyleNum nodeId={nodeId} path={glassPropPath('grain' as GlassParam)}
              label={t('effects.styles.grain', 'Grain')} value={Math.round(gl.grain * 100)} min={0} max={100} unit="%" trackFactor={0.01}
              onChange={(v) => void patchLayerStyleEdit(nodeId, 'glass', { grain: v / 100 })} />
          </div>

          <div className={styles.blendRow}>
            <span className={styles.blendLabel}>{t('effects.styles.rim', 'Rim')}</span>
            <StyleColor nodeId={nodeId} path={glassPropPath('rimColor')}
              label={t('effects.styles.glassRimColour', 'Glass rim colour')} value={gl.rimColor}
              onChange={(rimColor) => void patchLayerStyleEdit(nodeId, 'glass', { rimColor })} />
            <StyleNum nodeId={nodeId} path={glassPropPath('rimOpacity')} bare
              label={t('effects.styles.glassRimOpacity', 'Glass rim opacity')} value={Math.round(gl.rimOpacity * 100)}
              min={0} max={100} unit="%" trackFactor={0.01}
              onChange={(v) => void patchLayerStyleEdit(nodeId, 'glass', { rimOpacity: v / 100 })} />
          </div>
          <div className={styles.blendRow}>
            <Checkbox
              checked={gl.useGlobalLight === true}
              onChange={() => void patchLayerStyleEdit(nodeId, 'glass', { useGlobalLight: gl.useGlobalLight !== true })}
              label={<span className={styles.blendLabel} style={{ marginLeft: 6 }}>{t('effects.styles.useGlobalLight', 'Use global light')}</span>}
              aria-label={t('effects.styles.glassUseGlobalLight', 'Glass use global light')}
            />
          </div>
          <div className={styles.maskControls}>
            <StyleNum nodeId={nodeId} path={glassPropPath('rimWidth' as GlassParam)}
              label={t('effects.styles.rimWidth', 'Rim width')} value={gl.rimWidth} min={0} max={64} unit="px"
              onChange={(v) => void patchLayerStyleEdit(nodeId, 'glass', { rimWidth: v })} />
            <StyleNum nodeId={nodeId} path={glassPropPath('rimAngle' as GlassParam)}
              label={t('effects.styles.rimAngle', 'Rim angle')} value={gl.useGlobalLight ? light.angle : gl.rimAngle} unit="°"
              unbind={gl.useGlobalLight ? 'glass' : undefined}
              onChange={(v) => void patchLayerStyleEdit(nodeId, 'glass', { rimAngle: v, useGlobalLight: false })} />
          </div>

          <div className={styles.maskControls}>
            <StyleNum nodeId={nodeId} path={glassPropPath('specularIntensity' as GlassParam)}
              label={t('effects.styles.specular', 'Specular')} value={Math.round(gl.specularIntensity * 100)} min={0} max={200} unit="%" trackFactor={0.01}
              onChange={(v) => void patchLayerStyleEdit(nodeId, 'glass', { specularIntensity: v / 100 })} />
            <StyleNum nodeId={nodeId} path={glassPropPath('specularFalloff' as GlassParam)}
              label={t('effects.styles.falloff', 'Falloff')} value={gl.specularFalloff} min={0.1} max={64} precision={1}
              onChange={(v) => void patchLayerStyleEdit(nodeId, 'glass', { specularFalloff: v })} />
          </div>
          {!gl.useGlobalLight && (
            <div className={styles.blendRow}>
              <span className={styles.blendLabel}>{t('effects.styles.specularAngle', 'Specular angle')}</span>
              <AngleDial
                value={gl.specularAngle}
                onChange={(specularAngle) => void patchLayerStyleEdit(nodeId, 'glass', { specularAngle })}
                aria-label={t('effects.styles.glassSpecularAngle', 'Glass specular angle')}
              />
              <ValueField value={gl.specularAngle} precision={0} unit="°"
                onChange={(v) => void patchLayerStyleEdit(nodeId, 'glass', { specularAngle: v })} aria-label={t('effects.styles.glassSpecularAngleValue', 'Glass specular angle value')} />
            </div>
          )}

          {/* LIQUID GLASS (stream D, 2026-11-02): a surface under the glass. `edge`
              is the original material; the others give the backdrop a normal to
              bend through (glass-liquid.wgsl) — a dome over the alpha, the layer's
              luminance, or another layer's. */}
          <div className={styles.blendRow}>
            <span className={styles.blendLabel}>{t('effects.styles.glassSurface', 'Surface')}</span>
            {glassSurfaces().map((s) => (
              <button
                key={s.id}
                type="button"
                className={styles.blendLabel}
                aria-pressed={(gl.surface ?? 'edge') === s.id}
                style={{
                  opacity: (gl.surface ?? 'edge') === s.id ? 1 : 0.55,
                  textDecoration: (gl.surface ?? 'edge') === s.id ? 'underline' : 'none',
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  padding: '0 2px',
                }}
                onClick={() => void patchLayerStyleEdit(nodeId, 'glass', { surface: s.id })}
              >
                {s.label}
              </button>
            ))}
          </div>
          {(gl.surface ?? 'edge') === 'layer' && (
            <div className={styles.blendRow}>
              <span className={styles.blendLabel}>{t('effects.styles.glassBumpLayer', 'Bump layer')}</span>
              <select
                value={gl.bumpLayerId ?? ''}
                onChange={(ev) => void patchLayerStyleEdit(nodeId, 'glass', { bumpLayerId: ev.currentTarget.value })}
                aria-label={t('effects.styles.glassBumpLayer', 'Bump layer')}
                className={styles.paramSelect}
              >
                <option value="">{t('effects.styles.glassBumpNone', 'None (this layer’s luminance)')}</option>
                {siblingLayerOptions(nodeId).map((s) => (
                  <option key={s.id} value={s.id}>{s.name || s.id}</option>
                ))}
              </select>
            </div>
          )}
          {(gl.surface ?? 'edge') !== 'edge' && (
            <>
              <div className={styles.maskControls}>
                <StyleNum nodeId={nodeId} path={glassPropPath('thickness' as GlassParam)}
                  label={t('effects.styles.glassThickness', 'Thickness')} value={gl.thickness ?? 24} min={0} max={400} unit="px"
                  onChange={(v) => void patchLayerStyleEdit(nodeId, 'glass', { thickness: v })} />
                <StyleNum nodeId={nodeId} path={glassPropPath('ior' as GlassParam)}
                  label={t('effects.styles.glassIor', 'Index of refraction')} value={gl.ior ?? 1.5} min={1} max={3} step={0.01} precision={2}
                  onChange={(v) => void patchLayerStyleEdit(nodeId, 'glass', { ior: v })} />
              </div>
              <div className={styles.maskControls}>
                <StyleNum nodeId={nodeId} path={glassPropPath('dispersion' as GlassParam)}
                  label={t('effects.styles.glassDispersion', 'Dispersion')} value={Math.round((gl.dispersion ?? 0) * 100)} min={0} max={100} unit="%" trackFactor={0.01}
                  onChange={(v) => void patchLayerStyleEdit(nodeId, 'glass', { dispersion: v / 100 })} />
              </div>
            </>
          )}
          <div className={styles.maskControls}>
            <StyleNum nodeId={nodeId} path={glassPropPath('caustic' as GlassParam)}
              label={t('effects.styles.glassCaustic', 'Caustic')} value={Math.round((gl.caustic ?? 0) * 100)} min={0} max={200} unit="%" trackFactor={0.01}
              onChange={(v) => void patchLayerStyleEdit(nodeId, 'glass', { caustic: v / 100 })} />
            <StyleNum nodeId={nodeId} path={glassPropPath('fresnel' as GlassParam)}
              label={t('effects.styles.glassFresnel', 'Fresnel rim')} value={Math.round((gl.fresnel ?? 0) * 100)} min={0} max={200} unit="%" trackFactor={0.01}
              onChange={(v) => void patchLayerStyleEdit(nodeId, 'glass', { fresnel: v / 100 })} />
          </div>
        </>
      ) : null}
    </>
  );
}

export default LayerStylesControls;
