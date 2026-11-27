/**
 * Test 1: can the companion teach a total beginner? The learner is an LLM
 * (lib/learner.ts) role-playing someone who has never played, who only sees
 * what the panel shows (board drawn as text, status line, toasts) and the
 * chat. It opens with a fixed line asking to be taught, then chats and moves
 * on its own. Moves are validated like the panel does (a fired cell / full
 * column cannot be clicked) and re-asked when illegal.
 *
 * Everything on the companion side is real: the services, the board-turn
 * runner, the prompt assembly, the Anthropic provider (BYOK branch, the cloud
 * plan's model). The learner's fleet is a seeded random legal fleet (the
 * Random button).
 *
 * Env: MG_TEACH_GAMES (e.g. "bs:1,bs:2,c4:1,c4:2"), MG_CHAR (Sui),
 * MG_LEARNER_MODEL, MG_TEACH_CAP (learner $ cap per game, default 2.5).
 */
import { describe, it } from 'vitest';
import type { ChatMessage } from '../../src/shared/ipc';
import {
  initBATTLESHIPService,
  startBATTLESHIP,
  placeFleet,
  playerMove as bsPlayerMove,
  retryAiTurn as bsRetry,
  getBATTLESHIPState,
  endBATTLESHIP,
  handlePlayerChat as bsChat,
  __setBattleshipTestHooks,
} from '../../src/main/battleship/battleshipService';
import {
  initCONNECT4Service,
  startCONNECT4,
  playerMove as c4PlayerMove,
  retryAiTurn as c4Retry,
  getCONNECT4State,
  endCONNECT4,
  handlePlayerChat as c4Chat,
  __setConnect4TestHooks,
} from '../../src/main/connect4/connect4Service';
import type { BATTLESHIPPlacement } from '../../src/shared/battleshipIpc';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { Meter, outPath, appendJsonl, characterRow, companionProvider, installGlobals, registerGameCharacter, waitUntil } from './lib/env';
import { enemyWatersText, ownWatersText, parsePlaceFleet, seededFleet, shotMetrics } from './lib/battleship';
import { boardView, checkMoves } from './lib/connect4';
import { Learner } from './lib/learner';

const CHAR = process.env.MG_CHAR || 'Sui';
const GAMES = (process.env.MG_TEACH_GAMES || 'bs:1,bs:2,c4:1,c4:2').split(',').map((g) => {
  const [game, k] = g.split(':');
  return { game: game as 'bs' | 'c4', k: Number(k) };
});
const CAP = Number(process.env.MG_TEACH_CAP || 2.5);
const PLAYER = 'Ren';
const OPENER = "hey, i've never played this before. can you teach me as we go?";
const TURN_WAIT_MS = 6 * 60_000;

type Ev = { ts: number; who: 'player' | 'companion' | 'game' | 'note'; text: string };

const SHIP_LIST = 'carrier (5 cells), battleship (4), cruiser (3), submarine (3), destroyer (2)';

