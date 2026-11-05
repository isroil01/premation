/**
 * Opening a routed project never shows anything but that project.
 *
 * 2026-11-04, real app (server edition): (1) entering a project, the loading
 * screen gave way to the workspace's EMPTY-composition cards before the
 * project's content arrived; (2) opening project A, going back to the
 * dashboard and opening project B showed A's viewer, timeline and layers until
 * B landed.
 *
 * Both were the same thing: the editor shell mounts as soon as the engine is
 * up, and the routed project opens after that — fetched, opened by the engine,
 * refetched by the mirror. Until then the mirror holds what the engine already
 * had: its boot document (one empty comp → the cards) or, because the engine
 * process and the mirror outlive the editor route, the previous project. The
 * shell drew it. Now ProjectLoader says when the routed project is the one
 * shown (projectOpenStore) and ProjectOpenGate keeps the loading screen up
 * until then.
 *
 * Driven on the real engine: the real ProjectLoader, ProjectManager and engine
 * document session, a cloud "server" whose fetch the test holds open, and two
 * views of the mirror — one as the editor now shows it (behind the gate), one
 * as it showed it before (ungated, the control that proves the stale content
 * really is there to be seen).
 */

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { setupAppEngine, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { engine } from '@core/engine/engineInstance';
import { documentMirror } from '@stores/documentMirror';
import { useMirrorSelect } from '@hooks/useMirror';
import { ProjectManager } from '@core/project/ProjectManager';
import { EngineDocumentSession } from '@core/project/engineDocumentSession';
import type { FileManager } from '@core/files/FileManager';
import { projectOpenPending, useProjectOpenStore } from '@stores/projectOpenStore';
import { ProjectLoader } from './ProjectLoader';
import { ProjectOpenGate } from './ProjectOpenGate';

/** The cloud: project id → its document text; a held fetch resolves when the test says. */
const mockServer = new Map<string, string>();
let mockHeld: { id: string; asked: boolean; release: () => void } | null = null;
const mockFiles = {
  environment: 'api',
  read: (id: string): Promise<string | null> => new Promise((resolve) => {
    const answer = (): void => resolve(mockServer.get(id) ?? null);
    if (mockHeld?.id === id) {
      mockHeld.asked = true;
      mockHeld.release = answer;
    } else answer();
  }),
} as unknown as FileManager;
let mockPm: ProjectManager;

jest.mock('@core/services/coreServices', () => ({
  ...jest.requireActual('@core/services/coreServices'),
  getProjectManager: () => mockPm,
  getFileManager: () => mockFiles,
}));

let h: Harness;

beforeEach(async () => {
  h = await setupAppEngine();
  mockServer.clear();
  mockHeld = null;
  useProjectOpenStore.setState({ shownProjectId: null });
  const session = new EngineDocumentSession({
    engine: () => engine(),
    mirror: documentMirror(),
    recoveryPath: '',
    files: { readText: async () => null, remove: async () => {} },
    index: { read: () => null, write: () => {} },
    now: () => 0,
  });
  mockPm = new ProjectManager({ service: {} as never, files: mockFiles, recent: { add: () => {} } as never, engineDocument: session });
});

afterEach(async () => {
  cleanup();
  await h.dispose();
});

/** A cloud project holding one layer called `name`. */
async function serverProject(id: string, name: string): Promise<void> {
  await h.run({ type: 'newProject' });
  await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name, init: [] } as never);
  const { document } = await h.query({ type: 'exportDocument' });
  mockServer.set(id, new TextDecoder().decode(document));
}

/** What each view showed, render by render. */
let gated: string[] = [];
let ungated: string[] = [];

function MirrorView({ projectId, log }: { projectId: string; log: 'gated' | 'ungated' }): JSX.Element {
  const names = useMirrorSelect(['layers', 'comps'], (m) => m.layerIds().map((id) => m.layer(id)?.name ?? '?').sort().join(',') || '(empty comp)');
  const pending = useProjectOpenStore((s) => projectOpenPending(projectId, s.shownProjectId));
  const shown = log === 'gated' && pending ? '(loading)' : names;
  (log === 'gated' ? gated : ungated).push(shown);
  return <div data-testid={log}>{shown}</div>;
}

