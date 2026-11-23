/**
 * jszip on first use (261123). It is CommonJS and pulls in pako and
 * readable-stream (~70 files), which the main process used to load at launch
 * through static imports of the pack and avatar stores. Every caller unzips
 * inside an async path, so it now loads there instead.
 */
import type JSZip from 'jszip';

let loading: Promise<typeof JSZip> | null = null;

export function loadJSZip(): Promise<typeof JSZip> {
  loading ??= import('jszip').then((m) => ((m as unknown as { default?: typeof JSZip }).default ?? (m as unknown as typeof JSZip)));
  // A failed load is retried on the next call.
  loading.catch(() => {
    loading = null;
  });
  return loading;
}
