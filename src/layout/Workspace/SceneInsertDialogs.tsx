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
import { useDialogPrimaryAction } from '@components/Modal';
import { Input } from '@components/Input';
import { Switch } from '@components/Switch';
import { Checkbox } from '@components/Checkbox';
import { Segmented } from '@components/Segmented';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { ValueField } from '@components/ValueField';
import { ColorPicker } from '@components/ColorPicker';
import { openModal } from '@stores/modalStore';
import { documentMirror } from '@stores/documentMirror';
import { activeCompIdNow, useActiveMirrorComp } from '@hooks/useMirror';
import { settingsWorld } from '@core/mirror/compFacts';
import { nextDeviceNameIn } from '@core/mirror/deviceNames';
import { compHas3DContent, flattenCompLayers } from '@core/mirror/compLayers';
import { mirrorCanBe3D } from '@core/mirror/layerFacts';
import { DEFAULT_LENS_MM, LENS_PRESETS, focalPxForMm, fovForMm } from '@core/scene/lensPresets';
import type { Primitive3DKind } from '@core/scene/layerBuilders';
import { insertCameraEdit, insertLightEdit, insert3DPrimitiveEdit } from '@/engine-client/insertEdits';
import {
  defaultPrimitiveSpec,
  isPrimitiveMeshType,
  PRIMITIVE_FIELDS,
  type PrimitiveSpec,
} from '@core/scene/primitiveLayer';
import type { LightType } from '@core/scene/light';
import styles from './SceneInsertDialogs.module.css';
import { t } from '@core/i18n';

/** The next free "Camera N" / "Light N" of the active composition (the dialogs' prefill). */
function nextDeviceName(kind: 'camera' | 'light'): string {
  return nextDeviceNameIn(documentMirror(), activeCompIdNow(), kind);
}

/** The composition the dialogs insert into (`activeCompRootId`'s rule). */
function targetComp(): string {
  return activeCompIdNow() ?? 'comp_root';
}

/**
 * New Camera, task-led (camera program U4, 2026-10-14): the dialog asks what
 * the user is DOING, not which AE switch to flip.
 *
 *   Lens            the shared list (lensPresets.ts) in the app Dropdown, with
 *                   the angle of view it gives read out live beside it;
 *   Aim             "Aim at a target" (two-node: a Point of Interest the camera
 *                   always faces) or "Free" (one-node: it looks where turned);
 *   Make all 3D     on by default when no layer of the comp is 3D yet — the
 *                   #1 "the camera does nothing" trap, fixed before it bites.
 *
 * The 3D switches land in the SAME undo entry as the camera (`make3D` rides
 * the insert's `pasteLayers` batch), so one Undo takes back the whole action.
 */
