/**
 * LightSection — After Effects' Light Options for a light layer (2026-10-08):
 *
 *   Light Type
 *   Color · Color Temperature · Intensity
 *   Cone Angle · Cone Feather                      (Spot)
 *   Falloff · Radius · Falloff Distance            (Point, Spot)
 *   Casts Shadows  On/Off
 *     Shadow Darkness · Shadow Diffusion · ▶ Shadow Map
 *   Point of Interest X Y Z  [Aim by Angle]        (Spot, Parallel)
 *     — or Direction  [Add Target]
 *   ▶ Viewer: Show Glow in Viewer  On/Off          (Point, Spot)
 *
 * Numeric rows are keyframeable — the renderer samples their tracks — so each
 * carries the standard keyframe toggle.
 *
 * ## The panel grammar (typography.css, "Panel type roles")
 *
 * A twirl only opens and closes: Casts Shadows is a ROW whose value reads On /
 * Off, never a group header with a checkbox in it. Explanations are tooltips,
 * not paragraphs; the one help line left is the light-count warning. Picking a
 * whole look is an action on the section, so the preset picker is "Light
 * Presets ▸" in the Properties ≡ menu (`LightPresetsMenu`), not a row.
 *
 * ## Only rows the engine reads
 *
 *  • Falloff, Radius and Falloff Distance are drawn for Point and Spot only:
 *    the engine shades a Parallel light with no distance term
 *    (lights3d.cpp, solid3d.wgsl) and an Ambient one has no position. Radius
 *    is the reach of the Smooth and Inverse Square curves and of the legacy
 *    ramp; under Falloff None it changes only the viewer glow's size, so it is
 *    drawn then only while the glow is on. Falloff Distance is read by Smooth
 *    alone (Inverse Square ignores it).
 *  • Show Glow in Viewer is for Point and Spot: a Parallel light's glow is a
 *    radial blob at a meaningless position (light_wash.cpp). A Parallel or
 *    Ambient light that already HAS its glow on keeps the row, so it can be
 *    turned off.
 *  • An ENVIRONMENT light has no position, no reach and no cone: the engine
 *    reads its sky (`envPreset`, a preset or an `asset:` image), rotation,
 *    reflections and intensity, expands them into an ambient + parallel rig
 *    and a prefiltered reflection map, and skips it for the glow. So it shows
 *    only those rows, plus its visible sky and its key-light shadow.
 *
 * COLOUR TEMPERATURE: lighting is chosen in Kelvin; the hex picker cannot
 * express that. The Kelvin row writes the same `fill` prop through the
 * blackbody fit and reads its own position back from the colour, so the two
 * controls stay one value.
 */

import { useEffect } from 'react';
import { useMirrorFootage, useMirrorLayer, useMirrorProperty } from '@hooks/useMirror';
import { useActiveCompLayers } from '@hooks/useMirrorFields';
import { uiKindOf } from '@core/mirror/layerKinds';
import { ColorPicker } from '@components/ColorPicker';
import { Button } from '@components/Button';
import { ValueField } from '@components/ValueField';
import type { DropdownItem } from '@components/Dropdown';
import { cn } from '@utils/cn';
import { getTime } from '@stores/playbackClockStore';
import { edit } from '@core/engine/uiEdits';
import { componentOfType, values } from '@core/engine/propRefs';
import { POI_PATH } from '@core/engine/pointOfInterest';
import { LIGHT_DEFAULTS, MAX_LIGHTS3D, type LightType, type LightFalloff } from '@core/scene/light';
import {
  ENVIRONMENT_PRESETS,
  DEFAULT_ENVIRONMENT_PRESET,
  isEnvironmentPresetId,
  isEnvironmentSky,
  environmentSkyAssetId,
  environmentSkyForAsset,
  type EnvironmentSky,
} from '@core/scene/environmentLight';
import { ensureEnvironmentSh } from '@core/scene/environmentImage';
import { kelvinToHex, nearestKelvin, KELVIN_MIN, KELVIN_MAX } from '@core/scene/colorTemperature';
import {
  componentPropCommands,
  componentPropsCommands,
  reportUnaddressed,
  useComponentProp,
} from './useComponentProp';
import { TwirlGroup } from './appearance/TwirlGroup';
import { MultiPropertyPairRow, type PairFieldSpec } from './MultiPropertyPairRow';
import { OnOffRow } from './OnOffRow';
import { useSectionMenuRows } from './sectionMenu';
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
}

