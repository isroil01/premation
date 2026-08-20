/**
 * Import ingest — footage the browser cannot decode, made editable.
 *
 * The engine's decode paths all end at browser machinery: the exact WebCodecs
 * decoder, the <video> element fallback, drawImage. A ProRes MOV, an MXF, a
 * DV AVI — real footage from real cameras and real NLE round-trips — decode
 * in none of them, so importing one produced an asset that probed fine and
 * rendered black.
 *
 * The desktop app ships ffmpeg (the export encoder and the proxy generator
 * already run on it), so the fix is the one every NLE uses: TRANSCODE AT
 * IMPORT. The generic `generateProxy` IPC already runs arbitrary ffmpeg
 * argument lists in a child process with real cancellation; ingest is that
 * IPC with edit-friendly full-resolution settings rather than proxy ones.
 *
 * What comes out:
 *   • opaque sources → H.264 MP4, CRF 16 (visually transparent for editing),
 *     +faststart so the demuxer's index read is one seek;
 *   • alpha sources (ProRes 4444 and friends) → VP9 WebM with alpha. The
 *     exact-decoder column is MP4-only, so alpha ingests ride the element
 *     fallback tier — documented, and better than losing the alpha.
 *
 * The ingested File KEEPS the original basename (extension changes), so the
 * asset the user sees is named like the file they dropped. Browser edition:
 * no ffmpeg, `maybeIngestForImport` returns null, imports behave exactly as
 * before.
 */

import { canProbe, probeMedia } from './mediaProbe';

/** Containers the browser's <video> cannot open regardless of codec. */
const INGEST_CONTAINERS = new Set([
  'mxf', 'avi', 'wmv', 'flv', 'mts', 'm2ts', 'mpg', 'mpeg', 'vob', 'mpe', 'ts',
]);

/** Codecs no browser decodes, in containers it otherwise could open (.mov). */
const INGEST_CODECS = new Set([
  'prores', 'dnxhd', 'dnxhr', 'mpeg2video', 'cineform', 'ffv1', 'v210',
  'rawvideo', 'mjpeg', 'jpeg2000', 'huffyuv', 'qtrle',
]);

const extOf = (name: string): string => (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toLowerCase();

/**
 * The ffmpeg argument list for one ingest, with the `__IN__`/`__OUT__`
 * placeholders the main process substitutes (same contract as
 * `proxyEncodeArgs`). Exported for the args to be testable as data.
 */
export function ingestEncodeArgs(hasAlpha: boolean): { args: string[]; outExt: string; mime: string } {
  if (hasAlpha) {
    return {
      args: [
        '-i', '__IN__',
        '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-crf', '20', '-b:v', '0', '-row-mt', '1',
        '-c:a', 'libopus',
        '__OUT__',
      ],
      outExt: 'webm',
      mime: 'video/webm',
    };
  }
  return {
    args: [
      '-i', '__IN__',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart',
      '__OUT__',
    ],
    outExt: 'mp4',
    mime: 'video/mp4',
  };
}

/**
 * Whether this file needs ingest, given what the probe learned. Pure.
 *
 * Unplayable CONTAINERS ingest unconditionally — even when the probe failed,
 * because ffmpeg reads what ffprobe could not more often than the reverse.
 * Playable containers (.mov especially) ingest only on an unplayable CODEC:
 * an H.264 .mov plays natively and must not pay a re-encode.
 */
export function needsIngest(fileName: string, videoCodec: string | undefined): boolean {
  const ext = extOf(fileName);
  if (INGEST_CONTAINERS.has(ext)) return true;
  if (!videoCodec) return false;
  const codec = videoCodec.toLowerCase();
  for (const c of INGEST_CODECS) if (codec.includes(c)) return true;
  return false;
}

/** Files that could POSSIBLY need ingest — the cheap pre-filter that keeps
 *  ordinary MP4/WebM imports from paying a probe here (they probe later in
 *  `applyProbe` anyway; this module must not double that cost). */
export function ingestCandidate(fileName: string): boolean {
  const ext = extOf(fileName);
  return INGEST_CONTAINERS.has(ext) || ext === 'mov' || ext === 'mkv' || ext === 'm4v';
}

/**
 * Transcode `file` into a browser-playable File, or null when no ingest is
 * needed or possible (browser edition, ffmpeg absent, encode failed — every
 * one of which means "import the original exactly as before").
 */
export async function maybeIngestForImport(
  file: File,
  onStatus?: (msg: string) => void,
): Promise<File | null> {
  if (!ingestCandidate(file.name)) return null;
  const bridge = typeof window !== 'undefined' ? window.motionEditor?.media : undefined;
  if (!bridge?.generateProxy || !canProbe()) return null;

  const facts = await probeMedia(file);
  if (!needsIngest(file.name, facts.videoCodec)) return null;

  onStatus?.(`Transcoding “${file.name}” for editing (${facts.videoCodec ?? extOf(file.name)})…`);
  const { args, outExt, mime } = ingestEncodeArgs(facts.hasAlpha === true);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const out = await bridge.generateProxy(
    // Keyed per call: a re-import of the same file supersedes its own job and
    // nobody else's.
    `ingest:${file.name}:${file.size}`,
    bytes,
    extOf(file.name) || 'bin',
    args,
    outExt,
  ).catch(() => null);
  if (!out) return null;

  const base = file.name.replace(/\.[a-z0-9]+$/i, '');
  return new File([out as BlobPart], `${base}.${outExt}`, { type: mime });
}