export function CameraDialog({ close }: { close: () => void }): JSX.Element {
  const compId = targetComp();
  const compWidth = useActiveMirrorComp()?.settings.width ?? 1920;
  const [name, setName] = useState(() => nextDeviceName('camera'));
  const [lensMm, setLensMm] = useState<number>(DEFAULT_LENS_MM);
  const [aim, setAim] = useState<'target' | 'free'>('free');
  // Read once, when the dialog opens: the default follows the comp as it was.
  const [make3D, setMake3D] = useState(() => !compHas3DContent(documentMirror(), compId, false));

  const fov = fovForMm(lensMm);
  const focalPx = Math.round(focalPxForMm(compWidth, lensMm));
  const lens = LENS_PRESETS.find((p) => p.mm === lensMm);

  const create = async (): Promise<void> => {
    close();
    const flat = make3D ? await flatLayersOf(compId) : [];
    // The camera builder (two-node POI, lens → focal length, placement) runs off-document and
    // lands as ONE pasteLayers entry (engine-client/insertEdits.ts), the 3D switches with it.
    await insertCameraEdit({ name, focalLength: focalPx, twoNode: aim === 'target' }, 'New Camera', { comp: compId, make3D: flat });
  };
  useDialogPrimaryAction(() => { void create(); });

  return (
    <div className={styles.root}>
      <div className={styles.section}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>{t('workspace.sceneInsert.name', 'Name')}</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} aria-label={t('workspace.sceneInsert.cameraName', 'Camera name')} />
        </label>
      </div>

      <div className={styles.section}>
        <div className={styles.row}>
          <div className={styles.field}>
            <span className={styles.fieldLabel}>{t('workspace.sceneInsert.lens', 'Lens')}</span>
            <Dropdown
              trigger={
                <button type="button" className={styles.select} aria-label={t('workspace.sceneInsert.lens', 'Lens')}>
                  {lens?.label ?? `${lensMm}mm`}
                </button>
              }
              items={() => LENS_PRESETS.map((p): DropdownItem => ({
                type: 'item',
                id: `lens-${p.mm}`,
                label: p.label,
                ...(p.mm === lensMm ? { icon: 'check' as const } : {}),
                onSelect: () => setLensMm(p.mm),
              }))}
            />
          </div>
          <div className={styles.field}>
            <span className={styles.fieldLabel}>{t('workspace.sceneInsert.angleOfView', 'Angle of view')}</span>
            <span className={styles.readout} data-testid="camera-angle-of-view">
              {t('workspace.sceneInsert.angleReadout', '{fov}° · {zoom} px Zoom', { fov: fov.toFixed(1), zoom: focalPx })}
            </span>
          </div>
        </div>
      </div>

      <div className={styles.section}>
        <Segmented
          aria-label={t('workspace.sceneInsert.cameraAim', 'Camera aim')}
          value={aim}
          onChange={setAim}
          options={[
            { value: 'target', label: t('workspace.sceneInsert.aimTarget', 'Aim at a target') },
            { value: 'free', label: t('workspace.sceneInsert.aimFree', 'Free') },
          ]}
        />
        <p className={styles.hint}>
          {aim === 'target'
            ? t('workspace.sceneInsert.twoNodeHint', 'Two-node: the camera always faces its Point of Interest — move it and it re-frames the target.')
            : t('workspace.sceneInsert.oneNodeHint', 'One-node: the camera looks where it is turned, like a camera on a tripod head.')}
        </p>
      </div>

      <div className={styles.section}>
        <Checkbox
          checked={make3D}
          onChange={(e) => setMake3D(e.target.checked)}
          label={t('workspace.sceneInsert.make3D', 'Make all layers 3D')}
        />
        <p className={styles.hint}>{t('workspace.sceneInsert.make3DHint', 'A camera only moves layers whose 3D switch is on.')}</p>
      </div>

      <div className={styles.footer}>
        <Button variant="ghost" size="md" onClick={close}>{t('workspace.sceneInsert.cancel', 'Cancel')}</Button>
        <Button variant="primary" size="md" leftIcon={<Icon name="check" size="sm" />} onClick={() => { void create(); }}>
          {t('workspace.sceneInsert.createCamera', 'Create camera')}
        </Button>
      </div>
    </div>
  );
}

/** The layers of `comp` a camera could move that are still 2D (what "Make all layers 3D" switches). */
async function flatLayersOf(comp: string): Promise<string[]> {
  const m = documentMirror();
  const out: string[] = [];
  for (const id of flattenCompLayers(m, comp)) {
    const layer = m.layer(id);
    if (!layer || layer.switches.threeD) continue;
    if (mirrorCanBe3D(layer, await m.loadTree(id))) out.push(id);
  }
  return out;
}

