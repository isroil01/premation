import { isAppPage, isWebUrl } from './appNavigation';

describe('isAppPage', () => {
  const dev = 'http://localhost:5173';
  const packaged = 'file:///C:/Program%20Files/Premation/resources/app.asar/dist/index.html';

  it.each([
    'http://localhost:5173/',
    'http://localhost:5173/?platform=win32',
    'http://localhost:5173/#/dashboard?tab=billing',
  ])('stays on the dev server: %s', (url) => {
    expect(isAppPage(url, dev)).toBe(true);
  });

  it.each([
    'https://premation.lemonsqueezy.com/checkout/buy/abc',
    'http://localhost:5174/',
    'file:///C:/Users/me/clip.mp4',
    'not a url',
  ])('leaves the dev server: %s', (url) => {
    expect(isAppPage(url, dev)).toBe(false);
  });

  it('stays on the packaged page, query and route included', () => {
    expect(isAppPage(`${packaged}?platform=win32#/dashboard`, packaged)).toBe(true);
    expect(isAppPage(packaged.replace('C:', 'c:'), packaged)).toBe(true);
  });

  it.each([
    'file:///C:/Users/me/Downloads/dropped.png',
    'https://premation.lemonsqueezy.com/checkout/buy/abc',
  ])('refuses anything else from the packaged page: %s', (url) => {
    expect(isAppPage(url, packaged)).toBe(false);
  });
});

describe('isWebUrl', () => {
  it.each(['https://example.com/x', 'http://example.com'])('accepts %s', (url) => {
    expect(isWebUrl(url)).toBe(true);
  });

  it.each(['file:///C:/x.exe', 'premation://billing', 'javascript:alert(1)', 'nonsense'])('refuses %s', (url) => {
    expect(isWebUrl(url)).toBe(false);
  });
});
