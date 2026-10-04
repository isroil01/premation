import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { Command } from '@motion/engine-api';
import { PhysicsSection } from './PhysicsSection';
import { setupAppEngine, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { idle } from './__testHelpers__/engineLayers';
import { jsonField, setJsonField } from './__testHelpers__/jsonFields';
import { DEFAULT_PHYSICS_BODY, type PhysicsBodyConfig } from '@core/simulation/physicsBodies';

/** The layer field the rigid body is stored in. */
const PHYSICS_PATH = 'layer/physics';

let h: Harness;
let L = '';
const physics = (): (PhysicsBodyConfig & { enabled?: boolean }) | undefined => jsonField(L, PHYSICS_PATH);

describe('PhysicsSection in Effect Controls', () => {
  beforeEach(async () => {
    h = await setupAppEngine();
    L = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'rectangle', name: 'Layer 1', init: [] } as Command) as { layer: string }).layer;
    await setJsonField(L, PHYSICS_PATH, { ...DEFAULT_PHYSICS_BODY, enabled: true });
  });
  afterEach(async () => {
    cleanup();
    await h.dispose();
  });

  it('renders AE Effect Card with fx badge and title', async () => {
    render(<PhysicsSection nodeId={L} />);
    expect(screen.getByText('Physics (Rigid Body)')).toBeInTheDocument();
    expect(screen.getByText('fx')).toBeInTheDocument();
    expect(screen.getByTitle('Remove Physics effect')).toBeInTheDocument();
    expect(screen.getByTitle('Restore physics parameters to default')).toBeInTheDocument();
  });

  it('allows changing body type and collider shape', async () => {
    render(<PhysicsSection nodeId={L} />);

    const bodyTypeSelect = screen.getByLabelText('Body type') as HTMLSelectElement;
    expect(bodyTypeSelect.value).toBe('dynamic');

    fireEvent.change(bodyTypeSelect, { target: { value: 'static' } });
    await idle();
    expect(physics()?.kind).toBe('static');

    const colliderSelect = screen.getByLabelText('Collider shape') as HTMLSelectElement;
    fireEvent.change(colliderSelect, { target: { value: 'circle' } });
    await idle();
    expect(physics()?.shape).toBe('circle');
  });

  it('allows removing physics from layer', async () => {
    render(<PhysicsSection nodeId={L} />);
    fireEvent.click(screen.getByTitle('Remove Physics effect'));
    await idle();
    expect(physics()?.enabled ?? false).toBe(false);
  });

  it('allows resetting physics parameters to default', async () => {
    await setJsonField(L, PHYSICS_PATH, { enabled: true, kind: 'static', shape: 'circle', mass: 50 });

    render(<PhysicsSection nodeId={L} />);
    fireEvent.click(screen.getByTitle('Restore physics parameters to default'));
    await idle();
    const cfg = physics();
    expect(cfg?.kind).toBe('dynamic');
    expect(cfg?.shape).toBe('box');
    expect(cfg?.mass).toBe(1);
  });
});
