// `premation-engine --prepare JOB.json` — the document half of `premation
// render` / `premation comps` / `premation captions` (electron/cliEngineRender.ts),
// run by the engine itself: no window, no TypeScript engine.
//
// One Session is driven in process (the real command handlers, jobs and file
// ports, the codec's structs directly): open the project, then
//
//   requests [base64]      a recorded command log, applied first (each an
//                          EngineMessage{request}); {"ev":"replayed","applied","refused","firstError"?}
//   listComps              {"ev":"comps","comps":[{id,name,width,height,fps,durationSeconds,pristine}]}
//   reframe {ratio}        the autoReframe job on the selected composition, applied;
//                          {"ev":"reframed","comp":ID,"width":W,"height":H}
//   fill {fieldId: cell}    one data row into the template fields (text, colour,
//                          number; one batch); {"ev":"filled","filled","skipped","failed"}
//   captions {cues, style?} setCaptions on the selected composition (before a
//                          reframe); {"ev":"captions","layers":N}
//   transcribe {…}         the transcribe job (the user's speech provider; the
//                          credential is main's, passed in the job file and never
//                          echoed); {"ev":"cues","cues":[{start,end,text}],"compName":S}
//   saveTo PATH            saveProject {path, copy:true} — the document the
//                          render then opens with `--export`; {"ev":"saved","path":P}
//
// then {"ev":"done","comp":ID} (the composition a render should target).
// Any failure: {"ev":"error","message":S} and exit 1. Bad job file: exit 64.
#pragma once

#include <string>

namespace premation::cli {

/// The whole prepare job. Returns the exit code (0 ok, 1 failed, 64 bad job).
int run_prepare(const std::string& jobPath);

}  // namespace premation::cli