/** The editor route for `projectId`: the loader, the gate, and the two views. */
function EditorRoute({ projectId }: { projectId: string }): JSX.Element {
  return (
    <>
      <ProjectLoader projectId={projectId} />
      <ProjectOpenGate projectId={projectId} />
      <MirrorView projectId={projectId} log="gated" />
      <MirrorView projectId={projectId} log="ungated" />
    </>
  );
}

async function settled(id: string): Promise<void> {
  await waitFor(() => expect(useProjectOpenStore.getState().shownProjectId).toBe(id));
  await act(async () => { await documentMirror().whenIdle(); });
}

it('first entry: the loading screen goes straight to the project, never through the empty comp', async () => {
  await serverProject('proj-b', 'Layer B');
  // The engine's boot document: one empty, pristine comp.
  await h.run({ type: 'newProject' });
  await act(async () => { await documentMirror().whenIdle(); });

  mockHeld = { id: 'proj-b', asked: false, release: () => {} };
  gated = [];
  ungated = [];
  render(<EditorRoute projectId="proj-b" />);
  await waitFor(() => expect(mockHeld?.asked).toBe(true));
  // Mid-open: the old shell would show the empty comp; the editor shows the loading screen.
  expect(screen.getByTestId('ungated').textContent).toBe('(empty comp)');
  expect(screen.getByTestId('gated').textContent).toBe('(loading)');
  expect(screen.getByRole('status')).toBeTruthy();

  act(() => mockHeld!.release());
  await settled('proj-b');

  expect(screen.getByTestId('gated').textContent).toBe('Layer B');
  expect(screen.queryByRole('status')).toBeNull();
  expect(gated).not.toContain('(empty comp)');
  expect(new Set(gated)).toEqual(new Set(['(loading)', 'Layer B']));
  // The control: the ungated view DID pass through the empty comp.
  expect(ungated).toContain('(empty comp)');
});

it('re-entry: opening B after leaving A never shows A', async () => {
  await serverProject('proj-a', 'Layer A');
  await serverProject('proj-b', 'Layer B');

  // Open A, look at it, leave (back to the dashboard: the route unmounts).
  const a = render(<EditorRoute projectId="proj-a" />);
  await settled('proj-a');
  expect(screen.getByTestId('gated').textContent).toBe('Layer A');
  a.unmount();
  expect(useProjectOpenStore.getState().shownProjectId).toBeNull();

  // Open B, with the server's answer held so the in-between is observable.
  mockHeld = { id: 'proj-b', asked: false, release: () => {} };
  gated = [];
  ungated = [];
  render(<EditorRoute projectId="proj-b" />);
  await waitFor(() => expect(mockHeld?.asked).toBe(true));
  expect(screen.getByTestId('ungated').textContent).toBe('Layer A');
  expect(screen.getByTestId('gated').textContent).toBe('(loading)');

  act(() => mockHeld!.release());
  await settled('proj-b');

  expect(screen.getByTestId('gated').textContent).toBe('Layer B');
  expect(gated).not.toContain('Layer A');
  expect(new Set(gated)).toEqual(new Set(['(loading)', 'Layer B']));
  // The control: without the gate, A was on screen while B opened.
  expect(ungated).toContain('Layer A');
});

it('a failed open after A shows an empty editor, never A', async () => {
  await serverProject('proj-a', 'Layer A');
  const a = render(<EditorRoute projectId="proj-a" />);
  await settled('proj-a');
  a.unmount();

  gated = [];
  render(<EditorRoute projectId="proj-gone" />);
  await settled('proj-gone');

  expect(screen.getByTestId('gated').textContent).toBe('(empty comp)');
  expect(gated).not.toContain('Layer A');
});
