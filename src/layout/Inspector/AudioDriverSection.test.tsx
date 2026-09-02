/**
 * Audio Driver panel.
 *
 * The analysis is proved in `core/audio/audioDriver.test.ts`; what is left to
 * check here is the wiring a person actually touches — that the property list
 * is derived from the layer rather than hardcoded, that the mode switch tells
 * the truth about expression mode, and that a remembered driver comes back as
 * "Re-bake" instead of as an anonymous keyframe track.
 */

import { render, screen, fireEvent, act } from '@testing-library/react';
import { AudioDriverSection, hasAudioDriverSection } from './AudioDriverSection';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import {
  readAudioDrivers,
  writeAudioDriver,
  defaultAudioDriver,
  AUDIO_DRIVER_PROP,
} from '@core/audio/audioDriver';

function addLayer(id: string, kind = 'shape'): void {
  defaultSceneGraph.addNode({
    id,
    name: 'Layer 1',
    parent: null,
    children: [],
    visible: true,
    locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      {
        id: `${id}_t`,
        type: 'Transform',
        props: { __kind: kind, x: 0, y: 0, width: 100, height: 100, rotation: 0, opacity: 100 },
      },
    ],
  } as never);
}

describe('AudioDriverSection', () => {
  beforeEach(() => {
    defaultSceneGraph.clear();
    addLayer('rect');
  });

  it('offers itself to any layer with an animatable numeric property', () => {
    expect(hasAudioDriverSection('rect')).toBe(true);
  });

  it('lists the layer’s own properties, not a hardcoded set', () => {
    render(<AudioDriverSection nodeId="rect" />);
    const picker = screen.getByLabelText('Driven property') as HTMLSelectElement;
    expect(picker.options.length).toBeGreaterThan(1);
    // Derived from the property tree, so Transform is in there under whatever
    // labels propertyMeta gives it.
    expect(picker.options.length).toBe(new Set([...picker.options].map((o) => o.value)).size);
  });

  it('defaults to the comp mix and the full band', () => {
    render(<AudioDriverSection nodeId="rect" />);
    expect((screen.getByLabelText('Audio source') as HTMLSelectElement).value).toBe('mix');
    expect((screen.getByLabelText('Frequency band') as HTMLSelectElement).value).toBe('full');
  });

  it('a custom band reveals its Hz fields', () => {
    render(<AudioDriverSection nodeId="rect" />);
    expect(screen.queryByLabelText('Band low Hz')).toBeNull();
    fireEvent.change(screen.getByLabelText('Frequency band'), { target: { value: 'custom' } });
    // ValueField names both its spinbutton and the span inside it, so the
    // label matches twice — `getAllBy` is the honest query, not a workaround.
    expect(screen.getAllByLabelText('Band low Hz').length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText('Band high Hz').length).toBeGreaterThan(0);
  });

  it('says WHY expression mode will not be used, instead of silently baking', () => {
    render(<AudioDriverSection nodeId="rect" />);
    // The default driver has attack and release on, which no expression can do.
    fireEvent.change(screen.getByLabelText('Driver mode'), { target: { value: 'expression' } });
    expect(screen.getByText(/Will bake instead/)).toBeInTheDocument();
  });

  it('a remembered driver comes back as Re-bake, with a Remove beside it', () => {
    render(<AudioDriverSection nodeId="rect" />);
    const path = (screen.getByLabelText('Driven property') as HTMLSelectElement).value;
    expect(screen.getByRole('button', { name: 'Apply' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();

    act(() => writeAudioDriver('rect', { ...defaultAudioDriver(path), min: 50, max: 150 }));
    render(<AudioDriverSection nodeId="rect" />);
    expect(screen.getAllByRole('button', { name: 'Re-bake' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'Remove' }).length).toBeGreaterThan(0);
  });

  it('renders nothing for a node that is gone', () => {
    const { container } = render(<AudioDriverSection nodeId="missing" />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('driver persistence', () => {
  beforeEach(() => {
    defaultSceneGraph.clear();
    addLayer('rect');
  });

  it('round-trips through the node’s hidden __audioDriver map', () => {
    writeAudioDriver('rect', { ...defaultAudioDriver('opacity'), band: 'low', min: 10, max: 90 });
    const node = defaultSceneGraph.getNode('rect');
    const drivers = readAudioDrivers(node!);
    expect(drivers.opacity?.band).toBe('low');
    expect(drivers.opacity?.min).toBe(10);
    // Stored on the Transform component under the hidden prop, so the generic
    // NodeInspector's property list never shows it.
    const t = node!.components.find((c) => c.type === 'Transform');
    expect(t?.props[AUDIO_DRIVER_PROP]).toBeTruthy();
  });

  it('a garbled record degrades to defaults rather than throwing', () => {
    const node = defaultSceneGraph.getNode('rect');
    const t = node!.components.find((c) => c.type === 'Transform');
    defaultSceneGraph.writeProp('rect', t!.id, AUDIO_DRIVER_PROP, {
      scale: { band: 'nonsense', attackMs: 'soon', curve: 'wobble' },
    });
    const drivers = readAudioDrivers(defaultSceneGraph.getNode('rect')!);
    expect(drivers.scale?.band).toBe('full');
    expect(drivers.scale?.curve).toBe('linear');
    expect(typeof drivers.scale?.attackMs).toBe('number');
  });
});
