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

        details.addEventListener('screenschange', () => {
          this.refreshMonitors();
        });
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
