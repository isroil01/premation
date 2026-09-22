/**
 * What the After Effects import actually did.
 *
 * An AE project is big and this editor is not AE, so an import that carried
 * across 95 % of a file is a success and the remaining 5 % is the part the user
 * needs told. The dialog is built around that: the counts first, so they can be
 * checked against the project open in AE next door, then a plain list of
 * everything that did not survive the trip.
 *
 * A clean import is a toast and nothing more — an importer that opens a
 * dialog on every success teaches people to dismiss dialogs without reading.
 */

import { openModal } from '@stores/modalStore';
import { useUIStore } from '@stores/uiStore';
import { Button } from '@components/Button';
import { Icon } from '@components/Icon';
import { summarizeAepImport, type AepImportResult } from './aepImport';
import { track } from '@core/analytics/productEvents';

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

const listStyle: React.CSSProperties = {
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
};

function openReport(fileLabel: string, result: AepImportResult): void {
  const warnings = result.applied.warnings;
  const expressions = result.plan.comps.flatMap((c) => c.layers.flatMap((l) => l.expressions));

  openModal({
    title: (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Icon name="warning" size="md" style={{ color: 'var(--color-warning, #f59e0b)' }} />
        <span>After Effects import report</span>
      </div>
    ),
    size: 'md',
    render: (close) => (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <p style={{ margin: 0, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
          Opened <strong style={{ color: 'var(--color-text-primary)' }}>{summarizeAepImport(result)}</strong> from{' '}
          <strong style={{ color: 'var(--color-text-primary)' }}>{fileLabel}</strong>
          {result.project.aeVersion ? ` (saved by After Effects ${result.project.aeVersion})` : ''}. Here is everything
          that did not come across exactly:
        </p>
        <ul style={listStyle}>
          {warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
        {expressions.length > 0 && (
          <p style={{ margin: 0, fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
            {plural(expressions.length, 'expression')} came across as text on the properties that carried them. They are
            not evaluated on import — open a property and re-enable its expression to run it here.
          </p>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button variant="primary" size="sm" onClick={close}>
            Got it
          </Button>
        </div>
      </div>
    ),
  });
}

/** Report an import: always a toast, plus the detail dialog when something was lost. */
export function reportAepImport(fileLabel: string, result: AepImportResult): void {
  const { notify } = useUIStore.getState();
  const warnings = result.applied.warnings;
  track('aep_imported', {
    layers: result.project.comps.reduce((n, c) => n + c.layers.length, 0),
    warnings: warnings.length,
  });
  if (warnings.length === 0) {
    notify({ level: 'success', message: `Opened ${summarizeAepImport(result)} from “${fileLabel}”`, durationMs: 3200 });
    return;
  }
  notify({
    level: 'warning',
    message: `Opened ${summarizeAepImport(result)} — ${plural(warnings.length, 'thing')} did not come across`,
    durationMs: 4500,
  });
  openReport(fileLabel, result);
}

/** The file could not be read at all. */
export function reportAepImportFailure(fileLabel: string, message: string): void {
  // The message names the file and quotes its contents; only a code goes out.
  track('import_failed', { kind: 'other', reason: 'aep_unreadable' });
  useUIStore.getState().notify({
    level: 'error',
    message: `Could not open “${fileLabel}” — ${message}`,
    durationMs: 6000,
  });
}
