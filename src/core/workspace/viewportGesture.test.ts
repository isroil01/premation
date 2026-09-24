/**
 * The pointer-gesture contract: the drag flag is up for the whole gesture
 * (nested or not), an empty gesture records and announces nothing, and stray
 * ends are harmless. The engine side — ONE engine gesture per drag — is pinned
 * by the tools' own tests (ToolTransaction / sendToolEdit).
 */

import {
  beginViewportGesture,
  endViewportGesture,
  viewportGestureActive,
} from './viewportGesture';
import { CommandSystem, setCommandSystem, getCommandSystem } from '@core/commands/CommandSystem';
import { getEventBus } from '@core/events/EventBus';
import { useUIStore } from '@stores/uiStore';

describe('viewportGesture', () => {
  beforeEach(() => {
    setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
    // A dangling gesture from a failed test must not leak into the next.
    endViewportGesture();
  });

  it('raises the UI drag flag for the whole gesture, nested or not', () => {
    // The render loop reads this flag (via renderQualityStore.interacting) to
    // stop serving the RAM preview mid-drag. The 3D gizmo and the device
    // handles never set it themselves, so the cached pre-drag frame was
    // blitted over their live renders.
    expect(useUIStore.getState().isDragging).toBe(false);
    beginViewportGesture();
    expect(useUIStore.getState().isDragging).toBe(true);
    beginViewportGesture(); // a stray second pointer
    endViewportGesture();
    expect(useUIStore.getState().isDragging).toBe(true);
    endViewportGesture();
    expect(useUIStore.getState().isDragging).toBe(false);
  });

  it('a gesture with no writes records nothing and announces nothing', () => {
    let structural = 0;
    const sub = getEventBus().on('SceneGraphChanged', () => { structural++; });
    beginViewportGesture();
    endViewportGesture();
    expect(structural).toBe(0);
    expect(getCommandSystem().getHistory().peek()).toBeFalsy();
    sub.dispose();
  });

  it('unbalanced end calls are harmless', () => {
    endViewportGesture();
    endViewportGesture();
    expect(viewportGestureActive()).toBe(false);
  });
});
