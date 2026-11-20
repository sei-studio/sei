// Static ESM link check for code the packaged app runs UNBUNDLED under plain
// Node ESM.
//
// Why this exists: src/bot/** ships as raw ESM source, asar-unpacked to
// app.asar.unpacked/src/bot/ and started with utilityProcess.fork. The vendored
// packages (soulcaster, img2skin, cce-1) are externalized by electron-vite and
// loaded by main straight from node_modules. Neither goes through a bundler, so
// a named import that the target module does not export is a link-time
// SyntaxError the moment Node loads the graph, and the whole process dies
// before any code runs. Vitest does not catch it: its transform turns named
// imports into property reads on the module namespace, so a missing export is
// just `undefined` until called. v0.7.0-beta.5 shipped exactly that
// (orchestrator.js imported renderAdoptedLanguageNote through the prompts.js
// barrel, which did not re-export it) and the game bot never loaded.
//
// What it checks, for every non-test .js/.mjs file under the roots, without
// executing anything:
//   - the file parses as an ES module;
//   - its package boundary declares "type": "module" (the root package.json is
//     sealed inside app.asar and is not visible to the unpacked tree);
//   - every static import / re-export specifier resolves the way Node ESM
//     resolves it (relative paths need the exact file, no extension guessing
//     or directory index; bare specifiers go through node_modules and the
//     package "exports" map with node/import conditions);
//   - every named import and named re-export exists in the target, following
//     `export * from` chains and reporting ambiguous star exports like V8;
//   - JSON imports carry `with { type: 'json' }` and import only the default;
//   - literal relative dynamic import() targets exist.
// Named imports from CommonJS packages are not checked (Node decides those with
// cjs-module-lexer at load time); they are counted in the stats.

import { parse } from 'acorn';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import path from 'node:path';

/**
 * Code that runs as plain Node ESM in the packaged app. `dir` is scanned
 * recursively; `boundary` is the directory whose package.json must declare
 * "type": "module" (the nearest one at or below it decides the format, like
 * Node's own lookup on the unpacked filesystem).
 */
export const DEFAULT_ROOTS = [
  // Forked by src/main/botSupervisor.ts from app.asar.unpacked (asarUnpack: src/bot/**).
  { dir: 'src/bot', boundary: 'src/bot' },
  // `file:` deps externalized by electron-vite, imported by main at runtime.
  { dir: 'vendor/soulcaster/src', boundary: 'vendor/soulcaster' },
  { dir: 'vendor/skin-gen/src', boundary: 'vendor/skin-gen' },
  { dir: 'vendor/cce-1/src', boundary: 'vendor/cce-1' },
];

// Mirrors the electron-builder `files` exclusions for src/bot (tests,
// fixtures, type declarations never ship).
const SKIP_DIRS = new Set(['node_modules', '__fixtures__', 'fixtures', '__tests__', 'tests', 'test']);
const isTestFile = (name) => /\.(test|spec)\.(js|mjs|cjs)$/.test(name);
const isSourceFile = (name) => /\.(js|mjs)$/.test(name) && !name.endsWith('.d.ts') && !isTestFile(name);

const requireBuiltin = createRequire(import.meta.url);
const CONDITIONS = new Set(['node', 'import', 'module-sync', 'default']);

function walkFiles(dir, out) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (!SKIP_DIRS.has(ent.name)) walkFiles(full, out);
    } else if (ent.isFile() && isSourceFile(ent.name)) {
      out.push(full);
    }
  }
  return out;
}

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function exportName(node) {
  // `export { x as "string name" }` uses a Literal.
  return node.type === 'Literal' ? String(node.value) : node.name;
}

function collectPatternNames(pattern, out) {
  if (!pattern) return;
  switch (pattern.type) {
    case 'Identifier':
      out.push(pattern.name);
      break;
    case 'ObjectPattern':
      for (const prop of pattern.properties) collectPatternNames(prop.type === 'RestElement' ? prop.argument : prop.value, out);
      break;
    case 'ArrayPattern':
      for (const el of pattern.elements) collectPatternNames(el, out);
      break;
    case 'RestElement':
      collectPatternNames(pattern.argument, out);
      break;
    case 'AssignmentPattern':
      collectPatternNames(pattern.left, out);
      break;
  }
}

