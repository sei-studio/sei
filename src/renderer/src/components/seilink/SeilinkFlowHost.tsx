/**
 * SeilinkFlowHost (261105, T337): the one place the SeiLink surfaces render.
 *
 * Mounted once by App.tsx. It shows whatever useSeilinkStore holds:
 *  - `flow`: the move-in sheet or the room editor, opened by any entry point
 *    (the chat top bar's SeiLink button, the companion page's gear menu, the
 *    dock, the guide's tour, 261106 the dock's decorate offer;
 *    lib/seilink/seilinkFlow.ts). The editor opens on the desktop for the
 *    companion who lives there (`desktop`);
 *  - `intro`: the first-link intro (FirstLinkIntro), over everything, while
 *    the host starts;
 *  - `liveHint` (261110): the "lives on your desktop" card after a move-in
 *    without the intro (LiveCard); a fresh move-in steps aside once it is
 *    dismissed.
 * All three are lazy chunks: nothing loads until someone opens SeiLink.
 */
import React, { Suspense, lazy } from 'react';
import { movedInId, useSeilinkStore } from '../../lib/stores/useSeilinkStore';
import { useDataStore } from '../../lib/stores/useDataStore';
import { revealAndOffer } from '../../lib/seilink/seilinkFlow';
import { sei } from '../../lib/ipcClient';

const CompanionRoomEditor = lazy(() => import('./CompanionRoomEditor'));
const MoveInSheet = lazy(() => import('./MoveInSheet'));
const FirstLinkIntro = lazy(() => import('./intro/FirstLinkIntro'));
const LiveCard = lazy(() => import('./LiveCard').then((m) => ({ default: m.LiveCard })));

export function SeilinkFlowHost(): React.ReactElement | null {
  const flow = useSeilinkStore((s) => s.flow);
  const intro = useSeilinkStore((s) => s.intro);
  const livingId = useSeilinkStore((s) => movedInId(s.status));
  const characters = useDataStore((s) => s.characters);
  const closeFlow = useSeilinkStore((s) => s.closeFlow);
  const endIntro = useSeilinkStore((s) => s.endIntro);
  const liveHint = useSeilinkStore((s) => s.liveHint);
  const endLiveHint = useSeilinkStore((s) => s.endLiveHint);
  if (!flow && !intro && !liveHint) return null;
  const nameOf = (id: string): string | null => characters.find((c) => c.id === id)?.name ?? null;
  return (
    <Suspense fallback={null}>
      {flow?.kind === 'sheet' ? (
        <MoveInSheet
          key={`${flow.characterId}:${flow.reason}`}
          characterId={flow.characterId}
          name={nameOf(flow.characterId) ?? ''}
          otherName={livingId && livingId !== flow.characterId ? nameOf(livingId) : null}
          reason={flow.reason}
          entry={flow.entry}
          onClose={closeFlow}
        />
      ) : null}
      {flow?.kind === 'editor' ? (
        <CompanionRoomEditor
          key={`${flow.characterId}:${flow.desktop ? 'desktop' : 'app'}`}
          characterId={flow.characterId}
          openedFrom={flow.openedFrom}
          desktop={flow.desktop === true}
          onClose={closeFlow}
        />
      ) : null}
      {intro ? <FirstLinkIntro key={intro.seq} request={intro} onDone={() => endIntro(intro.seq)} /> : null}
      {liveHint && !intro ? (
        <LiveCard
          key={liveHint.characterId}
          characterId={liveHint.characterId}
          name={nameOf(liveHint.characterId) ?? ''}
          surface="app_window"
          onDone={(end) => {
            endLiveHint();
            // A fresh move-in steps aside onto her (the window is already hidden after a Win+D).
            if (liveHint.fresh) void revealAndOffer(liveHint.characterId, 'move_in');
            else if (end === 'minimized') void sei.seilinkStage?.({ action: 'reveal', purpose: 'move_in', characterId: liveHint.characterId }).catch(() => null);
          }}
        />
      ) : null}
    </Suspense>
  );
}
