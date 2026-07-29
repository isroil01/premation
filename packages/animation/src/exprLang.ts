/**
 * Expression language — parser + evaluator for property expressions.
 *
 * WHY THIS EXISTS: expressions used to compile via `new Function`, which the
 * app's Content-Security-Policy (`script-src 'self'`, no `'unsafe-eval'`)
 * refuses at runtime. Every expression on every property silently evaluated to
 * null and fell back to the base value. The unit tests passed because jsdom
 * enforces no CSP — the failure only ever existed in the real renderer.
 *
 * Relaxing the CSP would have fixed it in one line, but the renderer holds the
 * user's auth token and talks to motion-back, so `'unsafe-eval'` would make any
 * expression in any opened or shared project an arbitrary-code-execution vector.
 * Interpreting the formula ourselves keeps the CSP intact AND means a user
 * expression can only ever reach the names we hand it — there is no `window`,
 * no `fetch`, no `constructor` escape.
 *
 * SCOPE: a single JavaScript *expression*, which is all the old code allowed
 * (`return (${src})`). No statements, declarations, assignment or loops — so
 * this is a bounded grammar, not a JS engine. Supported:
 *
 *   literals        1, 1.5,.5, 1e3, "s", 'a', true, false, null
 *   identifiers     time, value, wiggle, Math, thisComp, …
 *   member          a.b, a["b"]
 *   call            f(x), Math.sin(t), thisComp.layer('A', 'x')
 *   unary           -x, +x, !x
 *   binary          * / % + - < <= > >= == != === !== && ||
 *   ternary         c ? a: b
 *   grouping        (…)
 *   array           [a, b]
 *
 * Evaluation is total: it throws typed errors that `expressions.ts` turns into
 * the same plain-language messages users already saw.
 */

// ── AST ───────────────────────────────────────────────────────────

export type ExprNode =
  | { kind: 'num'; value: number }
  | { kind: 'str'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'ident'; name: string }
  | { kind: 'array'; items: ExprNode[] }
  | { kind: 'member'; object: ExprNode; property: ExprNode; computed: boolean }
  | { kind: 'call'; callee: ExprNode; args: ExprNode[] }
  | { kind: 'unary'; op: '-' | '+' | '!'; argument: ExprNode }
  | { kind: 'binary'; op: BinaryOp; left: ExprNode; right: ExprNode }
  | { kind: 'logical'; op: '&&' | '||'; left: ExprNode; right: ExprNode }
  | { kind: 'conditional'; test: ExprNode; consequent: ExprNode; alternate: ExprNode };

export type BinaryOp =
  | '*' | '/' | '%' | '+' | '-'
  | '<' | '<=' | '>' | '>='
  | '==' | '!=' | '===' | '!==';

/** Thrown for anything malformed. `expressions.ts` humanizes the message. */
export class ExprSyntaxError extends Error {}
/** Thrown during evaluation (unknown name, not a function, blocked access). */
export class ExprRuntimeError extends Error {}

// ── Lexer ─────────────────────────────────────────────────────────

interface Tok {
  type: 'num' | 'str' | 'name' | 'punct' | 'eof';
  value: string;
  start: number;
}

// Longest-first: '===' must be tried before '==', which must beat '='.
const PUNCT = [
  '===', '!==', '==', '!=', '<=', '>=', '&&', '||',
  '(', ')', '[', ']', ',', '.', '?', ':',
  '+', '-', '*', '/', '%', '<', '>', '!',
];

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;

  while (i < src.length) {
    const c = src[i]!;

    if (/\s/.test(c)) { i++; continue; }

    // Number: 1, 1.5,.5, 1e-3
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const start = i;
      while (i < src.length && /[0-9]/.test(src[i]!)) i++;
      if (src[i] === '.') { i++; while (i < src.length && /[0-9]/.test(src[i]!)) i++; }
      if (src[i] === 'e' || src[i] === 'E') {
        const save = i;
        i++;
        if (src[i] === '+' || src[i] === '-') i++;
        if (/[0-9]/.test(src[i] ?? '')) { while (i < src.length && /[0-9]/.test(src[i]!)) i++; }
        else i = save; // "1e" — the 'e' isn't part of the number
      }
      out.push({ type: 'num', value: src.slice(start, i), start });
      continue;
    }

    // String
    if (c === '"' || c === "'") {
      const start = i;
      const quote = c;
      i++;
      let value = '';
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') {
          const esc = src[i + 1];
          value +=
            esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc ?? '';
          i += 2;
          continue;
        }
        value += src[i];
        i++;
      }
      if (i >= src.length) throw new ExprSyntaxError('Unterminated string — missing a closing quote.');
      i++; // closing quote
      out.push({ type: 'str', value, start });
      continue;
    }

    // Identifier
    if (/[A-Za-z_$]/.test(c)) {
      const start = i;
      while (i < src.length && /[A-Za-z0-9_$]/.test(src[i]!)) i++;
      out.push({ type: 'name', value: src.slice(start, i), start });
      continue;
    }

    const punct = PUNCT.find((p) => src.startsWith(p, i));
    if (punct) {
      out.push({ type: 'punct', value: punct, start: i });
      i += punct.length;
      continue;
    }

    throw new ExprSyntaxError(`Unexpected character “${c}”.`);
  }

  out.push({ type: 'eof', value: '', start: i });
  return out;
}

