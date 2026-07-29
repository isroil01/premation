/**
 * What survives of the client-side pipeline.
 *
 * Phase 3.4 deleted the rest: a 10-stage LLM chain (orchestrator, context,
 * six schema files, seven stage files — ~2,165 lines) that asked a model to
 * author a storyboard, then a scene, then keyframes. That is precisely the
 * arrangement the caster replaces, and it ran *behind* the backend director,
 * so it was a fallback whose output would have had to be thrown away anyway.
 *
 * Classification is all that was worth keeping, and it was never a pipeline
 * stage — it is one pure function over a string.
 */
export * from './Router';
