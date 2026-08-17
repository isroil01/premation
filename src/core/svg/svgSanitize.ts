/**
 * SVG sanitization + id scoping.
 *
 * Imported markup is untrusted input. It ends up in a DOM (the rasterizer's
 * `<img>`, and any future inline renderer), so sanitizing is mandatory rather
 * than defensive — and because it can REMOVE content, it is also a fidelity
 * change the UI has to disclose (see `svgCapabilityWarnings`).
 *
 * Two jobs, both required before an SVG is safe to render:
 *
 *  1. **Sanitize.** DOMPurify with the SVG profile, plus our own pass for the
 *     things a general-purpose sanitizer has no opinion on: remote `href`s and
 *     remote `url(...)` references, which would make a frame's pixels depend on
 *     a network fetch we neither control nor cache.
 *
 *  2. **Scope ids.** Every `id` is rewritten to a layer-unique name, along with
 *     every `url(#…)`, `href="#…"` and `#id` selector that points at it. Two
 *     copies of the same logo in one document otherwise share one id namespace,
 *     and the second copy silently picks up the first one's gradient / filter /
 *     clip-path. This is the single most common "why is the duplicate wrong"
 *     bug in inline-SVG systems, and it costs one pass to make impossible.
 *
 * `sourceMarkup` is always kept verbatim alongside the sanitized result, so a
 * change to this policy is re-appliable and revert is lossless (§13).
 */

import DOMPurify from 'dompurify';
import { scanSvgCapabilities, type SvgCapabilities } from './svgCapabilities';

/** Attributes that can carry a URL reference. */
const HREF_ATTRS = ['href', 'xlink:href', 'src'];

/** Presentation attributes whose value can be `url(#id)`. */
const URL_REF_ATTRS = [
  'fill', 'stroke', 'filter', 'mask', 'clip-path', 'marker-start', 'marker-mid',
  'marker-end', 'style', 'fill-opacity', 'stroke-opacity',
];

function isRemoteRef(value: string): boolean {
  const v = value.trim();
  return /^(https?:)?\/\//i.test(v) || /^ftp:/i.test(v);
}

/**
 * Strip references our renderer must not follow.
 *
 * DOMPurify keeps remote `href`s (they're not XSS), but a remote reference is a
 * determinism problem for us: the same project would render differently
 * depending on the network. Blocking is the honest behaviour — the capability
 * scan already flagged it, so the user is told rather than left guessing.
 */
