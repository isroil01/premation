/**
 * Properties ▸ Subjects ▸ Tracking and View (the approved Subjects Pro
 * design, boards 1 and 4).
 *
 *   view     how the viewers show the subject: Overlay (tinted in its colour),
 *            on Black, on White, its Alpha, its Boundary — drawn by the engine
 *            through the subject's live edge (setViewport `subjectView`)
 *   lanes    one per subject across the composition: where it was tracked,
 *            its fixes (diamonds: your own selection or edit, or a frame a
 *            walk started from), and the frames the tracker was unsure of
 *            (warning colour). Click a lane to go to that frame.
 *   review   the active subject's unsure runs, in order: go to one, fix it
 *            (Shift / Alt clicks or a brush on that frame), then Re-track —
 *            only the frames between the fixes either side are walked again.
 *
 * The lanes read `getSubjectTracks` again when the document changes; the
 * playhead line follows the clock through a subscription (no React render
 * per played frame).
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { cn } from '@utils/cn';
import { Button } from '@components/Button';
import { Icon } from '@components/Icon';
import { usePlaybackClockStore, getTime } from '@stores/playbackClockStore';
import { useSubjectStore, type SubjectViewMode } from '@stores/subjectStore';
import { activeCompSettingsNow } from '@hooks/useMirrorFrame';
import { settingsDurationSeconds, settingsFps } from '@core/mirror/compFacts';
import { seekPlayhead, playheadSeconds } from '@core/timeline/timelineView';
import { framesToTimecode } from '@core/time/timecode';
import { t } from '@core/i18n';
import type { Subject } from '@core/workspace/subjects';
import { fetchSubjectTracks, isTracked, reviewSpans, type ReviewSpan, type SubjectTrack, type TrackFrame } from '@core/workspace/subjectTracks';
import { cancelSubjectWalk, followSubject, layerMoves, retrackSubject, subjectWalkRunning } from '@layout/Workspace/subjectActions';
import { useUIStore } from '@stores/uiStore';
import { SubjectGroup } from './SubjectGroup';
import styles from './SubjectSection.module.css';

function viewModes(): ReadonlyArray<{ id: Exclude<SubjectViewMode, 'off'>; label: string; hint: string }> {
  return [
    { id: 'overlay', label: t('inspector.subject.view.overlay', 'Overlay'), hint: t('inspector.subject.view.overlayHint', 'The subject tinted in its colour') },
    { id: 'black', label: t('inspector.subject.view.black', 'Black'), hint: t('inspector.subject.view.blackHint', 'The subject over black') },
    { id: 'white', label: t('inspector.subject.view.white', 'White'), hint: t('inspector.subject.view.whiteHint', 'The subject over white') },
    { id: 'alpha', label: t('inspector.subject.view.alpha', 'Alpha'), hint: t('inspector.subject.view.alphaHint', 'The matte itself, white on black') },
    { id: 'boundary', label: t('inspector.subject.view.boundary', 'Boundary'), hint: t('inspector.subject.view.boundaryHint', 'The matte\'s edge as a line') },
  ];
}

/** The layer's tracks, asked again whenever the document revision moves. */
function useSubjectTracks(nodeId: string, rev: number): SubjectTrack[] {
  const [tracks, setTracks] = useState<SubjectTrack[]>([]);
  useEffect(() => {
    let live = true;
    fetchSubjectTracks(nodeId).then((r) => { if (live) setTracks(r); }, () => { if (live) setTracks([]); });
    return () => { live = false; };
  }, [nodeId, rev]);
  return tracks;
}

/** Runs of stored frames no more than 1.5 frames apart: where the subject has a matte. */
function coveredRuns(frames: readonly TrackFrame[], fps: number): Array<{ start: number; end: number }> {
  const gap = 1.5 / Math.max(1, fps);
  const out: Array<{ start: number; end: number }> = [];
  for (const f of frames) {
    const last = out[out.length - 1];
    if (last && f.time - last.end <= gap) last.end = f.time;
    else out.push({ start: f.time, end: f.time });
  }
  return out;
}

/** The playhead's line in a lane: moved by the clock store, never by a React render. */
function LanePlayhead({ duration }: { duration: number }): JSX.Element {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const place = (): void => {
      if (ref.current) ref.current.style.left = `${Math.min(100, Math.max(0, (getTime() / duration) * 100))}%`;
    };
    place();
    return usePlaybackClockStore.subscribe(place);
  }, [duration]);
  return <span ref={ref} className={styles.lanePlayhead} aria-hidden="true" />;
}