describe(`teach: ${CHAR}`, () => {
  it('plays beginner games', async () => {
    const gl = installGlobals(PLAYER);
    const row = await characterRow(CHAR);
    const meter = new Meter();
    const provider = await companionProvider(meter);
    let events: Ev[] = [];
    let currentId = '';
    let liveFile = '';
    const live = (e: Ev) => {
      if (!liveFile) return;
      try { appendFileSync(liveFile, `${new Date(e.ts).toISOString().slice(11, 19)} ${e.who}: ${e.text}\n`); } catch { /* progress only */ }
    };
    const track = (e: Ev) => { events.push(e); live(e); };
    const pushChatMessage = (characterId: string, msg: ChatMessage) => {
      if (characterId === currentId && msg.role === 'companion') track({ ts: msg.ts ?? Date.now(), who: 'companion', text: msg.text });
    };
    initBATTLESHIPService({ pushState: () => {}, pushChatMessage, isSummoned: () => false });
    initCONNECT4Service({ pushState: () => {}, pushChatMessage, isSummoned: () => false });
    __setBattleshipTestHooks({ provider });
    __setConnect4TestHooks({ provider });
    const name = String(row.name);

    const chatLog = (): string => {
      const lines = events
        .filter((e) => e.who === 'player' || e.who === 'companion' || e.who === 'game')
        .map((e) => (e.who === 'player' ? `You: ${e.text}` : e.who === 'companion' ? `${name}: ${e.text}` : `[screen] ${e.text}`));
      // Keep the chat whole but trim old screen toasts once it grows long.
      const keep = lines.length > 90 ? [...lines.slice(0, 20).filter((l) => !l.startsWith('[screen]')), '…', ...lines.slice(-60)] : lines;
      return keep.join('\n');
    };
    const game = (text: string) => track({ ts: Date.now(), who: 'game', text });

    for (const { game: kind, k } of GAMES) {
      const id = registerGameCharacter(gl, row);
      currentId = id;
      events = [];
      liveFile = outPath('teach', `live-${kind}-${k}.txt`);
      mkdirSync(path.dirname(liveFile), { recursive: true });
      meter.reset();
      gl.captures.length = 0;
      const learner = new Learner(kind, name, PLAYER);
      let learnerIllegal = 0;
      let fallbacks = 0;
      let chats = 0;
      let retryClicks = 0;
      let stuck = false;
      let capped = false;
      const t0 = Date.now();
      const say = async (text: string, send: typeof bsChat) => {
        chats++;
        track({ ts: Date.now(), who: 'player', text });
        const n0 = events.filter((e) => e.who === 'companion').length;
        const res = await send({ characterId: id, text });
        // Replies stream through pushChatMessage; give a late line a moment.
        await meter.idle(1200, 120_000);
        return { res, replied: events.filter((e) => e.who === 'companion').length > n0 };
      };

      if (kind === 'bs') {
        // ── Fleet Battle ────────────────────────────────────────────────
        const fleet: BATTLESHIPPlacement[] = seededFleet(1000 + k);
        await startBATTLESHIP(id, { playerStarts: true });
        game(`Fleet Battle with ${name}. Hide your fleet, then take turns firing.`);
        await say(OPENER, bsChat);
        game('Place your ships. Drag ships onto your waters. Click one to turn it. (You pressed Random.)');
        await placeFleet(id, fleet);
        game('Fleet ready');
        for (;;) {
          const st = await waitUntil(() => {
            const s = getBATTLESHIPState(id)!;
            return s.status === 'active' || s.aiTurnFailed ? s : null;
          }, TURN_WAIT_MS);
          if (!st || st.status === 'active') break;
          if (++retryClicks > 3) { stuck = true; break; }
          await bsRetry(id);
        }
        const aiPlace = [...meter.calls].reverse().find((c) => c.tools.some((t) => t.name === 'place_fleet' && parsePlaceFleet(t.input)));
        const aiFleet = aiPlace ? parsePlaceFleet(aiPlace.tools.find((t) => t.name === 'place_fleet' && parsePlaceFleet(t.input))!.input) : null;

        while (!stuck) {
          const s = getBATTLESHIPState(id)!;
          if (s.status === 'ended') break;
          if (learner.cost > CAP) { capped = true; break; }
          if (s.aiTurnFailed) {
            game('Try again');
            if (++retryClicks > 3) { stuck = true; break; }
            await bsRetry(id);
            continue;
          }
          if (s.turn !== 'player' || s.aiThinking) {
            const ok = await waitUntil(() => {
              const x = getBATTLESHIPState(id)!;
              return x.status === 'ended' || x.aiTurnFailed || (x.turn === 'player' && !x.aiThinking);
            }, TURN_WAIT_MS);
            if (!ok) { stuck = true; break; }
            continue;
          }
          // The player's turn: one optional chat, then a shot.
          let chatted = false;
          let problem = '';
          let move: [number, number] | null = null;
          for (let ask = 0; ask < 4 && !move; ask++) {
            const cur = getBATTLESHIPState(id)!;
            const screen = [
              `SCREEN: Fleet Battle with ${name}. Status: Your turn. Your shots so far: ${cur.playerShots}. ${name}'s shots: ${cur.aiShots}.`,
              `Ships in each fleet: ${SHIP_LIST}.`,
              `Enemy waters (${name}'s board; click a cell to fire). X = hit, # = sunk ship, o = miss, . = not fired at yet:`,
              enemyWatersText(cur),
              `Your fleet (your board). S = your ship, X = your ship got hit, # = your sunk ship, o = ${name} missed here, . = water:`,
              ownWatersText(cur),
              '',
              'Chat and screen messages so far:',
              chatLog(),
            ].join('\n');
            const askText = problem
              ? `${problem} It is your turn: fire at a cell that is still "." in the enemy waters.`
              : chatted
                ? 'You already sent a message this turn and saw the reply. Now fire: give `move`.'
                : 'It is your turn. Send a chat message (no move), or fire with `move`.';
            const nCalls = learner.calls.length;
            const act = await learner.step(screen, askText);
            for (const c of learner.calls.slice(nCalls)) if (c.raw) live({ ts: Date.now(), who: 'note', text: `(learner call failed: ${c.raw})` });
            if (!act) break;
            track({ ts: Date.now(), who: 'note', text: `${act.note}${act.move ? ` [move ${act.move}]` : ''}${act.chat ? ' [chat]' : ''}` });
            if (act.chat && !chatted) {
              chatted = true;
              problem = '';
              await say(act.chat, bsChat);
              if (getBATTLESHIPState(id)!.status === 'ended') break;
              continue;
            }
            if (!act.move) { problem = 'You did not fire.'; continue; }
            const m = /^\s*([A-Ja-j])\s*-?\s*(10|[1-9])\s*$/.exec(act.move);
            if (!m) { learnerIllegal++; problem = `"${act.move}" is not a cell on the board (use a row letter A-J and a column 1-10, like D4).`; continue; }
            const r = m[1].toUpperCase().charCodeAt(0) - 65;
            const c = Number(m[2]) - 1;
            if (cur.aiVisibleGrid.cells[r][c] !== 'empty') { learnerIllegal++; problem = `Already fired at ${act.move.toUpperCase()}.`; continue; }
            move = [r, c];
          }
          if (!move) {
            // Fallback so the game can finish: first unknown cell (logged).
            fallbacks++;
            const cur = getBATTLESHIPState(id)!;
            outer: for (let r = 0; r < 10; r++) for (let c = 0; c < 10; c++) if (cur.aiVisibleGrid.cells[r][c] === 'empty') { move = [r, c]; break outer; }
          }
          const [r, c] = move!;
          const res = await bsPlayerMove(id, r, c);
          if (!res.ok) { learnerIllegal++; continue; }
          const last = res.state.history[res.state.history.length - 1];
          const cell = `${String.fromCharCode(65 + r)}${c + 1}`;
          game(`You fired at ${cell}: ${last?.sunkShip ? `You sank their ${last.sunkShip}` : last?.hit ? 'Hit' : 'Miss'}`);
          if (res.state.status === 'ended') break;
          const done = await waitUntil(() => {
            const x = getBATTLESHIPState(id)!;
            return x.status === 'ended' || x.aiTurnFailed || (x.turn === 'player' && !x.aiThinking) ? x : null;
          }, TURN_WAIT_MS);
          if (!done) { stuck = true; break; }
          const ai = [...done.history].reverse().find((h) => h.by === 'ai');
          if (ai && done.history.length > res.state.history.length) {
            game(ai.sunkShip ? `${name} sank your ${ai.sunkShip}` : ai.hit ? `${name} hit your fleet` : `${name} missed`);
          }
        }
        await meter.idle(1500, 90_000);
        const fin = getBATTLESHIPState(id)!;
        if (fin.status === 'ended') game(fin.result?.winner === 'player' ? 'You won' : `${name} won. ${name} sank your whole fleet.`);
        const ended = gl.captures.find((c) => c.event === 'battleship_game_ended')?.props ?? {};
        if (fin.status !== 'ended') await endBATTLESHIP(id);
        const pm = aiFleet ? shotMetrics(fin.history, 'player', aiFleet) : null;
        // Learner improvement: follow-up rate over its first vs second half of shots.
        const half = (which: 0 | 1) => {
          if (!aiFleet) return null;
          const cut = Math.floor(fin.history.filter((h) => h.by === 'player').length / 2);
          let n = 0;
          const prefix = fin.history.filter((h) => h.by === 'ai' || ++n <= cut);
          const first = shotMetrics(prefix, 'player', aiFleet);
          if (which === 0) return { openHitShots: first.openHitShots, followUps: first.followUps };
          const all = shotMetrics(fin.history, 'player', aiFleet);
          return { openHitShots: all.openHitShots - first.openHitShots, followUps: all.followUps - first.followUps };
        };
        const am = shotMetrics(fin.history, 'ai', fleet);
        const out = {
          test: 'teach',
          game: 'bs',
          k,
          character: CHAR,
          learnerModel: process.env.MG_LEARNER_MODEL || 'claude-opus-5-5',
          winner: fin.result?.winner ?? null,
          finished: fin.status === 'ended' && !!fin.result?.winner,
          stuck,
          capped,
          playerShots: fin.playerShots,
          aiShots: fin.aiShots,
          learner: pm && { hitRate: pm.hitRate, followUpRate: pm.followUpRate, openHitShots: pm.openHitShots, followUps: pm.followUps, firstHalf: half(0), secondHalf: half(1) },
          ai: { hitRate: am.hitRate, followUpRate: am.followUpRate },
          learnerIllegal,
          fallbacks,
          chats,
          aiIllegal: ended.illegal_moves ?? null,
          aiRetries: ended.retries ?? null,
          aiFailedTurns: ended.failed_turns ?? null,
          retryClicks,
          gameMs: Date.now() - t0,
          companionCost: meter.cost,
          learnerCost: learner.cost,
          learnerCalls: learner.calls.map((c) => ({ model: c.model, ms: c.ms, cost: c.cost, raw: c.raw, ok: !!c.act })),
          companionCalls: meter.calls.map((c) => ({ kind: c.kind, ms: c.ms, stop: c.stopReason, text: c.text.slice(0, 600), tools: c.tools, error: c.error })),
          aiFleet,
          playerFleet: fleet,
          history: fin.history,
          events,
        };
        appendJsonl('teach/games.jsonl', out);
        appendJsonl('spend.jsonl', { test: 'teach', game: 'bs', k, companion: meter.cost, learner: learner.cost });
        console.log(`[mg-eval] teach bs k=${k} winner=${out.winner} shots=${fin.playerShots}/${fin.aiShots} follow=${pm?.followUpRate?.toFixed(2)} chats=${chats} illegal=${learnerIllegal} fb=${fallbacks} stuck=${stuck} cost=$${meter.cost.toFixed(3)}+$${learner.cost.toFixed(3)}`);
      } else {
        // ── Four in a Row ───────────────────────────────────────────────
        const playerColor = k % 2 === 1 ? 'r' : 'y';
        const colorName = playerColor === 'r' ? 'red' : 'yellow';
        await startCONNECT4(id, { playerColor });
        game(`Four in a Row with ${name}. You picked ${colorName} (red moves first).`);
        await say(OPENER, c4Chat);
        let lastLen = 0;
        while (!stuck) {
          const s = getCONNECT4State(id)!;
          if (s.status === 'ended') break;
          if (learner.cost > CAP) { capped = true; break; }
          if (s.aiTurnFailed) {
            game('Try again');
            if (++retryClicks > 3) { stuck = true; break; }
            await c4Retry(id);
            continue;
          }
          if (s.turn !== s.playerColor || s.aiThinking) {
            const ok = await waitUntil(() => {
              const x = getCONNECT4State(id)!;
              return x.status === 'ended' || x.aiTurnFailed || (x.turn === x.playerColor && !x.aiThinking);
            }, TURN_WAIT_MS);
            if (!ok) { stuck = true; break; }
            continue;
          }
          const nowLen = s.history.length;
          for (const h of s.history.slice(lastLen)) if (h.color !== playerColor) game(`${name}'s disc dropped into column ${h.column + 1}.`);
          lastLen = nowLen;
          let chatted = false;
          let problem = '';
          let col: number | null = null;
          for (let ask = 0; ask < 4 && col === null; ask++) {
            const cur = getCONNECT4State(id)!;
            const screen = [
              `SCREEN: Four in a Row with ${name}. You are ${colorName} (${playerColor === 'r' ? 'R' : 'Y'}), ${name} is ${playerColor === 'r' ? 'yellow (Y)' : 'red (R)'}. Status: Your turn.`,
              'Board (top row first; . = empty; discs fall to the lowest empty space of a column):',
              boardView(cur),
              '',
              'Chat and screen messages so far:',
              chatLog(),
            ].join('\n');
            const askText = problem
              ? `${problem} It is your turn: pick a column 1-7 that is not full.`
              : chatted
                ? 'You already sent a message this turn and saw the reply. Now drop a disc: give `move`.'
                : 'It is your turn. Send a chat message (no move), or drop a disc with `move` (column 1-7).';
            const nCalls = learner.calls.length;
            const act = await learner.step(screen, askText);
            for (const c of learner.calls.slice(nCalls)) if (c.raw) live({ ts: Date.now(), who: 'note', text: `(learner call failed: ${c.raw})` });
            if (!act) break;
            track({ ts: Date.now(), who: 'note', text: `${act.note}${act.move ? ` [move ${act.move}]` : ''}${act.chat ? ' [chat]' : ''}` });
            if (act.chat && !chatted) {
              chatted = true;
              problem = '';
              await say(act.chat, c4Chat);
              if (getCONNECT4State(id)!.status === 'ended') break;
              continue;
            }
            if (!act.move) { problem = 'You did not drop a disc.'; continue; }
            const n = Number(/\d+/.exec(act.move)?.[0]);
            if (!(n >= 1 && n <= 7)) { learnerIllegal++; problem = `"${act.move}" is not a column.`; continue; }
            if (cur.board[0][n - 1] !== null) { learnerIllegal++; problem = `Column ${n} is full.`; continue; }
            col = n - 1;
          }
          if (col === null) {
            fallbacks++;
            const cur = getCONNECT4State(id)!;
            col = [3, 2, 4, 1, 5, 0, 6].find((c) => cur.board[0][c] === null)!;
          }
          const res = await c4PlayerMove(id, col);
          if (!res.ok) { learnerIllegal++; continue; }
          game(`Your disc dropped into column ${col + 1}.`);
          lastLen = res.state.history.length;
          if (res.state.status === 'ended') break;
        }
        await meter.idle(1500, 90_000);
        const fin = getCONNECT4State(id)!;
        for (const h of fin.history.slice(lastLen)) if (h.color !== playerColor) game(`${name}'s disc dropped into column ${h.column + 1}.`);
        if (fin.status === 'ended') game(fin.result?.winner === playerColor ? 'You won. Four in a row.' : fin.result?.winner ? `${name} won. Four in a row.` : 'Draw. The board is full.');
        const ended = gl.captures.find((c) => c.event === 'connect4_game_ended')?.props ?? {};
        if (fin.status !== 'ended') await endCONNECT4(id);
        const aiColor = playerColor === 'r' ? 'y' : 'r';
        const lc = checkMoves(fin.history, playerColor);
        const ac = checkMoves(fin.history, aiColor);
        const out = {
          test: 'teach',
          game: 'c4',
          k,
          character: CHAR,
          learnerModel: process.env.MG_LEARNER_MODEL || 'claude-opus-5-5',
          playerColor,
          winner: fin.result?.winner === playerColor ? 'player' : fin.result?.winner ? 'ai' : fin.status === 'ended' ? 'draw' : null,
          finished: fin.status === 'ended',
          stuck,
          capped,
          plies: fin.moves,
          learner: {
            missedWins: lc.filter((c) => c.missedWin).length,
            missedBlocks: lc.filter((c) => c.missedBlock).length,
            blocksNeeded: lc.filter((c) => c.blockNeeded).length,
            gaveWins: lc.filter((c) => c.gaveWin).length,
            checks: lc,
          },
          ai: { missedWins: ac.filter((c) => c.missedWin).length, missedBlocks: ac.filter((c) => c.missedBlock).length, gaveWins: ac.filter((c) => c.gaveWin).length },
          learnerIllegal,
          fallbacks,
          chats,
          aiIllegal: ended.illegal_moves ?? null,
          aiRetries: ended.retries ?? null,
          aiFailedTurns: ended.failed_turns ?? null,
          retryClicks,
          gameMs: Date.now() - t0,
          companionCost: meter.cost,
          learnerCost: learner.cost,
          learnerCalls: learner.calls.map((c) => ({ model: c.model, ms: c.ms, cost: c.cost, raw: c.raw, ok: !!c.act })),
          companionCalls: meter.calls.map((c) => ({ kind: c.kind, ms: c.ms, stop: c.stopReason, text: c.text.slice(0, 600), tools: c.tools, error: c.error })),
          history: fin.history,
          events,
        };
        appendJsonl('teach/games.jsonl', out);
        appendJsonl('spend.jsonl', { test: 'teach', game: 'c4', k, companion: meter.cost, learner: learner.cost });
        console.log(`[mg-eval] teach c4 k=${k} ${playerColor} winner=${out.winner} plies=${fin.moves} missedBlock=${out.learner.missedBlocks} chats=${chats} illegal=${learnerIllegal} fb=${fallbacks} stuck=${stuck} cost=$${meter.cost.toFixed(3)}+$${learner.cost.toFixed(3)}`);
      }
    }
  });
});
