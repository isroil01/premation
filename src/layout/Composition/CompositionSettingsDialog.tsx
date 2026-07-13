/**
 * CompositionSettingsDialog (Prompt E1) — edit the composition's name, size,
 * frame rate, duration and BACKGROUND (the background was previously hardcoded
 * to a near-black constant). Also exposes the pasteboard (canvas surround)
 * colour under an "Environment" section.
 *
 * Writes flow to the compositionStore (render pipeline reads it live) and, for
 * fps/duration, into the TimelineController so the time domain stays consistent.
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
import { getTimelineController } from '@core/timeline/TimelineController';
import { getPasteboardColor, setPasteboardColor } from '@core/theme/pasteboard';
import styles from './CompositionSettingsDialog.module.css';

/** Common frame rates offered as quick chips. */
const FPS_PRESETS = [24, 25, 30, 50, 60] as const;

function CompositionSettings({ close }: { close: () => void }): JSX.Element {
  const s = useCompositionStore();
  const [pasteboard, setPasteboard] = useState<string>(() => getPasteboardColor());

  const setName = (name: string): void => s.update({ name });
  const setWidth = (width: number): void => s.update({ width });
  const setHeight = (height: number): void => s.update({ height });
  const setFps = (fps: number): void => {
    s.update({ fps });
    getTimelineController().setFrameRate(useCompositionStore.getState().fps);
  };
  const setDuration = (durationSeconds: number): void => {
    s.update({ durationSeconds });
    getTimelineController().setDurationSeconds(useCompositionStore.getState().durationSeconds);
  };
  const applyPasteboard = (color: string): void => {
    setPasteboard(color);
    setPasteboardColor(color);
  };

  return (
    <div className={styles.root}>
      {/* Name */}
      <div className={styles.section}>
        <div className={styles.label}>Name</div>
        <Input value={s.name} onChange={(e) => setName(e.target.value)} aria-label="Composition name" />
      </div>

      {/* Size */}
      <div className={styles.section}>
        <div className={styles.label}>Size</div>
        <div className={styles.row}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Width</span>
            <ValueField value={s.width} onChange={setWidth} min={1} max={16384} step={1} unit="px" aria-label="Width" />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Height</span>
            <ValueField value={s.height} onChange={setHeight} min={1} max={16384} step={1} unit="px" aria-label="Height" />
          </label>
        </div>
      </div>

      {/* Frame rate + duration */}
      <div className={styles.section}>
        <div className={styles.label}>Frame rate & duration</div>
        <div className={styles.row}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Frame rate</span>
            <ValueField value={s.fps} onChange={setFps} min={1} max={240} step={1} unit="fps" aria-label="Frame rate" />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Duration</span>
            <ValueField value={s.durationSeconds} onChange={setDuration} min={0.1} max={3600} step={0.5} unit="s" aria-label="Duration" />
          </label>
        </div>
        <div className={styles.chips}>
          {FPS_PRESETS.map((f) => (
            <button
              key={f}
              type="button"
              className={f === s.fps ? styles.chipOn : styles.chip}
              onClick={() => setFps(f)}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {/* Background */}
      <div className={styles.section}>
        <div className={styles.label}>Background</div>
        <div className={styles.bgRow}>
          <ColorPicker
            value={s.background}
            onChange={s.setBackground}
            className={styles.colorTrigger}
            aria-label="Background color"
          />
          <Switch
            checked={s.transparent}
            onChange={(e) => s.setTransparent(e.target.checked)}
            label="Transparent"
          />
        </div>
        {s.transparent ? (
          <p className={styles.hint}>The comp has no background — exports keep an alpha channel.</p>
        ) : null}
      </div>

      {/* Environment (pasteboard surround) */}
      <div className={styles.section}>
        <div className={styles.label}>Environment</div>
        <div className={styles.bgRow}>
          <ColorPicker
            value={pasteboard || '#0a0a0b'}
            onChange={applyPasteboard}
            className={styles.colorTrigger}
            aria-label="Pasteboard color"
          />
          <Button variant="ghost" size="sm" onClick={() => applyPasteboard('')} disabled={!pasteboard}>
            Reset to theme
          </Button>
        </div>
        <p className={styles.hint}>The area around the composition. Empty follows the current theme.</p>
      </div>

      <div className={styles.footer}>
        <Button variant="primary" size="md" leftIcon={<Icon name="check" size={14} />} onClick={close}>
          Done
        </Button>
      </div>
    </div>
  );
}

/** Open the Composition Settings dialog as a modal. */
export function openCompositionSettings(): void {
  openModal({
    id: 'composition-settings',
    title: 'Composition settings',
    size: 'sm',
    render: (close) => <CompositionSettings close={close} />,
  });
}
