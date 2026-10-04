#!/usr/bin/env node
// Block 3 of docs/TS_ENGINE_REMOVAL.md — which code the APP still runs that
// touches the page replica (the TypeScript engine's live document).
//
// Declaration-level reachability from src/main.tsx through the TypeScript
// checker: nodes are top-level declarations (plus one `<module>` node per file
// for its top-level statements); an edge is an identifier in a node's VALUE
// code that resolves, through import aliases, to another top-level declaration.
// Type positions are ignored (they do not run). A reached declaration pulls in
// its file's `<module>` node (importing a file runs its top level).
//
// The TypeScript engine itself (LocalEngine + its command handlers) is DROPPED
// from the graph: what it alone uses goes with it. What is left touching the
// SINKS (the replica's singletons) is the block-3 worklist.
//
//   node scripts/lint/replicaReach.cjs                 per-file table + total
//   node scripts/lint/replicaReach.cjs --file <path>   the file's reached sink users, each with its chain from main
//   node scripts/lint/replicaReach.cjs --why <file#decl>   one chain
//   node scripts/lint/replicaReach.cjs --json <out>    machine-readable
//   node scripts/lint/replicaReach.cjs --deadfiles     project files the app never reaches
//
// ~25 s (it type-checks the app's import closure).

const path = require('path');
const fs = require('fs');

const root = path.resolve(__dirname, '..', '..');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const ts = require(path.join(root, 'node_modules/typescript'));

const DROP = new RegExp(arg('--drop', '^src/core/engine/(handlers/|LocalEngine\\.ts)'));
const SINKS = new RegExp(arg('--sinks', [
  'src/core/scene/DefaultSceneGraph\\.ts#',
  'packages/animation/src/defaultAnimation\\.ts#defaultAnimation$',
  'src/core/timeline/TimelineController\\.ts#getTimelineController$',
  'src/core/engine/doc\\.ts#',
  'src/core/engine/state\\.ts#',
  'src/core/engine/offDocument\\.ts#',
  'src/core/engine/engineInstance\\.ts#localEngine$',
].map((s) => `^${s}`).join('|')));

const cfg = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, root);
const entry = path.join(root, 'src/main.tsx');
const program = ts.createProgram([entry], { ...parsed.options, noEmit: true });
const checker = program.getTypeChecker();
const norm = (f) => path.relative(root, f).replace(/\\/g, '/');
const isOurs = (f) => !f.includes('node_modules') && !f.endsWith('.d.ts');

const nodes = new Map(); // key -> { file, name, edges }
const declKey = new Map(); // declaration node -> key

function topDeclsOf(statements) {
  const out = [];
  for (const st of statements) {
    if (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) {
      if (st.name) out.push([st.name.text, st]);
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) out.push([ts.isIdentifier(d.name) ? d.name.text : `<destructure@${st.pos}>`, d]);
    } else if (ts.isModuleDeclaration(st)) {
      out.push([st.name.text || 'ns', st]);
    }
  }
  return out;
}

const files = program.getSourceFiles().filter((sf) => isOurs(sf.fileName));
for (const sf of files) {
  const f = norm(sf.fileName);
  nodes.set(`${f}#<module>`, { file: f, name: '<module>', edges: new Set() });
  for (const [name, d] of topDeclsOf(sf.statements)) {
    const k = `${f}#${name}`;
    if (!nodes.has(k)) nodes.set(k, { file: f, name, edges: new Set() });
    declKey.set(d, k);
  }
}

function keyOfSymbol(sym) {
  if (!sym) return null;
  if (sym.flags & ts.SymbolFlags.Alias) {
    try { sym = checker.getAliasedSymbol(sym); } catch { return null; }
  }
  for (const d of sym.declarations || []) {
    let n = d;
    while (n && !declKey.has(n)) n = n.parent;
    if (n) return declKey.get(n);
  }
  return null;
}

