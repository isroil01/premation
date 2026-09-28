/**
 * Panel id → the doc section its `?` opens.
 *
 * A small table rather than a convention, because the docs are organised by
 * subsystem and the panels by workflow, and the two do not line up by name:
 * the Tracker's doc is ONE_CLICK_TRACKING, the Rig panel's is
 * BONE_AND_PUPPET_RIGGING. `heading` is matched case-insensitively as a
 * substring of a section heading in that doc; absent, the doc's first section
 * opens. Anything not listed falls back to the Editor Reference.
 */

export interface HelpLink {
  /** `docs/<doc>.md` */
  doc: string;
  /** A heading in that doc to land on (substring, case-insensitive). */
  heading?: string;
}

export const DEFAULT_HELP: HelpLink = { doc: 'EDITOR_REFERENCE' };

export const PANEL_HELP: Readonly<Record<string, HelpLink>> = {
  scene: { doc: 'EDITOR_REFERENCE', heading: 'Scene' },
  effectControls: { doc: 'EDITOR_REFERENCE', heading: 'Effect' },
  assets: { doc: 'VIDEO_EDITING_PIPELINE', heading: 'Import' },
  transcript: { doc: 'CAPTIONS' },
  library: { doc: 'EDITOR_REFERENCE', heading: 'Library' },
  ai: { doc: 'AI_ARCHITECTURE_FULL' },
  properties: { doc: 'EDITOR_REFERENCE', heading: 'Inspector' },
  character: { doc: 'EDITOR_REFERENCE', heading: 'Text' },
  paragraph: { doc: 'EDITOR_REFERENCE', heading: 'Text' },
  align: { doc: 'EDITOR_REFERENCE', heading: 'Align' },
  swatches: { doc: 'EDITOR_REFERENCE', heading: 'Swatches' },
  info: { doc: 'EDITOR_REFERENCE', heading: 'Audio' },
  scopes: { doc: 'EDITOR_REFERENCE', heading: 'Scopes' },
  preview: { doc: 'EDITOR_REFERENCE', heading: 'Preview' },
  sourceMonitor: { doc: 'VIDEO_EDITING_PIPELINE', heading: 'Source' },
  tracker: { doc: 'ONE_CLICK_TRACKING' },
  rig: { doc: 'BONE_AND_PUPPET_RIGGING' },
  effects: { doc: 'COMPOSITING_PLAN', heading: 'Effects' },
  motion: { doc: 'CHOREOGRAPHY' },
  presets: { doc: 'CHOREOGRAPHY', heading: 'Preset' },
  history: { doc: 'EDITOR_REFERENCE', heading: 'History' },
  renderQueue: { doc: 'EDITOR_REFERENCE', heading: 'Render' },
  export: { doc: 'EDITOR_REFERENCE', heading: 'Export' },
  // Non-panel surfaces that also link here.
  errorBoundary: { doc: 'EDITOR_REFERENCE', heading: 'Troubleshooting' },
  exportFailed: { doc: 'EDITOR_REFERENCE', heading: 'Export' },
  renderFailed: { doc: 'EDITOR_REFERENCE', heading: 'Render' },
};

export function helpLinkFor(id: string): HelpLink {
  return PANEL_HELP[id] ?? DEFAULT_HELP;
}

/**
 * Pick the section a link lands on out of an indexed doc. Pure, so the
 * matching order (heading match → doc's first section → nothing) is testable
 * without the Vite glob.
 */
export function pickHelpSection<T extends { doc: string; heading: string; level: number }>(
  sections: ReadonlyArray<T>,
  link: HelpLink,
): T | null {
  const inDoc = sections.filter((s) => s.doc === link.doc);
  if (inDoc.length === 0) return null;
  if (link.heading) {
    const needle = link.heading.toLowerCase();
    const hit = inDoc.find((s) => s.level > 1 && s.heading.toLowerCase().includes(needle));
    if (hit) return hit;
  }
  return inDoc[0] ?? null;
}

/** Where the same section lives on the web, for the desktop's external browser. */
export function helpUrlFor(link: HelpLink): string {
  const base = 'https://github.com/isroil01/motion-editor/blob/main/docs';
  const anchor = link.heading ? `#${link.heading.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : '';
  return `${base}/${link.doc}.md${anchor}`;
}
