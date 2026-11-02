/**
 * Media tools — what the user can do with FOOTAGE that the model could not
 * (MCP plan stream E, 2026-11-02): subjects (the Object Matte tool group —
 * select, refine, find, follow, style), point tracking (Track Motion + Apply),
 * transcription, a look at an imported asset, and the editor's own state.
 *
 * Coordinates: every point on footage is in FOOTAGE pixels from the top-left
 * of the picture (what `place_behind_subject` takes), never comp px — the
 * handlers map them onto the layer's box. Times are composition seconds.
 *
 * The long jobs (follow_subject, transcribe, track_point) run in the engine;
 * a call that returns a `jobId` is polled with get_job_status.
 */

import type { AiToolDef, JsonSchema } from '../types';

const POINT: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['x', 'y'],
  properties: {
    x: { type: 'number', description: 'Footage px from the left edge.' },
    y: { type: 'number', description: 'Footage px from the top edge.' },
    label: { type: 'string', enum: ['subject', 'not'], default: 'subject', description: '"subject": on the subject; "not": on something that is NOT the subject.' },
  },
};

const BOX: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['x', 'y', 'w', 'h'],
  properties: {
    x: { type: 'number', description: 'Left, footage px.' },
    y: { type: 'number', description: 'Top, footage px.' },
    w: { type: 'number', minimum: 1 },
    h: { type: 'number', minimum: 1 },
  },
  description: 'A box around the subject, footage px from the top-left.',
};

const EDGE: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    feather: { type: 'number', minimum: 0, maximum: 200, description: 'Soft edge, px.' },
    choke: { type: 'number', minimum: -100, maximum: 100, description: 'Shrink (+) or grow (−) the matte, px.' },
    contrast: { type: 'number', minimum: 0, maximum: 100, description: 'Harden the soft band, %.' },
    smooth: { type: 'number', minimum: 0, maximum: 100, description: 'Smooth the outline, %.' },
    invert: { type: 'boolean' },
  },
  description: 'The subject\'s live edge settings (Subjects panel ▸ Edge): applied to every frame, no re-segmentation.',
};

export const findSubjectsDef: AiToolDef = {
  name: 'find_subjects',
  kind: 'read',
  description:
    'Find Objects: every object the segmentation model sees in a footage layer\'s frame — a list of candidates ' +
    '(index, bounds in footage px, share of the frame, a seed point) to choose from. Nothing is written. Then ' +
    'select_subject with `candidate` (or with your own points). A video or image layer only.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['layerId'],
    properties: {
      layerId: { type: 'string', description: 'The footage layer.' },
      time: { type: 'number', minimum: 0, description: 'Composition seconds (default the playhead).' },
      limit: { type: 'integer', minimum: 1, maximum: 60, default: 20 },
    },
  },
};

export const selectSubjectDef: AiToolDef = {
  name: 'select_subject',
  kind: 'write',
  description:
    'Select a SUBJECT (a person, an object) in a footage layer on one frame, as the Object Matte tool does: give ' +
    'points on it (and "not" points on what is not it), a box round it, or a `candidate` from find_subjects. The ' +
    'matte is a soft raster selection the layer keeps — effects can Apply To it (apply_subject_style), text can ' +
    'go Behind Subject (place_behind_subject), the background can be blurred or removed. Returns the subject id, ' +
    'its coverage and bounds; refine with refine_subject, carry it through the shot with follow_subject. Each call ' +
    'without `subject` makes a NEW subject on a layer that already has one (a second person, a prop); pass ' +
    '`subject` to replace an existing one\'s selection on this frame.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['layerId'],
    properties: {
      layerId: { type: 'string', description: 'The footage layer (video or image).' },
      points: { type: 'array', items: POINT, maxItems: 40, description: 'Clicks on the subject (label "subject") and off it (label "not").' },
      box: BOX,
      candidate: { type: 'integer', minimum: 0, description: 'An index from find_subjects (same layer and time).' },
      name: { type: 'string', description: 'A name for the subject ("Rider", "Cup").' },
      subject: { type: 'string', description: 'An existing subject id (s1, s2…) to re-select; omit for a new one.' },
      time: { type: 'number', minimum: 0, description: 'The frame, composition seconds (default the playhead).' },
    },
  },
};

