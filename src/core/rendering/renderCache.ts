/**
 * Render cache (spec §Performance — the cache bar under the timeline ruler).
 *
 * As frames are rendered (during playback or scrubbing) their time buckets are
 * marked cached; the timeline reads the merged ranges to paint the green cache
 * bar. Any animation change invalidates the whole cache — the cached frames are
 * no longer valid. This mirrors After Effects' RAM-preview cache behavior.
 */

const BUCKET = 1 / 30; // ~one frame at 30fps

class RenderCache {
  private buckets = new Set<number>();
  private rev = 0;

  /** Mark the frame at time `t` as rendered/cached. */
  mark(t: number): void {
    if (t < 0 || !Number.isFinite(t)) return;
    const b = Math.round(t / BUCKET);
    if (this.buckets.has(b)) return;
    this.buckets.add(b);
    this.rev++;
  }

  /** Clear the cache (called when the animation changes). */
  invalidate(): void {
    if (this.buckets.size === 0) return;
    this.buckets.clear();
    this.rev++;
  }

  /** Monotonic revision — lets the timeline recompute when the cache changes. */
  revision(): number {
    return this.rev;
  }

  /** Merge cached buckets into contiguous [start, end] second-ranges. */
  ranges(): { start: number; end: number }[] {
    if (this.buckets.size === 0) return [];
    const sorted = [...this.buckets].sort((a, b) => a - b);
    const out: { start: number; end: number }[] = [];
    let runStart = sorted[0]!;
    let prev = sorted[0]!;
    for (let i = 1; i < sorted.length; i++) {
      const b = sorted[i]!;
      if (b === prev + 1) { prev = b; continue; }
      out.push({ start: runStart * BUCKET, end: (prev + 1) * BUCKET });
      runStart = b;
      prev = b;
    }
    out.push({ start: runStart * BUCKET, end: (prev + 1) * BUCKET });
    return out;
  }
}

export const renderCache = new RenderCache();
export default renderCache;
