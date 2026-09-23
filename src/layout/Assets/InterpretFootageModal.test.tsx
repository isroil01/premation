import { act, render, screen, fireEvent } from '@testing-library/react';
import { openInterpretFootage } from './InterpretFootageModal';
import { useAssetStore, type ImportedAsset } from '@stores/assetStore';
import { useModalStore } from '@stores/modalStore';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { engineIdle } from '@core/engine/engineInstance';

describe('InterpretFootageModal', () => {
  const sampleAsset: ImportedAsset = {
    id: 'test-asset-1',
    name: 'interview_take1.mp4',
    type: 'video',
    src: 'blob:video1',
    size: 1048576,
    metadata: {
      width: 1920,
      height: 1080,
      fps: 29.97,
      duration: 12.5,
      hasAlpha: false,
    },
  };

  let h: Harness & { engine: LocalEngine };
  beforeEach(async () => {
    h = await setupAppEngine();
    useAssetStore.setState({ assets: [sampleAsset], folders: [] });
    useModalStore.setState({ stack: [] });
  });
  afterEach(async () => {
    await h.dispose();
  });

  const current = (): ImportedAsset | undefined => useAssetStore.getState().assets.find((a) => a.id === sampleAsset.id);

  it('opens modal with correct title and initial data', () => {
    openInterpretFootage(sampleAsset);
    const stack = useModalStore.getState().stack;
    expect(stack.length).toBe(1);
    expect(stack[0]?.title).toBe('Interpret Footage: interview_take1.mp4');
  });

  it('conforms the frame rate through the engine: one undo entry, undo restores exactly', async () => {
    const before = h.doc();
    openInterpretFootage(sampleAsset);
    const modal = useModalStore.getState().stack[0];
    expect(modal).toBeDefined();

    const { getByText } = render(modal!.render(() => useModalStore.getState().close(modal!.id)));

    fireEvent.click(screen.getByLabelText(/Conform to frame rate:/i));
    fireEvent.change(screen.getByDisplayValue('29.97'), { target: { value: '24' } });
    await act(async () => {
      fireEvent.click(getByText('OK'));
      await engineIdle();
    });

    expect(current()?.interpret?.conformFps).toBe(24);
    expect(historyLabels().at(-1)).toBe('Interpret Footage');
    await h.run({ type: 'undo' });
    expect(current()?.interpret?.conformFps).toBeUndefined();
    expect(h.doc()).toBe(before);
    await h.run({ type: 'redo' });
    expect(current()?.interpret?.conformFps).toBe(24);
  });

  it('supports pixel aspect ratio presets and looping count', async () => {
    openInterpretFootage(sampleAsset);
    const modal = useModalStore.getState().stack[0];

    const { getByText } = render(modal!.render(() => useModalStore.getState().close(modal!.id)));

    // Select Anamorphic 2:1
    fireEvent.change(screen.getByDisplayValue('Square Pixels (1.0)'), { target: { value: '2' } });
    // Change loop count
    fireEvent.change(screen.getByDisplayValue('1'), { target: { value: '5' } });

    await act(async () => {
      fireEvent.click(getByText('OK'));
      await engineIdle();
    });

    expect(current()?.interpret?.par).toBe(2);
    expect(current()?.interpret?.loopCount).toBe(5);
    expect(historyLabels().filter((l) => l === 'Interpret Footage')).toHaveLength(1);
  });

  it('OK with nothing changed records nothing', async () => {
    openInterpretFootage(sampleAsset);
    const modal = useModalStore.getState().stack[0];
    const { getByText } = render(modal!.render(() => useModalStore.getState().close(modal!.id)));
    await act(async () => {
      fireEvent.click(getByText('OK'));
      await engineIdle();
    });
    expect(historyLabels()).not.toContain('Interpret Footage');
  });
});
