/**
 * Project thumbnails render on the main thread at idle.
 *
 * The worker this replaces could never produce one: it had no `document` to
 * create a canvas with, and an empty scene graph of its own. These tests pin
 * the replacement's contract: the render runs later (not inside the caller's
 * frame), reads the comp at render time, hands over the blob, and a cancelled
 * capture neither renders nor calls back.
 */

const mockRender = jest.fn<Promise<Blob | null>, [unknown]>();
jest.mock('@core/export/exportManager', () => ({
  renderThumbnailBlob: (comp: unknown) => mockRender(comp),
}));

// The active comp comes off the document mirror (B4): its settings, as the
// engine states them (0..1 colour, flicks), turned into the comp record.
let mockComp = { width: 1920, height: 1080, background: '#101014', transparent: false };
const hexColor = (hex: string) => ({
  r: parseInt(hex.slice(1, 3), 16) / 255,
  g: parseInt(hex.slice(3, 5), 16) / 255,
  b: parseInt(hex.slice(5, 7), 16) / 255,
  a: 1,
});
jest.mock('@hooks/useMirror', () => ({ activeCompIdNow: () => 'comp_1' }));
jest.mock('@stores/documentMirror', () => ({
  documentMirror: () => ({
    comp: (id: string) => (id === 'comp_1'
      ? {
        id,
        settings: {
          name: 'Comp 1', width: mockComp.width, height: mockComp.height, pixelAspect: 1,
          frameRate: { num: 30, den: 1 }, duration: 0, startTimecode: 0,
          background: hexColor(mockComp.background), transparent: mockComp.transparent,
          globalLightAngle: 135, globalLightAltitude: 45,
        },
      }
      : undefined),
  }),
}));

import { captureThumbnailWhenIdle } from './thumbnailCapture';

const settle = () => new Promise((r) => setTimeout(r, 10));

beforeEach(() => {
  mockRender.mockReset();
  mockComp = { width: 1920, height: 1080, background: '#101014', transparent: false };
});

describe('captureThumbnailWhenIdle', () => {
  it('renders later, with the comp as it is at render time, and hands over the blob', async () => {
    const blob = new Blob(['jpeg']);
    mockRender.mockResolvedValue(blob);
    const onBlob = jest.fn();
    captureThumbnailWhenIdle(onBlob);
    // Not synchronous: nothing rendered inside the caller's turn.
    expect(mockRender).not.toHaveBeenCalled();
    mockComp = { ...mockComp, width: 1280, height: 720 };
    await settle();
    expect(mockRender).toHaveBeenCalledWith({ width: 1280, height: 720, background: '#101014', transparent: false });
    expect(onBlob).toHaveBeenCalledWith(blob);
  });

  it('a cancelled capture never renders or calls back', async () => {
    mockRender.mockResolvedValue(new Blob(['x']));
    const onBlob = jest.fn();
    const cancel = captureThumbnailWhenIdle(onBlob);
    cancel();
    await settle();
    expect(mockRender).not.toHaveBeenCalled();
    expect(onBlob).not.toHaveBeenCalled();
  });

  it('a failing render reports null instead of throwing', async () => {
    mockRender.mockRejectedValue(new Error('no GPU'));
    const onBlob = jest.fn();
    captureThumbnailWhenIdle(onBlob);
    await settle();
    expect(onBlob).toHaveBeenCalledWith(null);
  });
});