function Lane({ subject, frames, duration, fps, active, onPick }: {
  subject: Subject;
  frames: readonly TrackFrame[];
  duration: number;
  fps: number;
  active: boolean;
  onPick: () => void;
}): JSX.Element {
  const pct = (s: number): string => `${Math.min(100, Math.max(0, (s / duration) * 100))}%`;
  // A marker's centre kept 4 px inside the lane, so one on the first or last frame is not cut in half.
  const markAt = (s: number): string => `clamp(4px, ${Math.min(100, Math.max(0, (s / duration) * 100))}%, calc(100% - 4px))`;
  const width = (a: number, b: number): string => `max(2px, ${Math.max(0, ((b - a + 1 / fps) / duration) * 100)}%)`;
  const spans = reviewSpans(frames, fps);
  const fixes = frames.filter((f) => f.fix);
  const tracked = isTracked(frames, fps);
  return (
    <div className={cn(styles.laneRow, active && styles.laneRowActive)} style={{ '--subject-color': subject.color } as CSSProperties}>
      <button type="button" className={styles.laneName} onClick={onPick} title={subject.name}>
        <span className={styles.dot} />
        <span className={styles.nameText}>{subject.name}</span>
      </button>
      <div
        className={styles.lane}
        role="slider"
        tabIndex={0}
        aria-label={t('inspector.subject.laneLabel', '{name} tracking', { name: subject.name })}
        aria-valuemin={0}
        aria-valuemax={duration}
        aria-valuenow={playheadSeconds()}
        title={tracked
          ? t('inspector.subject.laneHint', 'Click to go to a frame · diamonds are fixes · amber frames need a look')
          : t('inspector.subject.laneHintOne', 'Selected on {n} frame(s), held on the others · Follow it to track it', { n: frames.length })}
        onPointerDown={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          if (r.width <= 0) return;
          onPick();
          seekPlayhead(Math.round(((e.clientX - r.left) / r.width) * duration * fps) / fps);
        }}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
          e.preventDefault();
          seekPlayhead(Math.max(0, Math.min(duration, playheadSeconds() + (e.key === 'ArrowLeft' ? -1 : 1) / fps)));
        }}
      >
        {tracked
          ? coveredRuns(frames, fps).map((r) => <span key={r.start} className={styles.laneCovered} style={{ left: pct(r.start), width: width(r.start, r.end) }} />)
          : frames.map((f) => <span key={f.time} className={styles.laneHeld} style={{ left: markAt(f.time) }} />)}
        {spans.map((s) => <span key={s.start} className={styles.laneLow} style={{ left: pct(s.start), width: width(s.start, s.end) }} />)}
        {fixes.map((f) => <span key={f.time} className={styles.laneFix} style={{ left: markAt(f.time) }} />)}
        <LanePlayhead duration={duration} />
      </div>
    </div>
  );
}

/** Properties ▸ Subject ▸ Edge ▸ Show matte as: how the viewers draw the subject (click again to turn it off). */
export function SubjectViewRow(): JSX.Element {
  const view = useSubjectStore((s) => s.view);
  const viewAll = useSubjectStore((s) => s.viewAll);
  return (
    <>
      <div className={styles.edgeRow}>
        <span className={styles.edgeLabel}>{t('inspector.subject.viewAs', 'Show matte as')}</span>
        <div className={styles.viewModes} role="group" aria-label={t('inspector.subject.viewModes', 'Subject view')}>
          {viewModes().map((m) => (
            <button
              key={m.id}
              type="button"
              className={cn(styles.viewMode, view === m.id && styles.viewModeOn)}
              aria-pressed={view === m.id}
              aria-label={m.label}
              title={`${m.label} · ${m.hint}`}
              onClick={() => useSubjectStore.getState().setView(view === m.id ? 'off' : m.id)}
            >
              <span className={styles.viewGlyph} data-mode={m.id} aria-hidden="true" />
            </button>
          ))}
        </div>
      </div>
      <label className={cn(styles.check, styles.checkIndent)}>
        <input type="checkbox" checked={viewAll} onChange={(e) => useSubjectStore.getState().setView(view, e.currentTarget.checked)} />
        {t('inspector.subject.viewAllShort', 'Show all subjects')}
      </label>
    </>
  );
}

