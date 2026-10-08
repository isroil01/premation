import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { CharacterPanel } from '../CharacterPanel';
import { ParagraphPanel } from '../ParagraphPanel';
import { TooltipProvider } from '@components/Tooltip';
import { DockPanel } from '@components/DockPanel';
import { useSelectionStore } from '@stores/selectionStore';
import { useLayoutStore } from '@stores/layoutStore';
import { PANEL_DEFS, availablePanelDefs, panelDef } from '@layout/EditorLayout/panelDefs';
import { PANEL_COMPONENTS } from '@layout/EditorLayout/panelRenderers';
import { clearHistory, setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import { docView } from '@core/engine/__testHelpers__/docView';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { sourceTextCommand } from '@layout/Text/textEdits';
import { componentPropsCommands } from '../useComponentProp';
import { componentOfType } from '@core/engine/propRefs';
import { documentMirror } from '@stores/documentMirror';

// The panels read the document mirror and write through the engine API
// (B3/B4): the fixture is the app's engine, the text layers are created through
// it and seeded with the same command builders the panels write with, and each
// action is pinned as ONE undo entry that undo reverses.
//
// Since 2026-10 they are After Effects' TWO panels: Character draws the
// character rows, Paragraph the paragraph rows — one body (`TextSettingsBody`),
// two variants — and neither draws a heading (the tab is the title).
jest.useFakeTimers();

class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function renderCharacter() {
  return render(
    <TooltipProvider>
      <CharacterPanel />
    </TooltipProvider>,
  );
}

function renderParagraph() {
  return render(
    <TooltipProvider>
      <ParagraphPanel />
    </TooltipProvider>,
  );
}

const textComp = async (id: string) => (await docView()).getNode(id)?.components.find((c) => c.type === 'Text');

/** The paragraph rows: the seven alignment buttons, then indents and spacing. */
const ALIGN_BUTTONS = ['Left Align', 'Center Align', 'Right Align', 'Justify Last Left', 'Justify Last Center', 'Justify Last Right', 'Justify All Lines'];
const PARAGRAPH_FIELDS = ['Paragraph Spacing', 'First Line Indent', 'Left Indent', 'Right Indent', 'Space Before', 'Space After'];

describe('Character and Paragraph panels', () => {
  let h: Harness;

  beforeAll(() => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = StubResizeObserver;
  });

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
    await documentMirror().loadTree(id);
    const { cmds, rest } = componentPropsCommands(id, componentOfType(id, 'Text')!, textProps, 0);
    expect(rest).toEqual({});
    const source = typeof content === 'string' ? sourceTextCommand(id, content, 0) : [];
    expect(source).not.toBeNull();
    await h.batch('seed', [...(source ?? []), ...cmds]);
    await clearHistory();
    return id;
  };

  const idle = async (): Promise<void> => { await act(async () => { await engineIdle(); }); };
  /** No second entry from the 700 ms recorder on top of the engine's. */
  const settle = (): void => { act(() => { jest.advanceTimersByTime(2000); }); };
  const undo = async (): Promise<void> => { await act(async () => { await h.run({ type: 'undo' }); }); };

  it('Character with nothing selected: no "Text" heading, the character rows, none of the paragraph rows', async () => {
    renderCharacter();
    // The tab is the panel's only title.
    expect(screen.queryByText('Text')).not.toBeInTheDocument();
    expect(screen.queryByText('Typography')).not.toBeInTheDocument();
    expect(screen.queryByText('Default Preset')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Font Size')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Faux Bold' })).toBeInTheDocument();
    for (const name of ALIGN_BUTTONS) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    for (const label of PARAGRAPH_FIELDS) expect(screen.queryByLabelText(label)).not.toBeInTheDocument();
  });

  it('Character renders the character controls for a selected text layer — and no paragraph rows', async () => {
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
    renderCharacter();

    // The Source Text group.
    const textarea = screen.getByPlaceholderText('Type text content here...') as HTMLTextAreaElement;
    expect(textarea.value).toBe('Hello World');

    // Typography
    expect(screen.getByLabelText('Font Size')).toHaveValue(48);
    expect(screen.getByLabelText('Leading (Line Height)')).toHaveValue(1.3);
    expect(screen.getByLabelText('Tracking (Letter Spacing)')).toBeInTheDocument();

    // AE's synthetic styles — independent of the weight menu and the font's italic.
    for (const name of ['Faux Bold', 'Faux Italic', 'All Caps', 'Small Caps', 'Superscript', 'Subscript']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }

    // The app's extras are group rows that open and close, after AE's rows.
    for (const name of ['Source Text', 'Text Box', 'Presets']) {
      expect(screen.getByRole('button', { name })).toHaveAttribute('aria-expanded', 'true');
    }

    // The paragraph rows are the Paragraph panel's now.
    for (const name of ALIGN_BUTTONS) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    for (const label of PARAGRAPH_FIELDS) expect(screen.queryByLabelText(label)).not.toBeInTheDocument();
  });

  it('Paragraph renders the paragraph rows only — alignment, indents, spacing, direction', async () => {
    const textNode = await addTextNode('Body Copy', { content: 'Paragraph content', paragraphSpacing: 12, align: 'left' });

    act(() => { useSelectionStore.setState({ ids: [textNode] }); });
    renderParagraph();

    for (const name of ALIGN_BUTTONS) expect(screen.getByRole('button', { name })).toBeInTheDocument();
    expect(screen.getByLabelText('Paragraph Spacing')).toHaveValue(12);
    for (const label of PARAGRAPH_FIELDS) expect(screen.getByLabelText(label)).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Text Direction' })).toBeInTheDocument();

    // No character rows, no Source Text, no heading.
    expect(screen.queryByLabelText('Font Size')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Faux Bold' })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Type text content here...')).not.toBeInTheDocument();
    expect(screen.queryByText('Paragraph & Alignment')).not.toBeInTheDocument();
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
    renderParagraph();
    const before = (await h.doc());

    fireEvent.click(screen.getByRole('button', { name: 'Center Align' }));
    await idle();
    expect((await textComp(textNode))?.props.align).toBe('center');
    settle();
    expect((await historyLabels())).toHaveLength(1);
    const afterCenter = (await h.doc());

    fireEvent.click(screen.getByRole('button', { name: 'Right Align' }));
    await idle();
    expect((await textComp(textNode))?.props.align).toBe('right');
    settle();
    expect((await historyLabels())).toHaveLength(2);

    await undo();
    expect((await textComp(textNode))?.props.align).toBe('center');
    expect((await h.doc())).toBe(afterCenter);
    await undo();
    expect((await textComp(textNode))?.props.align).toBe('left');
    expect((await h.doc())).toBe(before);
  });

  it('updates paragraph spacing when input changes — one undo entry', async () => {
    const textNode = await addTextNode('Spaced Copy', {
      content: 'Spaced paragraph',
      paragraphSpacing: 10,
    });

    act(() => {
      useSelectionStore.setState({ ids: [textNode] });
    });
    renderParagraph();
    const before = (await h.doc());

    const spacingInput = screen.getByLabelText('Paragraph Spacing');
    fireEvent.change(spacingInput, { target: { value: '25' } });
    fireEvent.blur(spacingInput);
    await idle();

    expect((await textComp(textNode))?.props.paragraphSpacing).toBe(25);
    settle();
    expect((await historyLabels())).toHaveLength(1);

    await undo();
    expect((await textComp(textNode))?.props.paragraphSpacing).toBe(10);
    expect((await h.doc())).toBe(before);
  });

  it('Character offers its text style presets in the dock ≡ menu, not as a header button', async () => {
    const textNode = await addTextNode('Styled Layer', { content: 'Styled' });
    act(() => {
      const layout = useLayoutStore.getState();
      layout.registerPanel({ id: 'character', title: 'Character', icon: 'type', region: 'rightInspector', closable: true } as never);
      layout.openPanel('character');
      useSelectionStore.setState({ ids: [textNode] });
    });
    render(
      <TooltipProvider>
        <DockPanel region="rightInspector" renderers={{ character: () => <CharacterPanel /> }} />
      </TooltipProvider>,
    );
    await idle();
    expect(screen.queryByRole('button', { name: 'Text style presets' })).not.toBeInTheDocument();

    const menus = screen.getAllByRole('button', { name: 'Panel options' });
    fireEvent.click(menus[menus.length - 1]!);
    expect(screen.getByRole('menuitem', { name: 'Text Style Presets' })).toBeInTheDocument();
  });

  it('ParagraphPanel is its own panel now, not a re-export of CharacterPanel', async () => {
    expect(ParagraphPanel).not.toBe(CharacterPanel);
  });

  describe('Panel registry', () => {
    it('character panel is titled "Character" (AE) with icon "type"', async () => {
      const def = panelDef('character');
      expect(def).toBeDefined();
      expect(def?.title).toBe('Character');
      expect(def?.icon).toBe('type');
      expect(def?.region).toBe('rightInspector');
    });

    it('registers Paragraph right after Character, permanent and closable, with a glyph of its own', async () => {
      const ids = PANEL_DEFS.map((p) => p.id);
      expect(ids.indexOf('paragraph')).toBe(ids.indexOf('character') + 1);
      const def = panelDef('paragraph');
      expect(def).toMatchObject({ id: 'paragraph', title: 'Paragraph', icon: 'text-left', region: 'rightInspector', weight: 4.48, closable: true });
      expect(def?.onDemand).toBeUndefined();
      // Icons are distinct glyphs (panelDefs.ts): no other panel uses it.
      expect(PANEL_DEFS.filter((p) => p.icon === def?.icon).map((p) => p.id)).toEqual(['paragraph']);
      expect(availablePanelDefs().map((p) => p.id)).toContain('paragraph');
    });

    it('PANEL_COMPONENTS maps character to CharacterPanel and paragraph to ParagraphPanel', async () => {
      expect(PANEL_COMPONENTS.character).toBe(CharacterPanel);
      expect(PANEL_COMPONENTS.paragraph).toBe(ParagraphPanel);
    });
  });
});
