/**
 * projectDocumentIO — the project's save/load document.
 *
 * The ProjectManager used to be wired to `sceneProjectIO`, which captures the
 * SCENE GRAPH AND NOTHING ELSE. So `File ▸ Save` wrote a `.motion` containing
 * geometry with no keyframes, no comp settings and no timeline: reopening it
 * gave you back the shapes and silently dropped every animation you'd authored.
 *
 * This registers the full EditorDocument instead — the same one the cloud
 * autosave and `File ▸ Export ▸ Project` use, so all three round-trip through
 * one shape and a file written by any of them opens in the others.
 */

