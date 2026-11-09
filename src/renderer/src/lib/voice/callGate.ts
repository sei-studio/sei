/**
 * Whether a call can dial now, or needs the voice module first (261110).
 * The same check VoiceCallScreen's install gate makes (260705/260725), for
 * surfaces that start a call in place (the WorldLink room editor's Call
 * button): already on the call, or a cloud user without the local fallback
 * (no local model), dials at once; otherwise the ~40 MB module must be on
 * disk, be downloading, or be asked for.
 */
import { sei } from '../ipcClient';
import { useVoiceStore } from '../stores/useVoiceStore';
import { isVoiceModelReady, prefetchInProgress } from './modelPrefetch';
import { sttPolicy } from './sttPolicy';

export type CallGate = 'ready' | 'installing' | 'consent';

export async function callGate(characterId: string): Promise<CallGate> {
  if (useVoiceStore.getState().participants.includes(characterId)) return 'ready';
  const cfg = await sei.getConfig().catch(() => null);
  if (sttPolicy(cfg, cfg?.ai_backend_kind ?? 'cloud-proxy').localModel === 'none') return 'ready';
  if (await isVoiceModelReady()) return 'ready';
  return prefetchInProgress() ? 'installing' : 'consent';
}
