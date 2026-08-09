/**
 * A publisher's README, wrapped in a document that cannot hurt anyone.
 *
 * ── Why the README is not injected into the editor's DOM ─────────────────────
 *
 * The registry renders it with a construct-only Markdown renderer: raw HTML in
 * a README is escaped to text and never parsed, so the only tags in the output
 * are ones the renderer built. That is a strong property and it is the primary
 * control. This is the second one, and it exists because the primary control is
 * code, and code has bugs.
 *
 * What a bug would cost without this is worse here than on a web page. The
 * editor's renderer process holds the user's session, their project, and a
 * bridge to the main process. Script running in it is not a defaced listing.
 * And unlike a plugin, a README needs no permission to be shown — a user
 * BROWSING the marketplace has agreed to nothing.
 *
 * So the markup is moved somewhere it has nothing to reach:
 *
 *   • **A sandboxed iframe with no `allow-same-origin`.** Opaque origin: no
 *     access to this document, its storage, or the preload bridge.
 *   • **`connect-src 'none'`.** Nothing to exfiltrate to.
 *   • **`script-src` pinned to one hash.** The only script that may run is the
 *     height reporter. Inline script that survived the renderer does not
 *     execute — the sandbox makes an escape harmless, this stops it happening.
 *   • **`img-src 'none'`.** The renderer emits no images by design (a
 *     publisher-controlled `<img src>` is a tracking pixel reporting every
 *     viewer's IP); this holds even if that changed.
 *
 * The panel frames already work this way — see `panelTheme.ts`, whose token
 * push exists for exactly the same reason and is reused here.
 */

import { readPanelTheme } from './panelTheme';

/**
 * Reports the rendered height to the host so the frame can size itself.
 *
 * Pinned by hash in the frame's CSP, so every character is part of a security
 * decision: a reformat that changes one space stops it running, and the frame
 * silently collapses to its minimum height. `readmeDocument.test.ts` recomputes
 * the hash from this string and fails if the two have drifted.
 */
export const HEIGHT_REPORTER =
  "(function(){function r(){parent.postMessage({premationReadmeHeight:"
  + "document.documentElement.scrollHeight},'*')}r();"
  + "addEventListener('load',r);addEventListener('resize',r)})()";

/**
 * SHA-256 of `HEIGHT_REPORTER`, base64.
 *
 * A constant rather than a computed value because `crypto.subtle.digest` is
 * asynchronous and this is called while rendering. The test is what keeps it
 * honest.
 */
export const HEIGHT_REPORTER_SHA256 = 'RSWa0rQoTpc7HLNTQd70c4oidYgofrALnZWDEiaRB8o=';

/** The message the reporter sends. The host validates against this shape. */
export const README_HEIGHT_MESSAGE = 'premationReadmeHeight';

/**
 * Styling, inlined.
 *
 * The frame cannot read the editor's stylesheet, so the rules travel with it,
 * and the editor's own tokens travel with them — a README in a dark editor
 * should not be black-on-white. Deliberately plain and tightly scoped: this is
 * a stranger's markup, and the job is legibility, not handing them the run of
 * the type scale.
 */
function style(theme: Record<string, string>): string {
  const vars = Object.entries(theme).map(([k, v]) => `${k}:${v};`).join('');
  return `
    :root{${vars}}
    html,body{margin:0;padding:0;background:transparent}
    body{
      color:var(--pm-muted,#a1a1a1);
      font-family:var(--pm-font,system-ui,sans-serif);
      font-size:var(--pm-font-size,13px);
      line-height:1.55;
      overflow-wrap:break-word;
    }
    body>:first-child{margin-top:0}
    body>:last-child{margin-bottom:0}
    h2,h3,h4,h5,h6,h7{
      color:var(--pm-fg,#ededed);
      margin:var(--pm-space-3,12px) 0 var(--pm-space-1,4px);
      font-size:1.05em;line-height:1.3;
    }
    p,ul,ol{margin:var(--pm-space-2,8px) 0}
    ul,ol{padding-left:1.2em}
    ul{list-style:disc}
    ol{list-style:decimal}
    li{margin:2px 0}
    a{color:var(--pm-accent,#7c7cff)}
    strong{color:var(--pm-fg,#ededed)}
    hr{border:0;border-top:1px solid var(--pm-border,#2a2a2a);margin:var(--pm-space-3,12px) 0}
    blockquote{
      margin:0;padding-left:var(--pm-space-2,8px);
      border-left:2px solid var(--pm-border,#2a2a2a);
      color:var(--pm-muted,#8a8a8a);
    }
    code{
      font-family:var(--pm-font-mono,monospace);font-size:0.92em;
      background:var(--pm-surface,#1a1a1a);padding:1px 4px;border-radius:3px;
    }
    pre{
      background:var(--pm-surface,#1a1a1a);
      border:1px solid var(--pm-border,#2a2a2a);
      border-radius:var(--pm-radius,4px);
      padding:var(--pm-space-2,8px);
      overflow-x:auto;white-space:pre-wrap;word-break:break-word;
    }
    pre code{background:none;padding:0}
  `;
}

/** Build the complete document for the frame. */
export function buildReadmeDocument(readmeHtml: string): string {
  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `script-src 'sha256-${HEIGHT_REPORTER_SHA256}'`,
    "img-src 'none'",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');

  return '<!doctype html><html><head><meta charset="utf-8">'
    + `<meta http-equiv="Content-Security-Policy" content="${csp}">`
    + `<style>${style(readPanelTheme().vars)}</style></head><body>`
    + readmeHtml
    + `<script>${HEIGHT_REPORTER}</script>`
    + '</body></html>';
}
