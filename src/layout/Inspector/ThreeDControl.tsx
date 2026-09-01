/**
 * ThreeDControl — the layer's "3D Layer" switch in the inspector.
 *
 * Turning it on adds depth props (Z, X-rotation, Y-rotation) to the layer, so
 * the NodeInspector below renders keyframeable rows for them and the renderer
 * projects the layer through the composition camera (perspective scale +
 * parallax + tilt). Turning it off removes them and the layer is flat 2D again.
 *
 * Material rows are label + styled slider + scrubbable ValueField. The old
 * shape — a bare <input type="range"> with NO numeric readout — meant seven of
 * the eight material properties could not be seen or typed at all, which was
 * the single largest control gap against AE's Material Options.
 */

import { Switch } from '@components/Switch';
import { ValueField } from '@components/ValueField';
import { useSceneRevision } from '@stores/sceneStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { is3DEnabled, set3DEnabled, canBe3D, readNode3D, setNodeExtrusionDepth, setNodeBevelDepth, isPerChar3D, setNodePerChar3D } from '@core/scene/threeD';
import { hasTextComponent } from '@core/text/textAnimators';
import { notifyCameraTipIfMissing } from '@core/workspace/cameraNav';
import { useUIStore } from '@stores/uiStore';
import parentStyles from './ParentControl.module.css';
import s from './ThreeDControl.module.css';
import { FaceMaterialsSection } from './FaceMaterialsSection';

import {
  readNodeMaterial,
  setNodeAcceptsLights,
  setNodeMaterialPct,
  setNodeShadowMode,
  setNodeShininess,
  setNodeSpecular,
  setNodeShadingModel,
  MATERIAL_PCT_DEFAULTS,
} from '@core/scene/material';

/**
 * One material response row: label, slider, and a scrubbable/typable number.
 * Slider and field write through the same handler, so they can never disagree.
 */
function MaterialRow({
  label,
  value,
  min = 0,
  max = 100,
  unit = '%',
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  unit?: string;
  onChange: (v: number) => void;
}): JSX.Element {
  return (
    <div className={s.row}>
      <span className={s.label}>{label}</span>
      <input
        type="range"
        className={s.slider}
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
        aria-label={`${label} slider`}
      />
      <span className={s.value}>
        <ValueField
          value={value}
          min={min}
          max={max}
          step={1}
          unit={unit}
          onChange={onChange}
          aria-label={label}
        />
      </span>
    </div>
  );
}

