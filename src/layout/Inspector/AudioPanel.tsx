/**
 * The Audio panel — After Effects' Ctrl+4.
 *
 * What makes this a panel rather than a fourth VU meter: **the faders edit the
 * selected layer.** The three meters this app already had (`InfoAudioPanel`,
 * `PreviewPanel`, the status-bar `VUMeter`) all monitor the master bus and none
 * of them can change a level, so "the mix is too loud" had no control anywhere
 * near the thing measuring it. Here the meter and the fader that fixes what it
 * shows are the same six inches of screen.
 *
 * ## Two faders, one dB property and one pan
 *
 * AE draws an L and an R fader and calls the pair "Audio Levels". We store a
 * single `audioLevelDb` plus `audioPan`, and derive the two fader positions
 * from them. That is a deliberate schema choice, not an approximation:
 *
 *  - Both halves stay SCALAR, so they keyframe, graph-edit, and ride the
 *    existing ramp builder that keeps preview and export identical. A
 *    two-component property would need its own sampling path, and the graph
 *    editor could not draw it.
 *  - It gives us a real per-layer Pan, which the app did not have at all —
 *    panning previously meant applying the Stereo Mixer *effect*.
 *  - Independent L/R trims are exactly a level plus a balance, so nothing the
 *    two AE faders can express is lost.
 *
 * Dragging one fader moves level and pan together; the arithmetic and its
 * inverse live in `faderMath.ts`, tested there.
 *
 * ## Units and floor
 *
 * AE's Audio panel menu offers Units (decibels / percent) and a Slider Minimum.
 * Both are here, and both are per-user view settings rather than document
 * state — they change how a number is spelled, never what is stored.
 */

import { useEffect, useRef, useState } from 'react';
import { useSelectionStore } from '@stores/selectionStore';
import { useSceneRevision, bumpScene } from '@stores/sceneStore';
import { useActiveWorkspace } from '@stores/projectStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { audioEngine } from '@core/audio/AudioEngine';
import { toDb, meterFraction } from '@core/audio/audioLevels';
import {
  AUDIO_LEVEL_DB_PROP, AUDIO_PAN_PROP,
  MAX_LEVEL_DB, percentToDb,
} from '@core/audio/audioParams';
import { readNodeKind } from '@core/scene/sceneDerive';
import { audioComponent, VIDEO_AUDIO_LEVEL_PROP } from '@core/audio/audioScene';
import { defaultAnimation } from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';
import { compToKeyframeTime } from '@core/timeline/TimelineController';
import { applyFade, DEFAULT_FADE_SEC } from '@core/audio/audioFades';
import { channelDb, fromChannelDb, CLIP_DB } from './faderMath';
import { InfoReadout } from './InfoReadout';
import { Icon } from '@components/Icon';
import { cn } from '@utils/cn';
import styles from './AudioPanel.module.css';

/** Meter refresh. 30 Hz is smooth to the eye and a third of the work of 90. */
const METER_HZ = 30;
/** How long a clip indicator stays lit after the peak that set it. */
const CLIP_HOLD_MS = 2000;
/** How long the peak-hold tick sits before it starts falling. */
const PEAK_HOLD_MS = 1200;

type Units = 'db' | 'percent';

interface Target {
  nodeId: string;
  /** The component the static props live on — Audio, or the video Transform. */
  componentId: string;
  levelDb: number;
  pan: number;
  levelAnimated: boolean;
  panAnimated: boolean;
}

/**
 * The selected layer that makes a sound, resolved to what the faders need.
 *
 * `compSec` matters once a property is ANIMATED: the fader has to show the value
 * at the playhead, not the static base underneath the track. Without it the
 * panel and the inspector's own Level row disagreed — mid-fade the row read
 * −60 dB while the fader sat at 0 — which is the fastest way to make a user
 * stop trusting a mixer. Found by walking the app with a real clip; no unit test
 * would have noticed, because both halves were individually correct.
 */
