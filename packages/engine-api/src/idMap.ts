/**
 * IdMap — carry a recorded request stream from one engine to another.
 *
 * Ids are opaque and engine-minted (ENGINE_API.md §3.1): the TypeScript engine
 * says `layer_3`, `comp_1`, `k12`; the C++ engine says `L3`, `C1`, `K2`; both
 * are deterministic from a fresh document, but they are not the same strings.
 * Replaying one engine's log against the other (the C3 parity check, and a
 * fallback that moves work between backends) therefore needs a translation
 * built from the two engines' RESULTS for the same request:
 *
 *   learn(srcResult, dstResult)   zip-walks both values; wherever the source
 *                                 has a string and the target a different
 *                                 string at the same place, that is an id
 *                                 pair. `gesture` numbers are paired too.
 *   translate(request)            deep copy with every known source id (and
 *                                 gesture number) replaced.
 *   unmapped(value)               source ids the value still references that
 *                                 have no counterpart — the request depends on
 *                                 something the target never created.
 *
 * Property paths may embed group ids (`effects/fx_1/radius`): a path segment
 * that is a known id is translated segment by segment.
 */

/** Result fields that hold ids (LayerRef.layer, ItemRef.item, KeyframeIds.ids, SetPropertyResult.key, …). */
const ID_KEYS = new Set(['layer', 'layers', 'item', 'items', 'ids', 'id', 'key', 'keys', 'comp', 'groups', 'group']);

export class IdMap {
  private readonly ids = new Map<string, string>();
  private readonly gestures = new Map<number, number>();
  /** Every id the SOURCE engine has shown (results, seeded documents). */
  private readonly sourceIds = new Set<string>();

  get size(): number {
    return this.ids.size;
  }

  /** Record a pair directly (e.g. comps seeded into both engines). */
  pair(src: string, dst: string): void {
    this.sourceIds.add(src);
    this.ids.set(src, dst);
  }

  /** Note ids the source engine owns (so `unmapped` can see them). */
  noteIds(ids: Iterable<string>): void {
    for (const id of ids) this.sourceIds.add(id);
  }

  /** Note the ids in a source RESULT (only id-carrying fields, as `learn` reads them). */
  noteSource(value: unknown, key = ''): void {
    if (typeof value === 'string') {
      if (!ID_KEYS.has(key)) return;
      this.sourceIds.add(value);
      // A group path ('effects/fx_2'): its own id is the last segment.
      if (value.includes('/')) this.sourceIds.add(value.slice(value.lastIndexOf('/') + 1));
      return;
    }
    if (Array.isArray(value)) {
      for (const v of value) this.noteSource(v, key);
      return;
    }
    if (value && typeof value === 'object' && !(value instanceof Uint8Array)) {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) this.noteSource(v, k);
    }
  }

  get(src: string): string | undefined {
    return this.ids.get(src);
  }

  /** The source id a target id was learned from (reverse lookup). */
  sourceOf(dst: string): string | undefined {
    for (const [s, d] of this.ids) if (d === dst) return s;
    return undefined;
  }

  /** Zip-walk two results of the same request: differing strings are id pairs. */
  learn(src: unknown, dst: unknown, key = ''): void {
    if (typeof src === 'string' && typeof dst === 'string') {
      // Only fields that carry ids (a history label is a string too, and the
      // engines word them differently).
      if (!ID_KEYS.has(key)) return;
      this.sourceIds.add(src);
      if (src !== dst || !this.ids.has(src)) this.ids.set(src, dst);
      return;
    }
    if (typeof src === 'number' && typeof dst === 'number') {
      if (key === 'gesture') this.gestures.set(src, dst);
      return;
    }
    if (Array.isArray(src) && Array.isArray(dst)) {
      const n = Math.min(src.length, dst.length);
      for (let i = 0; i < n; i++) this.learn(src[i], dst[i], key);
      return;
    }
    if (src && dst && typeof src === 'object' && typeof dst === 'object') {
      for (const k of Object.keys(src as object)) {
        if (k in (dst as object)) this.learn((src as Record<string, unknown>)[k], (dst as Record<string, unknown>)[k], k);
      }
    }
  }

  /** A deep copy of `value` with every known id and gesture number translated. */
  translate<T>(value: T, key = ''): T {
    if (typeof value === 'string') return this.translateString(value) as unknown as T;
    if (typeof value === 'number') {
      if (key === 'gesture' && this.gestures.has(value)) return this.gestures.get(value) as unknown as T;
      return value;
    }
    if (value instanceof Uint8Array) return value.slice() as unknown as T;
    if (Array.isArray(value)) return value.map((v) => this.translate(v, key)) as unknown as T;
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = this.translate(v, k);
      return out as T;
    }
    return value;
  }

  /** Source ids `value` references that have no mapping (its target would be missing). */
  unmapped(value: unknown): string[] {
    const out = new Set<string>();
    walkStrings(value, (s) => {
      if (this.sourceIds.has(s) && !this.ids.has(s)) {
        out.add(s);
        return;
      }
      for (const part of s.includes('/') ? s.split('/') : []) {
        if (this.sourceIds.has(part) && !this.ids.has(part)) out.add(part);
      }
    });
    return [...out];
  }

  private translateString(s: string): string {
    const direct = this.ids.get(s);
    if (direct !== undefined) return direct;
    if (!s.includes('/')) return s;
    let changed = false;
    const parts = s.split('/').map((p) => {
      const m = this.ids.get(p);
      if (m === undefined) return p;
      changed = true;
      return m;
    });
    return changed ? parts.join('/') : s;
  }
}

function walkStrings(value: unknown, fn: (s: string) => void): void {
  if (typeof value === 'string') {
    fn(value);
    return;
  }
  if (value instanceof Uint8Array) return;
  if (Array.isArray(value)) {
    for (const v of value) walkStrings(v, fn);
    return;
  }
  if (value && typeof value === 'object') for (const v of Object.values(value as Record<string, unknown>)) walkStrings(v, fn);
}