export const refineSubjectDef: AiToolDef = {
  name: 'refine_subject',
  kind: 'write',
  description:
    'Correct a subject\'s selection on one frame: more points (add / "not" points subtract through the model), ' +
    'brush strokes as polylines (`strokes`, painted exactly or refined against the picture for hair), and the ' +
    'live edge settings (feather, choke, contrast, smooth, invert) that apply to every frame. One undo step. ' +
    'Look at the result with render_frame (or the matte preview this returns over MCP) before following it.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['layerId'],
    properties: {
      layerId: { type: 'string' },
      subject: { type: 'string', description: 'Subject id (default: the layer\'s active subject).' },
      time: { type: 'number', minimum: 0, description: 'The frame, composition seconds (default the playhead).' },
      add: { type: 'array', items: POINT, maxItems: 40, description: 'Points on parts the selection MISSED (labels are ignored: all add).' },
      subtract: { type: 'array', items: POINT, maxItems: 40, description: 'Points on parts wrongly INCLUDED.' },
      strokes: {
        type: 'array',
        maxItems: 20,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['points'],
          properties: {
            points: { type: 'array', minItems: 1, maxItems: 400, items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 }, description: '[[x, y], …] footage px.' },
            op: { type: 'string', enum: ['add', 'subtract'], default: 'add' },
            tool: { type: 'string', enum: ['paint', 'refine'], default: 'paint', description: 'paint: the brush exactly; refine: soft alpha estimated inside the brush band (hair, fur, motion blur).' },
            radius: { type: 'number', minimum: 1, maximum: 400, default: 12, description: 'Brush radius, footage px.' },
          },
        },
      },
      edge: EDGE,
    },
  },
};

export const followSubjectDef: AiToolDef = {
  name: 'follow_subject',
  kind: 'write',
  description:
    'Carry a selected subject through the shot: the engine tracks the matte frame by frame from the frame it was ' +
    'selected on (both directions) over the work area or the range given. Starts a background job (the Tasks panel ' +
    'shows it); returns a jobId to poll with get_job_status, or pass wait: true to block until it finishes. ' +
    'Afterwards the subject\'s styles and Behind Subject hold on every frame.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['layerId'],
    properties: {
      layerId: { type: 'string' },
      subject: { type: 'string', description: 'Subject id (default: the active one).' },
      startSec: { type: 'number', minimum: 0, description: 'Default: the work area start (or 0).' },
      endSec: { type: 'number', minimum: 0, description: 'Default: the work area end (or the composition end).' },
      originSec: { type: 'number', minimum: 0, description: 'The frame to track outward from (default the playhead — the frame select_subject used).' },
      wait: { type: 'boolean', default: false, description: 'Block until the walk finishes (may take minutes on a long clip).' },
    },
  },
};

export const applySubjectStyleDef: AiToolDef = {
  name: 'apply_subject_style',
  kind: 'write',
  description:
    'Style a subject with the Subjects panel\'s presets — ordinary effects reading that subject alone (editable in ' +
    'Effect Controls afterwards): outlines (sticker, comic, dashes), glows (neon, halo), background treatments ' +
    '(spotlight, portrait blur, "background_blur"), looks (colour splash, duotone, warm subject) — or ' +
    '"remove_background" / "keep_background" (the subject\'s Object Matte effect on / off: the layer is cut to the ' +
    'subject, or shown whole). Call list_capabilities { area: "media" } for the preset list with descriptions.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['layerId', 'style'],
    properties: {
      layerId: { type: 'string' },
      style: {
        type: 'string',
        enum: ['sticker', 'neon', 'spotlight', 'splash', 'duotone', 'comic', 'halo', 'dashes', 'portrait', 'warm', 'background_blur', 'remove_background', 'keep_background'],
      },
      subject: { type: 'string', description: 'Subject id (default: the active one; presets read that subject alone).' },
    },
  },
};

export const trackPointDef: AiToolDef = {
  name: 'track_point',
  kind: 'write',
  description:
    'Track a detail of a footage layer through the shot (Track Motion, one click): the engine picks the trackable ' +
    'feature nearest `point`, sizes its windows from the measured motion, adds a companion feature for rotation / ' +
    'scale, and tracks outward from the playhead both ways. Returns a trackId, the frames tracked and where the ' +
    'point is at the start and end, in footage px. Then attach_to_track puts a layer (or a null) on it. ' +
    'The samples are kept on the layer as its tracker (Track Motion panel).',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['layerId', 'point'],
    properties: {
      layerId: { type: 'string', description: 'The footage (video) layer.' },
      point: { type: 'object', additionalProperties: false, required: ['x', 'y'], properties: { x: { type: 'number' }, y: { type: 'number' } }, description: 'The detail to follow, footage px from the top-left, on the frame at `originSec`.' },
      radius: { type: 'number', minimum: 4, maximum: 400, description: 'Half-size of a box round the detail (the feature window), footage px. Omit for a click.' },
      startSec: { type: 'number', minimum: 0, description: 'Default: the layer\'s in point.' },
      endSec: { type: 'number', minimum: 0, description: 'Default: the layer\'s out point.' },
      originSec: { type: 'number', minimum: 0, description: 'The frame `point` is given on (default the playhead).' },
    },
  },
};

