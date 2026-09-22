/**
 * The start screen goes away when a project is open — by ANY route.
 *
 * WHY THIS EXISTS. The screen was dismissed only by its own buttons, so Ctrl+O,
 * File ▸ Open and a crash-recovery Restore all loaded their project BEHIND it.
 * None of those routes knows the screen exists, and none should have to: the
 * test drives a real ProjectManager through each of its entry points and never
 * touches the screen.
 */

import { act, renderHook } from '@testing-library/react';
import { ProjectManager, type ProjectDocumentIO } from '@core/project/ProjectManager';
import type { VersionedDocument } from '@core/types';
import { useStartScreenVisible, dismissStartScreen, resetStartScreenDismissal } from './useStartScreenVisible';

const DOC = { version: '1.1.0' } as VersionedDocument;
const io: ProjectDocumentIO = { createEmpty: () => DOC, capture: () => DOC, restore: () => {} };

let pm: ProjectManager;
jest.mock('@core/services/coreServices', () => ({
  getProjectManager: () => pm,
}));

beforeEach(() => {
  resetStartScreenDismissal();
  pm = new ProjectManager({
    service: {} as never,
    files: {} as never,
    recent: { add: () => {} } as never,
    io,
    storage: { save: async () => {}, load: async () => DOC },
  });
});

describe('useStartScreenVisible', () => {
  it('is up while there is no project', () => {
    const { result } = renderHook(() => useStartScreenVisible(true));
    expect(result.current.visible).toBe(true);
  });

  it('never shows in the cloud edition, which has the dashboard for this', () => {
    const { result } = renderHook(() => useStartScreenVisible(false));
    expect(result.current.visible).toBe(false);
  });

  it('goes away when a project is opened from the menu / shortcut (openPath)', async () => {
    const { result } = renderHook(() => useStartScreenVisible(true));
    await act(async () => { await pm.openPath('/x/qa1.motion'); });
    expect(result.current.visible).toBe(false);
  });

  it('goes away when crash recovery restores a project (resume — no ProjectLoaded event)', () => {
    const { result } = renderHook(() => useStartScreenVisible(true));
    act(() => { pm.resume('Recovered', '/x/Recovered.motion'); });
    expect(result.current.visible).toBe(false);
  });

  it('goes away for New Project and for an adopted portable file', () => {
    const a = renderHook(() => useStartScreenVisible(true));
    act(() => { pm.newProject('Untitled'); });
    expect(a.result.current.visible).toBe(false);

    act(() => { pm.close(); });
    act(() => { pm.adopt('Packed', null); });
    expect(a.result.current.visible).toBe(false);
  });

  it('is already down when a project was open before it mounted', () => {
    pm.adopt('Early', null);
    const { result } = renderHook(() => useStartScreenVisible(true));
    expect(result.current.visible).toBe(false);
  });

  it('comes BACK when the project is closed — Close now unloads the scene under it', () => {
    const { result } = renderHook(() => useStartScreenVisible(true));
    act(() => { pm.newProject('Untitled'); });
    act(() => { pm.close(); });
    expect(result.current.visible).toBe(true);
  });

  it('"Continue without a project" holds until the next project has come and gone', () => {
    const { result } = renderHook(() => useStartScreenVisible(true));
    act(() => { result.current.dismiss(); });
    expect(result.current.visible).toBe(false);

    act(() => { pm.newProject('Untitled'); });
    act(() => { pm.close(); });
    expect(result.current.visible).toBe(true);
  });
});

describe('dismissStartScreen — a restore with no project behind it', () => {
  it('hides the screen from outside, as the recovery Restore button needs', () => {
    const { result } = renderHook(() => useStartScreenVisible(true));
    expect(result.current.visible).toBe(true);
    act(() => dismissStartScreen());
    expect(result.current.visible).toBe(false);
  });

  it('holds a dismissal that arrives BEFORE the screen mounts — a cold-launch Restore', () => {
    resetStartScreenDismissal();
    dismissStartScreen(); // the recovery prompt is up before the lazy start screen
    const { result } = renderHook(() => useStartScreenVisible(true));
    expect(result.current.visible).toBe(false);
    resetStartScreenDismissal();
  });
});
