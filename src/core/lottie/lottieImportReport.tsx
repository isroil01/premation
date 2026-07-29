/**
 * One place that tells the user what a Lottie import actually did.
 *
 * Both entry points (the File menu and the Library panel's import button) used
 * to hand-roll the same toast, and both showed the warning COUNT — "Imported 23
 * layers (2 warnings)" — while throwing the warning strings away. So a file
 * could come in with its gradients flattened, its masks dropped and its trim
 * paths ignored, and the only signal was a number. The planner knows exactly
 * what it could not carry across; this shows it.
 *
 * Success with nothing lost stays a plain toast — no dialog for a clean import.
 */

import { openModal } from '@stores/modalStore';
import { useUIStore } from '@stores/uiStore';
import { Button } from '@components/Button';
import { Icon } from '@components/Icon';

export interface LottieImportOutcome {
  nodeIds: readonly string[];
  warnings: readonly string[];
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The "what didn't come across" dialog. */
function openReport(fileLabel: string, layerCount: number, warnings: readonly string[]): void {
  openModal({
    title: (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Icon name="warning" size={18} style={{ color: 'var(--color-warning, #f59e0b)' }} />
        <span>Import report</span>
      </div>
    ),
    size: 'md',
    render: (close) => (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <p style={{ margin: 0, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
          Imported <strong style={{ color: 'var(--color-text-primary)' }}>{plural(layerCount, 'layer')}</strong> from{' '}
          <strong style={{ color: 'var(--color-text-primary)' }}>{fileLabel}</strong>. Lottie describes some things this
          editor renders differently — here is everything that did not come across exactly:
        </p>
        <ul
          style={{
            margin: 0,
            padding: '10px 10px 10px 26px',
            maxHeight: 280,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            background: 'var(--color-surface-1)',
            border: '1px solid var(--color-border-subtle)',
            borderRadius: 'var(--radius-sm)',
            fontSize: 'var(--font-size-xs)',
            lineHeight: 1.55,
            color: 'var(--color-text-secondary)',
          }}
        >
          {warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button variant="primary" size="sm" onClick={close}>
            Got it
          </Button>
        </div>
      </div>
    ),
  });
}

/**
 * Report the outcome of an import: a toast always, plus the detail dialog when
 * something was lost. `fileLabel` names what was imported (a file name, or a
 * library item's name).
 */
export function reportLottieImport(fileLabel: string, outcome: LottieImportOutcome): void {
  const { notify } = useUIStore.getState();
  const n = outcome.nodeIds.length;
  if (n === 0) {
    notify({ level: 'warning', message: `“${fileLabel}” imported no layers — nothing in it could be converted.`, durationMs: 4000 });
    return;
  }
  if (outcome.warnings.length === 0) {
    notify({ level: 'success', message: `Imported ${plural(n, 'layer')} from “${fileLabel}”`, durationMs: 2600 });
    return;
  }
  notify({
    level: 'warning',
    message: `Imported ${plural(n, 'layer')} — ${plural(outcome.warnings.length, 'thing')} did not come across`,
    durationMs: 4000,
  });
  openReport(fileLabel, n, outcome.warnings);
}

/** Failure path — the file could not be parsed at all. */
export function reportLottieImportFailure(fileLabel: string, err: unknown): void {
  const detail = err instanceof Error && err.message ? `: ${err.message}` : '';
  useUIStore.getState().notify({
    level: 'error',
    message: `Could not import “${fileLabel}”${detail}`,
    durationMs: 5000,
  });
}
