import { PROPERTY_ROW_CONTENT_PX, propertyRowPin } from './headerPin';
import { proxyThumb } from '@layout/StatusBar/ScrollProxyBar';

describe('propertyRowPin', () => {
  it('follows the scroll exactly when the whole row fits', () => {
    expect(propertyRowPin(0, 800)).toBe(0);
    expect(propertyRowPin(178, 800)).toBe(178);
  });

  it('gives way by the shortfall in a narrow column, so the values stay reachable', () => {
    const narrow = PROPERTY_ROW_CONTENT_PX - 100;
    expect(propertyRowPin(50, narrow)).toBe(0);
    expect(propertyRowPin(300, narrow)).toBe(200);
  });
});

describe('proxyThumb', () => {
  it('sizes the thumb to the visible share and travels the whole track', () => {
    expect(proxyThumb(0, 1000, 500, 200)).toEqual({ width: 100, left: 0 });
    expect(proxyThumb(500, 1000, 500, 200)).toEqual({ width: 100, left: 100 });
  });

  it('keeps a grabbable thumb on very long content', () => {
    const { width, left } = proxyThumb(9900, 10000, 100, 200);
    expect(width).toBe(18);
    expect(left).toBe(182);
  });
});
