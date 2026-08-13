# Template data binding — scope

**Derived from source at `c9fc537`, 2026-08-10. Nothing here is built.**
Reported for a decision before any code, per the master brief.

## The claim that started this

`EDITOR_REFERENCE.md` listed data binding among the template capabilities that
were "complete and tested — do not rebuild". It does not exist: `dataBinding`,
`dataSource` and `csvBind` have **zero hits** repo-wide. The other five
capabilities are real. This is greenfield, not a remainder.

## What already exists, and is the right foundation

The template model is in better shape than the missing feature suggests.

- `TemplateField` — `{ id, label, kind, target, default, group?, fit? }`
- `TemplateFieldTarget` — `{ nodeId, componentType, prop }`, resolved to a
  concrete component id at write time
- 5 field kinds: `text`, `color`, `number`, `image`, `media`
- `writeTemplateField(field, value)` already performs the write
- Media slots carry an author-chosen `SlotFit`

**A field is already a named, typed, addressable write target.** Data binding is
therefore not a new mechanism — it is a *source* for values that
`writeTemplateField` can already apply.

## The actual decision: what "data binding" means here

Three products wear the name, and they are not the same size.

**A. Fill-from-a-row.** A user supplies a table (CSV/JSON); each row maps to the
existing fields by id; the template renders once per row. This is what motion
designers mean by data-driven templates and what LottieFiles/Jitter ship.
*Nothing in the document model changes* — the row is external, applied at fill
time through `writeTemplateField`. **Smallest, highest value.**

**B. Live binding.** The document persists a binding (`field ← source.path`) and
re-reads it. This *does* change the schema: `TemplateField` gains a binding
descriptor, which needs a `1.6.0 → 1.7.0` migration, and the reference doc's
§1 counts are unaffected but the format-freeze plan gains an item.

**C. Expression-level data access.** A `data()` function in the expression
language. Largest blast radius: the language is deliberately sandboxed and
cycle-checked, and an external data source is an I/O surface inside a pure
evaluator. Not recommended.

## Recommended scope: A only

Batch fill against the existing field ids. Concretely:

1. A parser for a table → `Array<Record<fieldId, string|number>>`, pure and
   unit-testable, with a clear error for an unknown field id.
2. A fill-and-render loop reusing the render queue — one job per row, output
   name templated from a chosen column.
3. UI: pick a file, map columns to fields (defaulting to id match), preview row 1.

**Why A and not B:** A needs no persisted state, so no migration, no format
change, and no new pre-freeze item. It is also the version whose absence people
actually feel — nobody asks for a live binding to a spreadsheet they will never
change; they ask to make forty lower-thirds.

## What must be decided before any code

1. **A or B.** If B is genuinely wanted, it should land *before* the format
   freeze (see `MOTION_FORMAT_FREEZE.md` §"What still wants to move").
2. **Where a row's media comes from.** `media` fields hold a source URL. A CSV
   column of file paths means the batch path touches asset ingestion, which is
   a materially bigger job than text and colour columns. Restricting v1 to
   `text` / `color` / `number` keeps it small and honest.
3. **Whether output naming is a template field or a queue setting.**

## Estimate

**A, text/colour/number only:** small — parser, loop, one panel. No schema
change, no migration, no renderer involvement.
**A including media columns:** medium, dominated by asset ingestion.
**B:** medium-large, and it takes a schema slot.

Not started. Awaiting a decision on A vs B.

---

## Update 2026-08-10 — what shipped, and the blocker on the last piece

**Shipped:** `dataTable.ts` (CSV/JSON parsing, pure), `dataFill.ts`
(`coerceCell` + `applyDataRow`, one row = one undo entry), and
`DataFillSection` in the template panel — load a table, step through rows,
apply one. 24 tests. Restricted to `text`/`color`/`number` as recommended;
media fields are reported as skipped rather than silently ignored.

**Not shipped, and NOT a small remainder: one render per row.**

The obvious implementation — apply row *i*, `addJob(...)`, repeat — produces
silently wrong files. `renderJob` calls `renderVideo`, which calls
`buildSnapshot` against the **live scene graph**; a queued job carries settings,
not a document. Queue forty jobs and every one renders whatever the scene looks
like when it runs, which is the last row applied. Forty identical files, each
correctly named after a different row. Nothing errors.

This is the same class of defect the queue already fixed once: `RenderJob` grew
a `compositionId` because `compositionName` was only a label, so every job
rendered whatever comp was active. That fix made jobs name their comp; it did
not make them capture its *state*.

Two ways out, and they are different sizes:

- **A sequential driver.** Batch fill owns the loop: apply row, await a full
  render, apply the next. Does not use `addJob` at all. Correct, and small —
  but it is a second render driver beside the queue, it cannot interleave with
  user-queued jobs, and it wants pause/resume (Step 3) to be useful, since a
  forty-row batch is exactly when someone reaches for pause.
- **Per-job document snapshots.** `RenderJob` carries a captured document that
  `buildSnapshot` renders instead of the live graph. The general fix, and the
  one that would let batch rows, queued comps and a busy editor coexist. Much
  larger, and it touches the render path's most safety-critical invariant.

**Recommendation:** the sequential driver, sequenced AFTER Step 3, because
pause/resume is the thing that makes a long batch usable and building the driver
first would mean building it twice.
