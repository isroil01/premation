/**
 * "Animate selection" — the motion features, where someone will find them.
 *
 * Choreography, beat-synced timing, speed ramps and Smart Animate all shipped
 * as commands and menu entries, which means they were reachable only by people
 * who already knew they existed. This is the discovery surface.
 *
 * ── It drives the COMMANDS, not the code underneath ────────────────
 * Every button resolves a command by id and calls its `execute`. Re-calling
 * `animateLayers` or `smartAnimateBetween` directly would be shorter and would
 * slowly drift: the toast, the seed, the frame rate and the feel are decided
 * inside those command bodies, and a second caller means a second set of
 * decisions to keep in step. Reading `enabled()` from the same place is what
 * makes a greyed button here mean exactly what a greyed entry means in the
 * palette.
 *
 * ── Absent, not broken ─────────────────────────────────────────────
 * A row whose command cannot run is hidden when the reason is structural (no
 * audio layer in the composition, no other board to animate to) and DISABLED
 * with a reason when the reason is the current selection. The difference
 * matters: "there is nothing to do here" and "pick a layer first" are
 * different messages, and showing four dead buttons teaches people the panel
 * is broken.
 *
 * It lives in the Presets panel rather than in one of its own. That panel is
 * already "apply motion to this layer", it is already registered, and a fifth
 * tab for four buttons would be worse than a section at the top of the right
 * one.
 */

import { asCommandId } from '@app-types/common';
import { getCommandRegistry } from '@core/commands/Command';
import { Icon } from '@components/Icon';
import { useSelectionStore } from '@stores/selectionStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { useSceneRevision } from '@stores/sceneStore';
import { useProjectStore } from '@stores/projectStore';
import { findAudioLayer } from '@core/audio/beatGrid';
import { rampTargets } from '@core/animation/speedRampCommands';
import { transitionTargets } from '@core/animation/smartAnimateCommands';
import type { ChoreographyFeel } from '@core/animation/choreography';
import styles from './ChoreographySection.module.css';

const FEELS: ReadonlyArray<{ value: ChoreographyFeel; label: string; hint: string }> = [
  { value: 'snappy', label: 'Snappy', hint: 'Short, tight, close together' },
  { value: 'smooth', label: 'Smooth', hint: 'Longer travel with a soft landing' },
  { value: 'bouncy', label: 'Bouncy', hint: 'Overshoots and settles' },
];

/** Buttons shown before the rest are left to the palette. A board list can be
 *  long, and this section sits above the preset library it must not crowd. */
const MAX_TARGETS = 4;

function run(id: string): void {
  const command = getCommandRegistry().get(asCommandId(id));
  void command?.execute({} as never);
}

function canRun(id: string): boolean {
  const command = getCommandRegistry().get(asCommandId(id));
  if (!command) return false;
  return command.enabled ? command.enabled() !== false : true;
}

export function ChoreographySection(): JSX.Element {
  // Both stores are read so the buttons re-evaluate as things change: the
  // selection drives most `enabled()` checks, and the scene revision covers
  // layers being added or deleted underneath a stale render.
  const selected = useSelectionStore((s) => s.ids);
  const feel = usePreferenceStore((s) => s.motionFeel ?? 'smooth');
  // Subscribed to, not read: both are what make the rows below re-evaluate.
  // The scene revision covers layers appearing or going, and the comps map
  // covers a board being created, renamed or deleted.
  useSceneRevision((s) => s.rev);
  useProjectStore((s) => s.comps);

  // Derived on every render rather than memoised. They read live stores that
  // are NOT in any dependency array — a `useMemo` here would need the stores
  // themselves as deps, which is how the first version ended up calling a hook
  // inside a dependency list. These are three cheap array walks; correctness
  // is worth more than skipping them.
  const hasSelection = selected.length > 0;
  const hasAudio = findAudioLayer() !== undefined;
  const canRamp = rampTargets().length > 0;
  const targets = transitionTargets();

  return (
    <div className={styles.root}>
      <div className={styles.heading}>
        <Icon name="sparkles" size="sm" />
        <span>Animate selection</span>
      </div>

      <div className={styles.feelRow} role="group" aria-label="Motion feel">
        {FEELS.map((option) => (
          <button
            key={option.value}
            type="button"
            className={styles.feelButton}
            data-active={feel === option.value}
            title={option.hint}
            aria-pressed={feel === option.value}
            onClick={() => run(`animation.motionFeel.${option.value}`)}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.action}
          disabled={!canRun('animation.animateIn')}
          title={hasSelection
            ? 'Stagger the selected layers in, one after another'
            : 'Select some layers first'}
          onClick={() => run('animation.animateIn')}
        >
          Animate In
        </button>
        <button
          type="button"
          className={styles.action}
          disabled={!canRun('animation.animateOut')}
          title={hasSelection ? 'Stagger the selected layers out' : 'Select some layers first'}
          onClick={() => run('animation.animateOut')}
        >
          Animate Out
        </button>
      </div>

      {/* Hidden rather than disabled: with no audio in the composition there is
          nothing to beat-sync to, and a permanently dead row is noise. */}
      {hasAudio && (
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.action}
            disabled={!canRun('animation.animateInOnBeats')}
            title={hasSelection
              ? 'One layer per beat of the audio layer'
              : 'Select some layers first'}
            onClick={() => run('animation.animateInOnBeats')}
          >
            In, on the beat
          </button>
          <button
            type="button"
            className={styles.action}
            title="Mark every beat of the audio layer on the timeline"
            onClick={() => run('audio.markBeats')}
          >
            Mark beats
          </button>
        </div>
      )}

      {canRamp && (
        <>
          <div className={styles.subheading}>Speed ramp</div>
          <div className={styles.actions}>
            {[
              { id: 'quarter', label: '25%' },
              { id: 'half', label: '50%' },
              { id: 'normal', label: '100%' },
              { id: 'freeze', label: 'Freeze' },
            ].map((step) => (
              <button
                key={step.id}
                type="button"
                className={styles.action}
                title={`Ease to ${step.label} at the playhead`}
                onClick={() => run(`time.speedRamp.${step.id}`)}
              >
                {step.label}
              </button>
            ))}
          </div>
        </>
      )}

      {targets.length > 0 && (
        <>
          <div className={styles.subheading}>Smart Animate</div>
          <p className={styles.hint}>
            Build a transition to another board. Layers pair up by name.
          </p>
          <div className={styles.actions}>
            {targets.slice(0, MAX_TARGETS).map((target) => (
              <button
                key={target.id}
                type="button"
                className={styles.action}
                title={`Animate this composition into “${target.name}”`}
                onClick={() => run(`comp.smartAnimate.${target.id}`)}
              >
                → {target.name}
              </button>
            ))}
          </div>
          {/* Never truncate silently: four buttons in a project with nine
              boards looks like the complete list unless it says otherwise. */}
          {targets.length > MAX_TARGETS && (
            <p className={styles.hint}>
              {targets.length - MAX_TARGETS} more — search “Smart Animate” in the command palette.
            </p>
          )}
        </>
      )}
    </div>
  );
}

export default ChoreographySection;
