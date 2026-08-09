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
 * API 2 extends that principle from *permissions* to *contributions*. Under
 * API 1 a plugin's commands existed only after its worker booted and its
 * `activate()` called `commands.register` — so the only way to find out what a
 * plugin offered was to run it. That is backwards for two reasons at once:
 *
 *   • A listing page cannot say "6 commands, 1 panel" before install.
 *   • Every installed plugin has to be started at launch just in case, and with
 *     forty of them that is forty workers racing an 8-second boot timeout.
 *
 * So `contributes` is DECLARED, read without executing anything, and
 * `activationEvents` says what should actually wake the worker up.
 *
 * Validation is strict and returns *messages*, not booleans: "this plugin did
 * not install" with no reason is the second-least actionable thing a plugin
 * manager can say, after saying nothing at all.
 */

import { ICON_NAMES } from '@components/Icon/iconNames';
import { parseLayerKinds, type LayerKindContribution } from './layerKindSchema';
import { parseEffects, type EffectContribution } from './effectSchema';
import { parseNet, type NetContribution } from './netSchema';

/**
 * Host API generation. Bump on a BREAKING change to the plugin-facing API.
 *
 * 3 — `contributes.layerKinds`. A plugin can declare a layer type the editor
 *     has never heard of, with animatable properties that behave like native
 *     ones. This is a version bump rather than an additive feature because it
 *     changes what a DOCUMENT contains: a project that uses a custom layer now
 *     references the plugin that defines it, which nothing before API 3 did.
 *
 * 4 — `contributes.effects`. A plugin can draw pixels: WGSL plus a typed
 *     parameter schema, compiled and bound by the host. A version bump for the
 *     same reason 3 was — a document using a plugin effect references the
 *     plugin that provides it — and because `render: "shader"` on a layer kind
 *     stops being a reserved value and starts meaning something.
 */
export const HOST_API_VERSION = 4;