function LightDialog({ close }: { close: () => void }): JSX.Element {
  const [name, setName] = useState(() => nextDeviceName('light'));
  const [type, setType] = useState<LightType>('point');
  const [intensity, setIntensity] = useState(100);
  const [color, setColor] = useState('#ffffff');
  const [coneAngleDeg, setConeAngleDeg] = useState(45);
  const [coneFeather, setConeFeather] = useState(50);
  const [castShadows, setCastShadows] = useState(false);
  // Seeded from the composition's World ▸ default sky, so the dialog opens on
  // the look the project is working in rather than always on Studio. It is a
  // starting point, not a lock — the menu below still changes it for this light.
  const compDefaultSky = settingsWorld(useActiveMirrorComp()?.settings).defaultEnvPreset;
  const [envPreset, setEnvPreset] = useState<'studio' | 'sky' | 'sunset'>(
    compDefaultSky === 'sky' || compDefaultSky === 'sunset' ? compDefaultSky : 'studio',
  );

  const create = (): void => {
    // The light builder (type, colour, intensity, cone, shadows, environment sky) runs
    // into a fragment and lands as ONE pasteLayers entry. AE's New Light makes exactly the one
    // light asked for — no Ambient Fill beside it (the silent insert keeps adding one).
    void insertLightEdit({
      name,
      type,
      intensity,
      color,
      coneAngle: type === 'spot' ? coneAngleDeg : undefined,
      coneFeather: type === 'spot' ? coneFeather : undefined,
      castShadows: type === 'environment' ? false : castShadows,
      envPreset: type === 'environment' ? envPreset : undefined,
      ambientFill: false,
    }, 'New Light', { comp: targetComp() });
    close();
  };
  useDialogPrimaryAction(create);

  return (
    <div className={styles.root}>
      <div className={styles.section}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>{t('workspace.sceneInsert.name', 'Name')}</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} aria-label={t('workspace.sceneInsert.lightName', 'Light name')} />
        </label>
      </div>

      <div className={styles.section}>
        <div className={styles.row}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t('workspace.sceneInsert.type', 'Type')}</span>
            <select
              className={styles.select}
              value={type}
              onChange={(e) => setType(e.target.value as LightType)}
              aria-label={t('workspace.sceneInsert.lightType', 'Light type')}
            >
              <option value="point">{t('workspace.sceneInsert.lightPoint', 'Point (radiates everywhere)')}</option>
              <option value="spot">{t('workspace.sceneInsert.lightSpot', 'Spot (directional cone)')}</option>
              {/* Parallel was the one LightType the dialog could not create,
                  so the only way to get sunlight was to insert some other kind
                  of light and re-type it in the inspector. It needs no extra
                  seed of its own: like a spot it is aimed, but by `lightAngle`
                  / Point of Interest, both of which readNodeLight defaults. */}
              <option value="parallel">{t('workspace.sceneInsert.lightParallel', 'Parallel (directional, like sunlight)')}</option>
              <option value="ambient">{t('workspace.sceneInsert.lightAmbient', 'Ambient (uniform wash)')}</option>
              <option value="environment">{t('workspace.sceneInsert.lightEnvironment', 'Environment (image-based sky)')}</option>
            </select>
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t('workspace.sceneInsert.intensity', 'Intensity')}</span>
            <ValueField value={intensity} onChange={setIntensity} min={0} max={500} unit="%" aria-label={t('workspace.sceneInsert.intensity', 'Intensity')} />
          </label>
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.row}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t('workspace.sceneInsert.color', 'Color')}</span>
            <div className={styles.colorRow}>
              <ColorPicker value={color} onChange={setColor} aria-label={t('workspace.sceneInsert.lightColor', 'Light color')} />
              <span className={styles.hint}>{color}</span>
            </div>
          </label>
          {type === 'spot' && (
            <>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>{t('workspace.sceneInsert.coneAngle', 'Cone angle')}</span>
                <ValueField value={coneAngleDeg} onChange={setConeAngleDeg} min={1} max={179} unit="°" aria-label={t('workspace.sceneInsert.coneAngle', 'Cone angle')} />
              </label>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>{t('workspace.sceneInsert.coneFeather', 'Cone feather')}</span>
                <ValueField value={coneFeather} onChange={setConeFeather} min={0} max={100} unit="%" aria-label={t('workspace.sceneInsert.coneFeather', 'Cone feather')} />
              </label>
            </>
          )}
          {type === 'environment' && (
            <label className={styles.field}>
              <span className={styles.fieldLabel}>{t('workspace.sceneInsert.sky', 'Sky')}</span>
              <select
                className={styles.select}
                value={envPreset}
                onChange={(e) => setEnvPreset(e.target.value as 'studio' | 'sky' | 'sunset')}
                aria-label={t('workspace.sceneInsert.envPreset', 'Environment preset')}
              >
                <option value="studio">{t('workspace.sceneInsert.envStudio', 'Studio (soft top light)')}</option>
                <option value="sky">{t('workspace.sceneInsert.envSky', 'Day sky (blue above)')}</option>
                <option value="sunset">{t('workspace.sceneInsert.envSunset', 'Sunset (warm horizon)')}</option>
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
            label={t('workspace.sceneInsert.castsShadows', 'Casts shadows')}
          />
        </div>
      </div>

      <div className={styles.footer}>
        <Button variant="ghost" size="md" onClick={close}>{t('workspace.sceneInsert.cancel', 'Cancel')}</Button>
        <Button variant="primary" size="md" leftIcon={<Icon name="check" size="sm" />} onClick={create}>
          {t('workspace.sceneInsert.createLight', 'Create light')}
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

/** A function, not a constant: `t()` must run at render time, never at module scope. */
function dialogKinds(): ReadonlyArray<{ id: DialogKind; label: string }> {
  return [
    { id: 'sphere', label: t('workspace.sceneInsert.primSphere', 'Sphere') },
    { id: 'cylinder', label: t('workspace.sceneInsert.primCylinder', 'Cylinder') },
    { id: 'cone', label: t('workspace.sceneInsert.primCone', 'Cone') },
    { id: 'torus', label: t('workspace.sceneInsert.primTorus', 'Torus') },
    { id: 'capsule', label: t('workspace.sceneInsert.primCapsule', 'Capsule') },
    { id: 'box', label: t('workspace.sceneInsert.primBox', 'Box (mesh)') },
    { id: 'cube', label: t('workspace.sceneInsert.primCube', 'Cube (extruded — bevels, per-face colours)') },
    { id: 'plane', label: t('workspace.sceneInsert.primPlane', 'Plane (flat quad)') },
  ];
}

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
    // Built off-document, inserted as ONE pasteLayers entry.
    void insert3DPrimitiveEdit(type, mesh ? spec : undefined, 'New 3D Primitive', { comp: activeCompIdNow() ?? 'comp_root' });
    close();
  };
  useDialogPrimaryAction(create);

  return (
    <div className={styles.root}>
      <div className={styles.section}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>{t('workspace.sceneInsert.shape', 'Shape')}</span>
          <select
            className={styles.select}
            value={type}
            onChange={(e) => onType(e.target.value as DialogKind)}
            aria-label={t('workspace.sceneInsert.primitiveShape', 'Primitive shape')}
          >
            {dialogKinds().map((k) => (
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
                  <span className={styles.fieldLabel}>
                    {mesh === 'torus' ? t('workspace.sceneInsert.ringRadius', 'Ring radius') : t('workspace.sceneInsert.radius', 'Radius')}
                  </span>
                  <ValueField value={Math.round(spec.radius)} onChange={set('radius')} min={1} max={4000} unit="px" aria-label={t('workspace.sceneInsert.radius', 'Radius')} />
                </label>
              )}
              {uses('radiusTop') && (
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>{t('workspace.sceneInsert.topRadius', 'Top radius')}</span>
                  <ValueField value={Math.round(spec.radiusTop)} onChange={set('radiusTop')} min={0} max={4000} unit="px" aria-label={t('workspace.sceneInsert.topRadius', 'Top radius')} />
                </label>
              )}
              {uses('tube') && (
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>{t('workspace.sceneInsert.tubeRadius', 'Tube radius')}</span>
                  <ValueField value={Math.round(spec.tube)} onChange={set('tube')} min={1} max={2000} unit="px" aria-label={t('workspace.sceneInsert.tubeRadius', 'Tube radius')} />
                </label>
              )}
              {uses('width') && (
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>{t('workspace.sceneInsert.width', 'Width')}</span>
                  <ValueField value={Math.round(spec.width)} onChange={set('width')} min={1} max={8000} unit="px" aria-label={t('workspace.sceneInsert.width', 'Width')} />
                </label>
              )}
              {uses('height') && (
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>
                    {mesh === 'capsule' ? t('workspace.sceneInsert.heightTotal', 'Height (total)') : t('workspace.sceneInsert.height', 'Height')}
                  </span>
                  <ValueField value={Math.round(spec.height)} onChange={set('height')} min={1} max={8000} unit="px" aria-label={t('workspace.sceneInsert.height', 'Height')} />
                </label>
              )}
              {uses('depth') && (
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>{t('workspace.sceneInsert.depth', 'Depth')}</span>
                  <ValueField value={Math.round(spec.depth)} onChange={set('depth')} min={1} max={8000} unit="px" aria-label={t('workspace.sceneInsert.depth', 'Depth')} />
                </label>
              )}
            </div>
          </div>

          {(uses('radialSegments') || uses('heightSegments')) && (
            <div className={styles.section}>
              <div className={styles.row}>
                {uses('radialSegments') && (
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>
                      {mesh === 'torus' ? t('workspace.sceneInsert.ringSegments', 'Ring segments') : t('workspace.sceneInsert.segmentsAround', 'Segments (around)')}
                    </span>
                    <ValueField value={spec.radialSegments} onChange={(v) => set('radialSegments')(Math.round(v))} min={3} max={256} aria-label={t('workspace.sceneInsert.radialSegments', 'Radial segments')} />
                  </label>
                )}
                {uses('heightSegments') && (
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>
                      {mesh === 'torus'
                        ? t('workspace.sceneInsert.tubeSegments', 'Tube segments')
                        : mesh === 'capsule' ? t('workspace.sceneInsert.capRows', 'Cap rows') : t('workspace.sceneInsert.segmentsRows', 'Segments (rows)')}
                    </span>
                    <ValueField value={spec.heightSegments} onChange={(v) => set('heightSegments')(Math.round(v))} min={3} max={256} aria-label={t('workspace.sceneInsert.heightSegments', 'Height segments')} />
                  </label>
                )}
              </div>
              <p className={styles.hint}>
                {t(
                  'workspace.sceneInsert.segmentsHint',
                  'More segments means a rounder silhouette and more triangles. The defaults look smooth at typical comp sizes; raise them for a close-up, lower them for a deliberately faceted look.',
                )}
              </p>
            </div>
          )}

          {uses('capped') && (
            <div className={styles.section}>
              <div className={styles.switchRow}>
                <Switch
                  checked={spec.capped}
                  onChange={(e) => setSpec((p) => ({ ...p, capped: e.target.checked }))}
                  label={t('workspace.sceneInsert.endCaps', 'End caps')}
                />
              </div>
            </div>
          )}
        </>
      )}

      <div className={styles.footer}>
        <Button variant="ghost" size="md" onClick={close}>{t('workspace.sceneInsert.cancel', 'Cancel')}</Button>
        <Button variant="primary" size="md" leftIcon={<Icon name="check" size="sm" />} onClick={create}>
          {t('workspace.sceneInsert.create', 'Create')}
        </Button>
      </div>
    </div>
  );
}

/** Open the "New 3D Primitive" dialog. */
export function openPrimitiveDialog(): void {
  openModal({
    id: 'insert-3d-primitive',
    title: t('workspace.sceneInsert.primitiveTitle', 'New 3D primitive'),
    size: 'sm',
    render: (close) => <PrimitiveDialog close={close} />,
  });
}

/** Open the AE-style "New Camera" dialog. */
export function openCameraDialog(): void {
  openModal({
    id: 'insert-camera',
    title: t('workspace.sceneInsert.cameraTitle', 'New camera'),
    size: 'sm',
    render: (close) => <CameraDialog close={close} />,
  });
}

/** Open the AE-style "New Light" dialog. */
export function openLightDialog(): void {
  openModal({
    id: 'insert-light',
    title: t('workspace.sceneInsert.lightTitle', 'New light'),
    size: 'sm',
    render: (close) => <LightDialog close={close} />,
  });
}
