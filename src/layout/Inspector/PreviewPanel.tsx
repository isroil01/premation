/**
 * Preview panel — After Effects' Preview panel: the transport row, then the
 * preview settings as labelled rows (2026-10).
 *
 * Only settings this app actually has, in AE's order — no stand-ins for AE's
 * Shortcut, Cache Before Playback, Play From, Frame Rate or Full Screen,
 * because a control that changes nothing is worse than none:
 *   • Transport  → TimelineController + projectStore (first / step / play / last, loop)
 *   • Include    → audio in the preview (audioEngine master mute)
 *   • Range      → the Work Area (Work Area / Entire Composition / From Current Time)
 *   • Step       → how far the step buttons move (1, 2, 3 or 6 frames)
 *   • Resolution → renderQualityStore (Auto adaptive / Full / Half / Third / Quarter)
 *   • Draft      → renderQualityStore draft flag (skips motion blur for 60fps scrub)
 *
 * Nothing here follows the playhead: the step buttons read it when pressed
 * (`getTime`), so playback renders this panel not once per frame. The keyboard
 * cheat-sheet and the second master meter are gone — the shortcuts are in each
 * button's tooltip, and the meter is the Audio panel's.
 */

import { useEffect, useState } from 'react';
import { useProjectStore } from '@stores/projectStore';
import { getTime, setTime as setPlayheadTime } from '@stores/playbackClockStore';
import { useRenderQualityStore, type PreviewResolution } from '@stores/renderQualityStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { documentMirror } from '@stores/documentMirror';
import { activeCompIdNow, compFps, useActiveMirrorComp } from '@hooks/useMirror';
import { flicksToSeconds, type CompSettings } from '@motion/engine-api';
import { isTransportLooping, pauseTransport, playTransport, setTransportLooping } from '@core/timeline/timelineView';
import { edit } from '@core/engine/uiEdits';
import { compTime } from '@core/engine/propRefs';
import { audioEngine } from '@core/audio/AudioEngine';
import { Accordion, type AccordionItem } from '@components/Accordion';
import { Icon } from '@components/Icon';
import { IconButton } from '@components/IconButton';
import styles from './PreviewPanel.module.css';

type PlayRange = 'work-area' | 'entire-comp' | 'current-forward';
type ResolutionChoice = 'auto' | PreviewResolution;

const RANGES: ReadonlyArray<{ value: PlayRange; label: string }> = [
  { value: 'work-area', label: 'Work Area' },
  { value: 'entire-comp', label: 'Entire Composition' },
  { value: 'current-forward', label: 'From Current Time' },
];

/** Frames the step buttons skip over (0 = the next frame). */
const STEPS: ReadonlyArray<{ skip: number; label: string }> = [
  { skip: 0, label: '1 frame' },
  { skip: 1, label: '2 frames' },
  { skip: 2, label: '3 frames' },
  { skip: 5, label: '6 frames' },
];

const RESOLUTIONS: ReadonlyArray<{ value: ResolutionChoice; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 1, label: 'Full' },
  { value: 2, label: 'Half' },
  { value: 3, label: 'Third' },
  { value: 4, label: 'Quarter' },
];

