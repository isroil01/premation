/**
 * InfoReadout — After Effects' Info panel, as values: the colour under the
 * pointer (R, G, B, A) beside its position (X, Y), then the selected layer —
 * its name, In, Out and Duration (2026-10).
 *
 * Everything shown is read, never invented: the pointer from `infoStore` (the
 * viewport writes it as the cursor moves), the layer from the document mirror
 * (`LayerInfo.timing`), the timecode in the layer's composition's own rate and
 * start frame — the same In / Out the timeline's columns show.
 *
 * The master meter that used to sit under this is gone: the Audio panel is the
 * one meter (and the one that can do something about what it shows).
 */

import { useInfoStore } from '@stores/infoStore';
import { useSelectionStore } from '@stores/selectionStore';
import { documentMirror } from '@stores/documentMirror';
import { useActiveMirrorComp, useMirrorLayer } from '@hooks/useMirror';
import { flicksToSeconds } from '@motion/engine-api';
import { settingsFps, settingsStartFrame } from '@core/mirror/compFacts';
import { framesToTimecode } from '@core/time/timecode';
import styles from './InfoAudioPanel.module.css';

/** One key / value pair of the readout — a label-role key, a value-role value. */
function Pair({ k, v, title }: { k: string; v: string; title?: string }): JSX.Element {
  return (
    <div className={styles.pair}>
      <dt className={styles.key}>{k}</dt>
      <dd className={styles.value} title={title}>{v}</dd>
    </div>
  );
}

export function InfoReadout(): JSX.Element {
  const { x, y, rgba, present } = useInfoStore();
  const selectedIds = useSelectionStore((s) => s.ids);
  const layer = useMirrorLayer(selectedIds[0]);
  const activeComp = useActiveMirrorComp();

  const channel = (v: number | undefined): string => (rgba && v !== undefined ? String(v) : '—');
  const swatch = rgba && rgba.a > 0
    ? `rgba(${rgba.r}, ${rgba.g}, ${rgba.b}, ${(rgba.a / 255).toFixed(2)})`
    : 'transparent';

  // The layer's own composition (the active one, almost always) sets the rate
  // and the start frame its In / Out read on.
  const comp = (layer && documentMirror().comp(layer.comp)) || activeComp;
  const fps = settingsFps(comp?.settings);
  const startFrame = settingsStartFrame(comp?.settings);
  const inSec = layer ? flicksToSeconds(layer.timing.inPoint) : 0;
  const outSec = layer ? flicksToSeconds(layer.timing.outPoint) : 0;
  const count = layer ? selectedIds.filter((id) => documentMirror().hasLayer(id)).length : 0;

  return (
    <>
      {/* ── Under the pointer: colour on the left, position on the right ── */}
      <section className={styles.group} aria-label="Pointer">
        <dl className={styles.pointerGrid}>
          <Pair k="R" v={channel(rgba?.r)} />
          <Pair k="X" v={present ? String(x) : '—'} />
          <Pair k="G" v={channel(rgba?.g)} />
          <Pair k="Y" v={present ? String(y) : '—'} />
          <Pair k="B" v={channel(rgba?.b)} />
          <div className={styles.pair}>
            <dt className={styles.srOnly}>Colour</dt>
            <dd className={styles.swatchValue}>
              {rgba ? <span className={styles.swatch} style={{ background: swatch }} /> : null}
            </dd>
          </div>
          <Pair k="A" v={channel(rgba?.a)} />
        </dl>
      </section>

      {/* ── The selected layer ── */}
      {layer && (
        <section className={styles.group} aria-label="Selected layer">
          {count > 1 ? (
            <div className={styles.subject}>{`${count} layers`}</div>
          ) : (
            <>
              <div className={styles.subject} title={layer.name}>{layer.name}</div>
              <dl className={styles.rows}>
                <Pair k="In" v={framesToTimecode(inSec, fps, startFrame)} />
                <Pair k="Out" v={framesToTimecode(outSec, fps, startFrame)} />
                <Pair k="Duration" v={framesToTimecode(Math.max(0, outSec - inSec), fps)} />
              </dl>
            </>
          )}
        </section>
      )}
    </>
  );
}
