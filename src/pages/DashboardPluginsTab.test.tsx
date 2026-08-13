/**
 * Two things this page kept getting wrong, both of which read as carelessness
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
 */

import { render, screen, act } from '@testing-library/react';
import { DashboardPluginsTab } from './DashboardPluginsTab';

jest.mock('@core/plugins/registry', () => ({
  browseRegistry: jest.fn(async () => ({ available: false })),
  checkForUpdates: jest.fn(async () => []),
  registryMediaUrl: (p: string | null) => p,
  myPublishers: jest.fn(async () => []),
  myPublishedPlugins: jest.fn(async () => []),
  registerPublisher: jest.fn(),
  updateListing: jest.fn(),
  fetchRegistryDetail: jest.fn(),
  REGISTRY_CATEGORIES: [],
}));

/** Both children load asynchronously; assert on the settled page, not the first frame. */
async function show(): Promise<HTMLElement> {
  let container!: HTMLElement;
  await act(async () => { ({ container } = render(<DashboardPluginsTab />)); });
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
    // The positive half: deleting the duplicate heading must not have taken the
    // one real section boundary on the page with it.
    expect(screen.getByRole('heading', { name: 'Publishing' })).toBeTruthy();
  });

  it('does not send publishers to a domain check that was removed', async () => {
    const container = await show();
    expect(container.textContent).not.toMatch(/verify your domain/i);
  });
});
