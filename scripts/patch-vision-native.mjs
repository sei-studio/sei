#!/usr/bin/env node
// scripts/patch-vision-native.mjs
//
// Phase 15 (in-game vision) — source patches that let the headless render path's native
// deps build against Electron 42's ABI. Idempotent; safe to run on every install.
//
// MUST run BEFORE `electron-builder install-app-deps` (which compiles gl from source) —
// otherwise install-app-deps fails on the unpatched gl. See 15-RESEARCH.md Pitfall 1 and
// scripts/rebuild-vision-native.mjs for the full rationale.
//
// Patches (see rebuild-vision-native.mjs header for the deep "why"):
//   1. gl/binding.gyp: c++17 -> c++20 (Electron 42 V8 headers use C++20 concepts) + bump
//      MACOSX_DEPLOYMENT_TARGET 10.8 -> 10.15.
//   2. nan External::New / External::Value: append V8's kExternalPointerTypeTagDefault, which
//      Electron 42's V8 made a REQUIRED arg and nan (<=2.27.0) has not adopted.
//
// `canvas` needs NO patch — package.json `overrides` force canvas@^3 (N-API, ABI-stable).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TAG = 'v8::kExternalPointerTypeTagDefault';

const log = (m) => console.log(`[patch-vision-native] ${m}`);

export function patchGlGyp() {
  const f = join(root, 'node_modules/gl/binding.gyp');
  if (!existsSync(f)) return log('gl not installed — skipping gyp patch');
  let s = readFileSync(f, 'utf8');
  let changed = false;
  if (s.includes("'CLANG_CXX_LANGUAGE_STANDARD':'c++17'")) {
    s = s.replace("'CLANG_CXX_LANGUAGE_STANDARD':'c++17'", "'CLANG_CXX_LANGUAGE_STANDARD':'c++20'");
    changed = true;
  }
  if (s.includes("'MACOSX_DEPLOYMENT_TARGET':'10.8'")) {
    s = s.replace("'MACOSX_DEPLOYMENT_TARGET':'10.8'", "'MACOSX_DEPLOYMENT_TARGET':'10.15'");
    changed = true;
  }
  // Windows/MSVC: Electron 42's V8 headers use C++20 (concepts). The stock win block
  // sets no /std, so MSVC defaults below C++20 and the gl compile fails. Append /std:c++20
  // to the Release VCCLCompilerTool AdditionalOptions (the mac branch above is clang-only).
  if (s.includes("'/MP', # compile across multiple CPUs") && !s.includes("'/std:c++20'")) {
    s = s.replace(
      "'/MP', # compile across multiple CPUs",
      "'/MP', # compile across multiple CPUs\n                      '/std:c++20', # Electron 42 V8 headers require C++20 (concepts)",
    );
    changed = true;
  }
  if (changed) { writeFileSync(f, s); log('patched gl/binding.gyp (c++20 + deployment target)'); }
  else log('gl/binding.gyp already patched');
}

export function patchNanNew() {
  const f = join(root, 'node_modules/nan/nan_implementation_12_inl.h');
  if (!existsSync(f)) return log('nan not installed — skipping External::New patch');
  let s = readFileSync(f, 'utf8');
  if (s.includes(TAG)) return log('nan External::New already patched');
  const NEEDLE = 'v8::External::New(';
  let out = '', i = 0, count = 0;
  while (i < s.length) {
    const m = s.indexOf(NEEDLE, i);
    if (m === -1) { out += s.slice(i); break; }
    out += s.slice(i, m);
    let j = m + NEEDLE.length, depth = 1, k = j;
    while (k < s.length && depth > 0) {
      const ch = s[k];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      k++;
    }
    out += `${NEEDLE}${s.slice(j, k - 1)}, ${TAG})`;
    count++;
    i = k;
  }
  writeFileSync(f, out);
  log(`patched ${count} nan External::New call site(s)`);
}

export function patchNanValue() {
  const f = join(root, 'node_modules/nan/nan_callbacks_12_inl.h');
  if (!existsSync(f)) return log('nan not installed — skipping External::Value patch');
  let s = readFileSync(f, 'utf8');
  const OLD = 'As<v8::External>()->Value()';
  const NEW = `As<v8::External>()->Value(${TAG})`;
  if (!s.includes(OLD)) return log('nan External::Value already patched (or call shape changed)');
  const count = s.split(OLD).length - 1;
  writeFileSync(f, s.split(OLD).join(NEW));
  log(`patched ${count} nan External::Value read site(s)`);
}

export function applyAll() {
  patchGlGyp();
  patchNanNew();
  patchNanValue();
}

// Run directly (postinstall step 1)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  applyAll();
}
