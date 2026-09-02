/**
 * SceneInsertDialogs — AE-parity "New Camera" / "New Light" creation dialogs.
 *
 * The +Camera / +Light buttons open these instead of silently
 * inserting hardcoded seeds. Both collect a small set of options and hand them
 * to insertCamera / insertLight (whose no-arg call keeps the legacy defaults,
 * so AI tools and other programmatic callers are unaffected).
 */

import { useState } from 'react';
import { Icon } from '@components/Icon';
import { Button } from '@components/Button';
import { Input } from '@components/Input';
import { Switch } from '@components/Switch';
import { ValueField } from '@components/ValueField';
import { ColorPicker } from '@components/ColorPicker';
import { openModal } from '@stores/modalStore';
import { useCompositionStore } from '@stores/compositionStore';
import { Project3D } from '@motion/scene';
import { insertCamera, insertLight, insert3DPrimitive, type Primitive3DKind } from '@core/scene/sceneInsert';
import {
  defaultPrimitiveSpec,
  isPrimitiveMeshType,
  PRIMITIVE_FIELDS,
  type PrimitiveSpec,
} from '@core/scene/primitiveLayer';
import type { LightType } from '@core/scene/light';
import styles from './SceneInsertDialogs.module.css';

/** AE's camera lens presets (35mm-equivalent focal lengths, mm). The stored
 *  focal length is in comp px: fov = 2·atan(18 / mm) on a 36mm frame, then
 *  Project3D maps that field of view onto the comp width. */
const LENS_PRESETS_MM = [15, 20, 24, 28, 35, 50, 80, 135, 200] as const;

function fovForMm(mm: number): number {
  return (2 * Math.atan(18 / mm) * 180) / Math.PI;
}

function CameraDialog({ close }: { close: () => void }): JSX.Element {
  const compWidth = useCompositionStore((s) => s.width);
  const [name, setName] = useState('Camera 1');
  const [lensMm, setLensMm] = useState<number>(50);
  const [twoNode, setTwoNode] = useState(false);

  const fov = fovForMm(lensMm);
  const focalPx = Math.round(Project3D.focalLengthForFov(compWidth, fov));

  const create = (): void => {
    insertCamera({ name, focalLength: focalPx, twoNode });
    close();
  };

  return (
    <div className={styles.root}>
      <div className={styles.section}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Name</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} aria-label="Camera name" />
        </label>
      </div>

      <div className={styles.section}>
        <div className={styles.row}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Lens preset</span>
            <select
              className={styles.select}
              value={lensMm}
              onChange={(e) => setLensMm(Number(e.target.value))}
              aria-label="Lens preset"
            >
              {LENS_PRESETS_MM.map((mm) => (
                <option key={mm} value={mm}>{mm}mm</option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Field of view</span>
            <span className={styles.hint} style={{ lineHeight: '26px' }}>
              {fov.toFixed(1)}° · {focalPx}px
            </span>
          </label>
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.switchRow}>
          <Switch
            checked={twoNode}
            onChange={(e) => setTwoNode(e.target.checked)}
            label="Two-node (with Point of Interest)"
          />
        </div>
        <p className={styles.hint}>
          A two-node camera always aims at its Point of Interest — move the
          camera and it re-frames the target. A one-node camera looks where it
          is oriented.
        </p>
      </div>

      <div className={styles.footer}>
        <Button variant="ghost" size="md" onClick={close}>Cancel</Button>
        <Button variant="primary" size="md" leftIcon={<Icon name="check" size="sm" />} onClick={create}>
          Create camera
        </Button>
      </div>
    </div>
  );
}

function LightDialog({ close }: { close: () => void }): JSX.Element {
  const [name, setName] = useState('Light 1');
  const [type, setType] = useState<LightType>('point');
  const [intensity, setIntensity] = useState(100);
  const [color, setColor] = useState('#ffffff');
  const [coneAngleDeg, setConeAngleDeg] = useState(45);
  const [coneFeather, setConeFeather] = useState(50);
  const [castShadows, setCastShadows] = useState(false);
  // Seeded from the composition's World ▸ default sky, so the dialog opens on
  // the look the project is working in rather than always on Studio. It is a
  // starting point, not a lock — the menu below still changes it for this light.
  const compDefaultSky = useCompositionStore((s) => s.defaultEnvPreset);
  const [envPreset, setEnvPreset] = useState<'studio' | 'sky' | 'sunset'>(
    compDefaultSky === 'sky' || compDefaultSky === 'sunset' ? compDefaultSky : 'studio',
  );

  const create = (): void => {
    insertLight({
      name,
      type,
      intensity,
      color,
      coneAngle: type === 'spot' ? coneAngleDeg : undefined,
      coneFeather: type === 'spot' ? coneFeather : undefined,
      castShadows: type === 'environment' ? false : castShadows,
      envPreset: type === 'environment' ? envPreset : undefined,
    });
    close();
  };

  return (
    <div className={styles.root}>
      <div className={styles.section}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Name</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} aria-label="Light name" />
        </label>
      </div>

      <div className={styles.section}>
        <div className={styles.row}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Type</span>
            <select
              className={styles.select}
              value={type}
              onChange={(e) => setType(e.target.value as LightType)}
              aria-label="Light type"
            >
              <option value="point">Point (radiates everywhere)</option>
              <option value="spot">Spot (directional cone)</option>
              {/* Parallel was the one LightType the dialog could not create,
                  so the only way to get sunlight was to insert some other kind
                  of light and re-type it in the inspector. It needs no extra
                  seed of its own: like a spot it is aimed, but by `lightAngle`
                  / Point of Interest, both of which readNodeLight defaults. */}
              <option value="parallel">Parallel (directional, like sunlight)</option>
              <option value="ambient">Ambient (uniform wash)</option>
              <option value="environment">Environment (image-based sky)</option>
            </select>
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Intensity</span>
            <ValueField value={intensity} onChange={setIntensity} min={0} max={500} unit="%" aria-label="Intensity" />
          </label>
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.row}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Color</span>
            <div className={styles.colorRow}>
              <ColorPicker value={color} onChange={setColor} aria-label="Light color" />
              <span className={styles.hint}>{color}</span>
            </div>
          </label>
          {type === 'spot' && (
            <>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Cone angle</span>
                <ValueField value={coneAngleDeg} onChange={setConeAngleDeg} min={1} max={179} unit="°" aria-label="Cone angle" />
              </label>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Cone feather</span>
                <ValueField value={coneFeather} onChange={setConeFeather} min={0} max={100} unit="%" aria-label="Cone feather" />
              </label>
            </>
          )}
          {type === 'environment' && (
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Sky</span>
              <select
                className={styles.select}
                value={envPreset}
                onChange={(e) => setEnvPreset(e.target.value as 'studio' | 'sky' | 'sunset')}
                aria-label="Environment preset"
              >
                <option value="studio">Studio (soft top light)</option>
                <option value="sky">Day sky (blue above)</option>
                <option value="sunset">Sunset (warm horizon)</option>
              </select>
            </label>
          )}
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.switchRow}>
          <Switch
            checked={castShadows}
            onChange={(e) => setCastShadows(e.target.checked)}
            label="Casts shadows"
          />
        </div>
      </div>

      <div className={styles.footer}>
        <Button variant="ghost" size="md" onClick={close}>Cancel</Button>
        <Button variant="primary" size="md" leftIcon={<Icon name="check" size="sm" />} onClick={create}>
          Create light
        </Button>
      </div>
    </div>
  );
}

