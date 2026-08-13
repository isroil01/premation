/**
 * The gate a plugin's WGSL passes before it is allowed near the GPU.
 *
 * ── What this is actually defending against ──────────────────────────────────
 *
 * Not "malicious code", in the sense the worker sandbox defends against. A
 * fragment shader cannot read the document, reach the network, or call anything.
 * What it CAN do is take too long — and a GPU has no preemption. A shader that
 * loops a million times per pixel does not throw, does not yield, and cannot be
 * cancelled: the driver waits, then the operating system decides the GPU has
 * hung and resets it. On Windows that is TDR, and it takes down every GPU
 * context in the process, which means the editor's viewport goes with it.
 *
 * So the failure this prevents is: **one plugin's shader kills the whole
 * document's rendering, and the user has no idea which one.** Everything below
 * is chosen for that, not for secrecy.
 *
 * ── Why static analysis is worth anything here, when it wasn't for the scanner ─
 *
 * `plugin-scan.ts` is explicitly advisory because it reasons about intent and
 * intent can be hidden. This does not reason about intent. It refuses SYNTAX —
 * a loop whose bound is not a literal has no bounded cost, whoever wrote it and
 * whatever they meant. An author can still write a slow shader within the rules;
 * they cannot write an unbounded one.
 *
 * It is still not the last line of defence. Compilation has a timeout, failure
 * falls back to passthrough, and device loss is attributed and disables the
 * offending effect (`pluginEffects.ts`). This is the cheap check that stops the
 * obvious cases before any of that is needed.
 *
 * ── The honest limits, stated ────────────────────────────────────────────────
 *
 * This is a lexical pass, not a WGSL parser. It can be defeated — a macro-free
 * language still allows `for (var i = 0; i < 100000; i++)`, which is a literal
 * bound and passes. The instruction ceiling is what catches that shape, and it
 * is a proxy (statement count) rather than a real cost model. Writing a real
 * one would mean writing a WGSL front end, and a hand-written parser fed hostile
 * input is a worse liability than the thing it would be protecting.
 */

/** One reason a shader was refused, in the words its author reads. */
export interface WgslProblem {
  rule: string;
  detail: string;
  /** 1-based, when the problem is at a place. */
  line?: number;
}

export interface WgslCheck {
  ok: boolean;
  problems: WgslProblem[];
}

/**
 * Ceilings.
 *
 * `MAX_SOURCE_BYTES` is first and bluntest: everything below scans the source,
 * and an unbounded source is an unbounded scan on the install path.
 *
 * `MAX_STATEMENTS` is a proxy for cost, and deliberately generous — a real
 * effect with a 9-tap blur and some colour maths lands well under it. What it
 * rules out is the shape that is unmistakably not an effect: thousands of
 * statements, or a modest loop body multiplied by a huge literal bound.
 *
 * `MAX_LOOP_ITERATIONS` is the one that matters most. Per-pixel cost multiplies
 * by it, and a 4K frame is ~8.3M pixels — so a 4096-iteration loop is 34 billion
 * iterations for one frame. 256 keeps a separable blur, a sample kernel and an
 * iterative SDF comfortably expressible.
 */
export const MAX_SOURCE_BYTES = 64 * 1024;
export const MAX_STATEMENTS = 2000;
export const MAX_LOOP_ITERATIONS = 256;
export const MAX_LOOP_NESTING = 3;

/**
 * Constructs refused outright.
 *
 * Each is refused for a specific reason, not on general suspicion:
 *
 *  • `while` / `loop` have no syntactic bound at all. A `for` with a literal
 *    bound can be costed; these cannot, and "it exits eventually" is a claim
 *    only the author can make and only the GPU can disprove.
 *  • Storage and atomic bindings are the write path to memory the host owns. A
 *    fragment effect has no business with either, and allowing them would make
 *    the parameter block stop being the whole interface.
 *  • `@compute` is a different execution model with a different cost story.
 *    Effects are fragment passes; a compute entry point in an effect package is
 *    either a mistake or an attempt at something this contract does not cover.
 *  • `discard` is refused because effects composite: a discarded fragment
 *    leaves whatever was underneath, which reads as corruption rather than as
 *    transparency. Authors want `alpha = 0`, and that is available.
 */
