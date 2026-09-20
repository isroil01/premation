/**
 * Three things this page kept getting wrong, all of which read as carelessness
 * long before anyone works out what caused them.
 *
 * 1. **It titled itself.** `DashboardPage` already prints a heading and a
 *    description above whichever tab is showing. This tab printed its own
 *    "Plugins" and its own description of plugins directly underneath, so the
 *    page opened with the same word twice and two paragraphs saying the same
 *    thing — and pushed the list, the only reason anyone is here, down the page.
 *
 * 2. **It described a flow that no longer exists.** The publisher section told
 *    users to verify a domain months after domain verification was removed. Copy
 *    that survives the feature it documents is worse than no copy: it sends a
 *    reader looking for a control that is not there, and they conclude the app
 *    is broken rather than the sentence.
 *
 * 3. **Publishing was behind a dialog.** It is a view now. The assertion that
 *    used to look for a "Publishing" heading looks for the tab instead: the
 *    section boundary it was protecting is still there, as a destination you can
 *    reach and link to rather than a heading inside a scrim.
 */

import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DashboardPluginsTab } from './DashboardPluginsTab';

jest.mock('@core/plugins/registry', () => ({
  browseRegistry: jest.fn(async () => ({ available: false })),
  checkForUpdates: jest.fn(async () => []),
  registryMediaUrl: (p: string | null) => p,
  myPublishers: jest.fn(async () => []),
  myPublishedPlugins: jest.fn(async () => []),
  registerPublisher: jest.fn(),
  updateListing: jest.fn(),
  deletePublishedPlugin: jest.fn(),
  fetchRegistryDetail: jest.fn(),
  uploadPluginMedia: jest.fn(),
  deletePluginMedia: jest.fn(),
  REGISTRY_CATEGORIES: [],
  MAX_PLUGIN_IMAGE_BYTES: 2 * 1024 * 1024,
  MAX_PLUGIN_SCREENSHOTS: 6,
  PLUGIN_IMAGE_MIME: ['image/png'],
}));

/**
 * Both children load asynchronously; assert on the settled page, not the first
 * frame. Inside a router because the view is a URL parameter — the page reads
 * it through `useSearchParams` so that it works under the app's hash router,
 * where `window.location.search` is empty.
 */
async function show(): Promise<HTMLElement> {
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(
      <MemoryRouter initialEntries={['/dashboard?tab=plugins']}>
        <DashboardPluginsTab />
      </MemoryRouter>,
    ));
  });
  return container;
}

describe('the dashboard Plugins page', () => {
  it('leaves the page title to the page', async () => {
    await show();

    // Asserted on headings rather than on text, because the word "plugins"
    // legitimately appears all over this page — in row descriptions, in the
    // sandbox note. What must not appear twice is a HEADING announcing it.
    expect(screen.queryAllByRole('heading', { name: /^plugins$/i })).toHaveLength(0);
  });

  it('still separates publishing from browsing', async () => {
    await show();
    // The positive half: the one real section boundary on the page has to
    // survive, and it is now a tab rather than a heading in a dialog.
    expect(screen.getByRole('tab', { name: 'Publishing' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Installed' })).toBeTruthy();
  });

  it('opens on the installed list, not the publisher shelf', async () => {
    await show();
    expect(screen.getByRole('tab', { name: 'Installed' })).toHaveAttribute('aria-selected', 'true');
  });

  it('★ shows publishing in the page, never in a dialog', async () => {
    await show();
    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: 'Publishing' }));
    });

    // The whole point of the redesign: durable state — listings, visibility,
    // published packages — must not sit behind a scrim you dismiss by clicking
    // next to it.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Publishing' })).toHaveAttribute('aria-selected', 'true');
  });

  it('does not send publishers to a domain check that was removed', async () => {
    const container = await show();
    expect(container.textContent).not.toMatch(/verify your domain/i);
  });
});
