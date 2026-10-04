import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { Command } from '@motion/engine-api';
import { ClonerSection } from './ClonerSection';
import { setupAppEngine, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { idle } from './__testHelpers__/engineLayers';
import { jsonField, setJsonField } from './__testHelpers__/jsonFields';
import { DEFAULT_CLONER, type ClonerConfig } from '@core/scene/cloner';

/** The layer field the cloner is stored in. */
const CLONER_PATH = 'layer/cloner';

let h: Harness;
let L = '';
const storedCloner = (): Partial<ClonerConfig> | undefined => jsonField<Partial<ClonerConfig>>(L, CLONER_PATH);

describe('ClonerSection in Effect Controls', () => {
  beforeEach(async () => {
    h = await setupAppEngine();
    L = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'rectangle', name: 'Layer 1', init: [] } as Command) as { layer: string }).layer;
    await setJsonField(L, CLONER_PATH, { ...DEFAULT_CLONER, enabled: true });
  });
  afterEach(async () => {
    cleanup();
    await h.dispose();
  });

  it('renders AE Effect Card with fx badge and title', async () => {
    render(<ClonerSection nodeId={L} />);
    expect(screen.getByText(/Cloner/)).toBeInTheDocument();
    expect(screen.getByText('fx')).toBeInTheDocument();
    expect(screen.getByTitle('Remove Cloner effect')).toBeInTheDocument();
    expect(screen.getByTitle('Restore cloner parameters to default')).toBeInTheDocument();
  });

  it('allows changing cloner mode', async () => {
    render(<ClonerSection nodeId={L} />);
    const modeSelect = screen.getByLabelText('Cloner mode') as HTMLSelectElement;
    expect(modeSelect.value).toBe('linear');

    fireEvent.change(modeSelect, { target: { value: 'grid' } });
    await idle();
    expect(storedCloner()?.mode).toBe('grid');
  });

  it('allows removing cloner from layer', async () => {
    render(<ClonerSection nodeId={L} />);
    fireEvent.click(screen.getByTitle('Remove Cloner effect'));
    await idle();
    expect(storedCloner()).toBeUndefined();
  });

  it('allows resetting cloner parameters to default', async () => {
    await setJsonField(L, CLONER_PATH, { enabled: true, mode: 'grid', countX: 8, countY: 8 });

    render(<ClonerSection nodeId={L} />);
    fireEvent.click(screen.getByTitle('Restore cloner parameters to default'));
    await idle();
    const cfg = storedCloner();
    expect(cfg?.mode).toBe('linear');
    expect(cfg?.count).toBe(5);
  });
});
