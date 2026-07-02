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
//   3. nan TypedArrayContents: swap buffer->GetBackingStore()->Data() for buffer->Data().
//      Electron 42's V8 (v13) dropped the GetBackingStore() export; strict linkers (Windows
//      MSVC) fail with LNK2019. ArrayBuffer::Data() (V8 11.4+) is the exported replacement.
//
// `canvas` needs NO patch — package.json `overrides` force canvas@^3 (N-API, ABI-stable).

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
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

// Windows/MSVC: Electron 42's V8/cppgc headers (e.g. cppgc/heap.h) use the
// GCC/Clang builtin __builtin_frame_address, which MSVC does not provide
// (error C3861). gl compiles against these headers, so we inject a guarded shim
// that maps it to MSVC's _AddressOfReturnAddress intrinsic. clang/gcc are
// excluded so the real builtin is used on mac/linux. Pass the path to the
// downloaded Electron headers (<devdir>/<version>/include/node) — they must
// already be fetched (see postinstall's Windows pre-fetch step).
const V8_MSVC_SHIM = `// [sei] MSVC shim for GCC/Clang __builtin_frame_address (Electron V8 headers, C3861).
#if defined(_MSC_VER) && !defined(__clang__) && !defined(__GNUC__)
#include <intrin.h>
#ifndef __builtin_frame_address
#define __builtin_frame_address(x) _AddressOfReturnAddress()
#endif
#endif
`;
const V8_SHIM_MARKER = '[sei] MSVC shim for GCC/Clang';

export function patchV8MsvcBuiltins(includeNodeDir) {
  if (process.platform !== 'win32') return; // clang/gcc already have the builtin
  if (!includeNodeDir || !existsSync(includeNodeDir)) {
    return log(`electron headers not at ${includeNodeDir} — skipping V8 MSVC shim`);
  }
  let patched = 0, scanned = 0;
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { walk(p); continue; }
      if (!/\.(h|hpp|inc)$/.test(name)) continue;
      scanned++;
      const s = readFileSync(p, 'utf8');
      if (!s.includes('__builtin_frame_address') || s.includes(V8_SHIM_MARKER)) continue;
      writeFileSync(p, V8_MSVC_SHIM + s);
      patched++;
    }
  };
  walk(includeNodeDir);
  log(`V8 MSVC shim: patched ${patched} header(s) using __builtin_frame_address (scanned ${scanned})`);
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

// nan's TypedArrayContents reads the ArrayBuffer data pointer via
// `buffer->GetBackingStore()->Data()`. Electron 42's V8 (v13) still DECLARES
// ArrayBuffer::GetBackingStore() in the headers (so it compiles) but no longer
// EXPORTS it from the V8 lib — a strict linker (Windows MSVC) then fails with
// LNK2019. macOS hides this behind dynamic_lookup, which is why the mac CI
// missed it. The modern, exported replacement is ArrayBuffer::Data() (V8 11.4+).
export function patchNanTypedArrayContents() {
  const f = join(root, 'node_modules/nan/nan_typedarray_contents.h');
  if (!existsSync(f)) return log('nan not installed — skipping TypedArrayContents patch');
  let s = readFileSync(f, 'utf8');
  const OLD = 'buffer->GetBackingStore()->Data()';
  const NEW = 'buffer->Data()';
  if (!s.includes(OLD)) return log('nan TypedArrayContents already patched (or call shape changed)');
  const count = s.split(OLD).length - 1;
  writeFileSync(f, s.split(OLD).join(NEW));
  log(`patched ${count} nan TypedArrayContents GetBackingStore site(s)`);
}

export function applyAll() {
  patchGlGyp();
  patchNanNew();
  patchNanValue();
  patchNanTypedArrayContents();
}

// Run directly (postinstall step 1)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  applyAll();
}
