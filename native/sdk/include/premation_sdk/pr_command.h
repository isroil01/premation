/*
 * Premation native plugin SDK — commands (SDK 1.2): plugins that are not
 * effects. After Effects' AEGP command class (AEGP_InsertMenuCommand /
 * AEGP_RegisterCommandHook): a menu item that edits the project.
 *
 * A module lists its commands in PrPluginInfo's SDK 1.2 trailing fields
 * (`command_count`, `commands`), and the manifest names them:
 *
 *     "commands": [ { "id": "distribute", "name": "Distribute Layers", "menu": "Layer" } ]
 *
 * The editor shows them in the Plugins menu (under `menu`, a submenu name;
 * "" = the plugin's own submenu) and in the command palette. Running one is
 * the engine API's `runPluginCommand`.
 *
 * Where it runs: in premation-engine, on the engine's core thread (the thread
 * that owns the document), inside the crash guard, the watchdog and the crash
 * journal like every selector. A crash or a hang never takes the editor down:
 * a crash rolls back every edit the command made and disables the command for
 * the session (setPluginEnabled(true) re-arms it); a hang quarantines the
 * plugin (docs/PLUGIN_SDK.md "Crash isolation").
 *
 * What it can do: read and edit the document through the ENGINE API, the same
 * API the editor uses (packages/engine-api; docs/ENGINE_API.md), as JSON:
 *
 *     engine_query(host, "{\"type\":\"listLayers\",\"comp\":\"comp_1\"}", &json, &len)
 *     engine_command(host, "{\"type\":\"setProperty\",\"prop\":{...},\"value\":{...}}", &json, &len)
 *
 * The JSON is the engine API's own object form (what the TypeScript client
 * sends): flat unions (Command, Query) carry `type`, other unions `kind` (and
 * `value`), enums their names, bytes base64, times integer flicks. Only EDIT
 * commands are accepted (no undo, open, transport or another runPluginCommand).
 * Every edit of one invocation is ONE undo entry, labelled with the command's
 * name, with origin `plugin`, and lands in the command log as the edits
 * themselves (a crash replay never runs the plugin again). A command that
 * returns an error, or one whose edit fails, changes nothing.
 */
#ifndef PREMATION_SDK_PR_COMMAND_H
#define PREMATION_SDK_PR_COMMAND_H

#include "pr_host.h"
#include "pr_types.h"

#ifdef __cplusplus
extern "C" {
#endif

/* ── selectors ─────────────────────────────────────────────────────────────
 *   PR_COMMAND_RUN   do the command: read with engine_query, edit with engine_command. */
typedef int32_t PrCommandCmd;
#define PR_COMMAND_RUN 0
/* SDK 1.4 (U1): a viewer tool's live event while it is active — the pointer moving (a hover, or a drag
 * in progress), the wheel, a key. `args_json` = { "tool", "event": "move" | "wheel" | "key", "pointer":
 * [x, y] (comp px), "stroke": [[x, y], …] (the drag so far, absent on a hover), "deltaY" (wheel),
 * "key" (key), "shift", "alt", "ctrl" }. Draw the tool's overlay with tool_draw; put a status line in
 * return_msg. No edits here (engine_command answers PR_ERR_INVALID_CALLBACK): the drag's edits are its
 * RUN, one undo entry. Keep what the events change (a brush size) in the module. */
#define PR_COMMAND_TOOL_EVENT 1

/* SDK 1.4 (U1): what tool_draw draws, in comp px. */
#define PR_TOOL_DRAW_LINE 0   /* a polyline: xy = x0, y0, x1, y1, … */
#define PR_TOOL_DRAW_CIRCLE 1 /* xy = cx, cy, r */
#define PR_TOOL_DRAW_DOT 2    /* xy = x, y (a filled point, `width` px across on screen) */

/** What a command may call back (the engine API). Results are host-owned UTF-8 JSON,
 *  NUL-terminated, valid until the selector returns. */
typedef struct PrCommandSuite {
  uint32_t struct_size;
  /* A query (`{"type": "<query>", …}`). PR_ERR_NONE: *out_json is the result
   * (`{"type": "<query>", …the result's fields}`). An engine error: PR_ERR_INVALID_PARAM
   * (or PR_ERR_NOT_FOUND for `notFound`) and *out_json is `{"code": "…", "message": "…"}`. */
  PrErr(PR_CALL* engine_query)(PrHost* host, const char* request_json, const char** out_json, uint32_t* out_len);
  /* An edit command (`{"type": "<command>", …}`): applied at once (the next query sees it)
   * and part of this invocation's single undo entry. Results and errors as engine_query.
   * A failed command changed nothing; return its error from RUN to undo the others too. */
  PrErr(PR_CALL* engine_command)(PrHost* host, const char* request_json, const char** out_json, uint32_t* out_len);
  /* ── SDK 1.4 (U1), appended: check struct_size >= offsetof(PrCommandSuite, tool_draw) + sizeof(void*) ──
   * PR_COMMAND_TOOL_EVENT only: one item of the tool's overlay (PR_TOOL_DRAW_*), comp px, straight RGBA
   * (NULL = the editor's accent), `width` screen px. At most 512 items and 4096 points per event. */
  PrErr(PR_CALL* tool_draw)(PrHost* host, uint32_t kind, const double* xy, uint32_t count, const float* rgba, double width);
} PrCommandSuite;

typedef struct PrCommandContext {
  uint32_t struct_size;
  uint32_t host_sdk_version;   /* PR_SDK_VERSION of the host */
  const PrHostSuite* host;     /* handles, log, progress (render-only callbacks answer PR_ERR_INVALID_CALLBACK) */
  PrHost* host_ref;            /* first argument of every PrHostSuite / PrCommandSuite callback */
  const PrCommandSuite* engine;
  const char* command_id;      /* the manifest command id */
  /* What the user had when they chose the command. */
  const char* comp_id;         /* the active composition ("" = none) */
  const char* const* selected_layers; /* layer ids, top of the stack first */
  uint32_t selected_layer_count;
  int64_t time;                /* the playhead, composition time, PR_TIME_SCALE ticks */
  double frame_rate;           /* the active composition's frames per second (0 = none) */
  const char* args_json;       /* runPluginCommand's `args` ("{}" when none) */
} PrCommandContext;

typedef struct PrCommandOut {
  uint32_t struct_size;
  /* Why the command failed (NUL-terminated), or a short note for the status bar on success. */
  char return_msg[PR_MAX_MESSAGE];
} PrCommandOut;

typedef PrErr(PR_CALL* PrCommandMainFn)(PrCommandCmd cmd, const PrCommandContext* ctx, PrCommandOut* out);

/** One command of the module (PrPluginInfo.commands); `id` equals the manifest's. */
typedef struct PrCommandEntry {
  const char* id;
  PrCommandMainFn main;
} PrCommandEntry;

#ifdef __cplusplus
}
#endif

#endif /* PREMATION_SDK_PR_COMMAND_H */
