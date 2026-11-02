/**
 * Help ▸ Report a Problem.
 *
 * One dialog, three states: compose → sending → sent (with the report's
 * number) or an inline error that keeps everything the user typed. The
 * viewport is captured BEFORE the dialog opens (it would otherwise photograph
 * itself) and shown in the side column, where the user can drop or retake it.
 * Everything that will be attached is listed and viewable before Send — the
 * dialog says exactly what leaves the machine, and the project only does when
 * the box is ticked.
 */

import { useEffect, useMemo, useState } from 'react';
import { Button } from '@components/Button';
import { Checkbox } from '@components/Checkbox';
import { Icon } from '@components/Icon';
import { Input } from '@components/Input';
import { Segmented } from '@components/Segmented';
import { useDialogPrimaryAction } from '@components/Modal/Modal';
import { openModal, closeModal } from '@stores/modalStore';
import { useAuthStore } from '@stores/authStore';
import { documentMirror, hasDocumentMirror } from '@stores/documentMirror';
import { t } from '@core/i18n';
import {
  REPORT_CATEGORIES,
  buildReportForm,
  captureViewport,
  collectDiagnostics,
  safeProjectFacts,
  submitReport,
  validateDraft,
  type ProjectSource,
  type ReportCategory,
  type ReportDraft,
  type ReportImpact,
  type ReportResult,
} from './reportProblem';
import styles from './ReportProblemDialog.module.css';

const MODAL_ID = 'report-problem';

function categoryLabel(c: ReportCategory): string {
  switch (c) {
    case 'crash': return t('help.report.cat.crash', 'Crash or freeze');
    case 'rendering': return t('help.report.cat.rendering', 'Viewer / rendering');
    case 'performance': return t('help.report.cat.performance', 'Slow');
    case 'playback': return t('help.report.cat.playback', 'Playback');
    case 'export': return t('help.report.cat.export', 'Export');
    case 'import': return t('help.report.cat.import', 'Import / media');
    case 'text': return t('help.report.cat.text', 'Text');
    case 'effects': return t('help.report.cat.effects', 'Effects');
    case 'audio': return t('help.report.cat.audio', 'Audio');
    case 'ui': return t('help.report.cat.ui', 'Interface');
    case 'plugins': return t('help.report.cat.plugins', 'Plugins');
    case 'account': return t('help.report.cat.account', 'Account / billing');
    case 'other': return t('help.report.cat.other', 'Something else');
  }
}

function projectSource(): ProjectSource | null {
  try {
    return hasDocumentMirror() ? (documentMirror() as unknown as ProjectSource) : null;
  } catch {
    return null;
  }
}

