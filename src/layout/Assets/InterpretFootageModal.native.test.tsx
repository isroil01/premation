import { act, render, screen, fireEvent } from '@testing-library/react';
import { openInterpretFootage } from './InterpretFootageModal';
import { useAssetStore, type ImportedAsset } from '@stores/assetStore';
import { useModalStore } from '@stores/modalStore';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { engineIdle } from '@core/engine/engineInstance';

describe('InterpretFootageModal', () => {
  // The footage as the engine imported it (the fake port: 640×360, 4 s, 30 fps); the asset store is its view.
  let sampleAsset: ImportedAsset;
  let h: Harness;
  beforeEach(async () => {
    h = await setupAppEngine();
    const { items: [id] } = await h.run({ type: 'importFiles', files: [{ path: 'C:/m/interview_take1.mp4', asSequence: false, createComposition: false }] });
    await engineIdle();
    sampleAsset = useAssetStore.getState().assets.find((a) => a.id === id)!;
    await h.run({ type: 'clearHistory' });
    useModalStore.setState({ stack: [] });
  });
  afterEach(async () => {
    await h.dispose();
  });

  const current = (): ImportedAsset | undefined => useAssetStore.getState().assets.find((a) => a.id === sampleAsset.id);

  it('opens modal with correct title and initial data', async () => {
    openInterpretFootage(sampleAsset);
    const stack = useModalStore.getState().stack;
    expect(stack.length).toBe(1);
    expect(stack[0]?.title).toBe('Interpret Footage: interview_take1.mp4');
  });

  it('conforms the frame rate through the engine: one undo entry, undo restores exactly', async () => {
    const before = (await h.doc());
    openInterpretFootage(sampleAsset);
    const modal = useModalStore.getState().stack[0];
    expect(modal).toBeDefined();

    const { getByText } = render(modal!.render(() => useModalStore.getState().close(modal!.id)));

    fireEvent.click(screen.getByLabelText(/Conform to frame rate:/i));
    fireEvent.change(screen.getByDisplayValue('30'), { target: { value: '24' } });
    await act(async () => {
      fireEvent.click(getByText('OK'));
      await engineIdle();
    });

    expect(current()?.interpret?.conformFps).toBe(24);
    expect((await historyLabels()).at(-1)).toBe('Interpret Footage');
    await h.run({ type: 'undo' });
    expect(current()?.interpret?.conformFps).toBeUndefined();
    expect((await h.doc())).toBe(before);
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
    expect((await historyLabels()).filter((l) => l === 'Interpret Footage')).toHaveLength(1);
  });

  it('OK with nothing changed records nothing', async () => {
    openInterpretFootage(sampleAsset);
    const modal = useModalStore.getState().stack[0];
    const { getByText } = render(modal!.render(() => useModalStore.getState().close(modal!.id)));
    await act(async () => {
      fireEvent.click(getByText('OK'));
      await engineIdle();
    });
    expect((await historyLabels())).not.toContain('Interpret Footage');
  });
});
