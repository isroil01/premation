/**
 * The timeline's Collapse / Continuous Rasterize, Quality and Frame Blending
 * switches, and Select Label Group — the helpers, then the switches as the
 * track header renders them.
 */

import { act, render, screen, fireEvent } from '@testing-library/react';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useSelectionStore } from '@stores/selectionStore';
import { readContinuousRaster } from '@core/scene/continuousRaster';
import { readNodeQuality } from '@core/effects/layerQuality';
import { getNodeLayerTime } from '@core/scene/layerTime';
import { engineIdle } from '@core/engine/engineInstance';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import type { TimelineTrack } from './TimelineModel';
import {
  collapseSwitchKind,
  toggleCollapseSwitch,
  toggleQualitySwitch,
  frameBlendSwitchAvailable,
  toggleFrameBlendSwitch,
  selectLabelGroup,
} from './layerSwitches';
import { TrackHeader } from './TrackHeaderColumn';

class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

// The switches write through the engine API (B3): the layers are built through
// the engine, and every toggle is awaited before the prop is read.
let h: Harness & { engine: LocalEngine };
let TEXT = '';
let VIDEO = '';
let NUL = '';

async function idle(): Promise<void> {
  await act(async () => { await engineIdle(); });
}

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = StubResizeObserver;
});

beforeEach(async () => {
  h = await setupAppEngine();
  const comp = 'comp_root';
  const { items: [footage] } = await h.run({
    type: 'importFiles',
    files: [{ path: 'C:/media/clip.mp4', asSequence: false, createComposition: false }],
  });
  const mk = async (kind: 'text' | 'video' | 'null', name: string, label: number, source?: string): Promise<string> => {
    const { layer } = await h.run({ type: 'createLayer', comp, kind, name, ...(source ? { source } : {}), init: [] });
    await h.run({ type: 'setLayerSwitches', layers: [layer], patch: { label } });
    return layer;
  };
  // Labels: 3 = Warm Coral (#d0705a), 1 = Slate Blue (#5282b8).
  TEXT = await mk('text', TEXT, 3);
  VIDEO = await mk('video', VIDEO, 3, footage);
  NUL = await mk('null', NUL, 1);
});

afterEach(async () => {
  await h.dispose();
});

describe('switch helpers', () => {
  it('the sunburst is Continuous Rasterize on vector layers and nothing on a null', async () => {
    expect(collapseSwitchKind(defaultSceneGraph.getNode(TEXT))).toBe('raster');
    expect(collapseSwitchKind(defaultSceneGraph.getNode(NUL))).toBeNull();
    toggleCollapseSwitch(TEXT);
    await idle();
    // The legacy label, kept: `toggleLayerFlags` named the column, not the meaning.
    expect(historyLabels().at(-1)).toBe('Enable Collapse Transformations');
    expect(readContinuousRaster(defaultSceneGraph.getNode(TEXT)!)).toBe(true);
  });

  it('quality cycles Best → Draft → Wireframe → Best, like AE', async () => {
    expect(toggleQualitySwitch(VIDEO)).toBe('draft');
    await idle();
    expect(readNodeQuality(defaultSceneGraph.getNode(VIDEO)!)).toBe('draft');
    expect(historyLabels().at(-1)).toBe('Quality: Draft');
    expect(toggleQualitySwitch(VIDEO)).toBe('wireframe');
    await idle();
    expect(readNodeQuality(defaultSceneGraph.getNode(VIDEO)!)).toBe('wireframe');
    expect(toggleQualitySwitch(VIDEO)).toBe('best');
    await idle();
    expect(readNodeQuality(defaultSceneGraph.getNode(VIDEO)!)).toBe('best');
  });

  it('frame blending only on layers with frames, Off ↔ Frame Mix', async () => {
    expect(frameBlendSwitchAvailable(defaultSceneGraph.getNode(TEXT))).toBe(false);
    expect(frameBlendSwitchAvailable(defaultSceneGraph.getNode(VIDEO))).toBe(true);
    toggleFrameBlendSwitch(VIDEO);
    await idle();
    expect(getNodeLayerTime(VIDEO).frameBlend).toBe('mix');
    await h.run({ type: 'undo' });
    expect(getNodeLayerTime(VIDEO).frameBlend ?? 'none').toBe('none');
    await h.run({ type: 'redo' });
    expect(getNodeLayerTime(VIDEO).frameBlend).toBe('mix');
    toggleFrameBlendSwitch(VIDEO);
    await idle();
    expect(getNodeLayerTime(VIDEO).frameBlend).toBe('none');
  });

  it('Select Label Group selects every layer with the same label', () => {
    const ids = selectLabelGroup(TEXT);
    expect(ids).toEqual(expect.arrayContaining([TEXT, VIDEO]));
    expect(ids).not.toContain(NUL);
    expect(useSelectionStore.getState().ids).toEqual(ids);
  });
});

describe('TrackHeader switches', () => {
  const track = (id: string): TimelineTrack => ({ id: id as never, name: id });
  const renderRow = (id: string): void => {
    render(
      <TrackHeader
        track={track(id)}
        index={1}
        selected={false}
        expanded={false}
        hasProps={false}
        extraColumns={[]}
        frameRate={30}
        active
        onRowFocus={() => {}}
        onToggleExpand={() => {}}
        onActivate={() => {}}
        onClick={() => {}}
        onToggleVisible={() => {}}
        onToggleLock={() => {}}
        onToggleSolo={() => {}}
        style={{}}
      />,
    );
  };

  it('a text layer shows Continuous Rasterize and Quality; clicking them writes the props', async () => {
    renderRow(TEXT);
    const cr = screen.getByRole('button', { name: 'Continuous Rasterize' });
    expect(cr).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(cr);
    await idle();
    expect(readContinuousRaster(defaultSceneGraph.getNode(TEXT)!)).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Quality: Best' }));
    await idle();
    expect(readNodeQuality(defaultSceneGraph.getNode(TEXT)!)).toBe('draft');
    // No frames, no frame-blend switch — a spacer holds the column.
    expect(screen.queryByRole('button', { name: 'Frame Blending' })).toBeNull();
  });

  it('a video layer shows Frame Blending and no sunburst', () => {
    renderRow(VIDEO);
    expect(screen.getByRole('button', { name: 'Frame Blending' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Collapse Transformations|Continuous Rasterize/ })).toBeNull();
  });
});
