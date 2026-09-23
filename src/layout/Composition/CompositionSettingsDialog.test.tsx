import { act, render as rtlRender, screen, fireEvent } from '@testing-library/react';
import { openCompositionSettings, CompositionSettings } from './CompositionSettingsDialog';
import { useModalStore } from '@stores/modalStore';
import { useProjectStore } from '@stores/projectStore';
import { useCompositionStore, DEFAULT_COMPOSITION } from '@stores/compositionStore';
import { TooltipProvider } from '@components/Tooltip';
import { getTimelineController } from '@core/timeline/TimelineController';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { engineIdle } from '@core/engine/engineInstance';

const render = (ui: React.ReactElement) => rtlRender(ui, { wrapper: TooltipProvider });

/**
 * The dialog edits a DRAFT; Save Changes sends the changed fields as one
 * engine edit (`setCompositionSettings`), Cancel writes nothing.
 */
describe('CompositionSettingsDialog', () => {
  const compId = 'comp_root';
  let h: Harness & { engine: LocalEngine };

  beforeEach(async () => {
    h = await setupAppEngine();
    useModalStore.setState({ stack: [] });
    useProjectStore.getState().actions.updateComp(compId, {
      ...DEFAULT_COMPOSITION,
      id: compId,
      name: 'Main Showcase',
      width: 1920,
      height: 1080,
      fps: 30,
      durationSeconds: 10,
      background: '#101014',
      transparent: false,
      pristine: undefined,
    });
    useProjectStore.getState().actions.openTab(compId, [compId], 'Main Showcase');
  });
  afterEach(async () => {
    await h.dispose();
  });

  const comp = () => useCompositionStore.getState().comp();

  it('opens modal with size "lg", descriptive subtitle, and title "Composition Settings"', () => {
    openCompositionSettings();
    const stack = useModalStore.getState().stack;
    expect(stack.length).toBe(1);
    expect(stack[0]?.title).toBe('Composition Settings');
    expect(stack[0]?.size).toBe('lg');
    expect(stack[0]?.description).toContain('Main Showcase');
    expect(stack[0]?.description).toContain('1920 × 1080');
    expect(stack[0]?.description).toContain('30 fps');
  });

  it('renders initial composition values and live visual preview', () => {
    render(<CompositionSettings close={jest.fn()} />);
    expect(screen.getByLabelText(/composition name/i)).toHaveValue('Main Showcase');
    expect(screen.getByText('1920 × 1080 px')).toBeInTheDocument();
    expect(screen.getByText('Landscape')).toBeInTheDocument();
    expect(screen.getAllByText('16:9').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/30 fps/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('YouTube 1080p').length).toBeGreaterThanOrEqual(1);
  });

  it('updates resolution, locks aspect ratio, and swaps dimensions — in the draft only', () => {
    render(<CompositionSettings close={jest.fn()} />);

    fireEvent.click(screen.getByLabelText(/swap width and height/i));
    expect(screen.getByText('Portrait')).toBeInTheDocument();
    expect(screen.getAllByText('9:16').length).toBeGreaterThanOrEqual(1);
    // Nothing is written until Save.
    expect(comp().width).toBe(1920);

    fireEvent.click(screen.getByLabelText(/lock aspect ratio/i));
    expect(screen.getByLabelText(/unlock aspect ratio/i)).toBeInTheDocument();

    const widthSpin = screen.getByRole('spinbutton', { name: 'Width' });
    fireEvent.keyDown(widthSpin, { key: 'Enter' });
    const widthInput = screen.getByDisplayValue('1080');
    fireEvent.change(widthInput, { target: { value: '540' } });
    fireEvent.blur(widthInput);
    expect(screen.getByText('540 × 960 px')).toBeInTheDocument();
  });

  it('selects quick popular presets', () => {
    render(<CompositionSettings close={jest.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /4K UHD/i }));
    expect(screen.getByText('3840 × 2160 px')).toBeInTheDocument();
  });

  it('switches to Background tab and updates transparency and studio swatches', () => {
    render(<CompositionSettings close={jest.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: /background/i }));
    expect(screen.getByText(/scene canvas background/i)).toBeInTheDocument();

    const transparentSwitch = screen.getByRole('switch', { name: /canvas transparency/i });
    expect(transparentSwitch).not.toBeChecked();
    fireEvent.click(transparentSwitch);
    expect(screen.getByRole('switch', { name: /canvas transparency/i })).toBeChecked();

    fireEvent.click(screen.getByLabelText(/studio dark/i));
    expect(screen.getByRole('switch', { name: /canvas transparency/i })).not.toBeChecked();
  });

  it('switches between all tabs without errors', () => {
    render(<CompositionSettings close={jest.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: /grid & guides/i }));
    expect(screen.getByText(/pixel grid/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /world/i }));
    expect(screen.getByText(/default sky preset/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /time/i }));
    expect(screen.getByText(/responsive time/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /color/i }));
    expect(screen.getByText(/working space/i)).toBeInTheDocument();
  });

  it('Cancel writes nothing and records nothing', async () => {
    const before = h.doc();
    const close = jest.fn();
    render(<CompositionSettings close={close} />);
    fireEvent.change(screen.getByLabelText(/composition name/i), { target: { value: 'Modified Name' } });
    fireEvent.click(screen.getByRole('button', { name: /4K UHD/i }));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
      await engineIdle();
    });
    expect(close).toHaveBeenCalledTimes(1);
    expect(comp().name).toBe('Main Showcase');
    expect(comp().width).toBe(1920);
    expect(historyLabels()).not.toContain('Composition Settings');
    expect(h.doc()).toBe(before);
  });

  it('Save Changes is ONE engine entry; undo restores exactly, redo reapplies', async () => {
    const before = h.doc();
    const close = jest.fn();
    render(<CompositionSettings close={close} />);
    fireEvent.change(screen.getByLabelText(/composition name/i), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: /4K UHD/i }));
    fireEvent.click(screen.getByRole('button', { name: /^60 fps/i }));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
      await engineIdle();
    });

    expect(close).toHaveBeenCalledTimes(1);
    expect(comp()).toMatchObject({ name: 'Renamed', width: 3840, height: 2160, fps: 60 });
    expect(getTimelineController().timelineForComp(compId)?.timeline.getFrameRate().fps).toBe(60);
    expect(historyLabels().filter((l) => l === 'Composition Settings')).toHaveLength(1);

    await h.run({ type: 'undo' });
    expect(comp()).toMatchObject({ name: 'Main Showcase', width: 1920, height: 1080, fps: 30 });
    expect(h.doc()).toBe(before);
    await h.run({ type: 'redo' });
    expect(comp()).toMatchObject({ name: 'Renamed', width: 3840, fps: 60 });
  });

  it('an NTSC rate is stored as typed (29.97, not 30000/1001)', async () => {
    render(<CompositionSettings close={jest.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /^29\.97 fps/i }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
      await engineIdle();
    });
    expect(comp().fps).toBe(29.97);
  });
});
