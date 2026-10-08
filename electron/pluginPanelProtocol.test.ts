import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findBundle, panelCsp, panelNavigationAllowed, parsePanelUrl, readPanelFile } from './pluginPanelProtocol';

describe('plugin-ui protocol', () => {
  let root: string;
  let bundle: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'plugin-ui-'));
    bundle = path.join(root, 'rings');
    await mkdir(path.join(bundle, 'ui', 'sub'), { recursive: true });
    await writeFile(path.join(bundle, 'premation-plugin.json'), JSON.stringify({ id: 'com.Premation.Rings' }));
    await writeFile(path.join(bundle, 'ui', 'index.html'), '<p>hi</p>');
    await writeFile(path.join(bundle, 'ui', 'sub', 'a.js'), '1');
    await writeFile(path.join(bundle, 'secret.txt'), 'x');
    await writeFile(path.join(bundle, 'ui', 'notes.txt'), 'x');
    await symlink(path.join(bundle, 'premation-plugin.json'), path.join(bundle, 'ui', 'escape.json'));
    await writeFile(path.join(root, 'stray.json'), '{}');
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('parses only safe panel URLs', () => {
    expect(parsePanelUrl('plugin-ui://com.premation.rings/index.html')).toEqual({ host: 'com.premation.rings', segments: ['index.html'] });
    expect(parsePanelUrl('plugin-ui://com.premation.rings/')).toEqual({ host: 'com.premation.rings', segments: ['index.html'] });
    expect(parsePanelUrl('plugin-ui://com.premation.rings/sub/a.js')?.segments).toEqual(['sub', 'a.js']);
    // The URL parser resolves dot segments first: `..` can never climb out of ui/.
    expect(parsePanelUrl('plugin-ui://com.premation.rings/%2e%2e/secret.txt')?.segments).toEqual(['secret.txt']);
    expect(parsePanelUrl('plugin-ui://com.premation.rings/a/%252e%252e/b.js')).toBeNull();
    expect(parsePanelUrl('plugin-ui://com.premation.rings/.hidden')).toBeNull();
    expect(parsePanelUrl('plugin-ui://com.premation.rings/a%5Cb.js')).toBeNull();
    expect(parsePanelUrl('local-file://com.premation.rings/index.html')).toBeNull();
    expect(parsePanelUrl('not a url')).toBeNull();
  });

  it('allows no network and only the bundle itself', () => {
    const csp = panelCsp('com.premation.rings');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain('script-src plugin-ui://com.premation.rings');
    expect(csp).not.toContain("'unsafe-eval'");
  });

  it('finds a bundle by id in a folder of bundles or as a root itself', async () => {
    expect(await findBundle([root], 'com.premation.rings')).toBe(bundle);
    expect(await findBundle([bundle], 'com.premation.rings')).toBe(bundle);
    expect(await findBundle([path.join(root, 'missing'), root], 'com.premation.rings')).toBe(bundle);
    expect(await findBundle([root], 'com.other')).toBeNull();
  });

  it('serves files under ui/ with the policy, and nothing else', async () => {
    const f = await readPanelFile([root], 'plugin-ui://com.premation.rings/index.html');
    expect(f?.body.toString()).toBe('<p>hi</p>');
    expect(f?.contentType).toBe('text/html; charset=utf-8');
    expect(f?.csp).toContain("connect-src 'none'");
    expect((await readPanelFile([root], 'plugin-ui://com.premation.rings/sub/a.js'))?.contentType).toContain('javascript');
    expect(await readPanelFile([root], 'plugin-ui://com.premation.rings/../secret.txt')).toBeNull();
    expect(await readPanelFile([root], 'plugin-ui://com.premation.rings/notes.txt')).toBeNull(); // not a served type
    expect(await readPanelFile([root], 'plugin-ui://com.premation.rings/escape.json')).toBeNull(); // symlink out of ui/
    expect(await readPanelFile([root], 'plugin-ui://com.premation.rings/missing.js')).toBeNull();
    expect(await readPanelFile([root], 'plugin-ui://com.other/index.html')).toBeNull();
  });
});

describe('panel navigation', () => {
  it('keeps a panel frame inside its own bundle', () => {
    expect(panelNavigationAllowed('plugin-ui://com.a/index.html', 'plugin-ui://com.a/other.html')).toBe(true);
    expect(panelNavigationAllowed('plugin-ui://com.a/index.html', 'https://example.com/')).toBe(false);
    expect(panelNavigationAllowed('plugin-ui://com.a/index.html', 'plugin-ui://com.b/index.html')).toBe(false);
    expect(panelNavigationAllowed('about:blank', 'plugin-ui://com.a/index.html')).toBe(true);
    expect(panelNavigationAllowed('http://localhost:5173/', 'http://localhost:5173/x')).toBe(true);
  });
});
