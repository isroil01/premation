/**
 * The proxy UI, traced through its READ path.
 *
 * "Never ship a control whose value nothing reads" cuts both ways: a badge that
 * does not follow the store is the same defect as a switch nothing consumes. So
 * these assert what the row DISPLAYS for each store state, and that the switch
 * writes the preference the renderer actually reads — not merely that the
 * component mounts.
 *
 * The state that matters most is "Proxy in use". A proxy silently in use looks
 * like a quality bug, so it must be visible exactly when `resolveMediaSrc` would
 * return the proxy, and never otherwise. That agreement is asserted directly.
 */

import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ProxyRow } from './ProxyRow';
import { useAssetStore, type ImportedAsset } from '@stores/assetStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { resolveMediaSrc, type ProxyRecord } from '@core/assets/proxy';

const ID = 'asset-1';
const ORIGINAL = 'blob:original';

const asset = (over: Partial<ImportedAsset> = {}): ImportedAsset => ({
  id: ID,
  name: 'shot.mov',
  type: 'video',
  src: ORIGINAL,
  size: 1,
  metadata: { width: 3840, height: 2160, duration: 10 },
  ...over,
});

const seed = (a: ImportedAsset = asset()): void => {
  useAssetStore.setState({ assets: [a] } as never);
};

beforeEach(() => {
  // Desktop build by default, so Create Proxy is offered.
  (window as unknown as { motionEditor?: unknown }).motionEditor = {
    media: { generateProxy: jest.fn(), cancelProxy: jest.fn() },
  };
  usePreferenceStore.getState().set('useProxies', false);
  seed();
});
afterEach(cleanup);

