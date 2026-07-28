/**
 * LayerStylesControls (Prompt E8) — Photoshop-style layer styles for a layer:
 * Drop Shadow + Outer Glow. Both compile to the CSS-filter render path, so
 * edits repaint live and are captured by History / autosave / export.
 */

import { ValueField } from '@components/ValueField';
import { ColorPicker } from '@components/ColorPicker';
import { Checkbox } from '@components/Checkbox';
import { AngleDial } from '@components/AngleDial';
import { useCompositionStore } from '@stores/compositionStore';
import { resolveGlobalLight } from '@stores/projectStore';
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
} from '@core/effects/layerStyles';
import styles from './EffectsPanel.module.css';

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
      <div className={styles.sectionTitle}>Layer styles</div>

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
            <label className={styles.maskField}>
              <span>Blur</span>
              <ValueField value={gl.blur} min={0} max={200} precision={0} unit="px"
                onChange={(v) => updateGlass(nodeId, { blur: v })} aria-label="Glass blur" />
            </label>
            <label className={styles.maskField}>
              {/* The "vibrancy" boost. Without it frosted glass reads as a grey
                  smear rather than as glass. */}
              <span>Saturation</span>
              <ValueField value={gl.saturation} min={0} max={4} precision={2} step={0.05}
                onChange={(v) => updateGlass(nodeId, { saturation: v })} aria-label="Glass saturation" />
            </label>
          </div>
          <div className={styles.blendRow}>
            <span className={styles.blendLabel}>Tint</span>
            <ColorPicker value={gl.tintColor} onChange={(tintColor) => updateGlass(nodeId, { tintColor })} aria-label="Glass tint" />
            <ValueField value={Math.round(gl.tintOpacity * 100)} min={0} max={100} precision={0} unit="%"
              onChange={(v) => updateGlass(nodeId, { tintOpacity: v / 100 })} aria-label="Glass tint opacity" />
          </div>

          <div className={styles.maskControls}>
            <label className={styles.maskField}>
              <span>Refraction</span>
              <ValueField value={gl.refraction} min={-200} max={200} precision={0} unit="px"
                onChange={(v) => updateGlass(nodeId, { refraction: v })} aria-label="Glass refraction" />
            </label>
            <label className={styles.maskField}>
              <span>Edge width</span>
              <ValueField value={gl.edgeWidth} min={0} max={64} precision={0} unit="px"
                onChange={(v) => updateGlass(nodeId, { edgeWidth: v })} aria-label="Glass edge width" />
            </label>
          </div>
          <div className={styles.maskControls}>
            <label className={styles.maskField}>
              {/* Two pixels of this is the whole difference between "blurred
                  rectangle" and "glass" — real glass splits light. */}
              <span>Aberration</span>
              <ValueField value={gl.chromaticAberration} min={-32} max={32} precision={0} unit="px"
                onChange={(v) => updateGlass(nodeId, { chromaticAberration: v })} aria-label="Glass chromatic aberration" />
            </label>
            <label className={styles.maskField}>
              {/* A blurred gradient bands on any real display. */}
              <span>Grain</span>
              <ValueField value={Math.round(gl.grain * 100)} min={0} max={100} precision={0} unit="%"
                onChange={(v) => updateGlass(nodeId, { grain: v / 100 })} aria-label="Glass grain" />
            </label>
          </div>

          <div className={styles.blendRow}>
            <span className={styles.blendLabel}>Rim</span>
            <ColorPicker value={gl.rimColor} onChange={(rimColor) => updateGlass(nodeId, { rimColor })} aria-label="Glass rim colour" />
            <ValueField value={Math.round(gl.rimOpacity * 100)} min={0} max={100} precision={0} unit="%"
              onChange={(v) => updateGlass(nodeId, { rimOpacity: v / 100 })} aria-label="Glass rim opacity" />
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
            <label className={styles.maskField}>
              <span>Rim width</span>
              <ValueField value={gl.rimWidth} min={0} max={64} precision={0} unit="px"
                onChange={(v) => updateGlass(nodeId, { rimWidth: v })} aria-label="Glass rim width" />
            </label>
            <label className={styles.maskField}>
              <span>Rim angle</span>
              {/* Shows the LIGHT's angle while bound, so the field cannot
                  disagree with what is on screen. Editing unbinds. */}
              <ValueField
                value={gl.useGlobalLight ? light.angle : gl.rimAngle}
                precision={0}
                unit="°"
                onChange={(v) => updateGlass(nodeId, { rimAngle: v, useGlobalLight: false })}
                aria-label="Glass rim angle"
              />
            </label>
          </div>

          <div className={styles.maskControls}>
            <label className={styles.maskField}>
              <span>Specular</span>
              <ValueField value={Math.round(gl.specularIntensity * 100)} min={0} max={200} precision={0} unit="%"
                onChange={(v) => updateGlass(nodeId, { specularIntensity: v / 100 })} aria-label="Glass specular intensity" />
            </label>
            <label className={styles.maskField}>
              <span>Falloff</span>
              <ValueField value={gl.specularFalloff} min={0.1} max={64} precision={1}
                onChange={(v) => updateGlass(nodeId, { specularFalloff: v })} aria-label="Glass specular falloff" />
            </label>
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
            <ColorPicker value={ds.color} onChange={(color) => updateDropShadow(nodeId, { color })} aria-label="Shadow color" />
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
            <label className={styles.maskField}>
              <span>Distance</span>
              <ValueField value={ds.distance} min={0} max={200} precision={0} unit="px"
                onChange={(v) => updateDropShadow(nodeId, { distance: v })} aria-label="Shadow distance" />
            </label>
            <label className={styles.maskField}>
              <span>Angle</span>
              {/* Shows the LIGHT's angle while bound, so the field never
                  disagrees with the shadow on screen. Editing it unbinds — you
                  cannot meaningfully set a per-style angle and stay bound. */}
              <ValueField
                value={boundToLight ? light.angle : ds.angle}
                precision={0}
                unit="°"
                onChange={(v) => updateDropShadow(nodeId, { angle: v, useGlobalLight: false })}
                aria-label="Shadow angle"
              />
            </label>
          </div>
          <div className={styles.maskControls}>
            <label className={styles.maskField}>
              <span>Blur</span>
              <ValueField value={ds.blur} min={0} max={200} precision={0} unit="px"
                onChange={(v) => updateDropShadow(nodeId, { blur: v })} aria-label="Shadow blur" />
            </label>
            <label className={styles.maskField}>
              <span>Opacity</span>
              <ValueField value={Math.round(ds.opacity * 100)} min={0} max={100} precision={0} unit="%"
                onChange={(v) => updateDropShadow(nodeId, { opacity: v / 100 })} aria-label="Shadow opacity" />
            </label>
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
            <ColorPicker value={og.color} onChange={(color) => updateOuterGlow(nodeId, { color })} aria-label="Glow color" />
          </div>
          <div className={styles.maskControls}>
            <label className={styles.maskField}>
              <span>Size</span>
              <ValueField value={og.size} min={0} max={200} precision={0} unit="px"
                onChange={(v) => updateOuterGlow(nodeId, { size: v })} aria-label="Glow size" />
            </label>
            <label className={styles.maskField}>
              <span>Opacity</span>
              <ValueField value={Math.round(og.opacity * 100)} min={0} max={100} precision={0} unit="%"
                onChange={(v) => updateOuterGlow(nodeId, { opacity: v / 100 })} aria-label="Glow opacity" />
            </label>
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
            <ColorPicker value={ish.color} onChange={(color) => updateInnerShadow(nodeId, { color })} aria-label="Inner shadow color" />
          </div>
          <div className={styles.maskControls}>
            <label className={styles.maskField}>
              <span>Distance</span>
              <ValueField value={ish.distance} min={0} max={200} precision={0} unit="px"
                onChange={(v) => updateInnerShadow(nodeId, { distance: v })} aria-label="Inner shadow distance" />
            </label>
            <label className={styles.maskField}>
              <span>Angle</span>
              <ValueField
                value={ish.useGlobalLight ? light.angle : ish.angle}
                precision={0}
                unit="°"
                onChange={(v) => updateInnerShadow(nodeId, { angle: v, useGlobalLight: false })}
                aria-label="Inner shadow angle"
              />
            </label>
          </div>
          <div className={styles.maskControls}>
            <label className={styles.maskField}>
              <span>Size</span>
              <ValueField value={ish.size} min={0} max={200} precision={0} unit="px"
                onChange={(v) => updateInnerShadow(nodeId, { size: v })} aria-label="Inner shadow size" />
            </label>
            <label className={styles.maskField}>
              <span>Opacity</span>
              <ValueField value={Math.round(ish.opacity * 100)} min={0} max={100} precision={0} unit="%"
                onChange={(v) => updateInnerShadow(nodeId, { opacity: v / 100 })} aria-label="Inner shadow opacity" />
            </label>
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
            <ColorPicker value={igl.color} onChange={(color) => updateInnerGlow(nodeId, { color })} aria-label="Inner glow color" />
          </label>
          <label className={styles.maskField}>
            <span>Size</span>
            <ValueField value={igl.size} min={0} max={200} precision={0} unit="px"
              onChange={(v) => updateInnerGlow(nodeId, { size: v })} aria-label="Inner glow size" />
          </label>
          <label className={styles.maskField}>
            <span>Opacity</span>
            <ValueField value={Math.round(igl.opacity * 100)} min={0} max={100} precision={0} unit="%"
              onChange={(v) => updateInnerGlow(nodeId, { opacity: v / 100 })} aria-label="Inner glow opacity" />
          </label>
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
            <ColorPicker value={sat.color} onChange={(color) => updateSatin(nodeId, { color })} aria-label="Satin color" />
          </div>
          <div className={styles.maskControls}>
            <label className={styles.maskField}>
              <span>Distance</span>
              <ValueField value={sat.distance} min={0} max={200} precision={0} unit="px"
                onChange={(v) => updateSatin(nodeId, { distance: v })} aria-label="Satin distance" />
            </label>
            <label className={styles.maskField}>
              <span>Angle</span>
              <ValueField value={sat.angle} precision={0} unit="°"
                onChange={(v) => updateSatin(nodeId, { angle: v })} aria-label="Satin angle" />
            </label>
          </div>
          <div className={styles.maskControls}>
            <label className={styles.maskField}>
              <span>Size</span>
              <ValueField value={sat.size} min={0} max={200} precision={0} unit="px"
                onChange={(v) => updateSatin(nodeId, { size: v })} aria-label="Satin size" />
            </label>
            <label className={styles.maskField}>
              <span>Opacity</span>
              <ValueField value={Math.round(sat.opacity * 100)} min={0} max={100} precision={0} unit="%"
                onChange={(v) => updateSatin(nodeId, { opacity: v / 100 })} aria-label="Satin opacity" />
            </label>
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
            <label className={styles.maskField}>
              <span>Size</span>
              <ValueField value={bev.size} min={1} max={100} precision={0} unit="px"
                onChange={(v) => updateBevel(nodeId, { size: v })} aria-label="Bevel size" />
            </label>
            <label className={styles.maskField}>
              <span>Depth</span>
              <ValueField value={bev.depth} min={0} max={500} precision={0} unit="%"
                onChange={(v) => updateBevel(nodeId, { depth: v })} aria-label="Bevel depth" />
            </label>
          </div>
          <div className={styles.maskControls}>
            <label className={styles.maskField}>
              <span>Angle</span>
              <ValueField
                value={bev.useGlobalLight ? light.angle : bev.angle}
                precision={0}
                unit="°"
                onChange={(v) => updateBevel(nodeId, { angle: v, useGlobalLight: false })}
                aria-label="Bevel angle"
              />
            </label>
            <label className={styles.maskField}>
              <span>Altitude</span>
              {/* The ONLY control in the app that reads the light's altitude —
                  a bevel needs to know how steeply the light falls, not just
                  which way it comes from. */}
              <ValueField
                value={bev.useGlobalLight ? light.altitude : bev.altitude}
                min={0}
                max={90}
                precision={0}
                unit="°"
                onChange={(v) => updateBevel(nodeId, { altitude: v, useGlobalLight: false })}
                aria-label="Bevel altitude"
              />
            </label>
          </div>
          <div className={styles.blendRow}>
            <span className={styles.blendLabel}>Highlight</span>
            <ColorPicker value={bev.highlightColor}
              onChange={(highlightColor) => updateBevel(nodeId, { highlightColor })} aria-label="Bevel highlight color" />
            <ValueField value={Math.round(bev.highlightOpacity * 100)} min={0} max={100} precision={0} unit="%"
              onChange={(v) => updateBevel(nodeId, { highlightOpacity: v / 100 })} aria-label="Bevel highlight opacity" />
          </div>
          <div className={styles.blendRow}>
            <span className={styles.blendLabel}>Shadow</span>
            <ColorPicker value={bev.shadowColor}
              onChange={(shadowColor) => updateBevel(nodeId, { shadowColor })} aria-label="Bevel shadow color" />
            <ValueField value={Math.round(bev.shadowOpacity * 100)} min={0} max={100} precision={0} unit="%"
              onChange={(v) => updateBevel(nodeId, { shadowOpacity: v / 100 })} aria-label="Bevel shadow opacity" />
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
            <ColorPicker value={co.color} onChange={(color) => updateColorOverlay(nodeId, { color })} aria-label="Overlay color" />
          </label>
          <label className={styles.maskField}>
            <span>Opacity</span>
            <ValueField value={Math.round(co.opacity * 100)} min={0} max={100} precision={0} unit="%"
              onChange={(v) => updateColorOverlay(nodeId, { opacity: v / 100 })} aria-label="Overlay opacity" />
          </label>
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
              <ColorPicker value={go.from} onChange={(from) => updateGradientOverlay(nodeId, { from })} aria-label="Gradient from" />
            </label>
            <label className={styles.maskField}>
              <span>To</span>
              <ColorPicker value={go.to} onChange={(to) => updateGradientOverlay(nodeId, { to })} aria-label="Gradient to" />
            </label>
          </div>
          <div className={styles.maskControls}>
            <label className={styles.maskField}>
              <span>Angle</span>
              <ValueField
                value={go.useGlobalLight ? light.angle : go.angle}
                precision={0}
                unit="°"
                onChange={(v) => updateGradientOverlay(nodeId, { angle: v, useGlobalLight: false })}
                aria-label="Gradient angle"
              />
            </label>
            <label className={styles.maskField}>
              <span>Opacity</span>
              <ValueField value={Math.round(go.opacity * 100)} min={0} max={100} precision={0} unit="%"
                onChange={(v) => updateGradientOverlay(nodeId, { opacity: v / 100 })} aria-label="Gradient opacity" />
            </label>
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
        <div className={styles.maskControls}>
          <label className={styles.maskField}>
            <span>Color</span>
            <ColorPicker value={stk.color} onChange={(color) => updateStrokeStyle(nodeId, { color })} aria-label="Stroke style color" />
          </label>
          <label className={styles.maskField}>
            <span>Size</span>
            <ValueField value={stk.size} min={0} max={200} precision={0} unit="px"
              onChange={(v) => updateStrokeStyle(nodeId, { size: v })} aria-label="Stroke style size" />
          </label>
          <label className={styles.maskField}>
            <span>Opacity</span>
            <ValueField value={Math.round(stk.opacity * 100)} min={0} max={100} precision={0} unit="%"
              onChange={(v) => updateStrokeStyle(nodeId, { opacity: v / 100 })} aria-label="Stroke style opacity" />
          </label>
        </div>
      ) : null}
    </>
  );
}

export default LayerStylesControls;
