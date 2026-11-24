/**
 * Summon speed (261124): minecraft-protocol compiles only the types each
 * non-play state can reach (patches/minecraft-protocol+1.68.0.patch,
 * src/transforms/serializer.js `reachableTypes`).
 *
 * Every state used to compile the protocol's whole global `types` section, so
 * the status ping (handshaking + status) and the login and configuration
 * phases each paid for all of play's item and component types, on the
 * summon's critical path. The patch must not change a single packet, so these
 * tests compile each non-play state of every version the bot can join both
 * ways (full, and through the patched module) and require the code generated
 * for every kept type to be identical, with nothing the kept code calls
 * through `ctx` left out.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const nmpRequire = createRequire(require.resolve('minecraft-protocol'));
const { supportedVersions } = require('minecraft-protocol/src/version.js');
const { ProtoDefCompiler } = nmpRequire('protodef').Compiler;
const nbt = nmpRequire('prismarine-nbt');
const merge = nmpRequire('lodash.merge');
const minecraftData = nmpRequire('minecraft-data');
const compilerMinecraft = require('minecraft-protocol/src/datatypes/compiler-minecraft.js');

const SMALL_STATES = ['handshaking', 'status', 'login', 'configuration'];
const PARTS = ['readCompiler', 'writeCompiler', 'sizeOfCompiler'];

/**
 * A fresh instance of the patched serializer module (its compile cache is
 * module-level, and other test files in this worker may have filled it), plus
 * the ProtoDefCompiler each createProtocol call compiled.
 */
function freshSerializer() {
  const id = require.resolve('minecraft-protocol/src/transforms/serializer.js');
  delete require.cache[id];
  const mod = require(id);
  delete require.cache[id];
  return mod;
}

function captureCompiler(fn, onCompile = () => {}) {
  const orig = ProtoDefCompiler.prototype.compileProtoDefSync;
  let captured = null;
  ProtoDefCompiler.prototype.compileProtoDefSync = function (...args) {
    captured = this;
    onCompile(this);
    return orig.apply(this, args);
  };
  try {
    fn();
  } finally {
    ProtoDefCompiler.prototype.compileProtoDefSync = orig;
  }
  return captured;
}

/** The unpatched build: every global type, as createProtocol did before. */
function fullCompiler(version, state, direction) {
  const compiler = new ProtoDefCompiler();
  compiler.addTypes(compilerMinecraft);
  compiler.addProtocol(merge(minecraftData(version).protocol, {}), [state, direction]);
  nbt.addTypesToCompiler('big', compiler);
  return compiler;
}

/**
 * protodef names anonymous container fields `_` + Math.random() base36
 * (compiler-structures.js); number them in order of appearance instead.
 */
function stableAnonNames(code) {
  const names = new Map();
  return code.replace(/\b_[a-z0-9]{1,12}(?=Size\b|\b)/g, (m) => {
    if (!names.has(m)) names.set(m, `_anon${names.size}`);
    return names.get(m);
  });
}

/**
 * Compiler.generate() per type. Each type starts from a fresh scope: generate()
 * shares one scope across types, so local variable suffixes (name1 vs name)
 * depend on which types came before, which says nothing about behavior.
 */
function codeByType(c) {
  const out = {};
  for (const t in c.context) out[t] = c.context[t];
  for (const t in c.types) {
    if (out[t]) continue;
    if (c.types[t] === 'native') { out[t] = `native.${t}`; continue; }
    c.scopeStack = [{}];
    let code = c.compileType(c.types[t]);
    if (code.startsWith('ctx')) code = 'function () { return ' + code + '(...arguments) }';
    if (!isNaN(code)) code = c.wrapCode('  return ' + code);
    out[t] = stableAnonNames(code);
  }
  return out;
}

const jsonTypeCount = (c) => Object.values(c.types).filter((t) => t !== 'native').length;

describe('minecraft-protocol non-play compile keeps only reachable types', () => {
  it('drops unreachable types for login on 1.21.11 and keeps play whole', () => {
    const ser = freshSerializer();
    const login = captureCompiler(() => ser.createDeserializer({ state: 'login', version: '1.21.11' }));
    const loginFull = fullCompiler('1.21.11', 'login', 'toClient');
    expect(login).not.toBeNull();
    expect(jsonTypeCount(login.readCompiler)).toBeLessThan(jsonTypeCount(loginFull.readCompiler) / 4);

    const play = captureCompiler(() => ser.createDeserializer({ state: 'play', version: '1.21.11' }));
    const playFull = fullCompiler('1.21.11', 'play', 'toClient');
    for (const part of PARTS) {
      expect(Object.keys(play[part].types)).toEqual(Object.keys(playFull[part].types));
    }
  });

  it('generates identical code for every kept type, on every version the bot joins', () => {
    const ser = freshSerializer();
    let combos = 0;
    for (const version of supportedVersions) {
      const proto = minecraftData(version).protocol;
      for (const state of SMALL_STATES) {
        if (!proto[state]) continue;
        for (const isServer of [false, true]) {
          // createSerializer compiles the direction this side writes.
          const direction = isServer ? 'toClient' : 'toServer';
          // Read the code before compileProtoDefSync runs: generate() mutates
          // some type definitions as it goes, so compare both sides fresh.
          let got = null;
          const pruned = captureCompiler(
            () => ser.createSerializer({ state, isServer, version }),
            (c) => { got = Object.fromEntries(PARTS.map((part) => [part, codeByType(c[part])])); },
          );
          expect(pruned, `${version} ${state} ${direction} compiled`).not.toBeNull();
          const full = fullCompiler(version, state, direction);
          for (const part of PARTS) {
            const want = codeByType(full[part]);
            const gotPart = got[part];
            const where = `${version} ${state} ${direction} ${part}`;
            expect(gotPart.packet, `${where}: packet`).toBeDefined();
            for (const t of Object.keys(gotPart)) {
              expect(gotPart[t], `${where}: ${t}`).toBe(want[t]);
            }
            const calls = new Set([...Object.values(gotPart).join('\n').matchAll(/ctx\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
            for (const name of calls) {
              if (name in want) expect(name in gotPart, `${where}: ctx.${name} kept`).toBe(true);
            }
          }
          combos++;
        }
      }
    }
    expect(combos).toBeGreaterThan(200);
  }, 120_000);

  it('round-trips login and configuration packets through the patched protocol', () => {
    const ser = freshSerializer();
    const version = '1.21.11';
    const write = (state, name, params) =>
      ser.createSerializer({ state, version }).proto.createPacketBuffer('packet', { name, params });
    const read = (state, buf) =>
      ser.createDeserializer({ state, isServer: true, version }).proto.parsePacketBuffer('packet', buf).data;

    const uuid = '0f7b4c1e-2a3d-4e5f-8a9b-0c1d2e3f4a5b';
    expect(read('login', write('login', 'login_start', { username: 'Sui', playerUUID: uuid }))).toEqual({
      name: 'login_start',
      params: { username: 'Sui', playerUUID: uuid },
    });
    const packs = { packs: [{ namespace: 'minecraft', id: 'core', version: '1.21.11' }] };
    expect(read('configuration', write('configuration', 'select_known_packs', packs))).toEqual({
      name: 'select_known_packs',
      params: packs,
    });
  });
});
