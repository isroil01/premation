import { act, render as rtlRender, screen, fireEvent } from '@testing-library/react';
import { openCompositionSettings, CompositionSettings, gradientCss } from './CompositionSettingsDialog';
import { useModalStore } from '@stores/modalStore';
import { useProjectStore } from '@stores/projectStore';
import { useCompositionStore } from '@stores/compositionStore';
import { TooltipProvider } from '@components/Tooltip';
import { setupAppEngine, historyLabels, settleEdits } from '@core/engine/__testHelpers__/appEngine';
import { docView } from '@core/engine/__testHelpers__/docView';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { documentMirror } from '@stores/documentMirror';
import { useGuidesStore } from '@stores/guidesStore';
import { useColorManagementStore } from '@stores/colorManagementStore';
import { compRecordFromSettings } from '@core/mirror/compFacts';

const render = (ui: React.ReactElement) => rtlRender(ui, { wrapper: TooltipProvider });

/**
 * The dialog edits a DRAFT; Save Changes sends the changed fields as one
 * engine edit (`setCompositionSettings`), Cancel writes nothing.
 */
describe('CompositionSettingsDialog', () => {
  const compId = 'comp_root';
  let h: Harness;

  beforeEach(async () => {
    h = await setupAppEngine({ panels: true });
    useModalStore.setState({ stack: [] });
    await h.run({ type: 'setCompositionSettings', comp: compId, patch: {
      name: 'Main Showcase', width: 1920, height: 1080, frameRate: { num: 30, den: 1 },
      duration: 10 * 705_600_000, background: { r: 16 / 255, g: 16 / 255, b: 20 / 255, a: 1 }, transparent: false, pristine: false,
    } });
    await h.run({ type: 'clearHistory' });
    useProjectStore.getState().actions.openTab(compId, [compId], 'Main Showcase');
  });
  afterEach(async () => {
    await h.dispose();
  });

  const comp = () => useCompositionStore.getState().comp();

  it('opens modal with size "lg", descriptive subtitle, and title "Composition Settings"', async () => {
    openCompositionSettings();
    const stack = useModalStore.getState().stack;
    expect(stack.length).toBe(1);
    expect(stack[0]?.title).toBe('Composition Settings');
    expect(stack[0]?.size).toBe('lg');
    expect(stack[0]?.description).toContain('Main Showcase');
    expect(stack[0]?.description).toContain('1920 × 1080');
    expect(stack[0]?.description).toContain('30 fps');
  });

  it('renders initial composition values and live visual preview', async () => {
    render(<CompositionSettings close={jest.fn()} />);
    expect(screen.getByLabelText(/composition name/i)).toHaveValue('Main Showcase');
    expect(screen.getByText('1920 × 1080 px')).toBeInTheDocument();
    expect(screen.getByText('Landscape')).toBeInTheDocument();
    expect(screen.getAllByText('16:9').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/30 fps/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('YouTube 1080p').length).toBeGreaterThanOrEqual(1);
  });

  it('updates resolution, locks aspect ratio, and swaps dimensions — in the draft only', async () => {
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

  it('selects quick popular presets', async () => {
    render(<CompositionSettings close={jest.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /4K UHD/i }));
    expect(screen.getByText('3840 × 2160 px')).toBeInTheDocument();
  });

  it('switches to Background tab and updates transparency and studio swatches', async () => {
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

  it('switches between all tabs without errors', async () => {
    render(<CompositionSettings close={jest.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: /grid & guides/i }));
    expect(screen.getByText(/pixel grid/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /world/i }));
    expect(screen.getByText(/default sky preset/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /renderer/i }));
    expect(screen.getByText(/shadow map size/i)).toBeInTheDocument();
    expect(screen.getByText(/ambient occlusion \(ssao\)/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /time/i }));
    expect(screen.getByText(/responsive time/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /color/i }));
    expect(screen.getByText(/working space/i)).toBeInTheDocument();
  });

  it('Cancel writes nothing and records nothing', async () => {
    const before = (await h.doc());
    const close = jest.fn();
    render(<CompositionSettings close={close} />);
    fireEvent.change(screen.getByLabelText(/composition name/i), { target: { value: 'Modified Name' } });
    fireEvent.click(screen.getByRole('button', { name: /4K UHD/i }));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
      await settleEdits();
    });
    expect(close).toHaveBeenCalledTimes(1);
    expect(comp().name).toBe('Main Showcase');
    expect(comp().width).toBe(1920);
    expect((await historyLabels())).not.toContain('Composition Settings');
    expect((await h.doc())).toBe(before);
  });

  it('Save Changes is ONE engine entry; undo restores exactly, redo reapplies', async () => {
    const before = (await h.doc());
    const close = jest.fn();
    render(<CompositionSettings close={close} />);
    fireEvent.change(screen.getByLabelText(/composition name/i), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: /4K UHD/i }));
    fireEvent.click(screen.getByRole('button', { name: /^60 fps/i }));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
      await settleEdits();
    });

    expect(close).toHaveBeenCalledTimes(1);
    expect(comp()).toMatchObject({ name: 'Renamed', width: 3840, height: 2160, fps: 60 });
    expect((await docView()).timelineForComp(compId)?.frameRate.fps).toBe(60);
    expect((await historyLabels()).filter((l) => l === 'Composition Settings')).toHaveLength(1);

    await h.run({ type: 'undo' });
    expect(comp()).toMatchObject({ name: 'Main Showcase', width: 1920, height: 1080, fps: 30 });
    expect((await h.doc())).toBe(before);
    await h.run({ type: 'redo' });
    expect(comp()).toMatchObject({ name: 'Renamed', width: 3840, fps: 60 });
  });

  it('an NTSC rate is stored as typed (29.97, not 30000/1001)', async () => {
    render(<CompositionSettings close={jest.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /^29\.97 fps/i }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
      await settleEdits();
    });
    expect(comp().fps).toBe(29.97);
  });

  describe('Grid & Guides and Color are drafts', () => {
    const grid0 = useGuidesStore.getState().grid;
    const spacing0 = useGuidesStore.getState().gridSpacing;
    const dt0 = useColorManagementStore.getState().displayTransform;
    afterEach(() => {
      useGuidesStore.setState({ grid: grid0, gridSpacing: spacing0, gridStyle: 'lines' });
      useColorManagementStore.setState({ displayTransform: dt0 });
    });

    const projectSettings = async (): Promise<{ linearBlending?: boolean; workingSpace?: string }> => {
      await settleEdits();
      return { ...documentMirror().settings };
    };

    const editDrafts = (): void => {
      fireEvent.click(screen.getByRole('tab', { name: /grid & guides/i }));
      fireEvent.click(screen.getByRole('switch', { name: /show grid/i }));
      fireEvent.change(screen.getByLabelText(/grid style/i), { target: { value: 'dots' } });
      fireEvent.click(screen.getByRole('tab', { name: /color/i }));
      fireEvent.click(screen.getByRole('button', { name: /^ACES \(sRGB ODT\)/i }));
      fireEvent.click(screen.getByRole('button', { name: /^Linear \(1\.0 gamma\)/i }));
      fireEvent.change(screen.getByLabelText(/project colour management/i), { target: { value: 'rec2020' } });
    };

    it('Cancel leaves the view, the colour settings and the project alone', async () => {
      const before = await projectSettings();
      render(<CompositionSettings close={jest.fn()} />);
      editDrafts();
      // The chosen value shows in the dialog while nothing has been applied.
      expect(screen.getByLabelText(/project colour management/i)).toHaveValue('rec2020');
      expect(useGuidesStore.getState().gridStyle).toBe('lines');
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
        await settleEdits();
      });
      expect(useGuidesStore.getState().grid).toBe(grid0);
      expect(useGuidesStore.getState().gridStyle).toBe('lines');
      expect(useColorManagementStore.getState().displayTransform).toBe(dt0);
      expect(await projectSettings()).toEqual(before);
    });

    it('Save Changes applies them all, the document part as one undo entry', async () => {
      render(<CompositionSettings close={jest.fn()} />);
      editDrafts();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
        await settleEdits();
      });
      expect(useGuidesStore.getState().grid).toBe(!grid0);
      expect(useGuidesStore.getState().gridStyle).toBe('dots');
      expect(useColorManagementStore.getState().displayTransform).toBe('aces');
      expect((await projectSettings()).linearBlending).toBe(true);
      expect((await projectSettings()).workingSpace).toBe('rec2020');
      expect((await historyLabels()).filter((l) => l === 'Composition Settings')).toHaveLength(1);
    });
  });

  it('the preview draws a gradient as the engine does', () => {
    const stops = [{ id: 'a', offset: 0, color: '#000000' }, { id: 'b', offset: 1, color: '#ffffff' }];
    // A paint's 90° is ↓, which is CSS 180°.
    expect(gradientCss({ type: 'linear', angle: 90, stops }, 200, 100)).toContain('linear-gradient(180deg');
    // A radius is a fraction of the half-diagonal; the centre is honoured.
    expect(gradientCss({ type: 'radial', cx: 0.25, cy: 0.5, radius: 1, stops }, 300, 400)).toContain('circle 250px at 25% 50%');
    expect(gradientCss({ type: 'solid', color: '#000000' }, 200, 100)).toBeNull();
  });

  it('Background tab: a gradient saves to the document', async () => {
    render(<CompositionSettings close={jest.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: /background/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Linear$/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
      await settleEdits();
    });
    expect(JSON.parse(documentMirror().comp(compId)?.settings.backgroundPaint ?? '{}')).toMatchObject({ type: 'linear', angle: 90 });
  });

  it('Time: start frame, duration and pixel aspect save and read back', async () => {
    render(<CompositionSettings close={jest.fn()} />);
    const type = (name: string | RegExp, value: string): void => {
      fireEvent.keyDown(screen.getByRole('spinbutton', { name }), { key: 'Enter' });
      const input = screen.getByRole('textbox', { name });
      fireEvent.change(input, { target: { value } });
      fireEvent.blur(input);
    };
    type(/start timecode/i, '48');
    type('Duration', '5');
    fireEvent.change(screen.getByLabelText(/pixel aspect ratio preset/i), { target: { value: screen.getAllByRole('option', { name: /D1\/DV NTSC/i })[0]!.getAttribute('value') } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
      await settleEdits();
    });
    const rec = compRecordFromSettings(compId, documentMirror().comp(compId)!.settings);
    expect(rec.startFrame).toBe(48);
    expect(rec.durationSeconds).toBe(5);
    expect(rec.pixelAspect).toBeCloseTo(0.9091, 3);
  });

  it('Renderer tab: shadow-map size, light cap, DOF quality and MSAA save under the composition World JSON, one entry, undoable (U3)', async () => {
    render(<CompositionSettings close={jest.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: /renderer/i }));
    fireEvent.change(screen.getByLabelText(/shadow map size/i), { target: { value: '2048' } });
    fireEvent.change(screen.getByLabelText(/depth of field quality/i), { target: { value: 'high' } });
    fireEvent.change(screen.getByLabelText(/multisample anti-aliasing/i), { target: { value: '1' } });
    fireEvent.click(screen.getByLabelText(/enable ambient occlusion/i));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
      await settleEdits();
    });
    const world = JSON.parse(documentMirror().comp(compId)?.settings.world ?? '{}') as { renderer?: unknown; ssao?: { enabled: boolean } };
    // The SSAO half rides the key the engine already keeps: the tab's save path is proven by it.
    expect(world.ssao?.enabled).toBe(true);
    expect((await historyLabels()).filter((l) => l === 'Composition Settings')).toHaveLength(1);
    // The renderer block rides the World JSON: the engine keeps it
    // (handlers_comps.cpp / readmodel.cpp whitelist `renderer`) and the mirror
    // hands it back as `renderer` on the composition.
    expect(world.renderer).toEqual({ shadowMapSize: 2048, shadowLightCap: 4, dofQuality: 'high', msaa: 1 });
    expect(comp().renderer).toEqual({ shadowMapSize: 2048, shadowLightCap: 4, dofQuality: 'high', msaa: 1 });
    await h.run({ type: 'undo' });
    expect(comp().renderer).toBeUndefined();
    expect(comp().ssao?.enabled ?? false).toBe(false);
  });
});
