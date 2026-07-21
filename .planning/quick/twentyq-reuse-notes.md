# 20 Questions reuse notes — the party-tier probe (260720)

20 Questions is game #4 (built alongside connect4 game #3 and the watch
activity), deliberately the PARTY-TIER template: pure conversation, no board,
no engine, no presentation hold. This file records only what is NEW relative
to .planning/quick/connect4-reuse-notes.md; everything that document says
about the shared 70 percent still holds.

## What was reused vs re-cloned

Copied nearly verbatim from connect4Service.ts: the session map, deps
injection, FSM queue construction (P1 chat coalescing via chatBuffer, P3 idle
with silent-streak backoff, onPreempt aborting idle turns only), the
`turnSeq`/`turnCtrl` stale-turn plumbing, `describeErr`/`isConnectionError`,
`flushChatBuffer`, `sampleIdleDelayMs`, the connection-error single retry, the
endSession transcript event + MEMORY.md line, and the whole
system-blocks/toMessages/markLastMessageCached turn scaffolding. The renderer
store is the useConnect4Store clone minus the reveal/ack machinery; the panel
CSS is the Connect4Panel clone minus the board sections. Wiring (shared
channels, preload members, IPC handlers, games.ts, picker/about branches,
ChatScreen aside, summon guard) is the same 8-site boilerplate, now with only
4 invoke channels (start/getState/newRound/end) instead of connect4's 7.

New files with no counterpart: rules.ts (the pure round machine; connect4's
rules.ts is board math, this one is phase/slot bookkeeping) and secret.ts
(per-round secret pick; the chessProfile SHAPE with no persistence).

Deliberately NOT cloned: the presentation hold (HoldState, prethink sampler,
cap timers, wait()/revision semantics, ackReveal), the candidate engine, the
reveal-gating hook, the per-character game profile (persona already rides the
system blocks; there is no strength knob to fix), and the pendingAiMove state.

## New SDK learnings beyond connect4's

1. **The adapter boundary survives losing the board.** TurnGameAdapter (notes
   §B1) assumed applyPlayerMove/applyAiMove/candidates. A conversation game
   voids all three; what remains universal is exactly: session map + FSM queue
   + chatBuffer coalescing + idle cadence + turn scaffolding + endSession.
   That smaller core is the real SDK seed; the move/hold pipeline should be an
   OPTIONAL board-game layer on top of it, not the core itself.

2. **Sessions and rounds are different lifetimes.** Chess/connect4 conflate
   "game" and "session" (rematch tears down and restarts). The party template
   needs rounds INSIDE a session (running score, result banner + new_round
   without closing the panel, transcript/memory once at session end). If the
   SDK core owns endSession, it must also own a round sub-lifecycle or games
   will hand-roll it.

3. **Canonical tool-line delivery beats text-only speech.** The counted
   question/guess/answer rides the tool input and the SERVICE pushes it as
   the chat line (model plain text is only banter, told not to repeat the
   line). This makes the countable game moves deterministic and testable and
   removes the "model spoke a question but never called the tool" divergence.
   Connect4 never needed this because the move is not a chat line. Candidate
   SDK helper: `speakLine()` (one bubble, no splitReply) next to `speak()`.

4. **Deterministic endings need a "ball location" bit.** The one subtle piece
   of state is `awaitingReply`: slot 20 must not end the round until the
   player has answered the question that spent it, and a guess cannot be
   claimed (reveal) before the player replied to it. Rules-level flag +
   noteReply() at chat dispatch was enough; without it the service either ends
   rounds early or lets the model self-confirm guesses in the same turn.

5. **Tool sets as phase functions.** Legality here varies by mode AND phase
   (guesser/keeper, live/over, pendingGuess resolved or not, slots left), not
   just by "is there a hold". Computing the tools array per turn from the
   typed state, with the rules functions as the backstop for anything the
   model calls anyway, gave zero-cost legality: every illegal path is a
   tool_result note, mirroring the illegal-column pattern.

6. **Secrets are main-side state, not renderer state.** First game with
   information asymmetry: the keeper secret exists in the session and the
   prompt only, and enters a snapshot exclusively inside a finished round's
   result. The service test asserts no live snapshot ever serializes it. Any
   SDK snapshot helper needs an explicit "hidden until over" slot, or games
   will leak via a lazy spread.

7. **aiBusy replaces aiThinking.** With no move pipeline there is no
   aiThinking/pendingAiMove; a single aiBusy bool (any turn or secret pick in
   flight) drives the header shimmer. Pushed from the turn runner's
   entry/finally, which costs two extra small pushes per turn and needs no
   other lifecycle.

8. **Concurrent-agent wiring held up.** All shared-file edits (ipc.ts x4,
   shared/ipc.ts, preload, games.ts, picker/about, ChatScreen) landed
   additively while the watch agent edited the same files; the only
   cross-feature touch was extending watch's `isGameActive` closure in
   ipc.ts (an additive `|| tq.isTwentyQActive(id)`) and mirroring its
   watch-takeover guard in twentyq:start. The connect4 note (§C6) that game
   DI should ride IPC registration, not index.ts, is what made this
   conflict-free.
