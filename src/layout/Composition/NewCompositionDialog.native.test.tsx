import { act, render as rtlRender, screen, fireEvent } from '@testing-library/react';
import { openNewCompositionDialog, NewComposition } from './NewCompositionDialog';
import { useModalStore } from '@stores/modalStore';
import { useProjectStore } from '@stores/projectStore';
import { documentMirror } from '@stores/documentMirror';
import { CommandSystem, setCommandSystem } from '@core/commands/CommandSystem';
import { TooltipProvider } from '@components/Tooltip';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { docView } from '@core/engine/__testHelpers__/docView';
import { engineIdle } from '@core/engine/engineInstance';

const render = (ui: React.ReactElement) => rtlRender(ui, { wrapper: TooltipProvider });

describe('NewCompositionDialog', () => {
  beforeEach(() => {
    setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
    useModalStore.setState({ stack: [] });
    useProjectStore.getState().actions.replaceComps({});
  });

  it('opens modal with size "md" and title "New Composition"', async () => {
    openNewCompositionDialog();
    const stack = useModalStore.getState().stack;
    expect(stack.length).toBe(1);
    expect(stack[0]?.title).toBe('New Composition');
    expect(stack[0]?.size).toBe('md');
  });

  // The dialog is a settings form (2026-10): one preset menu and labelled
  // fields, with the size read back beside them.
  const presetMenu = (): HTMLSelectElement => screen.getByRole('combobox', { name: 'Preset' }) as HTMLSelectElement;

  /** Type a number into a ValueField the way a user does: Enter, type, leave. */
  const typeInto = (label: string, from: string, to: string): void => {
    fireEvent.keyDown(screen.getByRole('spinbutton', { name: label }), { key: 'Enter' });
    const input = screen.getByDisplayValue(from);
    fireEvent.change(input, { target: { value: to } });
    fireEvent.blur(input);
  };

  it('renders initial state with smart default comp name, the size read back, and the presets', async () => {
    const close = jest.fn();
    render(<NewComposition close={close} />);

    const nameInput = screen.getByLabelText(/composition name/i);
    expect(nameInput).toHaveValue('Comp 1');

    expect(screen.getByText('1920 × 1080 px')).toBeInTheDocument();
    expect(screen.getByText('Landscape')).toBeInTheDocument();
    expect(screen.getByText('16:9')).toBeInTheDocument();
    expect(screen.getByText(/300 frames at 30 fps/)).toBeInTheDocument();

    // The preset menu names the matching preset and offers the rest.
    expect(presetMenu().value).toBe('yt_1080');
    const names = Array.from(presetMenu().options).map((o) => o.textContent ?? '');
    expect(names.some((n) => n.startsWith('YouTube 1080p'))).toBe(true);
    expect(names.some((n) => n.startsWith('Instagram Reel / Story'))).toBe(true);
  });

  it('picks a preset from the menu', async () => {
    const close = jest.fn();
    render(<NewComposition close={close} />);

    fireEvent.change(presetMenu(), { target: { value: 'ig_reel' } });

    expect(screen.getByText('1080 × 1920 px')).toBeInTheDocument();
    expect(screen.getByText('Portrait')).toBeInTheDocument();
    expect(screen.getByText('9:16')).toBeInTheDocument();
  });

  it('flips orientation with the swap button', async () => {
    const close = jest.fn();
    render(<NewComposition close={close} />);

    expect(screen.getByText('Landscape')).toBeInTheDocument();

    const swapBtn = screen.getByLabelText(/swap width and height/i);
    fireEvent.click(swapBtn);

    expect(screen.getByText('1080 × 1920 px')).toBeInTheDocument();
    expect(screen.getByText('Portrait')).toBeInTheDocument();

    fireEvent.click(swapBtn);
    expect(screen.getByText('1920 × 1080 px')).toBeInTheDocument();
    expect(screen.getByText('Landscape')).toBeInTheDocument();
  });

  it('locks aspect ratio and scales dimensions proportionally', async () => {
    const close = jest.fn();
    render(<NewComposition close={close} />);

    // Lock aspect ratio (initially 1920 / 1080 = 16:9)
    fireEvent.click(screen.getByLabelText(/lock aspect ratio/i));
    expect(screen.getByLabelText(/unlock aspect ratio/i)).toBeInTheDocument();

    typeInto('Width', '1920', '1280');

    // Height should proportionally scale to 720 (1280 / (1920/1080) = 720)
    expect(screen.getByText('1280 × 720 px')).toBeInTheDocument();
  });

  it('reads the frame rate and duration back as frames and timecode', async () => {
    const close = jest.fn();
    render(<NewComposition close={close} />);

    typeInto('Frame rate', '30', '60');
    expect(screen.getByText(/600 frames at 60 fps/)).toBeInTheDocument();

    typeInto('Duration', '10', '30');
    expect(screen.getByText(/00:30:00/)).toBeInTheDocument();
    expect(screen.getByText(/1800 frames at 60 fps/)).toBeInTheDocument();
  });

  it('supports background color swatches and transparent switch', async () => {
    const close = jest.fn();
    render(<NewComposition close={close} />);

    const blackSwatch = screen.getByLabelText('Deep Black');
    expect(blackSwatch).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(blackSwatch);
    expect(blackSwatch).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Studio Dark')).toHaveAttribute('aria-pressed', 'false');

    // Transparent: no colour is in use, so no swatch reads as chosen.
    const transSwitch = screen.getByRole('switch', { name: /transparent/i });
    fireEvent.click(transSwitch);
    expect(transSwitch).toBeChecked();
    expect(blackSwatch).toHaveAttribute('aria-pressed', 'false');
  });

  describe('through the engine', () => {
    let h: Harness;
    beforeEach(async () => {
      h = await setupAppEngine();
    });
    afterEach(async () => {
      await h.dispose();
    });

    const create = async (): Promise<jest.Mock> => {
      const close = jest.fn();
      render(<NewComposition close={close} />);
      fireEvent.change(screen.getByLabelText(/composition name/i), { target: { value: 'Promo' } });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /^create$/i }));
        await engineIdle();
      });
      return close;
    };

    it('adds a composition as ONE undo entry, opens its tab, and undo removes it exactly', async () => {
      // A project whose only comp is the user's (configured, so no longer pristine): New Composition ADDS.
      await h.run({ type: 'setCompositionSettings', comp: 'comp_root', patch: { name: 'Mine' } });
      await engineIdle();
      await documentMirror().whenIdle();
      expect(documentMirror().comp('comp_root')?.settings.pristine ?? false).toBe(false);
      const before = (await h.doc());
      const count = Object.keys(useProjectStore.getState().comps).length;
      const close = await create();

      expect(close).toHaveBeenCalledTimes(1);
      const comps = useProjectStore.getState().comps;
      expect(Object.keys(comps)).toHaveLength(count + 1);
      const made = Object.values(comps).find((c) => c.name === 'Promo')!;
      expect(made).toMatchObject({ width: 1920, height: 1080, fps: 30, durationSeconds: 10, background: '#101014', transparent: false });
      expect((await docView()).getNode(made.id)?.name).toBe('Promo');
      const s = useProjectStore.getState();
      expect(s.tabs[s.activeTabId!]?.compositionId).toBe(made.id);
      expect((await historyLabels()).at(-1)).toBe('New Composition');

      await h.run({ type: 'undo' });
      expect(useProjectStore.getState().comps[made.id]).toBeUndefined();
      expect((await h.doc())).toBe(before);
      await h.run({ type: 'redo' });
      expect(useProjectStore.getState().comps[made.id]?.name).toBe('Promo');
    });

    it('in a fresh project, configures the pristine comp instead of stacking a second', async () => {
      expect(documentMirror().comp('comp_root')?.settings.pristine).toBe(true);
      const before = (await h.doc());
      await create();
      const comps = useProjectStore.getState().comps;
      expect(Object.keys(comps)).toEqual(['comp_root']);
      expect(comps.comp_root).toMatchObject({ name: 'Promo', width: 1920 });
      expect(comps.comp_root?.pristine).toBeUndefined();
      await h.run({ type: 'undo' });
      expect(useProjectStore.getState().comps.comp_root?.pristine).toBe(true);
      expect((await h.doc())).toBe(before);
    });
  });
});
