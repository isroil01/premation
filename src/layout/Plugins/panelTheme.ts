/**
 * The editor's look, handed to a plugin panel.
 *
 * A panel frame is sandboxed with an opaque origin. That is the point — it
 * cannot read this document, so it cannot read our stylesheets either, and the
 * consequence is that every plugin panel written so far has been unstyled white
 * on a dark editor. Authors either shipped a hardcoded dark theme (wrong the
 * moment the user switches to light) or shipped nothing (wrong always).
 *
 * So the host posts the values in. A small, deliberately GENERIC vocabulary —
 * `--pm-bg`, not `--color-panel-header` — because these are a contract with
 * third-party code: renaming an internal token must not break every installed
 * plugin, and exposing seventy of them would guarantee that it does.
 *
 * This is one-directional. A panel receives colours; it cannot set them, and it
 * cannot style anything outside its own frame.
 */

/** Generic name → the editor token it currently resolves from. */
const TOKEN_MAP: ReadonlyArray<readonly [string, string]> = [
  ['--pm-bg', '--color-panel'],
  ['--pm-surface', '--color-surface-1'],
  ['--pm-fg', '--color-text-primary'],
  ['--pm-muted', '--color-text-secondary'],
  ['--pm-accent', '--color-primary'],
  ['--pm-accent-fg', '--color-primary-foreground'],
  ['--pm-border', '--color-border'],
  ['--pm-hover', '--color-hover'],
  ['--pm-danger', '--color-danger'],
  ['--pm-radius', '--radius-md'],
  ['--pm-font', '--font-family-sans'],
  ['--pm-font-mono', '--font-family-mono'],
  ['--pm-font-size', '--font-size-body'],
  ['--pm-space-1', '--space-1'],
  ['--pm-space-2', '--space-2'],
  ['--pm-space-3', '--space-3'],
  ['--pm-space-4', '--space-4'],
];

/**
 * Values used when a token resolves to nothing.
 *
 * Not decoration. A panel that receives an empty string for `--pm-bg` renders
 * transparent-on-white and looks broken, and the token names above are the kind
 * of thing that gets renamed during a design pass — so the fallback is what
 * keeps a rename from shipping as "every plugin panel went white".
 */
const FALLBACKS: Readonly<Record<string, string>> = {
  '--pm-bg': '#1e1e1e',
  '--pm-surface': '#252525',
  '--pm-fg': '#e6e6e6',
  '--pm-muted': '#9a9a9a',
  '--pm-accent': '#3b82f6',
  '--pm-accent-fg': '#ffffff',
  '--pm-border': '#3a3a3a',
  '--pm-hover': 'rgba(255,255,255,0.06)',
  '--pm-danger': '#ef4444',
  '--pm-radius': '4px',
  '--pm-font': 'system-ui, sans-serif',
  '--pm-font-mono': 'ui-monospace, monospace',
  '--pm-font-size': '12px',
  '--pm-space-1': '4px',
  '--pm-space-2': '8px',
  '--pm-space-3': '12px',
  '--pm-space-4': '16px',
};

export interface PanelTheme {
  /** `'light' | 'dark'`, so a panel can branch on more than colour. */
  mode: string;
  /** `--pm-*` → value. Applied by the panel shell to its own `:root`. */
  vars: Record<string, string>;
}

/**
 * Read the live theme off the document root.
 *
 * Computed rather than mapped from a table, because the resolved value is what
 * the user is actually looking at — a table would be a second source of truth
 * that goes stale the first time a theme file changes.
 */
export function readPanelTheme(): PanelTheme {
  const vars: Record<string, string> = {};
  const root = typeof document !== 'undefined' ? document.documentElement : null;
  const computed = root ? getComputedStyle(root) : null;

  for (const [generic, token] of TOKEN_MAP) {
    const value = computed?.getPropertyValue(token).trim();
    vars[generic] = value || FALLBACKS[generic]!;
  }

  return {
    mode: root?.getAttribute('data-theme') === 'light' ? 'light' : 'dark',
    vars,
  };
}

/**
 * Call `onChange` whenever the editor's theme changes.
 *
 * Watches the `data-theme` attribute rather than subscribing to `ThemeManager`.
 * The attribute is what the CSS actually keys off, so observing it catches every
 * path that changes the theme — including any that does not go through the
 * manager — and it needs no singleton to exist, which matters because panels
 * also mount in pop-out windows that boot a smaller shell.
 */
export function subscribeToTheme(onChange: () => void): () => void {
  if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}
