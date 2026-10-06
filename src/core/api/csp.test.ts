import { readFileSync } from 'fs';
import { join } from 'path';
import { buildAppCsp, originOf } from './csp';

/**
 * Parses a policy string into a lookup of directive → allowed sources. Missing
 * directives read as `[]` rather than undefined, so a policy that lost one fails
 * the assertion about its contents instead of blowing up on the lookup.
 */
function directives(csp: string): (name: string) => string[] {
  const parsed = new Map<string, string[]>();
  for (const part of csp.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) parsed.set(name, sources);
  }
  return (name) => parsed.get(name) ?? [];
}

describe('app CSP', () => {
  it('keeps working for dev and the bundled sidecar with no backend configured', () => {
    const d = directives(buildAppCsp());
    expect(d('connect-src')).toContain("'self'");
    expect(d('connect-src')).toContain('http://localhost:*');
    expect(d('connect-src')).toContain('ws://localhost:*');
    expect(d('script-src')).toEqual(["'self'"]);
    expect(d('default-src')).toEqual(["'self'"]);
  });

  it('lets a packaged build reach the deployed backend it was built for', () => {
    // The bug this guards: the policy named localhost only, so a build pointed
    // at a deployed server booted to a login screen that could never log in.
    const d = directives(buildAppCsp({ backendOrigin: 'https://api.example.com' }));
    expect(d('connect-src')).toContain('https://api.example.com');
    expect(d('connect-src')).toContain('wss://api.example.com');
    // /files assets are served from the backend origin under the local driver.
    expect(d('img-src')).toContain('https://api.example.com');
    expect(d('media-src')).toContain('https://api.example.com');
  });

  it('allows the production asset host by default, for fetch as well as tags', () => {
    // Asset bytes are fetched, not only tagged: AudioEngine fetch()es the src
    // and decodes it. img-src alone would draw stills and mute every audio
    // layer, which is the harder failure to attribute.
    const d = directives(buildAppCsp());
    for (const directive of ['connect-src', 'img-src', 'media-src']) {
      expect(d(directive)).toContain('https://res.cloudinary.com');
    }
  });

  it('accepts extra media origins and honours an explicit empty list', () => {
    const withExtra = directives(buildAppCsp({ mediaOrigins: 'https://cdn.example.com,https://two.example.com' }));
    expect(withExtra('img-src')).toContain('https://cdn.example.com');
    expect(withExtra('img-src')).toContain('https://two.example.com');
    // Cloudinary is a DEFAULT, not a floor — a local-disk self-host may drop it.
    expect(withExtra('img-src')).not.toContain('https://res.cloudinary.com');

    const none = directives(buildAppCsp({ mediaOrigins: '' }));
    expect(none('img-src')).not.toContain('https://res.cloudinary.com');
  });

  it('reduces a URL to its origin and ignores junk', () => {
    // A trailing path or slash in the env var would produce a source expression
    // that matches nothing, silently.
    expect(originOf('https://api.example.com/api/')).toBe('https://api.example.com');
    expect(originOf('https://api.example.com:8443')).toBe('https://api.example.com:8443');
    expect(originOf('  ')).toBeNull();
    expect(originOf('not a url')).toBeNull();
  });

  it('never lists an origin twice', () => {
    const d = directives(buildAppCsp({
      backendOrigin: 'https://api.example.com',
      mediaOrigins: 'https://api.example.com',
    }));
    const occurrences = d('img-src').filter((s) => s === 'https://api.example.com');
    expect(occurrences).toHaveLength(1);
  });

  it('index.html delegates the policy instead of hardcoding one', () => {
    // Regression guard: a literal policy here is how the remote-backend build
    // broke. If someone re-inlines one, the placeholder disappears and this
    // fails rather than shipping an unreachable API.
    const html = readFileSync(join(__dirname, '..', '..', '..', 'index.html'), 'utf8');
    expect(html).toContain('content="%MOTION_CSP%"');
    expect(html).not.toMatch(/content="default-src/);
  });
});
