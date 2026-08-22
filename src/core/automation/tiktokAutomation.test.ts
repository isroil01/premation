import { AnimationEngine } from '@motion/animation';
import { applyTemplateInputs } from './applyInputs';
import {
  buildTikTokAutomationDocument,
  TIKTOK_COMP,
  TIKTOK_DEFAULT_ASSETS,
  TIKTOK_FIELDS,
} from './tiktokAutomation.fixture';

describe('TikTok automation scenario', () => {
  const base = buildTikTokAutomationDocument();

  it('matches the vertical TikTok comp settings', () => {
    expect(TIKTOK_COMP.width).toBe(1080);
    expect(TIKTOK_COMP.height).toBe(1920);
    expect(TIKTOK_COMP.fps).toBe(30);
    expect(base.comps?.comp_root?.durationSeconds).toBe(30);
  });

  it('exposes character and backgroundVideo as media inputs', () => {
    expect(TIKTOK_FIELDS.map((f) => f.id).sort()).toEqual(['backgroundVideo', 'character']);
    expect(TIKTOK_FIELDS.every((f) => f.kind === 'media')).toBe(true);
  });

  it('animates position, scale, rotation and opacity with multiple keyframes', () => {
    const tracks = base.animation!.tracks.character!;
    expect(Object.keys(tracks).sort()).toEqual(['opacity', 'rotation', 'scaleX', 'scaleY', 'x', 'y']);
    for (const track of Object.values(tracks)) {
      expect(track.keyframes.length).toBeGreaterThanOrEqual(3);
    }
    expect(tracks.x!.keyframes.some((k) => k.easing === 'bezier' || k.bezier)).toBe(true);
    expect(tracks.y!.keyframes.some((k) => k.easing === 'easeInOut')).toBe(true);
  });

  it('replaces remote assets while preserving every animation track', () => {
    const nextCharacter = 'https://cdn.example.com/new-anime.png';
    const nextBackground = 'https://cdn.example.com/cooking.mp4';
    const { document, applied, errors } = applyTemplateInputs(base, {
      character: nextCharacter,
      backgroundVideo: nextBackground,
    });

    expect(errors).toEqual([]);
    expect(applied.sort()).toEqual(['backgroundVideo', 'character']);
    expect(document.animation).toEqual(base.animation);

    const bg = document.scene.nodes.find((n) => n.id === 'backgroundVideo')!;
    const char = document.scene.nodes.find((n) => n.id === 'character')!;
    expect((bg.components[0]!.props as { src: string }).src).toBe(nextBackground);
    expect((char.components[0]!.props as { src: string }).src).toBe(nextCharacter);

    // Transform keyframe props on the character layer are untouched.
    expect((char.components[0]!.props as { x: number }).x).toBe(540);
    expect((char.components[0]!.props as { rotation: number }).rotation).toBe(0);
  });

  it('still samples the same motion after asset replacement', () => {
    const engineBefore = new AnimationEngine();
    engineBefore.restore(base.animation!);
    const engineAfter = new AnimationEngine();
    const { document } = applyTemplateInputs(base, {
      character: 'https://cdn.example.com/other.png',
      backgroundVideo: 'https://cdn.example.com/other.mp4',
    });
    engineAfter.restore(document.animation!);

    const sampleAt = 5.5;
    const before = engineBefore.evaluateNode('character', sampleAt);
    const after = engineAfter.evaluateNode('character', sampleAt);
    expect(after.get('x')).toBeCloseTo(before.get('x')!, 4);
    expect(after.get('y')).toBeCloseTo(before.get('y')!, 4);
    expect(after.get('rotation')).toBeCloseTo(before.get('rotation')!, 4);
    expect(after.get('scaleX')).toBeCloseTo(before.get('scaleX')!, 4);
    expect(after.get('opacity')).toBeCloseTo(before.get('opacity')!, 4);
  });

  it('uses public default asset URLs suitable for server-side fetch', () => {
    expect(TIKTOK_DEFAULT_ASSETS.character.startsWith('https://')).toBe(true);
    expect(TIKTOK_DEFAULT_ASSETS.backgroundVideo.startsWith('https://')).toBe(true);
  });
});
