/**
 * SceneInsertDialogs — AE-parity "New Camera" / "New Light" creation dialogs.
 *
 * The ViewportHeader's +Camera / +Light buttons open these instead of silently
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
import { insertCamera, insertLight } from '@core/scene/sceneInsert';
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
        <Button variant="primary" size="md" leftIcon={<Icon name="check" size={14} />} onClick={create}>
          Create camera
        </Button>
      </div>
    </div>
  );
}

const LIGHT_TYPES: Array<{ value: LightType; label: string }> = [
  { value: 'point', label: 'Point' },
  { value: 'spot', label: 'Spot' },
  { value: 'parallel', label: 'Parallel' },
  { value: 'ambient', label: 'Ambient' },
];

function LightDialog({ close }: { close: () => void }): JSX.Element {
  const [name, setName] = useState('Light 1');
  const [type, setType] = useState<LightType>('point');
  const [color, setColor] = useState('#fff3c0');
  const [intensity, setIntensity] = useState(100);
  const [coneAngle, setConeAngle] = useState(45);
  const [castShadows, setCastShadows] = useState(false);

  const create = (): void => {
    insertLight({ name, type, color, intensity, coneAngle, castShadows });
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
              {LIGHT_TYPES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Intensity</span>
            <ValueField
              value={intensity}
              onChange={(v) => setIntensity(Number(v))}
              min={0}
              max={400}
              step={1}
              unit="%"
              aria-label="Light intensity"
            />
          </label>
        </div>
        <div className={styles.row}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Color</span>
            <ColorPicker value={color} onChange={setColor} aria-label="Light color" />
          </label>
          {type === 'spot' && (
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Cone angle</span>
              <ValueField
                value={coneAngle}
                onChange={(v) => setConeAngle(Number(v))}
                min={1}
                max={180}
                step={1}
                unit="°"
                aria-label="Spot cone angle"
              />
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
        <Button variant="primary" size="md" leftIcon={<Icon name="check" size={14} />} onClick={create}>
          Create light
        </Button>
      </div>
    </div>
  );
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
