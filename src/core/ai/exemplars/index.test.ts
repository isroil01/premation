import { EXEMPLARS, selectExemplars, buildExemplarBlock } from './index';

describe('exemplar retriever', () => {
  it('ships six exemplars, each compact (under ~1.5k tokens ≈ 6k chars)', () => {
    expect(EXEMPLARS).toHaveLength(6);
    for (const ex of EXEMPLARS) {
      expect(JSON.stringify(ex).length).toBeLessThan(6000);
      expect(ex.transcript.length).toBeGreaterThanOrEqual(5);
    }
  });

  it('matches intent keywords and caps at two', () => {
    const picked = selectExemplars('a product launch promo video for our new phone with pricing cards');
    expect(picked.length).toBeLessThanOrEqual(2);
    expect(picked.map((e) => e.id)).toContain('product_reveal');
  });

  it('returns an empty block when nothing matches', () => {
    expect(buildExemplarBlock('qwerty asdf zxcv')).toBe('');
  });

  it('renders picked exemplars with their lessons into the block', () => {
    const block = buildExemplarBlock('kinetic typography quote about hustle');
    expect(block).toContain('EMULATE');
    expect(block).toContain('Kinetic-typography quote');
  });
});