function stripRemoteRefs(root: Element): void {
  for (const el of elementsOf(root)) {
    for (const attrName of HREF_ATTRS) {
      const v = el.getAttribute(attrName);
      if (v && isRemoteRef(v)) el.removeAttribute(attrName);
    }
    for (const attr of Array.from(el.attributes)) {
      if (attr.name === 'd' || attr.name === 'points') continue;
      if (/url\(\s*['"]?(https?:)?\/\//i.test(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
  }
}

/**
 * SMIL nodes DOMPurify refuses and why we re-admit them selectively.
 *
 * DOMPurify's svg profile allows `animateTransform`/`animateMotion` but drops
 * plain `<animate>` and `<set>` — because `<animate attributeName="href">` can
 * retarget a link or `<use>` at runtime, which is a real vector. But those two
 * tags are also how every Keyshape/SVGator export animates FILL, OPACITY and
 * VISIBILITY: stripping them wholesale turned a dark-mode toggle into a
 * permanently-light picture with only its transforms still moving.
 *
 * So the tags are ADD_TAGS'd back in, and THIS pass removes only the actually
 * dangerous instances: any SMIL element whose `attributeName` retargets a
 * reference/identity attribute rather than a presentation value.
 */
const UNSAFE_SMIL_TARGETS = new Set(['href', 'xlink:href', 'src', 'id', 'class', 'style']);

function stripUnsafeAnimations(root: Element): void {
  for (const el of root.querySelectorAll('animate, set, animateTransform, animateMotion')) {
    const tag = el.localName.toLowerCase();
    const target = (el.getAttribute('attributeName') ?? '').trim().toLowerCase();
    if (UNSAFE_SMIL_TARGETS.has(target) || target.startsWith('on')) {
      el.remove();
      continue;
    }
    // DOMPurify may have already stripped a hostile attributeName, leaving an
    // inert shell — drop it too rather than serialize dead nodes. (Transform/
    // motion animations legitimately need no attributeName.)
    if (!target && (tag === 'animate' || tag === 'set')) el.remove();
  }
}

/**
 * Root + every descendant, as a STATIC array.
 *
 * `getElementsByTagName` hands back a live HTMLCollection whose indexed access
 * re-walks the tree, which turns any full-document pass into O(n²) — a 1MB
 * illustration took tens of seconds before this. `querySelectorAll` is static,
 * and materializing once also makes it safe to mutate while iterating.
 */
function elementsOf(root: Element): Element[] {
  return [root, ...Array.from(root.querySelectorAll('*'))];
}

/** Every id defined anywhere in the tree. */
function collectIds(root: Element): Set<string> {
  const ids = new Set<string>();
  for (const el of elementsOf(root)) {
    const id = el.getAttribute('id');
    if (id) ids.add(id);
  }
  return ids;
}

/** Escape a string for literal use inside a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rewrite every id in the tree to `<scope>__<id>`, and every reference to it.
 *
 * References live in three shapes and all three must move together, or the
 * scoping itself becomes the bug it was meant to prevent:
 *   • `url(#id)` inside any attribute or `<style>` rule
 *   • `href="#id"` / `xlink:href="#id"` (`<use>`, `<textPath>`, `<mpath>`)
 *   • `#id` selectors and `@keyframes` names inside `<style>`
 *
 * Longest-id-first ordering matters: rewriting `a` before `ab` would corrupt
 * `#ab` into `#scope__ab`'s prefix. Sorting by descending length removes that
 * class of collision entirely.
 */
export function scopeSvgIds(root: Element, scope: string): void {
  const ids = [...collectIds(root)].sort((a, b) => b.length - a.length);
  if (ids.length === 0) return;
  const rename = (id: string): string => `${scope}__${id}`;

  const rewriteText = (text: string): string => {
    let out = text;
    for (const id of ids) {
      const e = escapeRe(id);
      // url(#id) / url('#id') / url("#id")
      out = out.replace(new RegExp(`url\\(\\s*(['"]?)#${e}\\1\\s*\\)`, 'g'), `url($1#${rename(id)}$1)`);
      // #id as a CSS selector — only when not followed by an identifier char,
      // so `#a` cannot match inside `#ab`.
      out = out.replace(new RegExp(`#${e}(?![\\w-])`, 'g'), `#${rename(id)}`);
    }
    return out;
  };

  for (const el of elementsOf(root)) {
    // <style> bodies carry both selectors and url references.
    if (el.localName === 'style') {
      el.textContent = rewriteText(el.textContent ?? '');
      continue;
    }
    const ownId = el.getAttribute('id');
    if (ownId) el.setAttribute('id', rename(ownId));

    for (const attrName of HREF_ATTRS) {
      const v = el.getAttribute(attrName);
      if (v && v.startsWith('#')) {
        const target = v.slice(1);
        if (ids.includes(target)) el.setAttribute(attrName, `#${rename(target)}`);
      }
    }
    for (const attrName of URL_REF_ATTRS) {
      const v = el.getAttribute(attrName);
      if (v && v.includes('url(')) el.setAttribute(attrName, rewriteText(v));
    }
    // `begin="other.end"` and similar SMIL sync-bases reference element ids by
    // bare name, not `#id` — rewrite those too or the timing chain breaks.
    for (const attrName of ['begin', 'end']) {
      const v = el.getAttribute(attrName);
      if (!v) continue;
      let next = v;
      for (const id of ids) {
        next = next.replace(new RegExp(`(^|[\\s;+])${escapeRe(id)}\\.`, 'g'), `$1${rename(id)}.`);
      }
      if (next !== v) el.setAttribute(attrName, next);
    }
  }
}

/** Intrinsic size + viewBox, resolved the way a browser would. */
export interface SvgIntrinsicSize {
  width: number;
  height: number;
  viewBox: [number, number, number, number] | null;
}

function parseLen(v: string | null): number {
  if (!v) return 0;
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * The size an SVG wants to be.
 *
 * `width`/`height` win; a viewBox supplies whichever is missing (or both);
 * a file with neither falls back to 512² rather than the browser's 300×150
 * default, which is an arbitrary number that just happens to letterbox badly.
 */
export function readSvgIntrinsicSize(root: Element): SvgIntrinsicSize {
  let width = parseLen(root.getAttribute('width'));
  let height = parseLen(root.getAttribute('height'));
  const raw = (root.getAttribute('viewBox') || '').split(/[\s,]+/).filter(Boolean).map(Number);
  const viewBox: [number, number, number, number] | null =
    raw.length === 4 && raw.every((n) => Number.isFinite(n)) && raw[2]! > 0 && raw[3]! > 0
      ? [raw[0]!, raw[1]!, raw[2]!, raw[3]!]
      : null;

  if ((!width || !height) && viewBox) {
    const [, , vbW, vbH] = viewBox;
    if (width && !height) height = (width * vbH) / vbW;
    else if (height && !width) width = (height * vbW) / vbH;
    else { width = vbW; height = vbH; }
  }
  if (!width || !height) { width = 512; height = 512; }
  return { width, height, viewBox };
}

/**
 * Version of the sanitize POLICY, stamped onto stored layers.
 *
 * The sanitized markup is baked into the document at import time, so a policy
 * fix (v2: stop dropping `<animate>`/`<set>` — the dark-mode-button bug) would
 * otherwise never reach layers imported before it. `readSvgLayer` re-sanitizes
 * from `sourceMarkup` when a stored layer's stamp is older than this.
 */
export const SVG_SANITIZE_POLICY_VERSION = 2;

export interface SanitizedSvg {
  /** Safe, id-scoped markup — what actually renders. */
  markup: string;
  width: number;
  height: number;
  viewBox: [number, number, number, number] | null;
  /** True when sanitizing removed CONTENT (drives the disclosure warning). */
  changed: boolean;
}

/**
 * Did sanitizing actually cost the user anything?
 *
 * Compared on CONTENT, not on text: DOMPurify reformats whitespace, quotes and
 * unused namespace declarations on every file it touches, so a string compare
 * reports "changed" for markup it left completely intact — and a warning that
 * fires on every import is a warning nobody reads.
 */
function didRemoveContent(a: SvgCapabilities, after: Document): boolean {
  const b = scanSvgCapabilities(after);
  return (
    (a.hasScript && !b.hasScript) ||
    (a.hasForeignObject && !b.hasForeignObject) ||
    (a.hasExternalRefs && !b.hasExternalRefs) ||
    b.pathCount < a.pathCount
  );
}

/**
 * Sanitize + scope one SVG for use as a layer.
 *
 * `scope` should be stable for the life of the layer (its node id): the ids are
 * baked into the stored markup, so a scope that changed between renders would
 * invalidate the texture cache every frame.
 */
export function sanitizeSvg(
  sourceMarkup: string,
  scope: string,
  sourceCapabilities?: SvgCapabilities,
): SanitizedSvg | null {
  // SCOPE FIRST, THEN SANITIZE. Order matters and is load-bearing:
  //
  // DOMPurify strips `id` values that could clobber a DOM property — `id="target"`
  // is removed outright, which silently breaks every `url(#target)` and `#target`
  // CSS rule pointing at it. Scoping first turns it into `id="<layer>__target"`,
  // which clobbers nothing and survives untouched. Disabling `SANITIZE_DOM` would
  // also "fix" it, by giving up a real protection; renaming fixes the actual
  // cause. Verified empirically both ways.
  const staged = new DOMParser().parseFromString(sourceMarkup, 'image/svg+xml');
  const stagedRoot = staged.documentElement;
  if (!stagedRoot || stagedRoot.localName !== 'svg' || staged.getElementsByTagName('parsererror').length > 0) {
    return null;
  }
  scopeSvgIds(stagedRoot, scope);

  const clean = DOMPurify.sanitize(new XMLSerializer().serializeToString(stagedRoot), {
    USE_PROFILES: { svg: true, svgFilters: true },
    // `use` is NOT in DOMPurify's SVG profile, so `<use href="#icon">` — the
    // single most common way an icon set is authored — was dropped entirely.
    // `style` carries @keyframes and class rules; dropping it silently restyles
    // the file. Both are safe here: DOMPurify still scrubs their contents, and
    // cross-file `<use href="external.svg#id">` is removed by stripRemoteRefs.
    //
    // `animate`/`set` are DOMPurify-forbidden because they can retarget href —
    // re-admitted here and policed by stripUnsafeAnimations, which removes only
    // the instances aimed at reference/identity attributes. Without these two
    // tags every Keyshape/SVGator export loses its fill/opacity/visibility
    // animation and plays as transforms-only.
    ADD_TAGS: ['use', 'style', 'animate', 'set'],
    FORBID_TAGS: ['script', 'foreignObject'],
    FORBID_ATTR: ['onload', 'onerror', 'onclick', 'onmouseover', 'onbegin', 'onend', 'onrepeat'],
  });

  const doc = new DOMParser().parseFromString(clean, 'image/svg+xml');
  const root = doc.documentElement;
  if (!root || root.localName !== 'svg' || doc.getElementsByTagName('parsererror').length > 0) {
    return null;
  }

  stripRemoteRefs(root);
  stripUnsafeAnimations(root);

  // Measured after every REMOVAL pass but before the viewBox backfill, which is
  // a rewrite and must not read as content loss. The importer has already
  // scanned the source to decide the route; reusing that saves a full re-parse
  // of a file that can be megabytes.
  const changed = didRemoveContent(
    sourceCapabilities ?? scanSvgCapabilities(new DOMParser().parseFromString(sourceMarkup, 'image/svg+xml')),
    doc,
  );

  const { width, height, viewBox } = readSvgIntrinsicSize(root);
  // Guarantee a viewBox so the raster step can scale the file to any size
  // without the browser falling back to its 300×150 default box.
  if (!viewBox) root.setAttribute('viewBox', `0 0 ${width} ${height}`);

  return {
    markup: new XMLSerializer().serializeToString(root),
    width,
    height,
    viewBox,
    changed,
  };
}

/**
 * A `data:` URL the texture pipeline can rasterize.
 *
 * Base64 rather than percent-encoding: SVG markup is full of `<`, `#` and `"`,
 * which percent-encoding inflates badly, and `btoa` needs the UTF-8 round-trip
 * to survive non-ASCII text content.
 */
export function svgToDataUrl(markup: string): string {
  const utf8 = new TextEncoder().encode(markup);
  let binary = '';
  for (let i = 0; i < utf8.length; i += 1) binary += String.fromCharCode(utf8[i]!);
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}
