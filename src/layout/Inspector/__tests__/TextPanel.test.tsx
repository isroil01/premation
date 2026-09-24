import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { CharacterPanel } from '../CharacterPanel';
import { ParagraphPanel } from '../ParagraphPanel';
import { TooltipProvider } from '@components/Tooltip';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useSelectionStore } from '@stores/selectionStore';
import { PANEL_DEFS, availablePanelDefs, panelDef } from '@layout/EditorLayout/panelDefs';
import { PANEL_COMPONENTS } from '@layout/EditorLayout/panelRenderers';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { sourceTextCommand } from '@layout/Text/textEdits';
import { componentPropsCommands } from '../useComponentProp';

// The panel reads the document mirror and writes through the engine API
// (B3/B4): the fixture is the app's engine, the text layers are created through
// it and seeded with the same command builders the panel writes with, and each
// action is pinned as ONE undo entry that undo reverses.
jest.useFakeTimers();

function renderPanel() {
  return render(
    <TooltipProvider>
      <CharacterPanel />
    </TooltipProvider>,
  );
}

const textComp = (id: string) => defaultSceneGraph.getNode(id)?.components.find((c) => c.type === 'Text');

describe('Unified Text Panel (Character + Paragraph)', () => {
  let h: Harness & { engine: LocalEngine };

  beforeEach(async () => {
    h = await setupAppEngine();
  });

  afterEach(async () => {
    cleanup();
    act(() => { useSelectionStore.setState({ ids: [] }); });
    await h.dispose();
  });

  /** A text layer created through the engine, seeded through it, history cleared. */
  const addTextNode = async (name: string, { content, ...textProps }: Record<string, unknown> = {}): Promise<string> => {
    const id = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'text', name, init: [] })).layer;
    // Source Text is its own property; the rest are the Text component's props.
    const { cmds, rest } = componentPropsCommands(id, textComp(id)!.id, textProps, 0);
    expect(rest).toEqual({});
    const source = typeof content === 'string' ? sourceTextCommand(id, content, 0) : [];
    expect(source).not.toBeNull();
    await h.batch('seed', [...(source ?? []), ...cmds]);
    getCommandSystem().getHistory().clear();
    return id;
  };

  const idle = async (): Promise<void> => { await act(async () => { await engineIdle(); }); };
  /** No second entry from the 700 ms recorder on top of the engine's. */
  const settle = (): void => { act(() => { jest.advanceTimersByTime(2000); }); };
  const undo = async (): Promise<void> => { await act(async () => { await h.run({ type: 'undo' }); }); };

  it('renders default text panel when no text node is selected', () => {
    renderPanel();
    expect(screen.getByText('Text')).toBeInTheDocument();
    expect(screen.getByText('Default Preset')).toBeInTheDocument();
    expect(screen.getByText('Typography')).toBeInTheDocument();
    expect(screen.getByText(/Paragraph/)).toBeInTheDocument();
  });

  it('renders both character and paragraph controls for selected text layer', async () => {
    const textNode = await addTextNode('Headline Layer', {
      content: 'Hello World',
      fontSize: 48,
      fontFamily: 'Inter',
      fontWeight: '600',
      align: 'left',
      paragraphSpacing: 12,
      lineHeight: 1.3,
      fill: '#ffffff',
      stroke: '#000000',
      strokeWidth: 0,
    });

    act(() => { useSelectionStore.setState({ ids: [textNode] }); });
    renderPanel();

    // Verify layer name in header badge
    expect(screen.getByText('Headline Layer')).toBeInTheDocument();

    // Verify content textarea
    const textarea = screen.getByPlaceholderText('Type text content here...') as HTMLTextAreaElement;
    expect(textarea).toBeInTheDocument();
    expect(textarea.value).toBe('Hello World');

    // Verify typography controls
    expect(screen.getByLabelText('Font Size')).toHaveValue(48);
    expect(screen.getByLabelText('Leading (Line Height)')).toHaveValue(1.3);

    // Verify character style buttons
    // AE's synthetic styles — independent of the weight menu and the font's italic.
    expect(screen.getByRole('button', { name: 'Faux Bold' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Faux Italic' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'All Caps' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Small Caps' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Superscript' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Subscript' })).toBeInTheDocument();

    // Verify all 7 alignment buttons
    expect(screen.getByRole('button', { name: 'Left Align' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Center Align' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Right Align' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Justify Last Left' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Justify Last Center' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Justify Last Right' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Justify All Lines' })).toBeInTheDocument();

    // Verify paragraph metrics
    expect(screen.getByLabelText('Paragraph Spacing')).toHaveValue(12);
    expect(screen.getByLabelText('First Line Indent')).toBeInTheDocument();
    expect(screen.getByLabelText('Left Indent')).toBeInTheDocument();
    expect(screen.getByLabelText('Right Indent')).toBeInTheDocument();
    expect(screen.getByLabelText('Space Before')).toBeInTheDocument();
  });

  it('updates alignment when paragraph alignment buttons are clicked — one undo entry per click', async () => {
    const textNode = await addTextNode('Body Copy', {
      content: 'Paragraph content',
      fontSize: 24,
      align: 'left',
    });

    act(() => {
      useSelectionStore.setState({ ids: [textNode] });
    });
    renderPanel();
    const before = h.doc();

    fireEvent.click(screen.getByRole('button', { name: 'Center Align' }));
    await idle();
    expect(textComp(textNode)?.props.align).toBe('center');
    settle();
    expect(historyLabels()).toHaveLength(1);
    const afterCenter = h.doc();

    fireEvent.click(screen.getByRole('button', { name: 'Right Align' }));
    await idle();
    expect(textComp(textNode)?.props.align).toBe('right');
    settle();
    expect(historyLabels()).toHaveLength(2);

    await undo();
    expect(textComp(textNode)?.props.align).toBe('center');
    expect(h.doc()).toBe(afterCenter);
    await undo();
    expect(textComp(textNode)?.props.align).toBe('left');
    expect(h.doc()).toBe(before);
  });

  it('updates paragraph spacing when input changes — one undo entry', async () => {
    const textNode = await addTextNode('Spaced Copy', {
      content: 'Spaced paragraph',
      paragraphSpacing: 10,
    });

    act(() => {
      useSelectionStore.setState({ ids: [textNode] });
    });
    renderPanel();
    const before = h.doc();

    const spacingInput = screen.getByLabelText('Paragraph Spacing');
    fireEvent.change(spacingInput, { target: { value: '25' } });
    fireEvent.blur(spacingInput);
    await idle();

    expect(textComp(textNode)?.props.paragraphSpacing).toBe(25);
    settle();
    expect(historyLabels()).toHaveLength(1);

    await undo();
    expect(textComp(textNode)?.props.paragraphSpacing).toBe(10);
    expect(h.doc()).toBe(before);
  });

  it('ParagraphPanel exports the unified component for backward compatibility', () => {
    expect(ParagraphPanel).toBe(CharacterPanel);
  });

  describe('Panel Registry Consolidation', () => {
    it('character panel is titled "Text" with icon "type"', () => {
      const def = panelDef('character');
      expect(def).toBeDefined();
      expect(def?.title).toBe('Text');
      expect(def?.icon).toBe('type');
      expect(def?.region).toBe('rightInspector');
    });

    it('separate paragraph panel is removed from PANEL_DEFS to avoid duplicate tabs', () => {
      const paragraphDef = PANEL_DEFS.find((p) => p.id === 'paragraph');
      expect(paragraphDef).toBeUndefined();

      const availableIds = availablePanelDefs().map((p) => p.id);
      expect(availableIds).toContain('character');
      expect(availableIds).not.toContain('paragraph');
    });

    it('PANEL_COMPONENTS maps character (and paragraph, while it is still mapped) to CharacterPanel', () => {
      expect(PANEL_COMPONENTS.character).toBe(CharacterPanel);
      // `paragraph` had no def and was dropped from the renderer map; if it is
      // ever mapped again it must be the same shared panel, never a copy.
      expect([undefined, CharacterPanel]).toContain(PANEL_COMPONENTS.paragraph);
    });
  });
});
