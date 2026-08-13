/**
 * Scene must survive a tab open/close cycle.
 *
 * This is the single highest-risk behaviour in the tab system, and it fails
 * SILENTLY in a way that looks like something else: open a plugin page, come
 * back, and the viewport has reset its transform and re-acquired a GPU context.
 * The user reads that as "the editor lost my view", nobody connects it to tabs,
 * and the obvious implementation — `{active === 'scene' && <Scene/>}` — is
 * exactly what causes it.
 *
 * So the assertion here is on IDENTITY, not on appearance. A Scene that
 * unmounted and remounted looks identical in the DOM and is a different object
 * with a different WebGL context; asserting "the canvas is present" would pass
 * for the broken implementation. Asserting that the very same object instance
 * is still there cannot.
 */

import { useRef } from 'react';
import { render, screen, act } from '@testing-library/react';
import { EditorTabs } from './EditorTabs';
import { SCENE_TAB_ID, useEditorTabStore, TAB_PERSIST_KEY } from '@stores/editorTabStore';

/**
 * A stand-in for the viewport that records its own lifecycle.
 *
 * `context` stands for the GPU context: created once per mount, and a NEW
 * object if the component is ever remounted. Comparing it across a tab cycle
 * is the whole test.
 */
let mountCount = 0;
let liveContext: object | null = null;

function FakeScene(): JSX.Element {
  // The context is held in a REF, not in module scope. That distinction is the
  // difference between a test that works and one that cannot fail: module
  // state survives an unmount, so a remounted Scene would find the old object
  // still there and the identity check would pass for the broken
  // implementation it exists to catch. A ref is per-instance, so a remount
  // genuinely produces a new one.
  const ref = useRef<object | null>(null);
  if (ref.current === null) {
    mountCount += 1;
    ref.current = { id: mountCount };
    liveContext = ref.current;
  }
  return <canvas data-testid="fake-canvas" />;
}

function resetScene(): void {
  mountCount = 0;
  liveContext = null;
}

const openTab = (id: string, title: string): void => {
  act(() => {
    useEditorTabStore.getState().open({ id, kind: 'plugin', title, ref: id.replace('plugin:', '') });
  });
};

beforeEach(() => {
  localStorage.clear();
  resetScene();
  act(() => { useEditorTabStore.setState({ tabs: [], activeId: SCENE_TAB_ID }); });
});

describe('Scene is permanent', () => {
  it('stays mounted when a plugin tab is opened', () => {
    render(<EditorTabs scene={<FakeScene />} renderTab={() => <div>plugin body</div>} />);
    const before = liveContext;

    openTab('plugin:com.acme.thing', 'Thing');

    // The tab body is showing…
    expect(screen.getByTestId('tab-pane')).toBeTruthy();
    // …and Scene is still in the tree, with the SAME context object.
    expect(screen.getByTestId('fake-canvas')).toBeTruthy();
    expect(liveContext).toBe(before);
    expect(mountCount).toBe(1);
  });

  it('survives an open/close cycle with its context intact', () => {
    render(<EditorTabs scene={<FakeScene />} renderTab={() => <div>plugin body</div>} />);
    const before = liveContext;

    openTab('plugin:com.acme.thing', 'Thing');
    act(() => { useEditorTabStore.getState().close('plugin:com.acme.thing'); });

    // Identity, not appearance. A remounted Scene would look identical here
    // and be a different object with a different GPU context.
    expect(liveContext).toBe(before);
    expect(mountCount).toBe(1);
    expect(useEditorTabStore.getState().activeId).toBe(SCENE_TAB_ID);
  });

  it('hides Scene without removing it from the tree', () => {
    render(<EditorTabs scene={<FakeScene />} renderTab={() => <div>plugin body</div>} />);
    openTab('plugin:com.acme.thing', 'Thing');

    const pane = screen.getByTestId('scene-pane');
    // `aria-hidden` and a class, never a conditional render — and never
    // `display: none`, which collapses the box and resizes the canvas to zero.
    expect(pane.getAttribute('aria-hidden')).toBe('true');
    expect(pane.querySelector('canvas')).toBeTruthy();
  });

  it('gives Scene a tab that has no close control', () => {
    render(<EditorTabs scene={<FakeScene />} renderTab={() => <div>x</div>} />);
    expect(screen.queryByLabelText('Close Scene')).toBeNull();
  });

  it('Ctrl/Cmd+W never closes Scene', () => {
    render(<EditorTabs scene={<FakeScene />} renderTab={() => <div>x</div>} />);
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true }));
    });
    // Nothing to close, and — critically — nothing thrown and no fall-through
    // to a window-closing default.
    expect(useEditorTabStore.getState().activeId).toBe(SCENE_TAB_ID);
    expect(mountCount).toBe(1);
  });

  it('Ctrl/Cmd+W closes the active plugin tab', () => {
    render(<EditorTabs scene={<FakeScene />} renderTab={() => <div>x</div>} />);
    openTab('plugin:com.acme.thing', 'Thing');
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', metaKey: true }));
    });
    expect(useEditorTabStore.getState().tabs).toEqual([]);
    expect(useEditorTabStore.getState().activeId).toBe(SCENE_TAB_ID);
  });
});

