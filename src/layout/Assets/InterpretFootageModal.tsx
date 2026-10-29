/**
 * Interpret Footage: Main Dialog — After Effects canonical dialog for conforming
 * and reinterpreting imported footage (fps, PAR, alpha, looping).
 *
 * Stored on the ITEM (the footage record), so setting it once fixes every layer
 * referencing this footage across all compositions in the project.
 */

import { useState } from 'react';
import { openModal } from '@stores/modalStore';
import { Button } from '@components/Button';
import type { ImportedAsset } from '@stores/assetStore';
import { documentMirror } from '@stores/documentMirror';
import { itemAsset } from '@core/mirror/itemAssets';
import type { AlphaInterpretation, FootageInterpretation } from '@core/source/sourceInfo';
import { canProbePulldown, probePulldown } from '@core/video/pulldownProbe';
import { interpretFootageEdit } from './assetEdits';
import styles from './InterpretFootageModal.module.css';
import { t } from '@core/i18n';

function parPresets(): Array<{ label: string; value: number }> {
  return [
    { label: t('assets.interpret.parSquare', 'Square Pixels (1.0)'), value: 1.0 },
    { label: 'D1/DV NTSC (0.91)', value: 0.91 },
    { label: 'D1/DV PAL (1.09)', value: 1.09 },
    { label: t('assets.interpret.parNtscWide', 'D1/DV NTSC Widescreen (1.21)'), value: 1.21 },
    { label: t('assets.interpret.parPalWide', 'D1/DV PAL Widescreen (1.46)'), value: 1.46 },
    { label: 'HDV / DVCPRO HD 1080 (1.333)', value: 1.333333 },
    { label: t('assets.interpret.parAnamorphic', 'Anamorphic 2:1 (2.0)'), value: 2.0 },
  ];
}

/** Interpret Footage > Color > Assign Profile (RenderColorSpace names), grouped as AE's menu reads. */
function colorProfiles(): Array<{ group: string; items: Array<{ value: string; label: string }> }> {
  return [
    { group: t('assets.interpret.color.display', 'Display'), items: [
      { value: 'srgb', label: 'sRGB IEC61966-2.1' },
      { value: 'rec709', label: 'Rec. 709 (gamma 2.4)' },
      { value: 'displayP3', label: 'Display P3' },
      { value: 'rec2020', label: 'Rec. 2020 (gamma 2.4)' },
    ] },
    { group: t('assets.interpret.color.hdr', 'HDR'), items: [
      { value: 'rec2100Pq', label: 'Rec. 2100 PQ' },
      { value: 'rec2100Hlg', label: 'Rec. 2100 HLG' },
    ] },
    { group: t('assets.interpret.color.linear', 'Linear / ACES'), items: [
      { value: 'linearSrgb', label: t('assets.interpret.color.linearSrgb', 'Linear sRGB (Rec. 709)') },
      { value: 'linearDisplayP3', label: t('assets.interpret.color.linearP3', 'Linear Display P3') },
      { value: 'linearRec2020', label: t('assets.interpret.color.linear2020', 'Linear Rec. 2020') },
      { value: 'acesCg', label: 'ACEScg' },
      { value: 'acesCct', label: 'ACEScct' },
      { value: 'aces2065', label: 'ACES2065-1' },
    ] },
    { group: t('assets.interpret.color.camera', 'Camera log'), items: [
      { value: 'arriLogC3', label: 'ARRI LogC3 (EI 800)' },
      { value: 'arriLogC4', label: 'ARRI LogC4' },
      { value: 'sLog3SGamut3', label: 'Sony S-Log3 / S-Gamut3' },
      { value: 'sLog3SGamut3Cine', label: 'Sony S-Log3 / S-Gamut3.Cine' },
      { value: 'vLogVGamut', label: 'Panasonic V-Log / V-Gamut' },
      { value: 'log3G10RedWideGamut', label: 'RED Log3G10 / REDWideGamutRGB' },
      { value: 'canonLog3CinemaGamut', label: 'Canon Log 3 / Cinema Gamut' },
      { value: 'appleLog', label: 'Apple Log' },
      { value: 'bmdFilmGen5', label: 'Blackmagic Film Gen 5' },
      { value: 'davinciIntermediate', label: 'DaVinci Intermediate' },
    ] },
  ];
}