export const LIGHT_PRESETS: readonly LightPreset[] = [
  // The main source: a daylight-balanced spot at full energy.
  { label: 'Key', type: 'spot', intensity: 100, kelvin: 5600, falloff: 'smooth', cone: 45, coneFeather: 45 },
  // A soft, low-energy wash opposite the key to open the shadows.
  { label: 'Fill', type: 'point', intensity: 45, kelvin: 6500, falloff: 'smooth' },
  // Hot, slightly cool and narrow — separates the subject from the background.
  { label: 'Rim / Back', type: 'spot', intensity: 140, kelvin: 7000, falloff: 'smooth', cone: 30, coneFeather: 30 },
  // An even overhead light, like a bounced ceiling.
  { label: 'Soft top', type: 'parallel', intensity: 65, kelvin: 6000, falloff: 'none' },
  // A tungsten lamp in shot: warm, and falling off physically.
  { label: 'Warm practical', type: 'point', intensity: 80, kelvin: 2700, falloff: 'inverse-square' },
  // A dim, very blue directional light.
  { label: 'Cool moonlight', type: 'parallel', intensity: 55, kelvin: 10000, falloff: 'none' },
  // Low, wide and orange — a sun near the horizon.
  { label: 'Sunset key', type: 'spot', intensity: 110, kelvin: 2200, falloff: 'smooth', cone: 70, coneFeather: 70 },
];

/** A new light's colour when its Style carries no fill (readNodeLight's default). */
const DEFAULT_COLOR = '#fff3c0';

/** The canonical five-member LightType, matching `readNodeLight`'s coercion. */
function coerceLightType(v: unknown): LightType {
  return v === 'ambient' || v === 'spot' || v === 'parallel' || v === 'environment' ? v : 'point';
}

function coerceFalloff(v: unknown): LightFalloff {
  return v === 'smooth' || v === 'inverse-square' || v === 'legacy' ? v : 'none';
}

const num = (v: unknown, fb: number): number => (typeof v === 'number' ? v : fb);

/** The rows' components (Transform, the Style fill), resolved by the write seam when a row writes (the reads are the mirror's). */
const TRANSFORM = { type: 'Transform' } as const;
const STYLE = { type: 'Style' } as const;

/** Point of Interest as Position draws its axes: one row, three fields, each keyframed on its own track. */
const POI_FIELDS: readonly PairFieldSpec[] = [
  { prop: 'poiX', prefix: 'X' },
  { prop: 'poiY', prefix: 'Y' },
  { prop: 'poiZ', prefix: 'Z' },
];

/**
 * Transform-component props (+ the light's Style fill) as ONE engine batch —
 * one undo entry for one menu pick. Refused whole when any prop is not an
 * engine property of this light (nothing half-applied).
 */
function sendLightLook(nodeId: string, label: string, t: Record<string, unknown>, fill?: string): void {
  const seconds = getTime();
  // The components the batch lands on, from the write seam at write time.
  const tId = componentOfType(nodeId, 'Transform') ?? '';
  const sId = componentOfType(nodeId, 'Style');
  const { cmds, rest } = componentPropsCommands(nodeId, tId, t, seconds);
  const fillCmds = fill !== undefined && sId ? componentPropCommands(nodeId, sId, 'fill', fill, seconds) : [];
  const missing = [...Object.keys(rest), ...(fillCmds === null ? ['fill'] : [])];
  if (missing.length > 0) {
    reportUnaddressed(nodeId, missing, label);
    return;
  }
  void edit(label, [...cmds, ...(fillCmds ?? [])]);
}

