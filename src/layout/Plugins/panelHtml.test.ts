/**
 * A panel's markup, prepared the way an author actually writes it.
 *
 * ── Two rules that were bugs wearing documentation ──────────────────────────
 *
 * `PLUGINS.md` told authors: "open the panel with a real element, not a
 * `<style>`", and said nothing at all about linked stylesheets. Both were
 * defects:
 *
 *   • The shell transplanted `doc.body.innerHTML` alone, and the HTML parser
 *     hoists `<style>`, `<link>` and `<meta>` into `<head>` when they come
 *     before any body content — which is exactly where an author puts a
 *     stylesheet. The panel rendered completely unstyled with nothing saying
 *     why.
 *   • A relative `href` resolved against the APP's origin, where the plugin's
 *     file does not exist, and the frame has `connect-src 'none'` so it could
 *     not have fetched one anyway.
 *
 * A rule an author has to remember, whose violation is invisible, is a rule
 * everyone breaks eventually. This module removes the second; the shell's
 * `render()` removes the first.
 */

import { inlinePanelStyles, resolvePackagePath } from './panelHtml';

const FILES = {
  'panel.html': '<link rel="stylesheet" href="panel.css"><p>hi</p>',
  'panel.css': 'body { color: red; }',
  'ui/panel.html': '<link rel="stylesheet" href="theme.css">',
  'ui/theme.css': 'p { margin: 0; }',
  'shared/base.css': 'html { font-size: 12px; }',
};

describe('resolving a package path', () => {
  it('resolves a sibling', () => {
    expect(resolvePackagePath('panel.html', 'panel.css')).toBe('panel.css');
  });

  it('resolves relative to the entry s DIRECTORY, not the package root', () => {
    // The rule a browser applies, done by hand because there is no base URL to
    // apply it against.
    expect(resolvePackagePath('ui/panel.html', 'theme.css')).toBe('ui/theme.css');
    expect(resolvePackagePath('ui/panel.html', './theme.css')).toBe('ui/theme.css');
  });

  it('walks up with ..', () => {
    expect(resolvePackagePath('ui/panel.html', '../shared/base.css')).toBe('shared/base.css');
  });

  it('REFUSES a path that escapes the package', () => {
    /*
      Refused, not clamped. Clamping `../../x` to `x` would silently resolve a
      DIFFERENT file than the author wrote — and a panel reaching above its own
      package is either confused or trying something, neither of which earns a
      file.
    */
    expect(resolvePackagePath('panel.html', '../secrets.css')).toBeNull();
    expect(resolvePackagePath('ui/panel.html', '../../../etc/passwd')).toBeNull();
  });

  it('declines anything that is not a package-relative path', () => {
    // Absolute, protocol-relative and root-relative hrefs are not package
    // files. Left for the frame's CSP to refuse, which it does.
    for (const href of ['https://cdn.example/x.css', '//cdn.example/x.css', '/x.css', 'data:text/css,x']) {
      expect(resolvePackagePath('panel.html', href)).toBeNull();
    }
  });
});

describe('inlining a linked stylesheet', () => {
  it('replaces the link with the file s contents', () => {
    const out = inlinePanelStyles(FILES['panel.html'], FILES, 'panel.html');
    expect(out).toContain('<style>body { color: red; }</style>');
    expect(out).not.toContain('<link');
    // Everything else is untouched.
    expect(out).toContain('<p>hi</p>');
  });

  it('resolves against the entry s directory', () => {
    const out = inlinePanelStyles(FILES['ui/panel.html'], FILES, 'ui/panel.html');
    expect(out).toContain('p { margin: 0; }');
  });

  it('accepts single quotes and no quotes', () => {
    for (const tag of ['<link rel=stylesheet href=panel.css>', "<link rel='stylesheet' href='panel.css'>"]) {
      expect(inlinePanelStyles(tag, FILES, 'panel.html')).toContain('color: red');
    }
  });

  it('leaves a link it cannot resolve exactly as written', () => {
    /*
      Left, not deleted. It will fail to load — the frame's CSP sees to that —
      but an author inspecting their own panel finds what they wrote rather than
      wondering where it went.
    */
    const tag = '<link rel="stylesheet" href="does-not-exist.css">';
    expect(inlinePanelStyles(tag, FILES, 'panel.html')).toBe(tag);

    const remote = '<link rel="stylesheet" href="https://cdn.example/x.css">';
    expect(inlinePanelStyles(remote, FILES, 'panel.html')).toBe(remote);
  });

  it('ignores a link that is not a stylesheet', () => {
    const icon = '<link rel="icon" href="panel.css">';
    expect(inlinePanelStyles(icon, FILES, 'panel.html')).toBe(icon);
  });

  it('cannot be used to break out of the style element', () => {
    /*
      The one hostile shape here. A CSS file containing `</style>` would
      otherwise close the element early and put whatever followed into the
      panel's markup as live HTML — inside a sandboxed frame with an opaque
      origin, so not a session risk, but still markup the author did not write
      appearing where they did not put it.
    */
    const files = { 'panel.css': 'a{}</style><img src=x onerror=alert(1)>' };
    const out = inlinePanelStyles('<link rel="stylesheet" href="panel.css">', files, 'panel.html');
    expect(out).not.toContain('</style><img');
    expect(out).toContain('<\\/style>');
    // Exactly one closing tag: the one this module wrote.
    expect(out.match(/<\/style>/g)).toHaveLength(1);
  });

  it('inlines several links in one document', () => {
    const html = '<link rel="stylesheet" href="../shared/base.css"><link rel="stylesheet" href="theme.css">';
    const out = inlinePanelStyles(html, FILES, 'ui/panel.html');
    expect(out).toContain('font-size: 12px');
    expect(out).toContain('margin: 0');
  });

  it('leaves markup with no links completely untouched', () => {
    // The overwhelmingly common panel. This module must be a no-op for it,
    // byte for byte — a rewrite that "tidies" the author's markup would show
    // up as mysterious diffs in their devtools inspector.
    const html = '<style>p{color:blue}</style><div id="root"></div><script>init()</script>';
    expect(inlinePanelStyles(html, FILES, 'panel.html')).toBe(html);
  });
});
