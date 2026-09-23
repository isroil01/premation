/**
 * Sequential async list helpers for tool handlers. SEQUENTIAL on purpose: the
 * facades send engine requests, and a tool's writes must land in the order the
 * tool made them (Promise.all over writes would interleave nothing today — the
 * engine queues requests in order — but reads-after-writes stay obvious).
 */

export async function mapSeq<T, U>(xs: readonly T[], f: (x: T, i: number) => Promise<U> | U): Promise<U[]> {
  const out: U[] = [];
  for (let i = 0; i < xs.length; i++) out.push(await f(xs[i]!, i));
  return out;
}

export async function filterSeq<T>(xs: readonly T[], f: (x: T, i: number) => Promise<boolean> | boolean): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < xs.length; i++) if (await f(xs[i]!, i)) out.push(xs[i]!);
  return out;
}
