/**
 * Interpret Footage: Main Dialog — After Effects canonical dialog for conforming
 * and reinterpreting imported footage (fps, PAR, alpha, looping).
 *
 * Stored on the ASSET in useAssetStore, so setting it once fixes every layer
 * referencing this footage across all compositions in the project.
 */

import { useState } from 'react';
import { openModal } from '@stores/modalStore';
import { Button } from '@components/Button';
import { useAssetStore, type ImportedAsset } from '@stores/assetStore';
import { bumpScene } from '@stores/sceneStore';
import type { AlphaInterpretation, FootageInterpretation } from '@core/source/sourceInfo';
import styles from './InterpretFootageModal.module.css';

const PAR_PRESETS: Array<{ label: string; value: number }> = [
  { label: 'Square Pixels (1.0)', value: 1.0 },
  { label: 'D1/DV NTSC (0.91)', value: 0.91 },
  { label: 'D1/DV PAL (1.09)', value: 1.09 },
  { label: 'D1/DV NTSC Widescreen (1.21)', value: 1.21 },
  { label: 'D1/DV PAL Widescreen (1.46)', value: 1.46 },
  { label: 'HDV / DVCPRO HD 1080 (1.333)', value: 1.333333 },
  { label: 'Anamorphic 2:1 (2.0)', value: 2.0 },
];

function findParPreset(val: number): string {
  const match = PAR_PRESETS.find((p) => Math.abs(p.value - val) < 0.01);
  return match ? String(match.value) : 'custom';
}

