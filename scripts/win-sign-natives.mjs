// electron-builder afterPack hook: sign the Windows app's unsigned native
// modules with our Trusted Signing cert (261118).
//
// Why: Smart App Control blocks any DLL or .node file with no signature and
// no cloud reputation, and until now the build signed only .exe files. A
// Windows 11 user with SAC on got CodeIntegrity 3077 events for
// sherpa-onnx-c-api.dll and lost every local voice (and SenseVoice). The same
// gap covered sharp, velopack's node addon, the WorldLink addon and Electron's
// own ffmpeg/ANGLE/Vulkan DLLs. See scripts/lib/peSignature.mjs.
//
// What: walk the packaged app (release/win-unpacked), list every .dll and
// .node, and sign the ones that carry NO signature through
// `packager.signIf`, which is electron-builder's own Azure Trusted Signing
// path (same credentials, retries and queue as Sei.exe). Files that already
// have a signature are left alone: Microsoft's onnxruntime.dll, dxil.dll and
// d3dcompiler_47.dll keep Microsoft's signature (win.signExts would re-sign
// them, and would cost one signing request per match).
//
// It runs after the app is copied and before electron-builder signs the .exe
// files and builds the installer, so the NSIS installer and the
// win-unpacked folder Velopack packs (scripts/velopack-pack.mjs, which
// excludes .dll/.node from vpk's own signing) both carry the signed files.
//
// Unsigned builds (dry runs, local `npm run dist:win`, forks without the
// Azure secrets) only log the list. A signed build fails if any native is
// still unsigned afterwards, so a broken signing run cannot ship half-signed.
import { unsignedNatives } from './lib/peSignature.mjs';

/** The decision for one pack, split out for the unit test. */
export function signPlan(context) {
  if (context.electronPlatformName !== 'win32') return { kind: 'skip' };
  const azure = context.packager?.platformSpecificBuildOptions?.azureSignOptions;
  return { kind: azure ? 'sign' : 'log' };
}

export default async function winSignNatives(context) {
  const plan = signPlan(context);
  if (plan.kind === 'skip') return;
  const root = context.appOutDir;
  const todo = unsignedNatives(root);
  const tag = '[win-sign-natives]';
  if (todo.length === 0) {
    console.log(`${tag} no unsigned .dll/.node under ${root}`);
    return;
  }
  const list = todo.map((n) => `  ${n.rel} (${n.bytes} bytes)`).join('\n');
  if (plan.kind === 'log') {
    console.log(`${tag} signing not configured; ${todo.length} native file(s) ship UNSIGNED:\n${list}`);
    return;
  }
  console.log(`${tag} signing ${todo.length} unsigned native file(s):\n${list}`);
  const started = Date.now();
  // signIf queues on electron-builder's signing queue (one at a time) and
  // rejects when a file fails. Wait for all of them, then check the result
  // on disk rather than trusting the return values.
  const results = await Promise.allSettled(todo.map((n) => context.packager.signIf(n.file)));
  const failed = results
    .map((r, i) => (r.status === 'rejected' ? `${todo[i].rel}: ${r.reason?.message ?? r.reason}` : null))
    .filter(Boolean);
  const still = unsignedNatives(root);
  if (failed.length || still.length) {
    throw new Error(
      `${tag} ${still.length} native file(s) still unsigned after signing` +
        (still.length ? `:\n${still.map((n) => `  ${n.rel}`).join('\n')}` : '') +
        (failed.length ? `\nerrors:\n  ${failed.join('\n  ')}` : ''),
    );
  }
  console.log(`${tag} signed ${todo.length} file(s) in ${Math.round((Date.now() - started) / 1000)}s`);
}