/** Everything a plugin may ask for. Nothing outside this list is grantable. */
export const PERMISSIONS = {
  'scene:read': {
    label: 'Read your layers',
    detail: 'See the names, structure and properties of layers in your composition.',
  },
  /*
    Listed BEFORE `scene:write`, and the order is load-bearing.

    The consent screen renders this object in key order, and a user reading top
    to bottom should meet the narrow grant before the wide one. "Build the
    layers beneath its own" is something a person can picture; "create, change
    and delete layers" is not, and meeting the wide one first makes the narrow
    one read as a footnote to it rather than as the alternative.
  */
  'scene:proxy': {
    label: 'Build the layers beneath its own',
    detail:
      'Generate and update the child layers underneath layers this plugin itself created. '
      + 'It cannot reach anything else in your composition, and it stops managing a layer the moment you edit it.',
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
  'assets:read': {
    label: 'Read images in your project',
    // Was "Plugins cannot access the internet." That stopped being true when
    // `net:fetch` shipped, and a reassurance that has quietly become false is
    // worse than no reassurance — the user reads it while deciding what to
    // trust. The remaining sentence is still true and still worth saying: a
    // plugin has NO network of its own, and reaching one is a separate
    // permission with its own named destinations.
    detail: 'Read the pixels of images already in your composition. Plugins have no network access unless you also grant "Contact specific websites".',
  },
  'net:fetch': {
    label: 'Contact specific websites',
    /*
      The one permission whose danger is a COMBINATION, said plainly.

      Listing "can reach the internet" beside "can read your layers" leaves the
      user to multiply the two, and most will not. A plugin holding both can
      take a copy of the project somewhere else, and that is not a flaw in the
      design — it is what the pair means. The consent screen names the hosts
      separately, from `contributes.net`.
    */
    detail: 'Send and receive data from the websites this plugin lists below — and only those. Combined with permission to read your layers, a plugin could copy your project to them.',
  },
  'assets:write': {
    label: 'Add images to your project',
    detail: 'Create new images and place them as layers. Every change is undoable.',
  },
  timeline: {
    label: 'Control the playhead',
    detail: 'Read the current time and move the playhead.',
  },
} as const;

export type PluginPermission = keyof typeof PERMISSIONS;

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as PluginPermission[];

/**
 * Permissions that CONTAIN other permissions.
 *
 * `scene:write` is "create, change and delete layers"; `scene:proxy` is a
 * proper subset of that — the same verbs, restricted to a plugin's own proxy
 * subtrees. Holding the wide one and being refused the narrow one would be
 * nonsense, and it is also the migration: every plugin installed before
 * `scene:proxy` existed holds `scene:write` and must keep working with no
 * re-consent.
 *
 * ── Why this is a table and not an `||` in the gate ─────────────────────────
 *
 * The registry's publish-time scanner reads the same method→permission map to
 * infer which permissions a package actually uses. Without the implication it
 * would see a call to `scene.setProxyChildren`, conclude the package needs
 * `scene:proxy`, find only `scene:write` in the manifest, and report an
 * undeclared permission — sending every existing proxy plugin to manual review
 * for a call it is fully entitled to make. So the relationship has to be known
 * on BOTH sides, which makes it data rather than a branch.
 *
 * Deliberately not transitive and deliberately not a graph. One level is what
 * the model needs; a hierarchy is a thing to get subtly wrong in a security
 * check, and `expandPermissions` below would have to close over it.
 */
export const PERMISSION_IMPLIES: Readonly<Partial<Record<PluginPermission, readonly PluginPermission[]>>> = {
  'scene:write': ['scene:proxy'],
};

/**
 * A grant, plus everything it contains.
 *
 * The set to check a required permission against — never the raw grant. A
 * caller that tests `granted.includes(required)` directly is the bug this
 * exists to prevent, and it is a quiet one: it refuses a plugin holding a
 * STRICTLY WIDER permission than the one being asked for.
 */
export function expandPermissions(
  granted: readonly PluginPermission[],
): ReadonlySet<PluginPermission> {
  const out = new Set<PluginPermission>(granted);
  for (const held of granted) {
    for (const implied of PERMISSION_IMPLIES[held] ?? []) out.add(implied);
  }
  return out;
}

/** A command declared in the manifest — and, identically, one registered at
 *  runtime. One shape, so a declared command and a registered one cannot drift. */
export interface PluginCommandContribution {
  /** Plugin-local id; the host namespaces it as `plugin.<pluginId>.<id>`. */
  id: string;
  label: string;
  /** Icon name from the editor's vocabulary. Checked here, at validation time,
   *  rather than at render time — an unknown name that silently falls back to
   *  the generic glyph is a typo the author never finds out about. */
  icon?: string;
  /** When true the host only enables it with a non-empty selection. */
  needsSelection?: boolean;
}

/**
 * Where the host should put a panel.
 *
 * One field with three values rather than two orthogonal ones (dock × shape),
 * because two would spell four combinations of which only three are real — and
 * the fourth ("shared, but in the left sidebar") would need a second shared host
 * nobody asked for. Each value names a destination the user can point at.
 *
 *  • `shared` — a tab inside the one "Plugin Panels" panel in the right
 *    inspector. Costs no rail space, so it is the default and the right answer
 *    for the common case: a small panel of controls for the current selection.
 *  • `sidebar` — its OWN rail tab in the left sidebar, beside Scene, Assets and
 *    Library. For a plugin that is a place you go rather than a control you
 *    reach for: a browser, a library, an asset generator.
 *  • `inspector` — its own rail tab in the right inspector, beside Properties
 *    and Effects. For a full editor that still belongs to the selection.
 *
 * A rail tab is not granted just because it is asked for — see
 * `layout/Plugins/pluginPanelDefs.ts`, which caps how many a rail will give out.
 */
export type PluginPanelPlacement = 'shared' | 'sidebar' | 'inspector';

export const PANEL_PLACEMENTS: readonly PluginPanelPlacement[] = ['shared', 'sidebar', 'inspector'];

/** A panel declared in the manifest. */
export interface PluginPanelContribution {
  id: string;
  title: string;
  /** Package-relative path to the panel's HTML. */
  entry: string;
  /**
   * Always set after parsing — `shared` when the manifest says nothing, which is
   * what every plugin written before this field existed gets, and is exactly
   * the behaviour it already had.
   */
  placement: PluginPanelPlacement;
  /**
   * Rail glyph, for a panel that gets its own tab.
   *
   * Validated against the editor's icon set at PARSE time, like `command.icon`:
   * the rail is icon-ONLY, so a name that silently falls back to the generic
   * plugin glyph is a typo whose only symptom is a tab the author cannot tell
   * apart from someone else's.
   */
  icon?: string;
}

/**
 * What a plugin contributes, readable without executing it.
 *
 * Always normalised by `parseManifest` — every key present, arrays possibly
 * empty — so no consumer has to write `contributes?.commands ?? []`. A field
 * that is sometimes absent and sometimes empty is two representations of one
 * state, and every reader has to know about both.
 */
export interface PluginContributes {
  commands: PluginCommandContribution[];
  panels: PluginPanelContribution[];
  /**
   * Layer types this plugin invents. Requires `apiVersion: 3`.
   *
   * See `layerKindSchema.ts` — including why `render` is part of the schema
   * rather than a runtime choice, and why only some property types animate.
   */
  layerKinds: LayerKindContribution[];
  /**
   * Effects this plugin draws. Requires `apiVersion: 4`.
   *
   * See `effectSchema.ts` — including why the shader is DATA rather than a
   * callback, and why the host writes the bindings rather than the author.
   */
  effects: EffectContribution[];
  /**
   * Hosts this plugin may contact. Requires `apiVersion: 4` and the
   * `net:fetch` permission — see `netSchema.ts`.
   *
   * `null` means the plugin declared no network block, which is the common
   * case. That is NOT the same as an empty host list, which is refused:
   * network access to nowhere is a mistake rather than a configuration.
   */
  net: NetContribution | null;
}

/**
 * Keys that are recognised but must be empty in this version.
 *
 * Empty as of API 4, when `effects` became real. Kept as a mechanism rather
 * than deleted: it is how the NEXT reserved key gets refused with a version
 * message instead of an unknown-key one, and those are different problems for
 * an author — one means "wait", the other means "you made a typo".
 */
export const RESERVED_CONTRIBUTION_KEYS: readonly string[] = [];

/**
 * What wakes a plugin's worker up.
 *
 * `onStartup` is the API-1 behaviour and stays the default, because a plugin
 * that does not say when it is needed has to be assumed to be needed always.
 */
export type ActivationEvent =
  | 'onStartup'
  | `onCommand:${string}`
  | `onPanel:${string}`
  // Fired when a document containing this kind is opened. Declaring a kind
  // implies it (see `activatesOnLayerKind`); the spelling exists so an
  // author can be explicit, and so the set is readable from the manifest.
  | `onLayerKind:${string}`;

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
  permissions: PluginPermission[];
  /** Always present after parsing — see `PluginContributes`. A legacy
   *  `panel: "panel.html"` string is normalised into `panels` here, so nothing
   *  downstream needs to know that spelling ever existed. */
  contributes: PluginContributes;
  /** Always non-empty after parsing; `['onStartup']` when unspecified. */
  activationEvents: ActivationEvent[];
}

