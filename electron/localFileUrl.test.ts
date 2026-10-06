/**
 * The request URLs below are the ones Electron 44.4.3 actually delivered to
 * `protocol.handle('local-file', …)` (probed with net.fetch), not guesses.
 */

import { localFileCorsOrigin, localFileUrlToPath } from './localFileUrl';

describe('localFileCorsOrigin', () => {
  const dev = 'http://localhost:5173';
  it('lets the app’s own pages read the bytes (dev server, packaged file:// page)', () => {
    expect(localFileCorsOrigin('http://localhost:5173', dev)).toBe('http://localhost:5173');
    expect(localFileCorsOrigin('null', dev)).toBe('null');
  });
  it('gives any other origin, and a same-origin load, no header', () => {
    expect(localFileCorsOrigin('https://example.com', dev)).toBeNull();
    expect(localFileCorsOrigin('http://localhost:5199', dev)).toBeNull();
    expect(localFileCorsOrigin(null, dev)).toBeNull();
  });
});

describe('localFileUrlToPath', () => {
  it('recovers the drive Chromium moved into the host (local-file://C:/… → local-file://C/…)', () => {
    expect(localFileUrlToPath('local-file://C/Users/x/a%20b.mp4', 'win32')).toBe('C:\\Users\\x\\a b.mp4');
  });

  it('accepts the triple-slash form', () => {
    expect(localFileUrlToPath('local-file:///C:/Users/x/a%20b.mp4', 'win32')).toBe('C:\\Users\\x\\a b.mp4');
    expect(localFileUrlToPath('local-file:///D:', 'win32')).toBe('D:\\');
  });

  it('keeps a UNC share on Windows', () => {
    expect(localFileUrlToPath('local-file://nas/footage/a.mov', 'win32')).toBe('\\\\nas\\footage\\a.mov');
  });

  it('posix paths', () => {
    expect(localFileUrlToPath('local-file:///home/u/a%20b.mp4', 'darwin')).toBe('/home/u/a b.mp4');
    expect(localFileUrlToPath('local-file://host/home/u/a.mp4', 'linux')).toBeNull();
  });

  it('refuses other schemes and malformed input', () => {
    expect(localFileUrlToPath('file:///C:/a.mp4', 'win32')).toBeNull();
    expect(localFileUrlToPath('not a url', 'win32')).toBeNull();
    expect(localFileUrlToPath('local-file:///C:/%E0%A4%A', 'win32')).toBeNull();
  });
});
