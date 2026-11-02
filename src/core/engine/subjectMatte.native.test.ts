/**
 * The subject as a selection (setLayerMatte with cut: false): the footage
 * shows whole, and the subject's matte is what other things read —
 *
 *   Apply To        an effect lands inside the subject, or outside it
 *   Matte Stroke    the outline follows the subject, not the footage's box
 *   Behind Subject  a layer above the footage is hidden where the subject is
 *   merge           a one-frame edit replaces that frame's matte only
 *
 * The footage is a flat orange clip over a navy solid; its subject is the
 * left half (x < 160). Needs a GPU adapter (PREMATION_GPU_TESTS=1) and ffmpeg
 * on PATH (the clip is made once in the OS temp folder).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import type { Command, PropertyTree } from '@motion/engine-api';
import { activeCompRootId } from '@core/scene/activeComp';
import { applySubjectStyle, defaultParams, presetById } from '@layout/Workspace/subjectStyles';
import '@layout/Workspace/placeBehindSubjectCommand';
import { runToolTurn } from '@core/ai/aiTurn';
import { engineIdle } from '@core/engine/engineInstance';
import { documentMirror } from '@stores/documentMirror';
import { sec, settleEdits, setupAppEngine, type Harness } from './__testHelpers__/appEngine';

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

const file = process.env.PREMATION_GPU_TESTS === '1' ? clip() : null;
const suite = file ? describe : describe.skip;

/** A cut-out frame of the orange footage, opaque where `inside(x)`. */
function matteFrame(dir: string, name: string, inside: (x: number) => boolean): string {
  const png = new PNG({ width: W, height: H });
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      png.data[i] = 208; png.data[i + 1] = 80; png.data[i + 2] = 42;
      png.data[i + 3] = inside(x) ? 255 : 0;
    }
  }
  const f = path.join(dir, name);
  fs.writeFileSync(f, PNG.sync.write(png));
  return f;
}

