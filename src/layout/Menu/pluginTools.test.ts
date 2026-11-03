import { parseToolShortcut } from './pluginMenu';

describe('plugin viewer tools (SDK 1.4 U): the manifest shortcut', () => {
  it('reads modifiers and a key', () => {
    expect(parseToolShortcut('Shift+S')).toEqual({ key: 's', shift: true });
    expect(parseToolShortcut('Ctrl+Alt+K')).toEqual({ key: 'k', ctrl: true, alt: true });
    expect(parseToolShortcut('F7')).toEqual({ key: 'F7' });
  });
  it('refuses what it cannot bind', () => {
    expect(parseToolShortcut('')).toBeNull();
    expect(parseToolShortcut('Hyper+S')).toBeNull();
  });
});
