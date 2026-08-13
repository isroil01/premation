/**
 * `contributes.net` — the hosts a plugin may reach.
 *
 * ── This permission changes the sandbox's character, and the docs say so ─────
 *
 * Every other permission bounds what a plugin can TOUCH. This one bounds where
 * it can SEND. A plugin holding `scene:read` and `net:fetch` together can read
 * the user's project and put it somewhere else — that is not a bug in the
 * design, it is what the two permissions mean when combined, and the consent
 * screen has to say it in those words rather than list two capabilities and
 * leave the user to multiply them.
 *
 * ── Why the hosts are declared, and why they are exact ───────────────────────
 *
 * The plugin never gets a `fetch`. It asks the host to make a request, and the
 * host checks the URL against this list first — so a plugin cannot reach a host
 * it did not disclose, and the consent screen can name every destination
 * verbatim rather than saying "the internet".
 *
 * Wildcards are refused. `*.example.com` on a consent screen is a category, not
 * a destination, and the whole value of declaring hosts is that a user can read
 * the list and recognise what is on it. The cost is real — a plugin talking to
 * three subdomains lists three — and it is the right way round: the burden
 * falls on the author who knows their own infrastructure, not on the user
 * deciding whether to trust it.
 */

/** Everything a plugin declared about its network access. */
export interface NetContribution {
  /** Exact lowercase hostnames. Never empty when `net:fetch` is requested. */
  hosts: string[];
}

/**
 * Caps.
 *
 * A list a user cannot read is a list they scroll past, and the consent screen
 * shows every entry. Eight is more than any honest plugin needs and few enough
 * to take in at a glance.
 */
export const MAX_NET_HOSTS = 8;
const MAX_HOST_LENGTH = 253;

/**
 * A hostname, conservatively.
 *
 * Labels of letters, digits and hyphens, at least two of them, ending in an
 * alphabetic TLD. Deliberately narrower than the RFC: it rejects trailing dots,
 * IP literals, ports, userinfo and unicode — every one of which is a way to
 * write a host that a user reads as one thing and a URL parser resolves as
 * another.
 */
const HOST_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*\.[a-z]{2,}$/;

/**
 * Hosts that are refused even though they parse.
 *
 * Declared here as well as blocked at request time, so an author finds out when
 * they publish rather than when a user's request is refused. The request-time
 * check is the control; this is the error message.
 */
const NEVER_ALLOWED = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
]);

/** `.local` and `.internal` name networks that are not the author's to reach. */
const NEVER_ALLOWED_SUFFIX = ['.local', '.internal', '.localhost', '.home.arpa'];

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Validate `contributes.net`.
 *
 * Returns `null` when the block is absent, which is the common case and means
 * the plugin has no network access at all — distinct from an empty host list,
 * which is refused, because "I want network access to nowhere" is a mistake
 * rather than a configuration.
 */
export function parseNet(raw: unknown, errors: string[]): NetContribution | null {
  if (raw === undefined) return null;

  if (!isPlainObject(raw)) {
    errors.push('"contributes.net" must be an object.');
    return null;
  }

  const hosts = raw.hosts;
  if (!Array.isArray(hosts)) {
    errors.push('"contributes.net.hosts" must be an array of hostnames.');
    return null;
  }
  if (hosts.length === 0) {
    errors.push(
      '"contributes.net.hosts" is empty. Declare the hosts this plugin needs, or remove the "net" block — network access to nowhere is a mistake rather than a configuration.',
    );
    return null;
  }
  if (hosts.length > MAX_NET_HOSTS) {
    errors.push(
      `"contributes.net.hosts" declares ${hosts.length} hosts; the limit is ${MAX_NET_HOSTS}. Every one is shown on the consent screen, and a list nobody reads is a list nobody checks.`,
    );
    return null;
  }

  const clean: string[] = [];
  const seen = new Set<string>();

  for (const [i, entry] of hosts.entries()) {
    const at = `contributes.net.hosts[${i}]`;
    if (typeof entry !== 'string') {
      errors.push(`"${at}" must be a string.`);
      return null;
    }

    const host = entry.trim().toLowerCase();

    if (host.includes('*')) {
      errors.push(
        `"${at}": wildcards are not allowed. A pattern on a consent screen is a category rather than a destination — list each host you actually contact.`,
      );
      return null;
    }
    if (host.includes('/') || host.includes(':') || host.includes('@')) {
      errors.push(
        `"${at}" must be a bare hostname — no scheme, port, path or credentials.`,
      );
      return null;
    }
    if (host.length > MAX_HOST_LENGTH || !HOST_RE.test(host)) {
      errors.push(`"${at}" is not a hostname this editor will accept.`);
      return null;
    }
    if (NEVER_ALLOWED.has(host) || NEVER_ALLOWED_SUFFIX.some((s) => host.endsWith(s))) {
      errors.push(
        `"${at}": "${host}" names a machine on the user's own network, which a plugin may not reach.`,
      );
      return null;
    }
    if (seen.has(host)) {
      errors.push(`"${at}" duplicates an earlier host "${host}".`);
      return null;
    }

    seen.add(host);
    clean.push(host);
  }

  // Sorted, so the consent screen's order does not depend on how the author
  // happened to type the array — two publishes of the same list must read the
  // same to a user comparing them.
  return { hosts: clean.sort() };
}

/**
 * Is this URL one the plugin declared?
 *
 * Scheme and host only. A path is not checked and deliberately is not: the
 * consent screen promises a HOST, and a per-path allowlist would promise
 * something finer than the user was shown while being trivially worked around
 * by any host that serves a redirect or a query parameter.
 *
 * Exact host match, no subdomain widening — `api.example.com` does not permit
 * `evil.api.example.com`, and neither permits the other.
 */
export function isDeclaredHost(url: string, net: NetContribution | null): boolean {
  if (!net) return false;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  // HTTPS only. Plain HTTP is readable and modifiable by anything on the path
  // between the user and the host, and a plugin's traffic carries whatever the
  // plugin was given access to.
  if (parsed.protocol !== 'https:') return false;

  return net.hosts.includes(parsed.hostname.toLowerCase());
}
