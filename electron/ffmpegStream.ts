/**
 * Streaming encode — raw frames piped into ONE long-lived ffmpeg child.
 *
 * The staged path pays for every frame three times: the renderer encodes it to
 * JPEG/PNG, main writes the file, and ffmpeg decodes it again at the end —
 * after the whole render has finished, so the encode never overlaps the render
 * either. Here the child is started when the export begins and fed raw RGBA on
 * stdin as frames arrive: no image codec on either side, and the video encoder
 * runs WHILE the comp renders.
 *
 * ── Back-pressure is the whole design ──────────────────────────────────────
 *
 * A 1080p RGBA frame is 8 MB and a 4K one 33 MB. `stdin.write` never refuses
 * bytes — it buffers them and returns false — so a renderer that outpaces the
 * encoder would grow main's heap by a frame per frame until the process died.
 * `write` therefore resolves only once the pipe has DRAINED, and the renderer
 * awaits it before sending more (see `SequentialWriter` in framePipeline.ts),
 * so at most one frame beyond the pipe's own buffer is ever held here.
 *
 * A child that exits mid-stream must not leave a `drain` wait hanging forever:
 * every wait races the exit, and the exit's stderr tail becomes the error.
 *
 * Electron-free (the binary and args are handed in) so a fake ffmpeg — a node
 * script that consumes stdin slowly — can exercise the back-pressure and the
 * failure paths in `ffmpegStream.test.ts`.
 */

import { spawn, type ChildProcess } from 'node:child_process';

export interface FfmpegStreamOptions {
  bin: string;
  args: string[];
  /** Exact byte length every frame must have (width × height × 4 for rgba). */
  frameBytes: number;
  /** For tests. */
  spawnImpl?: typeof spawn;
}

interface ExitInfo {
  code: number | null;
  error?: NodeJS.ErrnoException;
}

/** Tail of ffmpeg's stderr kept for error messages. It prints a progress line
 *  per frame, so an unbounded buffer is megabytes on a long render. */
const STDERR_TAIL = 16 * 1024;

/**
 * The largest single IPC payload `render:streamChunk` accepts.
 *
 * The renderer splits every frame into `RAW_PIPE_CHUNK_BYTES` pieces
 * (src/core/export/rawPipe.ts, 4 MiB) and awaits an ack per piece; this is
 * the ceiling main enforces on what it will take, twice that so a chunk-size
 * change on one side needs a matching one here — a test pins the pair. An
 * unbounded payload would let a renderer park a whole 4K frame (33 MB) per
 * message in main's heap before back-pressure could say no.
 */
export const RAW_PIPE_MAX_CHUNK_BYTES = 8 * 1024 * 1024;

function spawnFailure(err: NodeJS.ErrnoException): Error {
  // ENOENT is the one failure worth explaining: nothing is wrong with the
  // render, ffmpeg simply is not installed.
  return err.code === 'ENOENT'
    ? new Error(
        'ffmpeg was not found. Install it and make sure it is on your PATH, '
          + 'or set the FFMPEG_PATH environment variable to the executable.',
      )
    : err;
}

export class FfmpegStdinStream {
  private nextIndex = 0;
  private stderr = '';
  private exitInfo: ExitInfo | null = null;
  private readonly exit: Promise<ExitInfo>;
  private stdinError: Error | null = null;
  private ended = false;
  /** Writes that had to wait for `drain` — the back-pressure actually engaging. */
  drainWaits = 0;

  private constructor(private readonly proc: ChildProcess, private readonly frameBytes: number) {
    proc.stderr?.on('data', (d: Buffer) => {
      this.stderr = (this.stderr + String(d)).slice(-STDERR_TAIL);
    });
    // EPIPE when the child has died is delivered HERE, and an unhandled stream
    // error in the main process is an uncaught exception that takes the app
    // down. Recorded; the exit carries the real reason.
    proc.stdin?.on('error', (err) => {
      this.stdinError = err;
    });
    this.exit = new Promise<ExitInfo>((resolve) => {
      proc.once('error', (error: NodeJS.ErrnoException) => {
        this.exitInfo ??= { code: null, error };
        resolve(this.exitInfo);
      });
      proc.once('close', (code) => {
        this.exitInfo ??= { code };
        resolve(this.exitInfo);
      });
    });
  }