export function ThreeDControl({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node || nodeId === 'comp_root') return null;
  // Only kinds the renderer can actually project in 3D get the switch —
  // groups / nulls / cameras / lights / solids / particles etc. are excluded
  // by the shared canBe3D predicate (single source of truth with the timeline
  // cube and the viewport 3D badge).
  if (!canBe3D(node)) return null;

  const on = is3DEnabled(node);
  const material = readNodeMaterial(node);
  const three = readNode3D(node);
  // Per-character 3D is a text-only affordance (AE parity).
  const isTextLayer = hasTextComponent(node);

  return (
    <div className={s.stack}>
      <div className={parentStyles.row}>
        <span className={parentStyles.label}>3D Layer</span>
        <Switch
          checked={on}
          onChange={(e) => {
            const next = e.currentTarget.checked;
            set3DEnabled(nodeId, next);
            if (next) {
              notifyCameraTipIfMissing((message, level) =>
                useUIStore.getState().notify({ level, message, durationMs: 3200 }),
              );
            }
          }}
          aria-label="3D layer"
        />
      </div>

      {on && (
        <div className={s.subPanel}>
          <span className={s.groupHeader}>Geometry Options</span>
          {isTextLayer && (
            <div className={s.row}>
              <span className={s.label}>Per-character 3D</span>
              <Switch
                checked={isPerChar3D(node)}
                onChange={(e) => setNodePerChar3D(nodeId, e.currentTarget.checked)}
                aria-label="Enable per-character 3D"
              />
            </div>
          )}
          <div className={s.row}>
            <span className={s.label}>Extrusion Depth</span>
            <ValueField
              value={three.extrusionDepth}
              min={0}
              max={1000}
              step={1}
              unit="px"
              onChange={(v) => setNodeExtrusionDepth(nodeId, v)}
              aria-label="Extrusion depth"
            />
          </div>
          {three.extrusionDepth > 0 && (
            <div className={s.row}>
              <span className={s.label}>Bevel Depth</span>
              <ValueField
                value={three.bevelDepth}
                min={0}
                max={200}
                step={1}
                unit="px"
                onChange={(v) => setNodeBevelDepth(nodeId, v)}
                aria-label="Bevel depth"
              />
            </div>
          )}
          <FaceMaterialsSection nodeId={nodeId} />
          <span className={s.groupHeader}>Material Options</span>
          {/* Tri-states, not switches: `Only` is what shadow-catcher setups are
              built from — a layer that throws or catches a shadow without
              rendering itself — and a boolean cannot express it. */}
          <div className={s.row}>
            <span className={s.label}>Casts Shadows</span>
            <select
              className={s.select}
              value={material.castsShadowsMode}
              onChange={(e) => setNodeShadowMode(nodeId, 'castsShadows', e.currentTarget.value as 'off' | 'on' | 'only')}
              aria-label="Casts shadows"
            >
              <option value="off">Off</option>
              <option value="on">On</option>
              <option value="only">Only</option>
            </select>
          </div>
          <div className={s.row}>
            <span className={s.label}>Accepts Shadows</span>
            <select
              className={s.select}
              value={material.acceptsShadowsMode}
              onChange={(e) => setNodeShadowMode(nodeId, 'acceptsShadows', e.currentTarget.value as 'off' | 'on' | 'only')}
              aria-label="Accepts shadows"
            >
              <option value="off">Off</option>
              <option value="on">On</option>
              <option value="only">Only</option>
            </select>
          </div>
          {material.shadowOnly && (
            <p className={s.hint}>
              “Only” hides the layer itself — it stays in the scene purely as a
              shadow caster or catcher.
            </p>
          )}
          <MaterialRow
            label="Light Transmission"
            value={material.lightTransmission}
            onChange={(v) => setNodeMaterialPct(nodeId, 'lightTransmission', v, MATERIAL_PCT_DEFAULTS.lightTransmission)}
          />
          <div className={s.row}>
            <span className={s.label}>Accepts Lights</span>
            <Switch
              checked={material.acceptsLights}
              onChange={(e) => setNodeAcceptsLights(nodeId, e.currentTarget.checked)}
              aria-label="Accepts lights"
            />
          </div>
          {material.acceptsLights && (
            <>
              <MaterialRow
                label="Ambient"
                value={material.ambient}
                onChange={(v) => setNodeMaterialPct(nodeId, 'ambient', v, MATERIAL_PCT_DEFAULTS.ambient)}
              />
              <MaterialRow
                label="Diffuse"
                value={material.diffuse}
                onChange={(v) => setNodeMaterialPct(nodeId, 'diffuse', v, MATERIAL_PCT_DEFAULTS.diffuse)}
              />
              {/* Reflectance model. Phong is the original look and the
                  default; Physical is Cook-Torrance/GGX — AE's Advanced 3D
                  model — where Roughness replaces Shininess and Metal means
                  "reflects its own colour, no diffuse". */}
              <div className={s.row}>
                <span className={s.label}>Shading</span>
                <select
                  className={s.select}
                  value={material.shading}
                  onChange={(e) => setNodeShadingModel(nodeId, e.currentTarget.value === 'pbr' ? 'pbr' : 'phong')}
                  aria-label="Shading model"
                >
                  <option value="phong">Phong</option>
                  <option value="pbr">Physical (PBR)</option>
                </select>
              </div>
              <MaterialRow
                label="Specular"
                value={material.specular}
                onChange={(v) => setNodeSpecular(nodeId, v)}
              />
              {material.shading === 'pbr' ? (
                <MaterialRow
                  label="Roughness"
                  value={material.roughness}
                  onChange={(v) => setNodeMaterialPct(nodeId, 'roughness', v, MATERIAL_PCT_DEFAULTS.roughness)}
                />
              ) : (
                <MaterialRow
                  label="Shininess"
                  value={material.shininess}
                  min={1}
                  max={128}
                  unit=""
                  onChange={(v) => setNodeShininess(nodeId, v)}
                />
              )}
              <MaterialRow
                label="Metal"
                value={material.metal}
                onChange={(v) => setNodeMaterialPct(nodeId, 'metal', v, MATERIAL_PCT_DEFAULTS.metal)}
              />
              {/* Metal only shows up in the highlight, so it reads as dead
                  unless Specular is up. Say so rather than letting the slider
                  look broken. (Under PBR a metal also loses its diffuse, so it
                  is never invisible there.) */}
              {material.specular === 0 && material.shading !== 'pbr' && (
                <p className={s.hint}>
                  Metal tints the specular highlight — raise Specular to see it.
                </p>
              )}
            </>
          )}
          {/* The "Pro 3D Material Presets" grid lived here. It was a third
              hard-coded preset grid, in a panel that does not own fill — picking
              one silently replaced the layer's colour. The same six materials
              are now in the Style panel's preset registry under "Material",
              alongside every other look, and they set specular/shininess through
              the same apply path. */}
        </div>
      )}
    </div>
  );
}

export default ThreeDControl;
