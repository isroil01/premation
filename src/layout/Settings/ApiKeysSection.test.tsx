import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ApiKeysSection } from './ApiKeysSection';
import { api } from '@core/api/client';

jest.mock('@components/Modal', () => ({
  customConfirm: jest.fn(async () => true),
}));

jest.mock('@core/api/client', () => ({
  api: {
    listApiKeys: jest.fn(),
    getApiUsage: jest.fn(),
    createApiKey: jest.fn(),
    revokeApiKey: jest.fn(),
  },
}));

const key = {
  id: 'key-1',
  name: 'Production workflow',
  prefix: 'pm_live_ab12',
  createdAt: '2026-08-01T00:00:00.000Z',
  lastUsedAt: '2026-08-10T00:00:00.000Z',
  requestCount: 42,
  revokedAt: null,
  scopes: ['renders:write'],
  expiresAt: '2027-08-01T00:00:00.000Z',
};

describe('ApiKeysSection', () => {
  beforeEach(() => {
    jest.mocked(api.listApiKeys).mockResolvedValue({ items: [key], total: 1, limit: 50, offset: 0 });
    jest.mocked(api.getApiUsage).mockResolvedValue({
      period: '2026-08',
      renderJobs: 2,
      renderDurationMs: 120_000,
      renderedMinutes: 2,
      apiRequests: 42,
      assetProcessingBytes: 0,
      limits: {
        apiEnabled: true,
        monthlyRenderMinutes: 10,
        monthlyApiRequests: 100,
        maxActiveApiKeys: 2,
      },
    });
  });

  it('shows quota progress and operational key details', async () => {
    render(<MemoryRouter><ApiKeysSection /></MemoryRouter>);

    expect(await screen.findByText('Production workflow')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Render minutes usage' })).toHaveAttribute('aria-valuenow', '2');
    expect(screen.getByText(/Last used/)).toBeInTheDocument();
    expect(screen.getByText(/42 requests/)).toBeInTheDocument();
    expect(screen.getByText(/Active key allowance: up to 2/)).toBeInTheDocument();
    expect(screen.getByText('Scopes: renders:write')).toBeInTheDocument();
    expect(screen.getByText(/Expires/)).toBeInTheDocument();
  });

  it('locks the whole page when the contract disables API access', async () => {
    jest.mocked(api.getApiUsage).mockResolvedValueOnce({
      period: '2026-08',
      renderJobs: 0,
      renderDurationMs: 0,
      renderedMinutes: 0,
      apiRequests: 0,
      assetProcessingBytes: 0,
      limits: { apiEnabled: false, monthlyRenderMinutes: 0, monthlyApiRequests: 0 },
    });
    const onViewPlans = jest.fn();
    render(<MemoryRouter><ApiKeysSection onViewPlans={onViewPlans} /></MemoryRouter>);

    expect(
      await screen.findByText(/Automation API access is not included in this plan/),
    ).toBeInTheDocument();
    // Locked means GONE, not disabled: no create form, no quickstart snippets,
    // no quota cards — a disabled console read as available-but-broken.
    expect(screen.queryByRole('button', { name: 'Create API key' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Quickstart/)).not.toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    // But keys minted under the old plan stay visible and revocable.
    expect(await screen.findByText('Production workflow')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeInTheDocument();
    // The route to billing is the OWNING PAGE's to know — this component used
    // to navigate to `/dashboard`, which does not exist in every edition.
    fireEvent.click(screen.getByRole('button', { name: 'View plans' }));
    expect(onViewPlans).toHaveBeenCalled();
    expect(api.createApiKey).not.toHaveBeenCalled();
  });

  it('renders neither the open console nor the upgrade pitch while access is unknown', async () => {
    // /v1/usage unreachable: the page must not guess in either direction.
    jest.mocked(api.getApiUsage).mockRejectedValueOnce(new Error('network down'));
    render(<MemoryRouter><ApiKeysSection /></MemoryRouter>);

    expect(
      await screen.findByText(/Could not load your plan's API access/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create API key' })).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Automation API access is not included in this plan/),
    ).not.toBeInTheDocument();
  });

  it('omits the plans route when the build has no billing surface', async () => {
    jest.mocked(api.getApiUsage).mockResolvedValueOnce({
      period: '2026-08',
      renderJobs: 0,
      renderDurationMs: 0,
      renderedMinutes: 0,
      apiRequests: 0,
      assetProcessingBytes: 0,
      limits: { apiEnabled: false, monthlyRenderMinutes: 0, monthlyApiRequests: 0 },
    });
    render(<MemoryRouter><ApiKeysSection /></MemoryRouter>);

    // The callout still explains WHY keys are unavailable; only the button that
    // would lead nowhere is gone.
    expect(
      await screen.findByText(/Automation API access is not included in this plan/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'View plans' })).not.toBeInTheDocument();
  });
});
