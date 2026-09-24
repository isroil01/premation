/**
 * The graph editor's dense curve samples, from the engine's `sampleProperty`
 * query (B4, docs/B4_MIRROR.md §2: curves are what the mirror does not carry by
 * design — keyframes come from the mirror, the dense curve between them from
 * this query).
 *
 * Asked per (property, visible window, sample count, document revision) — the
 * graph re-samples when the document or the view changes, never per played
 * frame. In process the answer is immediate (`LocalEngine.querySync`, the same
 * fast path the document mirror uses); otherwise (a request in flight, the
 * engine process) the query is sent and the LAST answer for that property is
 * shown until the new one lands (`onAnswer` asks the owner to redraw) — never
 * a blank curve.
 */

import type { PropertySamples, QueryOf } from '@motion/engine-api';
import { engine, localEngine } from '@core/engine/engineInstance';

interface Answer {
  key: string;
  seq: number;
  samples: PropertySamples;
}

export class CurveSampler {
  private readonly answers = new Map<string, Answer>();
  private readonly pending = new Set<string>();
  private seq = 0;
  private disposed = false;

  constructor(private readonly onAnswer: () => void) {}

  /**
   * Samples for `q` at document `revision` (values in API units, `dimensions`
   * numbers per time), or the property's previous answer while this one is
   * fetched; undefined when the engine cannot sample it (not numeric).
   */
  get(q: QueryOf<'sampleProperty'>, revision: number): PropertySamples | undefined {
    const prop = `${q.prop.layer}\u0000${q.prop.path}`;
    const key = `${q.range.start}|${q.range.duration}|${q.samples}|${revision}`;
    const hit = this.answers.get(prop);
    if (hit && hit.key === key) return hit.samples;
    const seq = ++this.seq;
    const sync = localEngine()?.querySync(q);
    if (sync) {
      if (!sync.ok) {
        this.answers.delete(prop);
        return undefined;
      }
      this.answers.set(prop, { key, seq, samples: sync.value });
      return sync.value;
    }
    const pk = `${prop}\u0000${key}`;
    if (!this.pending.has(pk)) {
      this.pending.add(pk);
      engine().query(q).then((r) => {
        this.pending.delete(pk);
        if (this.disposed || !r.ok) return;
        const cur = this.answers.get(prop);
        // An answer overtaken by a newer one (a later revision / window) is dropped.
        if (cur && cur.seq > seq) return;
        this.answers.set(prop, { key, seq, samples: r.value });
        this.onAnswer();
      }, () => {
        this.pending.delete(pk);
      });
    }
    return hit?.samples;
  }

  /** Forget properties no longer plotted (keeps the cache to what is on screen). */
  retain(props: ReadonlySet<string>): void {
    for (const k of [...this.answers.keys()]) if (!props.has(k)) this.answers.delete(k);
  }

  dispose(): void {
    this.disposed = true;
    this.answers.clear();
    this.pending.clear();
  }
}

/** The cache key `retain` takes for one property. */
export function samplerPropKey(layer: string, path: string): string {
  return `${layer}\u0000${path}`;
}
