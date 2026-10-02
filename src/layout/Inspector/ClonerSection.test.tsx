import { render, screen, fireEvent } from '@testing-library/react';
import { ClonerSection } from './ClonerSection';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { addLayer, idle } from './__testHelpers__/engineLayers';
import { DEFAULT_CLONER, type ClonerConfig } from '@core/scene/cloner';

/** The fx key `layer/cloner` is stored under (layerFieldSpecs). */
const CLONER_PROP = '__cloner';

/** The cloner config as stored on the layer, or undefined when it has none. */
function storedCloner(): Partial<ClonerConfig> | undefined {
  for (const c of defaultSceneGraph.getNode('rect')?.components ?? []) {
    const raw = (c.props as Record<string, unknown>)[CLONER_PROP];
    if (raw && typeof raw === 'object') return raw as Partial<ClonerConfig>;
  }
  return undefined;
}

describe('ClonerSection in Effect Controls', () => {
  beforeEach(() => {
    defaultSceneGraph.clear();
    addLayer({
      id: 'rect',
      name: 'Layer 1',
      parent: null,
      children: [],
      visible: true,
      locked: false,
      transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
      components: [],
    } as any);
    defaultSceneGraph.setFxKey('rect', CLONER_PROP, { ...DEFAULT_CLONER, enabled: true });
  });

  it('renders AE Effect Card with fx badge and title', async () => {
    render(<ClonerSection nodeId="rect" />);
    expect(screen.getByText(/Cloner/)).toBeInTheDocument();
    expect(screen.getByText('fx')).toBeInTheDocument();
    expect(screen.getByTitle('Remove Cloner effect')).toBeInTheDocument();
    expect(screen.getByTitle('Restore cloner parameters to default')).toBeInTheDocument();
  });

  it('allows changing cloner mode', async () => {
    render(<ClonerSection nodeId="rect" />);
    const modeSelect = screen.getByLabelText('Cloner mode') as HTMLSelectElement;
    expect(modeSelect.value).toBe('linear');

    fireEvent.change(modeSelect, { target: { value: 'grid' } });
    await idle();
    expect(storedCloner()?.mode).toBe('grid');
  });

  it('allows removing cloner from layer', async () => {
    render(<ClonerSection nodeId="rect" />);
    const removeBtn = screen.getByTitle('Remove Cloner effect');
    fireEvent.click(removeBtn);
    await idle();
    expect(storedCloner()).toBeUndefined();
  });

  it('allows resetting cloner parameters to default', async () => {
    defaultSceneGraph.setFxKey('rect', CLONER_PROP, {
      enabled: true,
      mode: 'grid',
      countX: 8,
      countY: 8,
    });

    render(<ClonerSection nodeId="rect" />);
    const resetBtn = screen.getByTitle('Restore cloner parameters to default');
    fireEvent.click(resetBtn);
    await idle();
    const cfg = storedCloner();
    expect(cfg?.mode).toBe('linear');
    expect(cfg?.count).toBe(5);
  });
});
