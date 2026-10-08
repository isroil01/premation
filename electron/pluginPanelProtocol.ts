/**
 * `plugin-ui://<plugin id>/<file>` — a native plugin's panel (plan P5,
 * docs/PLUGIN_SDK.md "Plugin panels"): files from the bundle's `ui/` folder,
 * served to a sandboxed frame in the editor (`sandbox="allow-scripts"`, an
 * opaque origin, no Node).
 *
 * The response carries its own Content-Security-Policy, which a panel can
 * tighten but never loosen: scripts, styles, images and fonts from its own
 * bundle only, no network at all (`connect-src 'none'`), no forms, no frames.
 * Only files inside `<bundle>/ui/` are served — no `..`, no hidden files, no
 * symlink out of the folder. No plugin code runs here: main reads files.
 */

import { realpath, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

export const PANEL_SCHEME = 'plugin-ui';
const MANIFEST = 'premation-plugin.json';
const MAX_FILE_BYTES = 32 * 1024 * 1024;

/** The policy on every panel response, for the bundle `host` (the lower-cased plugin id). */
export function panelCsp(host: string): string {
  const self = `${PANEL_SCHEME}://${host}`;
  return [
    "default-src 'none'",
    `script-src ${self}`,
    `style-src ${self} 'unsafe-inline'`,
    `img-src ${self} data: blob:`,
    `font-src ${self}`,
    `media-src ${self}`,
    "connect-src 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
  ].join('; ');
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

export interface PanelUrl {
  /** The plugin id, lower-cased (a standard scheme's host is). */
  host: string;
  /** Path segments under `ui/`. */
  segments: string[];
}

/** `plugin-ui://com.vendor.x/sub/a.js` → its parts; null for anything else or anything unsafe. */
export function parsePanelUrl(raw: string): PanelUrl | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== `${PANEL_SCHEME}:` || !/^[a-z][a-z0-9._-]{0,99}$/.test(u.hostname)) return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(u.pathname);
  } catch {
    return null;
  }
  const segments = pathname.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) segments.push('index.html');
  for (const s of segments) {
    if (s.startsWith('.') || /[\\\0:%]/.test(s)) return null;
  }
  return { host: u.hostname, segments };
}

async function manifestId(dir: string): Promise<string | null> {
  try {
    const m = JSON.parse(await readFile(path.join(dir, MANIFEST), 'utf8')) as { id?: unknown };
    return typeof m.id === 'string' ? m.id : null;
  } catch {
    return null;
  }
}

/**
 * The bundle folder of plugin `host` in `roots` (each a bundle, or a folder of
 * bundles — as the engine scans them), first match wins; null when none.
 */
export async function findBundle(roots: readonly string[], host: string): Promise<string | null> {
  for (const root of roots) {
    const own = await manifestId(root);
    if (own !== null) {
      if (own.toLowerCase() === host) return root;
      continue;
    }
    let names: string[];
    try {
      names = await readdir(root);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const dir = path.join(root, name);
      if ((await manifestId(dir))?.toLowerCase() === host) return dir;
    }
  }
  return null;
}

export interface PanelFile {
  body: Buffer;
  contentType: string;
  csp: string;
}

/** The file a panel URL names, or null (404). Never throws. */
export async function readPanelFile(roots: readonly string[], rawUrl: string): Promise<PanelFile | null> {
  const parsed = parsePanelUrl(rawUrl);
  if (!parsed) return null;
  const type = TYPES[path.extname(parsed.segments[parsed.segments.length - 1] ?? '').toLowerCase()];
  if (!type) return null;
  try {
    const bundle = await findBundle(roots, parsed.host);
    if (!bundle) return null;
    const ui = await realpath(path.join(bundle, 'ui'));
    const file = await realpath(path.join(ui, ...parsed.segments));
    if (!file.startsWith(ui + path.sep)) return null; // a symlink out of ui/
    const s = await stat(file);
    if (!s.isFile() || s.size > MAX_FILE_BYTES) return null;
    return { body: await readFile(file), contentType: type, csp: panelCsp(parsed.host) };
  } catch {
    return null;
  }
}

/**
 * May a frame at `fromUrl` navigate to `toUrl`? A panel frame stays inside its
 * own bundle: navigating itself to the web would be network access its CSP
 * cannot stop. Frames that are not panels are not this rule's business.
 */
export function panelNavigationAllowed(fromUrl: string, toUrl: string): boolean {
  const from = parsePanelUrl(fromUrl);
  if (!from) return true;
  const to = parsePanelUrl(toUrl);
  return to !== null && to.host === from.host;
}
