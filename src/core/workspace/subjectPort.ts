/**
 * The seam the Assistant's `apply_subject_style` tool calls through for the
 * Subjects panel's style presets (layout/Workspace/subjectStyles.ts), which
 * src/core must not import. The editor registers them when it loads
 * (placeBehindSubjectCommand.ts). The segmentation, following and background
 * switches are core (rotoBrushTool.ts, objectMatteEffect.ts) and need no port.
 */

import type { Command } from '@motion/engine-api';

export interface SubjectStyleInfo {
  id: string;
  label: string;
  hint: string;
  /** The shelf it sits on (outline, glow, shadow, background, look, motion). */
  kind: string;
}

export interface SubjectPort {
  /** The Subjects panel's style presets. */
  styles(): SubjectStyleInfo[];
  /**
   * The commands that add preset `styleId` for one subject of `layer`
   * (`subject` null: every subject), to send inside the caller's own edit.
   * Empty for an unknown preset.
   */
  styleCommands(layer: string, subject: string | null, styleId: string): Command[];
}

let port: SubjectPort | null = null;

export function registerSubjectPort(p: SubjectPort | null): void {
  port = p;
}

/** The registered port, or null when this editor has none (headless tests). */
export function subjectPort(): SubjectPort | null {
  return port;
}
