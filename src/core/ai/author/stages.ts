/**
 * The author run's progress stages, in order.
 *
 * Their own module so the chat hook can read them without importing the
 * runner. `AuthorRunner` emits exactly these strings (with a trailing "…")
 * through `onActivity`, and `pipelineStages.test.ts` reads the runner's source
 * to hold the two in step — the caster's checklist once described a pipeline
 * that no longer existed, and nothing noticed.
 */
export const AUTHOR_STAGE_LABELS = [
  'Designing the piece',
  'Writing the beats',
  'Building the scene',
  'Reviewing the frames',
  'Revising beats',
] as const;