for (const sf of files) {
  const modKey = `${norm(sf.fileName)}#<module>`;
  const visit = (owner, n) => {
    // `await import('…')`: the binding a destructure names does not resolve to
    // the export, so the caller reaches the WHOLE module (conservative).
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) {
      const target = checker.getSymbolAtLocation(n.arguments[0]);
      const tf = target && target.valueDeclaration && ts.isSourceFile(target.valueDeclaration) ? norm(target.valueDeclaration.fileName) : null;
      // `const { a, b } = await import('…')` names exactly what it takes.
      const p = n.parent && ts.isAwaitExpression(n.parent) ? n.parent.parent : null;
      const names = p && ts.isVariableDeclaration(p) && ts.isObjectBindingPattern(p.name)
        ? p.name.elements.map((e) => (e.propertyName ?? e.name).getText())
        : null;
      if (tf && names && !p.name.elements.some((e) => e.dotDotDotToken)) {
        for (const nm of names) if (nodes.has(`${tf}#${nm}`)) nodes.get(owner).edges.add(`${tf}#${nm}`);
        nodes.get(owner).edges.add(`${tf}#<module>`);
      } else if (tf) for (const k of nodes.keys()) if (k.startsWith(`${tf}#`)) nodes.get(owner).edges.add(k);
    }
    if (ts.isIdentifier(n)) {
      // `{ name }` names the property: the VALUE it takes is the shorthand's value symbol.
      const sh = n.parent && ts.isShorthandPropertyAssignment(n.parent) && n.parent.name === n;
      const k = keyOfSymbol(sh ? checker.getShorthandAssignmentValueSymbol(n.parent) : checker.getSymbolAtLocation(n));
      if (k && k !== owner) nodes.get(owner).edges.add(k);
    }
    if (ts.isTypeNode(n) && !ts.isExpressionWithTypeArguments(n)) return;
    ts.forEachChild(n, (c) => visit(owner, c));
  };
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st)) continue;
    const decls = topDeclsOf([st]);
    if (decls.length) {
      for (const [, d] of decls) visit(declKey.get(d), d);
      continue;
    }
    if (ts.isExportDeclaration(st)) {
      if (st.exportClause && ts.isNamedExports(st.exportClause)) {
        for (const el of st.exportClause.elements) {
          const k = keyOfSymbol(checker.getSymbolAtLocation(el.name));
          if (k) nodes.get(modKey).edges.add(k);
        }
      }
      continue;
    }
    visit(modKey, st);
  }
}

const mainFile = norm(entry);
const parent = new Map();
const queue = [];
for (const k of nodes.keys()) if (k.startsWith(`${mainFile}#`)) { parent.set(k, null); queue.push(k); }
while (queue.length) {
  const k = queue.shift();
  const n = nodes.get(k);
  const next = [...n.edges];
  if (n.name !== '<module>') next.push(`${n.file}#<module>`);
  for (const t of next) {
    const tn = nodes.get(t);
    if (!tn || DROP.test(tn.file) || parent.has(t)) continue;
    parent.set(t, k);
    queue.push(t);
  }
}

const chain = (k) => { const c = []; while (k) { c.push(k); k = parent.get(k); } return c.reverse(); };
const users = [];
for (const k of parent.keys()) {
  if (SINKS.test(k)) continue;
  const hits = [...nodes.get(k).edges].filter((e) => SINKS.test(e));
  if (hits.length) users.push({ k, hits });
}
const byFile = new Map();
for (const u of users) {
  const f = u.k.split('#')[0];
  if (!byFile.has(f)) byFile.set(f, []);
  byFile.get(f).push(u);
}

const json = arg('--json', null);
if (json) fs.writeFileSync(json, JSON.stringify(users.map((u) => ({ ...u, chain: chain(u.k) })), null, 1));

const one = arg('--file', null);
if (one) {
  for (const u of byFile.get(one.replace(/\\/g, '/')) || []) {
    console.log(`${u.k}\n  sinks: ${u.hits.map((h) => h.split('#')[1]).join(', ')}\n  via:   ${chain(u.k).slice(0, -1).reverse().slice(0, 6).join('\n         ')}`);
  }
}
const why = arg('--why', null);
if (why) console.log(parent.has(why) ? chain(why).reverse().join('\n  <- ') : `${why} is not reached`);

if (argv.includes('--deadfiles')) {
  const reachedFiles = new Set([...parent.keys()].map((k) => nodes.get(k).file));
  for (const sf of files) { const f = norm(sf.fileName); if (!reachedFiles.has(f)) console.log('DEAD', f); }
}

if (!one && !why && !argv.includes('--deadfiles')) {
  for (const [f, us] of [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`${String(us.length).padStart(3)}  ${f}  ${us.map((u) => u.k.split('#')[1]).join(', ')}`);
  }
}
console.log(`replica users reached from the app: ${users.length} declarations in ${byFile.size} files`);
