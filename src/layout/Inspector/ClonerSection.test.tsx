import { render, screen, fireEvent } from '@testing-library/react';
import { ClonerSection } from './ClonerSection';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { enableNodeCloner, readNodeClonerRaw, nodeHasCloner, CLONER_PROP } from '@core/scene/clonerExpand';

describe('ClonerSection in Effect Controls', () => {
  beforeEach(() => {
    defaultSceneGraph.clear();
    defaultSceneGraph.addNode({
      id: 'rect',
      name: 'Layer 1',
      parent: null,
      children: [],
      visible: true,
      locked: false,
      transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
      components: [],
    } as any);
    enableNodeCloner('rect');
  });

  it('renders AE Effect Card with fx badge and title', () => {
    render(<ClonerSection nodeId="rect" />);
    expect(screen.getByText(/Cloner/)).toBeInTheDocument();
    expect(screen.getByText('fx')).toBeInTheDocument();
    expect(screen.getByTitle('Remove Cloner effect')).toBeInTheDocument();
    expect(screen.getByTitle('Restore cloner parameters to default')).toBeInTheDocument();
  });

  it('allows changing cloner mode', () => {
    render(<ClonerSection nodeId="rect" />);
    const modeSelect = screen.getByLabelText('Cloner mode') as HTMLSelectElement;
    expect(modeSelect.value).toBe('linear');

    fireEvent.change(modeSelect, { target: { value: 'grid' } });
    expect(readNodeClonerRaw(defaultSceneGraph.getNode('rect')).mode).toBe('grid');
  });

  it('allows removing cloner from layer', () => {
    render(<ClonerSection nodeId="rect" />);
    const removeBtn = screen.getByTitle('Remove Cloner effect');
    fireEvent.click(removeBtn);

    const node = defaultSceneGraph.getNode('rect');
    expect(nodeHasCloner(node)).toBe(false);
  });

  it('allows resetting cloner parameters to default', () => {
    defaultSceneGraph.setFxKey('rect', CLONER_PROP, {
      enabled: true,
      mode: 'grid',
      countX: 8,
      countY: 8,
    });

    render(<ClonerSection nodeId="rect" />);
    const resetBtn = screen.getByTitle('Restore cloner parameters to default');
    fireEvent.click(resetBtn);

    const cfg = readNodeClonerRaw(defaultSceneGraph.getNode('rect'));
    expect(cfg.mode).toBe('linear');
    expect(cfg.count).toBe(5);
  });
});
