import { defaultAnimation } from '@motion/animation';
import { useSelectionStore } from '@stores/selectionStore';
import { useKeyframeSelectionStore } from '@stores/keyframeSelectionStore';
import { copySelection, pasteSelection } from './clipboard';
import { getTimelineController } from '@core/timeline/TimelineController';

describe('Clipboard Copy-Paste System', () => {
  beforeEach(() => {
    useSelectionStore.getState().clear();
    useKeyframeSelectionStore.getState().clear();
    defaultAnimation.tracksFor('layer1').forEach((t) => {
      t.keyframes.forEach((k) => defaultAnimation.removeKeyframe('layer1', t.prop, getTimelineController().toLayerTime('layer1', k.t)));
    });
    defaultAnimation.tracksFor('layer2').forEach((t) => {
      t.keyframes.forEach((k) => defaultAnimation.removeKeyframe('layer2', t.prop, getTimelineController().toLayerTime('layer2', k.t)));
    });
  });

  test('copies and pastes keyframes onto selected layers', () => {
    // 1. Setup track with keyframes on layer1
    defaultAnimation.setKeyframe('layer1', 'x', getTimelineController().toLayerTime('layer1', 2.0), 100);
    defaultAnimation.setKeyframe('layer1', 'x', getTimelineController().toLayerTime('layer1', 3.0), 200);

    // 2. Select keyframes
    useKeyframeSelectionStore.getState().set(new Set(['layer1::x@2.0', 'layer1::x@3.0']));

    // 3. Copy keyframes
    copySelection();

    // 4. Select target layer2
    useSelectionStore.getState().set(['layer2']);

    // 5. Paste keyframes (at playhead time = 5.0)
    // We mock timeline playhead via composition / timeline controller indirectly, or we can mock getTimelineController
    // since currentSeconds is mocked or set in TimelineController
    // Let's verify that keyframes paste at current time
    pasteSelection();

    // Verify keyframes on layer2
    const targetKfs = defaultAnimation.getTrackKeyframes('layer2', 'x');
    expect(targetKfs).toBeDefined();
    if (targetKfs) {
      expect(targetKfs.length).toBe(2);
      expect(targetKfs[0]!.value).toBe(100);
      expect(targetKfs[1]!.value).toBe(200);
    }
  });
});
