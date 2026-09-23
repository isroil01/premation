import { act, render as rtlRender, screen, fireEvent } from '@testing-library/react';
import { openNewCompositionDialog, NewComposition } from './NewCompositionDialog';
import { useModalStore } from '@stores/modalStore';
import { useProjectStore } from '@stores/projectStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { CommandSystem, setCommandSystem } from '@core/commands/CommandSystem';
import { TooltipProvider } from '@components/Tooltip';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { engineIdle } from '@core/engine/engineInstance';

const render = (ui: React.ReactElement) => rtlRender(ui, { wrapper: TooltipProvider });

function resetScene(): void {
  const ids: string[] = [];
  defaultSceneGraph.traverse((n) => ids.push(n.id));
  for (const id of ids) defaultSceneGraph.removeNode(id);
}

describe('NewCompositionDialog', () => {
  beforeEach(() => {
    resetScene();
    setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
    useModalStore.setState({ stack: [] });
    useProjectStore.getState().actions.replaceComps({});
  });

  it('opens modal with size "lg" and title "New Composition"', () => {
    openNewCompositionDialog();
    const stack = useModalStore.getState().stack;
    expect(stack.length).toBe(1);
    expect(stack[0]?.title).toBe('New Composition');
    expect(stack[0]?.size).toBe('lg');
  });

  it('renders initial state with smart default comp name, preview, and popular presets', () => {
    const close = jest.fn();
    render(<NewComposition close={close} />);

    // Default name
    const nameInput = screen.getByLabelText(/composition name/i);
    expect(nameInput).toHaveValue('Comp 1');

    // Visual preview info
    expect(screen.getByText('1920 × 1080 px')).toBeInTheDocument();
    expect(screen.getByText('Landscape')).toBeInTheDocument();
    expect(screen.getAllByText('16:9').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/30 fps/)).toBeInTheDocument();

    // Preset cards
    expect(screen.getByText('YouTube 1080p')).toBeInTheDocument();
    expect(screen.getByText('Instagram Reel / Story')).toBeInTheDocument();
  });

  it('switches preset categories and selects a preset correctly', () => {
    const close = jest.fn();
    render(<NewComposition close={close} />);

    // Switch to Social tab
    const socialTab = screen.getByRole('tab', { name: /social/i });
    fireEvent.click(socialTab);

    // Social presets should be visible
    const reelBtn = screen.getByText('Instagram Reel / Story');
    expect(reelBtn).toBeInTheDocument();

    // Click reel preset (1080x1920)
    fireEvent.click(reelBtn);

    // Check preview updates
    expect(screen.getByText('1080 × 1920 px')).toBeInTheDocument();
    expect(screen.getByText('Portrait')).toBeInTheDocument();
    expect(screen.getAllByText('9:16').length).toBeGreaterThanOrEqual(1);
  });

  it('flips orientation with the swap button', () => {
    const close = jest.fn();
    render(<NewComposition close={close} />);

    // Initially 1920 x 1080 (Landscape)
    expect(screen.getByText('Landscape')).toBeInTheDocument();

    // Click swap button
    const swapBtn = screen.getByLabelText(/swap width and height/i);
    fireEvent.click(swapBtn);

    // Now 1080 x 1920 (Portrait)
    expect(screen.getByText('1080 × 1920 px')).toBeInTheDocument();
    expect(screen.getByText('Portrait')).toBeInTheDocument();

    // Click swap button again
    fireEvent.click(swapBtn);
    expect(screen.getByText('1920 × 1080 px')).toBeInTheDocument();
    expect(screen.getByText('Landscape')).toBeInTheDocument();
  });

  it('locks aspect ratio and scales dimensions proportionally', () => {
    const close = jest.fn();
    render(<NewComposition close={close} />);

    // Lock aspect ratio (initially 1920 / 1080 = 16:9)
    const lockBtn = screen.getByLabelText(/lock aspect ratio/i);
    fireEvent.click(lockBtn);
    expect(screen.getByLabelText(/unlock aspect ratio/i)).toBeInTheDocument();

    // Enter edit mode on Width spinbutton
    const widthSpin = screen.getByRole('spinbutton', { name: 'Width' });
    fireEvent.keyDown(widthSpin, { key: 'Enter' });

    // Now width input is present
    const widthInput = screen.getByDisplayValue('1920');
    fireEvent.change(widthInput, { target: { value: '1280' } });
    fireEvent.blur(widthInput);

    // Height should proportionally scale to 720 (1280 / (1920/1080) = 720)
    expect(screen.getByText('1280 × 720 px')).toBeInTheDocument();
  });

  it('updates FPS and duration via quick chips', () => {
    const close = jest.fn();
    render(<NewComposition close={close} />);

    // Click 60 fps chip
    const fps60Chip = screen.getByRole('button', { name: '60' });
    fireEvent.click(fps60Chip);
    expect(screen.getByText(/60 fps/)).toBeInTheDocument();

    // Click 30s duration chip
    const dur30Chip = screen.getByRole('button', { name: '30s' });
    fireEvent.click(dur30Chip);
    expect(screen.getByText(/00:30:00/)).toBeInTheDocument();
  });

  it('supports background color swatches and transparent switch', () => {
    const close = jest.fn();
    render(<NewComposition close={close} />);

    // Select Deep Black swatch
    const blackSwatch = screen.getByLabelText('Deep Black');
    fireEvent.click(blackSwatch);

    const canvasFrame = screen.getByTestId('canvas-preview-frame');
    expect(canvasFrame).toHaveStyle({ backgroundColor: '#000000' });

    // Toggle Transparent switch
    const transSwitch = screen.getByRole('switch', { name: /transparent/i });
    fireEvent.click(transSwitch);

    expect(canvasFrame).toHaveAttribute('data-transparent', 'true');
    expect(canvasFrame).toHaveStyle({ backgroundColor: 'transparent' });
  });

  describe('through the engine', () => {
    let h: Harness & { engine: LocalEngine };
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
        fireEvent.click(screen.getByRole('button', { name: /create composition/i }));
        await engineIdle();
      });
      return close;
    };

    it('adds a composition as ONE undo entry, opens its tab, and undo removes it exactly', async () => {
      // A project whose only comp is the user's (not pristine): New Composition ADDS.
      useProjectStore.getState().actions.updateComp('comp_root', { pristine: undefined });
      const before = h.doc();
      const count = Object.keys(useProjectStore.getState().comps).length;
      const close = await create();

      expect(close).toHaveBeenCalledTimes(1);
      const comps = useProjectStore.getState().comps;
      expect(Object.keys(comps)).toHaveLength(count + 1);
      const made = Object.values(comps).find((c) => c.name === 'Promo')!;
      expect(made).toMatchObject({ width: 1920, height: 1080, fps: 30, durationSeconds: 10, background: '#101014', transparent: false });
      expect(defaultSceneGraph.getNode(made.id)?.name).toBe('Promo');
      const s = useProjectStore.getState();
      expect(s.tabs[s.activeTabId!]?.compositionId).toBe(made.id);
      expect(historyLabels().at(-1)).toBe('New Composition');

      await h.run({ type: 'undo' });
      expect(useProjectStore.getState().comps[made.id]).toBeUndefined();
      expect(h.doc()).toBe(before);
      await h.run({ type: 'redo' });
      expect(useProjectStore.getState().comps[made.id]?.name).toBe('Promo');
    });

    it('in a fresh project, configures the pristine comp instead of stacking a second', async () => {
      useProjectStore.getState().actions.updateComp('comp_root', { pristine: true });
      const before = h.doc();
      await create();
      const comps = useProjectStore.getState().comps;
      expect(Object.keys(comps)).toEqual(['comp_root']);
      expect(comps.comp_root).toMatchObject({ name: 'Promo', width: 1920 });
      expect(comps.comp_root?.pristine).toBeUndefined();
      await h.run({ type: 'undo' });
      expect(useProjectStore.getState().comps.comp_root?.pristine).toBe(true);
      expect(h.doc()).toBe(before);
    });
  });
});
