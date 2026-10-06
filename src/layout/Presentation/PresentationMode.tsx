/**
 * PresentationMode — the Preview PAGE: the composition alone, for watching.
 *
 * Three parts (2026-10, the After Effects direction):
 *   • a slim top bar — Back to editor, the comp's name, Resolution, View,
 *     Save frame, Export;
 *   • the picture, contain-fitted on a surround the viewer chooses (black, dark
 *     grey or white), with optional title / action safe guides;
 *   • ONE playback bar — a full-width scrub strip, then the timecode, the
 *     transport, the comp's facts and Full screen.
 * While it plays the bars fade and only the picture is left; moving the
 * pointer brings them back.
 *
 * It is a page in the sense that matters to the user: it has an address
 * (`?preview=1` on the editor's own route — see `PreviewAddress`), so Back
 * leaves it exactly as Esc and "Back to editor" do, and reloading on that
 * address reopens it. It stays mounted inside the editor because the picture
 * is the running engine's; a separate route would have to boot a second one.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useInRouterContext, useSearchParams } from 'react-router-dom';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { getUiPlatform, getWindowControls, hasDesktopChrome } from '@core/config/uiPlatform';
import { Icon } from '@components/Icon';
import { usePresentationStore } from '@stores/presentationStore';
import { useWorkspaceStore, useActiveWorkspace } from '@stores/projectStore';
import { useCurrentTime } from '@stores/playbackClockStore';
import { useMirrorRevision } from '@hooks/useMirror';
import { useRenderQualityStore, RESOLUTION_LABELS, type PreviewResolution } from '@stores/renderQualityStore';
import { paintWireframeOverlay } from '@layout/Workspace/wireframeOverlay';
import { paneViewTransform } from '@layout/Workspace/useSceneRefGeometry';
import { EnginePaneSurface, type PaneSurround } from '@components/EngineSurface/EnginePaneSurface';
import { parseCssRgb } from '@components/EngineSurface/pasteboard';
import { activeCompIdNow } from '@hooks/useMirror';
import { engineCompStill } from '@core/engine/engineStill';
import {
  goToEnd,
  goToStart,
  isTransportLooping,
  seekPlayhead,
  setTransportLooping,
  stepBackward,
  stepForward,
} from '@core/timeline/timelineView';
import { useActiveMirrorComp } from '@hooks/useMirror';
import { settingsDurationSeconds, settingsFps, settingsStartFrame } from '@core/mirror/compFacts';
import { framesToTimecode } from '@core/time/timecode';
import { openExportDialog } from '@layout/Export/ExportDialog';
import { activeViewWireframeNodes } from '@core/workspace/wireframeNodes';
import styles from './PresentationMode.module.css';

const QUALITY_ORDER: PreviewResolution[] = [1, 2, 3, 4];

/**
 * What the picture sits on — for judging a design against black, grey or white.
 * `auto` (the default) picks one that stands apart from the composition's own
 * background: on black, a black composition (the usual dark background) had no
 * visible edge.
 */
type Surround = 'auto' | 'black' | 'grey' | 'white';
const SURROUND_LABEL: Record<Surround, string> = { auto: 'Automatic', black: 'Black', grey: 'Dark grey', white: 'White' };
const SURROUND_KEY = 'premation.preview.surround';
/** Luma of the Dark grey surround (--color-slate-800, #2b2b2e). */
const GREY_LUMA = 0.17;

/** Automatic: Dark grey, unless the composition's background is itself close to it — then Black. */
function autoSurround(background: { r: number; g: number; b: number } | undefined): 'black' | 'grey' {
  if (!background) return 'grey';
  const luma = 0.2126 * background.r + 0.7152 * background.g + 0.0722 * background.b;
  return Math.abs(luma - GREY_LUMA) < 0.08 ? 'black' : 'grey';
}
const SAFE_KEY = 'premation.preview.safeAreas';
const PREVIEW_PARAM = 'preview';

/** A per-machine viewing preference; a blocked store just means the default. */
function readPref(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePref(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private window / blocked storage: lasts for this session only */
  }
}

/**
 * The Preview's address: `?preview=1` on the editor's route, kept in step with
 * the store both ways. Opening Preview pushes it (so Back closes Preview);
 * losing it — Back, or an edited URL — closes Preview; arriving with it opens
 * Preview. Its own component so it only mounts where there is a router (a
 * test may render the editor without one).
 */
