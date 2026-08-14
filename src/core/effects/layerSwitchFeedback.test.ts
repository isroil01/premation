import {
  enableLayerMotionBlurWithFeedback,
  disableLayerMotionBlur,
  setAdjustmentWithFeedback,
  guideLayerArmedMessage,
  guideLayerDisarmedMessage,
} from './layerSwitchFeedback';
import { useMotionBlurStore } from '@stores/motionBlurStore';
import { useRenderQualityStore } from '@stores/renderQualityStore';
import { useUIStore } from '@stores/uiStore';

jest.mock('@stores/motionBlurStore', () => ({
  useMotionBlurStore: Object.assign(
    jest.fn(),
    {
      getState: jest.fn(),
    },
  ),
}));

jest.mock('@stores/renderQualityStore', () => ({
  useRenderQualityStore: {
    getState: jest.fn(),
  },
}));

jest.mock('@stores/uiStore', () => ({
  useUIStore: {
    getState: jest.fn(),
  },
}));

jest.mock('@core/effects/effects', () => ({
  getNodeEffects: jest.fn(() => []),
}));

describe('layerSwitchFeedback', () => {
  const notify = jest.fn();
  const setEnabled = jest.fn();

  beforeEach(() => {
    notify.mockClear();
    setEnabled.mockClear();
    (useUIStore.getState as jest.Mock).mockReturnValue({ notify });
    (useMotionBlurStore.getState as jest.Mock).mockReturnValue({
      enabled: false,
      setEnabled,
    });
    (useRenderQualityStore.getState as jest.Mock).mockReturnValue({ draft: false });
  });

  it('enables composition motion blur when the layer opt-in is armed alone', () => {
    const setLayer = jest.fn();
    enableLayerMotionBlurWithFeedback('n1', setLayer);
    expect(setLayer).toHaveBeenCalledWith('n1', true);
    expect(setEnabled).toHaveBeenCalledWith(true);
    expect(notify).toHaveBeenCalled();
  });

  it('warns when draft preview would suppress motion blur samples', () => {
    (useMotionBlurStore.getState as jest.Mock).mockReturnValue({
      enabled: true,
      setEnabled,
    });
    (useRenderQualityStore.getState as jest.Mock).mockReturnValue({ draft: true });
    enableLayerMotionBlurWithFeedback('n1', jest.fn());
    expect(notify.mock.calls.some((c) => /Draft preview/i.test(c[0].message))).toBe(true);
  });

  it('does not touch the composition master when disabling a layer', () => {
    const setLayer = jest.fn();
    disableLayerMotionBlur('n1', setLayer);
    expect(setLayer).toHaveBeenCalledWith('n1', false);
    expect(setEnabled).not.toHaveBeenCalled();
  });

  it('explains empty adjustment stacks', () => {
    setAdjustmentWithFeedback('n1', true, jest.fn());
    expect(notify.mock.calls.some((c) => /add effects/i.test(c[0].message))).toBe(true);
  });

  it('describes guide layers as export-omitted, not viewer-hidden', () => {
    expect(guideLayerArmedMessage()).toMatch(/omitted from export/i);
    expect(guideLayerArmedMessage()).not.toMatch(/hidden from render/i);
    expect(guideLayerDisarmedMessage()).toMatch(/No longer a guide layer/);
  });
});
