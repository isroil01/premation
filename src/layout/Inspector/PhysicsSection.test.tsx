import { render, screen, fireEvent } from '@testing-library/react';
import { PhysicsSection } from './PhysicsSection';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { enableNodePhysics, readNodePhysicsRaw, nodeHasPhysics, PHYSICS_PROP } from '@core/simulation/physicsBodies';

describe('PhysicsSection in Effect Controls', () => {
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
    enableNodePhysics('rect');
  });

  it('renders AE Effect Card with fx badge and title', () => {
    render(<PhysicsSection nodeId="rect" />);
    expect(screen.getByText('Physics (Rigid Body)')).toBeInTheDocument();
    expect(screen.getByText('fx')).toBeInTheDocument();
    expect(screen.getByTitle('Remove Physics effect')).toBeInTheDocument();
    expect(screen.getByTitle('Restore physics parameters to default')).toBeInTheDocument();
  });

  it('allows changing body type and collider shape', () => {
    render(<PhysicsSection nodeId="rect" />);
    
    const bodyTypeSelect = screen.getByLabelText('Body type') as HTMLSelectElement;
    expect(bodyTypeSelect.value).toBe('dynamic');

    fireEvent.change(bodyTypeSelect, { target: { value: 'static' } });
    expect(readNodePhysicsRaw(defaultSceneGraph.getNode('rect')).kind).toBe('static');

    const colliderSelect = screen.getByLabelText('Collider shape') as HTMLSelectElement;
    fireEvent.change(colliderSelect, { target: { value: 'circle' } });
    expect(readNodePhysicsRaw(defaultSceneGraph.getNode('rect')).shape).toBe('circle');
  });

  it('allows removing physics from layer', () => {
    render(<PhysicsSection nodeId="rect" />);
    const removeBtn = screen.getByTitle('Remove Physics effect');
    fireEvent.click(removeBtn);

    const node = defaultSceneGraph.getNode('rect');
    expect(nodeHasPhysics(node)).toBe(false);
  });

  it('allows resetting physics parameters to default', () => {
    defaultSceneGraph.setFxKey('rect', PHYSICS_PROP, {
      enabled: true,
      kind: 'static',
      shape: 'circle',
      mass: 50,
    });

    render(<PhysicsSection nodeId="rect" />);
    const resetBtn = screen.getByTitle('Restore physics parameters to default');
    fireEvent.click(resetBtn);

    const cfg = readNodePhysicsRaw(defaultSceneGraph.getNode('rect'));
    expect(cfg.kind).toBe('dynamic');
    expect(cfg.shape).toBe('box');
    expect(cfg.mass).toBe(1);
  });
});
