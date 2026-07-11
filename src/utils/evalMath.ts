/**
 * Safe arithmetic evaluator for value-field input.
 *
 * Supports + - * / % ^, parentheses, decimals, and unary minus. There is NO
 * access to JS scope, functions, or identifiers — it is a pure numeric
 * calculator, so it is safe to run on arbitrary user input (never `eval`).
 *
 * Used by the signature ValueField so a user can type `960/2`, `1920*0.5`,
 * or `(3+4)*2` directly into any numeric property.
 */

type Tok =
  | { t: 'num'; v: number }
  | { t: 'op'; v: '+' | '-' | '*' | '/' | '%' | '^' }
  | { t: 'lp' }
  | { t: 'rp' };

function tokenize(input: string): Tok[] | null {
  const toks: Tok[] = [];
  let i = 0;
  const s = input.trim();
  while (i < s.length) {
    const c = s[i];
    if (c === undefined) break;
    if (c === ' ' || c === '\t') {
      i++;
      continue;
    }
    if (c === '(') {
      toks.push({ t: 'lp' });
      i++;
      continue;
    }
    if (c === ')') {
      toks.push({ t: 'rp' });
      i++;
      continue;
    }
    if (c === '+' || c === '-' || c === '*' || c === '/' || c === '%' || c === '^') {
      toks.push({ t: 'op', v: c });
      i++;
      continue;
    }
    // number (with optional decimal). Leading digits or a bare dot.
    if ((c >= '0' && c <= '9') || c === '.') {
      let j = i;
      let dot = false;
      while (j < s.length) {
        const d = s[j];
        if (d === undefined) break;
        if (d >= '0' && d <= '9') {
          j++;
        } else if (d === '.' && !dot) {
          dot = true;
          j++;
        } else {
          break;
        }
      }
      const num = Number(s.slice(i, j));
      if (!Number.isFinite(num)) return null;
      toks.push({ t: 'num', v: num });
      i = j;
      continue;
    }
    return null; // unknown character
  }
  return toks;
}

const PREC: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2, '^': 3 };
const RIGHT_ASSOC = new Set(['^']);

function prec(op: string): number {
  return PREC[op] ?? 0;
}

/**
 * Evaluate an arithmetic expression. Returns the numeric result, or `null`
 * if the expression is malformed or divides by zero.
 */
export function evalMath(input: string): number | null {
  const toks = tokenize(input);
  if (!toks || toks.length === 0) return null;

  // Shunting-yard → RPN, tracking unary minus/plus by position.
  const output: Tok[] = [];
  const ops: Tok[] = [];
  let prevKind: 'start' | 'num' | 'op' | 'lp' | 'rp' = 'start';

  for (const tok of toks) {
    if (tok.t === 'num') {
      output.push(tok);
      prevKind = 'num';
    } else if (tok.t === 'op') {
      // Unary +/- when at start, after another operator, or after '('.
      const unary =
        (tok.v === '-' || tok.v === '+') &&
        (prevKind === 'start' || prevKind === 'op' || prevKind === 'lp');
      if (unary) {
        // Represent unary minus as (0 - x) with high precedence: push 0.
        output.push({ t: 'num', v: 0 });
        // Treat as a normal operator but with elevated precedence handling
        // by pushing immediately (0 already emitted keeps it binary).
      }
      while (ops.length) {
        const top = ops[ops.length - 1];
        if (!top || top.t !== 'op') break;
        const higher =
          prec(top.v) > prec(tok.v) ||
          (prec(top.v) === prec(tok.v) && !RIGHT_ASSOC.has(tok.v));
        if (higher) output.push(ops.pop() as Tok);
        else break;
      }
      ops.push(tok);
      prevKind = 'op';
    } else if (tok.t === 'lp') {
      ops.push(tok);
      prevKind = 'lp';
    } else {
      // rp
      let matched = false;
      while (ops.length) {
        const top = ops.pop() as Tok;
        if (top.t === 'lp') {
          matched = true;
          break;
        }
        output.push(top);
      }
      if (!matched) return null; // unbalanced
      prevKind = 'rp';
    }
  }
  while (ops.length) {
    const top = ops.pop() as Tok;
    if (top.t === 'lp' || top.t === 'rp') return null; // unbalanced
    output.push(top);
  }

  // Evaluate RPN.
  const stack: number[] = [];
  for (const tok of output) {
    if (tok.t === 'num') {
      stack.push(tok.v);
      continue;
    }
    if (tok.t !== 'op') return null;
    const b = stack.pop();
    const a = stack.pop();
    if (a === undefined || b === undefined) return null;
    let r: number;
    switch (tok.v) {
      case '+': r = a + b; break;
      case '-': r = a - b; break;
      case '*': r = a * b; break;
      case '/': if (b === 0) return null; r = a / b; break;
      case '%': if (b === 0) return null; r = a % b; break;
      case '^': r = Math.pow(a, b); break;
      default: return null;
    }
    stack.push(r);
  }
  if (stack.length !== 1) return null;
  const result = stack[0];
  return result !== undefined && Number.isFinite(result) ? result : null;
}

/**
 * Resolve a raw value-field entry against the field's current value.
 *
 * A leading `+`, `*`, or `/` is RELATIVE and applies to `current`
 * (`+15` → current+15, `*1.5` → current*1.5, `/2` → current/2). Everything
 * else — including a leading `-` — is ABSOLUTE, so `-45` sets -45 and
 * `960/2` sets 480. Returns `null` when the entry is not valid arithmetic.
 */
export function applyValueExpression(current: number, raw: string): number | null {
  const s = raw.trim();
  if (s === '') return null;
  const head = s[0];
  if (head === '+' || head === '*' || head === '/') {
    const rhs = evalMath(s.slice(1));
    if (rhs === null) return null;
    if (head === '+') return current + rhs;
    if (head === '*') return current * rhs;
    return rhs === 0 ? null : current / rhs;
  }
  return evalMath(s);
}
