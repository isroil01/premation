/**
 * AILayoutAPI — AI Natural Language Layout Control Engine.
 * Exposes layout manipulation APIs for AI subagents and assistant intent handlers.
 */

import { useLayoutStore, type RegionId } from '@stores/layoutStore';
import { getWorkspaceManager } from '@core/layout/workspaceManager';

export interface AILayoutCommandResult {
  success: boolean;
  message: string;
}

export class AILayoutAPI {
  private static instance: AILayoutAPI;

  public static getInstance(): AILayoutAPI {
    if (!AILayoutAPI.instance) {
      AILayoutAPI.instance = new AILayoutAPI();
    }
    return AILayoutAPI.instance;
  }

  public setWorkspace(workspaceNameOrId: string): AILayoutCommandResult {
    const mgr = getWorkspaceManager();
    const ok = mgr.applyWorkspace(workspaceNameOrId);
    if (ok) {
      return { success: true, message: `Applied workspace layout: "${workspaceNameOrId}"` };
    }
    return { success: false, message: `Workspace layout "${workspaceNameOrId}" not found.` };
  }

  public floatPanel(panelId: string, bounds?: { x: number; y: number; width: number; height: number }): AILayoutCommandResult {
    const store = useLayoutStore.getState();
    if (!store.panels[panelId]) {
      return { success: false, message: `Panel "${panelId}" is not registered.` };
    }
    store.floatPanel(panelId, bounds);
    return { success: true, message: `Panel "${panelId}" is now floating.` };
  }

  public dockPanel(panelId: string, region?: RegionId): AILayoutCommandResult {
    const store = useLayoutStore.getState();
    if (!store.panels[panelId]) {
      return { success: false, message: `Panel "${panelId}" is not registered.` };
    }
    store.dockPanel(panelId, region);
    return { success: true, message: `Panel "${panelId}" docked to ${region ?? 'home region'}.` };
  }

  public popoutPanel(panelId: string, monitorId?: string): AILayoutCommandResult {
    const store = useLayoutStore.getState();
    if (!store.panels[panelId]) {
      return { success: false, message: `Panel "${panelId}" is not registered.` };
    }
    store.popoutPanel(panelId, monitorId);
    return { success: true, message: `Panel "${panelId}" popped out into external window.` };
  }

  public lockWorkspace(locked: boolean): AILayoutCommandResult {
    useLayoutStore.getState().setWorkspaceLocked(locked);
    return { success: true, message: `Workspace is now ${locked ? 'locked' : 'unlocked'}.` };
  }

  public arrangeForTask(task: 'motion-design' | 'animation' | 'ai-chat' | 'color' | 'presentation'): AILayoutCommandResult {
    const map: Record<string, string> = {
      'motion-design': 'motion-design',
      'animation': 'animation',
      'ai-chat': 'ai-focus',
      'color': 'color-grading',
      'presentation': 'presentation',
    };
    const targetId = map[task] ?? 'default';
    return this.setWorkspace(targetId);
  }
}

export const getAILayoutAPI = (): AILayoutAPI => AILayoutAPI.getInstance();
