/**
 * premation:// routing. Any web page can open one of these links, so the
 * table below is the security property as much as the feature: a link picks a
 * destination and nothing else, and `oauth` behaves exactly as it always has.
 */

import { DEEP_LINK_SCHEME, routeDeepLink } from './deepLink';

describe('premation://connections', () => {
  it.each([
    'premation://connections',
    // Browsers and the Windows shell add a trailing slash.
    'premation://connections/',
    // A query string is ignored, never acted on.
    'premation://connections?run=rm%20-rf&tab=billing',
    'premation://connections/?x=1',
    'premation://connections#settings',
    'premation://Connections',
  ])('%s opens Connections', (url) => {
    expect(routeDeepLink(url)).toEqual({ kind: 'connections' });
  });

  it.each([
    'premation://connections/plugins',
    'premation://connections//',
    // The path is not the host: this is a link with no host at all.
    'premation:///connections',
    'premation://connectionsx',
  ])('%s is not the Connections route, only a focus', (url) => {
    expect(routeDeepLink(url)).toEqual({ kind: 'focus' });
  });
});

describe('premation://billing', () => {
  it.each([
    'premation://billing',
    'premation://billing/',
    'premation://Billing',
    // The query is ignored: nothing a link says can claim a payment.
    'premation://billing?checkout=success&plan=pro',
  ])('routes %s with nothing but the destination', (url) => {
    expect(routeDeepLink(url)).toEqual({ kind: 'billing' });
  });

  it.each(['premation://billing/portal', 'premation://billingx'])('does not route %s', (url) => {
    expect(routeDeepLink(url)).toEqual({ kind: 'focus' });
  });
});

describe('other premation:// links', () => {
  it.each([
    'premation://plugin/x',
    'premation://open?file=C:%5Cevil.pproj',
    'premation://',
  ])('%s brings the app forward and does nothing else', (url) => {
    expect(routeDeepLink(url)).toEqual({ kind: 'focus' });
  });

  it.each([
    undefined,
    '',
    'https://premation.app/connections',
    'file:///C:/premation://connections',
    // The scheme check is case-sensitive, as it always was.
    'PREMATION://connections',
    // An argv entry that merely contains the scheme.
    '--flag=premation://connections',
  ])('%s is not ours and is ignored', (url) => {
    expect(routeDeepLink(url)).toBeNull();
  });
});

describe('premation://oauth (unchanged)', () => {
  it('hands over the one-time code', () => {
    expect(routeDeepLink('premation://oauth?code=abc123')).toEqual({ kind: 'oauth', code: 'abc123', error: undefined });
  });

  it('hands over a provider error', () => {
    expect(routeDeepLink('premation://oauth?error=access_denied')).toEqual({
      kind: 'oauth',
      code: undefined,
      error: 'access_denied',
    });
  });

  it('hands over both when both are present, as main always sent them', () => {
    expect(routeDeepLink('premation://oauth/?code=c&error=e')).toEqual({ kind: 'oauth', code: 'c', error: 'e' });
  });

  it.each([
    'premation://oauth',
    'premation://oauth?code=',
    'premation://oauth?code=&error=',
    'premation://oauth?state=xyz',
  ])('%s carries nothing, so it is ignored outright (no focus)', (url) => {
    expect(routeDeepLink(url)).toBeNull();
  });
});

it('routes on the scheme the app registers', () => {
  expect(DEEP_LINK_SCHEME).toBe('premation');
});
