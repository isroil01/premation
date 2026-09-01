/**
 * CameraSection — curated camera controls (AE's Camera Settings, simplified),
 * replacing the raw generic prop dump the camera inspector used to show.
 *
 * Position X/Y/Z live in the Transform section above; here we own the LENS:
 * a focal-length field plus familiar mm-style presets expressed as fields of
 * view. Focal length is in comp-space px (pinhole model — see Project3D).
 */

import { useMemo } from 'react';
import { useSceneRevision, bumpScene } from '@stores/sceneStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useNodeComponentProp } from '@hooks/useNodeComponentProp';
import { useCompositionStore } from '@stores/compositionStore';
import { Project3D } from '@motion/scene';
import { flattenComposition } from '@core/scene/sceneDerive';
import { activeCompRootId } from '@core/scene/activeComp';
import { is3DEnabled, set3DEnabled, canBe3D } from '@core/scene/threeD';
import { ValueField } from '@components/ValueField';
import { Button } from '@components/Button';
import styles from './TransformSection.module.css';
import { KeyframeRow } from './KeyframeRow';

/** AE's default virtual sensor width (35mm full frame). */
const DEFAULT_FILM_SIZE_MM = 36;

/** Classic lens presets → horizontal field of view (deg). */
const LENS_PRESETS: Array<{ label: string; fov: number }> = [
  { label: '15mm — Ultra Wide', fov: 100 },
  { label: '24mm — Wide', fov: 73 },
  { label: '35mm — Reportage', fov: 54 },
  { label: '50mm — Standard', fov: 39.6 },
  { label: '80mm — Portrait', fov: 25 },
  { label: '135mm — Tele', fov: 15 },
];

