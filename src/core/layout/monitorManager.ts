/**
 * MonitorManager — Multi-Monitor Detection & Display Management Service.
 * Detects connected monitors in Electron & Web, providing layout adaptation
 * and monitor-aware window positioning.
 */

import { getEventBus } from '@core/events/EventBus';

export interface DisplayInfo {
  id: string;
  label: string;
  bounds: { x: number; y: number; width: number; height: number };
  isPrimary: boolean;
  scaleFactor: number;
}

export class MonitorManager {
  private static instance: MonitorManager;
  private displays: DisplayInfo[] = [];

  constructor() {
    this.initDetection();
  }

  public static getInstance(): MonitorManager {
    if (!MonitorManager.instance) {
      MonitorManager.instance = new MonitorManager();
    }
    return MonitorManager.instance;
  }

  /** The ScreenDetails object we are currently subscribed to (see initDetection). */
  private screenDetails: { addEventListener: (t: string, fn: () => void) => void; removeEventListener: (t: string, fn: () => void) => void } | null = null;
  /** Stable handler reference, so it can actually be removed. */
  private readonly onScreensChange = (): void => {
    void this.initDetection();
  };

  private async initDetection(): Promise<void> {
    if (typeof window === 'undefined') return;

    // Electron Screen IPC
    if (window.motionEditor?.getMonitors) {
      try {
        const monitors = await window.motionEditor.getMonitors();
        this.updateDisplays(monitors);
      } catch { /* noop */ }
    }

    // Web Screen Detailed API if available
    if ('getScreenDetails' in window) {
      try {
        // @ts-ignore
        const details = await window.getScreenDetails();
        const mapped = details.screens.map((s: any, idx: number) => ({
          id: String(idx + 1),
          label: s.label || `Display ${idx + 1}`,
          bounds: { x: s.left, y: s.top, width: s.width, height: s.height },
          isPrimary: s.isPrimary,
          scaleFactor: s.devicePixelRatio || 1,
        }));
        this.updateDisplays(mapped);

        // Bind ONCE per ScreenDetails object.
        //
        // This used to add a fresh anonymous listener on every initDetection(),
        // and the listener itself calls refreshMonitors() → initDetection() → add
        // another. So each real screenschange doubled the listener count
        // (1 → 2 → 4 → 8…), every copy re-running getScreenDetails() and
        // re-emitting MonitorDetected/MonitorRemoved. Plugging a monitor in and
        // out a few times left hundreds of handlers, and nothing ever removed
        // them.
        if (this.screenDetails !== details) {
          this.screenDetails?.removeEventListener('screenschange', this.onScreensChange);
          details.addEventListener('screenschange', this.onScreensChange);
          this.screenDetails = details;
        }
      } catch {
        // Default fallback single monitor
        this.updateDisplays([
          {
            id: '1',
            label: 'Primary Display',
            bounds: { x: 0, y: 0, width: window.screen.width, height: window.screen.height },
            isPrimary: true,
            scaleFactor: window.devicePixelRatio || 1,
          },
        ]);
      }
    } else {
      this.updateDisplays([
        {
          id: '1',
          label: 'Primary Display',
          bounds: { x: 0, y: 0, width: window.screen.width, height: window.screen.height },
          isPrimary: true,
          scaleFactor: window.devicePixelRatio || 1,
        },
      ]);
    }
  }

  private updateDisplays(newDisplays: DisplayInfo[]): void {
    const prevCount = this.displays.length;
    this.displays = newDisplays;

    if (newDisplays.length > prevCount && prevCount > 0) {
      getEventBus().emit('MonitorDetected', { count: newDisplays.length, displays: newDisplays });
    } else if (newDisplays.length < prevCount) {
      getEventBus().emit('MonitorRemoved', { count: newDisplays.length, displays: newDisplays });
    }
  }

  public async refreshMonitors(): Promise<DisplayInfo[]> {
    await this.initDetection();
    return this.displays;
  }

  public getDisplays(): DisplayInfo[] {
    return this.displays;
  }

  public isMultiMonitor(): boolean {
    return this.displays.length > 1;
  }
}

export const getMonitorManager = (): MonitorManager => MonitorManager.getInstance();