/**
 * New 3D Primitive.
 *
 * The "+" menu's 3D Cube / Sphere / Cylinder items insert a fixed default
 * object, which is fine for the two shapes that only have a size — and useless
 * for a torus, whose whole character is the ratio of ring to tube, or for
 * anything where the tessellation is the difference between a sphere and a
 * faceted ball. So this dialog collects the parameters BEFORE the insert
 * rather than making you find them in the inspector afterwards.
 *
 * Cube and Plane are listed here too, and are the odd ones out: they are not
 * generated meshes but the extrusion and quad paths (an extruded square is
 * already a real box, with bevels and per-face colours a plain box mesh would
 * lose). Their labels say so; picking one ignores the parameters below.
 */
type DialogKind = Primitive3DKind;

const DIALOG_KINDS: ReadonlyArray<{ id: DialogKind; label: string }> = [
  { id: 'sphere', label: 'Sphere' },
  { id: 'cylinder', label: 'Cylinder' },
  { id: 'cone', label: 'Cone' },
  { id: 'torus', label: 'Torus' },
  { id: 'capsule', label: 'Capsule' },
  { id: 'box', label: 'Box (mesh)' },
  { id: 'cube', label: 'Cube (extruded — bevels, per-face colours)' },
  { id: 'plane', label: 'Plane (flat quad)' },
];

