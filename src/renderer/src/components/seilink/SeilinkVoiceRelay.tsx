/**
 * SeilinkVoiceRelay (261110): renders nothing. While the companion on the
 * desktop (WorldLink) talks in a call (TTS in this main window), tells main
 * she is speaking and arms the level tap for her clips, so her mouth moves in
 * her desktop room too (main relays both to the room host). Before this the
 * room only moved her mouth for its own text bubbles.
 */
import { useEffect, useRef } from 'react';
import { useSeilinkStore } from '../../lib/stores/useSeilinkStore';
import { useVoiceStore } from '../../lib/stores/useVoiceStore';
import { setDesktopLevelResident } from '../../lib/voice/avatarLevelTap';
import { desktopResident, residentSpeaking } from '../../lib/seilink/voiceRelay';
import { sei } from '../../lib/ipcClient';

export function SeilinkVoiceRelay(): null {
  const resident = useSeilinkStore((s) => desktopResident(s.status));
  const speakingId = useVoiceStore((s) => s.speakingId);
  const talking = residentSpeaking(resident, speakingId);
  const sent = useRef<{ id: string; speaking: boolean } | null>(null);

  useEffect(() => {
    setDesktopLevelResident(resident);
    return () => setDesktopLevelResident(null);
  }, [resident]);

  useEffect(() => {
    const prev = sent.current;
    // She stopped, or she moved out while talking: close her mouth there.
    if (prev && prev.speaking && (prev.id !== resident || !talking)) {
      sei.seilinkVoice?.(prev.id, false);
      sent.current = { id: prev.id, speaking: false };
    }
    if (resident && talking && !(sent.current?.id === resident && sent.current.speaking)) {
      sei.seilinkVoice?.(resident, true);
      sent.current = { id: resident, speaking: true };
    }
  }, [resident, talking]);

  // Unmounted mid-line (window reload): close her mouth there.
  useEffect(
    () => () => {
      const prev = sent.current;
      if (prev?.speaking) sei.seilinkVoice?.(prev.id, false);
      sent.current = null;
    },
    [],
  );

  return null;
}
