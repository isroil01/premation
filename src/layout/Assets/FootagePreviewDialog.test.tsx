/**
 * The footage viewer's exact-mode wiring — the reachability half. The decode
 * discipline itself is pinned in @core/video; what a jsdom test can and must
 * prove about the DIALOG is the honesty of the offer: "Frame by frame"
 * appears exactly when the platform has WebCodecs, and a source that cannot
 * be read degrades to the player with a note instead of a dead canvas.
 */

import { render, screen, fireEvent, act } from '@testing-library/react';
import { openFootagePreview } from './FootagePreviewDialog';
import { useModalStore, closeAllModals } from '@stores/modalStore';
import type { ImportedAsset } from '@stores/assetStore';

const asset = (patch: Partial<ImportedAsset> = {}): ImportedAsset => ({
  id: 'a1',
  name: 'clip.mp4',
  type: 'video',
  src: 'blob:nowhere/clip',
  size: 1234,
  metadata: { width: 64, height: 48, duration: 0.8, fps: 30 },
  ...patch,
});

/** openFootagePreview stores a render function in the modal store; mount it
 *  the way ModalHost would. */
function mountPreview(a: ImportedAsset): ReturnType<typeof render> {
  openFootagePreview(a);
  const req = useModalStore.getState().stack.find((m) => m.id === 'footage-preview');
  if (!req) throw new Error('preview modal was not opened');
  return render(<>{req.render(() => closeAllModals())}</>);
}

// The DOM lib types VideoDecoder/EncodedVideoChunk on globalThis (they just
// don't EXIST in jsdom), so the fakes go through an index-signature view.
const g = globalThis as unknown as Record<string, unknown>;
const installFakeCodecs = (): void => {
  g['VideoDecoder'] = function VideoDecoder(): void { /* capability probe only */ };
  g['EncodedVideoChunk'] = function EncodedVideoChunk(): void { /* capability probe only */ };
};

afterEach(() => {
  closeAllModals();
  delete g['VideoDecoder'];
  delete g['EncodedVideoChunk'];
});

describe('FootagePreviewDialog exact mode', () => {
  it('does NOT offer Frame by frame where WebCodecs is missing (jsdom)', () => {
    mountPreview(asset());
    expect(screen.queryByText('Frame by frame')).toBeNull();
    // The player itself is still there.
    expect(document.querySelector('video')).not.toBeNull();
  });

  it('offers Frame by frame when the platform has WebCodecs', () => {
    installFakeCodecs();
    mountPreview(asset());
    expect(screen.getByText('Frame by frame')).toBeInTheDocument();
  });

  it('never offers it for stills or audio', () => {
    installFakeCodecs();
    mountPreview(asset({ type: 'audio', name: 'a.mp3' }));
    expect(screen.queryByText('Frame by frame')).toBeNull();
  });

  it('an unreadable source degrades to the player with a note, not a dead canvas', async () => {
    installFakeCodecs();
    mountPreview(asset());
    // jsdom cannot fetch a blob: URL — exactly the failure a moved source
    // file produces in production.
    await act(async () => {
      fireEvent.click(screen.getByText('Frame by frame'));
      await Promise.resolve();
    });
    expect(await screen.findByText(/Frame-by-frame unavailable/)).toBeInTheDocument();
    // Still in player mode: the transport row's readout never appeared.
    expect(screen.queryByText(/frame \d+ \/ \d+/)).toBeNull();
  });
});