function findParPreset(val: number): string {
  const match = parPresets().find((p) => Math.abs(p.value - val) < 0.01);
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

  const [colorProfile, setColorProfile] = useState<string>(currentInterpret.colorProfile ?? 'auto');
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
    setPulldownStatus(t('assets.interpret.analyzing40', 'Analyzing 40 frames…'));
    try {
      const report = await probePulldown(asset.src, (f) =>
        setPulldownStatus(t('assets.interpret.analyzingPct', 'Analyzing… {pct}%', { pct: Math.round(f * 100) })));
      if (report.telecine && report.phase !== null) {
        // A positive detect arms the removal itself: the decode path re-weaves
        // whole 23.976 film frames, so field separation is switched off rather
        // than on — bobbing progressive frames would only halve their detail.
        setPulldownPhase(report.phase);
        setFieldsMode('off');
        setPulldownStatus(
          t(
            'assets.interpret.pulldownDetected',
            '3:2 pulldown detected (confidence {confidence}%, {repeats} field repeats / {transitions} transitions). Remove Pulldown armed at phase {phase} — playback now re-weaves whole progressive film frames.',
            {
              confidence: (report.confidence * 100).toFixed(0),
              repeats: report.repeats,
              transitions: report.transitions,
              phase: pulldownPhaseLabel(report.phase),
            },
          ),
        );
      } else {
        setPulldownStatus(
          t(
            'assets.interpret.noCadence',
            'No 3:2 cadence found (confidence {confidence}%). This looks progressive or natively interlaced.',
            { confidence: (report.confidence * 100).toFixed(0) },
          ),
        );
      }
    } catch (err) {
      setPulldownStatus(t('assets.interpret.detectFailed', 'Detection failed: {error}', { error: (err as Error).message }));
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
      colorProfile: colorProfile === 'auto' ? undefined : colorProfile,
    };

    // Read the item as it is NOW (the dialog is floating; it may have changed).
    // B4: the stored interpretation from the document mirror (`itemAsset` inverts ItemInfo.interpretation:
    // `auto` alpha reads as unset, an NTSC conform rate as the typed three decimals), so the patch is a diff
    // against what is stored.
    const info = documentMirror().item(asset.id);
    const live = (info ? itemAsset(info) : null) ?? asset;
    void interpretFootageEdit(live, patch);
    close();
  };

  return (
    <div className={styles.modalBody}>
      {/* ── Frame Rate ── */}
      <div className={styles.section}>
        <h4 className={styles.sectionTitle}>{t('assets.interpret.frameRate', 'Frame Rate')}</h4>
        <div className={styles.radioGroup}>
          <label className={styles.radioLabel}>
            <input
              type="radio"
              name="fps_mode"
              checked={!useConform}
              onChange={() => setUseConform(false)}
            />
            <span>
              {probedFps
                ? t('assets.interpret.useFileFps', 'Use frame rate from file ({fps} fps)', { fps: probedFps % 1 === 0 ? probedFps : probedFps.toFixed(3) })
                : t('assets.interpret.useFileFpsUnprobed', 'Use frame rate from file (unprobed / comp default)')}
            </span>
          </label>

          <label className={styles.radioLabel}>
            <input
              type="radio"
              name="fps_mode"
              checked={useConform}
              onChange={() => setUseConform(true)}
            />
            <span>{t('assets.interpret.conformTo', 'Conform to frame rate:')}</span>
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
          {t('assets.interpret.conformHint', 'Conforming changes playback speed without dropping frames (e.g. 60fps conform to 24fps creates smooth slow-motion).')}
        </p>
      </div>

      {/* ── Pixel Aspect Ratio ── */}
      <div className={styles.section}>
        <h4 className={styles.sectionTitle}>{t('assets.interpret.par', 'Pixel Aspect Ratio')}</h4>
        <select
          className={styles.select}
          value={parPreset}
          onChange={(e) => {
            const v = e.target.value;
            setParPreset(v);
            if (v !== 'custom') setCustomPar(parseFloat(v));
          }}
        >
          {parPresets().map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
          <option value="custom">{t('assets.interpret.custom', 'Custom…')}</option>
        </select>

        {parPreset === 'custom' && (
          <div className={styles.inlineInput} style={{ marginTop: 6, marginLeft: 0 }}>
            <span>{t('assets.interpret.aspectRatio', 'Aspect ratio:')}</span>
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
          <h4 className={styles.sectionTitle}>{t('assets.interpret.alpha', 'Alpha Channel')}</h4>
          <select
            className={styles.select}
            value={alphaMode}
            onChange={(e) => setAlphaMode(e.target.value as AlphaInterpretation)}
          >
            <option value="straight">{t('assets.interpret.straight', 'Straight (Unmatted)')}</option>
            <option value="premultiplied">{t('assets.interpret.premultiplied', 'Premultiplied (Matted With Black)')}</option>
          </select>
          <p className={styles.hint}>
            {t('assets.interpret.alphaHint', 'Straight is standard for PNG, ProRes 4444 and WebM. Premultiplied prevents black fringing on rendered elements.')}
          </p>
        </div>
      )}

      {/* ── Color ▸ Assign Profile ── */}
      {asset.type !== 'audio' && (
        <div className={styles.section}>
          <h4 className={styles.sectionTitle}>{t('assets.interpret.color', 'Color')}</h4>
          <select
            className={styles.select}
            value={colorProfile}
            aria-label={t('assets.interpret.assignProfile', 'Assign profile')}
            onChange={(e) => setColorProfile(e.target.value)}
          >
            <option value="auto">{t('assets.interpret.color.auto', 'From the file (embedded / tagged)')}</option>
            {colorProfiles().map((g) => (
              <optgroup key={g.group} label={g.group}>
                {g.items.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </optgroup>
            ))}
          </select>
          <p className={styles.hint}>
            {t('assets.interpret.colorHint', 'Assign the profile the camera recorded in (log footage, HDR, Display P3). It is converted into the working space under colour management (File ▸ Project Settings ▸ Color).')}
          </p>
        </div>
      )}

      {/* ── Fields (interlaced sources only — video, not stills) ── */}
      {asset.type === 'video' && (
        <div className={styles.section}>
          <h4 className={styles.sectionTitle}>{t('assets.interpret.separateFields', 'Separate Fields')}</h4>
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
            <option value="off">{t('assets.interpret.fieldsOff', 'Off (progressive)')}</option>
            <option value="upper">{t('assets.interpret.upperFirst', 'Upper Field First')}</option>
            <option value="lower">{t('assets.interpret.lowerFirst', 'Lower Field First')}</option>
          </select>
          <p className={styles.hint}>
            {t(
              'assets.interpret.fieldsHint',
              'For interlaced tape-era footage showing comb teeth on motion. Files don\'t record field order — DV is lower-first, most broadcast HD upper-first. Leave off for modern files.',
            )}
          </p>
          <h4 className={styles.sectionTitle} style={{ marginTop: 10 }}>{t('assets.interpret.removePulldown', 'Remove Pulldown')}</h4>
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
            <option value="off">{t('assets.interpret.off', 'Off')}</option>
            {[0, 1, 2, 3, 4].map((p) => (
              <option key={p} value={String(p)}>
                {pulldownPhaseLabel(p)}
              </option>
            ))}
          </select>
          <p className={styles.hint}>
            {t(
              'assets.interpret.pulldownHint',
              'Inverse telecine for 29.97 video mastered from 24 fps film: re-weaves whole progressive film frames from the 3:2 field cadence. Use Detect below to find the phase automatically.',
            )}
          </p>
          {canProbePulldown() && (
            <button
              type="button"
              className={styles.select}
              style={{ cursor: 'pointer', marginTop: 6 }}
              disabled={detecting}
              onClick={() => void onDetectPulldown()}
              title={t('assets.interpret.detectTitle', 'Decode a short window and look for the 3:2 telecine field cadence')}
            >
              {detecting ? t('assets.interpret.detecting', 'Detecting…') : t('assets.interpret.detect', 'Detect 3:2 Pulldown')}
            </button>
          )}
          {pulldownStatus && (
            <p className={styles.hint} role="status">{pulldownStatus}</p>
          )}
        </div>
      )}

      {/* ── Other Options / Looping ── */}
      <div className={styles.section}>
        <h4 className={styles.sectionTitle}>{t('assets.interpret.otherOptions', 'Other Options')}</h4>
        <div className={styles.inlineInput} style={{ marginLeft: 0 }}>
          <span>{t('assets.interpret.loop', 'Loop:')}</span>
          <input
            type="number"
            className={styles.numberInput}
            step="1"
            min="0"
            max="9999"
            value={loopCount}
            onChange={(e) => setLoopCount(parseInt(e.target.value, 10) || 0)}
          />
          <span>{loopCount === 0 ? t('assets.interpret.timesInfinite', 'Times (Infinite Loop)') : t('assets.interpret.times', 'Times')}</span>
        </div>
      </div>

      {/* ── Actions ── */}
      <div className={styles.footer}>
        <Button size="sm" variant="secondary" onClick={close}>
          {t('assets.interpret.cancel', 'Cancel')}
        </Button>
        <Button size="sm" variant="primary" onClick={handleSave}>
          {t('assets.interpret.ok', 'OK')}
        </Button>
      </div>
    </div>
  );
}

/** Open the After Effects Interpret Footage modal for one asset. */
export function openInterpretFootage(asset: ImportedAsset): void {
  openModal({
    id: `interpret-footage-${asset.id}`,
    title: t('assets.interpret.title', 'Interpret Footage: {name}', { name: asset.name }),
    size: 'md',
    // Floating: compare the interpreted clip against the viewport while the
    // fields are still open.
    variant: 'floating',
    render: (close) => <InterpretFootageBody asset={asset} close={close} />,
  });
}
