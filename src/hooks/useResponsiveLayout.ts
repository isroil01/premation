import { useEffect, useRef } from 'react';
import { useLayoutStore } from '@stores/layoutStore';
import { usePreferenceStore } from '@stores/preferenceStore';

const TABLET_BREAKPOINT = 1024;
const MOBILE_BREAKPOINT = 768;

/**
 * The width the layout actually has to work with. UI Scale zooms the chrome via
 * CSS `zoom`, which leaves `window.innerWidth` unchanged even though the painted
 * chrome is now `innerWidth / uiScale` CSS px wide. Dividing here lets the
 * breakpoints react to scale (scaling up = effectively narrower = collapse),
 * which is what keeps toolbar buttons from overflowing off-screen.
 */
function effectiveWidth(): number {
  const scale = usePreferenceStore.getState().uiScale || 1;
  return window.innerWidth / scale;
}

/**
 * Automatically collapses sidebars when crossing downward thresholds.
 * Avoids aggressively overriding user toggles by only triggering when the
 * window passes the breakpoint threshold.
 */
export function useResponsiveLayout() {
  const lastWidthRef = useRef(typeof window !== 'undefined' ? effectiveWidth() : 1200);

  useEffect(() => {
    const handleResize = () => {
      const currentWidth = effectiveWidth();
      const lastWidth = lastWidthRef.current;

      const setCollapsed = useLayoutStore.getState().setCollapsed;
      
      // Crossing below Tablet Breakpoint
      if (lastWidth >= TABLET_BREAKPOINT && currentWidth < TABLET_BREAKPOINT) {
        setCollapsed('rightInspector', true);
      }
      
      // Crossing below Mobile Breakpoint
      if (lastWidth >= MOBILE_BREAKPOINT && currentWidth < MOBILE_BREAKPOINT) {
        setCollapsed('leftSidebar', true);
        setCollapsed('rightInspector', true);
      }
      
      lastWidthRef.current = currentWidth;
    };

    window.addEventListener('resize', handleResize);
    
    // Initial check (only runs once on mount)
    const initWidth = effectiveWidth();
    if (initWidth < TABLET_BREAKPOINT) {
      useLayoutStore.getState().setCollapsed('rightInspector', true);
    }
    if (initWidth < MOBILE_BREAKPOINT) {
      useLayoutStore.getState().setCollapsed('leftSidebar', true);
    }
    
    return () => window.removeEventListener('resize', handleResize);
  }, []);
}
