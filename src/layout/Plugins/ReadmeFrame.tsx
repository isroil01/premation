/**
 * The frame a publisher's README renders inside.
 *
 * The document is built by `readmeDocument.ts`, which is where the reasoning for
 * framing it at all lives. This half is the element and the one thing an
 * isolated frame cannot work out for itself: how tall it should be.
 *
 * Height arrives by `postMessage` from a script pinned by hash in the frame's
 * own CSP, so the listener has to be careful about two things:
 *
 *   • **Which window sent it.** Anything can `postMessage` to this one. The
 *     source is checked against this iframe's `contentWindow`; the origin is
 *     not, because a frame with no `allow-same-origin` reports `"null"` and
 *     that is not a check.
 *   • **What it contains.** A finite number, clamped. An unbounded height from
 *     a hostile frame is a panel the user cannot scroll past.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { buildReadmeDocument, README_HEIGHT_MESSAGE } from './readmeDocument';

/** Below this the frame reads as broken; above it, a README owns the panel. */
const MIN_HEIGHT = 60;
const MAX_HEIGHT = 3000;

export function ReadmeFrame({ html }: { html: string }): React.ReactElement {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(MIN_HEIGHT);
  // Rebuilt only when the README changes — the document string carries the
  // theme, and re-creating it on every render would reload the frame.
  const doc = useMemo(() => buildReadmeDocument(html), [html]);

  useEffect(() => {
    function onMessage(event: MessageEvent): void {
      if (!ref.current || event.source !== ref.current.contentWindow) return;
      const raw = (event.data as Record<string, unknown> | null)?.[README_HEIGHT_MESSAGE];
      if (typeof raw !== 'number' || !Number.isFinite(raw)) return;
      setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(raw))));
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  return (
    <iframe
      ref={ref}
      /*
        `allow-scripts` and nothing else. No `allow-same-origin`, so the
        document sits in an opaque origin with no reach into this one, its
        storage or the preload bridge; no `allow-popups`, `allow-forms` or
        `allow-top-navigation`, so it cannot reach outward either. The only
        script it may run is the height reporter, pinned by hash in its CSP.
      */
      sandbox="allow-scripts"
      srcDoc={doc}
      title="About this plugin"
      referrerPolicy="no-referrer"
      scrolling="no"
      style={{ width: '100%', border: 0, display: 'block', height }}
    />
  );
}

export default ReadmeFrame;