/** Visit every ImportExpression with a string-literal source. */
function findDynamicImports(node, out) {
  if (!node || typeof node.type !== 'string') return;
  if (node.type === 'ImportExpression' && node.source.type === 'Literal' && typeof node.source.value === 'string') {
    out.push({ spec: node.source.value, line: node.loc.start.line });
  }
  for (const key in node) {
    if (key === 'loc') continue;
    const val = node[key];
    if (Array.isArray(val)) {
      for (const child of val) if (child && typeof child.type === 'string') findDynamicImports(child, out);
    } else if (val && typeof val.type === 'string') {
      findDynamicImports(val, out);
    }
  }
}

function attributeType(node) {
  for (const attr of node.attributes ?? []) {
    const key = attr.key.type === 'Identifier' ? attr.key.name : attr.key.value;
    if (key === 'type') return attr.value.value;
  }
  return undefined;
}

/**
 * @param {{ root: string, roots?: {dir: string, boundary: string}[] }} opts
 * @returns {{ errors: string[], stats: { files: number, modules: number, imports: number, cjsUnchecked: number } }}
 */
export function checkEsmLinks({ root, roots = DEFAULT_ROOTS }) {
  root = path.resolve(root);
  const errors = [];
  const stats = { files: 0, modules: 0, imports: 0, cjsUnchecked: 0 };
  const rel = (p) => path.relative(root, p) || p;

  const boundaries = roots.map((r) => path.resolve(root, r.boundary));
  const pkgCache = new Map();
  const moduleCache = new Map();
  const builtinExports = new Map();

  function nearestPackageJson(dir) {
    // Stop at a root boundary: above it, the packaged layout differs (the app
    // package.json is inside app.asar and invisible to unpacked files).
    let cur = dir;
    for (;;) {
      if (pkgCache.has(cur)) return pkgCache.get(cur);
      const candidate = path.join(cur, 'package.json');
      if (isFile(candidate)) {
        const res = { path: candidate, json: readJson(candidate) };
        pkgCache.set(cur, res);
        return res;
      }
      if (boundaries.includes(cur)) {
        pkgCache.set(cur, null);
        return null;
      }
      const parent = path.dirname(cur);
      if (parent === cur) return null;
      cur = parent;
    }
  }

  function formatOf(file) {
    if (file.endsWith('.mjs')) return 'esm';
    if (file.endsWith('.cjs')) return 'cjs';
    if (file.endsWith('.json')) return 'json';
    if (file.endsWith('.node')) return 'native';
    if (!file.endsWith('.js')) return 'unknown';
    const pkg = nearestPackageJson(path.dirname(file));
    const type = pkg?.json.type;
    if (type === 'module') return 'esm';
    if (type === 'commonjs') return 'cjs';
    // No "type": Node's syntax detection treats ESM syntax as ESM.
    const src = readFileSync(file, 'utf8');
    return /^\s*(import\s*[\w{*'"]|export\s)/m.test(src) ? 'esm' : 'cjs';
  }

  /** Parse an ESM file into an export/import record (cached by realpath). */
  function loadModule(file) {
    if (moduleCache.has(file)) return moduleCache.get(file);
    const rec = { file, imports: [], local: new Set(), indirect: new Map(), stars: [], dynamic: [], parseError: null };
    moduleCache.set(file, rec);
    stats.modules++;
    let ast;
    try {
      ast = parse(readFileSync(file, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module', locations: true, allowHashBang: true });
    } catch (err) {
      rec.parseError = err.message;
      return rec;
    }
    const importBindings = new Map();
    for (const node of ast.body) {
      const line = node.loc.start.line;
      if (node.type === 'ImportDeclaration') {
        const names = [];
        for (const s of node.specifiers) {
          if (s.type === 'ImportSpecifier') {
            names.push(exportName(s.imported));
            importBindings.set(s.local.name, { spec: node.source.value, name: exportName(s.imported), line });
          } else if (s.type === 'ImportDefaultSpecifier') {
            names.push('default');
            importBindings.set(s.local.name, { spec: node.source.value, name: 'default', line });
          } else {
            importBindings.set(s.local.name, { spec: node.source.value, name: '*', line });
          }
        }
        rec.imports.push({ spec: node.source.value, names, line, type: attributeType(node) });
      } else if (node.type === 'ExportNamedDeclaration') {
        if (node.source) {
          const names = [];
          for (const s of node.specifiers) {
            const imported = exportName(s.local);
            rec.indirect.set(exportName(s.exported), { spec: node.source.value, name: imported, line });
            names.push(imported);
          }
          rec.imports.push({ spec: node.source.value, names, line, type: attributeType(node) });
        } else if (node.declaration) {
          const d = node.declaration;
          if (d.type === 'VariableDeclaration') {
            const names = [];
            for (const decl of d.declarations) collectPatternNames(decl.id, names);
            names.forEach((n) => rec.local.add(n));
          } else if (d.id) {
            rec.local.add(d.id.name);
          }
        } else {
          for (const s of node.specifiers) {
            // `import { a } from './x.js'; export { a }` is an indirect export (spec).
            const viaImport = importBindings.get(s.local.name);
            if (viaImport) rec.indirect.set(exportName(s.exported), viaImport);
            else rec.local.add(exportName(s.exported));
          }
        }
      } else if (node.type === 'ExportDefaultDeclaration') {
        rec.local.add('default');
      } else if (node.type === 'ExportAllDeclaration') {
        rec.imports.push({ spec: node.source.value, names: [], line, type: attributeType(node) });
        if (node.exported) rec.indirect.set(exportName(node.exported), { spec: node.source.value, name: '*', line });
        else rec.stars.push({ spec: node.source.value, line });
      }
    }
    findDynamicImports(ast, rec.dynamic);
    return rec;
  }

  function packageRoot(name, fromDir) {
    let cur = fromDir;
    for (;;) {
      const candidate = path.join(cur, 'node_modules', name);
      if (isFile(path.join(candidate, 'package.json'))) return candidate;
      const parent = path.dirname(cur);
      if (parent === cur) return null;
      cur = parent;
    }
  }

  function resolveExportsTarget(target, pkgDir, patternMatch) {
    if (typeof target === 'string') {
      const sub = patternMatch == null ? target : target.split('*').join(patternMatch);
      return path.join(pkgDir, sub);
    }
    if (Array.isArray(target)) {
      for (const t of target) {
        const r = resolveExportsTarget(t, pkgDir, patternMatch);
        if (r) return r;
      }
      return null;
    }
    if (target && typeof target === 'object') {
      for (const [cond, t] of Object.entries(target)) {
        if (CONDITIONS.has(cond)) {
          const r = resolveExportsTarget(t, pkgDir, patternMatch);
          if (r) return r;
        }
      }
    }
    return null;
  }

  function resolvePackageExports(exportsField, subpath, pkgDir) {
    const isSubpathMap =
      exportsField && typeof exportsField === 'object' && !Array.isArray(exportsField) && Object.keys(exportsField).some((k) => k.startsWith('.'));
    const map = isSubpathMap ? exportsField : { '.': exportsField };
    if (Object.hasOwn(map, subpath) && !subpath.includes('*')) return resolveExportsTarget(map[subpath], pkgDir, null);
    let best = null;
    for (const key of Object.keys(map)) {
      const star = key.indexOf('*');
      if (star === -1) continue;
      const prefix = key.slice(0, star);
      const suffix = key.slice(star + 1);
      if (subpath.startsWith(prefix) && subpath.endsWith(suffix) && subpath.length >= key.length - 1) {
        if (!best || prefix.length > best.prefix.length) best = { key, prefix, match: subpath.slice(prefix.length, subpath.length - suffix.length) };
      }
    }
    return best ? resolveExportsTarget(map[best.key], pkgDir, best.match) : null;
  }

  /** Resolve a specifier like Node ESM. Returns { kind, file?, name? } or { error }. */
  function resolveSpecifier(spec, fromFile) {
    if (spec.startsWith('node:') || isBuiltin(spec)) return { kind: 'builtin', name: spec.replace(/^node:/, '') };
    if (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/')) {
      const target = path.resolve(path.dirname(fromFile), spec.split(/[?#]/)[0]);
      if (!isFile(target)) {
        const hint = isFile(target + '.js') ? ` (did you mean '${spec}.js'? ESM needs the extension)` : '';
        return { error: `cannot resolve '${spec}': no such file ${rel(target)}${hint}` };
      }
      return { kind: 'file', file: realpathSync(target) };
    }
    if (spec.startsWith('#') || spec.startsWith('file:') || spec.includes(':')) {
      return { kind: 'unchecked' };
    }
    const parts = spec.split('/');
    const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    const subpath = '.' + spec.slice(name.length);
    const pkgDir = packageRoot(name, path.dirname(fromFile));
    if (!pkgDir) return { error: `cannot resolve package '${name}' from ${rel(fromFile)} (not installed?)` };
    const pkg = readJson(path.join(pkgDir, 'package.json'));
    let target;
    if (pkg.exports !== undefined) {
      target = resolvePackageExports(pkg.exports, subpath, pkgDir);
      if (!target) return { error: `'${spec}': subpath '${subpath}' is not exported by ${name} (package.json "exports")` };
    } else if (subpath === '.') {
      const main = pkg.main ? path.join(pkgDir, pkg.main) : path.join(pkgDir, 'index.js');
      // Legacy main resolution still guesses extensions / index files.
      target = [main, main + '.js', main + '.json', main + '.node', path.join(main, 'index.js')].find(isFile) ?? main;
    } else {
      target = path.join(pkgDir, subpath);
    }
    if (!isFile(target)) return { error: `cannot resolve '${spec}': ${rel(target)} does not exist` };
    return { kind: 'file', file: realpathSync(target) };
  }

  function builtinNames(name) {
    if (!builtinExports.has(name)) {
      // Builtins expose their CommonJS exports as named ESM exports plus default.
      // Reading the keys of an already-loaded builtin has no side effects.
      let names = null;
      try {
        const mod = requireBuiltin(name);
        if (mod) names = new Set([...Object.keys(mod), 'default']);
      } catch {
        names = null;
      }
      builtinExports.set(name, names);
    }
    return builtinExports.get(name);
  }

  /**
   * ResolveExport (ECMA-262 16.2.1.6.3). Returns 'found' | 'missing' |
   * 'ambiguous' | 'unchecked', with the binding identity for star dedupe.
   */
  function resolveExport(file, exportNameWanted, seen = new Set()) {
    const key = file + '\0' + exportNameWanted;
    if (seen.has(key)) return { status: 'missing' }; // circular re-export resolves to nothing
    seen.add(key);
    const fmt = formatOf(file);
    if (fmt === 'cjs' || fmt === 'native' || fmt === 'unknown') return { status: 'unchecked' };
    if (fmt === 'json') return exportNameWanted === 'default' ? { status: 'found', id: file } : { status: 'missing' };
    const rec = loadModule(file);
    if (rec.parseError) return { status: 'unchecked' }; // reported separately when the file is a root
    if (rec.local.has(exportNameWanted)) return { status: 'found', id: file + '#' + exportNameWanted };
    const ind = rec.indirect.get(exportNameWanted);
    if (ind) {
      if (ind.name === '*') return { status: 'found', id: file + '#*' + exportNameWanted };
      const r = resolveSpecifier(ind.spec, file);
      if (r.error) return { status: 'unchecked' }; // the re-exporting module reports its own bad specifier
      if (r.kind === 'builtin') {
        const names = builtinNames(r.name);
        if (!names) return { status: 'unchecked' };
        return names.has(ind.name) ? { status: 'found', id: 'node:' + r.name + '#' + ind.name } : { status: 'missing' };
      }
      if (r.kind !== 'file') return { status: 'unchecked' };
      return resolveExport(r.file, ind.name, seen);
    }
    if (exportNameWanted === 'default') return { status: 'missing' };
    let found = null;
    let unchecked = false;
    for (const star of rec.stars) {
      const r = resolveSpecifier(star.spec, file);
      if (r.kind !== 'file') {
        unchecked = true;
        continue;
      }
      const res = resolveExport(r.file, exportNameWanted, seen);
      if (res.status === 'ambiguous') return res;
      if (res.status === 'unchecked') unchecked = true;
      if (res.status === 'found') {
        if (found && found.id !== res.id) return { status: 'ambiguous' };
        found = res;
      }
    }
    if (found) return found;
    return { status: unchecked ? 'unchecked' : 'missing' };
  }

  const files = [];
  for (const r of roots) {
    const dir = path.resolve(root, r.dir);
    if (!existsSync(dir)) {
      errors.push(`${r.dir}: root directory does not exist`);
      continue;
    }
    const boundaryPkg = path.join(path.resolve(root, r.boundary), 'package.json');
    if (!isFile(boundaryPkg) || readJson(boundaryPkg).type !== 'module') {
      errors.push(`${rel(boundaryPkg)}: must exist and declare "type": "module" (Node would load the unpacked .js files as CommonJS)`);
    }
    const shipped = realpathSync(path.resolve(root, r.boundary));
    for (const file of walkFiles(dir, [])) files.push({ file, shipped });
  }

  // A relative import that leaves the shipped tree (src/bot -> src/shared,
  // say) works in dev but points at a file the package does not contain.
  const leavesTree = (spec, r, shipped) =>
    (spec.startsWith('./') || spec.startsWith('../')) && r.kind === 'file' && !r.file.startsWith(shipped + path.sep);

  for (const { file, shipped } of files) {
    stats.files++;
    const where = (line) => `${rel(file)}:${line}`;
    const fmt = formatOf(file);
    if (fmt !== 'esm') {
      errors.push(`${rel(file)}: resolves to ${fmt} format; expected ESM (nearest package.json "type")`);
      continue;
    }
    const rec = loadModule(realpathSync(file));
    if (rec.parseError) {
      errors.push(`${rel(file)}: does not parse as an ES module: ${rec.parseError}`);
      continue;
    }
    for (const imp of rec.imports) {
      stats.imports++;
      const r = resolveSpecifier(imp.spec, file);
      if (r.error) {
        errors.push(`${where(imp.line)}: ${r.error}`);
        continue;
      }
      if (r.kind === 'builtin') {
        const names = builtinNames(r.name);
        if (!names) {
          errors.push(`${where(imp.line)}: '${imp.spec}' is not a Node builtin available here`);
          continue;
        }
        for (const n of imp.names) {
          if (!names.has(n)) errors.push(`${where(imp.line)}: '${imp.spec}' does not provide an export named '${n}'`);
        }
        continue;
      }
      if (r.kind !== 'file') continue;
      if (leavesTree(imp.spec, r, shipped)) {
        errors.push(`${where(imp.line)}: '${imp.spec}' resolves outside the shipped tree (${rel(shipped)}), so the packaged app does not have it`);
        continue;
      }
      const targetFmt = formatOf(r.file);
      if (targetFmt === 'json' && imp.type !== 'json') {
        errors.push(`${where(imp.line)}: '${imp.spec}' is JSON and needs \`with { type: 'json' }\``);
        continue;
      }
      if (targetFmt === 'unknown') {
        errors.push(`${where(imp.line)}: '${imp.spec}' resolves to ${rel(r.file)}, which Node ESM cannot load`);
        continue;
      }
      for (const n of imp.names) {
        const res = resolveExport(r.file, n);
        if (res.status === 'missing') {
          errors.push(`${where(imp.line)}: '${imp.spec}' does not provide an export named '${n}'`);
        } else if (res.status === 'ambiguous') {
          errors.push(`${where(imp.line)}: '${imp.spec}' export '${n}' is ambiguous (conflicting \`export *\`)`);
        } else if (res.status === 'unchecked' && (targetFmt === 'cjs' || targetFmt === 'native')) {
          stats.cjsUnchecked++;
        }
      }
    }
    for (const dyn of rec.dynamic) {
      if (!(dyn.spec.startsWith('./') || dyn.spec.startsWith('../'))) continue;
      const r = resolveSpecifier(dyn.spec, file);
      if (r.error) errors.push(`${where(dyn.line)}: dynamic import() ${r.error}`);
      else if (leavesTree(dyn.spec, r, shipped)) {
        errors.push(`${where(dyn.line)}: dynamic import() '${dyn.spec}' resolves outside the shipped tree (${rel(shipped)})`);
      }
    }
  }

  return { errors, stats };
}
