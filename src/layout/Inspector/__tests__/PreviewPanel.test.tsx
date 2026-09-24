import { act, cleanup, render, screen, fireEvent } from '@testing-library/react';
import { PreviewPanel } from '../PreviewPanel';
import { TooltipProvider } from '@components/Tooltip';
import { useProjectStore } from '@stores/projectStore';
import { secondsToFlicks } from '@motion/engine-api';
import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
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

let h: Harness & { engine: LocalEngine };

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

  it('renders timecode HUD, status pill, and composition specs', () => {
    renderPanel();
    expect(screen.getByText(/1920×1080 · 30 fps/)).toBeInTheDocument();
    expect(screen.getByText('Paused')).toBeInTheDocument();
    expect(screen.getByText(/300/)).toBeInTheDocument();
  });

  it('toggles playback via hero play button', () => {
    renderPanel();
    const playBtn = screen.getByRole('button', { name: 'Play' });
    expect(playBtn).toBeInTheDocument();

    fireEvent.click(playBtn);
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
    expect(screen.getByText('Playing')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument();
    expect(screen.getByText('Paused')).toBeInTheDocument();
  });

  it('updates range selection via segmented control', () => {
    renderPanel();
    const entireCompBtn = screen.getByRole('radio', { name: 'Entire Comp' });
    const fromTimeBtn = screen.getByRole('radio', { name: 'From Time' });
    const workAreaBtn = screen.getByRole('radio', { name: 'Work Area' });

    expect(workAreaBtn).toBeInTheDocument();
    fireEvent.click(entireCompBtn);
    expect(entireCompBtn).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(fromTimeBtn);
    expect(fromTimeBtn).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(workAreaBtn);
    expect(workAreaBtn).toHaveAttribute('aria-checked', 'true');
  });

  it('updates step jump multiplier', () => {
    renderPanel();
    const step2Btn = screen.getByRole('radio', { name: '2 Frames' });
    fireEvent.click(step2Btn);
    expect(step2Btn).toHaveAttribute('aria-checked', 'true');

    const step6Btn = screen.getByRole('radio', { name: '6 Frames' });
    fireEvent.click(step6Btn);
    expect(step6Btn).toHaveAttribute('aria-checked', 'true');
  });

  it('updates resolution and draft quality toggles', () => {
    renderPanel();
    const halfBtn = screen.getByRole('radio', { name: 'Half' });
    fireEvent.click(halfBtn);
    expect(useRenderQualityStore.getState().resolution).toBe(2);
    expect(useRenderQualityStore.getState().adaptive).toBe(false);

    const autoBtn = screen.getByRole('radio', { name: 'Auto' });
    fireEvent.click(autoBtn);
    expect(useRenderQualityStore.getState().adaptive).toBe(true);

    const draftBtn = screen.getByRole('button', { name: /Toggle Draft Quality/i });
    fireEvent.click(draftBtn);
    expect(useRenderQualityStore.getState().draft).toBe(true);

    fireEvent.click(draftBtn);
    expect(useRenderQualityStore.getState().draft).toBe(false);
  });

  it('toggles audio mute', () => {
    renderPanel();
    const muteBtn = screen.getByRole('button', { name: /Mute preview audio/i });
    fireEvent.click(muteBtn);
    expect(audioEngine.isMasterMuted()).toBe(true);

    const unmuteBtn = screen.getByRole('button', { name: /Unmute preview audio/i });
    fireEvent.click(unmuteBtn);
    expect(audioEngine.isMasterMuted()).toBe(false);
  });
});