suite('a subject is a selection other effects and layers read', () => {
  let h: Harness;
  let video = '';
  let matteDir = '';
  /** The Background Image tests' picture (a project image item). */
  let backdrop = '';
  beforeAll(async () => {
    h = await setupAppEngine({ gpu: true });
    const comp = activeCompRootId() as string;
    await h.run({ type: 'setCompositionSettings', comp, patch: { width: W, height: H, frameRate: { num: 30, den: 1 }, duration: sec(2) } } as Command);
    await h.run({ type: 'setViewport', viewport: 1, width: W, height: H, devicePixelRatio: 1, zoom: 0, pan: { x: 0, y: 0 }, channel: 'rgb', exposure: 0, transparencyGrid: false, displayTransform: '', layerRenderEffects: true } as Command);
    await runToolTurn('AI: ground', [{ name: 'create_layer', args: { id: 'bg', kind: 'solid', name: 'BG', x: W / 2, y: H / 2, width: W, height: H, fill: '#20243a' } }]);
    const items = (await h.run({ type: 'importFiles', files: [{ path: file!, asSequence: false, createComposition: false }] } as Command)) as unknown as { items: string[] };
    video = ((await h.run({ type: 'createLayer', comp, kind: 'video', source: items.items[0], init: [] } as Command)) as unknown as { layer: string }).layer;
    matteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'premation-subject-'));
    const left = matteFrame(matteDir, 'subject_left.png', (x) => x < W / 2);
    await settleEdits();
    await h.run({ type: 'setLayerMatte', layer: video, frames: [{ time: sec(0), src: left }], merge: true, cut: false } as Command);
    await settleEdits();
  }, 180_000);
  afterAll(async () => {
    await h.dispose();
    if (matteDir) fs.rmSync(matteDir, { recursive: true, force: true });
  });

  async function frame(t = 0.5): Promise<PNG> {
    await settleEdits();
    await engineIdle();
    const th = (await h.query({ type: 'getThumbnail', item: activeCompRootId() as string, time: sec(t), maxSize: W } as never)) as { data: Uint8Array };
    return PNG.sync.read(Buffer.from(th.data));
  }
  const px = (p: PNG, x: number, y = 90): [number, number, number] => {
    const i = (Math.round(y * p.height / H) * p.width + Math.round(x * p.width / W)) * 4;
    return [p.data[i]!, p.data[i + 1]!, p.data[i + 2]!];
  };
  const isOrange = (c: [number, number, number]): boolean => c[0] > 170 && c[1] < 120 && c[2] < 90;
  async function effectIds(type: string): Promise<string[]> {
    const tree = (await h.query({ type: 'getPropertyTree', layer: video, path: 'effects', depth: 2 } as never)) as PropertyTree;
    return tree.nodes.filter((n) => n.matchName === type).map((n) => n.path.slice('effects/'.length));
  }
  async function errors(): Promise<string[]> {
    await engineIdle();
    return documentMirror().layerErrors(activeCompRootId() as string).filter((e) => e.stage !== 'font').map((e) => `${e.stage} ${e.message}`);
  }

  it('cut: false — the footage shows whole; the Object Matte card is there, off', async () => {
    const f = await frame();
    expect(isOrange(px(f, 60))).toBe(true);
    expect(isOrange(px(f, 260))).toBe(true);
    expect(await effectIds('object-matte')).toHaveLength(1);
    expect(await errors()).toEqual([]);
  }, 120_000);

  it('Apply To: Subject inverts only the left half; Background only the right', async () => {
    await h.run({ type: 'addEffect', layers: [video], effect: 'invert', params: [], id: 'fx_inv' } as Command);
    await h.run({ type: 'setProperty', prop: { layer: video, path: 'effects/fx_inv/compositing/subject' }, value: { kind: 'string', value: 'subject' } } as Command);
    let f = await frame();
    expect(isOrange(px(f, 60))).toBe(false);
    expect(isOrange(px(f, 260))).toBe(true);
    await h.run({ type: 'setProperty', prop: { layer: video, path: 'effects/fx_inv/compositing/subject' }, value: { kind: 'string', value: 'background' } } as Command);
    f = await frame();
    expect(isOrange(px(f, 60))).toBe(true);
    expect(isOrange(px(f, 260))).toBe(false);
    await h.run({ type: 'removePropertyGroups', groups: [{ layer: video, path: 'effects/fx_inv' }] } as Command);
    expect(await errors()).toEqual([]);
  }, 180_000);

  it('Apply To refuses anything but subject / background', async () => {
    await h.run({ type: 'addEffect', layers: [video], effect: 'invert', params: [], id: 'fx_bad' } as Command);
    const r = await h.client.execute({ type: 'setProperty', prop: { layer: video, path: 'effects/fx_bad/compositing/subject' }, value: { kind: 'string', value: 'elsewhere' } } as Command);
    expect(r.ok).toBe(false);
    await h.run({ type: 'removePropertyGroups', groups: [{ layer: video, path: 'effects/fx_bad' }] } as Command);
  }, 60_000);

  it('Matte Stroke draws around the subject, not around the footage box', async () => {
    await h.run({ type: 'addEffect', layers: [video], effect: 'matte-stroke', id: 'fx_stroke',
      params: [{ path: 'width', value: { kind: 'scalar', value: 10 } }, { path: 'color', value: { kind: 'color', value: { r: 1, g: 1, b: 1, a: 1 } } }] } as Command);
    const f = await frame();
    const edge = px(f, 165);   // just outside the subject's edge (x = 160)
    expect(edge[1]).toBeGreaterThan(200);  // white stroke
    expect(isOrange(px(f, 260))).toBe(true);  // the rest of the footage is untouched
    await h.run({ type: 'removePropertyGroups', groups: [{ layer: video, path: 'effects/fx_stroke' }] } as Command);
    expect(await errors()).toEqual([]);
  }, 120_000);

  it('Behind Subject: a white layer above the footage shows only outside the subject', async () => {
    await runToolTurn('AI: card', [{ name: 'create_layer', args: { id: 'card', kind: 'solid', name: 'Card', x: W / 2, y: H / 2, width: W, height: H, fill: '#ffffff' } }]);
    await settleEdits();
    const comp = activeCompRootId() as string;
    const card = (documentMirror().comp(comp)?.layers ?? []).find((id) => documentMirror().layer(id)?.name === 'Card')!;
    expect(card).toBeDefined();
    let f = await frame();
    expect(px(f, 60)[1]).toBeGreaterThan(240);  // covers everything at first
    await h.run({ type: 'setProperty', prop: { layer: card, path: 'layer/behindSubject' }, value: { kind: 'string', value: video } } as Command);
    f = await frame();
    expect(isOrange(px(f, 60))).toBe(true);     // the subject in front
    expect(px(f, 260)[1]).toBeGreaterThan(240); // the card behind it shows elsewhere
    await h.run({ type: 'undo' } as Command);
    f = await frame();
    expect(px(f, 60)[1]).toBeGreaterThan(240);
    expect(await errors()).toEqual([]);
    await h.run({ type: 'deleteLayers', layers: [card] } as Command);
  }, 180_000);

  describe('Background Image (Image Fill applied to the background)', () => {
    let image = '';
    const isGreen = (c: [number, number, number]): boolean => c[1] > 170 && c[0] < 90 && c[2] < 90;
    /** Solid green but for a red band at x < 30% of the picture: where the crop falls. */
    function picture(name: string, width: number, height: number, band: boolean): string {
      const png = new PNG({ width, height });
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          const red = band && x < width * 0.3;
          png.data[i] = red ? 230 : 30; png.data[i + 1] = red ? 30 : 200; png.data[i + 2] = 40; png.data[i + 3] = 255;
        }
      }
      const f = path.join(matteDir, name);
      fs.writeFileSync(f, PNG.sync.write(png));
      return f;
    }
    async function importImage(file: string): Promise<string> {
      const items = (await h.run({ type: 'importFiles', files: [{ path: file, asSequence: false, createComposition: false }] } as Command)) as unknown as { items: string[] };
      return items.items[0]!;
    }
    async function addFill(id: string, item: string, fit: string): Promise<void> {
      await h.run({ type: 'addEffect', layers: [video], effect: 'image-fill', id,
        params: [{ path: 'image', value: { kind: 'string', value: item } }, { path: 'fit', value: { kind: 'choice', value: fit } }] } as Command);
      await h.run({ type: 'setProperty', prop: { layer: video, path: `effects/${id}/compositing/subject` }, value: { kind: 'string', value: 'background' } } as Command);
    }
    const remove = (id: string) => h.run({ type: 'removePropertyGroups', groups: [{ layer: video, path: `effects/${id}` }] } as Command);

    beforeAll(async () => {
      image = await importImage(picture('wide_green.png', 640, 320, true));
      backdrop = image;
    }, 60_000);

    it('replaces the picture outside the subject and leaves the subject', async () => {
      await addFill('fx_img', image, 'Fill Frame');
      const f = await frame();
      expect(isOrange(px(f, 60))).toBe(true);
      expect(isGreen(px(f, 260))).toBe(true);
      expect(await errors()).toEqual([]);
      await remove('fx_img');
    }, 120_000);

    it('Fill Frame crops a wider picture; Stretch shows all of it', async () => {
      await addFill('fx_fit', image, 'Fill Frame');
      await h.run({ type: 'setProperty', prop: { layer: video, path: 'effects/fx_fit/compositing/subject' }, value: { kind: 'string', value: '' } } as Command);
      // The footage layer is 640 × 360, twice the comp: the comp shows the middle half of its box
      // (comp x = (u - 0.25) × 640). A 2:1 picture on that 16:9 box loses 5.6% a side to the crop, so
      // its band (to 30% of the picture) ends at u = 0.275 (x = 16); stretched, at u = 0.3 (x = 32).
      let f = await frame();
      expect(px(f, 8)[0]).toBeGreaterThan(170);
      expect(isGreen(px(f, 24))).toBe(true);
      await h.run({ type: 'setProperty', prop: { layer: video, path: 'effects/fx_fit/fit' }, value: { kind: 'choice', value: 'Stretch' } } as Command);
      f = await frame();
      expect(px(f, 24)[0]).toBeGreaterThan(170);
      expect(isGreen(px(f, 48))).toBe(true);
      await remove('fx_fit');
    }, 120_000);

    it('Fit Inside leaves the layer showing where the picture does not reach', async () => {
      const tall = await importImage(picture('tall_green.png', 90, 180, false));
      await addFill('fx_in', tall, 'Fit Inside');
      await h.run({ type: 'setProperty', prop: { layer: video, path: 'effects/fx_in/compositing/subject' }, value: { kind: 'string', value: '' } } as Command);
      const f = await frame();
      expect(isGreen(px(f, 160))).toBe(true);
      expect(isOrange(px(f, 40))).toBe(true);
      expect(isOrange(px(f, 280))).toBe(true);
      await remove('fx_in');
    }, 120_000);

    it('follows the subject: each frame reads its own matte', async () => {
      const right = matteFrame(matteDir, 'bg_right.png', (x) => x >= W / 2);
      await h.run({ type: 'setLayerMatte', layer: video, frames: [{ time: sec(1.5), src: right }], merge: true, cut: false } as Command);
      await addFill('fx_track', image, 'Fill Frame');
      let f = await frame(0.2);
      expect(isOrange(px(f, 60))).toBe(true);
      expect(isGreen(px(f, 260))).toBe(true);
      f = await frame(1.6);
      expect(isGreen(px(f, 60))).toBe(true);
      expect(isOrange(px(f, 260))).toBe(true);
      await remove('fx_track');
    }, 180_000);

    it('a missing image never blanks the frame: the footage shows, and the layer says so', async () => {
      await addFill('fx_gone', 'no_such_item', 'Fill Frame');
      const f = await frame();
      expect(isOrange(px(f, 60))).toBe(true);
      expect(isOrange(px(f, 260))).toBe(true);
      expect((await errors()).join(' ')).toMatch(/Image Fill.*missing/);
      await remove('fx_gone');
    }, 120_000);

    it('applied from the style shelf it is one undo step', async () => {
      const preset = presetById('bgImage')!;
      expect(await applySubjectStyle(video, null, preset, { ...defaultParams(preset), image })).toBe(true);
      expect(await effectIds('image-fill')).toHaveLength(1);
      expect(isGreen(px(await frame(), 260))).toBe(true);
      await h.run({ type: 'undo' } as Command);
      await settleEdits();
      expect(await effectIds('image-fill')).toHaveLength(0);
      expect(isOrange(px(await frame(), 260))).toBe(true);
    }, 180_000);

    it('an image a layer effect uses cannot be removed from under it', async () => {
      await addFill('fx_used', image, 'Fill Frame');
      const r = await h.client.execute({ type: 'removeItems', items: [image] } as Command);
      expect(r.ok).toBe(false);
      await remove('fx_used');
    }, 60_000);
  });

  it('merge replaces one frame and keeps the others', async () => {
    const right = matteFrame(matteDir, 'subject_right.png', (x) => x >= W / 2);
    await h.run({ type: 'setLayerMatte', layer: video, frames: [{ time: sec(1.5), src: right }], merge: true, cut: false } as Command);
    await h.run({ type: 'addEffect', layers: [video], effect: 'invert', params: [], id: 'fx_inv2' } as Command);
    await h.run({ type: 'setProperty', prop: { layer: video, path: 'effects/fx_inv2/compositing/subject' }, value: { kind: 'string', value: 'subject' } } as Command);
    // Nearest frame: 0.2 s reads the left subject, 1.6 s the right one.
    let f = await frame(0.2);
    expect(isOrange(px(f, 60))).toBe(false);
    expect(isOrange(px(f, 260))).toBe(true);
    f = await frame(1.6);
    expect(isOrange(px(f, 60))).toBe(true);
    expect(isOrange(px(f, 260))).toBe(false);
    await h.run({ type: 'removePropertyGroups', groups: [{ layer: video, path: 'effects/fx_inv2' }] } as Command);
  }, 180_000);

  async function subjectsOf(): Promise<Array<{ id: string; name: string; color: string }>> {
    const r = (await h.query({ type: 'getPropertyValues', props: [{ layer: video, path: 'layer/subjects' }], time: 0 } as never)) as {
      values: Array<{ value: { kind: string; value?: string } }>;
    };
    const v = r.values[0]?.value;
    return v?.kind === 'json' && v.value ? (JSON.parse(v.value) as Array<{ id: string; name: string; color: string }>) : [];
  }
  const setSubjects = (list: unknown): Promise<unknown> =>
    h.run({ type: 'setProperty', prop: { layer: video, path: 'layer/subjects' }, value: { kind: 'json', value: JSON.stringify(list) } } as Command);

  /**
   * A cut-out at the LAYER's own size (its box may be larger than the comp: the
   * test clip's layer is drawn 1:1 around the comp's centre), opaque where the
   * comp column `inside(x)` — so a subject's region is exact in comp px.
   */
  async function layerMatte(name: string, inside: (compX: number) => boolean): Promise<string> {
    const r = (await h.query({ type: 'getPropertyValues', props: [{ layer: video, path: 'layer/width' }, { layer: video, path: 'layer/height' }], time: 0, evaluated: true } as never)) as {
      values: Array<{ value: { value?: number } }>;
    };
    const lw = Math.round(r.values[0]?.value.value ?? W);
    const lh = Math.round(r.values[1]?.value.value ?? H);
    const png = new PNG({ width: lw, height: lh });
    for (let y = 0; y < lh; y++) {
      for (let x = 0; x < lw; x++) {
        const i = (y * lw + x) * 4;
        png.data[i] = 208; png.data[i + 1] = 80; png.data[i + 2] = 42;
        png.data[i + 3] = inside(x - lw / 2 + W / 2) ? 255 : 0;
      }
    }
    const f = path.join(matteDir, name);
    fs.writeFileSync(f, PNG.sync.write(png));
    return f;
  }

  it('several subjects: each its own frames, name and colour; an effect reads one of them or all', async () => {
    const left = await layerMatte('s1_left.png', (x) => x < 120);
    const farRight = await layerMatte('s2_far_right.png', (x) => x >= 240);
    // Subject 1 alone on the left (not merged: its other frames go); Subject 2 on the far right.
    await h.run({ type: 'setLayerMatte', layer: video, frames: [{ time: sec(0), src: left }], merge: false, cut: false } as Command);
    await h.run({ type: 'setLayerMatte', layer: video, frames: [{ time: sec(0), src: farRight }], merge: true, cut: false, subject: 's2' } as Command);
    const list = await subjectsOf();
    expect(list.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(list.map((s) => s.name)).toEqual(['Subject 1', 'Subject 2']);
    expect(list[0]!.color).not.toBe(list[1]!.color);

    await h.run({ type: 'addEffect', layers: [video], effect: 'invert', params: [], id: 'fx_s2' } as Command);
    await h.run({ type: 'setProperty', prop: { layer: video, path: 'effects/fx_s2/compositing/subject' }, value: { kind: 'string', value: 'subject' } } as Command);
    await h.run({ type: 'setProperty', prop: { layer: video, path: 'effects/fx_s2/compositing/subjectId' }, value: { kind: 'string', value: 's2' } } as Command);
    let f = await frame();
    expect(isOrange(px(f, 60))).toBe(true);    // Subject 1: not this effect's
    expect(isOrange(px(f, 180))).toBe(true);   // neither subject
    expect(isOrange(px(f, 280))).toBe(false);  // Subject 2
    // All subjects: both regions.
    await h.run({ type: 'setProperty', prop: { layer: video, path: 'effects/fx_s2/compositing/subjectId' }, value: { kind: 'string', value: '' } } as Command);
    f = await frame();
    expect(isOrange(px(f, 60))).toBe(false);
    expect(isOrange(px(f, 180))).toBe(true);
    expect(isOrange(px(f, 280))).toBe(false);
    expect(await errors()).toEqual([]);
  }, 240_000);

  it('a subject\'s live edge and visibility change the matte at once', async () => {
    const list = await subjectsOf();
    // Subject 1 (x < 120) grown by 30 px: the invert (all subjects) reaches x = 150.
    await setSubjects(list.map((s) => (s.id === 's1' ? { ...s, choke: -30 } : s)));
    let f = await frame();
    expect(isOrange(px(f, 135))).toBe(false);
    expect(isOrange(px(f, 165))).toBe(true);
    // Subject 2 hidden: it covers nothing.
    await setSubjects(list.map((s) => (s.id === 's2' ? { ...s, hidden: true } : s)));
    f = await frame();
    expect(isOrange(px(f, 280))).toBe(true);
    expect(isOrange(px(f, 60))).toBe(false);
    await setSubjects(list);
    expect(await errors()).toEqual([]);
  }, 240_000);

  it('Behind Subjects: a layer between the subjects — behind Subject 1 only', async () => {
    await h.run({ type: 'removePropertyGroups', groups: [{ layer: video, path: 'effects/fx_s2' }] } as Command);
    await runToolTurn('AI: card', [{ name: 'create_layer', args: { id: 'card2', kind: 'solid', name: 'Card2', x: W / 2, y: H / 2, width: W, height: H, fill: '#ffffff' } }]);
    await settleEdits();
    const comp = activeCompRootId() as string;
    const card = (documentMirror().comp(comp)?.layers ?? []).find((id) => documentMirror().layer(id)?.name === 'Card2')!;
    await h.run({ type: 'setProperty', prop: { layer: card, path: 'layer/behindSubject' }, value: { kind: 'string', value: video } } as Command);
    await h.run({ type: 'setProperty', prop: { layer: card, path: 'layer/behindSubjects' }, value: { kind: 'json', value: JSON.stringify(['s1']) } } as Command);
    const f = await frame();
    expect(isOrange(px(f, 60))).toBe(true);        // Subject 1 in front of the card
    expect(px(f, 280)[1]).toBeGreaterThan(240);    // Subject 2 is behind it
    expect(px(f, 200)[1]).toBeGreaterThan(240);
    await h.run({ type: 'deleteLayers', layers: [card] } as Command);
    expect(await errors()).toEqual([]);
  }, 240_000);

  it('removing a subject keeps the others', async () => {
    await h.run({ type: 'setLayerMatte', layer: video, frames: [], merge: false, subject: 's2' } as Command);
    expect((await subjectsOf()).map((s) => s.id)).toEqual(['s1']);
    await h.run({ type: 'addEffect', layers: [video], effect: 'invert', params: [], id: 'fx_left' } as Command);
    await h.run({ type: 'setProperty', prop: { layer: video, path: 'effects/fx_left/compositing/subject' }, value: { kind: 'string', value: 'subject' } } as Command);
    const f = await frame();
    expect(isOrange(px(f, 60))).toBe(false);
    expect(isOrange(px(f, 280))).toBe(true);
    await h.run({ type: 'undo' } as Command);
    await h.run({ type: 'undo' } as Command);
    await h.run({ type: 'undo' } as Command);
    expect((await subjectsOf()).map((s) => s.id)).toEqual(['s1', 's2']);
    expect(await errors()).toEqual([]);
  }, 240_000);
  it('the Assistant’s apply_subject_style puts a project image behind a subject, one undo step', async () => {
    const subject = (await subjectsOf())[0]!.id;
    const bad = await runToolTurn('AI: backdrop', [{ name: 'apply_subject_style', args: { layerId: video, style: 'bgImage', subject } }]);
    expect(bad.results[0]!.ok).toBe(false);
    expect(bad.results[0]!.content).toMatch(/bgImage needs `image`/);
    const good = await runToolTurn('AI: backdrop', [{ name: 'apply_subject_style', args: { layerId: video, style: 'bgImage', subject, image: backdrop, fit: 'stretch' } }]);
    expect(good.results[0]!.content).toMatch(/Applied "Background Image"/);
    await settleEdits();
    expect(await effectIds('image-fill')).toHaveLength(1);
    await h.run({ type: 'undo' } as Command);
    await settleEdits();
    expect(await effectIds('image-fill')).toHaveLength(0);
  }, 120_000);
});
