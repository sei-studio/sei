/**
 * PNGTuber Remix import with its beta analytics (261122 spike,
 * docs/agents/pngremix-format.md). One `seilink_pngremix_import` event per
 * attempt, shape only: result, a closed failure reason, size and count
 * buckets, the save generation. Never a file name, layer name or state name.
 */
import type { AvatarManifest } from '../../shared/ipc';
import { mbBucket } from '../../shared/avatarLibrary';
import { PngRemixError, type PngRemixErrorCode } from '../../shared/pngremix/pngRemix';
import { capture } from '../analytics';
import { importPngRemix } from './avatarStore';

export type PngRemixImportReason = PngRemixErrorCode | 'store_failed';

/** A count as a coarse bucket (1, 2-5, 6-20, 21-50, 51-100, 100+). */
export function countBucket(n: number): string {
  if (n <= 1) return String(Math.max(0, n));
  if (n <= 5) return '2-5';
  if (n <= 20) return '6-20';
  if (n <= 50) return '21-50';
  if (n <= 100) return '51-100';
  return '100+';
}

/** The model's display name from the picked file's name: its stem, plain text, short. */
export function pngRemixModelName(fileName: string | null): string {
  const base = (fileName ?? '').split(/[\\/]/).pop() ?? '';
  const stem = base
    .replace(/\.pngremix$/i, '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  return stem.slice(0, 60) || 'PNGTuber model';
}

export async function importPngRemixTracked(characterId: string, bytes: Uint8Array, fileName: string | null): Promise<AvatarManifest> {
  const mb = mbBucket(bytes.byteLength);
  try {
    const { manifest, parsed } = await importPngRemix(characterId, bytes, pngRemixModelName(fileName));
    capture('seilink_pngremix_import', {
      result: 'ok',
      mb,
      generation: parsed.spec.source.generation,
      layers: countBucket(parsed.spec.layers.length),
      states: countBucket(parsed.spec.states.length),
      images: countBucket(parsed.spec.images.length),
      skipped_images: countBucket(parsed.skippedImages),
      emotions_mapped: Object.keys(manifest.emotions).length,
      appendages: parsed.spec.layers.some((l) => l.kind === 'appendage'),
    });
    return manifest;
  } catch (err) {
    const reason: PngRemixImportReason = err instanceof PngRemixError ? err.code : 'store_failed';
    capture('seilink_pngremix_import', { result: 'fail', reason, mb });
    throw err;
  }
}
