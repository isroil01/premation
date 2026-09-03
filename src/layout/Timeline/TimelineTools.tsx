/**
 * The timeline's EDIT TOOLS — a segmented row of five buttons that says which
 * NLE edit a drag on a clip performs.
 *
 * ## Why a visible row and not just the modifiers
 *
 * Slip (Alt-drag) and slide (Alt+Shift-drag) shipped and then sat unused,
 * because nothing anywhere said they existed: no button, no tooltip, no menu
 * row. The only discovery path was holding a modifier over a bar and noticing
 * the cursor. Roll had no gesture at all, and razor meant moving the playhead
 * first. Five lit buttons make the whole family visible at once and give each
 * one a place to advertise its shortcut.
 *
 * ## Where it renders
 *
 * Inside `<Timeline>`'s own header row, spanning the panel — not in
 * `ViewportTools`, which lives in the transport bar and is about the
 * composition (3D switch, auto-keyframe, view options). These are about the
 * TIMELINE's clips and belong to the panel that owns them; a mode armed in one
 * panel and shown in another is how a razor gets left on.
 *
 * The buttons are a `radiogroup`, because that is exactly what they are — one
 * of five, always exactly one. Arrow keys move between them for free.
 */

import { useEffect } from 'react';
import { Icon } from '@components/Icon';
import { cn } from '@utils/cn';
import {
  TIMELINE_EDIT_MODES,
  installTimelineEditModeCommands,
  useTimelineEditModeStore,
} from './timelineEditMode';
import styles from './TimelineTools.module.css';

export function TimelineTools(): JSX.Element {
  const mode = useTimelineEditModeStore((s) => s.mode);
  const setMode = useTimelineEditModeStore((s) => s.setMode);

  // Registered from here rather than the app's boot block so the feature is one
  // self-contained unit — same reasoning (and same idempotence) as
  // `installTimelineFitCommands`, which `TimelineZoom` installs the same way.
  useEffect(() => installTimelineEditModeCommands(), []);

  return (
    <div className={styles.tools} role="radiogroup" aria-label="Timeline edit tool">
      {TIMELINE_EDIT_MODES.map((def) => {
        const active = mode === def.mode;
        return (
          <button
            key={def.mode}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={`${def.label} tool`}
            className={cn(styles.toolBtn, active && styles.toolBtnActive)}
            // The description carries its weight here: these five gestures are
            // indistinguishable from each other by icon, and a tooltip that
            // only repeated the name would leave the user exactly as stuck.
            title={`${def.label} (${def.chord}) — ${def.description}`}
            onClick={() => setMode(def.mode)}
          >
            <Icon name={def.icon} size="sm" />
          </button>
        );
      })}
      {/* What the armed tool does, spelled out. An icon row with no label is a
          puzzle the first time; the word costs one slot and the row collapses
          it away before it drops any button (see the container query). */}
      <span className={styles.modeLabel}>
        {TIMELINE_EDIT_MODES.find((d) => d.mode === mode)?.label}
      </span>
    </div>
  );
}

export default TimelineTools;
