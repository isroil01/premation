/**
 * Project thumbnails are the engine's frame of the active composition, asked
 * for at idle. These tests pin the contract: the query runs later (not inside
 * the caller's frame), targets the comp active at that time, hands over the
 * image, and a cancelled capture neither asks nor calls back.
 */

const mockQuery = jest.fn();
jest.mock('@core/engine/engineInstance', () => ({ engine: () => ({ query: (q: unknown) => mockQuery(q) }) }));
let mockCompId: string | undefined = 'comp_1';
jest.mock('@hooks/useMirror', () => ({ activeCompIdNow: () => mockCompId }));

import { captureThumbnailWhenIdle } from './thumbnailCapture';

const settle = () => new Promise((r) => setTimeout(r, 10));
const thumb = { ok: true, value: { width: 480, height: 270, format: 'jpeg', data: new Uint8Array([1, 2, 3]) } };

beforeEach(() => {
  mockQuery.mockReset();
  mockCompId = 'comp_1';
});

describe('captureThumbnailWhenIdle', () => {
  it('asks later, for the comp active at that time, and hands over the image', async () => {
    mockQuery.mockResolvedValue(thumb);
    const onBlob = jest.fn();
    captureThumbnailWhenIdle(onBlob);
    expect(mockQuery).not.toHaveBeenCalled();
    mockCompId = 'comp_2';
    await settle();
    expect(mockQuery).toHaveBeenCalledWith({ type: 'getThumbnail', item: 'comp_2', time: 0, maxSize: 480 });
    const blob = onBlob.mock.calls[0]![0] as Blob;
    expect(blob.type).toBe('image/jpeg');
    expect(blob.size).toBe(3);
  });

  it('a cancelled capture never asks or calls back', async () => {
    mockQuery.mockResolvedValue(thumb);
    const onBlob = jest.fn();
    const cancel = captureThumbnailWhenIdle(onBlob);
    cancel();
    await settle();
    expect(mockQuery).not.toHaveBeenCalled();
    expect(onBlob).not.toHaveBeenCalled();
  });

  it('a failing query reports null instead of throwing', async () => {
    mockQuery.mockRejectedValue(new Error('engine gone'));
    const onBlob = jest.fn();
    captureThumbnailWhenIdle(onBlob);
    await settle();
    expect(onBlob).toHaveBeenCalledWith(null);
  });
});