function formatBytes(n: number): string {
  return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

interface BodyProps {
  initialShot: Blob | null;
  close: () => void;
}

type Phase = { kind: 'compose' } | { kind: 'sending' } | { kind: 'sent'; result: ReportResult } | { kind: 'error'; message: string };

export function ReportProblemBody({ initialShot, close }: BodyProps): JSX.Element {
  const accountEmail = useAuthStore((s) => s.user?.email ?? '');
  const [draft, setDraft] = useState<ReportDraft>({
    category: 'rendering',
    impact: 'major',
    summary: '',
    description: '',
    steps: '',
    email: accountEmail,
    includeProject: false,
  });
  const [shot, setShot] = useState<Blob | null>(initialShot);
  const [diagnostics, setDiagnostics] = useState<Record<string, unknown> | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [touched, setTouched] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'compose' });

  useEffect(() => {
    let alive = true;
    void collectDiagnostics().then((d) => alive && setDiagnostics(d));
    return () => {
      alive = false;
    };
  }, []);

  const shotUrl = useMemo(() => (shot ? URL.createObjectURL(shot) : null), [shot]);
  useEffect(() => () => {
    if (shotUrl) URL.revokeObjectURL(shotUrl);
  }, [shotUrl]);

  const errors = validateDraft(draft);
  const set = <K extends keyof ReportDraft>(k: K, v: ReportDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const project = projectSource();
  const facts = useMemo(() => safeProjectFacts(project), [project]);

  const send = async (): Promise<void> => {
    setTouched(true);
    if (Object.keys(validateDraft(draft)).length > 0 || phase.kind === 'sending') return;
    setPhase({ kind: 'sending' });
    try {
      const diag = diagnostics ?? (await collectDiagnostics());
      const result = await submitReport(buildReportForm({ draft, diagnostics: diag, project, screenshot: shot }));
      setPhase({ kind: 'sent', result });
    } catch (err) {
      const status = (err as { status?: number }).status;
      setPhase({
        kind: 'error',
        message:
          status === 429
            ? t('help.report.error.rate', 'Too many reports from this computer in the last hour. Try again later.')
            : status && status < 500
              ? ((err as Error).message || t('help.report.error.rejected', 'The server refused the report.'))
              : t('help.report.error.offline', 'The report could not reach Premation. Check your connection, or copy the diagnostics and send them another way.'),
      });
    }
  };

  useDialogPrimaryAction(phase.kind === 'sent' ? close : () => void send());

  const retake = async (): Promise<void> => {
    // The dialog (and its scrim) cover the viewer: hide every portal — the
    // siblings of the app root — for the two frames the capture takes.
    const portals = [...document.body.children].filter((el): el is HTMLElement => el instanceof HTMLElement && el.id !== 'root');
    const prev = portals.map((el) => el.style.visibility);
    portals.forEach((el) => (el.style.visibility = 'hidden'));
    try {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const next = await captureViewport();
      if (next) setShot(next);
    } finally {
      portals.forEach((el, i) => (el.style.visibility = prev[i] ?? ''));
    }
  };

  if (phase.kind === 'sent') {
    return (
      <div className={styles.sent} data-modal-id={MODAL_ID}>
        <div className={styles.sentMark} aria-hidden="true">
          <Icon name="check" size="md" />
        </div>
        <div className={styles.sentCopy}>
          <p className={styles.sentEyebrow}>{t('help.report.sent.eyebrow', 'Report received')}</p>
          <p className={styles.sentNumber}>{phase.result.number}</p>
          <p className={styles.hint}>
            {draft.email.trim()
              ? t('help.report.sent.mailed', 'A confirmation is on its way to {email}. Reply to it to add anything.', { email: draft.email.trim() })
              : t('help.report.sent.noMail', 'Quote this number if you contact us about it.')}
          </p>
        </div>
        <div className={styles.footer}>
          <span className={styles.footerNote} />
          <Button variant="ghost" icon={<Icon name="copy" size="sm" />} onClick={() => void navigator.clipboard?.writeText(phase.result.number)}>
            {t('help.report.sent.copy', 'Copy number')}
          </Button>
          <Button variant="primary" onClick={close}>
            {t('help.report.sent.done', 'Done')}
          </Button>
        </div>
      </div>
    );
  }

  const busy = phase.kind === 'sending';
  const show = (k: keyof typeof errors) => touched && errors[k];

  return (
    <div className={styles.root} data-modal-id={MODAL_ID}>
      <div className={styles.columns}>
        <div className={styles.form}>
          <fieldset className={styles.fieldset} disabled={busy}>
            <legend className={styles.label}>{t('help.report.category', 'What is it about?')}</legend>
            <div className={styles.chips} role="radiogroup" aria-label={t('help.report.category', 'What is it about?')}>
              {REPORT_CATEGORIES.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={draft.category === c}
                  className={styles.chip}
                  data-active={draft.category === c || undefined}
                  onClick={() => set('category', c)}
                >
                  {categoryLabel(c)}
                </button>
              ))}
            </div>
          </fieldset>

          <div className={styles.field}>
            <span className={styles.label}>{t('help.report.impact', 'How much does it get in the way?')}</span>
            <Segmented<ReportImpact>
              size="sm"
              fullWidth
              disabled={busy}
              value={draft.impact}
              onChange={(v) => set('impact', v)}
              aria-label={t('help.report.impact', 'How much does it get in the way?')}
              options={[
                { value: 'blocker', label: t('help.report.impact.blocker', 'Blocks my work') },
                { value: 'major', label: t('help.report.impact.major', 'Gets in the way') },
                { value: 'minor', label: t('help.report.impact.minor', 'Minor') },
              ]}
            />
          </div>

          <div className={styles.field}>
          <span className={styles.label}>{t('help.report.summary', 'Summary')}</span>
          <Input
            aria-label={t('help.report.summary', 'Summary')}
            placeholder={t('help.report.summary.placeholder', 'e.g. Viewer goes black after adding a spot light')}
            value={draft.summary}
            maxLength={160}
            disabled={busy}
            error={show('summary') ? t('help.report.summary.error', 'A few words, so we can find it again.') : undefined}
            onChange={(e) => set('summary', e.target.value)}
            fullWidth
            autoFocus
          />
          </div>

          <label className={styles.field}>
            <span className={styles.label}>{t('help.report.description', 'What happened?')}</span>
            <textarea
              className={styles.textarea}
              rows={4}
              maxLength={8000}
              disabled={busy}
              aria-invalid={Boolean(show('description'))}
              placeholder={t('help.report.description.placeholder', 'What you saw, and what you expected instead.')}
              value={draft.description}
              onChange={(e) => set('description', e.target.value)}
            />
            {show('description') ? <span className={styles.error}>{t('help.report.description.error', 'Tell us what went wrong.')}</span> : null}
          </label>

          <label className={styles.field}>
            <span className={styles.label}>
              {t('help.report.steps', 'Steps to reproduce')} <span className={styles.optional}>{t('help.report.optional', 'optional')}</span>
            </span>
            <textarea
              className={styles.textarea}
              rows={3}
              maxLength={4000}
              disabled={busy}
              placeholder={t('help.report.steps.placeholder', '1. New 1080p composition\n2. Add a spot light\n3. Scrub to 2 s')}
              value={draft.steps}
              onChange={(e) => set('steps', e.target.value)}
            />
          </label>

          <div className={styles.field}>
          <span className={styles.label}>{t('help.report.email', 'Email for a reply')}</span>
          <Input
            aria-label={t('help.report.email', 'Email for a reply')}
            help={t('help.report.email.help', 'Optional. Only used to follow up on this report.')}
            type="email"
            value={draft.email}
            disabled={busy}
            error={show('email') ? t('help.report.email.error', 'That address does not look right.') : undefined}
            onChange={(e) => set('email', e.target.value)}
            fullWidth
          />
          </div>
        </div>

        <aside className={styles.side}>
          <div className={styles.field}>
            <span className={styles.label}>{t('help.report.screenshot', 'Screenshot of the viewer')}</span>
            {shotUrl ? (
              <figure className={styles.shot}>
                <img src={shotUrl} alt={t('help.report.screenshot.alt', 'The viewer when the report was opened')} />
                <figcaption className={styles.shotBar}>
                  <span>{formatBytes(shot!.size)}</span>
                  <span className={styles.shotActions}>
                    <Button size="xs" variant="ghost" disabled={busy} onClick={() => void retake()}>
                      {t('help.report.screenshot.retake', 'Retake')}
                    </Button>
                    <Button size="xs" variant="ghost" disabled={busy} onClick={() => setShot(null)}>
                      {t('help.report.screenshot.remove', 'Remove')}
                    </Button>
                  </span>
                </figcaption>
              </figure>
            ) : (
              <div className={styles.shotEmpty}>
                <Icon name="image" size="md" />
                <p className={styles.hint}>{t('help.report.screenshot.none', 'No screenshot attached.')}</p>
                {window.motionEditor?.diag?.captureViewport ? (
                  <Button size="xs" variant="secondary" disabled={busy} onClick={() => void retake()}>
                    {t('help.report.screenshot.capture', 'Capture the viewer')}
                  </Button>
                ) : null}
              </div>
            )}
          </div>

          <div className={styles.attached}>
            <span className={styles.label}>{t('help.report.attached', 'Always attached')}</span>
            <ul className={styles.list}>
              <li>{t('help.report.attached.build', 'App version, OS, CPU and memory')}</li>
              <li>{t('help.report.attached.gpu', 'GPU and engine status')}</li>
              <li>{t('help.report.attached.log', 'Last engine log lines, file paths removed')}</li>
              <li>{t('help.report.attached.counts', 'Layer and error counts — no names')}</li>
            </ul>
            <Button
              size="xs"
              variant="ghost"
              className={styles.detailsToggle}
              icon={<Icon name={showDetails ? 'chevron-up' : 'chevron-down'} size="sm" />}
              onClick={() => setShowDetails((v) => !v)}
              aria-expanded={showDetails}
            >
              {showDetails ? t('help.report.attached.hide', 'Hide details') : t('help.report.attached.show', 'See exactly what is sent')}
            </Button>
            {showDetails ? (
              <pre className={styles.json} tabIndex={0}>
                {diagnostics ? JSON.stringify({ ...diagnostics, project: facts }, null, 2) : t('help.report.attached.loading', 'Collecting…')}
              </pre>
            ) : null}
          </div>

          <div className={styles.optIn}>
            <Checkbox
              checked={draft.includeProject}
              disabled={busy || !project}
              onChange={(e) => set('includeProject', e.target.checked)}
              label={t('help.report.includeProject', 'Include project details')}
            />
            <p className={styles.hint}>
              {t('help.report.includeProject.help', 'Adds the project file path, footage names and paths, and layer error messages. Off by default.')}
            </p>
          </div>
        </aside>
      </div>

      {phase.kind === 'error' ? (
        <div className={styles.banner} role="alert">
          <Icon name="warning" size="sm" />
          <span>{phase.message}</span>
          {window.motionEditor?.diag?.copyReport ? (
            <Button size="xs" variant="ghost" onClick={() => void window.motionEditor?.diag?.copyReport?.()}>
              {t('help.report.error.copy', 'Copy diagnostics')}
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className={styles.footer}>
        <span className={styles.footerNote}>{t('help.report.footer', 'Sent to the Premation team. Nothing from your project unless you tick the box.')}</span>
        <Button variant="ghost" onClick={close} disabled={busy}>
          {t('help.report.cancel', 'Cancel')}
        </Button>
        <Button variant="primary" loading={busy} onClick={() => void send()}>
          {busy ? t('help.report.sending', 'Sending…') : t('help.report.send', 'Send report')}
        </Button>
      </div>
    </div>
  );
}

/**
 * Capture the viewer first, then open the dialog — in that order, or the
 * screenshot is of the dialog.
 */
export async function openReportProblem(): Promise<void> {
  const shot = await captureViewport();
  openModal({
    id: MODAL_ID,
    title: t('help.report.title', 'Report a Problem'),
    size: 'lg',
    render: (close) => <ReportProblemBody initialShot={shot} close={close} />,
  });
}

export function closeReportProblem(): void {
  closeModal(MODAL_ID);
}
