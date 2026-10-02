/**
 * Channel view — Red / Green / Blue / Alpha as an opaque greyscale picture.
 *
 * The viewport's channel picker used to be a CSS `feColorMatrix` filter on
 * the WebGL content canvas. Two things made it read as "does nothing":
 *
 *   • the RAM-preview blit layer sits ABOVE that canvas and carried no
 *     filter, so after any cached frame (most of the time) the picture was
 *     the unfiltered one;
 *   • a CSS filter over a WebGL canvas whose drawing buffer is not preserved
 *     sees an empty buffer in Chromium, so even the live frame went black.
 *
 * This is the replacement: a pixel pass over the frame that is actually on
 * screen, applied on the 2D blit layer where the bytes are readable. Pure and
 * in place, so the tests can pin every channel without a DOM.
 *
 * Alpha is shown the way every compositor shows a matte: coverage as
 * brightness, fully opaque. The comp is rendered WITHOUT its background plate
 * for that view (see `useWorkspace.renderFrameAt`), otherwise every pixel is
 * covered and the matte is a white card.
 */

export type ViewChannel = 'rgb' | 'red' | 'green' | 'blue' | 'alpha';

/** True when the picture needs a pass at all. */
export function channelNeedsPass(channel: ViewChannel | undefined): channel is Exclude<ViewChannel, 'rgb'> {
  return channel === 'red' || channel === 'green' || channel === 'blue' || channel === 'alpha';
}

/**
 * Rewrite RGBA bytes in place so the chosen channel is shown as opaque grey.
 *
 * Input pixels are STRAIGHT (un-premultiplied) alpha, as `getImageData`
 * returns them. For the colour channels a partially transparent pixel is
 * composited over black first — the same thing the screen would have shown
 * over a dark stage — so a soft edge fades to black instead of flashing to
 * the colour's full value at 1% coverage.
 */
export function applyChannelView(data: Uint8ClampedArray, channel: ViewChannel): void {
  if (!channelNeedsPass(channel)) return;
  const n = data.length;
  if (channel === 'alpha') {
    for (let i = 0; i < n; i += 4) {
      const a = data[i + 3]!;
      data[i] = a;
      data[i + 1] = a;
      data[i + 2] = a;
      data[i + 3] = 255;
    }
    return;
  }
  const c = channel === 'red' ? 0 : channel === 'green' ? 1 : 2;
  for (let i = 0; i < n; i += 4) {
    const a = data[i + 3]!;
    // Round-to-nearest of (v * a / 255): the +127 keeps a fully opaque pixel
    // byte-identical to its source.
    const v = a === 255 ? data[i + c]! : ((data[i + c]! * a + 127) / 255) | 0;
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
    data[i + 3] = 255;
  }
}

/**
 * Apply the view to a whole 2D canvas in place. Returns false when the canvas
 * has no readable context (the caller then leaves the picture as it is rather
 * than hiding it).
 */
export function applyChannelViewToCanvas(canvas: HTMLCanvasElement, channel: ViewChannel): boolean {
  if (!channelNeedsPass(channel)) return true;
  const ctx = canvas.getContext('2d');
  if (!ctx || canvas.width === 0 || canvas.height === 0) return false;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  applyChannelView(img.data, channel);
  ctx.putImageData(img, 0, 0);
  return true;
}