const ID_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;
const VERSION_RE = /^\d+\.\d+\.\d+(-[\w.]+)?$/;
/** Contribution-local ids: no dots, because the host joins on dots. */
const LOCAL_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const ICONS: ReadonlySet<string> = new Set(ICON_NAMES);

/** The panel id a legacy `panel: "…"` string is normalised to. */
export const LEGACY_PANEL_ID = 'main';

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

/** An empty, fully-normalised contribution block. */
function emptyContributes(): PluginContributes {
  return { commands: [], panels: [], layerKinds: [], effects: [], net: null };
}

/**
 * Validate `contributes`, pushing messages rather than throwing.
 *
 * Takes `name` because a legacy panel has no declared title and the plugin's
 * own name is the only honest thing to put in the tab.
 */
function parseContributes(
  raw: unknown,
  legacyPanel: unknown,
  name: string,
  apiVersion: number,
  errors: string[],
): PluginContributes {
  const out = emptyContributes();

  if (raw !== undefined && apiVersion < 2) {
    errors.push('"contributes" requires "apiVersion": 2. Bump it, or remove the block.');
    return out;
  }
  if (raw !== undefined && legacyPanel !== undefined) {
    // Whichever one won, the other would be silently ignored, and the author
    // would be debugging a panel that "does not open" while looking at a
    // manifest that declares it twice.
    errors.push('Declare a panel either as "panel" or in "contributes.panels" — not both.');
    return out;
  }

  if (raw === undefined) {
    // API 1 shape. A bare `panel` string becomes the one declared panel.
    if (legacyPanel !== undefined) {
      if (!isSafePath(legacyPanel)) {
        errors.push('"panel", when present, must be a package-relative path to an HTML file.');
      } else {
        // `shared`, like every other undeclared panel. An API-1 package predates
        // placement entirely, and the one thing it must keep doing is what it
        // did before.
        out.panels.push({
          id: LEGACY_PANEL_ID,
          title: name || LEGACY_PANEL_ID,
          entry: legacyPanel,
          placement: 'shared',
        });
      }
    }
    return out;
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push('"contributes" must be an object.');
    return out;
  }
  const c = raw as Record<string, unknown>;

  for (const key of RESERVED_CONTRIBUTION_KEYS) {
    const v = c[key];
    if (v === undefined) continue;
    if (!Array.isArray(v)) {
      errors.push(`"contributes.${key}" must be an array.`);
    } else if (v.length > 0) {
      errors.push(`"contributes.${key}" is not supported in this version.`);
    }
  }

  if (c.layerKinds !== undefined) {
    if (apiVersion >= 3) {
      out.layerKinds = parseLayerKinds(c.layerKinds, errors, ICONS);
    } else if (!Array.isArray(c.layerKinds)) {
      errors.push('"contributes.layerKinds" must be an array.');
    } else if (c.layerKinds.length > 0) {
      // Only a NON-EMPTY block is using the feature. An API-2 manifest that
      // spells out `layerKinds: []` was valid before this version shipped and
      // stays valid — refusing it would break packages that declared nothing.
      //
      // The message names the version, because the fix is a one-character edit
      // and "not supported in this version" sends the author looking for a
      // newer editor they already have.
      errors.push('"contributes.layerKinds" requires "apiVersion": 3.');
    }
  }

  if (c.effects !== undefined) {
    if (apiVersion >= 4) {
      out.effects = parseEffects(c.effects, errors);
    } else if (!Array.isArray(c.effects)) {
      errors.push('"contributes.effects" must be an array.');
    } else if (c.effects.length > 0) {
      // Same back-compat rule as `layerKinds`, and it matters more here: every
      // manifest written against API 1–3 was allowed to spell out
      // `effects: []`, because the key was RESERVED and validated as
      // must-be-empty. Requiring API 4 for an empty block would break packages
      // that declared nothing, which is the opposite of what a version gate is
      // for.
      errors.push('"contributes.effects" requires "apiVersion": 4.');
    }
  }

  if (c.net !== undefined) {
    if (apiVersion >= 4) {
      out.net = parseNet(c.net, errors);
    } else {
      // No empty-block escape hatch here, unlike `effects` and `layerKinds`.
      // `net` was never a reserved key, so no older manifest can be declaring
      // it — anything that does is asking for the capability.
      errors.push('"contributes.net" requires "apiVersion": 4.');
    }
  }

  if (c.commands !== undefined) {
    if (!Array.isArray(c.commands)) {
      errors.push('"contributes.commands" must be an array.');
    } else {
      const seen = new Set<string>();
      c.commands.forEach((entry, i) => {
        const at = `contributes.commands[${i}]`;
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          errors.push(`"${at}" must be an object.`);
          return;
        }
        const e = entry as Record<string, unknown>;
        const id = typeof e.id === 'string' ? e.id : '';
        if (!LOCAL_ID_RE.test(id)) {
          errors.push(`"${at}.id" must be lowercase letters, digits and dashes (1–64 characters).`);
          return;
        }
        if (seen.has(id)) {
          errors.push(`"${at}.id" duplicates an earlier command id "${id}".`);
          return;
        }
        seen.add(id);

        const label = typeof e.label === 'string' ? e.label.trim() : '';
        if (!label || label.length > 80) {
          errors.push(`"${at}.label" is required (1–80 characters).`);
          return;
        }
        if (e.icon !== undefined && (typeof e.icon !== 'string' || !ICONS.has(e.icon))) {
          errors.push(`"${at}.icon" is not an icon this editor has. Omit it to use the plugin glyph.`);
          return;
        }
        out.commands.push({
          id,
          label,
          ...(typeof e.icon === 'string' ? { icon: e.icon } : {}),
          ...(e.needsSelection === true ? { needsSelection: true } : {}),
        });
      });
    }
  }

  if (c.panels !== undefined) {
    if (!Array.isArray(c.panels)) {
      errors.push('"contributes.panels" must be an array.');
    } else {
      const seen = new Set<string>();
      c.panels.forEach((entry, i) => {
        const at = `contributes.panels[${i}]`;
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          errors.push(`"${at}" must be an object.`);
          return;
        }
        const e = entry as Record<string, unknown>;
        const id = typeof e.id === 'string' ? e.id : '';
        if (!LOCAL_ID_RE.test(id)) {
          errors.push(`"${at}.id" must be lowercase letters, digits and dashes (1–64 characters).`);
          return;
        }
        if (seen.has(id)) {
          errors.push(`"${at}.id" duplicates an earlier panel id "${id}".`);
          return;
        }
        seen.add(id);

        const title = typeof e.title === 'string' ? e.title.trim() : '';
        if (!title || title.length > 80) {
          errors.push(`"${at}.title" is required (1–80 characters) — it is the tab label.`);
          return;
        }
        // Same rule as `main`: a panel entry is a path the host will read out
        // of the package, so it gets the same traversal check.
        if (!isSafePath(e.entry)) {
          errors.push(`"${at}.entry" must be a package-relative path to an HTML file.`);
          return;
        }

        // Refused rather than defaulted. A typo like "left" would otherwise mean
        // the panel quietly appears somewhere the author never chose, and the
        // only symptom is "my panel is in the wrong place" with nothing to read.
        let placement: PluginPanelPlacement = 'shared';
        if (e.placement !== undefined) {
          if (typeof e.placement !== 'string' || !PANEL_PLACEMENTS.includes(e.placement as PluginPanelPlacement)) {
            errors.push(
              `"${at}.placement" must be one of ${PANEL_PLACEMENTS.map((p) => `"${p}"`).join(', ')}.`,
            );
            return;
          }
          placement = e.placement as PluginPanelPlacement;
        }

        if (e.icon !== undefined && (typeof e.icon !== 'string' || !ICONS.has(e.icon))) {
          errors.push(`"${at}.icon" is not an icon this editor has. Omit it to use the plugin glyph.`);
          return;
        }
        // Not an error, because the panel still works — it just gets the generic
        // glyph, and on an icon-only rail that is worth saying out loud once.
        // Refusing it outright would make `icon` mandatory in all but name for
        // the two placements where it matters.
        if (placement !== 'shared' && e.icon === undefined) {
          errors.push(
            `"${at}" asks for its own tab, so it needs an "icon" — the sidebar rail shows glyphs, not titles.`,
          );
          return;
        }

        out.panels.push({
          id,
          title,
          entry: e.entry,
          placement,
          ...(typeof e.icon === 'string' ? { icon: e.icon } : {}),
        });
      });
    }
  }

  return out;
}

