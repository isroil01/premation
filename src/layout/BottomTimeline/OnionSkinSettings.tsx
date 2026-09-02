/**
 * Onion-skin settings popover.
 *
 * `onionSkinStore` has always exposed before / after / step / opacity, with
 * clamps written specifically so a UI could hand it junk (`ONION_MAX_SIDE`,
 * `ONION_MAX_STEP`) — and the timeline wired `toggle()` only. So the toggle
 * turned on whatever the defaults happened to be, permanently: 2 ghosts each
 * side at every frame, with no way to reach the numbers the store was clamping
 * for. This is that UI.
 *
 * A popover on a chevron beside the toggle rather than a Preferences page,
 * because these are working values you change WHILE looking at the ghosts —
 * the store's own comment says so ("per-session working values, like a tool's
 * current settings").
 */

import { Popover } from '@components/Popover';
import { Icon } from '@components/Icon';
import { Slider } from '@components/Slider';
import { Switch } from '@components/Switch';
import { ValueField } from '@components/ValueField';
import { useOnionSkinStore, ONION_MAX_SIDE, ONION_MAX_STEP } from '@stores/onionSkinStore';
import styles from './OnionSkinSettings.module.css';

export function OnionSkinSettingsPopover({ className }: { className?: string }): JSX.Element {
  const before = useOnionSkinStore((s) => s.before);
  const after = useOnionSkinStore((s) => s.after);
  const step = useOnionSkinStore((s) => s.step);
  const opacity = useOnionSkinStore((s) => s.opacity);
  const colorize = useOnionSkinStore((s) => s.colorize);
  const set = useOnionSkinStore((s) => s.set);

  return (
    <Popover
      placement="top-end"
      className={styles.pop}
      trigger={
        <button
          type="button"
          className={className}
          title="Onion Skin Settings"
          aria-label="Onion Skin Settings"
          aria-haspopup="dialog"
        >
          <Icon name="chevron-up" size="sm" />
        </button>
      }
    >
      <div className={styles.body}>
        <div className={styles.title}>Onion Skin</div>

        <div className={styles.row}>
          <span className={styles.label}>Before</span>
          <ValueField
            value={before}
            onChange={(v) => set({ before: v })}
            min={0}
            max={ONION_MAX_SIDE}
            step={1}
            precision={0}
            aria-label="Ghosts before the playhead"
          />
        </div>

        <div className={styles.row}>
          <span className={styles.label}>After</span>
          <ValueField
            value={after}
            onChange={(v) => set({ after: v })}
            min={0}
            max={ONION_MAX_SIDE}
            step={1}
            precision={0}
            aria-label="Ghosts after the playhead"
          />
        </div>

        <div className={styles.row}>
          <span className={styles.label}>Step</span>
          <ValueField
            value={step}
            onChange={(v) => set({ step: v })}
            min={1}
            max={ONION_MAX_STEP}
            step={1}
            precision={0}
            aria-label="Frames between ghosts"
          />
        </div>

        <div className={styles.rowWide}>
          <span className={styles.label}>Opacity</span>
          <Slider
            value={Math.round(opacity * 100)}
            min={0}
            max={100}
            step={1}
            showValue
            aria-label="Nearest ghost opacity"
            onChange={(v) => set({ opacity: v / 100 })}
          />
        </div>

        <div className={styles.row}>
          <span className={styles.label}>Colorize</span>
          <Switch
            checked={colorize}
            onChange={(e) => set({ colorize: e.currentTarget.checked })}
            aria-label="Tint past and future ghosts"
          />
        </div>

        {/* Each ghost is a FULL comp render, which is why the store caps the
            counts. Saying the number out loud is cheaper than a user wondering
            why the viewport got slow. */}
        <p className={styles.note}>{before + after + 1} comp renders per repaint</p>
      </div>
    </Popover>
  );
}
