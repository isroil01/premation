/**
 * Audio Driver — "make this property follow the music" as a control.
 *
 * The panel is arranged around the sentence a person is trying to say, in the
 * order they say it: WHAT moves (the property), FROM WHAT (a source and a
 * band), HOW IT RESPONDS (attack / release / gate), and BETWEEN WHAT (min /
 * max and a curve). The preview strip sits directly above Apply because the
 * question every one of those controls raises — "did that do what I meant?" —
 * has no other answer until the bake lands, and re-baking to find out is the
 * loop this section exists to remove.
 *
 * The strip is drawn from `computeDriverEnvelope`, the same function the bake
 * calls. A cheaper "good enough for preview" path was the obvious shortcut and
 * would have been the usual lie: the two would agree on the easy cases and
 * disagree exactly where the parameters are doing something interesting.
 *
 * Mode is not a user choice presented as an equal pair. Most drivers CANNOT be
 * an expression — `audio` is the live broadband meter, with no band, no memory
 * and no time argument — so the section says which one it will use and, when
 * it declines an expression, why. See `core/audio/audioDriver.ts`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@components/Button';
import { Slider } from '@components/Slider';
import { ValueField } from '@components/ValueField';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeKind } from '@core/scene/sceneDerive';
import { useSceneRevision } from '@stores/sceneStore';
import { buildStaticPropertyTree } from '@core/timeline/propertyTree';
import { resolvePropertyMeta, propertyLabel, GROUP_PLACEHOLDER_PREFIX } from '@core/inspector/propertyMeta';
import {
  applyAudioDriver,
  computeDriverEnvelope,
  defaultAudioDriver,
  driverRange,
  expressionBlocker,
  readAudioDrivers,
  removeAudioDriver,
  BAND_LABELS,
  CURVES,
  CURVE_LABELS,
  MIX_SOURCE,
  type AudioDriver,
  type AudioBand,
  type DriverEnvelope,
  type EnvelopeCurve,
} from '@core/audio/audioDriver';
import styles from './AudioDriverSection.module.css';

/** Property value types a 0..1 envelope can sensibly drive. */
const NUMERIC_TYPES = new Set(['number', 'percent', 'angle', 'multiplier']);

interface PropOption {
  path: string;
  label: string;
}

/**
 * Every numeric property of this layer that can hold a keyframe.
 *
 * Derived from `buildStaticPropertyTree` rather than from a hand-written list,
 * which is what makes effect parameters, expression-control sliders and plugin
 * layer-kind properties appear here without this file knowing they exist. A
 * local list would have covered transform and then quietly gone stale — the
 * exact failure `propertyMeta` was built to end.
 */
function numericProps(nodeId: string): PropOption[] {
  const out: PropOption[] = [];
  const seen = new Set<string>();
  for (const row of buildStaticPropertyTree(nodeId)) {
    for (const path of row.members) {
      if (seen.has(path)) continue;
      // Placeholders stand for a group of real paths; the real ones are in
      // `members` of their own rows, so keying one would key nothing.
      if (path.startsWith(GROUP_PLACEHOLDER_PREFIX)) continue;
      const meta = resolvePropertyMeta(path, nodeId);
      if (!NUMERIC_TYPES.has(meta.type)) continue;
      seen.add(path);
      const own = propertyLabel(path, nodeId);
      out.push({
        path,
        label: row.members.length > 1 && own !== row.label ? `${row.label} · ${own}` : row.label,
      });
    }
  }
  return out;
}

/**
 * Whether this layer has anything an envelope could drive.
 *
 * Exported so the Inspector can decide whether to emit the accordion HEADER at
 * all: a section that renders null still leaves its twirl-down title behind,
 * and an "Audio Driver" heading that opens onto nothing is worse than no
 * heading — it reads as a broken panel rather than as an inapplicable one.
 */
export function hasAudioDriverSection(nodeId: string): boolean {
  return numericProps(nodeId).length > 0;
}

/** Audio-kind layers, via `traverse` — `flattenScene` is empty on a fresh project. */
function audioLayers(): Array<{ id: string; name: string }> {
  const out: Array<{ id: string; name: string }> = [];
  defaultSceneGraph.traverse((n) => {
    if (readNodeKind(n) === 'audio') out.push({ id: n.id, name: n.name ?? n.id });
  });
  return out;
}

/** The band <select> value for a driver's band (custom ranges show as "custom"). */
function bandValue(band: AudioBand): string {
  return typeof band === 'string' ? band : 'custom';
}

