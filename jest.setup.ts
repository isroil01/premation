import '@testing-library/jest-dom';

// jsdom (older versions) lacks structuredClone, which some stores use at import
// time. Provide a JSON-based polyfill for the test environment only.
if (typeof globalThis.structuredClone !== 'function') {
  globalThis.structuredClone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
}

// jsdom doesn't expose TextEncoder/TextDecoder globally; the zip writer needs
// them. Bridge Node's implementations for the test environment.
// eslint-disable-next-line @typescript-eslint/no-var-requires
import { TextEncoder as NodeTextEncoder, TextDecoder as NodeTextDecoder } from 'util';
if (typeof globalThis.TextEncoder === 'undefined') {
  globalThis.TextEncoder = NodeTextEncoder as typeof globalThis.TextEncoder;
}
if (typeof globalThis.TextDecoder === 'undefined') {
  globalThis.TextDecoder = NodeTextDecoder as unknown as typeof globalThis.TextDecoder;
}
