/**
 * LightSection — curated light controls (preset / type / colour / intensity /
 * shaping) replacing the raw generic prop dump. Intensity, radius and the rest
 * of the numeric rows are keyframeable: the renderer already samples their
 * tracks (buildSnapshot reads av.get('intensity') / av.get('radius')), so each
 * row carries the standard keyframe toggle.
 *
 * Two things this section used to make unreachable:
 *
 *  • ENVIRONMENT lights. `LightType` has five members and the engine expands an
 *    environment light into a full SH-probe rig, but the coercion here folded
 *    anything that was not ambient/spot/parallel down to 'point' and the type
 *    menu offered four options — so an environment light created from the New
 *    Light dialog displayed, and edited, as a point light, and `envPreset` /
 *    `envRotation` (which buildSnapshot reads, the latter per-frame) had no
 *    controls at all.
 *
 *  • COLOUR TEMPERATURE. Lighting is chosen in Kelvin; the hex picker cannot
 *    express that, so every warm/cool decision was eyeballed. The Kelvin row
 *    writes the same `fill` prop through the blackbody fit, and reads its own
 *    position back from the colour, so the two controls stay one value.
 */

import { useMemo } from 'react';
import { ColorPicker } from '@components/ColorPicker';
import { Checkbox } from '@components/Checkbox';
import { Button } from '@components/Button';
import { ValueField } from '@components/ValueField';
import { useSceneRevision } from '@stores/sceneStore';
import { batchHistory } from '@stores/historyStore';
import { useCompositionStore } from '@stores/compositionStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { LIGHT_DEFAULTS, type LightType, type LightFalloff } from '@core/scene/light';
import { ENVIRONMENT_PRESETS, type EnvironmentPresetId } from '@core/scene/environmentLight';
import { kelvinToHex, nearestKelvin, KELVIN_MIN, KELVIN_MAX } from '@core/scene/colorTemperature';
import { useNodeComponentProp } from '@hooks/useNodeComponentProp';
import styles from './TransformSection.module.css';
import { KeyframeRow as KfRow } from './KeyframeRow';

/**
 * Lighting-department starting points, modelled on CameraSection's lens
 * presets: one pick sets the whole look (type + energy + colour + shaping) as a
 * single synchronous edit, which the inspector's history path records as ONE
 * undo step. Colours come from the blackbody fit rather than hand-picked hexes,
 * so "warm practical" is literally 2700 K.
 */
interface LightPreset {
  label: string;
  type: LightType;
  /** Percent, matching Light.intensity. */
  intensity: number;
  /** Colour temperature, K — the preset's colour is derived from it. */
  kelvin: number;
  falloff: LightFalloff;
  /** Spot only. */
  cone?: number;
  coneFeather?: number;
  hint: string;
}

const LIGHT_PRESETS: LightPreset[] = [
  { label: 'Key', type: 'spot', intensity: 100, kelvin: 5600, falloff: 'smooth', cone: 45, coneFeather: 45, hint: 'The main source: a daylight-balanced spot at full energy.' },
  { label: 'Fill', type: 'point', intensity: 45, kelvin: 6500, falloff: 'smooth', hint: 'A soft, low-energy wash opposite the key to open the shadows.' },
  { label: 'Rim / Back', type: 'spot', intensity: 140, kelvin: 7000, falloff: 'smooth', cone: 30, coneFeather: 30, hint: 'Hot, slightly cool and narrow — separates the subject from the background.' },
  { label: 'Soft top', type: 'parallel', intensity: 65, kelvin: 6000, falloff: 'none', hint: 'An even overhead wash, like a bounced ceiling.' },
  { label: 'Warm practical', type: 'point', intensity: 80, kelvin: 2700, falloff: 'inverse-square', hint: 'A tungsten lamp in shot: warm, and falling off physically.' },
  { label: 'Cool moonlight', type: 'parallel', intensity: 55, kelvin: 10000, falloff: 'none', hint: 'A dim, very blue directional wash.' },
  { label: 'Sunset key', type: 'spot', intensity: 110, kelvin: 2200, falloff: 'smooth', cone: 70, coneFeather: 70, hint: 'Low, wide and orange — a sun near the horizon.' },
];

function isEnvPresetId(v: unknown): v is EnvironmentPresetId {
  return v === 'studio' || v === 'sky' || v === 'sunset';
}

