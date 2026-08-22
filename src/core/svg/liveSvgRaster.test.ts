import { rasterizeSvgAtTime } from './liveSvgRaster';

describe('rasterizeSvgAtTime', () => {
  it('returns a bitmap for a simple animated SVG', async () => {
    const markup = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40">
      <rect width="40" height="40" fill="#2b7eff">
        <animate attributeName="opacity" values="1;0.2;1" dur="1s" repeatCount="indefinite"/>
      </rect>
    </svg>`;
    const bmp = await rasterizeSvgAtTime(markup, 0.25);
    expect(bmp.width).toBeGreaterThan(0);
    expect(bmp.height).toBeGreaterThan(0);
  });
});
