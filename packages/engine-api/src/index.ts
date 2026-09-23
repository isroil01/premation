/**
 * @motion/engine-api — the contract between the editor UI and the engine
 * (docs/ENGINE_API.md, docs/NATIVE_CORE_PLAN.md §2).
 *
 * Everything under ./generated is produced from ../schema/*.eapi by
 * `npm run engine-api:gen`; the same schema generates the C++ structs and
 * codec in native/protocol/generated. No React, no DOM, no editor state.
 */

export * from './generated/types';
export { codecs, encodeEngineMessage, decodeEngineMessage, encodeEngineMessageInto } from './generated/codec';
export type { Codec, CodecName } from './generated/codec';
export { COMMANDS, QUERIES, EVENTS, SCHEMA_COUNTS } from './generated/meta';
export type { CommandKind, CommandInfo, QueryInfo, EventInfo } from './generated/meta';
export { Reader, Writer, DecodeError } from './wire';
export type { DecodeErrorCode } from './wire';
export { FLICKS_PER_SECOND, secondsToFlicks, flicksToSeconds, frameToFlicks, flicksToFrame } from './time';
export { propPath, parsePropPath, PROP_ROOTS } from './propPath';
export type { PropRoot } from './propPath';
export { EngineClientBase, EngineRequestError, unwrap, engineError, commandKind, isCoalescable } from './client';
export type { EngineClient, EngineResult, RequestOptions, EventListener, CommandOf, QueryOf } from './client';