/** The canonical five-member LightType, matching `readNodeLight`'s coercion. */
function coerceLightType(v: unknown): LightType {
  return v === 'ambient' || v === 'spot' || v === 'parallel' || v === 'environment' ? v : 'point';
}

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
  const [envPresetRaw, setEnvPreset] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'envPreset');
  const [envRotationRaw, setEnvRotation] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'envRotation');
  const compWidth = useCompositionStore((s) => s.width);
  const compHeight = useCompositionStore((s) => s.height);
  if (!node || !tComp) return null;

  const num = (v: unknown, fb: number): number => (typeof v === 'number' ? v : fb);
  const intensity = num(intensityRaw, LIGHT_DEFAULTS.intensity);
  const radius = num(radiusRaw, LIGHT_DEFAULTS.radius);
  const color = typeof fillRaw === 'string' ? fillRaw : '#fff3c0';
  const type = coerceLightType(typeRaw);
  const angle = num(angleRaw, LIGHT_DEFAULTS.angle);
  const cone = num(coneRaw, LIGHT_DEFAULTS.cone);
  const feather = num(featherRaw, LIGHT_DEFAULTS.coneFeather);
  const falloff = falloffRaw === 'smooth' || falloffRaw === 'inverse-square' ? falloffRaw : 'none';
  const falloffDistance = num(falloffDistRaw, LIGHT_DEFAULTS.falloffDistance);
  const darkness = num(darknessRaw, LIGHT_DEFAULTS.shadowDarkness);
  const diffusion = num(diffusionRaw, LIGHT_DEFAULTS.shadowDiffusion);
  const castsShadows = shadowsRaw === true || shadowsRaw === 1;
  const envPreset: EnvironmentPresetId = isEnvPresetId(envPresetRaw) ? envPresetRaw : 'studio';
  const envRotation = num(envRotationRaw, 0);
  // A light is "targeted" (aimed in 3D) as soon as any POI component exists —
  // the same test readNodeLight applies.
  const hasPOI = [poiXRaw, poiYRaw, poiZRaw].some((v) => typeof v === 'number');
  /*
    An environment light has NO position, no reach and no cone: buildSnapshot
    reads only its `envPreset`, its `envRotation` and its `intensity`, expands
    those into the derived ambient+parallel rig, and explicitly skips it for
    both the glow wash and 2.5D shadow casting. Every other row here would be a
    control that changes nothing, so none of them are drawn.
  */
  const isEnv = type === 'environment';
  /** point / spot / parallel — the lights that actually sit somewhere. */
  const positional = !isEnv && type !== 'ambient';
  const aimable = type === 'spot' || type === 'parallel';

  const activePreset = LIGHT_PRESETS.find(
    (p) => p.type === type
      && p.intensity === intensity
      && p.falloff === falloff
      && kelvinToHex(p.kelvin) === color.trim().toLowerCase(),
  );

  /**
   * Apply a whole look as ONE undoable edit.
   *
   * `batchHistory` is load-bearing, not decoration: the debounced recorder
   * splits on a change of target, so six prop writes would otherwise land as
   * six undo steps for one menu pick — the same trap the linked corner radii
   * hit (`inspectorHistoryGranularity.test.tsx` measures it).
   */
  const applyPreset = (label: string): void => {
    const p = LIGHT_PRESETS.find((x) => x.label === label);
    if (!p) return;
    batchHistory(`light-preset:${nodeId}`, () => {
      setType(p.type);
      setIntensity(p.intensity);
      setFill(kelvinToHex(p.kelvin));
      // `none` is the absence of a falloff prop, not a stored value — the same
      // convention the Falloff menu below writes.
      setFalloff(p.falloff === 'none' ? undefined : p.falloff);
      if (p.type === 'spot') {
        setCone(p.cone ?? LIGHT_DEFAULTS.cone);
        setFeather(p.coneFeather ?? LIGHT_DEFAULTS.coneFeather);
      }
    });
  };

  return (
    <div className={styles.section}>
      <div className={styles.inlineRows}>
        <div className={styles.popoverRow}>
          <span className={styles.popoverLabel}>Preset</span>
          <select
            className={styles.select}
            style={{ width: 150 }}
            value={activePreset?.label ?? ''}
            onChange={(e) => applyPreset(e.target.value)}
            aria-label="Light preset"
            title={activePreset?.hint ?? 'Start from a lighting-department look, then adjust'}
          >
            {!activePreset && <option value="">Custom</option>}
            {LIGHT_PRESETS.map((p) => (
              <option key={p.label} value={p.label}>{p.label}</option>
            ))}
          </select>
        </div>
        <div className={styles.popoverRow}>
          <span className={styles.popoverLabel}>Type</span>
          <select
            className={styles.select}
            style={{ width: 150 }}
            value={type}
            onChange={(e) => {
              const next = coerceLightType(e.target.value);
              // One menu pick = one undo step, even though becoming an
              // environment light writes three props.
              batchHistory(`light-type:${nodeId}`, () => {
                setType(next);
                // Switching TO environment has to land on a real sky:
                // `envPreset` is what selects the SH probe, and an undefined
                // one would leave the light silently reading the fallback with
                // a menu that could not show which preset was in force.
                if (next === 'environment') {
                  if (!isEnvPresetId(envPresetRaw)) setEnvPreset('studio');
                  if (typeof envRotationRaw !== 'number') setEnvRotation(0);
                }
              });
            }}
            aria-label="Light type"
          >
            <option value="point">Point (glow)</option>
            <option value="ambient">Ambient (lift)</option>
            <option value="spot">Spot (cone)</option>
            <option value="parallel">Parallel (directional)</option>
            <option value="environment">Environment (sky probe)</option>
          </select>
        </div>
        {isEnv && (
          <div className={styles.popoverRow}>
            <span className={styles.popoverLabel}>Sky</span>
            <select
              className={styles.select}
              style={{ width: 150 }}
              value={envPreset}
              onChange={(e) => setEnvPreset(e.target.value)}
              aria-label="Environment preset"
            >
              {ENVIRONMENT_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          </div>
        )}
        {!isEnv && (
          <>
            <div className={styles.popoverRow}>
              <span className={styles.popoverLabel}>Color</span>
              <ColorPicker value={color} onChange={(hex) => setFill(hex)} aria-label="Light color" />
            </div>
            <div className={styles.popoverRow}>
              <span className={styles.popoverLabel}>Temperature</span>
              <ValueField
                value={nearestKelvin(color)}
                min={KELVIN_MIN}
                max={KELVIN_MAX}
                step={100}
                unit="K"
                onChange={(v) => setFill(kelvinToHex(v))}
                aria-label="Color temperature"
              />
            </div>
          </>
        )}
        <KfRow nodeId={nodeId} prop="intensity" label="Intensity" value={intensity} unit="%" min={0} onStatic={(v) => setIntensity(v)} />
        {isEnv && (
          <KfRow
            nodeId={nodeId}
            prop="envRotation"
            label="Sky rotation"
            value={envRotation}
            unit="°"
            onStatic={(v) => setEnvRotation(v)}
          />
        )}
        {positional && (
          <KfRow nodeId={nodeId} prop="radius" label="Radius" value={radius} unit="px" min={1} onStatic={(v) => setRadius(v)} />
        )}
        {positional && (
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
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => { setPoiX(undefined); setPoiY(undefined); setPoiZ(undefined); }}
                >
                  Remove target (aim by angle)
                </Button>
              </>
            ) : (
              <>
                <p style={{ margin: '2px 0 6px', fontSize: 'var(--font-size-micro)', color: 'var(--color-text-tertiary)', lineHeight: 1.5 }}>
                  Direction alone can only swing this light within the comp plane —
                  it can never aim at a layer sitting at a different depth. A target
                  aims it in real 3D.
                </p>
                <Button
                  size="xs"
                  variant="secondary"
                  onClick={() => { setPoiX(compWidth / 2); setPoiY(compHeight / 2); setPoiZ(0); }}
                >
                  Add target
                </Button>
              </>
            )}
          </>
        )}
        {positional && (
          <div className={styles.popoverRow}>
            <span className={styles.popoverLabel}>Cast shadows</span>
            <Checkbox
              checked={castsShadows}
              onChange={() => setShadows(castsShadows ? false : true)}
              title="Content layers drop a soft shadow away from this light"
            />
          </div>
        )}
        {positional && castsShadows && (
          <>
            <KfRow nodeId={nodeId} prop="shadowDarkness" label="Shadow darkness" value={darkness} unit="%" min={0} max={100} onStatic={(v) => setDarkness(v)} />
            <KfRow nodeId={nodeId} prop="shadowDiffusion" label="Shadow diffusion" value={diffusion} unit="px" min={0} onStatic={(v) => setDiffusion(v)} />
          </>
        )}
        <p style={{ margin: '6px 0 0', fontSize: 'var(--font-size-micro)', color: 'var(--color-text-tertiary)', lineHeight: 1.5 }}>
          {type === 'ambient'
            ? 'A uniform lift brightening the whole frame (screen blend).'
            : type === 'spot'
              ? 'A cone of light along its direction, fading over the radius.'
              : type === 'parallel'
                ? 'A directional wash across the frame (like sunlight), brighter on the source side.'
                : isEnv
                  ? 'Image-based lighting: the sky is projected onto a spherical-harmonic probe and expanded into an ambient floor plus directional bounces, so 3D layers pick up its colour from every side. It has no position, no reach and casts no shadows — only the sky, its rotation and the intensity matter.'
                  : 'A point light brightening the layers beneath it (screen blend).'}
          {' '}Numeric parameters are keyframeable.
        </p>
      </div>
    </div>
  );
}

export default LightSection;
