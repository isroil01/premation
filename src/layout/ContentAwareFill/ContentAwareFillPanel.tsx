/**
 * Content-Aware Fill panel (AE parity 3.7; AE's Window ▸ Content-Aware Fill).
 *
 * Fill Target is the layer's masks (drawn around what to remove; a Subtract
 * mask keeps an area out, Expansion grows the hole). Fill Method, Lighting
 * Correction and Range are the job's options; reference frames are clean
 * plates the user painted ("Create Reference Frame" writes one to paint).
 * "Generate Fill" runs the engine job and attaches the result to the layer as
 * one undo entry. All settings are editor state (contentAwareFillStore).
 */

import { flicksToSeconds } from '@motion/engine-api';
import { Button } from '@components/Button';
import { Progress } from '@components/Progress/Progress';
import { Segmented } from '@components/Segmented/Segmented';
import { ValueField } from '@components/ValueField/ValueField';
import { compFps, useActiveMirrorComp, useMirrorLayer } from '@hooks/useMirror';
import { useFootageSource } from '@hooks/useFootageSource';
import { useActiveWorkspace } from '@stores/projectStore';
import { useContentAwareFillStore, type FillRange } from '@stores/contentAwareFillStore';
import { settingsWorkArea } from '@core/mirror/compFacts';
import {
  FILL_MODES,
  LIGHTING,
  contentAwareFillSummaryText,
  startContentAwareFill,
  type ContentAwareFillRequest,
  type ContentAwareLighting,
} from '@core/tracking/contentAwareFill';
import styles from './ContentAwareFillPanel.module.css';

const RANGES: ReadonlyArray<{ value: FillRange; label: string }> = [
  { value: 'workArea', label: 'Work Area' },
  { value: 'layer', label: 'Layer' },
  { value: 'entire', label: 'Entire Duration' },
];

