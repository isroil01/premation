/**
 * useResizeObserver — measure a DOM element. Returns a ref + size.
 * The callback fires on every size change (debounced to rAF by the browser).
 */

import { useEffect, useRef, useState, type RefObject } from 'react';

export interface Size {
  width: number;
  height: number;
}

export function useResizeObserver<T extends HTMLElement>(): {
  ref: RefObject<T>;
  size: Size;
} {
  const ref = useRef<T>(null);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const e = entries[0];
      if (!e) return;
      const cr = e.contentRect;
      setSize({ width: cr.width, height: cr.height });
    });
    ro.observe(el);
    // Initial measurement
    setSize({ width: el.offsetWidth, height: el.offsetHeight });
    return () => ro.disconnect();
  }, []);

  return { ref, size };
}
