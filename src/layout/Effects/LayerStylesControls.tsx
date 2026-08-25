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
 */

import { ValueField } from '@components/ValueField';
import { ColorPicker } from '@components/ColorPicker';
import { Checkbox } from '@components/Checkbox';
import { AngleDial } from '@components/AngleDial';
import { StopwatchButton } from '@components/PropertyRow';
import { useCompositionStore } from '@stores/compositionStore';
import { useActiveWorkspace, resolveGlobalLight } from '@stores/projectStore';
import { useSceneRevision } from '@stores/sceneStore';
import { defaultAnimation } from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';
import { compToKeyframeTime } from '@core/timeline/TimelineController';
import { Color } from '@motion/renderer';
import { effectPropPath, resolveChannelColor } from '@core/effects/effects';
import { glassPropPath, type GlassParam } from '@core/effects/glassResolve';
import {
  getNodeLayerStyles,
  toggleDropShadow,
  toggleOuterGlow,
  updateDropShadow,
  updateOuterGlow,
  toggleColorOverlay,
  updateColorOverlay,
  toggleGradientOverlay,
  updateGradientOverlay,
  toggleStrokeStyle,
  updateStrokeStyle,
  toggleInnerShadow,
  updateInnerShadow,
  toggleInnerGlow,
  updateInnerGlow,
  toggleSatin,
  updateSatin,
  toggleBevel,
  updateBevel,
  toggleGlass,
  updateGlass,
  layerStyleEffectId,
  LAYER_STYLE_NUMBER_PARAMS,
  LAYER_STYLE_COLOR_PARAMS,
  type LayerStyles,
  type StrokeStylePosition,
} from '@core/effects/layerStyles';
import styles from './EffectsPanel.module.css';

const STROKE_POSITIONS: { id: StrokeStylePosition; label: string }[] = [
  { id: 'outside', label: 'Outside' },
  { id: 'inside', label: 'Inside' },
  { id: 'center', label: 'Center' },
];

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
  nodeId, path, label, value, onChange, trackFactor = 1, onAnimate, bare = false,
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
   * Run once, just before the first keyframe is written.
   *
   * For the angle fields bound to the composition's global light: that binding
   * overrides the style's own angle at render time, so keyframing the angle
   * while still bound would produce a track the renderer ignores. Editing the
   * value already unbinds; animating it has to as well.
   */
  onAnimate?: () => void;
  /** Render stopwatch + field only, with no label wrapper — for the horizontal
   *  rows (Tint, Rim) where the label already sits beside the colour swatch. */
  bare?: boolean;
  min?: number; max?: number; step?: number; precision?: number; unit?: string;
}): JSX.Element {
  const time = useActiveWorkspace()?.time ?? 0;
  useSceneRevision((s) => s.rev);
  const animated = !!path && defaultAnimation.isAnimated(nodeId, path);
  // The canonical keyframe axis — the same one buildSnapshot samples.
  const layerT = compToKeyframeTime(nodeId, time);
  const display = animated
    ? (defaultAnimation.sample(nodeId, path!, layerT) ?? value * trackFactor) / trackFactor
    : value;

  const set = (v: number): void => {
    if (animated) {
      runAnimEdit(
        `Set ${label}`,
        () => defaultAnimation.setKeyframe(nodeId, path!, layerT, v * trackFactor),
        `ls:${nodeId}:${path}:${layerT}`,
      );
    } else {
      onChange(v);
    }
  };
  const toggle = (): void => {
    if (!path) return;
    if (animated) {
      runAnimEdit(`Remove ${label} animation`, () => defaultAnimation.removeTrack(nodeId, path));
    } else {
      runAnimEdit(`Animate ${label}`, () => {
        onAnimate?.();
        defaultAnimation.setKeyframe(nodeId, path, layerT, value * trackFactor);
      });
    }
  };

  const field = (
    <ValueField
      value={display}
      min={min} max={max} step={step} precision={precision} unit={unit}
      onChange={set}
      aria-label={label}
    />
  );
  const watch = path ? <StopwatchButton animated={animated} label={label} onToggle={toggle} /> : null;

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
  useSceneRevision((s) => s.rev);
  const animated = !!path && defaultAnimation.isAnimated(nodeId, `${path}_r`);
  const layerT = compToKeyframeTime(nodeId, time);

  // Same rule the RENDERER uses — see `resolveChannelColor`. An unanimated
  // channel falls back to the STORED colour's channel; defaulting it to 255 made
  // the swatch show a colour the render never used.
  const displayed = animated
    ? resolveChannelColor(value, (s) => defaultAnimation.sample(nodeId, `${path}${s}`, layerT))
    : value;

  const writeChannels = (hex: string, editLabel: string): void => {
    const c = Color.fromHex(hex);
    runAnimEdit(editLabel, () => {
      defaultAnimation.setKeyframe(nodeId, `${path}_r`, layerT, c.r);
      defaultAnimation.setKeyframe(nodeId, `${path}_g`, layerT, c.g);
      defaultAnimation.setKeyframe(nodeId, `${path}_b`, layerT, c.b);
      defaultAnimation.setKeyframe(nodeId, `${path}_a`, layerT, c.a ?? 1);
    }, `lscolor:${nodeId}:${path}`);
  };
  const toggle = (): void => {
    if (!path) return;
    if (animated) {
      runAnimEdit(`Remove ${label} animation`, () => {
        for (const ch of ['_r', '_g', '_b', '_a']) defaultAnimation.removeTrack(nodeId, `${path}${ch}`);
      });
    } else {
      writeChannels(value, `Animate ${label}`);
    }
  };

  return (
    <>
      {path ? <StopwatchButton animated={animated} label={label} onToggle={toggle} /> : null}
      <ColorPicker
        value={displayed}
        onChange={(hex) => { if (animated) writeChannels(hex, `Set ${label}`); else onChange(hex); }}
        aria-label={label}
      />
    </>
  );
}

