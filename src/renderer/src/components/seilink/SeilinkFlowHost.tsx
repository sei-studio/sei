/**
 * SeilinkFlowHost (261105, T337): the one place the SeiLink surfaces render.
 *
 * Mounted once by App.tsx. It shows whatever useSeilinkStore holds:
 *  - `flow`: the move-in sheet or the room editor, opened by any entry point
 *    (the chat top bar's SeiLink button, the companion page's gear menu, the
 *    dock, the guide's tour; lib/seilink/seilinkFlow.ts);
 *  - `intro`: the first-link intro (FirstLinkIntro), over everything, while
 *    the host starts.
 * All three are lazy chunks: nothing loads until someone opens SeiLink.
 */
import React, { Suspense, lazy } from 'react';
import { movedInId, useSeilinkStore } from '../../lib/stores/useSeilinkStore';
import { useDataStore } from '../../lib/stores/useDataStore';

const CompanionRoomEditor = lazy(() => import('./CompanionRoomEditor'));
const MoveInSheet = lazy(() => import('./MoveInSheet'));
const FirstLinkIntro = lazy(() => import('./intro/FirstLinkIntro'));

export function SeilinkFlowHost(): React.ReactElement | null {
  const flow = useSeilinkStore((s) => s.flow);
  const intro = useSeilinkStore((s) => s.intro);
  const livingId = useSeilinkStore((s) => movedInId(s.status));
  const characters = useDataStore((s) => s.characters);
  const closeFlow = useSeilinkStore((s) => s.closeFlow);
  const endIntro = useSeilinkStore((s) => s.endIntro);
  if (!flow && !intro) return null;
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
        <CompanionRoomEditor key={flow.characterId} characterId={flow.characterId} openedFrom={flow.openedFrom} onClose={closeFlow} />
      ) : null}
      {intro ? <FirstLinkIntro key={intro.seq} request={intro} onDone={() => endIntro(intro.seq)} /> : null}
    </Suspense>
  );
}
