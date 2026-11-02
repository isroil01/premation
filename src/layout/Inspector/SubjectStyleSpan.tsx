/**
 * When a subject style shows: the whole shot, or part of it (From / To, an
 * optional fade) — Properties ▸ Subjects ▸ Styles, under each style. The span
 * is ordinary keys on the effect's Effect Opacity (core/workspace/
 * subjectStyleTime.ts), one undo entry per change; keys of another shape
 * (eased by hand in the timeline) show as "Keyframed" and are left alone
 * until reset.
 */

import { cn } from '@utils/cn';
import { ValueField } from '@components/ValueField';
import { Icon } from '@components/Icon';
import { documentMirror } from '@stores/documentMirror';
import { edit } from '@core/engine/uiEdits';
import { values } from '@core/engine/propRefs';
import { activeCompSettingsNow } from '@hooks/useMirrorFrame';
import { settingsDurationSeconds, settingsFps } from '@core/mirror/compFacts';
import { playheadSeconds, seekPlayhead } from '@core/timeline/timelineView';
import { framesToTimecode } from '@core/time/timecode';
import { readStyleSpan, styleOpacityPath, styleSpanKeys, type StyleSpan } from '@core/workspace/subjectStyleTime';
import { t } from '@core/i18n';
import styles from './SubjectSection.module.css';

export function SubjectStyleSpan({ nodeId, effectId, name, defaultSpan }: {
  nodeId: string;
  effectId: string;
  name: string;
  /** Where a new span starts and ends (the subject's tracked frames, else the playhead on). */
  defaultSpan: () => { start: number; end: number };
}): JSX.Element {
  const settings = activeCompSettingsNow();
  const fps = settingsFps(settings);
  const duration = settingsDurationSeconds(settings);
  const path = styleOpacityPath(effectId);
  const keys = documentMirror().keyframes(nodeId, path);
  const span = readStyleSpan(keys, fps);
  const custom = keys.length > 0 && !span;
  const prop = { layer: nodeId, path };
  const tc = (s: number): string => framesToTimecode(s, fps);

  const write = (next: StyleSpan): void => {
    void edit(t('inspector.subject.spanEdit', 'Style Time: {name}', { name }), [{ type: 'setKeyframes', prop, keys: styleSpanKeys(next, fps) }]);
  };
  const whole = (): void => {
    void edit(t('inspector.subject.spanWhole', 'Style Whole Shot: {name}', { name }), [
      { type: 'setAnimated', prop, animated: false, time: 0 },
      { type: 'setProperty', prop, value: values.scalar(100) },
    ]);
  };
  const part = (): void => {
    const d = defaultSpan();
    write({ start: d.start, end: d.end, fade: 0 });
  };

  return (
    <div className={styles.spanBox}>
      <div className={styles.spanModes} role="group" aria-label={t('inspector.subject.spanWhen', 'When {name} shows', { name })}>
        <button type="button" className={cn(styles.spanMode, keys.length === 0 && styles.spanModeOn)} aria-pressed={keys.length === 0} onClick={whole}>
          {t('inspector.subject.spanWholeShot', 'Whole shot')}
        </button>
        <button type="button" className={cn(styles.spanMode, !!span && styles.spanModeOn)} aria-pressed={!!span} onClick={() => { if (!span) part(); }}>
          {t('inspector.subject.spanPart', 'Part of it')}
        </button>
        {custom && <span className={styles.meta} title={t('inspector.subject.spanCustomHint', 'Its Effect Opacity has keys of its own (edited in the timeline). Whole shot or Part of it replaces them.')}>
          {t('inspector.subject.spanCustom', 'Keyframed')}
        </span>}
      </div>
      {span && (
        <div className={styles.spanFields}>
          <span className={styles.spanLabel}>{t('inspector.subject.spanFrom', 'From')}</span>
          <button type="button" className={styles.spanTime} title={t('inspector.subject.spanGo', 'Go to this frame')} onClick={() => seekPlayhead(span.start)}>{tc(span.start)}</button>
          <button type="button" className={styles.icon} title={t('inspector.subject.spanSetFrom', 'Start at the playhead')}
            aria-label={t('inspector.subject.spanSetFrom', 'Start at the playhead')}
            onClick={() => { const p = playheadSeconds(); write({ ...span, start: p, end: Math.max(p, span.end) }); }}><Icon name="skip-back" size="sm" /></button>
          <span className={styles.spanLabel}>{t('inspector.subject.spanTo', 'To')}</span>
          <button type="button" className={styles.spanTime} title={t('inspector.subject.spanGo', 'Go to this frame')} onClick={() => seekPlayhead(span.end)}>{tc(span.end)}</button>
          <button type="button" className={styles.icon} title={t('inspector.subject.spanSetTo', 'End at the playhead')}
            aria-label={t('inspector.subject.spanSetTo', 'End at the playhead')}
            onClick={() => { const p = Math.min(duration, playheadSeconds()); write({ ...span, end: p, start: Math.min(p, span.start) }); }}><Icon name="skip-forward" size="sm" /></button>
          <span className={styles.spanLabel}>{t('inspector.subject.spanFade', 'Fade')}</span>
          <span className={styles.spanFade}>
            <ValueField
              value={Math.round(span.fade * fps)}
              min={0}
              max={Math.max(1, Math.round(2 * fps))}
              step={1}
              precision={0}
              unit="f"
              aria-label={t('inspector.subject.spanFadeLabel', 'Fade in and out, frames')}
              onChange={(v) => write({ ...span, fade: Math.max(0, Number(v)) / fps })}
            />
          </span>
        </div>
      )}
    </div>
  );
}
