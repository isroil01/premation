/**
 * The ABI numbers in abi.ts are a MIRROR of native/include/motion/*.h (the C
 * headers cannot be imported). This parses the headers and fails on drift, so
 * a struct/enum change on the C side cannot ship without the bridge noticing.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  KF_HAS_BEZIER,
  KF_HAS_SI,
  KF_HAS_SO,
  KF_SPATIAL_SHIFT,
  NATIVE_ABI_VERSION_MAJOR,
  NATIVE_ABI_VERSION_MINOR,
  NATIVE_EASING,
  NATIVE_SPATIAL,
  NATIVE_STATUS,
  PACKED_DOUBLES,
} from './abi';

const includeDir = resolve(__dirname, '../../../native/include/motion');
const abiHeader = readFileSync(resolve(includeDir, 'motion_abi.h'), 'utf8');
const evalHeader = readFileSync(resolve(includeDir, 'motion_eval.h'), 'utf8');

function define(header: string, name: string): number {
  const m = new RegExp(`#define\\s+${name}\\s+(0x[0-9a-fA-F]+|\\d+)u?\\b`).exec(header);
  if (!m) throw new Error(`${name} not found in header`);
  return Number(m[1]);
}

function enumerator(header: string, name: string): number {
  const m = new RegExp(`\\b${name}\\s*=\\s*(\\d+)`).exec(header);
  if (!m) throw new Error(`${name} not found in header`);
  return Number(m[1]);
}

describe('abi.ts mirrors native/include/motion', () => {
  it('version', () => {
    expect(define(abiHeader, 'MOTION_ABI_VERSION_MAJOR')).toBe(NATIVE_ABI_VERSION_MAJOR);
    expect(define(abiHeader, 'MOTION_ABI_VERSION_MINOR')).toBe(NATIVE_ABI_VERSION_MINOR);
  });

  it('status values', () => {
    expect(enumerator(abiHeader, 'MOTION_OK')).toBe(NATIVE_STATUS.indexOf('OK'));
    expect(enumerator(abiHeader, 'MOTION_INVALID_ARG')).toBe(NATIVE_STATUS.indexOf('INVALID_ARG'));
    expect(enumerator(abiHeader, 'MOTION_OUT_OF_RANGE')).toBe(NATIVE_STATUS.indexOf('OUT_OF_RANGE'));
    expect(enumerator(abiHeader, 'MOTION_INTERNAL')).toBe(NATIVE_STATUS.indexOf('INTERNAL'));
  });

  it('packed layout and flag bits', () => {
    expect(define(evalHeader, 'MOTION_KEYFRAME_PACKED_DOUBLES')).toBe(PACKED_DOUBLES);
    expect(define(evalHeader, 'MOTION_KF_HAS_BEZIER')).toBe(KF_HAS_BEZIER);
    expect(define(evalHeader, 'MOTION_KF_HAS_SI')).toBe(KF_HAS_SI);
    expect(define(evalHeader, 'MOTION_KF_HAS_SO')).toBe(KF_HAS_SO);
    expect(define(evalHeader, 'MOTION_KF_SPATIAL_SHIFT')).toBe(KF_SPATIAL_SHIFT);
  });

  it('easing enum', () => {
    const expected: Record<string, number> = {
      MOTION_EASING_LINEAR: NATIVE_EASING.linear,
      MOTION_EASING_HOLD: NATIVE_EASING.hold,
      MOTION_EASING_BEZIER: NATIVE_EASING.bezier,
      MOTION_EASING_EASE_IN: NATIVE_EASING.easeIn,
      MOTION_EASING_EASE_OUT: NATIVE_EASING.easeOut,
      MOTION_EASING_EASE_IN_OUT: NATIVE_EASING.easeInOut,
      MOTION_EASING_EASE: NATIVE_EASING.ease,
      MOTION_EASING_AUTO_BEZIER: NATIVE_EASING.autoBezier,
      MOTION_EASING_CONTINUOUS_BEZIER: NATIVE_EASING.continuousBezier,
      MOTION_EASING_STEP: NATIVE_EASING.step,
    };
    for (const [name, value] of Object.entries(expected)) {
      expect([name, enumerator(evalHeader, name)]).toEqual([name, value]);
    }
    // Every EasingKind has a number and they are distinct.
    expect(new Set(Object.values(NATIVE_EASING)).size).toBe(Object.keys(NATIVE_EASING).length);
    expect(enumerator(evalHeader, 'MOTION_EASING_COUNT_')).toBe(Object.keys(NATIVE_EASING).length);
  });

  it('spatial enum', () => {
    expect(enumerator(evalHeader, 'MOTION_SPATIAL_LINEAR')).toBe(NATIVE_SPATIAL.linear);
    expect(enumerator(evalHeader, 'MOTION_SPATIAL_BEZIER')).toBe(NATIVE_SPATIAL.bezier);
    expect(enumerator(evalHeader, 'MOTION_SPATIAL_CONTINUOUS')).toBe(NATIVE_SPATIAL.continuous);
    expect(enumerator(evalHeader, 'MOTION_SPATIAL_AUTO')).toBe(NATIVE_SPATIAL.auto);
    expect(enumerator(evalHeader, 'MOTION_SPATIAL_UNSET')).toBe(0);
  });

  it('gen_golden.ts carries the same easing/flag table', () => {
    const gen = readFileSync(resolve(__dirname, '../../../native/tests/gen_golden.ts'), 'utf8');
    // `const EASING = { linear: 0, … }` — the object literal comes before the
    // SPATIAL one in the file, so the first `<kind>: n` is the easing entry.
    for (const [kind, value] of Object.entries(NATIVE_EASING)) {
      const m = new RegExp(`\\b${kind}:\\s*(\\d+)`).exec(gen);
      expect([kind, m && Number(m[1])]).toEqual([kind, value]);
    }
    expect(enumerator(gen, 'FLAG_HAS_BEZIER')).toBe(KF_HAS_BEZIER);
    expect(enumerator(gen, 'FLAG_HAS_SI')).toBe(KF_HAS_SI);
    expect(enumerator(gen, 'FLAG_HAS_SO')).toBe(KF_HAS_SO);
    expect(enumerator(gen, 'SPATIAL_SHIFT')).toBe(KF_SPATIAL_SHIFT);
  });
});
