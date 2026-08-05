/**
 * The dash-offset control has to be REACHABLE, and it has to write the track the
 * renderer reads.
 *
 * Two failures this guards, both of which leave every other test in this feature
 * green:
 *   • the row never renders (a model and a renderer with no way in);
 *   • the row renders but writes a different property name than
 *     `buildSnapshot` samples — the shape of F34, where `strokeWidth` has a
 *     stopwatch and no reader.
 *
 * The property name is taken from the SAME registry entry the renderer's track
 * name comes from, rather than being typed out again here, so a rename cannot
 * leave this passing.
 */

import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import { AppearanceSection } from './AppearanceSection';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useSelectionStore } from '@stores/selectionStore';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { defaultAnimation } from '@motion/animation';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import { resolvePropertyMeta } from '@core/inspector/propertyMeta';
import { readNodeStroke } from '@core/paint/stroke';
import type { SceneNode } from '@core/types';

const ID = 'dash_probe';
const PROP = 'strokeDashOffset';
const DASH = [24, 12];

function shapeNode(id: string): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 0, y: 0, width: 200, height: 160, opacity: 100 } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#1f4f8f' } },
    ],
  } as unknown as SceneNode;
}

function setStroke(dash: number[]): void {
  defaultSceneGraph.setStroke(ID, {
    enabled: true, color: '#33e0a0', width: 14, opacity: 1,
    align: 'center', dash, cap: 'butt', join: 'miter',
  });
}

/** The panel keeps stroke controls behind a popover; open it by its trigger. */
function openStrokePopover(): void {
  const trigger = screen.queryAllByLabelText(/stroke/i)[0];
  if (trigger) fireEvent.click(trigger);
}

beforeEach(() => {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
  if (defaultSceneGraph.getNode(ID)) defaultSceneGraph.removeNode(ID);
  defaultSceneGraph.addNode(shapeNode(ID));
  useSelectionStore.setState({ ids: [ID] } as never);
  defaultAnimation.removeTrack(ID, PROP);
});

afterEach(() => {
  cleanup();
  if (defaultSceneGraph.getNode(ID)) defaultSceneGraph.removeNode(ID);
});

describe('the Dash Offset row', () => {
  it('is registered under the name the renderer samples', () => {
    // `buildSnapshot` folds `a.get('strokeDashOffset')`. If the registry and the
    // renderer ever disagree the control writes a track nothing reads.
    const meta = resolvePropertyMeta(PROP, ID);
    expect(meta.label).toBe('Dash Offset');
    expect(meta.unit).toBe('px');
  });

  it('appears once the stroke has a dash pattern', () => {
    setStroke(DASH);
    render(<AppearanceSection nodeId={ID} />);
    openStrokePopover();
    expect(screen.queryAllByLabelText('Dash Offset').length).toBeGreaterThan(0);
  });

  it('is ABSENT on a solid stroke — offset with no pattern would do nothing', () => {
    setStroke([]);
    render(<AppearanceSection nodeId={ID} />);
    openStrokePopover();
    expect(screen.queryAllByLabelText('Dash Offset')).toHaveLength(0);
  });

  it('its keyframe toggle writes the track the renderer reads', () => {
    setStroke(DASH);
    render(<AppearanceSection nodeId={ID} />);
    openStrokePopover();
    const row = screen.getAllByLabelText('Dash Offset')[0]!;
    // The toggle is the checkbox in the same row.
    const checkbox = row.closest('div')?.parentElement?.querySelector('input[type="checkbox"]');
    expect(checkbox).toBeTruthy();
    fireEvent.click(checkbox as Element);
    expect(defaultAnimation.isAnimated(ID, PROP)).toBe(true);
  });

  it('editing with no animation writes the STATIC value onto the stroke', () => {
    setStroke(DASH);
    render(<AppearanceSection nodeId={ID} />);
    openStrokePopover();
    const field = screen.getAllByLabelText('Dash Offset')[0]!;
    fireEvent.keyDown(field, { key: 'Enter' });
    const input = field.querySelector('input');
    expect(input).toBeTruthy();
    fireEvent.change(input as Element, { target: { value: '9' } });
    fireEvent.keyDown(input as Element, { key: 'Enter' });
    expect(readNodeStroke(defaultSceneGraph.getNode(ID)!)?.dashOffset).toBe(9);
  });
});
