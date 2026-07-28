/**
 * SVG capability scan — what an imported file contains, computed ONCE at import.
 *
 * This is deliberately a cheap scan, not a parse. The whole point of the hybrid
 * import architecture is that importing an SVG never runs the geometry parser,
 * so the thing that decides how to import it must not either: this walks the
 * DOM once looking for feature markers and never touches path data.
 *
 * The resulting record drives every UI affordance and every warning. It is the
 * difference between "we support SVG" and "we silently misrender a quarter of
 * files" — an SVG whose text will reflow on another machine, or whose `<script>`
 * we stripped, has to SAY so, because the user cannot tell by looking.
 */

/** What an SVG contains. Every field is a reason to warn, gate, or route. */
export interface SvgCapabilities {
  /** `<animate>`, `<animateTransform>`, `<animateMotion>`, `<set>`. */
  hasSMIL: boolean;
  /** `@keyframes` / `animation:` / `transition:` in a `<style>` block or inline. */
  hasCSSAnimation: boolean;
  /** `begin="click"` and friends — animation state depends on interaction
   *  history, so scrubbing is not reproducible. */
  hasEventTiming: boolean;
  /** `<script>` or an `on*` handler — arbitrary state mutation. Stripped. */
  hasScript: boolean;
  /** `<foreignObject>` — arbitrary HTML, possibly scripted. Stripped. */
  hasForeignObject: boolean;
  /** A reference to a remote origin (http/https/protocol-relative). Blocked. */
  hasExternalRefs: boolean;
  /** `<text>` / `<tspan>` — resolves against host fonts, so it can render
   *  differently on another machine (§8: warn and proceed). */
  hasText: boolean;
  /** An embedded `<image>` — not vector, so it cannot become editable shapes. */
  hasRasterImage: boolean;
  /** Number of drawable elements. Drives the "this will produce N layers"
   *  warning on the convert path. */
  pathCount: number;
  /** Longest animation end time in seconds, when computable from static
   *  `begin`/`dur`/`repeatCount` alone. Null when it can't be determined
   *  (indefinite repeat, event timing, CSS-only animation). */
  intrinsicDuration: number | null;
}

/** Elements that draw something — what "how many layers would this become". */
const DRAWABLE = ['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text'];

const SMIL_TAGS = ['animate', 'animateTransform', 'animateMotion', 'set'];

/** Attributes that can carry a URL reference. */
const HREF_ATTRS = ['href', 'xlink:href', 'src'];

/** A remote reference — anything that would make rendering depend on network
 *  fetches we neither control nor cache. `#local`, `data:` and relative refs
 *  to nothing are fine; `http(s):` and `//host` are not. */
function isRemoteRef(value: string): boolean {
  const v = value.trim();
  return /^(https?:)?\/\//i.test(v) || /^ftp:/i.test(v);
}

/** Parse an SMIL clock value ("2s", "500ms", "1.5", "00:03") to seconds. */
export function parseClockValue(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const v = raw.trim();
  if (!v || v === 'indefinite') return null;
  // Full clock: [hh:]mm:ss[.frac]
  if (v.includes(':')) {
    const parts = v.split(':').map((p) => Number(p));
    if (parts.some((n) => !Number.isFinite(n))) return null;
    return parts.reduce((acc, n) => acc * 60 + n, 0);
  }
  const m = /^([0-9.]+)\s*(ms|s|min|h)?$/i.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  switch ((m[2] ?? 's').toLowerCase()) {
    case 'ms': return n / 1000;
    case 'min': return n * 60;
    case 'h': return n * 3600;
    default: return n;
  }
}

/**
 * When this SMIL element stops animating, in seconds — or null when that is not
 * statically knowable (indefinite repeat, event-driven begin, missing dur).
 *
 * Null is contagious on purpose: one indefinite animation makes the whole file's
 * intrinsic duration unknown, and the UI has to say "unknown" rather than invent
 * a number that would silently truncate a loop.
 */
function smilEndTime(el: Element): number | null {
  const begin = el.getAttribute('begin');
  // Event timing ("click", "other.end") has no static start.
  if (begin && !/^[0-9.:\s+-]*(ms|s|min|h)?$/i.test(begin.trim())) return null;
  const start = parseClockValue(begin) ?? 0;
  const dur = parseClockValue(el.getAttribute('dur'));
  if (dur === null) return null;

  const repeat = el.getAttribute('repeatCount');
  const repeatDur = parseClockValue(el.getAttribute('repeatDur'));
  if (repeat === 'indefinite' || el.getAttribute('repeatDur') === 'indefinite') return null;
  if (repeatDur !== null) return start + repeatDur;
  const count = repeat ? Number(repeat) : 1;
  if (!Number.isFinite(count) || count <= 0) return null;
  return start + dur * count;
}

/** True when a `begin`/`end` attribute is event-driven rather than a clock. */
function isEventTiming(value: string | null): boolean {
  if (!value) return false;
  // A clock value is digits/colons/sign plus an optional unit. Anything else
  // ("click", "btn.click+1s", "repeat(2)") is a sync- or event-base.
  return !/^[0-9.:\s+-]*(ms|s|min|h)?$/i.test(value.trim());
}

