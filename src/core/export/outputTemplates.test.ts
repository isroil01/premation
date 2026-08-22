/**
 * Output-module templates.
 *
 * The scale-not-pixels rule is the one worth defending: a template that froze
 * absolute pixels works until the first different-sized comp, which is the
 * worst kind of working. The rest is registry hygiene — overrides, corrupt
 * storage, built-ins as a floor.
 */

import {
  BUILTIN_OUTPUT_TEMPLATES,
  listOutputTemplates,
  saveOutputTemplate,
  deleteOutputTemplate,
  isBuiltinOutputTemplate,
  applyOutputTemplate,
  type OutputTemplate,
} from './outputTemplates';

const tpl = (patch: Partial<OutputTemplate> = {}): OutputTemplate => ({
  name: 'My Template',
  format: 'webm',
  quality: 'high',
  transparent: false,
  scale: 1,
  fps: 'comp',
  ...patch,
});

beforeEach(() => localStorage.clear());

describe('the registry', () => {
  it('lists the built-ins with empty storage', () => {
    expect(listOutputTemplates()).toEqual([...BUILTIN_OUTPUT_TEMPLATES]);
  });

  it('a saved template appears alongside the built-ins', () => {
    saveOutputTemplate(tpl());
    const names = listOutputTemplates().map((t) => t.name);
    expect(names).toContain('My Template');
    expect(names).toContain('Full Res WebM');
  });

  it('a user template OVERRIDES a built-in of the same name', () => {
    saveOutputTemplate(tpl({ name: 'Full Res WebM', quality: 'draft' }));
    const matches = listOutputTemplates().filter((t) => t.name === 'Full Res WebM');
    expect(matches).toHaveLength(1);
    expect(matches[0]!.quality).toBe('draft');
  });

  it('deleting an override RESTORES the built-in rather than leaving a hole', () => {
    saveOutputTemplate(tpl({ name: 'Full Res WebM', quality: 'draft' }));
    deleteOutputTemplate('Full Res WebM');
    const restored = listOutputTemplates().find((t) => t.name === 'Full Res WebM')!;
    expect(restored.quality).toBe('high');
    expect(isBuiltinOutputTemplate('Full Res WebM')).toBe(true);
  });

  it('re-saving a name replaces rather than duplicates', () => {
    saveOutputTemplate(tpl({ scale: 1 }));
    saveOutputTemplate(tpl({ scale: 0.5 }));
    const matches = listOutputTemplates().filter((t) => t.name === 'My Template');
    expect(matches).toHaveLength(1);
    expect(matches[0]!.scale).toBe(0.5);
  });

  it('survives unreadable storage, degrading to the built-ins', () => {
    localStorage.setItem('motion-editor.outputTemplates.v1', 'not json');
    expect(listOutputTemplates()).toEqual([...BUILTIN_OUTPUT_TEMPLATES]);
  });

  it('drops a corrupt ENTRY without losing the rest', () => {
    localStorage.setItem(
      'motion-editor.outputTemplates.v1',
      JSON.stringify([tpl({ name: 'Good' }), { name: 'Bad', scale: 'huge' }]),
    );
    const names = listOutputTemplates().map((t) => t.name);
    expect(names).toContain('Good');
    expect(names).not.toContain('Bad');
  });

  it('refuses to save junk', () => {
    expect(saveOutputTemplate({ ...tpl(), scale: 0 })).toBe(false);
    expect(saveOutputTemplate({ ...tpl(), name: '' })).toBe(false);
    expect(saveOutputTemplate({ ...tpl(), fps: -30 } as never)).toBe(false);
    expect(listOutputTemplates()).toEqual([...BUILTIN_OUTPUT_TEMPLATES]);
  });
});

describe('applying a template to a comp', () => {
  const COMP_4K = { width: 3840, height: 2160, fps: 30 };
  const COMP_HD = { width: 1920, height: 1080, fps: 24 };

  it('scale is RELATIVE — half res of a 4K comp is 1920, of an HD comp is 960', () => {
    const half = tpl({ scale: 0.5 });
    expect(applyOutputTemplate(half, COMP_4K).width).toBe(1920);
    expect(applyOutputTemplate(half, COMP_HD).width).toBe(960);
  });

  it("fps 'comp' follows the composition; a number overrides it", () => {
    expect(applyOutputTemplate(tpl({ fps: 'comp' }), COMP_HD).fps).toBe(24);
    expect(applyOutputTemplate(tpl({ fps: 15 }), COMP_HD).fps).toBe(15);
  });

  it('rounds output sizes to EVEN numbers, which encoders require', () => {
    // 1919 × 1079 comp at half scale would mint 959.5 × 539.5; H.264 rejects
    // odd dimensions outright.
    const out = applyOutputTemplate(tpl({ scale: 0.5 }), { width: 1919, height: 1079, fps: 30 });
    expect(out.width % 2).toBe(0);
    expect(out.height % 2).toBe(0);
  });

  it('never collapses below 2×2 whatever the scale', () => {
    const out = applyOutputTemplate(tpl({ scale: 0.001 }), { width: 100, height: 100, fps: 30 });
    expect(out.width).toBeGreaterThanOrEqual(2);
    expect(out.height).toBeGreaterThanOrEqual(2);
  });

  it('carries format, quality and transparency through untouched', () => {
    const out = applyOutputTemplate(
      tpl({ format: 'png-sequence', quality: 'draft', transparent: true }),
      COMP_HD,
    );
    expect(out).toMatchObject({ format: 'png-sequence', quality: 'draft', transparent: true });
  });
});
