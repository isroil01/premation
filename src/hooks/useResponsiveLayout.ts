import { useEffect, useRef } from 'react';
import { useLayoutStore } from '@stores/layoutStore';

const TABLET_BREAKPOINT = 1024;
const MOBILE_BREAKPOINT = 768;

/**
 * Automatically collapses sidebars when crossing downward thresholds.
 * Avoids aggressively overriding user toggles by only triggering when the 
 * window passes the breakpoint threshold.
 */
export function useResponsiveLayout() {
  const lastWidthRef = useRef(typeof window !== 'undefined' ? window.innerWidth : 1200);

  useEffect(() => {
    const handleResize = () => {
      const currentWidth = window.innerWidth;
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
    const initWidth = window.innerWidth;
    if (initWidth < TABLET_BREAKPOINT) {
      useLayoutStore.getState().setCollapsed('rightInspector', true);
    }
    if (initWidth < MOBILE_BREAKPOINT) {
      useLayoutStore.getState().setCollapsed('leftSidebar', true);
    }
    
    return () => window.removeEventListener('resize', handleResize);
  }, []);
}