/**
 * Scan a parsed SVG document for the features that drive import decisions.
 *
 * Takes a Document rather than a string so a caller that already parsed (the
 * importer parses once for capabilities AND sanitization) doesn't pay twice.
 */
export function scanSvgCapabilities(doc: Document): SvgCapabilities {
  const caps: SvgCapabilities = {
    hasSMIL: false,
    hasCSSAnimation: false,
    hasEventTiming: false,
    hasScript: false,
    hasForeignObject: false,
    hasExternalRefs: false,
    hasText: false,
    hasRasterImage: false,
    pathCount: 0,
    intrinsicDuration: null,
  };

  const root = doc.documentElement;
  if (!root || doc.getElementsByTagName('parsererror').length > 0) return caps;

  let maxEnd = 0;
  /** False once ANY animation's end time is unknowable — see smilEndTime. */
  let durationKnown = true;
  let sawTimedAnimation = false;

  // `querySelectorAll` returns a STATIC list; `getElementsByTagName` returns a
  // live HTMLCollection whose indexed access re-walks the tree, which made this
  // scan O(n²) — a 1MB, 11k-element file took 33 SECONDS to scan. The root is
  // included so an `onload` or animated `style` on `<svg>` itself is not missed.
  const all: Element[] = [root, ...Array.from(root.querySelectorAll('*'))];
  for (const el of all) {
    // localName is namespace-stripped and case-correct for XML parsing, which
    // tagName is not for the mixed-case SMIL tags (animateTransform).
    const tag = el.localName;

    if (DRAWABLE.includes(tag)) caps.pathCount += 1;
    if (tag === 'text' || tag === 'tspan' || tag === 'textPath') caps.hasText = true;
    if (tag === 'image') caps.hasRasterImage = true;
    if (tag === 'script') caps.hasScript = true;
    if (tag === 'foreignObject') caps.hasForeignObject = true;

    if (SMIL_TAGS.includes(tag)) {
      caps.hasSMIL = true;
      if (isEventTiming(el.getAttribute('begin')) || isEventTiming(el.getAttribute('end'))) {
        caps.hasEventTiming = true;
      }
      const end = smilEndTime(el);
      if (end === null) durationKnown = false;
      else {
        sawTimedAnimation = true;
        maxEnd = Math.max(maxEnd, end);
      }
    }

    // Inline styles and `<style>` text both carry CSS animation.
    if (tag === 'style') {
      const css = el.textContent ?? '';
      if (/@(-\w+-)?keyframes|animation(-name)?\s*:|transition\s*:/i.test(css)) {
        caps.hasCSSAnimation = true;
      }
    }

    for (const attr of Array.from(el.attributes)) {
      const name = attr.name;
      const value = attr.value;
      // `d` and `points` are long, never carry a URL, and are the bulk of a
      // vector file's bytes — skipping them keeps the per-attribute regexes off
      // the hot path entirely.
      if (name === 'd' || name === 'points') continue;
      // Event handlers are script by another name.
      if (/^on/i.test(name)) caps.hasScript = true;
      if (name === 'style' && /animation(-name)?\s*:|transition\s*:/i.test(value)) {
        caps.hasCSSAnimation = true;
      }
      if (HREF_ATTRS.includes(name)) {
        if (/^javascript:/i.test(value.trim())) caps.hasScript = true;
        if (isRemoteRef(value)) caps.hasExternalRefs = true;
      }
      // url(...) in any presentation attribute (fill, filter, mask, clip-path).
      const urlMatch = /url\(\s*['"]?([^'")]+)/i.exec(value);
      if (urlMatch && isRemoteRef(urlMatch[1]!)) caps.hasExternalRefs = true;
    }
  }

  caps.intrinsicDuration = durationKnown && sawTimedAnimation ? maxEnd : null;
  return caps;
}

/** Parse + scan in one step, for callers that only want the capabilities. */
export function scanSvgMarkup(markup: string): SvgCapabilities {
  const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
  return scanSvgCapabilities(doc);
}

/** True when the file animates at all — the routing question at import time. */
export function isAnimatedSvg(caps: SvgCapabilities): boolean {
  return caps.hasSMIL || caps.hasCSSAnimation;
}

/**
 * The warnings a capability record implies, in the user's words.
 *
 * One place, so the Inspector badges, the import toast and the convert
 * confirmation dialog cannot drift apart in what they claim was lost.
 */
export function svgCapabilityWarnings(caps: SvgCapabilities): string[] {
  const out: string[] = [];
  if (caps.hasScript) out.push('Contains script, which was removed for security.');
  if (caps.hasForeignObject) out.push('Contains foreignObject content, which was removed.');
  if (caps.hasExternalRefs) out.push('References remote files, which were blocked — those parts may be missing.');
  if (caps.hasText) out.push('Contains text — it may render differently on another machine.');
  if (caps.hasEventTiming) out.push('Contains interaction-triggered animation, which cannot be played on a timeline.');
  return out;
}
