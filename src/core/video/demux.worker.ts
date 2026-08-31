/**
 * The demux worker.
 *
 * `mp4Demuxer` and `webmDemuxer` are pure JavaScript over an ArrayBuffer — no
 * DOM, no WebCodecs, nothing that needs a window — so they run here unchanged.
 * That is the whole reason this is the first thing to move off the main thread:
 * the contract does not have to change, only where it executes.
 *
 * The cost being moved is real and it is not a decode. mp4box parses the sample
 * table synchronously off `appendBuffer`/`flush`; a 300 MB file is a noticeable
 * beat of frozen UI, arriving at exactly the moment the user dropped footage in
 * and is watching for something to happen.
 */

import { demuxMp4 } from './mp4Demuxer';
import { demuxWebm, isWebmMagic } from './webmDemuxer';
import { toWire } from './demuxWire';

interface Request {
  id: number;
  bytes: ArrayBuffer;
}

self.onmessage = (e: MessageEvent<Request>): void => {
  const { id, bytes } = e.data;
  void (async () => {
    try {
      const head = new Uint8Array(bytes, 0, Math.min(4, bytes.byteLength));
      // The same magic check the callers used to do for themselves, moved here
      // so the client hands over bytes and gets a result rather than having to
      // know which container it holds.
      const demuxed = isWebmMagic(head) ? await demuxWebm(bytes) : await demuxMp4(bytes);
      const wire = toWire(demuxed);
      // Transfer the packed samples: they are the file, and cloning them would
      // reintroduce on the main thread the copy this worker exists to avoid.
      (self as unknown as { postMessage: (m: unknown, t: Transferable[]) => void })
        .postMessage({ id, ok: true, wire }, [wire.bytes]);
    } catch (err) {
      self.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  })();
};
