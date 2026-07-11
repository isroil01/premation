/**
 * `@core` barrel.
 *
 * Intentionally minimal: the app imports core modules by their full path
 * (`@core/scene/SceneGraph`, `@core/commands/CommandSystem`, …), which keeps
 * dependencies explicit and tree-shakeable. This barrel only re-exports the
 * symbols actually consumed via the bare `@core` specifier. Add an entry here
 * only when a new bare-`@core` consumer appears.
 */

export { default as SceneGraph } from './scene/SceneGraph';