function PreviewAddress({ active, enter, exit }: { active: boolean; enter: () => void; exit: () => void }): null {
  const [params, setParams] = useSearchParams();
  const inUrl = params.get(PREVIEW_PARAM) === '1';
  // What this component last made true, so each side is followed exactly once.
  const lastActive = useRef(active);
  const lastInUrl = useRef(inUrl);

  useEffect(() => {
    const activeChanged = lastActive.current !== active;
    const urlChanged = lastInUrl.current !== inUrl;
    lastActive.current = active;
    lastInUrl.current = inUrl;
    if (active === inUrl) return;
    if (urlChanged && !activeChanged) {
      // The address moved (Back / Forward / a typed URL): the page follows it.
      if (inUrl) enter();
      else exit();
      return;
    }
    // The page moved (the Preview button, Esc): the address follows it.
    const next = new URLSearchParams(params);
    if (active) next.set(PREVIEW_PARAM, '1');
    else next.delete(PREVIEW_PARAM);
    setParams(next, { replace: !active });
  }, [active, inUrl, params, setParams, enter, exit]);

  // Arriving on the address (a reload, a pasted link) opens the Preview.
  useEffect(() => {
    if (inUrl && !active) enter();
    // Once, on mount: afterwards the effect above keeps the two in step.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
/** Hide the chrome after this long with no pointer movement while playing. */
const IDLE_HIDE_MS = 2600;

export function PresentationMode(): JSX.Element | null {
  const active = usePresentationStore((s) => s.active);
  const exit = usePresentationStore((s) => s.exit);
  const enter = usePresentationStore((s) => s.enter);
  const inRouter = useInRouterContext();
  const ws = useActiveWorkspace();
  const setPlaying = useWorkspaceStore((s) => s.actions.setPlaying);
  // Any document revision repaints (the renderer also listens to the engine's frame signals) — while the
  // mode is ACTIVE; an inactive one must not re-render on every viewport drag step.
  const sceneRev = useMirrorRevision(active);

  // The active composition's settings, from the document mirror.
  const settings = useActiveMirrorComp()?.settings;
  const name = settings?.name ?? '';
  const width = settings?.width ?? 1920;
  const height = settings?.height ?? 1080;
  const fps = settingsFps(settings) || 30;
  const startFrame = settingsStartFrame(settings) || 0;
  const duration = settingsDurationSeconds(settings) || 1;

  const previewResolution = useRenderQualityStore((s) => s.resolution);
  const setResolution = useRenderQualityStore((s) => s.setResolution);

  const time = useCurrentTime();
  const playing = ws?.playing ?? false;
  const durationFrames = Math.max(1, Math.round(duration * fps));
  const currentFrame = Math.min(durationFrames, Math.max(0, Math.round(time * fps)));
  const progress = duration > 0 ? Math.min(1, Math.max(0, time / duration)) : 0;

  const rootRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const scrubRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  // Tracks whether the backend has painted at least one frame — used to show a
  // loading spinner on the stage until the first pixels arrive (previously the
  // canvas was blank with no feedback while the GPU backend initialised).
  const [backendReady, setBackendReady] = useState(false);

  // Quality = Wireframe layers render hidden here (as in every viewer); their
  // boxes come from the main viewport's scene, which follows the same view mode.
  const wireframeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const wireframeOverlay = useMemo(
    () => ({ canvasRef: wireframeCanvasRef, nodes: activeViewWireframeNodes }),
    [],
  );
  // The pixels are the engine's (EnginePaneSurface, contain-fitted into the
  // stage on its own engine viewport); Quality = Wireframe boxes are painted
  // from the page's geometry through the same contain fit whenever anything moved.
  const wireframePaintedRef = useRef(false);
  useEffect(() => {
    const stage = stageRef.current;
    if (!active || !stage) return;
    const r = stage.getBoundingClientRect();
    const view = r.width > 0 && r.height > 0 ? paneViewTransform(r.width, r.height, width, height) : undefined;
    paintWireframeOverlay(wireframeOverlay, wireframeCanvasRef.current, view, { width, height }, wireframePaintedRef);
  }, [active, wireframeOverlay, width, height, sceneRev, time]);
  // NOTE: no usePlaybackClock here — App.tsx runs the single shared clock; a
  // second instance would double-tick the controller (2× playback speed).

  const [looping, setLoopingState] = useState(() => isTransportLooping());
  const [uiVisible, setUiVisible] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Viewing preferences: what the picture sits on, and the safe-area guides.
  const [surround, setSurroundState] = useState<Surround>(() => {
    const saved = readPref(SURROUND_KEY);
    return saved === 'black' || saved === 'grey' || saved === 'white' ? saved : 'auto';
  });
  const shownSurround = surround === 'auto' ? autoSurround(settings?.background) : surround;
  // The engine clears outside the comp to opaque black, over the whole stage: the
  // picture surface paints the stage's own colour there (read from the CSS, which
  // owns the palette), or the surround would always look black.
  const [surroundRgb, setSurroundRgb] = useState<[number, number, number] | null>(null);
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!active || !stage) return;
    const rgb = parseCssRgb(getComputedStyle(stage).backgroundColor);
    setSurroundRgb((prev) => (prev && rgb && prev.every((v, i) => v === rgb[i]) ? prev : rgb));
  }, [active, shownSurround]);
  const pictureSurround = useMemo<PaneSurround | null>(
    () => (surroundRgb ? { color: surroundRgb, compWidth: width, compHeight: height } : null),
    [surroundRgb, width, height],
  );
  const [safeAreas, setSafeAreasState] = useState(() => readPref(SAFE_KEY) === '1');
  const setSurround = (next: Surround): void => {
    setSurroundState(next);
    writePref(SURROUND_KEY, next);
  };
  const setSafeAreas = (next: boolean): void => {
    setSafeAreasState(next);
    writePref(SAFE_KEY, next ? '1' : '0');
  };

  // The stage's box, for placing the safe-area guides over the picture (the
  // engine contain-fits the comp into this same box).
  const [stageBox, setStageBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = stageRef.current;
    if (!active || !el || typeof ResizeObserver === 'undefined') return;
    const measure = (): void => {
      const r = el.getBoundingClientRect();
      setStageBox((prev) => (prev.w === r.width && prev.h === r.height ? prev : { w: r.width, h: r.height }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [active]);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Auto-play from the start on enter; stop on exit.
  //
  // Previously setPlaying(true) fired synchronously the moment `active` turned
  // true — before the canvas had been mounted in the DOM, before the GPU backend
  // had initialised, and before the ResizeObserver had sized the surface. The
  // playback clock then hammered renderImmediate against a null backend
  // (no-ops), and when the backend came up the render queue was already backed
  // up. On complex 3D/2D scenes one buildSnapshot call can take >50 ms, causing
  // the event loop to stall and making Esc/close completely unresponsive.
  //
  // Fix: defer auto-play by one rAF (≈ one paint) so React has committed the
  // portal DOM and the engine surface has mounted and measured its box. This
  // is not a "wait for the first frame" — the engine may still be rendering —
  // but it gives the layout engine time to mount the stage before playback
  // is requested.
  useEffect(() => {
    if (!active) {
      setPlaying(false);
      setBackendReady(false);
      return;
    }
    goToStart();

    // One rAF delay lets the portal DOM commit and the resize observer fire
    // before we start the clock.
    const rafId = requestAnimationFrame(() => {
      setPlaying(true);
      // Mark backend as "ready enough to show" after the first rAF — the
      // spinner disappears and the canvas is revealed. The real first pixel may
      // arrive a frame later (GPU init is async), but the spinner covers that.
      setBackendReady(true);
    });

    return () => {
      cancelAnimationFrame(rafId);
      setPlaying(false);
    };
  }, [active, setPlaying]);

  // Reveal chrome; while playing, re-arm an idle timer that hides it. Paused
  // always shows (the user is inspecting a still, not watching).
  const pokeControls = useCallback(() => {
    setUiVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (playing) hideTimer.current = setTimeout(() => setUiVisible(false), IDLE_HIDE_MS);
  }, [playing]);

  useEffect(() => {
    pokeControls();
    return () => { if (hideTimer.current) clearTimeout(hideTimer.current); };
  }, [pokeControls]);

  // ── Transport ──────────────────────────────────────────────────────
  const togglePlay = useCallback(() => setPlaying(!playing), [playing, setPlaying]);
  const toggleLoop = useCallback(() => {
    const on = !looping;
    setTransportLooping(on);
    setLoopingState(on);
  }, [looping]);
  const toggleFullscreen = useCallback(() => {
    const el = rootRef.current;
    if (!el) return;
    if (!document.fullscreenElement) el.requestFullscreen?.().catch(() => {});
    else document.exitFullscreen?.().catch(() => {});
  }, []);

  // Download the current frame. Rendered through the deterministic offline
  // path rather than read off the live preview canvas: a WebGL/WebGPU canvas
  // returns a BLANK toBlob (the drawing buffer is cleared after composite
  // unless preserveDrawingBuffer is set), so reading the surface only worked on
  // Canvas2D. The offline renderer produces a correct frame on any backend.
  const downloadFrame = useCallback(() => {
    void (async () => {
      // The composition record from the mirror; the frame from the engine's page-render seam.
      // The engine's still of this frame at full size (getThumbnail, engineStill.ts).
      const compId = activeCompIdNow();
      const blob = compId ? await engineCompStill(compId, currentFrame / fps, Math.max(width, height)) : null;
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${(name || 'frame').replace(/\s+/g, '_')}_${String(currentFrame).padStart(4, '0')}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    })();
  }, [name, currentFrame, fps, width, height]);

  // ── Seekable scrub bar ─────────────────────────────────────────────
  const seekToClientX = useCallback((clientX: number) => {
    const el = scrubRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const frac = r.width > 0 ? Math.min(1, Math.max(0, (clientX - r.left) / r.width)) : 0;
    seekPlayhead(frac * duration);
  }, [duration]);

  const onScrubDown = (e: React.PointerEvent): void => {
    draggingRef.current = true;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    seekToClientX(e.clientX);
  };
  const onScrubMove = (e: React.PointerEvent): void => {
    if (draggingRef.current) seekToClientX(e.clientX);
  };
  const onScrubUp = (e: React.PointerEvent): void => {
    draggingRef.current = false;
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
  };

  const handleExit = useCallback((e?: React.SyntheticEvent | Event) => {
    e?.stopPropagation();
    setPlaying(false);
    if (document.fullscreenElement) {
      document.exitFullscreen?.().catch(() => {});
    }
    exit();
  }, [exit, setPlaying]);

  // ── Keyboard shortcuts ─────────────────────────────────────────────
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent): void => {
      switch (e.key) {
        case 'Escape': e.preventDefault(); handleExit(e); break;
        case ' ': e.preventDefault(); setPlaying(!playing); break;
        case 'ArrowLeft': e.preventDefault(); stepBackward(); break;
        case 'ArrowRight': e.preventDefault(); stepForward(); break;
        case 'Home': e.preventDefault(); goToStart(); break;
        case 'End': e.preventDefault(); goToEnd(); break;
        case 'l': case 'L': toggleLoop(); break;
        case 'f': case 'F': toggleFullscreen(); break;
        default: break;
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true } as EventListenerOptions);
  }, [active, handleExit, setPlaying, playing, toggleLoop, toggleFullscreen]);

  useEffect(() => {
    const onFs = (): void => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  // Mounted even while closed (it is what opens the Preview from its address),
  // and at the SAME place in the tree open or closed: remounting it as the page
  // opened ran its first effect twice under StrictMode and pushed the address
  // twice, so Back had to be pressed twice.
  const address = inRouter ? <PreviewAddress active={active} enter={enter} exit={exit} /> : null;
  if (!active) return <>{address}</>;

  const pct = `${progress * 100}%`;

  // The picture's rect inside the stage (contain fit) — where the guides go.
  const fit = stageBox.w > 0 && stageBox.h > 0 ? Math.min(stageBox.w / width, stageBox.h / height) : 0;
  const pictureW = width * fit;
  const pictureH = height * fit;

  const resolutionItems: DropdownItem[] = QUALITY_ORDER.map((q) => ({
    type: 'checkbox',
    id: `res-${q}`,
    label: RESOLUTION_LABELS[q],
    checked: previewResolution === q,
    onChange: () => setResolution(q),
  }));
  const viewItems: DropdownItem[] = [
    { type: 'checkbox', id: 'safe', label: 'Title / action safe', checked: safeAreas, onChange: setSafeAreas },
    { type: 'separator' },
    { type: 'label', label: 'Background' },
    ...(Object.keys(SURROUND_LABEL) as Surround[]).map((key): DropdownItem => ({
      type: 'checkbox',
      id: `surround-${key}`,
      label: SURROUND_LABEL[key],
      checked: surround === key,
      onChange: () => setSurround(key),
    })),
  ];

  const page = createPortal(
    <div
      ref={rootRef}
      className={styles.root}
      role="region"
      aria-label="Preview"
      data-hidden={uiVisible ? undefined : ''}
      data-surround={shownSurround}
      // Where the app draws its OWN caption buttons (no OS overlay), they live in
      // the title bar — so this page starts under it rather than covering them.
      data-under-titlebar={hasDesktopChrome() && getUiPlatform() !== 'mac' && getWindowControls() === 'drawn' ? '' : undefined}
      onPointerMove={pokeControls}
    >
      <div className={styles.topBar} data-mac={hasDesktopChrome() && getUiPlatform() === 'mac' ? '' : undefined}>
        <button type="button" className={styles.back} onClick={handleExit} title="Back to editor (Esc)">
          <Icon name="chevron-left" size="sm" />
          <span>Back to editor</span>
        </button>
        <div className={styles.title} title={name}>{name || 'Composition'}</div>
        <div className={styles.topActions}>
          <Dropdown
            placement="bottom-end"
            items={resolutionItems}
            trigger={
              <button type="button" className={styles.select} title="Preview resolution — fewer pixels play back faster">
                <span>{RESOLUTION_LABELS[previewResolution]}</span>
                <Icon name="chevron-down" size="sm" />
              </button>
            }
          />
          <Dropdown
            placement="bottom-end"
            items={viewItems}
            trigger={
              <button type="button" className={styles.select} title="Guides and background">
                <span>View</span>
                <Icon name="chevron-down" size="sm" />
              </button>
            }
          />
          <button type="button" className={styles.pill} onClick={downloadFrame} title="Save the current frame as a PNG">
            Save frame
          </button>
          <button type="button" className={styles.pillPrimary} onClick={() => openExportDialog(duration, fps)} title="Export video…">
            Export
          </button>
        </div>
      </div>

      <div className={styles.stage} ref={stageRef}>
        {active && <EnginePaneSurface mode="active" framingRev={0} surround={pictureSurround} className={styles.canvas} />}
        {/* Quality = Wireframe boxes over the stage, through the same contain fit
            the engine draws with (`paintWireframeOverlay`). */}
        <canvas ref={wireframeCanvasRef} aria-hidden style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }} />
        {safeAreas && fit > 0 && (
          <div className={styles.safe} style={{ width: pictureW, height: pictureH }} aria-hidden>
            <span className={styles.safeAction} />
            <span className={styles.safeTitle} />
          </div>
        )}
        {/* Loading spinner — shown until the first rAF fires (surface mounting).
            Prevents the user from seeing a blank stage and assuming it's broken. */}
        {!backendReady && (
          <div className={styles.stageLoader} aria-label="Loading preview…">
            <div className={styles.stageSpinner} />
          </div>
        )}
      </div>

      {/* The playback bar: scrub strip, then one row of controls. */}
      <div className={styles.controls}>
        <div
          className={styles.scrub}
          ref={scrubRef}
          role="slider"
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={durationFrames}
          aria-valuenow={currentFrame}
          onPointerDown={onScrubDown}
          onPointerMove={onScrubMove}
          onPointerUp={onScrubUp}
        >
          <div className={styles.scrubFill} style={{ width: pct }} />
          <div className={styles.scrubHandle} style={{ left: pct }} />
        </div>

        <div className={styles.row}>
          <div className={styles.times}>
            <span className={styles.timecode}>{framesToTimecode(currentFrame / fps, fps, startFrame)}</span>
            <span className={styles.duration}>/ {framesToTimecode(durationFrames / fps, fps, startFrame)}</span>
          </div>

          <div className={styles.transport}>
            <button type="button" className={styles.tBtn} onClick={() => goToStart()} title="Go to start (Home)" aria-label="Go to start">
              <Icon name="skip-back" size="sm" />
            </button>
            <button type="button" className={styles.tBtn} onClick={() => stepBackward()} title="Previous frame (←)" aria-label="Previous frame">
              <Icon name="chevron-left" size="sm" />
            </button>
            <button type="button" className={playing ? styles.playOn : styles.play} onClick={togglePlay} title={playing ? 'Pause (Space)' : 'Play (Space)'} aria-label={playing ? 'Pause' : 'Play'}>
              <Icon name={playing ? 'pause' : 'play'} size="sm" />
            </button>
            <button type="button" className={styles.tBtn} onClick={() => stepForward()} title="Next frame (→)" aria-label="Next frame">
              <Icon name="chevron-right" size="sm" />
            </button>
            <button type="button" className={styles.tBtn} onClick={() => goToEnd()} title="Go to end (End)" aria-label="Go to end">
              <Icon name="skip-forward" size="sm" />
            </button>
            <span className={styles.tSep} aria-hidden />
            <button
              type="button"
              className={looping ? styles.tBtnActive : styles.tBtn}
              onClick={toggleLoop}
              title="Loop playback (L)"
              aria-label="Loop playback"
              aria-pressed={looping}
            >
              <Icon name="loop" size="sm" />
            </button>
          </div>

          <div className={styles.facts}>
            <span>{width} × {height} · {fps} fps · frame {currentFrame} of {durationFrames}</span>
            <button type="button" className={styles.tBtn} onClick={toggleFullscreen} title={isFullscreen ? 'Exit full screen (F)' : 'Full screen (F)'} aria-label="Toggle fullscreen">
              <Icon name={isFullscreen ? 'minimize' : 'maximize'} size="sm" />
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );

  return (
    <>
      {address}
      {page}
    </>
  );
}

export default PresentationMode;
