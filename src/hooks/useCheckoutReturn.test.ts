import { checkoutReturnShowsPlan } from './useCheckoutReturn';

describe('checkoutReturnShowsPlan', () => {
  it.each(['/', '/dashboard', '/dashboard/'])('shows the Plan page from %s', (route) => {
    expect(checkoutReturnShowsPlan(route)).toBe(true);
  });

  // An open project stays open: the link must not be able to close it.
  it.each(['/editor', '/editor/3f2a-project', '/login', '/oauth', '/welcome'])('stays on %s', (route) => {
    expect(checkoutReturnShowsPlan(route)).toBe(false);
  });
});
