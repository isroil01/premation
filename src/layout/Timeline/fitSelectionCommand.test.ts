/**
 * `timeline.fitSelection` — Shift+; — reads the mounted timeline's tracks
 * and the keyframe selection store, and fits the span they occupy.
 */
import { asTrackId, asKeyId, asNodeId } from '@app-types/common';
import { getCommandRegistry } from '@core/commands/Command';
import { useKeyframeSelectionStore } from '@stores/keyframeSelectionStore';
import { registerTimelineFitSource } from './fitSelection';
import {
  TIMELINE_FIT_SELECTION_COMMAND,
  installTimelineFitCommands,
  resetTimelineFitCommandsForTest,
} from './timelineFitCommands';
import { setTimelineViewportWidth } from './timelineViewport';
import type { TimelineTrack } from './TimelineModel';

const tracks: TimelineTrack[] = [
  {
    id: asTrackId('a'),
    name: 'A',
    clips: [{ id: 'c', trackId: asTrackId('a'), nodeId: asNodeId('a'), start: 2, duration: 3 }],
    keyframes: [
      { id: asKeyId('k1'), nodeId: asNodeId('a'), time: 1 },
      { id: asKeyId('k2'), nodeId: asNodeId('a'), time: 4 },
    ],
  },
];

describe('timeline.fitSelection', () => {
  beforeEach(() => {
    resetTimelineFitCommandsForTest();
    installTimelineFitCommands();
    setTimelineViewportWidth(800);
    useKeyframeSelectionStore.getState().clear();
  });

  it('is disabled with nothing selected and no timeline mounted', () => {
    const cmd = getCommandRegistry().get(TIMELINE_FIT_SELECTION_COMMAND)!;
    expect(cmd.shortcut).toEqual({ key: ';', shift: true });
    expect(cmd.enabled?.()).toBe(false);
  });

  it('enables for a layer selection, and prefers the keyframe selection', () => {
    const off = registerTimelineFitSource(() => ({ tracks, selectedTrackIds: ['a'] }));
    const cmd = getCommandRegistry().get(TIMELINE_FIT_SELECTION_COMMAND)!;
    expect(cmd.enabled?.()).toBe(true);
    useKeyframeSelectionStore.getState().set(new Set(['k1', 'k2']));
    expect(cmd.enabled?.()).toBe(true);
    off();
    expect(cmd.enabled?.()).toBe(false);
  });
});