function PrimitiveDialog({ close }: { close: () => void }): JSX.Element {
  const [type, setType] = useState<DialogKind>('sphere');
  // One spec for the whole dialog, re-seeded on every type change so the
  // ranges shown always belong to the shape being created. Values a shape
  // shares with the previous one survive the switch (defaultPrimitiveSpec
  // gives them the same meaning), so nudging the radius then trying it as a
  // capsule keeps the radius.
  const [spec, setSpec] = useState<PrimitiveSpec>(() => defaultPrimitiveSpec('sphere'));

  const onType = (next: DialogKind): void => {
    setType(next);
    if (isPrimitiveMeshType(next)) {
      setSpec((prev) => ({ ...defaultPrimitiveSpec(next), ...prev, type: next }));
    }
  };

  const mesh = isPrimitiveMeshType(type) ? type : null;
  const fields = mesh ? PRIMITIVE_FIELDS[mesh] : [];
  const uses = (f: keyof PrimitiveSpec): boolean => fields.includes(f);
  const set = (f: keyof PrimitiveSpec) => (v: number): void => setSpec((p) => ({ ...p, [f]: v }));

  const create = (): void => {
    insert3DPrimitive(type, mesh ? spec : undefined);
    close();
  };

  return (
    <div className={styles.root}>
      <div className={styles.section}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Shape</span>
          <select
            className={styles.select}
            value={type}
            onChange={(e) => onType(e.target.value as DialogKind)}
            aria-label="Primitive shape"
          >
            {DIALOG_KINDS.map((k) => (
              <option key={k.id} value={k.id}>{k.label}</option>
            ))}
          </select>
        </label>
      </div>

      {mesh && (
        <>
          <div className={styles.section}>
            <div className={styles.row}>
              {uses('radius') && (
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>{mesh === 'torus' ? 'Ring radius' : 'Radius'}</span>
                  <ValueField value={Math.round(spec.radius)} onChange={set('radius')} min={1} max={4000} unit="px" aria-label="Radius" />
                </label>
              )}
              {uses('radiusTop') && (
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Top radius</span>
                  <ValueField value={Math.round(spec.radiusTop)} onChange={set('radiusTop')} min={0} max={4000} unit="px" aria-label="Top radius" />
                </label>
              )}
              {uses('tube') && (
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Tube radius</span>
                  <ValueField value={Math.round(spec.tube)} onChange={set('tube')} min={1} max={2000} unit="px" aria-label="Tube radius" />
                </label>
              )}
              {uses('width') && (
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Width</span>
                  <ValueField value={Math.round(spec.width)} onChange={set('width')} min={1} max={8000} unit="px" aria-label="Width" />
                </label>
              )}
              {uses('height') && (
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>{mesh === 'capsule' ? 'Height (total)' : 'Height'}</span>
                  <ValueField value={Math.round(spec.height)} onChange={set('height')} min={1} max={8000} unit="px" aria-label="Height" />
                </label>
              )}
              {uses('depth') && (
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Depth</span>
                  <ValueField value={Math.round(spec.depth)} onChange={set('depth')} min={1} max={8000} unit="px" aria-label="Depth" />
                </label>
              )}
            </div>
          </div>

          {(uses('radialSegments') || uses('heightSegments')) && (
            <div className={styles.section}>
              <div className={styles.row}>
                {uses('radialSegments') && (
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>{mesh === 'torus' ? 'Ring segments' : 'Segments (around)'}</span>
                    <ValueField value={spec.radialSegments} onChange={(v) => set('radialSegments')(Math.round(v))} min={3} max={256} aria-label="Radial segments" />
                  </label>
                )}
                {uses('heightSegments') && (
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>
                      {mesh === 'torus' ? 'Tube segments' : mesh === 'capsule' ? 'Cap rows' : 'Segments (rows)'}
                    </span>
                    <ValueField value={spec.heightSegments} onChange={(v) => set('heightSegments')(Math.round(v))} min={3} max={256} aria-label="Height segments" />
                  </label>
                )}
              </div>
              <p className={styles.hint}>
                More segments means a rounder silhouette and more triangles. The
                defaults look smooth at typical comp sizes; raise them for a
                close-up, lower them for a deliberately faceted look.
              </p>
            </div>
          )}

          {uses('capped') && (
            <div className={styles.section}>
              <div className={styles.switchRow}>
                <Switch
                  checked={spec.capped}
                  onChange={(e) => setSpec((p) => ({ ...p, capped: e.target.checked }))}
                  label="End caps"
                />
              </div>
            </div>
          )}
        </>
      )}

      <div className={styles.footer}>
        <Button variant="ghost" size="md" onClick={close}>Cancel</Button>
        <Button variant="primary" size="md" leftIcon={<Icon name="check" size="sm" />} onClick={create}>
          Create
        </Button>
      </div>
    </div>
  );
}

/** Open the "New 3D Primitive" dialog. */
export function openPrimitiveDialog(): void {
  openModal({
    id: 'insert-3d-primitive',
    title: 'New 3D primitive',
    size: 'sm',
    render: (close) => <PrimitiveDialog close={close} />,
  });
}

/** Open the AE-style "New Camera" dialog. */
export function openCameraDialog(): void {
  openModal({
    id: 'insert-camera',
    title: 'New camera',
    size: 'sm',
    render: (close) => <CameraDialog close={close} />,
  });
}

/** Open the AE-style "New Light" dialog. */
export function openLightDialog(): void {
  openModal({
    id: 'insert-light',
    title: 'New light',
    size: 'sm',
    render: (close) => <LightDialog close={close} />,
  });
}
