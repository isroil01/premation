/**
 * The Properties panel's Text section is the Text panel's body in its section
 * layout — not a second copy. Pinned: the everyday controls are in view, the
 * rarer ones wait behind the disclosure, and an edit writes the layer.
 *
 * The section reads the document mirror and writes through the engine API
 * (B3/B4), so the fixture is the app's engine: the text layer is created
 * through it and seeded with the same command builder the panel writes with.
 */

import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { TextSection, hasTextSection } from '../TextSection';
import { useSelectionStore } from '@stores/selectionStore';
import { clearHistory, setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import { docView } from '@core/engine/__testHelpers__/docView';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { componentPropsCommands } from '../useComponentProp';
import { componentOfType } from '@core/engine/propRefs';
import { documentMirror } from '@stores/documentMirror';
import { sourceTextCommand } from '@layout/Text/textEdits';

jest.useFakeTimers();

let h: Harness;

beforeEach(async () => {
  h = await setupAppEngine();
});

afterEach(async () => {
  cleanup();
  useSelectionStore.setState({ ids: [] } as never);
  await h.dispose();
});

const textComp = async (id: string) => (await docView()).getNode(id)?.components.find((c) => c.type === 'Text');

/** A text layer created through the engine, its Text props seeded through it, history cleared. */
async function textLayer({ content, ...textProps }: Record<string, unknown>): Promise<string> {
  const id = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'text', name: 'text_section_probe', init: [] })).layer;
  // Source Text is its own property; the rest are the Text component's props.
  await documentMirror().loadTree(id);
  const { cmds, rest } = componentPropsCommands(id, componentOfType(id, 'Text')!, textProps, 0);
  expect(rest).toEqual({});
  const source = typeof content === 'string' ? sourceTextCommand(id, content, 0) : [];
  expect(source).not.toBeNull();
  await h.batch('seed', [...(source ?? []), ...cmds]);
  await clearHistory();
  return id;
}

it('applies to text layers only', async () => {
  expect(hasTextSection('no_such_node')).toBe(false);
  const solid = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name: 'S', init: [] })).layer;
  expect(hasTextSection(solid)).toBe(false);
  const id = await textLayer({ content: 'Hi' });
  expect(hasTextSection(id)).toBe(true);
});

it('shows the font size and the everyday controls for a text layer', async () => {
  const id = await textLayer({ content: 'Hello', fontSize: 48, letterSpacing: 5, fill: '#ff0000' });
  render(<TextSection nodeId={id} />);

  expect(screen.getByLabelText('Font Size')).toHaveValue(48);
  expect(screen.getByLabelText('Tracking (Letter Spacing)')).toHaveValue(5);
  expect(screen.getByLabelText('Character Fill Color')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Center Align' })).toBeInTheDocument();
  // No panel chrome: the section host draws the title.
  expect(screen.queryByText('Default Preset')).toBeNull();
});

it('shows AE\'s Character and Paragraph groups, and keeps the rarer options behind "More text options"', async () => {
  const id = await textLayer({ content: 'Hello', paragraphSpacing: 7 });
  render(<TextSection nodeId={id} />);

  // Character and Paragraph are open, as AE's two panels are.
  expect(screen.getByLabelText('Paragraph Spacing')).toHaveValue(7);
  expect(screen.getByRole('button', { name: 'Faux Bold' })).toBeInTheDocument();

  expect(screen.queryByLabelText('Point or Paragraph Text')).toBeNull();
  const more = screen.getByRole('button', { name: 'More text options' });
  expect(more).toHaveAttribute('aria-expanded', 'false');

  fireEvent.click(more);

  expect(more).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByLabelText('Point or Paragraph Text')).toBeInTheDocument();
});

it('writes a size edit to the layer — one undo entry that undo reverses', async () => {
  const id = await textLayer({ content: 'Hello', fontSize: 48 });
  render(<TextSection nodeId={id} />);
  const before = (await h.doc());

  const size = screen.getByLabelText('Font Size');
  await act(async () => {
    fireEvent.change(size, { target: { value: '64' } });
    fireEvent.blur(size);
    await engineIdle();
  });

  expect((await textComp(id))?.props.fontSize).toBe(64);
  // No second entry from the 700 ms recorder on top of the engine's.
  act(() => { jest.advanceTimersByTime(2000); });
  expect((await historyLabels())).toEqual(['Set Font Size']);

  await act(async () => { await h.run({ type: 'undo' }); });
  expect((await textComp(id))?.props.fontSize).toBe(48);
  expect((await h.doc())).toBe(before);
});

it('renders nothing for a layer that is not text', async () => {
  const { container } = render(<TextSection nodeId="no_such_node" />);
  expect(container.firstChild).toBeNull();
});
