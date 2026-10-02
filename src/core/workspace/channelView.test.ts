import { applyChannelView, channelNeedsPass } from './channelView';

function px(...rgba: number[]): Uint8ClampedArray {
  return new Uint8ClampedArray(rgba);
}

describe('channel view', () => {
  it('rgb needs no pass', () => {
    expect(channelNeedsPass('rgb')).toBe(false);
    expect(channelNeedsPass(undefined)).toBe(false);
    for (const c of ['red', 'green', 'blue', 'alpha'] as const) expect(channelNeedsPass(c)).toBe(true);
  });

  it('shows one colour channel as opaque grey', () => {
    const d = px(200, 100, 50, 255);
    applyChannelView(d, 'red');
    expect([...d]).toEqual([200, 200, 200, 255]);
    const g = px(200, 100, 50, 255);
    applyChannelView(g, 'green');
    expect([...g]).toEqual([100, 100, 100, 255]);
    const b = px(200, 100, 50, 255);
    applyChannelView(b, 'blue');
    expect([...b]).toEqual([50, 50, 50, 255]);
  });

  it('a colour channel of a soft pixel composites over black', () => {
    // 50% coverage of full red reads as mid grey, not full white.
    const d = px(255, 0, 0, 128);
    applyChannelView(d, 'red');
    expect(d[0]).toBe(128);
    expect(d[3]).toBe(255);
    // Fully transparent → black, whatever colour the bytes held.
    const t = px(255, 255, 255, 0);
    applyChannelView(t, 'blue');
    expect([...t]).toEqual([0, 0, 0, 255]);
  });

  it('alpha is coverage as brightness, fully opaque', () => {
    const d = px(10, 20, 30, 64, 0, 0, 0, 0, 255, 255, 255, 255);
    applyChannelView(d, 'alpha');
    expect([...d]).toEqual([64, 64, 64, 255, 0, 0, 0, 255, 255, 255, 255, 255]);
  });

  it('rgb leaves the bytes alone', () => {
    const d = px(1, 2, 3, 4);
    applyChannelView(d, 'rgb');
    expect([...d]).toEqual([1, 2, 3, 4]);
  });
});
