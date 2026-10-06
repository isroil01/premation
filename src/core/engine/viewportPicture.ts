/**
 * A readable, full-resolution copy of the frame the engine viewport shows —
 * for page chrome that needs the viewport's PIXELS under the pointer (the
 * tracker's loupe, the Clone Source Overlay).
 *
 * The engine's frame reaches the page as a VideoFrame that `EngineSurface`
 * blits and releases, and the page's own content canvas under it is blank, so
 * there is nothing to read after the fact. This keeps a 2D copy instead — but
 * only while a consumer HOLDS it: with no holder `EngineSurface` skips the
 * copy on a counter check, so playback pays nothing for a lens nobody has open.
 *
 * `frameTap` is the other copy and is not this one: it is rate-limited and
 * downsampled to 320 px for the scopes, which is no use at 4× magnification.
 *
 * The copy is laid out like the viewport (the comp under the page's camera,
 * pasteboard around it), `width × height` in the frame's own pixels; scale by
 * `width / <viewport CSS width>` to address it in CSS pixels.
 */

let holders = 0;
let picture: HTMLCanvasElement | null = null;
let pictureCtx: CanvasRenderingContext2D | null = null;
let refresh: (() => void) | null = null;

/**
 * Keep the copy up to date until the returned release is called. The first
 * holder asks the surface for a fresh frame, since a still viewport draws
 * nothing on its own.
 */
export function holdViewportPicture(): () => void {
  holders += 1;
  if (holders === 1) refresh?.();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders -= 1;
    if (holders === 0) {
      // A viewport-sized canvas nobody can ask for any more.
      picture = null;
      pictureCtx = null;
    }
  };
}

/** Whether anything holds the copy. The surface's gate, checked per drawn frame. */
export function viewportPictureWanted(): boolean {
  return holders > 0;
}

/** The latest copy, or null when nothing holds it or no frame has arrived yet. */
export function viewportPicture(): HTMLCanvasElement | null {
  return holders > 0 ? picture : null;
}

/**
 * Called by `EngineSurface` with the frame it is about to blit, while held.
 * Never throws: it sits on the viewport's draw path.
 */
export function captureViewportPicture(frame: VideoFrame): void {
  if (holders === 0) return;
  const w = frame.displayWidth;
  const h = frame.displayHeight;
  if (w < 1 || h < 1) return;
  try {
    if (!picture) {
      picture = document.createElement('canvas');
      pictureCtx = picture.getContext('2d');
    }
    if (!pictureCtx) return;
    if (picture.width !== w || picture.height !== h) {
      picture.width = w;
      picture.height = h;
    }
    pictureCtx.drawImage(frame, 0, 0, w, h);
  } catch {
    // A closed frame or a lost context: the consumer keeps the previous copy.
  }
}

/**
 * Ask the engine to deliver the frame on screen once more — for a consumer
 * that reads the NEXT drawn frame (a snapshot, a difference compare) while the
 * viewport is still and would otherwise draw nothing.
 */
export function refreshViewportPicture(): void {
  refresh?.();
}

/** `EngineSurface` installs how to ask the engine for the current frame again; null on unmount. */
export function setViewportPictureRefresh(fn: (() => void) | null): void {
  refresh = fn;
  if (fn && holders > 0) fn();
}

/** Test seam. */
export function resetViewportPicture(): void {
  holders = 0;
  picture = null;
  pictureCtx = null;
  refresh = null;
}