export function SubjectTracking({ nodeId, subjects, active, rev, locked }: {
  nodeId: string;
  subjects: readonly Subject[];
  active: Subject;
  rev: number;
  locked: boolean;
}): JSX.Element {
  const tracks = useSubjectTracks(nodeId, rev);
  const settings = activeCompSettingsNow();
  const fps = settingsFps(settings);
  const duration = Math.max(1 / fps, settingsDurationSeconds(settings));
  const framesOf = (id: string): TrackFrame[] => tracks.find((tr) => tr.subject === id)?.frames ?? [];
  const mine = framesOf(active.id);
  const tracked = isTracked(mine, fps);
  const spans: ReviewSpan[] = tracked ? reviewSpans(mine, fps) : [];
  const autoTrack = useSubjectStore((s) => s.autoTrack);
  // The active subject's walk while it runs (a Tasks-panel job; its progress is a few updates a second).
  const walk = useUIStore((s) => s.jobs.find((j) => j.id === `follow-${nodeId}-${active.id}` && j.status === 'running'));
  const pct = walk ? Math.round((typeof walk.progress === 'number' ? walk.progress : 0) * 100) : 0;
  // A subject of moving footage that was never tracked: the same matte on every frame.
  const held = !walk && !tracked && mine.length > 0 && layerMoves(nodeId) && !subjectWalkRunning(nodeId, active.id);
  const setActive = (id: string): void => useSubjectStore.getState().setActive(nodeId, id);
  const tc = (s: number): string => framesToTimecode(s, fps);
  // Walk from a frame the user selected or fixed (else the first stored one).
  const trackFrom = (): number | undefined => (mine.find((f) => f.fix) ?? mine[0])?.time;

  const summary = walk
    ? t('inspector.subject.trackingNow', 'Tracking… {pct}%', { pct })
    : tracked
      ? spans.length > 0
        ? t('inspector.subject.trackingSumReview', '{frames} frames · {n} to review', { frames: mine.length, n: spans.length })
        : t('inspector.subject.trackingSum', '{frames} frames', { frames: mine.length })
      : mine.length > 0
        ? t('inspector.subject.trackingSumHeld', 'Selected on {n} frame(s)', { n: mine.length })
        : t('inspector.subject.trackingNone', 'not tracked yet');

  return (
    <SubjectGroup id="tracking" title={t('inspector.subject.trackingTitle', 'Tracking')} summary={summary}>
      <div className={styles.lanes}>
        {subjects.map((s) => (
          <Lane key={s.id} subject={s} frames={framesOf(s.id)} duration={duration} fps={fps} active={s.id === active.id} onPick={() => setActive(s.id)} />
        ))}
      </div>
      {walk ? (
        <div className={styles.walkRow}>
          <div className={styles.walkBar} role="progressbar" aria-label={t('inspector.subject.trackingNowLabel', 'Tracking progress')}
            aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <span style={{ transform: `scaleX(${pct / 100})` }} />
          </div>
          <Button size="sm" variant="ghost" onClick={() => cancelSubjectWalk(nodeId, active.id)}>
            {t('inspector.subject.trackingStop', 'Stop')}
          </Button>
        </div>
      ) : tracked ? (
        <>
          {spans.length > 0 ? (
            <ul className={styles.reviewList} aria-label={t('inspector.subject.reviewCount', 'Frames to review · {n}', { n: spans.length })}>
              {spans.map((s) => (
                <li key={s.start}>
                  <button type="button" className={styles.reviewRow} onClick={() => seekPlayhead(s.start)}
                    title={t('inspector.subject.reviewGo', 'Go to this frame, fix the subject there, then Re-track')}>
                    <span className={styles.reviewSwatch} aria-hidden="true" />
                    <span className={styles.reviewTime}>{s.end > s.start ? `${tc(s.start)} – ${tc(s.end)}` : tc(s.start)}</span>
                    <span className={styles.meta}>{t('inspector.subject.reviewSure', '{n}% sure', { n: Math.round(s.lowest * 100) })}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <span className={styles.meta}>{t('inspector.subject.reviewNoneShort', 'Every frame confident')}</span>
          )}
          <div className={styles.trackRow}>
            <button
              type="button"
              className={styles.secondary}
              disabled={locked}
              title={t('inspector.subject.retrackHint', 'Walk the subject again from the playhead, both ways, up to the fixes either side. Fix the frame first: Shift / Alt clicks or a brush.')}
              onClick={() => { void retrackSubject(nodeId, active.id, playheadSeconds()); }}
            >
              <Icon name="refresh" size="sm" />
              {t('inspector.subject.retrack', 'Re-track from this frame')}
            </button>
            <Button
              size="sm"
              variant="ghost"
              disabled={locked}
              title={t('inspector.subject.trackAgainHint', 'Track the whole shot again from the first fix')}
              onClick={() => { void followSubject(nodeId, active.id, trackFrom()); }}
            >
              {t('inspector.subject.trackAgain', 'Track all again')}
            </Button>
          </div>
        </>
      ) : (
        <button
          type="button"
          className={styles.follow}
          disabled={locked}
          title={t('workspace.subjects.action.followDesc', 'Carry the selection to every frame')}
          onClick={() => { void followSubject(nodeId, active.id, trackFrom()); }}
        >
          <Icon name="play" size="sm" />
          <span className={styles.actionTitle}>{t('inspector.subject.trackNow', 'Track through the shot')}</span>
        </button>
      )}
      {held && (
        <p className={styles.help} role="status">
          {t('inspector.subject.heldNoteShorter', 'Until it is tracked, its styles stay put while the subject moves.')}
        </p>
      )}
      <label className={styles.check} title={t('inspector.subject.autoTrackHint', 'After each selection or fix on moving footage, the subject is tracked (or re-tracked between fixes) in the background.')}>
        <input type="checkbox" checked={autoTrack} onChange={(e) => useSubjectStore.getState().setAutoTrack(e.currentTarget.checked)} />
        {t('inspector.subject.autoTrack', 'Track automatically')}
      </label>
    </SubjectGroup>
  );
}