export function LayerStylesControls({ nodeId }: { nodeId: string }): JSX.Element {
  const ls = getNodeLayerStyles(nodeId);
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
  const comp = useCompositionStore((s) => ({ a: s.globalLightAngle, alt: s.globalLightAltitude }));
  const update = useCompositionStore((s) => s.update);
  const light = resolveGlobalLight({ globalLightAngle: comp.a, globalLightAltitude: comp.alt });
  const boundToLight = ds?.useGlobalLight !== false;

  return (
    <>

      {/* GLOBAL LIGHT — one direction for every style in the composition that
          opts in. This is what a layer style has and the equivalent effect does
          not: re-light the whole scene from one control. */}
      <div className={styles.blendRow}>
        <span className={styles.blendLabel}>Global light</span>
        <AngleDial
          value={light.angle}
          onChange={(angle) => update({ globalLightAngle: angle })}
          aria-label="Global light angle"
        />
        <ValueField
          value={light.angle}
          precision={0}
          unit="°"
          onChange={(angle) => update({ globalLightAngle: angle })}
          aria-label="Global light angle value"
        />
        <span className={styles.blendLabel} style={{ marginLeft: 8 }}>Altitude</span>
        <ValueField
          value={light.altitude}
          min={0}
          max={90}
          precision={0}
          unit="°"
          onChange={(altitude) => update({ globalLightAltitude: altitude })}
          aria-label="Global light altitude"
        />
      </div>

      {/* GLASS — first, because it is a MATERIAL rather than a decoration: the
          others sit on top of the layer, this replaces what you see through it.
          One style with a real parameter set, not the dozen-effect stack AE
          makes you assemble (see core/effects/layerStyles.ts). */}
      <div className={styles.blendRow}>
        <Checkbox
          checked={!!gl}
          onChange={() => toggleGlass(nodeId)}
          label={<span className={styles.blendLabel} style={{ marginLeft: 6 }}>Glass</span>}
          aria-label="Glass"
        />
      </div>
      {gl ? (
        <>
          <div className={styles.maskControls}>
            <StyleNum nodeId={nodeId} path={glassPropPath('blur' as GlassParam)}
              label="Blur" value={gl.blur} min={0} max={200} unit="px"
              onChange={(v) => updateGlass(nodeId, { blur: v })} />
            <StyleNum nodeId={nodeId} path={glassPropPath('saturation' as GlassParam)}
              label="Saturation" value={gl.saturation} min={0} max={4} step={0.05} precision={2}
              onChange={(v) => updateGlass(nodeId, { saturation: v })} />
          </div>
          <div className={styles.blendRow}>
            <span className={styles.blendLabel}>Tint</span>
            <StyleColor nodeId={nodeId} path={glassPropPath('tintColor')}
              label="Glass tint" value={gl.tintColor}
              onChange={(tintColor) => updateGlass(nodeId, { tintColor })} />
            <StyleNum nodeId={nodeId} path={glassPropPath('tintOpacity')} bare
              label="Glass tint opacity" value={Math.round(gl.tintOpacity * 100)}
              min={0} max={100} unit="%" trackFactor={0.01}
              onChange={(v) => updateGlass(nodeId, { tintOpacity: v / 100 })} />
          </div>

          <div className={styles.maskControls}>
            <StyleNum nodeId={nodeId} path={glassPropPath('refraction' as GlassParam)}
              label="Refraction" value={gl.refraction} min={-200} max={200} unit="px"
              onChange={(v) => updateGlass(nodeId, { refraction: v })} />
            <StyleNum nodeId={nodeId} path={glassPropPath('edgeWidth' as GlassParam)}
              label="Edge width" value={gl.edgeWidth} min={0} max={64} unit="px"
              onChange={(v) => updateGlass(nodeId, { edgeWidth: v })} />
          </div>
          <div className={styles.maskControls}>
            <StyleNum nodeId={nodeId} path={glassPropPath('chromaticAberration' as GlassParam)}
              label="Aberration" value={gl.chromaticAberration} min={-32} max={32} unit="px"
              onChange={(v) => updateGlass(nodeId, { chromaticAberration: v })} />
            <StyleNum nodeId={nodeId} path={glassPropPath('grain' as GlassParam)}
              label="Grain" value={Math.round(gl.grain * 100)} min={0} max={100} unit="%" trackFactor={0.01}
              onChange={(v) => updateGlass(nodeId, { grain: v / 100 })} />
          </div>

          <div className={styles.blendRow}>
            <span className={styles.blendLabel}>Rim</span>
            <StyleColor nodeId={nodeId} path={glassPropPath('rimColor')}
              label="Glass rim colour" value={gl.rimColor}
              onChange={(rimColor) => updateGlass(nodeId, { rimColor })} />
            <StyleNum nodeId={nodeId} path={glassPropPath('rimOpacity')} bare
              label="Glass rim opacity" value={Math.round(gl.rimOpacity * 100)}
              min={0} max={100} unit="%" trackFactor={0.01}
              onChange={(v) => updateGlass(nodeId, { rimOpacity: v / 100 })} />
          </div>
          <div className={styles.blendRow}>
            <Checkbox
              checked={gl.useGlobalLight === true}
              onChange={() => updateGlass(nodeId, { useGlobalLight: gl.useGlobalLight !== true })}
              label={<span className={styles.blendLabel} style={{ marginLeft: 6 }}>Use global light</span>}
              aria-label="Glass use global light"
            />
          </div>
          <div className={styles.maskControls}>
            <StyleNum nodeId={nodeId} path={glassPropPath('rimWidth' as GlassParam)}
              label="Rim width" value={gl.rimWidth} min={0} max={64} unit="px"
              onChange={(v) => updateGlass(nodeId, { rimWidth: v })} />
            <StyleNum nodeId={nodeId} path={glassPropPath('rimAngle' as GlassParam)}
              label="Rim angle" value={gl.useGlobalLight ? light.angle : gl.rimAngle} unit="°"
              onAnimate={() => updateGlass(nodeId, { useGlobalLight: false })}
              onChange={(v) => updateGlass(nodeId, { rimAngle: v, useGlobalLight: false })} />
          </div>

          <div className={styles.maskControls}>
            <StyleNum nodeId={nodeId} path={glassPropPath('specularIntensity' as GlassParam)}
              label="Specular" value={Math.round(gl.specularIntensity * 100)} min={0} max={200} unit="%" trackFactor={0.01}
              onChange={(v) => updateGlass(nodeId, { specularIntensity: v / 100 })} />
            <StyleNum nodeId={nodeId} path={glassPropPath('specularFalloff' as GlassParam)}
              label="Falloff" value={gl.specularFalloff} min={0.1} max={64} precision={1}
              onChange={(v) => updateGlass(nodeId, { specularFalloff: v })} />
          </div>
          {!gl.useGlobalLight && (
            <div className={styles.blendRow}>
              <span className={styles.blendLabel}>Specular angle</span>
              <AngleDial
                value={gl.specularAngle}
                onChange={(specularAngle) => updateGlass(nodeId, { specularAngle })}
                aria-label="Glass specular angle"
              />
              <ValueField value={gl.specularAngle} precision={0} unit="°"
                onChange={(v) => updateGlass(nodeId, { specularAngle: v })} aria-label="Glass specular angle value" />
            </div>
          )}
        </>
      ) : null}

      <div className={styles.blendRow}>
        <Checkbox
          checked={!!ds}
          onChange={() => toggleDropShadow(nodeId)}
          label={<span className={styles.blendLabel} style={{ marginLeft: 6 }}>Drop shadow</span>}
          aria-label="Drop shadow"
        />
      </div>
      {ds ? (
        <>
          <div className={styles.blendRow}>
            <span className={styles.blendLabel}>Color</span>
            <StyleColor nodeId={nodeId} path={styleColorPath('dropShadow', 'color')}
              label="Shadow color" value={ds.color}
              onChange={(color) => updateDropShadow(nodeId, { color })} />
          </div>
          <div className={styles.blendRow}>
            <Checkbox
              checked={boundToLight}
              onChange={() => updateDropShadow(nodeId, { useGlobalLight: !boundToLight })}
              label={<span className={styles.blendLabel} style={{ marginLeft: 6 }}>Use global light</span>}
              aria-label="Use global light"
            />
          </div>
          <div className={styles.maskControls}>
            <StyleNum nodeId={nodeId} path={stylePath('dropShadow', 'distance')}
              label="Distance" value={ds.distance} min={0} max={200} unit="px"
              onChange={(v) => updateDropShadow(nodeId, { distance: v })} />
            <StyleNum nodeId={nodeId} path={stylePath('dropShadow', 'angle')}
              label="Angle" value={boundToLight ? light.angle : ds.angle} unit="°"
              onAnimate={() => updateDropShadow(nodeId, { useGlobalLight: false })}
              onChange={(v) => updateDropShadow(nodeId, { angle: v, useGlobalLight: false })} />
          </div>
          <div className={styles.maskControls}>
            <StyleNum nodeId={nodeId} path={stylePath('dropShadow', 'blur')}
              label="Blur" value={ds.blur} min={0} max={200} unit="px"
              onChange={(v) => updateDropShadow(nodeId, { blur: v })} />
            <StyleNum nodeId={nodeId} path={stylePath('dropShadow', 'spread')}
              label="Spread" value={ds.spread ?? 0} min={0} max={100} unit="%"
              onChange={(v) => updateDropShadow(nodeId, { spread: v })} />
          </div>
          <div className={styles.maskControls}>
            <StyleNum nodeId={nodeId} path={stylePath('dropShadow', 'opacity')}
              label="Opacity" value={Math.round(ds.opacity * 100)} min={0} max={100} unit="%"
              onChange={(v) => updateDropShadow(nodeId, { opacity: v / 100 })} />
          </div>
        </>
      ) : null}

      <div className={styles.blendRow}>
        <Checkbox 
          checked={!!og} 
          onChange={() => toggleOuterGlow(nodeId)} 
          label={<span className={styles.blendLabel} style={{ marginLeft: 6 }}>Outer glow</span>} 
          aria-label="Outer glow" 
        />
      </div>
      {og ? (
        <>
          <div className={styles.blendRow}>
            <span className={styles.blendLabel}>Color</span>
            <StyleColor nodeId={nodeId} path={styleColorPath('outerGlow', 'color')}
              label="Glow color" value={og.color}
              onChange={(color) => updateOuterGlow(nodeId, { color })} />
          </div>
          <div className={styles.maskControls}>
            <StyleNum nodeId={nodeId} path={stylePath('outerGlow', 'size')}
              label="Size" value={og.size} min={0} max={200} unit="px"
              onChange={(v) => updateOuterGlow(nodeId, { size: v })} />
            <StyleNum nodeId={nodeId} path={stylePath('outerGlow', 'spread')}
              label="Spread" value={og.spread ?? 0} min={0} max={100} unit="%"
              onChange={(v) => updateOuterGlow(nodeId, { spread: v })} />
          </div>
          <div className={styles.maskControls}>
            <StyleNum nodeId={nodeId} path={stylePath('outerGlow', 'opacity')}
              label="Opacity" value={Math.round(og.opacity * 100)} min={0} max={100} unit="%"
              onChange={(v) => updateOuterGlow(nodeId, { opacity: v / 100 })} />
          </div>
        </>
      ) : null}

      {/* ── Inner shadow ───────────────────────────────────────── */}
      <div className={styles.blendRow}>
        <Checkbox
          checked={!!ish}
          onChange={() => toggleInnerShadow(nodeId)}
          label={<span className={styles.blendLabel} style={{ marginLeft: 6 }}>Inner shadow</span>}
          aria-label="Inner shadow"
        />
      </div>
      {ish ? (
        <>
          <div className={styles.blendRow}>
            <span className={styles.blendLabel}>Color</span>
            <StyleColor nodeId={nodeId} path={styleColorPath('innerShadow', 'color')}
              label="Inner shadow color" value={ish.color}
              onChange={(color) => updateInnerShadow(nodeId, { color })} />
          </div>
          <div className={styles.maskControls}>
            <StyleNum nodeId={nodeId} path={stylePath('innerShadow', 'distance')}
              label="Distance" value={ish.distance} min={0} max={200} unit="px"
              onChange={(v) => updateInnerShadow(nodeId, { distance: v })} />
            <StyleNum nodeId={nodeId} path={stylePath('innerShadow', 'angle')}
              label="Angle" value={ish.useGlobalLight ? light.angle : ish.angle} unit="°"
              onAnimate={() => updateInnerShadow(nodeId, { useGlobalLight: false })}
              onChange={(v) => updateInnerShadow(nodeId, { angle: v, useGlobalLight: false })} />
          </div>
          <div className={styles.maskControls}>
            <StyleNum nodeId={nodeId} path={stylePath('innerShadow', 'size')}
              label="Size" value={ish.size} min={0} max={200} unit="px"
              onChange={(v) => updateInnerShadow(nodeId, { size: v })} />
            <StyleNum nodeId={nodeId} path={stylePath('innerShadow', 'opacity')}
              label="Opacity" value={Math.round(ish.opacity * 100)} min={0} max={100} unit="%"
              onChange={(v) => updateInnerShadow(nodeId, { opacity: v / 100 })} />
          </div>
          <div className={styles.blendRow}>
            <Checkbox
              checked={ish.useGlobalLight !== false}
              onChange={() => updateInnerShadow(nodeId, { useGlobalLight: ish.useGlobalLight === false })}
              label={<span className={styles.blendLabel} style={{ marginLeft: 6 }}>Use global light</span>}
              aria-label="Inner shadow use global light"
            />
          </div>
        </>
      ) : null}

      {/* ── Inner glow ─────────────────────────────────────────── */}
      <div className={styles.blendRow}>
        <Checkbox
          checked={!!igl}
          onChange={() => toggleInnerGlow(nodeId)}
          label={<span className={styles.blendLabel} style={{ marginLeft: 6 }}>Inner glow</span>}
          aria-label="Inner glow"
        />
      </div>
      {igl ? (
        <div className={styles.maskControls}>
          <label className={styles.maskField}>
            <span>Color</span>
            <StyleColor nodeId={nodeId} path={styleColorPath('innerGlow', 'color')}
              label="Inner glow color" value={igl.color}
              onChange={(color) => updateInnerGlow(nodeId, { color })} />
          </label>
          <StyleNum nodeId={nodeId} path={stylePath('innerGlow', 'size')}
            label="Size" value={igl.size} min={0} max={200} unit="px"
            onChange={(v) => updateInnerGlow(nodeId, { size: v })} />
          <StyleNum nodeId={nodeId} path={stylePath('innerGlow', 'opacity')}
            label="Opacity" value={Math.round(igl.opacity * 100)} min={0} max={100} unit="%"
            onChange={(v) => updateInnerGlow(nodeId, { opacity: v / 100 })} />
        </div>
      ) : null}

      {/* ── Satin ──────────────────────────────────────────────── */}
      <div className={styles.blendRow}>
        <Checkbox
          checked={!!sat}
          onChange={() => toggleSatin(nodeId)}
          label={<span className={styles.blendLabel} style={{ marginLeft: 6 }}>Satin</span>}
          aria-label="Satin"
        />
      </div>
      {sat ? (
        <>
          <div className={styles.blendRow}>
            <span className={styles.blendLabel}>Color</span>
            <StyleColor nodeId={nodeId} path={styleColorPath('satin', 'color')}
              label="Satin color" value={sat.color}
              onChange={(color) => updateSatin(nodeId, { color })} />
          </div>
          <div className={styles.maskControls}>
            <StyleNum nodeId={nodeId} path={stylePath('satin', 'distance')}
              label="Distance" value={sat.distance} min={0} max={200} unit="px"
              onChange={(v) => updateSatin(nodeId, { distance: v })} />
            <StyleNum nodeId={nodeId} path={stylePath('satin', 'angle')}
              label="Angle" value={sat.angle} unit="°"
              onChange={(v) => updateSatin(nodeId, { angle: v })} />
          </div>
          <div className={styles.maskControls}>
            <StyleNum nodeId={nodeId} path={stylePath('satin', 'size')}
              label="Size" value={sat.size} min={0} max={200} unit="px"
              onChange={(v) => updateSatin(nodeId, { size: v })} />
            <StyleNum nodeId={nodeId} path={stylePath('satin', 'opacity')}
              label="Opacity" value={Math.round(sat.opacity * 100)} min={0} max={100} unit="%"
              onChange={(v) => updateSatin(nodeId, { opacity: v / 100 })} />
          </div>
          <div className={styles.blendRow}>
            <Checkbox
              checked={sat.invert === true}
              onChange={() => updateSatin(nodeId, { invert: !sat.invert })}
              label={<span className={styles.blendLabel} style={{ marginLeft: 6 }}>Invert</span>}
              aria-label="Satin invert"
            />
          </div>
        </>
      ) : null}

      {/* ── Bevel & emboss ─────────────────────────────────────── */}
      <div className={styles.blendRow}>
        <Checkbox
          checked={!!bev}
          onChange={() => toggleBevel(nodeId)}
          label={<span className={styles.blendLabel} style={{ marginLeft: 6 }}>Bevel &amp; emboss</span>}
          aria-label="Bevel and emboss"
        />
      </div>
      {bev ? (
        <>
          <div className={styles.maskControls}>
            <StyleNum nodeId={nodeId} path={stylePath('bevel', 'size')}
              label="Size" value={bev.size} min={1} max={100} unit="px"
              onChange={(v) => updateBevel(nodeId, { size: v })} />
            <StyleNum nodeId={nodeId} path={stylePath('bevel', 'depth')}
              label="Depth" value={bev.depth} min={0} max={500} unit="%"
              onChange={(v) => updateBevel(nodeId, { depth: v })} />
          </div>
          <div className={styles.maskControls}>
            <StyleNum nodeId={nodeId} path={stylePath('bevel', 'angle')}
              label="Angle" value={bev.useGlobalLight ? light.angle : bev.angle} unit="°"
              onAnimate={() => updateBevel(nodeId, { useGlobalLight: false })}
              onChange={(v) => updateBevel(nodeId, { angle: v, useGlobalLight: false })} />
            <StyleNum nodeId={nodeId} path={stylePath('bevel', 'altitude')}
              label="Altitude" value={bev.useGlobalLight ? light.altitude : bev.altitude} min={0} max={90} unit="°"
              onAnimate={() => updateBevel(nodeId, { useGlobalLight: false })}
              onChange={(v) => updateBevel(nodeId, { altitude: v, useGlobalLight: false })} />
          </div>
          <div className={styles.blendRow}>
            <span className={styles.blendLabel}>Highlight</span>
            <StyleColor nodeId={nodeId} path={styleColorPath('bevel', 'highlightColor')}
              label="Bevel highlight color" value={bev.highlightColor}
              onChange={(highlightColor) => updateBevel(nodeId, { highlightColor })} />
            <StyleNum nodeId={nodeId} path={stylePath('bevel', 'highlightOpacity')} bare
              label="Bevel highlight opacity" value={Math.round(bev.highlightOpacity * 100)}
              min={0} max={100} unit="%"
              onChange={(v) => updateBevel(nodeId, { highlightOpacity: v / 100 })} />
          </div>
          <div className={styles.blendRow}>
            <span className={styles.blendLabel}>Shadow</span>
            <StyleColor nodeId={nodeId} path={styleColorPath('bevel', 'shadowColor')}
              label="Bevel shadow color" value={bev.shadowColor}
              onChange={(shadowColor) => updateBevel(nodeId, { shadowColor })} />
            <StyleNum nodeId={nodeId} path={stylePath('bevel', 'shadowOpacity')} bare
              label="Bevel shadow opacity" value={Math.round(bev.shadowOpacity * 100)}
              min={0} max={100} unit="%"
              onChange={(v) => updateBevel(nodeId, { shadowOpacity: v / 100 })} />
          </div>
          <div className={styles.blendRow}>
            <Checkbox
              checked={bev.direction === 'down'}
              onChange={() => updateBevel(nodeId, { direction: bev.direction === 'down' ? 'up' : 'down' })}
              label={<span className={styles.blendLabel} style={{ marginLeft: 6 }}>Carve (down)</span>}
              aria-label="Bevel direction down"
            />
          </div>
          <div className={styles.blendRow}>
            <Checkbox
              checked={bev.useGlobalLight !== false}
              onChange={() => updateBevel(nodeId, { useGlobalLight: bev.useGlobalLight === false })}
              label={<span className={styles.blendLabel} style={{ marginLeft: 6 }}>Use global light</span>}
              aria-label="Bevel use global light"
            />
          </div>
        </>
      ) : null}

      {/* ── Colour overlay ─────────────────────────────────────── */}
      <div className={styles.blendRow}>
        <Checkbox
          checked={!!co}
          onChange={() => toggleColorOverlay(nodeId)}
          label={<span className={styles.blendLabel} style={{ marginLeft: 6 }}>Color overlay</span>}
          aria-label="Color overlay"
        />
      </div>
      {co ? (
        <div className={styles.maskControls}>
          <label className={styles.maskField}>
            <span>Color</span>
            <StyleColor nodeId={nodeId} path={styleColorPath('colorOverlay', 'color')}
              label="Overlay color" value={co.color}
              onChange={(color) => updateColorOverlay(nodeId, { color })} />
          </label>
          <StyleNum nodeId={nodeId} path={stylePath('colorOverlay', 'opacity')}
            label="Opacity" value={Math.round(co.opacity * 100)} min={0} max={100} unit="%"
            onChange={(v) => updateColorOverlay(nodeId, { opacity: v / 100 })} />
        </div>
      ) : null}

      {/* ── Gradient overlay ───────────────────────────────────── */}
      <div className={styles.blendRow}>
        <Checkbox
          checked={!!go}
          onChange={() => toggleGradientOverlay(nodeId)}
          label={<span className={styles.blendLabel} style={{ marginLeft: 6 }}>Gradient overlay</span>}
          aria-label="Gradient overlay"
        />
      </div>
      {go ? (
        <>
          <div className={styles.maskControls}>
            <label className={styles.maskField}>
              <span>From</span>
              <StyleColor nodeId={nodeId} path={styleColorPath('gradientOverlay', 'from')}
                label="Gradient from" value={go.from}
                onChange={(from) => updateGradientOverlay(nodeId, { from })} />
            </label>
            <label className={styles.maskField}>
              <span>To</span>
              <StyleColor nodeId={nodeId} path={styleColorPath('gradientOverlay', 'to')}
                label="Gradient to" value={go.to}
                onChange={(to) => updateGradientOverlay(nodeId, { to })} />
            </label>
          </div>
          <div className={styles.maskControls}>
            <StyleNum nodeId={nodeId} path={stylePath('gradientOverlay', 'angle')}
              label="Angle" value={go.useGlobalLight ? light.angle : go.angle} unit="°"
              onAnimate={() => updateGradientOverlay(nodeId, { useGlobalLight: false })}
              onChange={(v) => updateGradientOverlay(nodeId, { angle: v, useGlobalLight: false })} />
            <StyleNum nodeId={nodeId} path={stylePath('gradientOverlay', 'opacity')}
              label="Opacity" value={Math.round(go.opacity * 100)} min={0} max={100} unit="%"
              onChange={(v) => updateGradientOverlay(nodeId, { opacity: v / 100 })} />
          </div>
          <div className={styles.blendRow}>
            <Checkbox
              checked={go.useGlobalLight === true}
              onChange={() => updateGradientOverlay(nodeId, { useGlobalLight: !go.useGlobalLight })}
              label={<span className={styles.blendLabel} style={{ marginLeft: 6 }}>Use global light</span>}
              aria-label="Gradient use global light"
            />
          </div>
        </>
      ) : null}

      {/* ── Stroke ─────────────────────────────────────────────── */}
      <div className={styles.blendRow}>
        <Checkbox
          checked={!!stk}
          onChange={() => toggleStrokeStyle(nodeId)}
          label={<span className={styles.blendLabel} style={{ marginLeft: 6 }}>Stroke</span>}
          aria-label="Stroke style"
        />
      </div>
      {stk ? (
        <>
          <div className={styles.maskControls}>
            <label className={styles.maskField}>
              <span>Color</span>
              <StyleColor nodeId={nodeId} path={styleColorPath('stroke', 'color')}
                label="Stroke style color" value={stk.color}
                onChange={(color) => updateStrokeStyle(nodeId, { color })} />
            </label>
            <StyleNum nodeId={nodeId} path={stylePath('stroke', 'size')}
              label="Size" value={stk.size} min={0} max={200} unit="px"
              onChange={(v) => updateStrokeStyle(nodeId, { size: v })} />
            <StyleNum nodeId={nodeId} path={stylePath('stroke', 'opacity')}
              label="Opacity" value={Math.round(stk.opacity * 100)} min={0} max={100} unit="%"
              onChange={(v) => updateStrokeStyle(nodeId, { opacity: v / 100 })} />
          </div>
          <div className={styles.blendRow}>
            <span className={styles.blendLabel}>Position</span>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {STROKE_POSITIONS.map((p) => (
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
                  onClick={() => updateStrokeStyle(nodeId, { position: p.id })}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        </>
      ) : null}
    </>
  );
}

export default LayerStylesControls;