export function CameraSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  const compWidth = useCompositionStore((s) => s.width);
  const node = defaultSceneGraph.getNode(nodeId);
  const tComp = useMemo(() => node?.components.find((c) => c.type === 'Transform'), [node]);
  const [focalRaw, setFocal] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'focalLength');
  const [filmSizeRaw, setFilmSize] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'filmSize');
  const [yawRaw, setYaw] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'orbitYaw');
  const [pitchRaw, setPitch] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'orbitPitch');
  const [rollRaw, setRoll] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'orientationZ');
  const [oriXRaw, setOriX] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'orientationX');
  const [oriYRaw, setOriY] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'orientationY');
  const [dofRaw, setDofStrength] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'dofStrength');
  const [focusRaw, setFocusDistance] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'focusDistance');
  const [apertureRaw, setAperture] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'dofAperture');
  const [fStopRaw, setFStop] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'fStop');
  const [irisBladesRaw, setIrisBlades] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'irisBlades');
  const [irisRoundnessRaw, setIrisRoundness] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'irisRoundness');
  const [highlightGainRaw, setHighlightGain] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'highlightGain');
  const [poiXRaw, setPoiX] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'poiX');
  const [poiYRaw, setPoiY] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'poiY');
  const [poiZRaw, setPoiZ] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'poiZ');
  const [, setX] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'x');
  const [, setY] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'y');
  const [, setZ] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'z');
  const compHeight = useCompositionStore((s) => s.height);
  if (!node || !tComp) return null;

  const defaultFocal = Project3D.focalLengthForFov(compWidth, 39.6);
  const focal = typeof focalRaw === 'number' && focalRaw > 0 ? focalRaw : defaultFocal;
  const fovDeg = Project3D.fovForFocalLength(compWidth, focal);
  // AE's Film Size is the virtual sensor width; the millimetre focal length is
  // derived from it and the angle of view. Changing it re-labels the lens
  // without touching what the camera actually sees, which is exactly what a
  // real sensor swap does.
  const filmSize = typeof filmSizeRaw === 'number' && filmSizeRaw > 0 ? filmSizeRaw : DEFAULT_FILM_SIZE_MM;
  const focalMm = filmSize / (2 * Math.tan((fovDeg * Math.PI) / 360));
  // Which preset (if any) matches the current field of view.
  const activePreset = LENS_PRESETS.find((p) => Math.abs(p.fov - fovDeg) < 1.5)?.label ?? '';

  // The #1 "camera does nothing" trap: it only moves layers whose 3D switch
  // is ON. Show the live count and offer the one-click fix right here.
  // canBe3D = the shared "renderer can actually project this in 3D" predicate
  // — it also excludes solids/particles, which the old kind list let through
  // ("Make all 3D" lit switches that changed no pixel on those).
  // Scoped to the ACTIVE comp, not the scene. Comps are separate root subtrees,
  // so `flattenScene` here meant one click flipped the 3D switch on layers in
  // every other composition too — a persisted write (writeProp + autosave) that
  // no render-path fix undoes. Worse for solids: set3DEnabled seeds their
  // placement from the ACTIVE comp's dimensions, so a solid in a comp of a
  // different size was repositioned and resized as well.
  const contentLayers = flattenComposition(defaultSceneGraph, activeCompRootId()).filter((n) => canBe3D(n));
  const threeDCount = contentLayers.filter((n) => is3DEnabled(n)).length;
  const enableAll3D = (): void => {
    for (const n of contentLayers) set3DEnabled(n.id, true);
    bumpScene();
  };

  return (
    <div className={styles.section}>
      <h4 className={styles.title}>Lens</h4>
      <div className={styles.inlineRows}>
        <div className={styles.popoverRow}>
          <span className={styles.popoverLabel}>Preset</span>
          <select
            className={styles.select}
            style={{ width: 150 }}
            value={activePreset}
            onChange={(e) => {
              const preset = LENS_PRESETS.find((p) => p.label === e.target.value);
              if (preset) setFocal(Math.round(Project3D.focalLengthForFov(compWidth, preset.fov)));
            }}
            aria-label="Lens preset"
          >
            {activePreset === '' && <option value="">Custom</option>}
            {LENS_PRESETS.map((p) => (
              <option key={p.label} value={p.label}>{p.label}</option>
            ))}
          </select>
        </div>
        {/* AE calls this Zoom: the distance at which a layer renders 1:1. It
            and Angle of View are two views of ONE value, so editing either has
            to move the other — showing the angle as read-only text (which is
            what this was) makes it look like a separate, broken control. */}
        <KeyframeRow nodeId={nodeId} prop="focalLength" label="Zoom" value={focal} unit="px" min={50} onStatic={(v) => setFocal(v)} />
        <div className={styles.popoverRow}>
          <span className={styles.popoverLabel}>Angle of view</span>
          <ValueField
            value={Number(fovDeg.toFixed(2))}
            min={1}
            max={179}
            step={0.5}
            unit="°"
            onChange={(v) => setFocal(Math.round(Project3D.focalLengthForFov(compWidth, v)))}
            aria-label="Angle of view"
          />
        </div>
        <div className={styles.popoverRow}>
          <span className={styles.popoverLabel}>Film size</span>
          <ValueField
            value={filmSize}
            min={1}
            step={1}
            unit="mm"
            onChange={(v) => setFilmSize(v !== DEFAULT_FILM_SIZE_MM ? v : undefined)}
            aria-label="Film size"
          />
        </div>
        <div className={styles.popoverRow}>
          <span className={styles.popoverLabel}>Focal length</span>
          <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
            {focalMm.toFixed(1)} mm
          </span>
        </div>
        <p style={{ margin: '2px 0 0', fontSize: 'var(--font-size-micro)', color: 'var(--color-text-tertiary)', lineHeight: 1.5 }}>
          Film size is the virtual sensor width. It changes the millimetre
          reading only — the actual view is set by Zoom / Angle of View.
        </p>
        <div className={styles.subhead} style={{ marginTop: 8 }}>Orbit</div>
        <KeyframeRow nodeId={nodeId} prop="orbitYaw" label="Yaw" value={typeof yawRaw === 'number' ? yawRaw : 0} unit="°" min={-180} max={180} onStatic={(v) => setYaw(v)} />
        <KeyframeRow nodeId={nodeId} prop="orbitPitch" label="Pitch" value={typeof pitchRaw === 'number' ? pitchRaw : 0} unit="°" min={-89} max={89} onStatic={(v) => setPitch(v)} />
        <p style={{ margin: '2px 0 0', fontSize: 'var(--font-size-micro)', color: 'var(--color-text-tertiary)', lineHeight: 1.5 }}>
          Swings the camera around its point of interest, keeping it framed.
          On canvas: Alt+drag orbits, Shift+Alt+drag (or Alt+middle-drag)
          tracks XY, Alt+wheel dollies. Tick a stopwatch to keyframe any of these.
        </p>

        {/* IN-PLACE rotation, kept in its own group and NOT mixed in with Orbit
            above: the two look alike and do opposite things. Orbit moves the eye
            along an arc around the target; these turn the camera where it
            stands. Conflating them is what made a tripod pan unexpressible. */}
        <div className={styles.subhead} style={{ marginTop: 8 }}>Rotation (in place)</div>
        <KeyframeRow nodeId={nodeId} prop="orientationX" label="X Rotation" value={typeof oriXRaw === 'number' ? oriXRaw : 0} unit="°" min={-180} max={180} onStatic={(v) => setOriX(v)} />
        <KeyframeRow nodeId={nodeId} prop="orientationY" label="Y Rotation" value={typeof oriYRaw === 'number' ? oriYRaw : 0} unit="°" min={-180} max={180} onStatic={(v) => setOriY(v)} />
        {/* Roll spins the frame about the view axis (a dutch angle) without
            re-aiming the camera — the third orientation axis, which the yaw +
            pitch pair alone could not express. */}
        <KeyframeRow nodeId={nodeId} prop="orientationZ" label="Z Rotation (roll)" value={typeof rollRaw === 'number' ? rollRaw : 0} unit="°" min={-180} max={180} onStatic={(v) => setRoll(v)} />
        <p style={{ margin: '2px 0 0', fontSize: 'var(--font-size-micro)', color: 'var(--color-text-tertiary)', lineHeight: 1.5 }}>
          Turns the camera on the spot without moving it — a tripod pan or tilt.
          On a targeted camera these offset the tracked aim, so it keeps
          following its Point of Interest while looking off to the side.
        </p>

        <div className={styles.subhead} style={{ marginTop: 8 }}>Point of Interest</div>
        {(() => {
          const hasPOI = [poiXRaw, poiYRaw, poiZRaw].some((v) => typeof v === 'number');
          if (!hasPOI) {
            return (
              <>
                <div className={styles.popoverRow}>
                  <Button
                    size="xs"
                    variant="secondary"
                    onClick={() => {
                      // Enable a two-node camera aimed at the comp centre; from
                      // here the camera always LOOKS AT this target.
                      setPoiX(compWidth / 2);
                      setPoiY(compHeight / 2);
                      setPoiZ(0);
                    }}
                  >
                    Enable target (two-node camera)
                  </Button>
                </div>
                <p style={{ margin: '2px 0 0', fontSize: 'var(--font-size-micro)', color: 'var(--color-text-tertiary)', lineHeight: 1.5 }}>
                  A two-node camera always aims at a Point of Interest — move the
                  camera and it re-frames the target. Keyframe the POI to lead a
                  shot across the scene.
                </p>
              </>
            );
          }
          return (
            <>
              <KeyframeRow nodeId={nodeId} prop="poiX" label="Target X" value={typeof poiXRaw === 'number' ? poiXRaw : compWidth / 2} unit="px" onStatic={(v) => setPoiX(v)} />
              <KeyframeRow nodeId={nodeId} prop="poiY" label="Target Y" value={typeof poiYRaw === 'number' ? poiYRaw : compHeight / 2} unit="px" onStatic={(v) => setPoiY(v)} />
              <KeyframeRow nodeId={nodeId} prop="poiZ" label="Target Z" value={typeof poiZRaw === 'number' ? poiZRaw : 0} unit="px" onStatic={(v) => setPoiZ(v)} />
              <div className={styles.popoverRow} style={{ marginTop: 2 }}>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    // Back to a one-node (free) camera: drop the POI props.
                    setPoiX(undefined);
                    setPoiY(undefined);
                    setPoiZ(undefined);
                  }}
                >
                  Remove target (free camera)
                </Button>
              </div>
            </>
          );
        })()}

        <div className={styles.subhead} style={{ marginTop: 8 }}>Depth of field</div>
        <KeyframeRow nodeId={nodeId} prop="dofStrength" label="Blur strength" value={typeof dofRaw === 'number' ? dofRaw : 0} unit="px" min={0} max={60} onStatic={(v) => setDofStrength(v)} />
        {typeof dofRaw === 'number' && dofRaw > 0 && (
          <>
            <KeyframeRow nodeId={nodeId} prop="focusDistance" label="Focus distance" value={typeof focusRaw === 'number' ? focusRaw : focal} unit="px" min={1} onStatic={(v) => setFocusDistance(v)} />
            <KeyframeRow nodeId={nodeId} prop="dofAperture" label="Aperture" value={typeof apertureRaw === 'number' ? apertureRaw : (typeof dofRaw === 'number' ? dofRaw : 0)} unit="px" min={0} onStatic={(v) => setAperture(v)} />
            {/*
              F-Stop selects the lens model. Absent or 0 keeps the legacy
              symmetric ramp above — what every existing project uses, and what
              it must keep looking like. Set it and `dofBlurPx` switches to a
              real thin-lens circle of confusion: asymmetric, saturating behind
              the focal plane, and sensitive to focal length. Deliberately NOT
              given a numeric default, because a default would re-grade every
              shot anyone has already approved.
            */}
            <KeyframeRow nodeId={nodeId} prop="fStop" label="F-Stop (physical lens)" value={typeof fStopRaw === 'number' ? fStopRaw : 0} min={0} max={32} onStatic={(v) => setFStop(v)} />
            <p style={{ margin: '2px 0 6px', fontSize: 'var(--font-size-micro)', color: 'var(--color-text-tertiary)', lineHeight: 1.5 }}>
              {typeof fStopRaw === 'number' && fStopRaw > 0
                ? 'Thin-lens defocus: the foreground blurs harder than the background, distant layers stop getting blurrier, and focal length now affects depth of field.'
                : 'Leave at 0 for the classic ramp — symmetric, and it ignores focal length. Set an f-number for physical lens defocus.'}
            </p>
            <KeyframeRow
              nodeId={nodeId}
              prop="irisBlades"
              label="Iris blades"
              value={typeof irisBladesRaw === 'number' ? irisBladesRaw : 0}
              min={0}
              max={11}
              onStatic={(v) => setIrisBlades(v < 3 ? undefined : Math.round(v))}
            />
            {typeof irisBladesRaw === 'number' && irisBladesRaw >= 3 && (
              <>
                <KeyframeRow
                  nodeId={nodeId}
                  prop="irisRoundness"
                  label="Iris roundness"
                  value={typeof irisRoundnessRaw === 'number' ? irisRoundnessRaw : 0.65}
                  min={0}
                  max={1}
                  onStatic={(v) => setIrisRoundness(v)}
                />
                <KeyframeRow
                  nodeId={nodeId}
                  prop="highlightGain"
                  label="Highlight gain"
                  value={typeof highlightGainRaw === 'number' ? highlightGainRaw : 0}
                  min={0}
                  max={4}
                  onStatic={(v) => setHighlightGain(v <= 0 ? undefined : v)}
                />
                <p style={{ margin: '2px 0 6px', fontSize: 'var(--font-size-micro)', color: 'var(--color-text-tertiary)', lineHeight: 1.5 }}>
                  Polygonal bokeh (5–11 blades). Roundness 1 ≈ circle; highlight gain blooms speculars in the defocus.
                </p>
              </>
            )}
            {!(typeof irisBladesRaw === 'number' && irisBladesRaw >= 3) && (
              <p style={{ margin: '2px 0 6px', fontSize: 'var(--font-size-micro)', color: 'var(--color-text-tertiary)', lineHeight: 1.5 }}>
                Leave blades at 0 for a Gaussian blur. Set 5–11 for an iris-shaped bokeh.
              </p>
            )}
          </>
        )}

        <div className={styles.popoverRow} style={{ marginTop: 4 }}>
          <span className={styles.popoverLabel}>View</span>
          <Button
            size="xs"
            variant="secondary"
            onClick={() => {
              // Back to the default framing: comp centre, pulled back by the
              // focal length so the comp plane renders exactly 1:1, no orbit.
              setX(compWidth / 2);
              setY(compHeight / 2);
              setZ(-Math.round(focal));
              setYaw(0);
              setPitch(0);
            }}
          >
            Reset camera
          </Button>
        </div>

        <div className={styles.subhead} style={{ marginTop: 8 }}>3D layers</div>
        <div className={styles.popoverRow}>
          <span
            className={styles.popoverLabel}
            style={threeDCount === 0 ? { color: 'var(--color-warning, #f5b84b)' } : undefined}
          >
            {threeDCount === 0
              ? 'No 3D layers — the camera moves nothing yet'
              : `${threeDCount} of ${contentLayers.length} layers are 3D`}
          </span>
          {threeDCount < contentLayers.length && contentLayers.length > 0 && (
            <Button size="xs" variant="primary" onClick={enableAll3D} style={{ whiteSpace: 'nowrap' }}>
              Make all 3D
            </Button>
          )}
        </div>
        <p style={{ margin: '6px 0 0', fontSize: 'var(--font-size-micro)', color: 'var(--color-text-tertiary)', lineHeight: 1.5 }}>
          The camera moves layers with the 3D switch enabled (also per-layer in
          the timeline's switch column). Position and Z live in Transform above;
          shorter focal length = wider, more dramatic perspective.
        </p>
      </div>
    </div>
  );
}

export default CameraSection;
