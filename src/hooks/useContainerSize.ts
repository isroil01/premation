import { useState, useEffect, type RefObject } from 'react';

/**
 * Hook to measure and observe the dimensions of a container element using ResizeObserver.
 */
export function useContainerSize(ref: RefObject<HTMLElement | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === el) {
          setSize({
            width: entry.contentRect.width,
            height: entry.contentRect.height,
          });
        }
      }
    });

    // Initial measurement
    const rect = el.getBoundingClientRect();
    setSize({ width: rect.width, height: rect.height });

    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);

  return size;
}