function readTarget(nodeId: string | undefined, compSec: number): Target | null {
  if (!nodeId) return null;
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return null;
  const kind = readNodeKind(node);
  if (kind !== 'audio' && kind !== 'video') return null;
  const comp = kind === 'audio' ? audioComponent(node) : node.components.find((c) => c.type === 'Transform');
  if (!comp) return null;
  const p = comp.props as Record<string, unknown>;
  const legacy = kind === 'audio' ? p.__level : p[VIDEO_AUDIO_LEVEL_PROP];
  const levelDb =
    typeof p[AUDIO_LEVEL_DB_PROP] === 'number'
      ? (p[AUDIO_LEVEL_DB_PROP] as number)
      : typeof legacy === 'number'
        ? percentToDb(legacy)
        : 0;
  const staticPan = typeof p[AUDIO_PAN_PROP] === 'number' ? (p[AUDIO_PAN_PROP] as number) : 0;
  const levelAnimated = defaultAnimation.isAnimated(nodeId, AUDIO_LEVEL_DB_PROP);
  const panAnimated = defaultAnimation.isAnimated(nodeId, AUDIO_PAN_PROP);

  // The canonical keyframe axis — what the renderer samples for this node, and
  // what `KeyframeRow` uses, so the two controls cannot land on different times
  // for a retimed layer.
  // B3-legacy: engine gap — audio fades and level keys on the audio component (not a catalog `audio/levels` layer here) are not API-addressed.
  const layerT = compToKeyframeTime(nodeId, compSec);
  const sample = (prop: string, fallback: number): number => {
    const v = defaultAnimation.sample(nodeId, prop, layerT);
    return typeof v === 'number' ? v : fallback;
  };

  return {
    nodeId,
    componentId: comp.id,
    levelDb: levelAnimated ? sample(AUDIO_LEVEL_DB_PROP, levelDb) : levelDb,
    pan: panAnimated ? sample(AUDIO_PAN_PROP, staticPan) : staticPan,
    levelAnimated,
    panAnimated,
  };
}