  /**
   * Spawn the encoder. Resolves once the OS has actually started it, so a
   * missing binary rejects HERE — before a single frame has been rendered —
   * rather than on the first write.
   */
  static async open(opts: FfmpegStreamOptions): Promise<FfmpegStdinStream> {
    const proc = (opts.spawnImpl ?? spawn)(opts.bin, opts.args, { stdio: ['pipe', 'ignore', 'pipe'] });
    const stream = new FfmpegStdinStream(proc, opts.frameBytes);
    await new Promise<void>((resolve, reject) => {
      proc.once('spawn', () => resolve());
      proc.once('error', (err: NodeJS.ErrnoException) => reject(spawnFailure(err)));
    });
    return stream;
  }

  get framesWritten(): number {
    return this.nextIndex;
  }

  private failure(what: string): Error {
    const info = this.exitInfo;
    if (info?.error) return spawnFailure(info.error);
    const tail = this.stderr.slice(-600);
    return new Error(
      `${what}: ffmpeg exited ${info ? info.code : 'unexpectedly'}${tail ? `: ${tail}` : ''}`
        + (this.stdinError && !tail ? ` (${this.stdinError.message})` : ''),
    );
  }

  /**
   * Write frame `index` whole. Frames must arrive in order with no gaps —
   * ffmpeg's rawvideo demuxer has no index, so a skipped or swapped frame would
   * be encoded as the wrong picture with no error at all.
   */
  write(index: number, bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength !== this.frameBytes) {
      return Promise.reject(new Error(
        `Frame ${index} is ${bytes.byteLength} bytes; the encoder was opened for ${this.frameBytes}.`,
      ));
    }
    return this.writeChunk(index, 0, bytes, true);
  }

  /** Bytes of the frame currently being assembled from chunks. */
  private partial = 0;

  /**
   * Write one piece of frame `index`, starting at byte `offset`; `last` marks
   * the piece that completes the frame. Pieces of one frame arrive in order
   * and contiguously — the demuxer sees a byte stream, so a gap or an overlap
   * would shift every later pixel with no error — and a frame's byte count is
   * checked when its last piece lands.
   *
   * Resolves once the pipe has drained: THAT is the back-pressure. The
   * renderer awaits each chunk before sending the next, so at most one chunk
   * beyond the pipe's own buffer is ever held in this process.
   */
  async writeChunk(index: number, offset: number, bytes: Uint8Array, last: boolean): Promise<void> {
    if (this.ended) throw new Error('The encode stream is already finished.');
    if (this.exitInfo) throw this.failure(`Encoding stopped before frame ${index}`);
    if (index !== this.nextIndex) {
      throw new Error(`Frame ${index} reached the encoder out of order (expected ${this.nextIndex}).`);
    }
    if (offset !== this.partial) {
      throw new Error(`Frame ${index} chunk at byte ${offset} is not contiguous (expected ${this.partial}).`);
    }
    if (bytes.byteLength > RAW_PIPE_MAX_CHUNK_BYTES) {
      throw new Error(`Frame ${index} chunk is ${bytes.byteLength} bytes; the limit is ${RAW_PIPE_MAX_CHUNK_BYTES}.`);
    }
    const end = offset + bytes.byteLength;
    if (end > this.frameBytes || (last && end !== this.frameBytes)) {
      throw new Error(
        `Frame ${index} ${last ? 'is' : 'exceeds'} ${end} bytes; the encoder was opened for ${this.frameBytes}.`,
      );
    }
    if (last) {
      this.partial = 0;
      this.nextIndex += 1;
    } else {
      this.partial = end;
    }
    const stdin = this.proc.stdin;
    if (!stdin) throw new Error('The encoder has no input pipe.');
    // A view, not a copy: IPC already produced a fresh buffer for this frame.
    const ok = stdin.write(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    if (ok) return;
    this.drainWaits += 1;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const onDrain = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      stdin.once('drain', onDrain);
      void this.exit.then(() => {
        if (settled) return;
        settled = true;
        stdin.off('drain', onDrain);
        reject(this.failure(`Encoding stopped at frame ${index}`));
      });
    });
  }

  /** Close stdin and wait for the encode to finish. Resolves the frame count. */
  async finish(): Promise<number> {
    if (this.partial > 0) {
      this.kill();
      throw new Error(`Frame ${this.nextIndex} was only partly streamed (${this.partial} of ${this.frameBytes} bytes).`);
    }
    if (this.nextIndex === 0) {
      this.kill();
      throw new Error('No frames were streamed — refusing to write an empty file.');
    }
    this.ended = true;
    this.proc.stdin?.end();
    const info = await this.exit;
    if (info.error || info.code !== 0) throw this.failure('The encode failed');
    return this.nextIndex;
  }

  /** Kill the child (cancel / cleanup). Safe to call more than once. */
  kill(): void {
    this.ended = true;
    if (!this.exitInfo) this.proc.kill();
  }
}