export const attachToTrackDef: AiToolDef = {
  name: 'attach_to_track',
  kind: 'write',
  description:
    'Apply a track_point result (Track Motion ▸ Apply): "follow" keys the target layer\'s position onto it; ' +
    '"transform" also rotation and scale (needs the companion feature); "createNull" makes a "Tracked Null" beside ' +
    'the footage carrying the motion, to parent layers to (the usual choice); "stabilize" keys the FOOTAGE\'s own ' +
    'position against the motion (steadies the shot); "effectPoint" keys an effect\'s point parameter of the target ' +
    '(`effectPath` = "effects/<effectId>/<param>"). One undo step.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['trackId', 'mode'],
    properties: {
      trackId: { type: 'string', description: 'From track_point.' },
      mode: { type: 'string', enum: ['follow', 'transform', 'createNull', 'stabilize', 'effectPoint'] },
      targetId: { type: 'string', description: 'follow / transform / effectPoint: the layer that receives the keys (never the footage itself — use createNull).' },
      effectPath: { type: 'string', description: 'effectPoint: "effects/<effectId>/<param>" on the target.' },
    },
  },
};

export const transcribeDef: AiToolDef = {
  name: 'transcribe',
  kind: 'write',
  description:
    'Transcribe the composition\'s audio (the mix: music, voice, SFX, as the export would hear it) with the ' +
    'user\'s speech provider: sentence cues and WORD timings in composition seconds, plus the detected language. ' +
    'With createCaptions: true the cues become caption text layers (one per sentence, broadcast style, replacing ' +
    'the composition\'s existing captions) as one undo step. Use the word timings to cut kinetic type or SFX to ' +
    'speech. Needs the user\'s Allow in Premation (it sends audio to their provider).',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      startSec: { type: 'number', minimum: 0, description: 'Default 0.' },
      endSec: { type: 'number', minimum: 0, description: 'Default: the composition end.' },
      language: { type: 'string', description: 'A hint ("en", "pt-BR"); omit to detect.' },
      createCaptions: { type: 'boolean', default: false },
      maxWords: { type: 'integer', minimum: 0, maximum: 4000, default: 600, description: 'How many word timings to return (0 = none, cues only).' },
    },
  },
};

export const getJobStatusDef: AiToolDef = {
  name: 'get_job_status',
  kind: 'read',
  description:
    'The state of a background job this assistant started (follow_subject, track_point, transcribe): running with ' +
    'progress, done with its summary, failed with the reason, or cancelled. Omit jobId for every job of this session.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      jobId: { type: 'string' },
      cancel: { type: 'boolean', default: false, description: 'Stop the job instead of reading it.' },
    },
  },
};

export const getEditorContextDef: AiToolDef = {
  name: 'get_editor_context',
  kind: 'read',
  description:
    'Where the user is right now: the active composition, the playhead, the work area, the selected layers, ' +
    'selected properties and keyframes, the subject in focus and the active tool. Editor state, never written ' +
    'into the project — read it to resolve "here", "this", "the selected keys".',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
};

export const describeAssetDef: AiToolDef = {
  name: 'describe_asset',
  kind: 'read',
  description:
    'Look at an imported asset WITHOUT placing it: its real metadata (size, duration, frame rate, codec, container, ' +
    'audio channels, alpha, file size, the layers using it) and — over MCP — a contact sheet of `cells` frames ' +
    'spread over its length (one frame for a still). Use it to choose footage and the moments in it before ' +
    'create_media; render_frame { assetId, time } shows one frame large.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['assetId'],
    properties: {
      assetId: { type: 'string', description: 'From list_assets.' },
      cells: { type: 'integer', minimum: 1, maximum: 12, default: 6 },
    },
  },
};

export const MEDIA_TOOL_DEFS: readonly AiToolDef[] = [
  findSubjectsDef,
  selectSubjectDef,
  refineSubjectDef,
  followSubjectDef,
  applySubjectStyleDef,
  trackPointDef,
  attachToTrackDef,
  transcribeDef,
  getJobStatusDef,
  getEditorContextDef,
  describeAssetDef,
];

/** The names of the media tools (the host attaches images to some of them over MCP). */
export const MEDIA_TOOL_NAMES: ReadonlySet<string> = new Set(MEDIA_TOOL_DEFS.map((d) => d.name));
