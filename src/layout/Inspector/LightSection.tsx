/**
 * LightSection — curated light controls (color / intensity / radius) replacing
 * the raw generic prop dump. Intensity and radius are keyframeable: the
 * renderer already samples their tracks (buildSnapshot reads av.get('intensity')
 * / av.get('radius')), so each row carries the standard keyframe toggle.
 */

import { useMemo } from 'react';
import { ColorPicker } from '@components/ColorPicker';
import { Checkbox } from '@components/Checkbox';
import { useSceneRevision } from '@stores/sceneStore';
import { useCompositionStore } from '@stores/compositionStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { LIGHT_DEFAULTS } from '@core/scene/light';
import { useNodeComponentProp } from '@hooks/useNodeComponentProp';
import styles from './TransformSection.module.css';
import { KeyframeRow as KfRow } from './KeyframeRow';

export function LightSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  const node = defaultSceneGraph.getNode(nodeId);
  const tComp = useMemo(() => node?.components.find((c) => c.type === 'Transform'), [node]);
  const sComp = useMemo(() => node?.components.find((c) => c.type === 'Style'), [node]);
  const [intensityRaw, setIntensity] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'intensity');
  const [radiusRaw, setRadius] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'radius');
  const [typeRaw, setType] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'lightType');
  const [angleRaw, setAngle] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'lightAngle');
  const [coneRaw, setCone] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'lightCone');
  const [fillRaw, setFill] = useNodeComponentProp(defaultSceneGraph, nodeId, sComp?.id, 'fill');
  const [shadowsRaw, setShadows] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'castShadows');
  const [featherRaw, setFeather] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'lightConeFeather');
  const [falloffRaw, setFalloff] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'falloff');
  const [falloffDistRaw, setFalloffDist] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'falloffDistance');
  const [darknessRaw, setDarkness] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'shadowDarkness');
  const [diffusionRaw, setDiffusion] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'shadowDiffusion');
  const [poiXRaw, setPoiX] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'poiX');
  const [poiYRaw, setPoiY] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'poiY');
  const [poiZRaw, setPoiZ] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'poiZ');
  const compWidth = useCompositionStore((s) => s.width);
  const compHeight = useCompositionStore((s) => s.height);
  if (!node || !tComp) return null;

  const num = (v: unknown, fb: number): number => (typeof v === 'number' ? v : fb);
  const intensity = num(intensityRaw, LIGHT_DEFAULTS.intensity);
  const radius = num(radiusRaw, LIGHT_DEFAULTS.radius);
  const color = typeof fillRaw === 'string' ? fillRaw : '#fff3c0';
  const type = typeRaw === 'ambient' || typeRaw === 'spot' || typeRaw === 'parallel' ? typeRaw : 'point';
  const angle = num(angleRaw, LIGHT_DEFAULTS.angle);
  const cone = num(coneRaw, LIGHT_DEFAULTS.cone);
  const feather = num(featherRaw, LIGHT_DEFAULTS.coneFeather);
  const falloff = falloffRaw === 'smooth' || falloffRaw === 'inverse-square' ? falloffRaw : 'none';
  const falloffDistance = num(falloffDistRaw, LIGHT_DEFAULTS.falloffDistance);
  const darkness = num(darknessRaw, LIGHT_DEFAULTS.shadowDarkness);
  const diffusion = num(diffusionRaw, LIGHT_DEFAULTS.shadowDiffusion);
  const castsShadows = shadowsRaw === true || shadowsRaw === 1;
  // A light is "targeted" (aimed in 3D) as soon as any POI component exists —
  // the same test readNodeLight applies.
  const hasPOI = [poiXRaw, poiYRaw, poiZRaw].some((v) => typeof v === 'number');
  const aimable = type === 'spot' || type === 'parallel';

  return (
    <div className={styles.section}>
      <div className={styles.inlineRows}>
        <div className={styles.popoverRow}>
          <span className={styles.popoverLabel}>Type</span>
          <select
            className={styles.select}
            style={{ width: 110 }}
            value={type}
            onChange={(e) => setType(e.target.value)}
            aria-label="Light type"
          >
            <option value="point">Point (glow)</option>
            <option value="ambient">Ambient (lift)</option>
            <option value="spot">Spot (cone)</option>
            <option value="parallel">Parallel (directional)</option>
          </select>
        </div>
        <div className={styles.popoverRow}>
          <span className={styles.popoverLabel}>Color</span>
          <ColorPicker value={color} onChange={(hex) => setFill(hex)} aria-label="Light color" />
        </div>
        <KfRow nodeId={nodeId} prop="intensity" label="Intensity" value={intensity} unit="%" min={0} onStatic={(v) => setIntensity(v)} />
        {type !== 'ambient' && (
          <KfRow nodeId={nodeId} prop="radius" label="Radius" value={radius} unit="px" min={1} onStatic={(v) => setRadius(v)} />
        )}
        {type !== 'ambient' && (
          <>
            <div className={styles.popoverRow}>
              <span className={styles.popoverLabel}>Falloff</span>
              <select
                className={styles.select}
                style={{ width: 110 }}
                value={falloff}
                onChange={(e) => setFalloff(e.target.value === 'none' ? undefined : e.target.value)}
                aria-label="Falloff"
              >
                <option value="none">None</option>
                <option value="smooth">Smooth</option>
                <option value="inverse-square">Inverse Square Clamped</option>
              </select>
            </div>
            {falloff !== 'none' && (
              <KfRow
                nodeId={nodeId}
                prop="falloffDistance"
                label="Falloff distance"
                value={falloffDistance}
                unit="px"
                min={1}
                onStatic={(v) => setFalloffDist(v)}
              />
            )}
          </>
        )}
        {aimable && !hasPOI && (
          <KfRow nodeId={nodeId} prop="lightAngle" label="Direction" value={angle} unit="°" onStatic={(v) => setAngle(v)} />
        )}
        {type === 'spot' && (
          <>
            <KfRow nodeId={nodeId} prop="lightCone" label="Cone angle" value={cone} unit="°" min={1} onStatic={(v) => setCone(v)} />
            <KfRow
              nodeId={nodeId}
              prop="lightConeFeather"
              label="Cone feather"
              value={feather}
              unit="%"
              min={0}
              max={100}
              onStatic={(v) => setFeather(v)}
            />
          </>
        )}
        {aimable && (
          <>
            <div className={styles.subhead} style={{ marginTop: 8 }}>Point of Interest</div>
            {hasPOI ? (
              <>
                <KfRow nodeId={nodeId} prop="poiX" label="Target X" value={num(poiXRaw, compWidth / 2)} unit="px" onStatic={(v) => setPoiX(v)} />
                <KfRow nodeId={nodeId} prop="poiY" label="Target Y" value={num(poiYRaw, compHeight / 2)} unit="px" onStatic={(v) => setPoiY(v)} />
                <KfRow nodeId={nodeId} prop="poiZ" label="Target Z" value={num(poiZRaw, 0)} unit="px" onStatic={(v) => setPoiZ(v)} />
                <button
                  type="button"
                  onClick={() => { setPoiX(undefined); setPoiY(undefined); setPoiZ(undefined); }}
                  style={{ height: 20, padding: '0 8px', fontSize: 10, background: 'var(--color-surface-0)', color: 'var(--color-text-tertiary)', border: '1px solid var(--color-border-subtle)', borderRadius: 4, cursor: 'pointer' }}
                >
                  Remove target (aim by angle)
                </button>
              </>
            ) : (
              <>
                <p style={{ margin: '2px 0 6px', fontSize: 10, color: 'var(--color-text-tertiary)', lineHeight: 1.5 }}>
                  Direction alone can only swing this light within the comp plane —
                  it can never aim at a layer sitting at a different depth. A target
                  aims it in real 3D.
                </p>
                <button
                  type="button"
                  onClick={() => { setPoiX(compWidth / 2); setPoiY(compHeight / 2); setPoiZ(0); }}
                  style={{ height: 22, padding: '0 10px', fontSize: 10, fontWeight: 600, background: 'var(--color-surface-0)', color: 'var(--color-text-secondary)', border: '1px solid var(--color-border-subtle)', borderRadius: 4, cursor: 'pointer' }}
                >
                  Add target
                </button>
              </>
            )}
          </>
        )}
        {type !== 'ambient' && (
          <div className={styles.popoverRow}>
            <span className={styles.popoverLabel}>Cast shadows</span>
            <Checkbox
              checked={castsShadows}
              onChange={() => setShadows(castsShadows ? false : true)}
              title="Content layers drop a soft shadow away from this light"
            />
          </div>
        )}
        {type !== 'ambient' && castsShadows && (
          <>
            <KfRow nodeId={nodeId} prop="shadowDarkness" label="Shadow darkness" value={darkness} unit="%" min={0} max={100} onStatic={(v) => setDarkness(v)} />
            <KfRow nodeId={nodeId} prop="shadowDiffusion" label="Shadow diffusion" value={diffusion} unit="px" min={0} onStatic={(v) => setDiffusion(v)} />
          </>
        )}
        <p style={{ margin: '6px 0 0', fontSize: 10, color: 'var(--color-text-tertiary)', lineHeight: 1.5 }}>
          {type === 'ambient'
            ? 'A uniform lift brightening the whole frame (screen blend).'
            : type === 'spot'
              ? 'A cone of light along its direction, fading over the radius.'
              : type === 'parallel'
                ? 'A directional wash across the frame (like sunlight), brighter on the source side.'
                : 'A point light brightening the layers beneath it (screen blend).'}
          {' '}Numeric parameters are keyframeable.
        </p>
      </div>
    </div>
  );
}

export default LightSection;