function timecode(seconds: number, fps: number): string {
  const f = Math.round(seconds * fps);
  const s = Math.floor(f / fps);
  const ff = f - s * Math.round(fps);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}:${String(Math.max(0, ff)).padStart(2, '0')}`;
}

export function ContentAwareFillPanel(): JSX.Element {
  const source = useFootageSource();
  const layerId = source.activeId;
  const layer = useMirrorLayer(layerId);
  const comp = useActiveMirrorComp();
  const fps = compFps(comp);
  const time = useActiveWorkspace()?.time ?? 0;
  const st = useContentAwareFillStore();
  const refs = layerId ? st.references[layerId] ?? [] : [];

  if (!layerId || !layer) {
    return (
      <div className={styles.panel}>
        <p className={styles.text}>
          Content-Aware Fill removes an object from footage. Add a video layer to the composition, draw a mask around what to
          remove, then generate the fill here.
        </p>
      </div>
    );
  }

  const rangeSeconds = (): { start: number; end: number } => {
    const duration = comp?.settings ? flicksToSeconds(comp.settings.duration) : time + 1;
    const layerIn = flicksToSeconds(layer.timing.inPoint);
    const layerOut = flicksToSeconds(layer.timing.outPoint);
    let start = 0;
    let end = duration;
    if (st.range === 'workArea') {
      const wa = settingsWorkArea(comp?.settings);
      if (wa) ({ start, end } = wa);
    } else if (st.range === 'layer') {
      start = layerIn;
      end = layerOut;
    }
    // Never outside the layer: there is no footage there.
    return { start: Math.max(start, layerIn), end: Math.min(end, layerOut) };
  };

  const request = (createReference: boolean): ContentAwareFillRequest => {
    const { start, end } = rangeSeconds();
    return {
      layer: layerId,
      start: createReference ? time : start,
      end: createReference ? time + 1 / fps : end,
      fps,
      mode: st.mode,
      lighting: st.lighting,
      expansion: st.expansion,
      references: refs,
      createReference,
    };
  };

  const run = async (createReference: boolean): Promise<void> => {
    const s = useContentAwareFillStore.getState();
    if (s.running) return;
    try {
      const job = await startContentAwareFill(request(createReference), (f, msg) => s.setProgress(f, msg));
      s.begin(job.cancel);
      const out = await job.done;
      if (out.status === 'failed') s.finish(out.error?.message ?? 'Content-Aware Fill failed.');
      else if (out.status === 'cancelled') s.finish('Content-Aware Fill cancelled. Nothing was changed.');
      else {
        const summary = out.result;
        if (createReference && summary?.files?.[0] && layerId) {
          // The plate is listed at once: painting it in place is the usual next step.
          s.addReference(layerId, { time, src: summary.files[0] });
        }
        s.finish(contentAwareFillSummaryText(summary, createReference));
      }
    } catch (e) {
      s.finish(e instanceof Error ? e.message : String(e));
    }
  };

  const addReference = async (): Promise<void> => {
    const pick = window.motionEditor?.shell?.pickFiles;
    if (!pick) {
      st.finish('Adding a reference frame needs the desktop app.');
      return;
    }
    const files = await pick();
    const file = files?.find((f) => /\.png$/i.test(f)) ?? files?.[0];
    if (file) st.addReference(layerId, { time, src: file });
  };

  const { start, end } = rangeSeconds();
  const frames = Math.max(0, Math.round((end - start) * fps));
  const modeHint = FILL_MODES.find((m) => m.value === st.mode)?.hint ?? '';

  return (
    <div className={styles.panel}>
      {source.layers.length > 1 && !source.selectedId ? (
        <label className={styles.field}>
          <span className={styles.label}>Layer</span>
          <select aria-label="Fill layer" className={styles.select} value={layerId} onChange={(e) => source.choose(e.target.value)}>
            {source.layers.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </label>
      ) : (
        <p className={styles.text}><strong>{layer.name || layerId}</strong></p>
      )}

      <section className={styles.section} aria-label="Fill Target">
        <h3 className={styles.title}>Fill Target</h3>
        <p className={styles.text}>The layer’s masks are the hole. A Subtract mask keeps an area out; mode None is ignored.</p>
        <label className={styles.field}>
          <span className={styles.label}>Expansion</span>
          <ValueField aria-label="Expansion" value={st.expansion} onChange={st.setExpansion} min={-100} max={100} step={1} unit="px" />
        </label>
      </section>

      <section className={styles.section} aria-label="Fill Method">
        <h3 className={styles.title}>Fill Method</h3>
        <Segmented aria-label="Fill Method" size="sm" fullWidth options={FILL_MODES.map((m) => ({ value: m.value, label: m.label }))} value={st.mode} onChange={st.setMode} />
        <p className={styles.hint}>{modeHint}</p>
        <label className={styles.field}>
          <span className={styles.label}>Lighting Correction</span>
          <select
            aria-label="Lighting Correction"
            className={styles.select}
            value={st.lighting}
            disabled={st.mode === 'edgeBlend'}
            onChange={(e) => st.setLighting(e.target.value as ContentAwareLighting)}
          >
            {LIGHTING.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
          </select>
        </label>
      </section>

      <section className={styles.section} aria-label="Range">
        <h3 className={styles.title}>Range</h3>
        <Segmented aria-label="Range" size="sm" fullWidth options={RANGES} value={st.range} onChange={st.setRange} />
        <p className={styles.hint}>{`${timecode(start, fps)} – ${timecode(end, fps)} · ${frames} frame${frames === 1 ? '' : 's'}`}</p>
      </section>

      <section className={styles.section} aria-label="Reference Frames">
        <h3 className={styles.title}>Reference Frames</h3>
        <p className={styles.text}>
          A painted clean plate for a frame fills that frame exactly and guides the frames around it.
        </p>
        {refs.length > 0 ? (
          <ul className={styles.list} aria-label="Reference frames">
            {refs.map((r) => (
              <li key={r.time} className={styles.row}>
                <span className={styles.time}>{timecode(r.time, fps)}</span>
                <span className={styles.path} title={r.src}>{r.src.split(/[\\/]/).pop()}</span>
                <Button size="sm" variant="ghost" onClick={() => st.removeReference(layerId, r.time)} aria-label={`Remove reference at ${timecode(r.time, fps)}`}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className={styles.actions}>
          <Button size="sm" variant="secondary" disabled={st.running} onClick={() => void run(true)}>Create Reference Frame</Button>
          <Button size="sm" variant="secondary" disabled={st.running} onClick={() => void addReference()}>Add Reference…</Button>
        </div>
      </section>

      <div className={styles.actions}>
        <Button variant="primary" disabled={st.running || frames === 0} onClick={() => void run(false)}>Generate Fill</Button>
        {st.running ? <Button variant="secondary" onClick={() => st.cancel?.()}>Cancel</Button> : null}
      </div>
      {st.running ? <Progress value={st.progress} label={st.status} showValue size="sm" /> : null}
      {!st.running && st.status ? <p className={styles.text} role="status">{st.status}</p> : null}
    </div>
  );
}