export function AudioDriverSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  const rev = useSceneRevision((s) => s.rev);
  const node = defaultSceneGraph.getNode(nodeId);

  // No early return above this line: every hook below runs on every render,
  // including for a node that has just been deleted.
  const options = useMemo(() => (node ? numericProps(nodeId) : []), [nodeId, rev, node]);
  const sources = useMemo(() => audioLayers(), [rev]);
  const stored = useMemo(() => (node ? readAudioDrivers(node) : {}), [node, rev]);

  const [prop, setProp] = useState<string>('');
  const [draft, setDraft] = useState<AudioDriver>(() => defaultAudioDriver(''));
  const [env, setEnv] = useState<DriverEnvelope | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // The chosen property follows the layer: a driver already on it wins, else
  // the first animatable numeric property. Re-derived when the options change
  // so switching layers never leaves a path that belongs to the previous one.
  const activePath = prop && options.some((o) => o.path === prop)
    ? prop
    : (Object.keys(stored)[0] ?? options[0]?.path ?? '');

  useEffect(() => {
    if (!activePath) return;
    setDraft(stored[activePath] ?? { ...defaultAudioDriver(activePath) });
    setNote(null);
  }, [activePath, nodeId]);

  // Preview. Debounced, because every slider drag would otherwise start an FFT
  // pass over the whole work area on each pointer move.
  const key = JSON.stringify(draft);
  useEffect(() => {
    if (!activePath) {
      setEnv(null);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      void computeDriverEnvelope(draft)
        .then((e) => { if (alive) setEnv(e); })
        .catch(() => { if (alive) setEnv(null); });
    }, 180);
    return (): void => {
      alive = false;
      clearTimeout(timer);
    };
  }, [key, activePath]);

  // Draw the strip. Plain 2D, no library: it is one polyline and a baseline.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const read = (name: string, fallback: string): string => {
      const v = getComputedStyle(canvas).getPropertyValue(name).trim();
      return v || fallback;
    };
    ctx.fillStyle = read('--color-surface-2', '#1a1a1a');
    ctx.fillRect(0, 0, w, h);
    const data = env?.raw;
    if (!data || data.length === 0) return;
    ctx.strokeStyle = read('--color-accent', '#4c8dff');
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
      const x = data.length > 1 ? (i / (data.length - 1)) * (w - 1) : 0;
      const y = h - 1 - (data[i] ?? 0) * (h - 2);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }, [env]);

  const set = useCallback(<K extends keyof AudioDriver>(k: K, v: AudioDriver[K]): void => {
    setDraft((d) => ({ ...d, [k]: v }));
  }, []);

  const apply = useCallback(async (): Promise<void> => {
    if (!activePath) return;
    setBusy(true);
    try {
      const result = await applyAudioDriver(nodeId, { ...draft, prop: activePath });
      setNote(
        result.error
          ? result.error
          : result.mode === 'expression'
            ? 'Applied as an expression.'
            : `Baked ${result.keyframes} keyframes${result.fellBackBecause ? ` — ${result.fellBackBecause}.` : '.'}`,
      );
    } finally {
      setBusy(false);
    }
  }, [nodeId, draft, activePath]);

  if (!node || options.length === 0 || !activePath) return null;

  const existing = stored[activePath];
  const blocker = draft.mode === 'expression' ? expressionBlocker({ ...draft, prop: activePath }) : null;
  const range = driverRange();

  return (
    <div className={styles.root}>
      <p className={styles.hint}>
        Drives a property from an audio envelope — no hand-written{' '}
        <code>value + audio * 200</code>. Bakes keyframes over the work area
        ({range.start.toFixed(2)}s–{range.end.toFixed(2)}s).
      </p>

      <div className={styles.row}>
        <span className={styles.label}>Property</span>
        <select
          className={styles.select}
          value={activePath}
          onChange={(e) => setProp(e.target.value)}
          aria-label="Driven property"
        >
          {options.map((o) => (
            <option key={o.path} value={o.path}>
              {o.label}{stored[o.path] ? ' ●' : ''}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.row}>
        <span className={styles.label}>Source</span>
        <select
          className={styles.select}
          value={draft.sourceLayerId}
          onChange={(e) => set('sourceLayerId', e.target.value)}
          aria-label="Audio source"
        >
          <option value={MIX_SOURCE}>Comp mix (all audio)</option>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
      </div>

      <div className={styles.row}>
        <span className={styles.label}>Band</span>
        <select
          className={styles.select}
          value={bandValue(draft.band)}
          onChange={(e) => {
            const v = e.target.value;
            set('band', v === 'custom' ? { lo: 20, hi: 250 } : (v as AudioBand));
          }}
          aria-label="Frequency band"
        >
          {(['full', 'low', 'mid', 'high'] as const).map((b) => (
            <option key={b} value={b}>{BAND_LABELS[b]}</option>
          ))}
          <option value="custom">Custom range…</option>
        </select>
      </div>

      {typeof draft.band === 'object' && (
        <div className={styles.row}>
          <span className={styles.label}>Hz</span>
          <ValueField
            value={draft.band.lo}
            min={0}
            onChange={(v) => set('band', { lo: Number(v), hi: (draft.band as { hi: number }).hi })}
            aria-label="Band low Hz"
          />
          <ValueField
            value={draft.band.hi}
            min={1}
            onChange={(v) => set('band', { lo: (draft.band as { lo: number }).lo, hi: Number(v) })}
            aria-label="Band high Hz"
          />
        </div>
      )}

      <div className={styles.row}>
        <span className={styles.label}>Attack</span>
        <Slider
          value={draft.attackMs}
          min={0}
          max={500}
          step={1}
          size="sm"
          aria-label="Attack milliseconds"
          onChange={(v) => set('attackMs', v)}
        />
        <span className={styles.readout}>{Math.round(draft.attackMs)} ms</span>
      </div>

      <div className={styles.row}>
        <span className={styles.label}>Release</span>
        <Slider
          value={draft.releaseMs}
          min={0}
          max={2000}
          step={5}
          size="sm"
          aria-label="Release milliseconds"
          onChange={(v) => set('releaseMs', v)}
        />
        <span className={styles.readout}>{Math.round(draft.releaseMs)} ms</span>
      </div>

      <div className={styles.row}>
        <span className={styles.label}>Gate</span>
        <Slider
          value={draft.gate}
          min={0}
          max={1}
          step={0.01}
          size="sm"
          aria-label="Gate floor"
          onChange={(v) => set('gate', v)}
        />
        <span className={styles.readout}>{draft.gate.toFixed(2)}</span>
      </div>

      <div className={styles.row}>
        <span className={styles.label}>Range</span>
        <ValueField value={draft.min} onChange={(v) => set('min', Number(v))} aria-label="Output minimum" />
        <ValueField value={draft.max} onChange={(v) => set('max', Number(v))} aria-label="Output maximum" />
      </div>

      <div className={styles.row}>
        <span className={styles.label}>Curve</span>
        <select
          className={styles.select}
          value={draft.curve}
          onChange={(e) => set('curve', e.target.value as EnvelopeCurve)}
          aria-label="Response curve"
        >
          {CURVES.map((c) => (
            <option key={c} value={c}>{CURVE_LABELS[c]}</option>
          ))}
        </select>
      </div>

      <div className={styles.row}>
        <span className={styles.label}>Smooth</span>
        <ValueField
          value={draft.smoothFrames}
          min={1}
          unit="f"
          onChange={(v) => set('smoothFrames', Math.max(1, Math.floor(Number(v))))}
          aria-label="Smoothing frames"
        />
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={draft.normalize}
            onChange={(e) => set('normalize', e.target.checked)}
            aria-label="Normalize to the loudest moment"
          />
          Normalize
        </label>
      </div>

      <div className={styles.row}>
        <span className={styles.label}>Mode</span>
        <select
          className={styles.select}
          value={draft.mode}
          onChange={(e) => set('mode', e.target.value === 'expression' ? 'expression' : 'baked')}
          aria-label="Driver mode"
        >
          <option value="baked">Baked keyframes</option>
          <option value="expression">Expression (if possible)</option>
        </select>
      </div>

      {blocker && (
        <p className={styles.warn}>Will bake instead — {blocker}.</p>
      )}

      <div className={styles.previewWrap}>
        <canvas ref={canvasRef} width={240} height={40} className={styles.preview} aria-label="Envelope preview" />
        {!env && <span className={styles.previewEmpty}>No audio in this range yet</span>}
      </div>

      <div className={styles.actions}>
        <Button size="sm" variant="primary" onClick={() => void apply()} disabled={busy}>
          {existing ? 'Re-bake' : 'Apply'}
        </Button>
        {existing && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => { removeAudioDriver(nodeId, activePath); setNote('Driver removed.'); }}
            disabled={busy}
          >
            Remove
          </Button>
        )}
      </div>

      {note && <p className={styles.note}>{note}</p>}
    </div>
  );
}

export default AudioDriverSection;
