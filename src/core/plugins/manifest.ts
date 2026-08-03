/**
 * The plugin manifest — the contract between a package on disk and this host.
 *
 * Everything the manager needs in order to describe a plugin to the user BEFORE
 * a line of its code runs lives here: who wrote it, what version it is, which
 * host API it was built against, and — the part that matters — exactly what it
 * is asking permission to touch. A format whose only fields are `name` and a
 * function (which is what the previous plugin object was) cannot support an
 * informed install decision, because there is nothing to show but the name.
 *
 * Validation is strict and returns *messages*, not booleans: "this plugin did
 * not install" with no reason is the second-least actionable thing a plugin
 * manager can say, after saying nothing at all.
 */

/** Host API generation. Bump on a BREAKING change to the plugin-facing API. */
export const HOST_API_VERSION = 1;

/** Everything a plugin may ask for. Nothing outside this list is grantable. */
export const PERMISSIONS = {
  'scene:read': {
    label: 'Read your layers',
    detail: 'See the names, structure and properties of layers in your composition.',
  },
  'scene:write': {
    label: 'Modify your layers',
    detail: 'Create, change and delete layers. Every change is undoable.',
  },
  'animation:read': {
    label: 'Read your animation',
    detail: 'See keyframes and sample animated values over time.',
  },
  'animation:write': {
    label: 'Modify your animation',
    detail: 'Create and change keyframes and expressions. Every change is undoable.',
  },
  timeline: {
    label: 'Control the playhead',
    detail: 'Read the current time and move the playhead.',
  },
} as const;

export type PluginPermission = keyof typeof PERMISSIONS;

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as PluginPermission[];

export interface PluginManifest {
  /** Reverse-DNS, e.g. `studio.acme.easing-lab`. Namespaced so two vendors
   *  cannot collide, and stable so a document could one day reference it. */
  id: string;
  name: string;
  /** `major.minor.patch`. */
  version: string;
  description: string;
  author?: string;
  homepage?: string;
  /** Host API generation the plugin was written against. Refused when newer
   *  than this host — running it would fail in ways the author never saw. */
  apiVersion: number;
  /** Package-relative path to the entry ES module. */
  main: string;
  /** Package-relative path to an HTML panel, when the plugin has UI. */
  panel?: string;
  permissions: PluginPermission[];
}

const ID_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;
const VERSION_RE = /^\d+\.\d+\.\d+(-[\w.]+)?$/;

/**
 * A package-relative path that cannot escape the package.
 *
 * `../` in a manifest path is a directory traversal against whatever read the
 * package — worth refusing at the format level rather than trusting every
 * consumer to be careful.
 */
function isSafePath(p: unknown): p is string {
  return (
    typeof p === 'string' &&
    p.length > 0 &&
    p.length < 256 &&
    !p.startsWith('/') &&
    !/^[a-zA-Z]:/.test(p) &&
    !p.split(/[\\/]/).includes('..')
  );
}

export interface ManifestResult {
  manifest: PluginManifest | null;
  /** Empty exactly when `manifest` is non-null. */
  errors: string[];
}

/** Validate raw parsed JSON as a manifest. Never throws. */
export function parseManifest(raw: unknown): ManifestResult {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { manifest: null, errors: ['plugin.json is not a JSON object.'] };
  }
  const r = raw as Record<string, unknown>;

  const id = typeof r.id === 'string' ? r.id.trim() : '';
  if (!ID_RE.test(id)) {
    errors.push('"id" must be reverse-DNS and lowercase, e.g. "studio.acme.easing-lab".');
  }
  const name = typeof r.name === 'string' ? r.name.trim() : '';
  if (!name || name.length > 80) errors.push('"name" is required (1–80 characters).');

  const version = typeof r.version === 'string' ? r.version.trim() : '';
  if (!VERSION_RE.test(version)) errors.push('"version" must be semver, e.g. "1.0.0".');

  const description = typeof r.description === 'string' ? r.description.trim() : '';
  if (!description || description.length > 400) {
    errors.push('"description" is required (1–400 characters) — it is what the user reads before installing.');
  }

  const apiVersion = typeof r.apiVersion === 'number' ? r.apiVersion : NaN;
  if (!Number.isInteger(apiVersion) || apiVersion < 1) {
    errors.push('"apiVersion" must be a whole number ≥ 1.');
  } else if (apiVersion > HOST_API_VERSION) {
    errors.push(
      `This plugin needs host API ${apiVersion}; this version of Premation provides ${HOST_API_VERSION}. Update the app.`,
    );
  }

  if (!isSafePath(r.main)) errors.push('"main" must be a package-relative path to the entry module.');
  if (r.panel !== undefined && !isSafePath(r.panel)) {
    errors.push('"panel", when present, must be a package-relative path to an HTML file.');
  }

  const permsRaw = r.permissions;
  const permissions: PluginPermission[] = [];
  if (permsRaw !== undefined) {
    if (!Array.isArray(permsRaw)) {
      errors.push('"permissions" must be an array.');
    } else {
      for (const p of permsRaw) {
        if (typeof p !== 'string' || !(p in PERMISSIONS)) {
          errors.push(`Unknown permission "${String(p)}". Valid: ${ALL_PERMISSIONS.join(', ')}.`);
        } else if (!permissions.includes(p as PluginPermission)) {
          permissions.push(p as PluginPermission);
        }
      }
    }
  }

  if (errors.length > 0) return { manifest: null, errors };
  return {
    manifest: {
      id,
      name,
      version,
      description,
      apiVersion,
      main: r.main as string,
      ...(isSafePath(r.panel) ? { panel: r.panel } : {}),
      ...(typeof r.author === 'string' && r.author.trim() ? { author: r.author.trim().slice(0, 80) } : {}),
      ...(typeof r.homepage === 'string' && /^https?:\/\//i.test(r.homepage)
        ? { homepage: r.homepage.slice(0, 300) }
        : {}),
      permissions,
    },
    errors: [],
  };
}

/**
 * One line summarising a plugin's reach, for the manager list.
 *
 * "No permissions" is a real and good answer — a plugin that only registers
 * commands and shows its own panel needs nothing.
 */
export function describePermissions(permissions: readonly PluginPermission[]): string {
  if (permissions.length === 0) return 'Runs sandboxed. Asks for no access to your project.';
  return permissions.map((p) => PERMISSIONS[p].label).join(' · ');
}