/**
 * Apply a whole look as ONE undoable edit: `light/lightType` and
 * `light/falloff` (layer fields), Intensity and the cone (keyed at the
 * playhead where animated), and the colour (`layer/fill`).
 */
export function applyLightPreset(nodeId: string, p: LightPreset): void {
  sendLightLook(nodeId, `Light Preset: ${p.label}`, {
    lightType: p.type,
    intensity: p.intensity,
    // Stored explicitly, `none` included: an ABSENT falloff is what the
    // 1.7.0 → 1.8.0 migration reads as the old radius ramp.
    falloff: p.falloff,
    ...(p.type === 'spot'
      ? { lightCone: p.cone ?? LIGHT_DEFAULTS.cone, lightConeFeather: p.coneFeather ?? LIGHT_DEFAULTS.coneFeather }
      : {}),
  }, kelvinToHex(p.kelvin));
}

/** The preset whose look the light has exactly, if any. */
function presetInForce(type: LightType, intensity: number, falloff: LightFalloff, color: string): LightPreset | undefined {
  const hex = color.trim().toLowerCase();
  return LIGHT_PRESETS.find((p) => p.type === type && p.intensity === intensity && p.falloff === falloff && kelvinToHex(p.kelvin) === hex);
}

/**
 * "Light Presets ▸" in the Properties ≡ menu — Light Options' `menu` in the
 * section registry (see sectionMenu.tsx). One pick sets type, energy, colour
 * and shaping as ONE undoable edit; the look in force is ticked. Draws
 * nothing.
 */
export function LightPresetsMenu({ nodeId }: { nodeId: string; nodeIds?: ReadonlyArray<string> }): null {
  const [typeRaw] = useComponentProp(nodeId, TRANSFORM, 'lightType');
  const [intensityRaw] = useComponentProp(nodeId, TRANSFORM, 'intensity');
  const [falloffRaw] = useComponentProp(nodeId, TRANSFORM, 'falloff');
  const [fillRaw] = useComponentProp(nodeId, STYLE, 'fill');
  const active = presetInForce(
    coerceLightType(typeRaw),
    num(intensityRaw, LIGHT_DEFAULTS.intensity),
    coerceFalloff(falloffRaw),
    typeof fillRaw === 'string' ? fillRaw : DEFAULT_COLOR,
  );
  useSectionMenuRows([{
    type: 'item',
    id: 'light-presets',
    label: 'Light Presets',
    submenu: LIGHT_PRESETS.map((p): DropdownItem => ({
      type: 'item',
      id: `light-preset-${p.label}`,
      label: p.label,
      ...(p === active ? { icon: 'check' as const } : {}),
      onSelect: () => applyLightPreset(nodeId, p),
    })),
  }]);
  return null;
}

