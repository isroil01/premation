/**
 * HDR10 / HLG delivery end to end: a project made and saved by the engine,
 * rendered by `premation-engine --export` with `hdr` (native/engine/src/export/
 * hdr_convert.hpp) through the supervisor's launcher (electron/engineExport.ts)
 * into the host ffmpeg, then read back with ffprobe / ffmpeg: BT.2020 + PQ /
 * HLG tags, 10-bit, HDR10 mastering metadata, and the white background at
 * the code value the curves put SDR reference white at.
 *
 * Needs the engine built, a GPU and an ffmpeg with libx265 on PATH (or
 * FFMPEG_PATH); skipped, saying so, otherwise.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProcessEngineClient, secondsToFlicks } from '@motion/engine-api';
import { nativeEngineExe, startNativeEngine } from '@core/engine/__testHelpers__/nativeEngine';
// Test-only reach into the Electron main sources: the launcher is plain Node.
import { startEngineExport, type EngineExportOutcome } from '../../../../electron/engineExport';

const exe = nativeEngineExe();
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobe = process.env.FFPROBE_PATH || (process.env.FFMPEG_PATH ? path.join(path.dirname(process.env.FFMPEG_PATH), `ffprobe${path.extname(process.env.FFMPEG_PATH)}`) : 'ffprobe');
const hasX265 = (() => {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
  return r.status === 0 && /\slibx265\s/.test(r.stdout);
})();
const maybe = exe && hasX265 ? describe : describe.skip;
if (!exe) console.log('[hdrExport] premation-engine is not built — skipped');
else if (!hasX265) console.log('[hdrExport] no ffmpeg with libx265 — skipped');

jest.setTimeout(180_000);

/** The first frame's first luma sample, 10-bit (yuv420p10le). */
function firstLuma(file: string): number {
  const r = spawnSync(ffmpeg, ['-v', 'error', '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'yuv420p10le', '-'], { maxBuffer: 64 * 1024 * 1024 });
  expect(r.status).toBe(0);
  return (r.stdout as Buffer).readUInt16LE(0);
}

function probe(file: string): { stream: Record<string, unknown>; sideData: Array<Record<string, unknown>> } {
  const s = spawnSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,pix_fmt,color_transfer,color_primaries,color_space,color_range', '-of', 'json', file], { encoding: 'utf8' });
  expect(s.status).toBe(0);
  const f = spawnSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-read_intervals', '%+#1', '-show_frames', '-show_entries', 'frame=side_data_list', '-of', 'json', file], { encoding: 'utf8' });
  expect(f.status).toBe(0);
  const frames = (JSON.parse(f.stdout) as { frames?: Array<{ side_data_list?: Array<Record<string, unknown>> }> }).frames ?? [];
  return {
    stream: (JSON.parse(s.stdout) as { streams: Array<Record<string, unknown>> }).streams[0]!,
    sideData: frames[0]?.side_data_list ?? [],
  };
}

maybe('HDR export (engine)', () => {
  let dir = '';
  let projectPath = '';

  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'premation-hdr-'));
    projectPath = path.join(dir, 'p.motion');
    const native = await startNativeEngine();
    try {
      const client = new ProcessEngineClient(native.bridge);
      await client.whenReady();
      const made = await client.execute({
        type: 'createComposition',
        settings: { name: 'White', width: 64, height: 36, frameRate: { num: 30, den: 1 }, duration: secondsToFlicks(0.1), background: { r: 1, g: 1, b: 1, a: 1 } },
        fromItems: [],
      } as never);
      expect(made.ok).toBe(true);
      const saved = await client.execute({ type: 'saveProject', path: projectPath, copy: false } as never);
      expect(saved.ok).toBe(true);
    } finally {
      await native.stop();
    }
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const noGpu = (o: EngineExportOutcome): boolean => {
    const skip = o.kind === 'fallback' && /GPU|adapter/i.test(o.reason);
    if (skip) console.log(`[hdrExport] no GPU — skipped: ${o.kind === 'fallback' ? o.reason : ''}`);
    return skip;
  };

  async function render(format: string, name: string): Promise<{ outcome: EngineExportOutcome; out: string }> {
    const out = path.join(dir, name);
    const run = startEngineExport(`hdr-${format}`, { projectPath, outPath: out, format, comp: 'White', quality: 'high', hdrEncoder: 'libx265' }, { progress: () => undefined }, {
      enginePath: exe,
      ffmpegPath: () => ffmpeg,
      workDirFor: (id) => path.join(dir, id),
      log: () => undefined,
    });
    return { outcome: await run.done, out };
  }

  it('HDR10: HEVC 10-bit, BT.2020 + PQ, mastering metadata, white at 203 nits', async () => {
    const { outcome, out } = await render('hdr10', 'white-pq.mp4');
    if (noGpu(outcome)) return;
    expect(outcome).toMatchObject({ kind: 'completed', frames: 3, stats: { hdr: { transfer: 'pq', maxCll: 203, maxFall: 203 } } });
    expect(existsSync(out)).toBe(true);
    const p = probe(out);
    expect(p.stream).toMatchObject({ codec_name: 'hevc', pix_fmt: 'yuv420p10le', color_transfer: 'smpte2084', color_primaries: 'bt2020', color_space: 'bt2020nc', color_range: 'tv' });
    const types = p.sideData.map((d) => String(d.side_data_type));
    expect(types).toEqual(expect.arrayContaining(['Mastering display metadata', 'Content light level metadata']));
    // PQ(203 nits) = 0.5807; 10-bit limited range: 64 + 876 × 0.5807 = 572.7.
    expect(Math.abs(firstLuma(out) - 573)).toBeLessThanOrEqual(3);
  });

  it('HLG: BT.2020 + ARIB STD-B67, white at 75 % signal', async () => {
    const { outcome, out } = await render('hlg', 'white-hlg.mp4');
    if (noGpu(outcome)) return;
    expect(outcome).toMatchObject({ kind: 'completed', stats: { hdr: { transfer: 'hlg' } } });
    expect(probe(out).stream).toMatchObject({ codec_name: 'hevc', pix_fmt: 'yuv420p10le', color_transfer: 'arib-std-b67', color_primaries: 'bt2020' });
    // 64 + 876 × 0.75 = 721.
    expect(Math.abs(firstLuma(out) - 721)).toBeLessThanOrEqual(3);
  });
});
