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
import { canProbePulldown, probePulldown } from '@core/video/pulldownProbe';
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

/**
 * AE's phase notation: W = whole frame, S = split (field-shared) frame. With
 * the A/A frame at index `phase`, the cycle A/A, B/B, B/C, C/D, D/D reads
 * W W S S W rotated to start wherever the file's frame 0 lands in it.
 */
function pulldownPhaseLabel(phase: number): string {
  const base = 'WWSSW';
  let s = '';
  for (let i = 0; i < 5; i++) s += base[(((i - phase) % 5) + 5) % 5];
  return s;
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
  // Remove Pulldown: the detected (or user-picked) 3:2 cadence phase, null =
  // off. When set, the exact decode path serves inverse-telecined progressive
  // film frames and Separate Fields is moot (see sourceInfo.pulldownPhase).
  const [pulldownPhase, setPulldownPhase] = useState<number | null>(
    typeof currentInterpret.pulldownPhase === 'number' ? currentInterpret.pulldownPhase : null,
  );
  // 3:2 pulldown detection — decodes a short window and looks for the
  // phase-locked field-repeat cadence (see core/video/pulldownDetect.ts).
  const [pulldownStatus, setPulldownStatus] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);
  const onDetectPulldown = async (): Promise<void> => {
    if (detecting) return;
    setDetecting(true);
    setPulldownStatus('Analyzing 40 frames…');
    try {
      const report = await probePulldown(asset.src, (f) =>
        setPulldownStatus(`Analyzing… ${Math.round(f * 100)}%`));
      if (report.telecine && report.phase !== null) {
        // A positive detect arms the removal itself: the decode path re-weaves
        // whole 23.976 film frames, so field separation is switched off rather
        // than on — bobbing progressive frames would only halve their detail.
        setPulldownPhase(report.phase);
        setFieldsMode('off');
        setPulldownStatus(
          `3:2 pulldown detected (confidence ${(report.confidence * 100).toFixed(0)}%, ` +
          `${report.repeats} field repeats / ${report.transitions} transitions). ` +
          `Remove Pulldown armed at phase ${pulldownPhaseLabel(report.phase)} — ` +
          'playback now re-weaves whole progressive film frames.',
        );
      } else {
        setPulldownStatus(
          `No 3:2 cadence found (confidence ${(report.confidence * 100).toFixed(0)}%). ` +
          'This looks progressive or natively interlaced.',
        );
      }
    } catch (err) {
      setPulldownStatus(`Detection failed: ${(err as Error).message}`);
    } finally {
      setDetecting(false);
    }
  };

  const handleSave = () => {
    const patch: FootageInterpretation = {
      conformFps: useConform ? Math.max(0.1, conformFps) : undefined,
      par: parPreset === 'custom' ? customPar : parseFloat(parPreset),
      alpha: alphaMode,
      loopCount: Math.max(0, Math.round(loopCount)),
      // 'off' stores as an EXPLICIT undefined — setInterpretation merges by
      // key and only deletes what the patch names, so omitting the key would
      // leave a previously saved value alive behind an Off in the dialog.
      // Remove Pulldown wins over Separate Fields (the frames it serves are
      // progressive), so arming one clears the other.
      fields: pulldownPhase === null && fieldsMode !== 'off' ? fieldsMode : undefined,
      pulldownPhase: pulldownPhase !== null ? pulldownPhase : undefined,
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
            onChange={(e) => {
              const v = e.target.value as 'off' | 'upper' | 'lower';
              setFieldsMode(v);
              // The two treatments are exclusive: choosing a field order by
              // hand disarms Remove Pulldown rather than silently outranking
              // it at save time.
              if (v !== 'off') setPulldownPhase(null);
            }}
          >
            <option value="off">Off (progressive)</option>
            <option value="upper">Upper Field First</option>
            <option value="lower">Lower Field First</option>
          </select>
          <p className={styles.hint}>
            For interlaced tape-era footage showing comb teeth on motion. Files don&apos;t record
            field order — DV is lower-first, most broadcast HD upper-first. Leave off for modern files.
          </p>
          <h4 className={styles.sectionTitle} style={{ marginTop: 10 }}>Remove Pulldown</h4>
          <select
            className={styles.select}
            value={pulldownPhase === null ? 'off' : String(pulldownPhase)}
            onChange={(e) => {
              const v = e.target.value;
              if (v === 'off') { setPulldownPhase(null); return; }
              setPulldownPhase(parseInt(v, 10));
              // Removal serves progressive frames — separating fields on top
              // of it would halve the detail the weave restores.
              setFieldsMode('off');
            }}
          >
            <option value="off">Off</option>
            {[0, 1, 2, 3, 4].map((p) => (
              <option key={p} value={String(p)}>
                {pulldownPhaseLabel(p)}
              </option>
            ))}
          </select>
          <p className={styles.hint}>
            Inverse telecine for 29.97 video mastered from 24 fps film: re-weaves whole progressive
            film frames from the 3:2 field cadence. Use Detect below to find the phase automatically.
          </p>
          {canProbePulldown() && (
            <button
              type="button"
              className={styles.select}
              style={{ cursor: 'pointer', marginTop: 6 }}
              disabled={detecting}
              onClick={() => void onDetectPulldown()}
              title="Decode a short window and look for the 3:2 telecine field cadence"
            >
              {detecting ? 'Detecting…' : 'Detect 3:2 Pulldown'}
            </button>
          )}
          {pulldownStatus && (
            <p className={styles.hint} role="status">{pulldownStatus}</p>
          )}
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