export function LightSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  // The layer's header and the active comp from the document mirror (B4).
  const layer = useMirrorLayer(nodeId);
  const compLayers = useActiveCompLayers();
  const [intensityRaw, setIntensity] = useComponentProp(nodeId, TRANSFORM, 'intensity');
  const [radiusRaw, setRadius] = useComponentProp(nodeId, TRANSFORM, 'radius');
  const [typeRaw] = useComponentProp(nodeId, TRANSFORM, 'lightType');
  const [angleRaw, setAngle] = useComponentProp(nodeId, TRANSFORM, 'lightAngle');
  const [coneRaw, setCone] = useComponentProp(nodeId, TRANSFORM, 'lightCone');
  const [fillRaw, setFill] = useComponentProp(nodeId, STYLE, 'fill');
  const [shadowsRaw, setShadows] = useComponentProp(nodeId, TRANSFORM, 'castShadows');
  const [glowRaw, setGlow] = useComponentProp(nodeId, TRANSFORM, 'lightGlow');
  const [featherRaw, setFeather] = useComponentProp(nodeId, TRANSFORM, 'lightConeFeather');
  const [falloffRaw, setFalloff] = useComponentProp(nodeId, TRANSFORM, 'falloff');
  const [falloffDistRaw, setFalloffDist] = useComponentProp(nodeId, TRANSFORM, 'falloffDistance');
  const [darknessRaw, setDarkness] = useComponentProp(nodeId, TRANSFORM, 'shadowDarkness');
  const [diffusionRaw, setDiffusion] = useComponentProp(nodeId, TRANSFORM, 'shadowDiffusion');
  const [mapSizeRaw, setMapSize] = useComponentProp(nodeId, TRANSFORM, 'shadowMapSize');
  const [shadowBiasRaw, setShadowBias] = useComponentProp(nodeId, TRANSFORM, 'shadowBias');
  const [shadowSoftRaw, setShadowSoft] = useComponentProp(nodeId, TRANSFORM, 'shadowSoftness');
  // Whether the light is targeted: AE's Orient Towards Point of Interest, the
  // engine's own answer (true while a POI is STORED). Not "is poiX a number" —
  // the mirror lists an untargeted light's Point of Interest as a latent
  // property reading 0, so that test said every light was targeted and
  // "Add Target" could never be reached. The Point of Interest row reads and
  // writes its three fields itself.
  const orientInfo = useMirrorProperty(nodeId, POI_PATH);
  const [envPresetRaw, setEnvPreset] = useComponentProp(nodeId, TRANSFORM, 'envPreset');
  const [envRotationRaw, setEnvRotation] = useComponentProp(nodeId, TRANSFORM, 'envRotation');
  const [envReflRaw, setEnvRefl] = useComponentProp(nodeId, TRANSFORM, 'envReflections');
  // AE parity 4.4: the visible sky, its blur, and a live layer source.
  const [envVisibleRaw, setEnvVisible] = useComponentProp(nodeId, TRANSFORM, 'envVisible');
  const [envSkyBlurRaw, setEnvSkyBlur] = useComponentProp(nodeId, TRANSFORM, 'envSkyBlur');
  const [envLayerRaw, setEnvLayer] = useComponentProp(nodeId, TRANSFORM, 'envLayer');
  // The library, for the "Image…" sky. Selected as the whole array (a filtered
  // one would be a fresh reference on every store read, which re-renders
  // forever) and narrowed in a memo — the same shape the other asset rows use.
  // B4: the project's still images (`ItemInfo.mediaType`).
  const imageAssets = useMirrorFootage('image');
  /**
   * The asset id this light's sky names, or null when it names a preset.
   *
   * Kicking the decode from HERE as well as from the renderer is not
   * redundancy: picking an image has to project it NOW, and the renderer's own
   * kick only happens on a frame that reads this light.
   */
  const envAssetId = environmentSkyAssetId(envPresetRaw);
  useEffect(() => {
    // Engine-side until D5: the renderer's environment-SH cache (a decode of the asset's pixels), not the document.
    if (envAssetId) void ensureEnvironmentSh(envAssetId);
  }, [envAssetId]);
  if (!layer) return null;

  const intensity = num(intensityRaw, LIGHT_DEFAULTS.intensity);
  const radius = num(radiusRaw, LIGHT_DEFAULTS.radius);
  const color = typeof fillRaw === 'string' ? fillRaw : DEFAULT_COLOR;
  const type = coerceLightType(typeRaw);
  const angle = num(angleRaw, LIGHT_DEFAULTS.angle);
  const cone = num(coneRaw, LIGHT_DEFAULTS.cone);
  const feather = num(featherRaw, LIGHT_DEFAULTS.coneFeather);
  const falloff = coerceFalloff(falloffRaw);
  const falloffDistance = num(falloffDistRaw, LIGHT_DEFAULTS.falloffDistance);
  const darkness = num(darknessRaw, LIGHT_DEFAULTS.shadowDarkness);
  const diffusion = num(diffusionRaw, LIGHT_DEFAULTS.shadowDiffusion);
  const castsShadows = shadowsRaw === true || shadowsRaw === 1;
  const hasGlow = glowRaw === true || glowRaw === 1;
  const mapSize = num(mapSizeRaw, LIGHT_DEFAULTS.shadowMapSize);
  const shadowBias = num(shadowBiasRaw, LIGHT_DEFAULTS.shadowBias);
  const shadowSoftness = num(shadowSoftRaw, LIGHT_DEFAULTS.shadowSoftness);
  const envSky: EnvironmentSky = isEnvironmentSky(envPresetRaw) ? envPresetRaw : DEFAULT_ENVIRONMENT_PRESET;
  /** The Sky menu's value: a preset id, or the one "Image…" entry. */
  const skyMenuValue = envAssetId === null ? envSky : 'image';
  // An id the library no longer holds. Offered back as an explicit "(missing)"
  // entry rather than silently reset, because a sky that vanishes without a
  // trace is a property the user cannot fix.
  const envAssetMissing = !!envAssetId && !imageAssets.some((a) => a.id === envAssetId);
  const envRotation = num(envRotationRaw, 0);
  const envReflections = num(envReflRaw, LIGHT_DEFAULTS.envReflections);
  const envVisible = envVisibleRaw === true;
  const envSkyBlur = num(envSkyBlurRaw, 0);
  const envLayer = typeof envLayerRaw === 'string' ? envLayerRaw : '';
  // Layers that can drive the environment live: footage and compositions (equirectangular).
  const envLayerChoices = compLayers.filter((l) => {
    const k = uiKindOf(l);
    return l.id !== nodeId && (k === 'video' || k === 'image' || k === 'comp');
  });
  // A light is "targeted" (aimed in 3D) as soon as any POI component is stored
  // — the test readNodeLight applies, as the engine reports it.
  const orient = orientInfo?.value;
  const hasPOI = orient?.kind === 'bool' && orient.value;

  const isEnv = type === 'environment';
  /** point / spot / parallel — the lights that sit somewhere and cast. */
  const positional = !isEnv && type !== 'ambient';
  const aimable = type === 'spot' || type === 'parallel';
  /** The lights the engine attenuates with distance (see the module note). */
  const hasFalloff = type === 'point' || type === 'spot';
  const showRadius = hasFalloff && (falloff !== 'none' || hasGlow);
  const showGlow = type === 'point' || type === 'spot' || (hasGlow && !isEnv);

  // The engine shades with at most MAX_LIGHTS3D lights per draw (`kMaxLights`,
  // native/engine/src/render_graph/threed.cpp); extra scene lights are silently
  // dropped by layer order. Silent is the problem — say so where lights are
  // edited. Counted from the document mirror (visible light layers in the
  // active comp), so this adds no per-frame work.
  // (An environment light expands into an ambient + up-to-six-parallel rig, so
  // the true uploaded count can be higher still — the count here is the floor.)
  const lightLayerCount = compLayers
    .filter((l) => uiKindOf(l) === 'light' && l.switches.visible).length;

  return (
    <div className={styles.section}>
      <div className={styles.inlineRows}>
        {lightLayerCount > MAX_LIGHTS3D && (
          <p className={styles.helpWarning} role="note">
            {`Only the first ${MAX_LIGHTS3D} lights in layer order shade 3D layers — this comp has ${lightLayerCount}.`}
          </p>
        )}
        <div className={styles.popoverRow}>
          <span className={styles.popoverLabel}>Light Type</span>
          <select
            className={cn(styles.select, styles.rowSelect)}
            value={type}
            onChange={(e) => {
              const next = coerceLightType(e.target.value);
              // One menu pick = one undo step, even though becoming an
              // environment light writes three props. Switching TO environment
              // has to land on a real sky: `envPreset` is what selects the SH
              // probe, and an undefined one would leave the light silently
              // reading the fallback with a menu that could not show which
              // preset was in force.
              sendLightLook(nodeId, 'Set Light Type', {
                lightType: next,
                // The mirror reads an unset sky / rotation as its default, so
                // the shown values are written, not only a missing one.
                ...(next === 'environment'
                  ? {
                      envPreset: isEnvironmentSky(envPresetRaw) ? envPresetRaw : DEFAULT_ENVIRONMENT_PRESET,
                      envRotation: typeof envRotationRaw === 'number' ? envRotationRaw : 0,
                    }
                  : {}),
              });
            }}
            aria-label="Light Type"
          >
            <option value="parallel">Parallel</option>
            <option value="spot">Spot</option>
            <option value="point">Point</option>
            <option value="ambient">Ambient</option>
            <option value="environment">Environment</option>
          </select>
        </div>
        {isEnv && (
          <>
            <div className={styles.popoverRow}>
              <span className={styles.popoverLabel}>Sky</span>
              <select
                className={cn(styles.select, styles.rowSelect)}
                value={skyMenuValue}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === 'image') {
                    // "Image…" opens the picker row below. Landing on the first
                    // image in the library saves a second pick in the common
                    // case; an empty library leaves the sky as "image, nothing
                    // chosen yet" — a real state the row below then asks about,
                    // rather than the menu silently snapping back to a preset.
                    setEnvPreset(environmentSkyForAsset(imageAssets[0]?.id ?? ''));
                  } else if (isEnvironmentPresetId(v)) {
                    setEnvPreset(v);
                  }
                }}
                aria-label="Environment preset"
              >
                {ENVIRONMENT_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
                <option value="image">Image…</option>
              </select>
            </div>
            {envAssetId !== null && (
              <div className={styles.popoverRow}>
                <span className={styles.popoverLabel}>Image</span>
                <select
                  className={cn(styles.select, styles.rowSelect)}
                  value={envAssetId}
                  onChange={(e) => setEnvPreset(environmentSkyForAsset(e.target.value))}
                  aria-label="Environment image"
                  title="An equirectangular (2:1 lat-long) image or HDRI. An imported EXR is projected from its LINEAR float planes; an 8-bit file is linearised from sRGB first."
                >
                  <option value="">Choose an image…</option>
                  {envAssetMissing && <option value={envAssetId}>{`${envAssetId} (missing)`}</option>}
                  {imageAssets.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              </div>
            )}
          </>
        )}
        {!isEnv && (
          <>
            <div className={styles.popoverRow}>
              <span className={styles.popoverLabel}>Color</span>
              <ColorPicker value={color} onChange={(hex) => setFill(hex)} aria-label="Light color" />
            </div>
            <div className={styles.popoverRow}>
              <span className={styles.popoverLabel}>Color Temperature</span>
              <ValueField
                value={nearestKelvin(color)}
                min={KELVIN_MIN}
                max={KELVIN_MAX}
                step={100}
                unit="K"
                onChange={(v) => setFill(kelvinToHex(v))}
                aria-label="Color Temperature"
              />
            </div>
          </>
        )}
        <KfRow nodeId={nodeId} prop="intensity" label="Intensity" value={intensity} unit="%" min={0} onStatic={(v) => setIntensity(v)} />
        {isEnv && (
          <>
            <KfRow
              nodeId={nodeId}
              prop="envRotation"
              label="Sky Rotation"
              value={envRotation}
              unit="°"
              onStatic={(v) => setEnvRotation(v)}
            />
            {/*
              Reflections: the strength of the environment's MIRRORED half — the
              prefiltered specular map a Physical material reflects — as distinct
              from Intensity, which drives the irradiance rig that lights it. 100
              is physically matched to Intensity, so the row only ever pulls the
              reflection away from the light, never invents one; it stores nothing
              at the default, and a scene that never opens it is unchanged.
            */}
            <KfRow
              nodeId={nodeId}
              prop="envReflections"
              label="Reflections"
              value={envReflections}
              unit="%"
              min={0}
              onStatic={(v) => setEnvRefl(v !== LIGHT_DEFAULTS.envReflections ? v : undefined)}
            />
            <OnOffRow
              label="Show Environment"
              on={envVisible}
              onToggle={() => setEnvVisible(!envVisible)}
              title="Draw the sky behind every layer of the composition, rotated with this light"
            />
            {envVisible && (
              <div className={styles.popoverRow}>
                <span className={styles.popoverLabel}>Background Blur</span>
                <ValueField
                  value={envSkyBlur}
                  min={0}
                  max={100}
                  step={1}
                  unit="%"
                  onChange={(v) => setEnvSkyBlur(v > 0 ? v : undefined)}
                  aria-label="Environment background blur"
                />
              </div>
            )}
            <div className={styles.popoverRow}>
              <span className={styles.popoverLabel}>Source Layer</span>
              <select
                className={cn(styles.select, styles.rowSelect)}
                value={envLayer}
                onChange={(e) => setEnvLayer(e.target.value || undefined)}
                aria-label="Environment source layer"
                title="A composition or footage layer (equirectangular) that drives the environment's reflections and sky live, frame by frame. Set its Opacity to 0 to hide it; a hidden layer renders nothing."
              >
                <option value="">Sky image (above)</option>
                {envLayerChoices.map((l) => (
                  <option key={l.id} value={l.id}>{l.name || l.id}</option>
                ))}
                {envLayer && !envLayerChoices.some((l) => l.id === envLayer) ? (
                  <option value={envLayer}>(missing layer)</option>
                ) : null}
              </select>
            </div>
            <OnOffRow
              label="Casts Shadows"
              on={castsShadows}
              onToggle={() => setShadows(!castsShadows)}
              title="The environment's brightest direction casts a soft shadow map (the sky's key light)"
            />
            {castsShadows && (
              <>
                <KfRow nodeId={nodeId} prop="shadowDarkness" label="Shadow Darkness" value={darkness} unit="%" min={0} max={100} onStatic={(v) => setDarkness(v)} />
                <KfRow nodeId={nodeId} prop="shadowSoftness" label="Shadow Softness" value={shadowSoftness} unit="tx" min={0} onStatic={(v) => setShadowSoft(v)} />
              </>
            )}
          </>
        )}
        {type === 'spot' && (
          <>
            <KfRow nodeId={nodeId} prop="lightCone" label="Cone Angle" value={cone} unit="°" min={1} onStatic={(v) => setCone(v)} />
            <KfRow
              nodeId={nodeId}
              prop="lightConeFeather"
              label="Cone Feather"
              value={feather}
              unit="%"
              min={0}
              max={100}
              onStatic={(v) => setFeather(v)}
            />
          </>
        )}
        {hasFalloff && (
          <>
            <div className={styles.popoverRow}>
              <span className={styles.popoverLabel}>Falloff</span>
              <select
                className={cn(styles.select, styles.rowSelect)}
                value={falloff}
                onChange={(e) => setFalloff(e.target.value)}
                aria-label="Falloff"
              >
                <option value="none">None</option>
                <option value="smooth">Smooth</option>
                <option value="inverse-square">Inverse Square Clamped</option>
                <option value="legacy">Radius ramp (legacy)</option>
              </select>
            </div>
            {showRadius && (
              <KfRow nodeId={nodeId} prop="radius" label="Radius" value={radius} unit="px" min={1} onStatic={(v) => setRadius(v)} />
            )}
            {falloff === 'smooth' && (
              <KfRow
                nodeId={nodeId}
                prop="falloffDistance"
                label="Falloff Distance"
                value={falloffDistance}
                unit="px"
                min={1}
                onStatic={(v) => setFalloffDist(v)}
              />
            )}
          </>
        )}
        {positional && (
          <>
            <OnOffRow
              label="Casts Shadows"
              on={castsShadows}
              onToggle={() => setShadows(!castsShadows)}
              title="Content layers drop a soft shadow away from this light"
            />
            {castsShadows && (
              <>
                <KfRow nodeId={nodeId} prop="shadowDarkness" label="Shadow Darkness" value={darkness} unit="%" min={0} max={100} onStatic={(v) => setDarkness(v)} />
                <KfRow nodeId={nodeId} prop="shadowDiffusion" label="Shadow Diffusion" value={diffusion} unit="px" min={0} onStatic={(v) => setDiffusion(v)} />
                {/*
                  AE parity 4.3: every shadow-casting light renders a shadow MAP (up
                  to four per 3D run) — geometry-aware, landing on floors and any
                  surface at any angle, cast onto itself, across runs. Lights past
                  the fourth fall back to a projected copy of the caster's
                  silhouette, which Shadow Diffusion above still shapes.
                */}
                <TwirlGroup
                  prefKey="light.shadowMap"
                  label={<span title="Shadows are depth-mapped (up to four lights per 3D scene); further lights project a soft copy.">Shadow Map</span>}
                  defaultOpen={false}
                  summary={`${mapSize}`}
                >
                  <div className={styles.popoverRow}>
                    <span className={styles.popoverLabel}>Resolution</span>
                    <select
                      className={cn(styles.select, styles.rowSelect)}
                      value={String(mapSize)}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        setMapSize(v === LIGHT_DEFAULTS.shadowMapSize ? undefined : v);
                      }}
                      aria-label="Shadow Map Resolution"
                    >
                      <option value="512">512</option>
                      <option value="1024">1024</option>
                      <option value="2048">2048</option>
                    </select>
                  </div>
                  {/* Bias trades the two failures against each other: too little
                      and a lit surface stripes itself with its own depth
                      quantization, too much and the shadow lifts off the foot of
                      its caster. Both are visible, so this is a real control. */}
                  <KfRow nodeId={nodeId} prop="shadowBias" label="Shadow Bias" value={shadowBias} unit="px" min={0} onStatic={(v) => setShadowBias(v)} />
                  <KfRow nodeId={nodeId} prop="shadowSoftness" label="Map Softness" value={shadowSoftness} unit="tx" min={0} onStatic={(v) => setShadowSoft(v)} />
                </TwirlGroup>
              </>
            )}
          </>
        )}
        {aimable && hasPOI && (
          <>
            <MultiPropertyPairRow nodeId={nodeId} label="Point of Interest" props={POI_FIELDS} />
            <div className={styles.actionRow}>
              <Button
                size="sm"
                variant="secondary"
                title="Remove the target and aim this light by its Direction angle"
                // AE's Orient Towards Point of Interest off (`transform/orientTowardsPointOfInterest`).
                onClick={() => { void edit('Remove Point of Interest', { type: 'setProperty', prop: { layer: nodeId, path: POI_PATH }, value: values.bool(false) }); }}
              >
                Aim by Angle
              </Button>
            </div>
          </>
        )}
        {aimable && !hasPOI && (
          <>
            <KfRow nodeId={nodeId} prop="lightAngle" label="Direction" value={angle} unit="°" onStatic={(v) => setAngle(v)} />
            <div className={styles.actionRow}>
              <Button
                size="sm"
                variant="secondary"
                title="Direction can only swing this light within the comp plane — a target aims it at a point in 3D"
                // On: the target lands at the composition centre (w/2, h/2, 0).
                onClick={() => { void edit('Enable Point of Interest', { type: 'setProperty', prop: { layer: nodeId, path: POI_PATH }, value: values.bool(true) }); }}
              >
                Add Target
              </Button>
            </div>
          </>
        )}
        {showGlow && (
          <TwirlGroup prefKey="light.viewer" label="Viewer" defaultOpen={hasGlow} summary={hasGlow ? 'Glow On' : 'Glow Off'}>
            <OnOffRow
              label="Show Glow in Viewer"
              on={hasGlow}
              onToggle={() => setGlow(!hasGlow)}
              title="Also draw a soft bloom over the frame. It brightens everything beneath it, 2D layers included — leave off for lighting that only affects 3D layers"
            />
          </TwirlGroup>
        )}
      </div>
    </div>
  );
}

export default LightSection;
