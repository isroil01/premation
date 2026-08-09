/**
 * Preparing a plugin's panel markup before it reaches the frame.
 *
 * ── The rule this removes ────────────────────────────────────────────────────
 *
 * `PLUGINS.md` used to tell authors: "open the panel with a real element, not a
 * `<style>`". That was not advice, it was a bug with documentation. The shell
 * parsed the markup with `DOMParser` and then transplanted `doc.body.innerHTML`
 * alone — so anything the HTML parser hoisted into `<head>` was silently
 * dropped, and a `<style>` before the first body content is exactly what the
 * parser hoists. The panel rendered, unstyled, with nothing saying why.
 *
 * A rule an author has to remember, whose violation is invisible, is a rule
 * that will be broken by everyone eventually. The shell now transplants head
 * and body; this module handles the other half.
 *
 * ── Why linked stylesheets are inlined HERE ──────────────────────────────────
 *
 * `<link rel="stylesheet" href="panel.css">` never worked either, for a
 * different reason: the frame is loaded from the app's own
 * `plugin-panel.html`, so a relative href resolves against the APP's origin,
 * where the plugin's file does not exist. There is no URL that serves a
 * package's contents — the files live in IndexedDB, keyed by package-relative
 * path.
 *
 * So the resolution happens on this side, where the package is in hand, and the
 * link becomes an inline `<style>`. That also keeps the frame's promise intact:
 * it has `connect-src 'none'` and no network, and turning a link into a real
 * request would have been the one thing that could reach outward from it.
 *
 * An href this module cannot resolve is LEFT ALONE rather than deleted. It will
 * fail to load — the frame's CSP sees to that — but leaving it means an author
 * looking at their own markup in a devtools inspector finds what they wrote,
 * rather than wondering why it vanished.
 */

/** Package-relative path → file contents, as `pluginStore` holds them. */
export type PackageFiles = Readonly<Record<string, string>>;

/**
 * Resolve `href` against the directory holding the panel's entry file.
 *
 * The same rule a browser applies to a relative URL, done by hand because there
 * is no base URL to apply it against. `..` segments are honoured and then the
 * result is refused if it escaped the package — a panel reaching upward is
 * either confused or trying something, and neither deserves a file.
 */
export function resolvePackagePath(entryPath: string, href: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//') || href.startsWith('/')) {
    // Absolute, protocol-relative, or root-relative: not a package file, and
    // not this module's business.
    return null;
  }

  const base = entryPath.replace(/^\.\//, '').split('/').slice(0, -1);
  const out: string[] = [...base];
  for (const segment of href.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      // Refused rather than clamped. Clamping would silently turn `../../x`
      // into `x`, which resolves to a DIFFERENT file than the author wrote.
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.length > 0 ? out.join('/') : null;
}

/**
 * Replace `<link rel="stylesheet">` with the stylesheet's contents.
 *
 * A regex rather than `DOMParser`, deliberately, and this is the one place that
 * choice is defensible: parsing here and re-serialising would hand the markup
 * to a parser on THIS origin before it reaches the sandboxed frame, and the
 * whole design keeps the plugin's markup out of this document. The match is
 * narrow — a `link` tag, its attributes, no nesting to get wrong — and anything
 * it does not recognise is left exactly as the author wrote it.
 *
 * The stylesheet text is escaped where it could close the `<style>` element it
 * is being placed in. Nothing else is touched: this is a plugin's own CSS going
 * into a frame with an opaque origin and no network, so the only thing worth
 * preventing is markup ESCAPING the style element, not the CSS itself.
 */
export function inlinePanelStyles(
  html: string,
  files: PackageFiles,
  entryPath: string,
): string {
  return html.replace(/<link\b[^>]*>/gi, (tag) => {
    if (!/\brel\s*=\s*["']?stylesheet["']?/i.test(tag)) return tag;

    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const raw = href?.[1] ?? href?.[2] ?? href?.[3];
    if (!raw) return tag;

    const path = resolvePackagePath(entryPath, decodeHtml(raw.trim()));
    if (!path) return tag;

    const css = files[path];
    if (css === undefined) return tag;

    // `</style` is the only sequence that can end the element early, and it can
    // do so with any whitespace or `>` after it. Broken by escaping the slash.
    return `<style>${css.replace(/<\/(style)/gi, '<\\/$1')}</style>`;
  });
}

/** The five entities an href can plausibly carry. Not a general decoder. */
function decodeHtml(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'");
}
