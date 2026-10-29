/**
 * Automatic tracking decides from the engine's own record of the subject
 * (getSubjectTracks) what an edit asks for: a held subject on video is
 * Followed, a fix on a tracked one re-tracks between its neighbours, and
 * stills, locked subjects and fixes outside the tracked frames are left alone.
 *
 * Needs ffmpeg on PATH (the clip is made once in the OS temp folder). The
 * walks themselves need the model process (full engine); this checks the
 * decisions only.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import type { Command } from '@motion/engine-api';
import { activeCompRootId } from '@core/scene/activeComp';
import { edit } from '@core/engine/uiEdits';
import { updateSubjectCommands } from '@core/workspace/subjects';
import { sec, settleEdits, setupAppEngine, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { documentMirror } from '@stores/documentMirror';
import { trackingFor } from './autoTrack';
import { layerMoves } from './subjectActions';

jest.useFakeTimers({ doNotFake: ['setTimeout', 'queueMicrotask', 'nextTick', 'setImmediate'] });

const W = 320;
const H = 180;
const DIR = path.join(os.tmpdir(), 'premation-test-clips');

function clip(): string | null {
  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, 'object_matte_flat_320x180.mp4');
  if (fs.existsSync(file)) return file;
  try {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0xd0502a:s=${W}x${H}:r=30:d=2`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '4', '-pix_fmt', 'yuv420p', file], { stdio: 'ignore', timeout: 120_000 });
    return file;
  } catch {
    return null;
  }
}

const file = clip();
const suite = file ? describe : describe.skip;

suite('automatic subject tracking: what an edit asks for', () => {
  let h: Harness;
  let video = '';
  let still = '';
  let matte = '';
  let dir = '';
  beforeAll(async () => {
    h = await setupAppEngine();
    const comp = activeCompRootId() as string;
    await h.run({ type: 'setCompositionSettings', comp, patch: { width: W, height: H, frameRate: { num: 30, den: 1 }, duration: sec(2) } } as Command);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'premation-autotrack-'));
    const png = new PNG({ width: W, height: H });
    png.data.fill(255);
    matte = path.join(dir, 'm.png');
    fs.writeFileSync(matte, PNG.sync.write(png));
    const items = (await h.run({ type: 'importFiles', files: [{ path: file!, asSequence: false, createComposition: false }, { path: matte, asSequence: false, createComposition: false }] } as Command)) as unknown as { items: string[] };
    video = ((await h.run({ type: 'createLayer', comp, kind: 'video', source: items.items[0], init: [] } as Command)) as unknown as { layer: string }).layer;
    still = ((await h.run({ type: 'createLayer', comp, kind: 'image', source: items.items[1], init: [] } as Command)) as unknown as { layer: string }).layer;
    await settleEdits();
    await documentMirror().loadTrees([video, still]);
  }, 180_000);
  afterAll(async () => {
    await h.dispose();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  const frames = (from: number, to: number, fixes: number[] = []) =>
    Array.from({ length: to - from + 1 }, (_, i) => ({ time: sec((from + i) / 30), src: matte, ...(fixes.includes(from + i) ? { fix: true } : { confidence: 0.9 }) }));

  it('tells moving footage from a still', () => {
    expect(layerMoves(video)).toBe(true);
    expect(layerMoves(still)).toBe(false);
  });

  it('a subject selected on one frame of video is followed; on a still it is left held', async () => {
    await h.run({ type: 'setLayerMatte', layer: video, frames: [{ time: sec(0.5), src: matte, fix: true }], merge: false, cut: false } as Command);
    await h.run({ type: 'setLayerMatte', layer: still, frames: [{ time: sec(0), src: matte, fix: true }], merge: false, cut: false } as Command);
    await settleEdits();
    expect(await trackingFor(video, 's1', 0.5)).toBe('follow');
    expect(await trackingFor(still, 's1', 0)).toBeNull();
  });

  it('a fix on a tracked subject re-tracks; a fix past the tracked frames does not', async () => {
    await h.run({ type: 'setLayerMatte', layer: video, frames: frames(0, 40, [0, 20]), merge: false, cut: false } as Command);
    await settleEdits();
    expect(await trackingFor(video, 's1', 30 / 30)).toBe('retrack');
    expect(await trackingFor(video, 's1', 55 / 30)).toBeNull();
  });

  it('a locked subject is never tracked by itself', async () => {
    await documentMirror().loadTrees([video]);
    await edit('Lock', updateSubjectCommands(video, 's1', { locked: true }));
    await settleEdits();
    expect(await trackingFor(video, 's1', 1)).toBeNull();
  });
});
