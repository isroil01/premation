/**
 * Which video encoders THIS ffmpeg on THIS machine can actually run.
 *
 * Two questions, both cached for the life of the process:
 *
 *  1. Is the encoder compiled in? `ffmpeg -encoders` lists what the build
 *     knows about. Cheap, one spawn, answers "libx265?" and "h264_nvenc?"
 *     alike — but a listed hardware encoder is only a promise: the build has
 *     the code, not necessarily the GPU or the driver.
 *  2. Does it encode? A two-frame smoke encode of a synthetic source into
 *     `-f null`. This is where NVENC on a machine without an NVIDIA card, QSV
 *     without the Intel runtime, or VideoToolbox on an unsupported chip fails —
 *     in ~100 ms, before the export has rendered a single frame, instead of
 *     after it has rendered all of them.
 *
 * `resolveVideoEncoder` is the one call the export handlers make: the encoder
 * the user asked for if both answers are yes, `libx264` with a stated reason
 * otherwise. Falling back silently would be wrong (the user picked hardware
 * for a reason and should learn it did not engage) and failing would be worse
 * (the render is fine; only the accelerator is missing), so the reason travels
 * back to the renderer as a warning.
 *
 * Electron-free: the binary and a spawn implementation are handed in, so the
 * tests drive it with a fake ffmpeg.
 */

import { spawn } from 'node:child_process';
import {
  isHwVideoEncoder,
  parseFfmpegEncoders,
  type HwVideoEncoder,
  type VideoEncoder,
} from './ffmpegEncodeArgs';

export interface ProbeDeps {
  /** The ffmpeg executable — resolved by the caller, since only main knows the bundled path. */
  bin: () => string;
  spawnImpl?: typeof spawn;
  /** Milliseconds before a probe is abandoned as "not working". */
  timeoutMs?: number;
}

/** Run ffmpeg with `args`; resolve its combined output and exit code, never reject. */
function run(deps: ProbeDeps, args: string[]): Promise<{ code: number | null; text: string }> {
  return new Promise((resolve) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = (deps.spawnImpl ?? spawn)(deps.bin(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve({ code: null, text: '' });
      return;
    }
    let text = '';
    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, text });
    };
    const timer = setTimeout(() => {
      proc.kill();
      finish(null);
    }, deps.timeoutMs ?? 15_000);
    proc.stdout?.on('data', (d: Buffer) => { text += String(d); });
    proc.stderr?.on('data', (d: Buffer) => { text += String(d); });
    proc.on('error', () => finish(null));
    proc.on('close', (code) => finish(code));
  });
}

export class EncoderProbe {
  private listed: Promise<Set<string>> | null = null;
  private readonly smoke = new Map<string, Promise<boolean>>();

  constructor(private readonly deps: ProbeDeps) {}

  /** Names `ffmpeg -encoders` reports. Empty when ffmpeg cannot be run at all. */
  listEncoders(): Promise<Set<string>> {
    this.listed ??= run(this.deps, ['-hide_banner', '-encoders']).then(({ text }) => parseFfmpegEncoders(text));
    return this.listed;
  }

  /** Is `name` compiled into this ffmpeg? */
  async has(name: string): Promise<boolean> {
    return (await this.listEncoders()).has(name);
  }

  /**
   * Does `name` really encode here? Two frames of a synthetic source into a
   * null muxer — the cheapest thing that makes a hardware encoder open its
   * device. `-nostdin` so a misbehaving encoder cannot wait on a terminal.
   */
  works(name: string): Promise<boolean> {
    let p = this.smoke.get(name);
    if (!p) {
      p = (async () => {
        if (!(await this.has(name))) return false;
        const { code } = await run(this.deps, [
          '-hide_banner', '-nostdin', '-loglevel', 'error',
          '-f', 'lavfi', '-i', 'color=c=black:s=256x256:r=30:d=0.1',
          '-frames:v', '2', '-c:v', name, '-pix_fmt', 'yuv420p', '-f', 'null', '-',
        ]);
        return code === 0;
      })();
      this.smoke.set(name, p);
    }
    return p;
  }

  /** The hardware encoders that pass both checks — for the Settings UI. */
  async availableHw(): Promise<HwVideoEncoder[]> {
    const listed = await this.listEncoders();
    const candidates = [...listed].filter(isHwVideoEncoder);
    const ok = await Promise.all(candidates.map((c) => this.works(c)));
    return candidates.filter((_, i) => ok[i]);
  }

  /**
   * The encoder an export should use for `requested`.
   *
   * `libx264` always resolves to itself without a probe: it is in every ffmpeg
   * this app ships or documents, and probing it would only delay the export
   * whose default it is.
   */
  async resolveVideoEncoder(requested: VideoEncoder | undefined): Promise<{ encoder: VideoEncoder; fallbackReason?: string }> {
    if (!requested || requested === 'libx264') return { encoder: 'libx264' };
    if (!isHwVideoEncoder(requested)) {
      return { encoder: 'libx264', fallbackReason: `"${String(requested)}" is not a supported video encoder.` };
    }
    if (!(await this.has(requested))) {
      return { encoder: 'libx264', fallbackReason: `This ffmpeg build has no ${requested} encoder; encoded with libx264 instead.` };
    }
    if (!(await this.works(requested))) {
      return {
        encoder: 'libx264',
        fallbackReason: `${requested} is compiled in but failed to initialise on this machine (no device, or driver missing); encoded with libx264 instead.`,
      };
    }
    return { encoder: requested };
  }

  /** Forget every cached answer — a new ffmpeg path, or a test. */
  reset(): void {
    this.listed = null;
    this.smoke.clear();
  }
}