describe('status follows the store', () => {
  it('reads Full resolution with no proxy', () => {
    render(<ProxyRow assetId={ID} />);
    expect(screen.getByText('Full resolution')).toBeInTheDocument();
  });

  it('says what a proxy WOULD be, so the action is a known quantity', () => {
    render(<ProxyRow assetId={ID} />);
    expect(screen.getByText(/Would be 1920×1080/)).toBeInTheDocument();
  });

  it('reads Generating and offers Cancel instead of Create', () => {
    seed(asset({ proxy: { status: 'generating' } }));
    render(<ProxyRow assetId={ID} />);
    expect(screen.getByText('Generating…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Create Proxy|Regenerate/ })).toBeNull();
  });

  it('reads Failed and surfaces the reason', () => {
    seed(asset({ proxy: { status: 'failed', error: 'The proxy could not be encoded.' } }));
    render(<ProxyRow assetId={ID} />);
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('The proxy could not be encoded.')).toBeInTheDocument();
  });

  it('reads Proxy ready with its size when the toggle is OFF', () => {
    seed(asset({ proxy: { status: 'ready', src: 'blob:p', width: 1920, height: 1080 } }));
    render(<ProxyRow assetId={ID} />);
    expect(screen.getByText('Proxy ready')).toBeInTheDocument();
    expect(screen.getByText('1920×1080')).toBeInTheDocument();
  });

  it('escalates to Proxy in use once the toggle is ON', () => {
    seed(asset({ proxy: { status: 'ready', src: 'blob:p', width: 1920, height: 1080 } }));
    usePreferenceStore.getState().set('useProxies', true);
    render(<ProxyRow assetId={ID} />);
    expect(screen.getByText('Proxy in use')).toBeInTheDocument();
    expect(screen.queryByText('Proxy ready')).toBeNull();
  });

  it('marks a user-supplied proxy as theirs', () => {
    seed(asset({ proxy: { status: 'ready', src: 'blob:p', userSupplied: true } }));
    render(<ProxyRow assetId={ID} />);
    expect(screen.getByText(/yours/)).toBeInTheDocument();
  });
});

describe('"Proxy in use" agrees with what the renderer would decode', () => {
  const records: (ProxyRecord | undefined)[] = [
    undefined,
    { status: 'generating' },
    { status: 'failed', error: 'x' },
    { status: 'ready' }, // ready but src missing — a deleted proxy file
    { status: 'ready', src: 'blob:p' },
  ];

  it.each([true, false])('with useProxies=%s, the badge never lies', (on) => {
    for (const proxy of records) {
      cleanup();
      const a = asset(proxy ? { proxy } : {});
      seed(a);
      usePreferenceStore.getState().set('useProxies', on);
      render(<ProxyRow assetId={ID} />);
      const decodesProxy = resolveMediaSrc(a, on ? 'viewport' : 'original') !== ORIGINAL;
      expect(screen.queryByText('Proxy in use') !== null).toBe(decodesProxy);
    }
  });
});

describe('the global switch is wired to the preference the renderer reads', () => {
  it('writes useProxies', () => {
    render(<ProxyRow assetId={ID} />);
    const sw = screen.getByLabelText(/Use proxies in the viewport/i);
    fireEvent.click(sw);
    expect(usePreferenceStore.getState().useProxies).toBe(true);
    fireEvent.click(sw);
    expect(usePreferenceStore.getState().useProxies).toBe(false);
  });

  it('states in the UI that export is unaffected — the promise the feature rests on', () => {
    render(<ProxyRow assetId={ID} />);
    expect(screen.getByText(/exports and renders always use the original/i)).toBeInTheDocument();
  });
});

describe('refusals disable and explain rather than failing on click', () => {
  it('disables Create for footage already cheap to seek, and says why', () => {
    seed(asset({ metadata: { width: 1280, height: 720 } }));
    render(<ProxyRow assetId={ID} />);
    expect(screen.getByRole('button', { name: 'Create Proxy' })).toBeDisabled();
    expect(screen.getByText(/already small enough/i)).toBeInTheDocument();
  });

  it('disables Create when the size is unknown', () => {
    seed(asset({ metadata: {} }));
    render(<ProxyRow assetId={ID} />);
    expect(screen.getByRole('button', { name: 'Create Proxy' })).toBeDisabled();
  });

  it('offers Regenerate rather than Create once one exists', () => {
    seed(asset({ proxy: { status: 'ready', src: 'blob:p' } }));
    render(<ProxyRow assetId={ID} />);
    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeInTheDocument();
  });
});

describe('the browser build', () => {
  beforeEach(() => {
    (window as unknown as { motionEditor?: unknown }).motionEditor = {};
  });

  it('OMITS Create entirely rather than showing a permanently dead button', () => {
    render(<ProxyRow assetId={ID} />);
    expect(screen.queryByRole('button', { name: /Create Proxy|Regenerate/ })).toBeNull();
  });

  it('still offers Attach, which is its whole proxy story', () => {
    render(<ProxyRow assetId={ID} />);
    expect(screen.getByRole('button', { name: 'Attach…' })).toBeInTheDocument();
  });

  it('explains why generation is missing', () => {
    render(<ProxyRow assetId={ID} />);
    expect(screen.getByText(/need ffmpeg/i)).toBeInTheDocument();
  });

  it('still exposes the global toggle, so an attached proxy is usable', () => {
    render(<ProxyRow assetId={ID} />);
    expect(screen.getByLabelText(/Use proxies in the viewport/i)).toBeInTheDocument();
  });
});

describe('scope', () => {
  it('renders nothing for a still — there is no seek cost to avoid', () => {
    seed(asset({ type: 'image' }));
    const { container } = render(<ProxyRow assetId={ID} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for an asset that no longer exists', () => {
    useAssetStore.setState({ assets: [] } as never);
    const { container } = render(<ProxyRow assetId={ID} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('Detach is offered only when there is something to detach', () => {
    render(<ProxyRow assetId={ID} />);
    expect(screen.queryByRole('button', { name: 'Detach' })).toBeNull();
    cleanup();
    seed(asset({ proxy: { status: 'ready', src: 'blob:p' } }));
    render(<ProxyRow assetId={ID} />);
    expect(screen.getByRole('button', { name: 'Detach' })).toBeInTheDocument();
  });
});
