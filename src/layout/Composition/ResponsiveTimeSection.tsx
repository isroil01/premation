/**
 * Protected time regions — the marking UI for M7.
 *
 * ── Two things this deliberately does ────────────────────────────────
 *
 * 1. CLAMPS AT THE INTERACTION, not after it. Every edit goes through
 *    `clampRegionEdge` before it is written, so a region set that overlaps or
 *    inverts is never constructed. Validating afterwards would mean
 *    `normalizeRegions` silently MERGES two regions while the user is still
 *    looking at two sets of handles for them.
 *
 * 2. SHOWS THE AUTHORED DURATION. It is captured when regions are marked and
 *    never re-derived — that is what makes the stretch mean anything — but it
 *    also means a template stretched to 3× behaves according to a number the
 *    user cannot otherwise see. When the stretch does something surprising,
 *    that number is the explanation, so it is on screen next to the current
 *    duration and the stretch factor it implies.
 */

import { Icon } from '@components/Icon';
import { ValueField } from '@components/ValueField';
import { useCompositionStore } from '@stores/compositionStore';
import { useSceneRevision } from '@stores/sceneStore';
import { activeCompRootId } from '@core/scene/activeComp';
import {
  readResponsiveTime,
  setResponsiveTime,
} from '@core/template/responsiveTimeStore';
import {
  clampRegionEdge,
  proposeRegion,
  protectedTotal,
  normalizeRegions,
  MIN_REGION_SEC,
  type ProtectedRegion,
} from '@core/template/responsiveTime';
import styles from './CompositionSettingsDialog.module.css';

export function ResponsiveTimeSection(): JSX.Element {
  useSceneRevision((r) => r.rev);
  const comp = useCompositionStore();
  const rootId = activeCompRootId();
  const cfg = readResponsiveTime(rootId);

  const regions = cfg?.protectedRegions ?? [];
  const authored = cfg?.authoredDurationSec ?? comp.durationSeconds;
  const current = comp.durationSeconds;
  const protectedSec = protectedTotal(normalizeRegions(regions, authored));
  const flexAuthored = Math.max(0, authored - protectedSec);
  const flexCurrent = Math.max(0, current - protectedSec);
  const stretch = flexAuthored > 1e-9 ? flexCurrent / flexAuthored : 1;

  const write = (next: ProtectedRegion[]): void => {
    setResponsiveTime(rootId, next.length > 0
      ? { authoredDurationSec: authored, protectedRegions: next }
      : undefined);
  };

  const enable = (): void => {
    const first = proposeRegion([], comp.durationSeconds);
    if (first) {
      // Capture the authored duration HERE — at the moment of marking — not on
      // every write. Re-deriving it later would make the map an identity
      // forever, because authored and current would always be equal.
      setResponsiveTime(rootId, {
        authoredDurationSec: comp.durationSeconds,
        protectedRegions: [first],
      });
    }
  };

  const addRegion = (): void => {
    const made = proposeRegion(regions, authored);
    if (made) write([...regions, made].sort((a, b) => a.startSec - b.startSec));
  };

  const editEdge = (index: number, edge: 'start' | 'end', value: number): void => {
    const clamped = clampRegionEdge(regions, index, edge, value, authored);
    write(regions.map((r, i) => (i === index ? { ...r, [`${edge}Sec`]: clamped } : r)));
  };

  const removeRegion = (index: number): void => {
    write(regions.filter((_, i) => i !== index));
  };

  if (!cfg) {
    return (
      <div className={styles.section}>
        <div className={styles.label}>Responsive Time</div>
        <p className={styles.hint}>
          Mark spans that must keep their duration when this composition is
          stretched — an intro and an outro, typically. Everything outside them
          absorbs the change, so one lower-third works at any length.
        </p>
        <button type="button" className={styles.segmentBtn} onClick={enable}>
          <Icon name="plus" size="sm" /> Mark a protected region
        </button>
      </div>
    );
  }

  const noRoom = proposeRegion(regions, authored) === null;

  return (
    <div className={styles.section}>
      <div className={styles.label}>Responsive Time</div>

      {/* The invisible number, made visible. */}
      <div className={styles.rowThree}>
        <div className={styles.field}>
          <div className={styles.fieldLabel}>Authored at</div>
          <div className={styles.readout}>{authored.toFixed(2)}s</div>
        </div>
        <div className={styles.field}>
          <div className={styles.fieldLabel}>Current</div>
          <div className={styles.readout}>{current.toFixed(2)}s</div>
        </div>
        <div className={styles.field}>
          <div className={styles.fieldLabel}>Middle stretch</div>
          <div className={styles.readout}>{stretch.toFixed(2)}×</div>
        </div>
      </div>

      <p className={styles.hint}>
        {protectedSec.toFixed(2)}s protected · {flexAuthored.toFixed(2)}s flexible,
        playing at {stretch.toFixed(2)}×.
        {current < protectedSec && ' Shorter than the protected total, so the composition runs long rather than crushing marked animation.'}
      </p>

      {regions.map((r, i) => (
        <div key={`${i}-${r.startSec}`} className={styles.row}>
          <div className={styles.field}>
            <div className={styles.fieldLabel}>Start</div>
            <ValueField
              value={r.startSec}
              onChange={(v) => editEdge(i, 'start', v)}
              min={0}
              max={authored}
              step={0.05}
              unit="s"
              aria-label={`Protected region ${i + 1} start`}
            />
          </div>
          <div className={styles.field}>
            <div className={styles.fieldLabel}>End</div>
            <ValueField
              value={r.endSec}
              onChange={(v) => editEdge(i, 'end', v)}
              min={MIN_REGION_SEC}
              max={authored}
              step={0.05}
              unit="s"
              aria-label={`Protected region ${i + 1} end`}
            />
          </div>
          <button
            type="button"
            className={styles.segmentBtn}
            onClick={() => removeRegion(i)}
            aria-label={`Remove protected region ${i + 1}`}
          >
            <Icon name="trash" size="sm" />
          </button>
        </div>
      ))}

      <button
        type="button"
        className={styles.segmentBtn}
        onClick={addRegion}
        disabled={noRoom}
        title={noRoom ? 'No unprotected gap large enough for another region' : undefined}
      >
        <Icon name="plus" size="sm" /> Add region
      </button>
    </div>
  );
}