// ── Parser (Pratt) ────────────────────────────────────────────────

/** JS binary precedence. Higher binds tighter. Ternary and ?: sit below these. */
const BINARY_PRECEDENCE: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '==': 3, '!=': 3, '===': 3, '!==': 3,
  '<': 4, '<=': 4, '>': 4, '>=': 4,
  '+': 5, '-': 5,
  '*': 6, '/': 6, '%': 6,
};

class Parser {
  private toks: Tok[];
  private pos = 0;

  constructor(src: string) {
    this.toks = lex(src);
  }

  private peek(): Tok {
    return this.toks[this.pos]!;
  }

  private next(): Tok {
    return this.toks[this.pos++]!;
  }

  private is(value: string): boolean {
    const t = this.peek();
    return t.type === 'punct' && t.value === value;
  }

  private eat(value: string): boolean {
    if (this.is(value)) { this.pos++; return true; }
    return false;
  }

  private expect(value: string): void {
    if (!this.eat(value)) {
      const t = this.peek();
      const found = t.type === 'eof' ? 'end of expression' : `“${t.value}”`;
      throw new ExprSyntaxError(`Expected “${value}” but found ${found}.`);
    }
  }

  parse(): ExprNode {
    const node = this.parseExpression();
    if (this.peek().type !== 'eof') {
      throw new ExprSyntaxError(
        `Unexpected “${this.peek().value}”. An expression must be a single value — statements and “;” aren’t supported.`,
      );
    }
    return node;
  }

  private parseExpression(): ExprNode {
    return this.parseConditional();
  }

  private parseConditional(): ExprNode {
    const test = this.parseBinary(0);
    if (!this.eat('?')) return test;
    const consequent = this.parseExpression();
    this.expect(':');
    const alternate = this.parseExpression();
    return { kind: 'conditional', test, consequent, alternate };
  }

  private parseBinary(minPrec: number): ExprNode {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (t.type !== 'punct') break;
      const prec = BINARY_PRECEDENCE[t.value];
      if (prec === undefined || prec < minPrec) break;
      this.next();
      // All these operators are left-associative.
      const right = this.parseBinary(prec + 1);
      left =
        t.value === '&&' || t.value === '||'
          ? { kind: 'logical', op: t.value, left, right }
          : { kind: 'binary', op: t.value as BinaryOp, left, right };
    }
    return left;
  }

  private parseUnary(): ExprNode {
    const t = this.peek();
    if (t.type === 'punct' && (t.value === '-' || t.value === '+' || t.value === '!')) {
      this.next();
      return { kind: 'unary', op: t.value as '-' | '+' | '!', argument: this.parseUnary() };
    }
    return this.parseCallMember();
  }

  private parseCallMember(): ExprNode {
    let node = this.parsePrimary();
    for (;;) {
      if (this.eat('.')) {
        const t = this.next();
        if (t.type !== 'name') throw new ExprSyntaxError('Expected a property name after “.”.');
        node = { kind: 'member', object: node, property: { kind: 'str', value: t.value }, computed: false };
      } else if (this.eat('[')) {
        const property = this.parseExpression();
        this.expect(']');
        node = { kind: 'member', object: node, property, computed: true };
      } else if (this.eat('(')) {
        const args: ExprNode[] = [];
        if (!this.is(')')) {
          do { args.push(this.parseExpression()); } while (this.eat(','));
        }
        this.expect(')');
        node = { kind: 'call', callee: node, args };
      } else {
        return node;
      }
    }
  }

  private parsePrimary(): ExprNode {
    const t = this.next();

    if (t.type === 'num') {
      const value = Number(t.value);
      if (!Number.isFinite(value)) throw new ExprSyntaxError(`“${t.value}” isn’t a valid number.`);
      return { kind: 'num', value };
    }
    if (t.type === 'str') return { kind: 'str', value: t.value };

    if (t.type === 'name') {
      if (t.value === 'true') return { kind: 'bool', value: true };
      if (t.value === 'false') return { kind: 'bool', value: false };
      if (t.value === 'null' || t.value === 'undefined') return { kind: 'null' };
      return { kind: 'ident', name: t.value };
    }

    if (t.type === 'punct') {
      if (t.value === '(') {
        const node = this.parseExpression();
        this.expect(')');
        return node;
      }
      if (t.value === '[') {
        const items: ExprNode[] = [];
        if (!this.is(']')) {
          do { items.push(this.parseExpression()); } while (this.eat(','));
        }
        this.expect(']');
        return { kind: 'array', items };
      }
    }

    const found = t.type === 'eof' ? 'end of expression' : `“${t.value}”`;
    throw new ExprSyntaxError(`Unexpected ${found}.`);
  }
}

