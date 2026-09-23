/**
 * `local-file://` URL → absolute file path, for the protocol handler in main.
 *
 * `local-file` is not registered as a *standard* scheme, so Chromium parses it
 * as a non-special URL. Since Electron 33 (Chromium's "non-special scheme URLs"
 * work, breaking-changes.md "custom protocol URL handling on Windows") the
 * authority of such a URL is a real host/port, which changes what a Windows
 * path turns into. Measured on Electron 44.4.3:
 *
 *   local-file://C:/Users/x/a b.mp4    → request.url local-file://C/Users/x/a%20b.mp4
 *   local-file:///C:/Users/x/a%20b.mp4 → request.url unchanged
 *
 * The drive's colon is parsed as an empty port and dropped. The handler used
 * to strip the scheme and hand `C/Users/...` to `file://`, which resolves to
 * nothing. This accepts both shapes: a one-letter host on Windows is the drive.
 */

import path from 'node:path';

export function localFileUrlToPath(url: string, platform: NodeJS.Platform = process.platform): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'local-file:') return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
  if (platform === 'win32') {
    // local-file://C/Users/... (the drive landed in the host)
    if (/^[A-Za-z]$/.test(parsed.hostname)) return path.win32.normalize(`${parsed.hostname}:${pathname}`);
    // local-file:///C:/Users/...
    const drive = /^\/([A-Za-z]:)(\/.*)?$/.exec(pathname);
    if (drive) return path.win32.normalize(`${drive[1]}${drive[2] ?? '\\'}`);
    // local-file://server/share/... (UNC)
    if (parsed.hostname) return path.win32.normalize(`\\\\${parsed.hostname}${pathname}`);
    return null;
  }
  if (parsed.hostname) return null;
  return path.posix.normalize(pathname);
}
