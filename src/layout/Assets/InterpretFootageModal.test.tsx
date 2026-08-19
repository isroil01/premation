import { render, screen, fireEvent } from '@testing-library/react';
import { openInterpretFootage } from './InterpretFootageModal';
import { useAssetStore, type ImportedAsset } from '@stores/assetStore';
import { useModalStore } from '@stores/modalStore';

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

  beforeEach(() => {
    useAssetStore.setState({ assets: [sampleAsset] });
    useModalStore.setState({ stack: [] });
  });

  it('opens modal with correct title and initial data', () => {
    openInterpretFootage(sampleAsset);
    const stack = useModalStore.getState().stack;
    expect(stack.length).toBe(1);
    expect(stack[0]?.title).toBe('Interpret Footage: interview_take1.mp4');
  });

  it('allows conforming frame rate and applying interpretation to store', () => {
    openInterpretFootage(sampleAsset);
    const modal = useModalStore.getState().stack[0];
    expect(modal).toBeDefined();

    const { getByText } = render(modal!.render(() => useModalStore.getState().close(modal!.id)));

    // Select conform radio
    const conformRadio = screen.getByLabelText(/Conform to frame rate:/i);
    fireEvent.click(conformRadio);

    // Change conform fps
    const numberInput = screen.getByDisplayValue('29.97');
    fireEvent.change(numberInput, { target: { value: '24' } });

    // Click OK
    const okBtn = getByText('OK');
    fireEvent.click(okBtn);

    const updated = useAssetStore.getState().assets.find((a) => a.id === sampleAsset.id);
    expect(updated?.interpret?.conformFps).toBe(24);
  });

  it('supports pixel aspect ratio presets and looping count', () => {
    openInterpretFootage(sampleAsset);
    const modal = useModalStore.getState().stack[0];

    const { getByText } = render(modal!.render(() => useModalStore.getState().close(modal!.id)));

    // Select Anamorphic 2:1
    const parSelect = screen.getByDisplayValue('Square Pixels (1.0)');
    fireEvent.change(parSelect, { target: { value: '2' } });

    // Change loop count
    const loopInput = screen.getByDisplayValue('1');
    fireEvent.change(loopInput, { target: { value: '5' } });

    // Click OK
    fireEvent.click(getByText('OK'));

    const updated = useAssetStore.getState().assets.find((a) => a.id === sampleAsset.id);
    expect(updated?.interpret?.par).toBe(2);
    expect(updated?.interpret?.loopCount).toBe(5);
  });
});
