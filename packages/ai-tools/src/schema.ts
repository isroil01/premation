/**
 * A small JSON Schema validator, scoped to exactly the subset our tool schemas
 * use. We hand-roll it rather than pull in ajv because this package must stay
 * dependency-free (Electron's main process compiles it with bare `tsc`, and the
 * NestJS backend reads the same schemas).
 *
 * The output is tuned for a *model*, not a developer: errors are paths plus
 * what-to-do-instead ("keyframes[2].t must be >= 0"), because they are fed back
 * into the conversation as a repair hint. A vague error wastes a turn.
 */

import type { JsonSchema } from './types';

export interface ValidOk {
  ok: true;
  value: unknown;
}
export interface ValidErr {
  ok: false;
  errors: string[];
}
export type ValidResult = ValidOk | ValidErr;

const typeName = (v: unknown): string => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
};

/**
 * Validate `value` against `schema`, filling in defaults as it goes.
 *
 * Models routinely send numbers as strings ("1.2") and integers where floats
 * are wanted, so we coerce those two cases rather than bounce a turn over them.
 * Everything else is reported.
 */
export function validate(schema: JsonSchema, value: unknown, path = ''): ValidResult {
  const errors: string[] = [];
  const at = (p: string) => (p ? p : 'input');

  // ── enum ────────────────────────────────────────────────────────
  if (schema.enum && !schema.enum.includes(value as string | number)) {
    return { ok: false, errors: [`${at(path)} must be one of: ${schema.enum.join(', ')} (got ${JSON.stringify(value)})`] };
  }

  switch (schema.type) {
    case 'object': {
      if (typeName(value) !== 'object') {
        return { ok: false, errors: [`${at(path)} must be an object, got ${typeName(value)}`] };
      }
      const src = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      const props = schema.properties ?? {};

      for (const key of schema.required ?? []) {
        if (src[key] === undefined) errors.push(`${at(path)} is missing required property '${key}'`);
      }
      if (schema.additionalProperties === false) {
        const known = new Set(Object.keys(props));
        for (const key of Object.keys(src)) {
          if (!known.has(key)) {
            errors.push(`${at(path)} has unknown property '${key}'. Allowed: ${[...known].join(', ')}`);
          }
        }
      }
      for (const [key, sub] of Object.entries(props)) {
        const child = src[key];
        if (child === undefined) {
          if (sub.default !== undefined) out[key] = sub.default;
          continue;
        }
        const r = validate(sub, child, path ? `${path}.${key}` : key);
        if (r.ok) out[key] = r.value;
        else errors.push(...r.errors);
      }
      return errors.length ? { ok: false, errors } : { ok: true, value: out };
    }

    case 'array': {
      if (!Array.isArray(value)) {
        return { ok: false, errors: [`${at(path)} must be an array, got ${typeName(value)}`] };
      }
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        errors.push(`${at(path)} must have at least ${schema.minItems} item(s), got ${value.length}`);
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        errors.push(`${at(path)} must have at most ${schema.maxItems} item(s), got ${value.length}. Split this across multiple calls.`);
      }
      const out: unknown[] = [];
      if (schema.items) {
        value.forEach((item, i) => {
          const r = validate(schema.items!, item, `${at(path)}[${i}]`);
          if (r.ok) out.push(r.value);
          else errors.push(...r.errors);
        });
      } else {
        out.push(...value);
      }
      return errors.length ? { ok: false, errors } : { ok: true, value: out };
    }

    case 'number':
    case 'integer': {
      // Models often quote numbers. Accept that rather than burn a turn.
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (typeof n !== 'number' || !Number.isFinite(n)) {
        return { ok: false, errors: [`${at(path)} must be a finite number, got ${JSON.stringify(value)}`] };
      }
      if (schema.type === 'integer' && !Number.isInteger(n)) {
        return { ok: false, errors: [`${at(path)} must be an integer, got ${n}`] };
      }
      if (schema.minimum !== undefined && n < schema.minimum) {
        errors.push(`${at(path)} must be >= ${schema.minimum}, got ${n}`);
      }
      if (schema.maximum !== undefined && n > schema.maximum) {
        errors.push(`${at(path)} must be <= ${schema.maximum}, got ${n}`);
      }
      return errors.length ? { ok: false, errors } : { ok: true, value: n };
    }

    case 'string': {
      if (typeof value !== 'string') {
        return { ok: false, errors: [`${at(path)} must be a string, got ${typeName(value)}`] };
      }
      return { ok: true, value };
    }

    case 'boolean': {
      if (typeof value !== 'boolean') {
        return { ok: false, errors: [`${at(path)} must be a boolean, got ${typeName(value)}`] };
      }
      return { ok: true, value };
    }

    case 'null': {
      if (value !== null) {
        return { ok: false, errors: [`${at(path)} must be null, got ${typeName(value)}`] };
      }
      return { ok: true, value: null };
    }

    default:
      // No declared type — accept as-is.
      return { ok: true, value };
  }
}
