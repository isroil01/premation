/**
 * Which ffmpeg an export runs — one rule for both renderers (the Chromium raw
 * pipe in main.ts and the engine's export jobs, engineExport.ts), so the two
 * paths can never encode with different binaries:
 *
 *   1. FFMPEG_PATH, when it names a file that exists;
 *   2. the bundled copy, `<resources>/ffmpeg/ffmpeg[.exe]`;
 *   3. `ffmpeg` on PATH.
 *
 * Electron-free (everything it reads is handed in).
 */

import path from 'node:path';

export function resolveFfmpegBinary(env: {
  vars: Record<string, string | undefined>;
  resourcesPath: string;
  platform: NodeJS.Platform;
  exists: (p: string) => boolean;
}): string {
  const override = env.vars.FFMPEG_PATH;
  if (override && env.exists(override)) return override;
  const name = env.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const bundled = path.join(env.resourcesPath, 'ffmpeg', name);
  if (env.exists(bundled)) return bundled;
  return 'ffmpeg';
}