/** Parse an expression to an AST. Throws ExprSyntaxError. */
export function parseExpression(src: string): ExprNode {
  return new Parser(src).parse();
}

// ── Evaluator ─────────────────────────────────────────────────────

/**
 * Property names that can climb out of the sandbox into the prototype chain
 * (and from there to Function, and from Function to arbitrary code). The whole
 * point of interpreting instead of eval'ing is that this list is enforceable.
 */
const BLOCKED_PROPS = new Set(['__proto__', 'constructor', 'prototype']);

function isSafeCallee(v: unknown): v is (...args: unknown[]) => unknown {
  return typeof v === 'function';
}

function readMember(object: unknown, key: string | number): unknown {
  if (object === null || object === undefined) {
    throw new ExprRuntimeError(`Cannot read “${key}” of ${object === null ? 'null' : 'undefined'}.`);
  }
  if (typeof key === 'string' && BLOCKED_PROPS.has(key)) {
    throw new ExprRuntimeError(`Access to “${key}” isn’t allowed.`);
  }
  // Only ever read own properties, or the curated built-ins we hand in (Math's
  // members live on the Math object itself, so this covers them).
  const value = (object as Record<string | number, unknown>)[key];
  return value;
}

function truthy(v: unknown): boolean {
  return Boolean(v);
}

function evalNode(node: ExprNode, scope: ReadonlyMap<string, unknown>): unknown {
  switch (node.kind) {
    case 'num':
    case 'str':
    case 'bool':
      return node.value;
    case 'null':
      return null;

    case 'ident': {
      if (!scope.has(node.name)) {
        throw new ExprRuntimeError(`${node.name} is not defined`);
      }
      return scope.get(node.name);
    }

    case 'array':
      return node.items.map((n) => evalNode(n, scope));

    case 'member': {
      const object = evalNode(node.object, scope);
      const key = node.computed ? evalNode(node.property, scope) : (node.property as { value: string }).value;
      if (typeof key !== 'string' && typeof key !== 'number') {
        throw new ExprRuntimeError('Property names must be a string or number.');
      }
      return readMember(object, key);
    }

    case 'call': {
      // Member calls need their receiver as `this` (Math.sin won't work without it).
      let thisArg: unknown;
      let fn: unknown;
      if (node.callee.kind === 'member') {
        thisArg = evalNode(node.callee.object, scope);
        const key = node.callee.computed
          ? evalNode(node.callee.property, scope)
          : (node.callee.property as { value: string }).value;
        if (typeof key !== 'string' && typeof key !== 'number') {
          throw new ExprRuntimeError('Property names must be a string or number.');
        }
        fn = readMember(thisArg, key);
        if (!isSafeCallee(fn)) throw new ExprRuntimeError(`${String(key)} is not a function`);
      } else {
        fn = evalNode(node.callee, scope);
        if (!isSafeCallee(fn)) {
          const name = node.callee.kind === 'ident' ? node.callee.name : 'That';
          throw new ExprRuntimeError(`${name} is not a function`);
        }
      }
      const args = node.args.map((a) => evalNode(a, scope));
      return (fn as (...a: unknown[]) => unknown).apply(thisArg, args);
    }

    case 'unary': {
      const v = evalNode(node.argument, scope);
      if (node.op === '!') return !truthy(v);
      const n = Number(v);
      return node.op === '-' ? -n : +n;
    }

    case 'logical': {
      // Short-circuit, like JS — the right side must not evaluate.
      const left = evalNode(node.left, scope);
      if (node.op === '&&') return truthy(left) ? evalNode(node.right, scope) : left;
      return truthy(left) ? left : evalNode(node.right, scope);
    }

    case 'binary':
      return applyBinary(node.op, evalNode(node.left, scope), evalNode(node.right, scope));

    case 'conditional':
      return truthy(evalNode(node.test, scope)) ? evalNode(node.consequent, scope) : evalNode(node.alternate, scope);
  }
}

function applyBinary(op: BinaryOp, l: unknown, r: unknown): unknown {
  const a = l as never;
  const b = r as never;
  switch (op) {
    // `+` stays polymorphic so string concat works ('a' + 'b').
    case '+': return (a as number) + (b as number);
    case '-': return (a as number) - (b as number);
    case '*': return (a as number) * (b as number);
    case '/': return (a as number) / (b as number);
    case '%': return (a as number) % (b as number);
    case '<': return a < b;
    case '<=': return a <= b;
    case '>': return a > b;
    case '>=': return a >= b;
    case '==': return a == b; // eslint-disable-line eqeqeq
    case '!=': return a != b; // eslint-disable-line eqeqeq
    case '===': return a === b;
    case '!==': return a !== b;
  }
}

/** Evaluate a parsed expression against a name→value scope. */
export function evaluateExpression(node: ExprNode, scope: ReadonlyMap<string, unknown>): unknown {
  return evalNode(node, scope);
}