export function PreviewPanel(): JSX.Element {
  const activeTabId = useProjectStore((s) => s.activeTabId);
  const playing = useProjectStore((s) => (activeTabId ? s.tabs[activeTabId]?.playing ?? false : false));
  const setPlaying = useProjectStore((s) => s.actions.setPlaying);

  const setTime = (t: number, frame: number): void => {
    if (activeTabId) setPlayheadTime(activeTabId, t, frame);
  };

  const comp = useActiveMirrorComp();
  // The rate as the settings dialog states it (NTSC 30000/1001 → 29.97), so
  // the frame maths match what the user typed.
  const fps = Number(compFps(comp).toFixed(3)) || 30;
  const duration = comp ? flicksToSeconds(comp.settings.duration) : 0;

  // Loop playback state (transport, not the document)
  const [looping, setLoopingState] = useState(() => isTransportLooping());
  useEffect(() => {
    setLoopingState(isTransportLooping());
  }, [activeTabId]);

  const setLooping = (on: boolean): void => {
    setTransportLooping(on);
    setLoopingState(on);
  };

  // Work area range
  const [range, setRangeState] = useState<PlayRange>(() =>
    hasWorkArea(activeSettingsNow()) ? 'work-area' : 'entire-comp',
  );
  const setRange = (next: PlayRange): void => {
    const compId = activeCompIdNow();
    const now = getTime();
    if (next === 'entire-comp') {
      if (compId && hasWorkArea(activeSettingsNow())) void edit('Clear Work Area', { type: 'clearWorkArea', comp: compId });
    } else if (next === 'current-forward' && duration > now && compId) {
      void edit('Work Area', { type: 'setWorkArea', comp: compId, range: { start: compTime(now), duration: compTime(duration - now) } });
    }
    setRangeState(next);
  };

  // Frames the step buttons skip
  const [skip, setSkip] = useState<number>(0);

  // Render resolution & adaptive quality
  const resolution = useRenderQualityStore((s) => s.resolution);
  const adaptive = useRenderQualityStore((s) => s.adaptive);
  const draft = useRenderQualityStore((s) => s.draft);
  const setDraft = useRenderQualityStore((s) => s.setDraft);

  const resolutionChoice: ResolutionChoice = adaptive ? 'auto' : resolution;
  const setResolutionChoice = (next: ResolutionChoice): void => {
    const rq = useRenderQualityStore.getState();
    if (next === 'auto') {
      rq.setAdaptive(true);
      rq.setResolution(1);
    } else {
      rq.setAdaptive(false);
      rq.setResolution(next);
    }
  };

  // Audio in the preview (the master mute)
  const [muteAudio, setMuteAudioState] = useState(() => audioEngine.isMasterMuted());
  const setMuteAudio = (muted: boolean): void => {
    audioEngine.setMasterMuted(muted);
    setMuteAudioState(muted);
  };

  // The group rows remember their open state the way the Properties sections do.
  const groupsOpen = usePreferenceStore((s) => s.inspectorSections);
  const setPref = usePreferenceStore((s) => s.set);
  const toggleGroup = (id: string, open: boolean): void => {
    setPref('inspectorSections', { ...usePreferenceStore.getState().inspectorSections, [id]: open });
  };

  // Frame navigation handlers — the playhead is read when pressed, not rendered.
  const handleFirstFrame = (): void => {
    setTime(0, 0);
  };

  const handlePrevFrame = (): void => {
    const targetT = Math.max(0, getTime() - (skip + 1) / fps);
    setTime(targetT, Math.round(targetT * fps));
  };

  const handleTogglePlay = (): void => {
    const next = !playing;
    setPlaying(next);
    if (next) playTransport();
    else pauseTransport();
  };

  const handleNextFrame = (): void => {
    const targetT = Math.min(duration, getTime() + (skip + 1) / fps);
    setTime(targetT, Math.round(targetT * fps));
  };

  const handleLastFrame = (): void => {
    setTime(duration, Math.round(duration * fps));
  };

  const stepWord = skip > 0 ? `${skip + 1} frames` : 'one frame';

  const groups: AccordionItem[] = [
    {
      id: 'preview.playback',
      title: 'Playback',
      defaultOpen: true,
      content: (
        <>
          <label className={styles.row}>
            <span className={styles.label}>Range</span>
            <select
              className={styles.select}
              aria-label="Range"
              title="What a preview plays — and loops"
              value={range}
              onChange={(e) => setRange(e.currentTarget.value as PlayRange)}
            >
              {RANGES.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
          </label>
          <label className={styles.row}>
            <span className={styles.label}>Step</span>
            <select
              className={styles.select}
              aria-label="Step"
              title="How far the previous and next frame buttons move"
              value={String(skip)}
              onChange={(e) => setSkip(Number(e.currentTarget.value))}
            >
              {STEPS.map((s) => (
                <option key={s.skip} value={s.skip}>{s.label}</option>
              ))}
            </select>
          </label>
        </>
      ),
    },
    {
      id: 'preview.quality',
      title: 'Quality',
      defaultOpen: true,
      content: (
        <>
          <label className={styles.row}>
            <span className={styles.label}>Resolution</span>
            <select
              className={styles.select}
              aria-label="Resolution"
              title="Pixels the viewer renders: Auto drops while a drag or playback cannot keep up"
              value={String(resolutionChoice)}
              onChange={(e) => {
                const v = e.currentTarget.value;
                setResolutionChoice(v === 'auto' ? 'auto' : (Number(v) as PreviewResolution));
              }}
            >
              {RESOLUTIONS.map((r) => (
                <option key={String(r.value)} value={String(r.value)}>{r.label}</option>
              ))}
            </select>
          </label>
          <div className={styles.row}>
            <span className={styles.label}>Draft</span>
            <div className={styles.toggles}>
              <IconButton
                size="sm"
                variant="ghost"
                active={draft}
                aria-label="Draft quality"
                aria-pressed={draft}
                tooltip={draft ? 'Draft quality: on — motion blur skipped while previewing' : 'Draft quality: off'}
                onClick={() => setDraft(!draft)}
              >
                <Icon name="draft-3d" size="sm" />
              </IconButton>
            </div>
          </div>
        </>
      ),
    },
  ];

  return (
    <div className={styles.root}>
      <div className={styles.top}>
        {/* ── Transport: first, step back, play, step on, last · loop ── */}
        <div className={styles.transport} role="toolbar" aria-label="Preview transport controls">
          <IconButton
            aria-label="First frame (Home)"
            tooltip="First frame (Home)"
            variant="ghost"
            size="sm"
            onClick={handleFirstFrame}
          >
            <Icon name="skip-back" size="sm" />
          </IconButton>

          <IconButton
            aria-label="Previous frame"
            tooltip={`Back ${stepWord} (Page Up)`}
            variant="ghost"
            size="sm"
            onClick={handlePrevFrame}
          >
            <Icon name="chevron-left" size="sm" />
          </IconButton>

          <IconButton
            aria-label={playing ? 'Pause' : 'Play'}
            tooltip={playing ? 'Pause playback (Space)' : 'Play preview (Space)'}
            variant="primary"
            size="md"
            onClick={handleTogglePlay}
          >
            <Icon name={playing ? 'pause' : 'play'} size="md" />
          </IconButton>

          <IconButton
            aria-label="Next frame"
            tooltip={`Forward ${stepWord} (Page Down)`}
            variant="ghost"
            size="sm"
            onClick={handleNextFrame}
          >
            <Icon name="chevron-right" size="sm" />
          </IconButton>

          <IconButton
            aria-label="Last frame (End)"
            tooltip="Last frame (End)"
            variant="ghost"
            size="sm"
            onClick={handleLastFrame}
          >
            <Icon name="skip-forward" size="sm" />
          </IconButton>

          <span className={styles.transportDivider} aria-hidden />

          <IconButton
            aria-label={looping ? 'Disable loop' : 'Enable loop'}
            tooltip={looping ? 'Loop: on' : 'Loop: off — play once'}
            variant="ghost"
            active={looping}
            aria-pressed={looping}
            size="sm"
            onClick={() => setLooping(!looping)}
          >
            <Icon name="loop" size="sm" />
          </IconButton>
        </div>

        {/* ── Include: what the preview plays besides the picture ── */}
        <div className={styles.row}>
          <span className={styles.label}>Include</span>
          <div className={styles.toggles}>
            <IconButton
              size="sm"
              variant="ghost"
              active={!muteAudio}
              aria-label="Include audio"
              aria-pressed={!muteAudio}
              tooltip={muteAudio ? 'Audio: muted in previews' : 'Audio: playing in previews'}
              onClick={() => setMuteAudio(!muteAudio)}
            >
              <Icon name={muteAudio ? 'audio-off' : 'audio'} size="sm" />
            </IconButton>
          </div>
        </div>
      </div>

      <Accordion className={styles.groups} items={groups} openOverrides={groupsOpen} onToggle={toggleGroup} />
    </div>
  );
}

/** The active composition's settings, read at call time. */
function activeSettingsNow(): CompSettings | undefined {
  const id = activeCompIdNow();
  return id ? documentMirror().comp(id)?.settings : undefined;
}

/** Whether a work area is set: the API states "none" as the whole composition. */
function hasWorkArea(s: CompSettings | undefined): boolean {
  return !!s && !(s.workArea.start === 0 && s.workArea.duration === s.duration);
}

export default PreviewPanel;
