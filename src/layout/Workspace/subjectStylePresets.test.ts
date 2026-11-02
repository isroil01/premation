/**
 * Every subject style preset is made of effects the engine has, with
 * parameters those effects declare — a preset that named a missing effect
 * or a misspelt key would add a broken card to the layer.
 */

import fs from 'fs';
import path from 'path';
import { SUBJECT_STYLES, defaultParams, lighten, DRAW_ON_SECONDS } from './subjectStylePresets';
import { subjectStyleCommands } from './subjectStyles';

interface CatalogParam { key: string }
interface CatalogEffect { type: string; params?: CatalogParam[]; parameters?: CatalogParam[] }

const catalog: CatalogEffect[] = (() => {
  const raw = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../native/engine/catalog/effects.json'), 'utf8')) as unknown;
  const list = Array.isArray(raw) ? raw : (raw as { effects?: unknown }).effects;
  return (Array.isArray(list) ? list : Object.values(list as Record<string, unknown>)) as CatalogEffect[];
})();
const byType = new Map(catalog.map((e) => [e.type, new Set((e.params ?? e.parameters ?? []).map((p) => p.key))]));

const ctx = { fps: 30, time: 2 };

describe('subject style presets', () => {
  it.each(SUBJECT_STYLES.map((p) => [p.id, p] as const))('%s uses catalogue effects and their own parameters', (_id, preset) => {
    for (const intensity of [0, 50, 100]) {
      const parts = preset.parts({ ...defaultParams(preset), intensity }, ctx);
      expect(parts.length).toBeGreaterThan(0);
      for (const part of parts) {
        const keys = byType.get(part.effect);
        expect(keys).toBeDefined();
        for (const p of part.params) expect(keys!.has(p.path)).toBe(true);
        for (const k of part.keys ?? []) expect(keys!.has(k.path)).toBe(true);
      }
    }
  });

  it('commands add each part, scope it, name the subject and set its keys', () => {
    const drawOn = SUBJECT_STYLES.find((p) => p.id === 'drawOn')!;
    const cmds = subjectStyleCommands('L', 's2', drawOn, defaultParams(drawOn), ctx);
    expect(cmds.map((c) => c.type)).toEqual(['addEffect', 'setProperty', 'setKeyframes']);
    const keys = cmds[2] as { type: 'setKeyframes'; prop: { path: string }; keys: Array<{ time: number }> };
    expect(keys.prop.path).toMatch(/^effects\/fx_style_.*\/dashOffset$/);
    expect(keys.keys).toHaveLength(2);
    expect(keys.keys[1]!.time - keys.keys[0]!.time).toBe(DRAW_ON_SECONDS * 705600000);

    const portrait = SUBJECT_STYLES.find((p) => p.id === 'portrait')!;
    const bg = subjectStyleCommands('L', null, portrait);
    expect(bg.map((c) => c.type)).toEqual(['addEffect', 'setProperty']);
    expect((bg[1] as { prop: { path: string } }).prop.path).toMatch(/compositing\/subject$/);
  });

  it('the slider scales the designed look: 50 reproduces it, 100 doubles the stroke', () => {
    const comic = SUBJECT_STYLES.find((p) => p.id === 'comic')!;
    const width = (i: number): number => {
      const w = comic.parts({ intensity: i, color: '#111111' }, ctx)[0]!.params.find((p) => p.path === 'width')!.value as { value: number };
      return w.value;
    };
    expect(width(50)).toBe(8);
    expect(width(100)).toBe(16);
    expect(width(0)).toBe(0);
  });

  it('a colour swatch reaches the effect', () => {
    const neon = SUBJECT_STYLES.find((p) => p.id === 'neon')!;
    const color = neon.parts({ intensity: 50, color: '#ff0000' }, ctx)[0]!.params.find((p) => p.path === 'color')!.value as { value: { r: number; g: number; b: number } };
    expect(color.value).toMatchObject({ r: 1, g: 0, b: 0 });
  });
});

it('lighten mixes towards white', () => {
  expect(lighten('#000000', 0.5)).toBe('#808080');
  expect(lighten('#ff0000', 1)).toBe('#ffffff');
});
