/**
 * @motion/engine-api — the contract between the editor UI and the engine
 * (docs/ENGINE_API.md, docs/NATIVE_CORE_PLAN.md §2).
 *
 * Everything under ./generated is produced from ../schema/*.eapi by
 * `npm run engine-api:gen`; the same schema generates the C++ structs and
 * codec in native/protocol/generated. generated/catalog.ts is the engine's
 * effect / property catalog (native/engine/catalog/*.json), for synchronous
 * UI metadata. No React, no DOM, no editor state.
 */

export * from './generated/types';
export { codecs, encodeEngineMessage, decodeEngineMessage, encodeEngineMessageInto } from './generated/codec';
export type { Codec, CodecName } from './generated/codec';
export { COMMANDS, QUERIES, EVENTS, SCHEMA_COUNTS } from './generated/meta';
export type { CommandKind, CommandInfo, QueryInfo, EventInfo } from './generated/meta';
export { EFFECT_CATALOG, STATIC_PROPERTY_META, BLEND_MODE_IDS, LABEL_COLOR_CATALOG, CATALOG_DATA, catalogEffect } from './generated/catalog';
export type {
  CatalogJson,
  CatalogEffect,
  CatalogEffectParam,
  CatalogEffectParamType,
  CatalogEffectOption,
  CatalogStaticMeta,
  CatalogLabelColor,
} from './generated/catalog';
export { Reader, Writer, DecodeError } from './wire';
export type { DecodeErrorCode } from './wire';
export { FLICKS_PER_SECOND, secondsToFlicks, flicksToSeconds, frameToFlicks, flicksToFrame } from './time';
export { propPath, parsePropPath, PROP_ROOTS } from './propPath';
export type { PropRoot } from './propPath';
export { EngineClientBase, EngineRequestError, unwrap, engineError, commandKind, isCoalescable } from './client';
export type { EngineClient, EngineResult, RequestOptions, EventListener, CommandOf, QueryOf } from './client';
export { ProcessEngineClient, createProcessEngineClient } from './process';
export type {
  EngineBridge,
  EngineHostState,
  EngineHostStatus,
  EngineWireReply,
  EngineRestartNotice,
  EngineUnavailableNotice,
  EngineFrameMeta,
  EngineFrameConsumer,
  VideoFrameLike,
  ProcessEngineNotice,
  ProcessEngineOptions,
} from './process';
export { IdMap } from './idMap';