function InterpretFootageBody({
  asset,
  close,
}: {
  asset: ImportedAsset;
  close: () => void;
}): JSX.Element {
  const meta = asset.metadata ?? {};
  const currentInterpret = asset.interpret ?? {};

  const probedFps = meta.fps && meta.fps > 0 ? meta.fps : null;
  const initialConforming = currentInterpret.conformFps !== undefined;
  const [useConform, setUseConform] = useState<boolean>(initialConforming);
  const [conformFps, setConformFps] = useState<number>(
    currentInterpret.conformFps ?? (probedFps ?? 24),
  );

  const initialPar = currentInterpret.par ?? 1.0;
  const [parPreset, setParPreset] = useState<string>(findParPreset(initialPar));
  const [customPar, setCustomPar] = useState<number>(initialPar);

  const [alphaMode, setAlphaMode] = useState<AlphaInterpretation>(
    currentInterpret.alpha ?? 'straight',
  );

  const initialLoop = currentInterpret.loopCount ?? 1;
  const [loopCount, setLoopCount] = useState<number>(initialLoop);

  const [fieldsMode, setFieldsMode] = useState<'off' | 'upper' | 'lower'>(
    currentInterpret.fields ?? 'off',
  );

  const handleSave = () => {
    const patch: FootageInterpretation = {
      conformFps: useConform ? Math.max(0.1, conformFps) : undefined,
      par: parPreset === 'custom' ? customPar : parseFloat(parPreset),
      alpha: alphaMode,
      loopCount: Math.max(0, Math.round(loopCount)),
      // 'off' stores as absent — progressive is the unmarked state, so an
      // untouched asset round-trips without a fields key at all.
      ...(fieldsMode !== 'off' ? { fields: fieldsMode } : {}),
    };

    useAssetStore.getState().setInterpretation(asset.id, patch);
    bumpScene();
    close();
  };

  return (
    <div className={styles.modalBody}>
      {/* ── Frame Rate ── */}
      <div className={styles.section}>
        <h4 className={styles.sectionTitle}>Frame Rate</h4>
        <div className={styles.radioGroup}>
          <label className={styles.radioLabel}>
            <input
              type="radio"
              name="fps_mode"
              checked={!useConform}
              onChange={() => setUseConform(false)}
            />
            <span>
              Use frame rate from file{' '}
              {probedFps ? `(${probedFps % 1 === 0 ? probedFps : probedFps.toFixed(3)} fps)` : '(unprobed / comp default)'}
            </span>
          </label>

          <label className={styles.radioLabel}>
            <input
              type="radio"
              name="fps_mode"
              checked={useConform}
              onChange={() => setUseConform(true)}
            />
            <span>Conform to frame rate:</span>
          </label>
        </div>

        {useConform && (
          <div className={styles.inlineInput}>
            <input
              type="number"
              className={styles.numberInput}
              step="any"
              min="1"
              max="240"
              value={conformFps}
              onChange={(e) => setConformFps(parseFloat(e.target.value) || 24)}
            />
            <span>fps</span>
          </div>
        )}
        <p className={styles.hint}>
          Conforming changes playback speed without dropping frames (e.g. 60fps conform to 24fps creates smooth slow-motion).
        </p>
      </div>

      {/* ── Pixel Aspect Ratio ── */}
      <div className={styles.section}>
        <h4 className={styles.sectionTitle}>Pixel Aspect Ratio</h4>
        <select
          className={styles.select}
          value={parPreset}
          onChange={(e) => {
            const v = e.target.value;
            setParPreset(v);
            if (v !== 'custom') setCustomPar(parseFloat(v));
          }}
        >
          {PAR_PRESETS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
          <option value="custom">Custom…</option>
        </select>

        {parPreset === 'custom' && (
          <div className={styles.inlineInput} style={{ marginTop: 6, marginLeft: 0 }}>
            <span>Aspect ratio:</span>
            <input
              type="number"
              className={styles.numberInput}
              step="0.001"
              min="0.1"
              max="4.0"
              value={customPar}
              onChange={(e) => setCustomPar(parseFloat(e.target.value) || 1.0)}
            />
          </div>
        )}
      </div>

      {/* ── Alpha Channel ── */}
      {asset.type !== 'audio' && (
        <div className={styles.section}>
          <h4 className={styles.sectionTitle}>Alpha Channel</h4>
          <select
            className={styles.select}
            value={alphaMode}
            onChange={(e) => setAlphaMode(e.target.value as AlphaInterpretation)}
          >
            <option value="straight">Straight (Unmatted)</option>
            <option value="premultiplied">Premultiplied (Matted With Black)</option>
          </select>
          <p className={styles.hint}>
            Straight is standard for PNG, ProRes 4444 and WebM. Premultiplied prevents black fringing on rendered elements.
          </p>
        </div>
      )}

      {/* ── Fields (interlaced sources only — video, not stills) ── */}
      {asset.type === 'video' && (
        <div className={styles.section}>
          <h4 className={styles.sectionTitle}>Separate Fields</h4>
          <select
            className={styles.select}
            value={fieldsMode}
            onChange={(e) => setFieldsMode(e.target.value as 'off' | 'upper' | 'lower')}
          >
            <option value="off">Off (progressive)</option>
            <option value="upper">Upper Field First</option>
            <option value="lower">Lower Field First</option>
          </select>
          <p className={styles.hint}>
            For interlaced tape-era footage showing comb teeth on motion. Files don&apos;t record
            field order — DV is lower-first, most broadcast HD upper-first. Leave off for modern files.
          </p>
        </div>
      )}

      {/* ── Other Options / Looping ── */}
      <div className={styles.section}>
        <h4 className={styles.sectionTitle}>Other Options</h4>
        <div className={styles.inlineInput} style={{ marginLeft: 0 }}>
          <span>Loop:</span>
          <input
            type="number"
            className={styles.numberInput}
            step="1"
            min="0"
            max="9999"
            value={loopCount}
            onChange={(e) => setLoopCount(parseInt(e.target.value, 10) || 0)}
          />
          <span>Times {loopCount === 0 ? '(Infinite Loop)' : ''}</span>
        </div>
      </div>

      {/* ── Actions ── */}
      <div className={styles.footer}>
        <Button size="sm" variant="secondary" onClick={close}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" onClick={handleSave}>
          OK
        </Button>
      </div>
    </div>
  );
}

/** Open the After Effects Interpret Footage modal for one asset. */
export function openInterpretFootage(asset: ImportedAsset): void {
  openModal({
    id: `interpret-footage-${asset.id}`,
    title: `Interpret Footage: ${asset.name}`,
    size: 'md',
    render: (close) => <InterpretFootageBody asset={asset} close={close} />,
  });
}