describe('preview tabs', () => {
  it('reuses one slot while browsing', () => {
    // Without this, clicking through twenty plugins leaves twenty tabs and the
    // strip stops being usable at about six.
    act(() => {
      useEditorTabStore.getState().open({ id: 'plugin:a.one', kind: 'plugin', title: 'One', ref: 'a.one' }, { preview: true });
      useEditorTabStore.getState().open({ id: 'plugin:a.two', kind: 'plugin', title: 'Two', ref: 'a.two' }, { preview: true });
    });
    const { tabs, activeId } = useEditorTabStore.getState();
    expect(tabs.map((t) => t.id)).toEqual(['plugin:a.two']);
    expect(activeId).toBe('plugin:a.two');
  });

  it('keeps a pinned tab when the next preview opens', () => {
    act(() => {
      useEditorTabStore.getState().open({ id: 'plugin:a.one', kind: 'plugin', title: 'One', ref: 'a.one' });
      useEditorTabStore.getState().open({ id: 'plugin:a.two', kind: 'plugin', title: 'Two', ref: 'a.two' }, { preview: true });
    });
    expect(useEditorTabStore.getState().tabs.map((t) => t.id))
      .toEqual(['plugin:a.one', 'plugin:a.two']);
  });

  it('pins a preview tab on demand', () => {
    act(() => {
      useEditorTabStore.getState().open({ id: 'plugin:a.one', kind: 'plugin', title: 'One', ref: 'a.one' }, { preview: true });
      useEditorTabStore.getState().pin('plugin:a.one');
      useEditorTabStore.getState().open({ id: 'plugin:a.two', kind: 'plugin', title: 'Two', ref: 'a.two' }, { preview: true });
    });
    expect(useEditorTabStore.getState().tabs).toHaveLength(2);
  });
});

describe('tab state is workspace state', () => {
  it('persists under the workspace key, not the document', () => {
    act(() => {
      useEditorTabStore.getState().open({ id: 'plugin:a.one', kind: 'plugin', title: 'One', ref: 'a.one' });
    });
    const raw = localStorage.getItem(TAB_PERSIST_KEY);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!).tabs[0].id).toBe('plugin:a.one');
  });

  it('refuses a persisted tab whose id is malformed', () => {
    // Persisted state survived a reload and possibly a hand edit, and the id
    // is about to be used to look a plugin up.
    localStorage.setItem(TAB_PERSIST_KEY, JSON.stringify({
      tabs: [
        { id: 'plugin:../../etc/passwd', kind: 'plugin', title: 'Bad', ref: 'x', preview: false },
        { id: 'plugin:a.one', kind: 'plugin', title: 'One', ref: 'a.one', preview: false },
      ],
      activeId: 'plugin:a.one',
    }));
    // Re-import the module to re-run its load. `jest.isolateModules` gives a
    // fresh module registry, which is the only way to re-run module init.
    jest.isolateModules(() => {

      const mod = require('@stores/editorTabStore') as typeof import('@stores/editorTabStore');
      expect(mod.useEditorTabStore.getState().tabs.map((t) => t.id)).toEqual(['plugin:a.one']);
    });
  });

  it('restores tabs as pinned, never as previews', () => {
    localStorage.setItem(TAB_PERSIST_KEY, JSON.stringify({
      tabs: [{ id: 'plugin:a.one', kind: 'plugin', title: 'One', ref: 'a.one', preview: true }],
      activeId: 'plugin:a.one',
    }));
    jest.isolateModules(() => {

      const mod = require('@stores/editorTabStore') as typeof import('@stores/editorTabStore');
      // Preview-ness describes an in-progress browse. Restoring one as italic
      // and replaceable would surprise someone who left it open deliberately.
      expect(mod.useEditorTabStore.getState().tabs[0]!.preview).toBe(false);
    });
  });
});