/** Validate `activationEvents` against what the plugin actually declares. */
function parseActivationEvents(
  raw: unknown,
  contributes: PluginContributes,
  errors: string[],
): ActivationEvent[] {
  // Missing or empty both mean "no opinion", and the safe reading of no opinion
  // is the API-1 behaviour: start it.
  if (raw === undefined) return ['onStartup'];
  if (!Array.isArray(raw)) {
    errors.push('"activationEvents" must be an array.');
    return ['onStartup'];
  }
  if (raw.length === 0) return ['onStartup'];

  const commandIds = new Set(contributes.commands.map((c) => c.id));
  const panelIds = new Set(contributes.panels.map((p) => p.id));
  const layerKindIds = new Set(contributes.layerKinds.map((k) => k.id));
  const out: ActivationEvent[] = [];

  for (const ev of raw) {
    if (typeof ev !== 'string') {
      errors.push('Every entry in "activationEvents" must be a string.');
      continue;
    }
    if (ev === 'onStartup') {
      if (!out.includes('onStartup')) out.push('onStartup');
      continue;
    }
    const command = /^onCommand:(.*)$/.exec(ev);
    if (command) {
      // A reference to something that does not exist is an event that can never
      // fire — which presents to the user as a plugin that simply never starts,
      // with nothing anywhere saying why.
      if (!commandIds.has(command[1]!)) {
        errors.push(`"activationEvents" refers to command "${command[1]}", which is not in "contributes.commands".`);
        continue;
      }
      if (!out.includes(ev as ActivationEvent)) out.push(ev as ActivationEvent);
      continue;
    }
    const panel = /^onPanel:(.*)$/.exec(ev);
    if (panel) {
      if (!panelIds.has(panel[1]!)) {
        errors.push(`"activationEvents" refers to panel "${panel[1]}", which is not in "contributes.panels".`);
        continue;
      }
      if (!out.includes(ev as ActivationEvent)) out.push(ev as ActivationEvent);
      continue;
    }
    const layerKind = /^onLayerKind:(.*)$/.exec(ev);
    if (layerKind) {
      if (!layerKindIds.has(layerKind[1]!)) {
        errors.push(
          `"activationEvents" refers to layer kind "${layerKind[1]}", which is not in "contributes.layerKinds".`,
        );
        continue;
      }
      if (!out.includes(ev as ActivationEvent)) out.push(ev as ActivationEvent);
      continue;
    }
    errors.push(
      `Unknown activation event "${ev}". Valid: onStartup, onCommand:<id>, onPanel:<id>, onLayerKind:<id>.`,
    );
  }

  return out.length > 0 ? out : ['onStartup'];
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

  const contributes = parseContributes(r.contributes, r.panel, name, apiVersion, errors);
  const activationEvents = parseActivationEvents(r.activationEvents, contributes, errors);

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

  /*
    ★ The permission and the host list must agree, in BOTH directions.

    They are two halves of one statement — "this plugin reaches the network, and
    these are the places" — and either half alone is a manifest that means
    something different from what it looks like:

      • `net:fetch` with no hosts is a permission the consent screen would show
        with nothing under it. The user is asked to approve "contact websites"
        and shown no websites, which is the vaguest possible version of the one
        permission that most needs to be specific.

      • Hosts with no `net:fetch` is a list the user is never shown, attached to
        a capability the plugin does not have. Harmless today and exactly the
        shape of a plugin that adds the permission in its next version, when the
        hosts have already been sitting in the manifest unread.

    Checked here rather than in `parseNet`, because only this scope can see both.
  */
  const wantsNet = permissions.includes('net:fetch');
  if (wantsNet && !contributes.net) {
    errors.push(
      'The "net:fetch" permission requires a "contributes.net.hosts" list — the consent screen names the hosts, and a permission with nothing under it tells the user nothing.',
    );
  }
  if (!wantsNet && contributes.net) {
    errors.push(
      '"contributes.net" was declared without the "net:fetch" permission. Ask for the permission, or remove the block.',
    );
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
      ...(typeof r.author === 'string' && r.author.trim() ? { author: r.author.trim().slice(0, 80) } : {}),
      ...(typeof r.homepage === 'string' && /^https?:\/\//i.test(r.homepage)
        ? { homepage: r.homepage.slice(0, 300) }
        : {}),
      permissions,
      contributes,
      activationEvents,
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

/**
 * One line summarising what a plugin adds — "6 commands · 1 panel".
 *
 * The point of declaring contributions is that this can be shown on a listing
 * page BEFORE install, so it takes the counts and not a running plugin.
 */
export function describeContributions(contributes: PluginContributes): string {
  const parts: string[] = [];
  const { commands, panels, layerKinds } = contributes;
  if (commands.length > 0) parts.push(`${commands.length} command${commands.length === 1 ? '' : 's'}`);
  if (panels.length > 0) parts.push(`${panels.length} panel${panels.length === 1 ? '' : 's'}`);
  // Listed because it is the contribution that changes a DOCUMENT. A user
  // deciding whether to uninstall should be able to see that this one leaves
  // something behind in their projects.
  if (layerKinds.length > 0) {
    parts.push(`${layerKinds.length} layer type${layerKinds.length === 1 ? '' : 's'}`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'Adds no commands or panels.';
}

/**
 * Does this plugin want to start as soon as the editor does?
 *
 * The one question the host asks at boot, and the difference between spawning
 * forty workers and spawning none.
 */
export function activatesOnStartup(manifest: PluginManifest): boolean {
  return manifest.activationEvents.includes('onStartup');
}

/** Does `manifest` declare an activation event for this command / panel id? */
export function activatesOnCommand(manifest: PluginManifest, commandId: string): boolean {
  return manifest.activationEvents.includes(`onCommand:${commandId}`);
}

export function activatesOnPanel(manifest: PluginManifest, panelId: string): boolean {
  return manifest.activationEvents.includes(`onPanel:${panelId}`);
}

/**
 * Does `manifest` want to wake when a document containing one of its layer
 * kinds is opened?
 *
 * Implicit rather than declared: a plugin that defines a layer kind and does
 * NOT start when one appears is a plugin whose layers sit inert in a project
 * that has it installed. There is no coherent reason to opt out, and making it
 * opt-in would mean every author gets it wrong once.
 */
export function activatesOnLayerKind(manifest: PluginManifest, kindId: string): boolean {
  return manifest.contributes.layerKinds.some((k) => k.id === kindId)
    || manifest.activationEvents.includes(`onLayerKind:${kindId}` as ActivationEvent);
}