export function AudioPanel(): JSX.Element {
  useSceneRevision((s) => s.rev);
  const selectedIds = useSelectionStore((s) => s.ids);
  const time = useActiveWorkspace()?.time ?? 0;
  const autoKeyframe = usePreferenceStore((s) => s.timelineAutoKeyframe);

  const [units, setUnits] = useState<Units>('db');
  const [floorDb, setFloorDb] = useState(-48);
  const [menuOpen, setMenuOpen] = useState(false);

  // ── The master meter ──────────────────────────────────────────────
  const [bars, setBars] = useState({ l: 0, r: 0 });
  const [peaks, setPeaks] = useState({ l: 0, r: 0 });
  const [clipped, setClipped] = useState({ l: 0, r: 0 });
  const peakAt = useRef({ l: 0, r: 0 });

  useEffect(() => {
    let raf = 0;
    let last = 0;
    const tick = (now: number): void => {
      raf = requestAnimationFrame(tick);
      if (now - last < 1000 / METER_HZ) return;
      last = now;
      const lv = audioEngine.getLevels();
      if (!lv) {
        setBars({ l: 0, r: 0 });
        return;
      }
      const l = meterFraction(toDb(lv.l.rms), floorDb);
      const r = meterFraction(toDb(lv.r.rms), floorDb);
      setBars({ l, r });
      // Peak hold: the tick jumps up instantly and decays only after it has
      // sat still long enough to be read. A meter whose peak falls at the same
      // rate as the bar shows nothing the bar did not already show.
      setPeaks((prev) => {
        const next = { ...prev };
        for (const ch of ['l', 'r'] as const) {
          const v = ch === 'l' ? l : r;
          if (v >= prev[ch]) {
            next[ch] = v;
            peakAt.current[ch] = now;
          } else if (now - peakAt.current[ch] > PEAK_HOLD_MS) {
            next[ch] = Math.max(v, prev[ch] - 0.01);
          }
        }
        return next;
      });
      // Clipping is judged on absolute PEAK, not RMS — a single sample over
      // full scale is a clip, and RMS would never see it.
      setClipped((prev) => {
        const next = { ...prev };
        if (toDb(lv.l.peak) >= CLIP_DB) next.l = now;
        if (toDb(lv.r.peak) >= CLIP_DB) next.r = now;
        return next;
      });
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [floorDb]);

  const now = performance.now();
  const clipLit = { l: now - clipped.l < CLIP_HOLD_MS, r: now - clipped.r < CLIP_HOLD_MS };

  // ── The selected layer ────────────────────────────────────────────
  const target = readTarget(selectedIds.find((id) => readTarget(id, time) !== null), time);

  const write = (prop: string, value: number, clearAt?: number): void => {
    if (!target) return;
    const animated = prop === AUDIO_LEVEL_DB_PROP ? target.levelAnimated : target.panAnimated;
    if (animated || autoKeyframe) {
      // B3-legacy: engine gap — audio fades and level keys on the audio component (not a catalog `audio/levels` layer here) are not API-addressed.
      const t = compToKeyframeTime(target.nodeId, time, prop);
      runAnimEdit(`Set ${prop}`, () => defaultAnimation.setKeyframe(target.nodeId, prop, t, value), `set:${target.nodeId}:${prop}:${t}`);
      return;
    }
    // A prop whose value is its default is stored as ABSENT — that is what
    // keeps a document that never touched pan byte-identical (see `panOf`).
    // B3-legacy: engine gap — audio fades and level keys on the audio component (not a catalog `audio/levels` layer here) are not API-addressed.
    defaultSceneGraph.writeProp(
      target.nodeId,
      target.componentId,
      prop,
      clearAt !== undefined && value === clearAt ? undefined : value,
    );
    bumpScene();
  };

  /** Move one fader: solve back to a (level, pan) pair and write both. */
  const setChannel = (ch: 'l' | 'r', db: number): void => {
    if (!target) return;
    const other = channelDb(target.levelDb, target.pan, ch === 'l' ? 'r' : 'l');
    const next = fromChannelDb(ch === 'l' ? db : other, ch === 'l' ? other : db);
    write(AUDIO_LEVEL_DB_PROP, next.levelDb);
    if (next.pan !== target.pan) write(AUDIO_PAN_PROP, next.pan, 0);
  };

  const fmt = (db: number): string =>
    units === 'db'
      // `+ 0` collapses negative zero: an equal-power channel lands a hair
      // under unity, and `(-0).toFixed(1)` spells that "-0.0 dB", which reads
      // as an attenuation that is not there.
      ? `${db > 0 ? '+' : ''}${(db + 0).toFixed(1).replace(/^-0\.0$/, '0.0')} dB`
      // AE's own mapping: 100% is 0 dB.
      : `${Math.round(Math.pow(10, db / 20) * 100)}%`;

  const lDb = target ? channelDb(target.levelDb, target.pan, 'l') : 0;
  const rDb = target ? channelDb(target.levelDb, target.pan, 'r') : 0;

  return (
    <div className={styles.root}>
      <div className={styles.head}>
        <span className={styles.title}>Audio</span>
        <button
          type="button"
          className={styles.menuBtn}
          aria-label="Audio panel options"
          aria-expanded={menuOpen}
          title="Units and slider minimum"
          onClick={() => setMenuOpen((v) => !v)}
        >
          <Icon name="more-horizontal" size="sm" />
        </button>
      </div>

      {menuOpen && (
        <div className={styles.options} role="group" aria-label="Audio panel options">
          <label className={styles.optRow}>
            <span>Units</span>
            <select
              value={units}
              onChange={(e) => setUnits(e.currentTarget.value as Units)}
              aria-label="Level units"
            >
              <option value="db">Decibels</option>
              <option value="percent">Percent</option>
            </select>
          </label>
          <label className={styles.optRow}>
            <span>Slider minimum</span>
            <select
              value={String(floorDb)}
              onChange={(e) => setFloorDb(Number(e.currentTarget.value))}
              aria-label="Slider minimum"
            >
              {[-96, -72, -48, -24, -12].map((v) => (
                <option key={v} value={v}>{v} dB</option>
              ))}
            </select>
          </label>
        </div>
      )}

      {/* ── Pointer + composition readout (the old Info & Audio tab) ── */}
      <InfoReadout compact />

      {/* ── Meter + faders, sharing one dB scale ───────────────────── */}
      <div className={styles.deck}>
        <div className={styles.scale} aria-hidden="true">
          {scaleMarks(floorDb).map((db) => (
            <span key={db} style={{ bottom: `${meterFraction(db, floorDb) * 100}%` }}>{db}</span>
          ))}
        </div>

        {(['l', 'r'] as const).map((ch) => (
          <div key={ch} className={styles.strip}>
            <div
              className={cn(styles.clipLed, clipLit[ch] && styles.clipLedOn)}
              title={clipLit[ch] ? 'Clipped — the signal went over full scale' : 'No clipping'}
              aria-label={clipLit[ch] ? `${ch.toUpperCase()} clipped` : `${ch.toUpperCase()} not clipping`}
            />
            <div className={styles.meterWrap}>
              <div className={styles.meterBar}>
                <div className={styles.meterFill} style={{ height: `${bars[ch] * 100}%` }} />
                <div className={styles.peakTick} style={{ bottom: `${peaks[ch] * 100}%` }} />
              </div>
              <input
                className={styles.fader}
                type="range"
                // Firefox's legacy vertical-range opt-in. Not in React's typed
                // attribute set, hence the escape hatch; the CSS
                // `writing-mode` handles every other engine.
                {...{ orient: 'vertical' }}
                min={floorDb}
                max={MAX_LEVEL_DB}
                step={0.5}
                value={Math.max(floorDb, Math.min(MAX_LEVEL_DB, ch === 'l' ? lDb : rDb))}
                disabled={!target}
                onChange={(e) => setChannel(ch, Number(e.currentTarget.value))}
                aria-label={`${ch === 'l' ? 'Left' : 'Right'} level`}
              />
            </div>
            <span className={styles.chLabel}>{ch.toUpperCase()}</span>
          </div>
        ))}
      </div>

      {/* ── Readout ─────────────────────────────────────────────────── */}
      {target ? (
        <>
          <div className={styles.readout}>
            <span className={styles.readLabel}>L</span>
            <span className={styles.readVal}>{fmt(lDb)}</span>
            <span className={styles.readLabel}>R</span>
            <span className={styles.readVal}>{fmt(rDb)}</span>
          </div>
          <div className={styles.readout}>
            <span className={styles.readLabel}>Pan</span>
            <span className={styles.readVal}>
              {target.pan === 0 ? 'Centre' : `${Math.abs(target.pan)}% ${target.pan < 0 ? 'L' : 'R'}`}
            </span>
          </div>
          <div className={styles.fades}>
            <button
              type="button"
              // B3-legacy: engine gap — audio fades and level keys on the audio component (not a catalog `audio/levels` layer here) are not API-addressed.
              onClick={() => runAnimEdit('Fade Audio In', () => { applyFade(target.nodeId, 'in'); bumpScene(); })}
              title={`Ramp up from silence over ${DEFAULT_FADE_SEC}s`}
            >
              Fade in
            </button>
            <button
              type="button"
              // B3-legacy: engine gap — audio fades and level keys on the audio component (not a catalog `audio/levels` layer here) are not API-addressed.
              onClick={() => runAnimEdit('Fade Audio Out', () => { applyFade(target.nodeId, 'out'); bumpScene(); })}
              title={`Ramp down to silence over ${DEFAULT_FADE_SEC}s`}
            >
              Fade out
            </button>
          </div>
          {(target.levelAnimated || target.panAnimated) && (
            <p className={styles.note}>
              {target.levelAnimated && target.panAnimated
                ? 'Level and pan are keyframed'
                : target.levelAnimated ? 'Level is keyframed' : 'Pan is keyframed'}
              {' '}— moving a fader keys at the playhead.
            </p>
          )}
        </>
      ) : (
        <p className={styles.note}>
          Select a layer with sound to set its level and pan. The meter above
          always shows the master mix.
        </p>
      )}
    </div>
  );
}

/** The dB gridlines that fit the chosen floor without crowding. */
function scaleMarks(floorDb: number): number[] {
  const all = [MAX_LEVEL_DB, 6, 0, -6, -12, -24, -36, -48, -72, -96];
  return all.filter((db) => db <= MAX_LEVEL_DB && db >= floorDb);
}
