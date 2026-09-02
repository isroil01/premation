/**
 * The Transcript panel's public face.
 *
 * `transcriptCommands` is imported for its SIDE EFFECT — it registers the
 * palette/menu commands on load — so it must be imported here rather than only
 * from the component: the renderer map in `DemoPanels.tsx` imports this module
 * at boot, while the component itself is not evaluated until the panel is on
 * screen, and a command that only exists once you have found the panel is not a
 * command anybody can find the panel with.
 */

import './transcriptCommands';

export { TranscriptPanel } from './TranscriptPanel';
export { TRANSCRIPT_PANEL_ID, buildTranscriptCommands } from './transcriptCommands';
export { useTranscriptStore, transcriptFor } from './transcriptStore';
export type { CompTranscript, TranscriptSource } from './transcriptStore';