const FORBIDDEN: Array<{ rule: string; re: RegExp; detail: string }> = [
  {
    rule: 'while-loop',
    re: /\bwhile\s*\(/,
    detail:
      'A `while` loop has no bound the host can check. Use `for` with a literal count — the cost of a fragment shader has to be knowable before it runs, because a GPU cannot be interrupted once it starts.',
  },
  {
    rule: 'loop-statement',
    re: /\bloop\s*\{/,
    detail:
      'A `loop` block has no bound the host can check. Use `for` with a literal count.',
  },
  {
    rule: 'storage-binding',
    re: /var\s*<\s*storage/,
    detail:
      'Storage buffers are not available to effects. Everything an effect reads comes from its declared parameters and the input texture.',
  },
  {
    rule: 'atomic',
    re: /\batomic\s*</,
    detail: 'Atomics are not available to effects.',
  },
  {
    rule: 'compute-shader',
    re: /@compute\b/,
    detail:
      'An effect is a fragment pass. Compute entry points are not part of this contract.',
  },
  {
    rule: 'author-binding',
    re: /@(group|binding)\s*\(/,
    detail:
      'Do not declare `@group` or `@binding` yourself. The host generates the parameter block, the input texture and the sampler from your declared parameters and prepends them — an author-declared binding would collide with those, and getting uniform padding right by hand is a class of bug nobody should have to debug from a black frame.',
  },
  {
    rule: 'discard',
    re: /\bdiscard\b/,
    detail:
      'Use `alpha = 0.0` instead of `discard`. Effects composite onto what is beneath them, so a discarded fragment shows the layer below rather than transparency — which reads as corruption.',
  },
];

/** Strip comments so a rule cannot be dodged by, or fired by, a comment. */
export function stripWgslComments(src: string): string {
  return src
    // Block comments become a newline each, so line numbers survive.
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');
}

/**
 * Check a plugin's fragment shader.
 *
 * Runs on the SOURCE, before compilation, because a compile is the expensive
 * step and because the driver's own error messages are not something an author
 * can act on.
 */
export function validateWgsl(source: string): WgslCheck {
  const problems: WgslProblem[] = [];

  if (typeof source !== 'string' || !source.trim()) {
    return { ok: false, problems: [{ rule: 'empty', detail: 'The shader source is empty.' }] };
  }

  // Byte length, not character count: a source of astral-plane characters is
  // twice the bytes it looks like, and this bound exists to cap work.
  const bytes = new TextEncoder().encode(source).length;
  if (bytes > MAX_SOURCE_BYTES) {
    problems.push({
      rule: 'too-large',
      detail: `The shader is ${Math.round(bytes / 1024)} KB; the limit is ${MAX_SOURCE_BYTES / 1024} KB.`,
    });
    // Returned early. Everything below scans the source, and scanning an
    // oversized source is the cost this rule exists to refuse.
    return { ok: false, problems };
  }

  const code = stripWgslComments(source);
  const lines = code.split('\n');

  for (const { rule, re, detail } of FORBIDDEN) {
    const index = lines.findIndex((l) => re.test(l));
    if (index !== -1) problems.push({ rule, detail, line: index + 1 });
  }

  problems.push(...checkLoops(lines));

  /*
    Statement count as a cost proxy.

    Counting semicolons is crude and deliberately so — see the header. It is
    measured on comment-stripped source so a documented shader is not penalised
    for being documented.
  */
  const statements = (code.match(/;/g) ?? []).length;
  if (statements > MAX_STATEMENTS) {
    problems.push({
      rule: 'too-complex',
      detail: `The shader has about ${statements} statements; the limit is ${MAX_STATEMENTS}. This ceiling exists because a fragment shader runs once per pixel and cannot be interrupted.`,
    });
  }

  /*
    Not cost rules — correctness ones, and both are refusals an author can act
    on in seconds. Without them the compile or the pipeline fails with a driver
    message that names nothing the author wrote.

    The entry point must be called `fs`, because that is the name the pipeline
    looks for (`entryPoint: desc.fragmentEntry ?? 'fs'`) and every built-in
    shader in this renderer uses it. Refusing a differently-named entry here
    beats a pipeline that fails to create for a reason nothing states.
  */
  if (!/@fragment\b/.test(code)) {
    problems.push({
      rule: 'no-fragment-entry',
      detail: 'The shader declares no `@fragment` entry point.',
    });
  } else if (!/@fragment[\s\S]{0,40}?\bfn\s+fs\s*\(/.test(code)) {
    problems.push({
      rule: 'fragment-entry-name',
      detail:
        'Name your `@fragment` entry point `fs`. That is the name the render pipeline looks for, and a differently-named one fails to bind with a driver error that names nothing you wrote.',
    });
  }

  if (/@vertex\b/.test(code)) {
    problems.push({
      rule: 'author-vertex',
      detail:
        'Do not write a vertex shader. The host generates it — it is the same full-screen quad transform for every effect, and yours would collide with it.',
    });
  }

  return { ok: problems.length === 0, problems };
}

/**
 * Every `for` loop must have a literal bound, and loops may not nest deeply.
 *
 * The bound rule is the load-bearing one. `for (var i = 0; i < n; i++)` where
 * `n` comes from a uniform is a loop whose cost the user picks at runtime by
 * dragging a slider — and the slider's range is the plugin's to declare. The
 * host cannot cost it, so it is refused.
 *
 * Nesting is capped because bounds MULTIPLY: three nested loops at the
 * per-loop maximum is already 16 million iterations per pixel, which is a hung
 * GPU on any hardware.
 */
function checkLoops(lines: string[]): WgslProblem[] {
  const problems: WgslProblem[] = [];
  let deepest = 0;
  /** Brace depth at which each open loop's body sits. */
  const loopDepths: number[] = [];
  let braces = 0;

  lines.forEach((line, i) => {
    const forMatch = /\bfor\s*\((.*)$/.exec(line);
    if (forMatch) {
      const bound = literalLoopBound(forMatch[1] ?? '');
      if (bound === null) {
        problems.push({
          rule: 'dynamic-loop-bound',
          line: i + 1,
          detail:
            'This loop’s bound is not a literal. A fragment shader runs once per pixel and cannot be interrupted, so its cost has to be knowable before it runs — a bound that comes from a uniform lets a slider hang the GPU.',
        });
      } else if (bound > MAX_LOOP_ITERATIONS) {
        problems.push({
          rule: 'loop-too-long',
          line: i + 1,
          detail: `This loop runs ${bound} times; the limit is ${MAX_LOOP_ITERATIONS} per loop. Per-pixel cost multiplies by this, and a 4K frame is 8.3 million pixels.`,
        });
      }
      loopDepths.push(braces);
      deepest = Math.max(deepest, loopDepths.length);
    }

    for (const ch of line) {
      if (ch === '{') braces += 1;
      else if (ch === '}') {
        braces -= 1;
        // A loop whose body just closed is no longer open.
        while (loopDepths.length && braces <= loopDepths[loopDepths.length - 1]!) {
          loopDepths.pop();
        }
      }
    }
  });

  if (deepest > MAX_LOOP_NESTING) {
    problems.push({
      rule: 'loops-too-deep',
      detail: `Loops are nested ${deepest} deep; the limit is ${MAX_LOOP_NESTING}. Bounds multiply, so nesting is where a shader stops being costable.`,
    });
  }

  return problems;
}

/**
 * The literal iteration count of a `for` header, or null when it is not literal.
 *
 * Deliberately narrow: it understands `i < N`, `i <= N`, `i > N` and `i >= N`
 * against a decimal literal, and nothing else. Anything it does not understand
 * returns null and the loop is REFUSED — which is the safe direction. A cleverer
 * reader that guessed at expressions would be guessing about the one number
 * that decides whether the GPU survives.
 */
export function literalLoopBound(header: string): number | null {
  // `for (init; cond; step)` — the condition is the middle clause.
  const parts = header.split(';');
  if (parts.length < 2) return null;
  const cond = parts[1] ?? '';

  const m = /[<>]=?\s*(\d+)\s*(?:u|i|f)?\s*\)?\s*$/.exec(cond.trim());
  if (!m) return null;

  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}
