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
import { flattenScene } from '@core/scene/sceneDerive';
import { is3DEnabled, set3DEnabled, canBe3D } from '@core/scene/threeD';
import styles from './TransformSection.module.css';
import { KeyframeRow } from './KeyframeRow';

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
  const [yawRaw, setYaw] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'orbitYaw');
  const [pitchRaw, setPitch] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'orbitPitch');
  const [dofRaw, setDofStrength] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'dofStrength');
  const [focusRaw, setFocusDistance] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'focusDistance');
  const [apertureRaw, setAperture] = useNodeComponentProp(defaultSceneGraph, nodeId, tComp?.id, 'dofAperture');
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
  const fovDeg = (2 * Math.atan(compWidth / 2 / focal) * 180) / Math.PI;
  // Which preset (if any) matches the current field of view.
  const activePreset = LENS_PRESETS.find((p) => Math.abs(p.fov - fovDeg) < 1.5)?.label ?? '';

  // The #1 "camera does nothing" trap: it only moves layers whose 3D switch
  // is ON. Show the live count and offer the one-click fix right here.
  // canBe3D = the shared "renderer can actually project this in 3D" predicate
  // — it also excludes solids/particles, which the old kind list let through
  // ("Make all 3D" lit switches that changed no pixel on those).
  const contentLayers = flattenScene(defaultSceneGraph).filter((n) => canBe3D(n));
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
        <KeyframeRow nodeId={nodeId} prop="focalLength" label="Focal length" value={focal} unit="px" min={50} onStatic={(v) => setFocal(v)} />
        <div className={styles.popoverRow}>
          <span className={styles.popoverLabel}>Field of view</span>
          <span style={{ fontSize: 11, color: 'var(--color-text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
            {fovDeg.toFixed(1)}°
          </span>
        </div>
        <div className={styles.subhead} style={{ marginTop: 8 }}>Orbit</div>
        <KeyframeRow nodeId={nodeId} prop="orbitYaw" label="Yaw" value={typeof yawRaw === 'number' ? yawRaw : 0} unit="°" min={-180} max={180} onStatic={(v) => setYaw(v)} />
        <KeyframeRow nodeId={nodeId} prop="orbitPitch" label="Pitch" value={typeof pitchRaw === 'number' ? pitchRaw : 0} unit="°" min={-89} max={89} onStatic={(v) => setPitch(v)} />
        <p style={{ margin: '2px 0 0', fontSize: 10, color: 'var(--color-text-tertiary)', lineHeight: 1.5 }}>
          Swings the camera around its point of interest, keeping it framed.
          On canvas: Alt+drag orbits, Shift+Alt+drag (or Alt+middle-drag)
          tracks XY, Alt+wheel dollies. Tick a stopwatch to keyframe any of these.
        </p>

        <div className={styles.subhead} style={{ marginTop: 8 }}>Point of Interest</div>
        {(() => {
          const hasPOI = [poiXRaw, poiYRaw, poiZRaw].some((v) => typeof v === 'number');
          if (!hasPOI) {
            return (
              <>
                <div className={styles.popoverRow}>
                  <button
                    type="button"
                    onClick={() => {
                      // Enable a two-node camera aimed at the comp centre; from
                      // here the camera always LOOKS AT this target.
                      setPoiX(compWidth / 2);
                      setPoiY(compHeight / 2);
                      setPoiZ(0);
                    }}
                    style={{ height: 22, padding: '0 10px', fontSize: 10, fontWeight: 600, background: 'var(--color-surface-0)', color: 'var(--color-text-secondary)', border: '1px solid var(--color-border-subtle)', borderRadius: 3, cursor: 'pointer' }}
                  >
                    Enable target (two-node camera)
                  </button>
                </div>
                <p style={{ margin: '2px 0 0', fontSize: 10, color: 'var(--color-text-tertiary)', lineHeight: 1.5 }}>
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
                <button
                  type="button"
                  onClick={() => {
                    // Back to a one-node (free) camera: drop the POI props.
                    setPoiX(undefined);
                    setPoiY(undefined);
                    setPoiZ(undefined);
                  }}
                  style={{ height: 20, padding: '0 8px', fontSize: 10, background: 'var(--color-surface-0)', color: 'var(--color-text-tertiary)', border: '1px solid var(--color-border-subtle)', borderRadius: 3, cursor: 'pointer' }}
                >
                  Remove target (free camera)
                </button>
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
          </>
        )}

        <div className={styles.popoverRow} style={{ marginTop: 4 }}>
          <span className={styles.popoverLabel}>View</span>
          <button
            type="button"
            onClick={() => {
              // Back to the default framing: comp centre, pulled back by the
              // focal length so the comp plane renders exactly 1:1, no orbit.
              setX(compWidth / 2);
              setY(compHeight / 2);
              setZ(-Math.round(focal));
              setYaw(0);
              setPitch(0);
            }}
            style={{
              height: 22,
              padding: '0 10px',
              fontSize: 10,
              fontWeight: 600,
              background: 'var(--color-surface-0)',
              color: 'var(--color-text-secondary)',
              border: '1px solid var(--color-border-subtle)',
              borderRadius: 3,
              cursor: 'pointer',
            }}
          >
            Reset camera
          </button>
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
            <button
              type="button"
              onClick={enableAll3D}
              style={{
                height: 22,
                padding: '0 10px',
                fontSize: 10,
                fontWeight: 600,
                background: 'var(--color-primary-subtle)',
                color: 'var(--color-primary)',
                border: '1px solid var(--color-primary)',
                borderRadius: 3,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              Make all 3D
            </button>
          )}
        </div>
        <p style={{ margin: '6px 0 0', fontSize: 10, color: 'var(--color-text-tertiary)', lineHeight: 1.5 }}>
          The camera moves layers with the 3D switch enabled (also per-layer in
          the timeline's switch column). Position and Z live in Transform above;
          shorter focal length = wider, more dramatic perspective.
        </p>
      </div>
    </div>
  );
}

export default CameraSection;
