/**
 * The Preview panel, laid out as After Effects' (2026-10): the transport row
 * first, then one labelled row per setting this app has — Include, Range,
 * Step, Resolution, Draft — under group rows. No timecode HUD, no keyboard
 * cheat-sheet, no second master meter (the Audio panel has it).
 */

import { act, cleanup, render, screen, fireEvent } from '@testing-library/react';
import { PreviewPanel } from '../PreviewPanel';
import { TooltipProvider } from '@components/Tooltip';
import { useProjectStore } from '@stores/projectStore';
import { getTime } from '@stores/playbackClockStore';
import { secondsToFlicks } from '@motion/engine-api';
import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { useRenderQualityStore } from '@stores/renderQualityStore';
import { audioEngine } from '@core/audio/AudioEngine';

function renderPanel() {
  return render(
    <TooltipProvider>
      <PreviewPanel />
    </TooltipProvider>,
  );
}

let h: Harness;

describe('PreviewPanel', () => {
  beforeEach(async () => {
    // The active composition, through the engine — the panel reads the mirror.
    h = await setupAppEngine();
    const s = useProjectStore.getState();
    const compId = s.activeTabId ? s.tabs[s.activeTabId]?.compositionId : undefined;
    await act(async () => {
      await h.run({
        type: 'setCompositionSettings',
        comp: compId ?? 'comp_root',
        patch: { width: 1920, height: 1080, frameRate: { num: 30, den: 1 }, duration: secondsToFlicks(10) },
      });
      await engineIdle();
    });
    // Reset quality store
    useRenderQualityStore.setState({
      adaptive: true,
      resolution: 1,
      draft: false,
    });
    // Reset mute state
    audioEngine.setMasterMuted(false);
  });

  afterEach(async () => {
    cleanup();
    await h.dispose();
  });

  it('is the transport row, then labelled setting rows under group rows — no HUD, cheat-sheet or meter', async () => {
    const { container } = renderPanel();
    const transport = screen.getByRole('toolbar', { name: 'Preview transport controls' });
    // The transport comes first.
    expect(container.querySelector('[role="toolbar"]')).toBe(transport);
    for (const name of ['First frame (Home)', 'Previous frame', 'Play', 'Next frame', 'Last frame (End)', /^(Enable|Disable) loop$/]) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
    for (const label of ['Range', 'Step', 'Resolution']) expect(screen.getByLabelText(label)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Include audio' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Draft quality' })).toBeInTheDocument();
    for (const name of ['Playback', 'Quality']) {
      expect(screen.getByRole('button', { name })).toHaveAttribute('aria-expanded', 'true');
    }

    expect(screen.queryByText('Pro Keyboard Shortcuts')).not.toBeInTheDocument();
    expect(screen.queryByText('Paused')).not.toBeInTheDocument();
    expect(screen.queryByText('Audio Monitoring')).not.toBeInTheDocument();
    expect(screen.queryByText(/1920×1080/)).not.toBeInTheDocument();
  });

  it('toggles playback via the play button', async () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument();
  });

  it('sets the range from its dropdown', async () => {
    renderPanel();
    const range = screen.getByLabelText('Range') as HTMLSelectElement;
    expect([...range.options].map((o) => o.text)).toEqual(['Work Area', 'Entire Composition', 'From Current Time']);

    fireEvent.change(range, { target: { value: 'entire-comp' } });
    expect(range.value).toBe('entire-comp');
    fireEvent.change(range, { target: { value: 'current-forward' } });
    expect(range.value).toBe('current-forward');
    fireEvent.change(range, { target: { value: 'work-area' } });
    expect(range.value).toBe('work-area');
  });

  it('the Step row sets how far the step buttons move', async () => {
    renderPanel();
    const step = screen.getByLabelText('Step') as HTMLSelectElement;
    fireEvent.change(step, { target: { value: '1' } });
    expect(step.value).toBe('1');

    const before = getTime();
    fireEvent.click(screen.getByRole('button', { name: 'Next frame' }));
    // Two frames at 30 fps.
    expect(getTime() - before).toBeCloseTo(2 / 30, 5);

    fireEvent.change(step, { target: { value: '5' } });
    expect(step.value).toBe('5');
  });

  it('sets the resolution and the draft quality', async () => {
    renderPanel();
    const resolution = screen.getByLabelText('Resolution') as HTMLSelectElement;
    fireEvent.change(resolution, { target: { value: '2' } });
    expect(useRenderQualityStore.getState().resolution).toBe(2);
    expect(useRenderQualityStore.getState().adaptive).toBe(false);

    fireEvent.change(resolution, { target: { value: 'auto' } });
    expect(useRenderQualityStore.getState().adaptive).toBe(true);

    const draft = screen.getByRole('button', { name: 'Draft quality' });
    fireEvent.click(draft);
    expect(useRenderQualityStore.getState().draft).toBe(true);
    expect(draft).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(draft);
    expect(useRenderQualityStore.getState().draft).toBe(false);
  });

  it('Include ▸ audio mutes and unmutes the preview', async () => {
    renderPanel();
    const audio = screen.getByRole('button', { name: 'Include audio' });
    expect(audio).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(audio);
    expect(audioEngine.isMasterMuted()).toBe(true);
    expect(audio).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(audio);
    expect(audioEngine.isMasterMuted()).toBe(false);
  });
});
