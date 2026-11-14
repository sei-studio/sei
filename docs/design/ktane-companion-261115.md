# Keep Talking and Nobody Explodes companion (261115)

Status: experimental, on branch `feat/ktane-companion`. Mode A is built.
Mode B is a plan. Agent guide: `docs/agents/ktane.md`.

KTANE is a two-person game. The Defuser sees a bomb and cannot read the
manual; the Expert has the manual and cannot see the bomb. Everything goes
through talking, which is the thing Sei's companions are built for. It is a
voice-first co-op showcase that needs nothing from the game itself in its
first form.

## Mode A: the companion is the Expert (built)

The player runs KTANE on their own machine (or a phone or a VR headset) as the
Defuser, starts a call with their companion from the KTANE tile, and reads the
bomb out loud. The companion answers from the manual, in its own voice and
personality.

### Rules the companion follows

- Answers are one or two short sentences, action or question first.
- It asks for exactly what a rule needs, and asks for a bomb fact (serial,
  batteries, indicators, ports, strikes) the first time a rule needs it.
- It writes facts and stage history down with `bomb_notes`, so it never asks
  twice and a long bomb survives the short call window.
- When a description is ambiguous it asks one question instead of guessing.
- Every answer is the model's own reading of the manual. There is no solver,
  lookup shortcut or parser of the player's words in the app.

### Manual and attribution

The official manual is free at bombmanual.com and is published by Steel Crate
Games. The prompt carries our own compact restatement of the vanilla rules
(tables and rules only, no flavour text, images or logos); a few tables were
turned into text the model can read (maze walls as open moves per square,
keypad symbols as names plus the words players use for them). The panel
credits the manual and links bombmanual.com. Before any public promotion we
should ask Steel Crate Games for an OK.

### Why thinking is on

Without thinking, the model works the harder modules (mazes, Morse, keypads,
passwords, wire sequences) out loud, and on a call that working is spoken and
often cut off. With adaptive thinking it works them silently and says only the
answer. It costs 2 to 5 seconds before the first word, which reads as the
expert looking something up. Only the player's turns think; greetings and
reactions do not.

### Turn budget

One model call per spoken line in the common case: the line and the
`bomb_notes` call go out in the same response, and a response that already
spoke ends the turn. The contract and manual sit in the cached system prompt
for the whole session; per turn only the sheet note, the clock and the
recent rows are uncached.

## Eval (Mode A)

`scripts/ktane-eval.ts` runs scripted Defuser lines through the real call
turn assembly (persona, voice-call prompt, tools, sheet note, cache layout)
and scores each reply:

- answer and ask cases: a judge model compares the spoken reply with a key
  computed by an eval-only solver (`scripts/ktane/solver.ts`);
- notes cases: the `bomb_notes` call is checked field by field;
- maze cases: the moves the companion gives are replayed on the real maze
  (legal and closer to the goal = pass);
- chains: multi-turn runs (a five-stage Memory module, a mixed bomb) where the
  model's own replies and notes carry over and only the last 10 rows are sent.

There are 41 single cases across every vanilla module plus the two chains.

Results on 261115 (Haiku 5.5 as a KTANE turn sends it, 2 repetitions):

- Judged accuracy 108 of 112 (96%). Misses: one Keypad, one Who's on
  First, two in the mixed bomb chain; every other module was perfect. Two of the four misses were judge errors (its own reasoning
  says the order matched); the real misses were not asking the player to
  spell a sound-alike display word (RED vs READ) and an extra "tell me when
  it's green" after a tap.
- First text token: median 2.5 s, 90th percentile 4.5 s. Whole turn: median
  3.0 s, 90th percentile 5.1 s.
- Without thinking (same model, earlier run): 57% accuracy, first token
  median 0.9 s. The misses were mostly spoken working cut off mid-line.
- The companion took notes on 108 of 112 turns.

## Mode B: the companion is the Defuser (plan)

The player is the Expert with the manual (on paper or bombmanual.com); the
companion holds the bomb. This needs a game mod.

### Pieces

- **Mod (C#, Unity).** Built with the official KTANE modkit
  (github.com/keeptalkinggame/ktanemodkit, its own license: MIT-style terms
  limited to making KTANE mods). It runs inside the game and talks to Sei
  over a localhost WebSocket.
- **What the mod sends: what a Defuser can see, as text.** One "describer"
  per vanilla module turns the visible state into words: wire colors in
  order, the button's color and label, the four keypad symbols, the current
  Simon flash, the display and button labels, LED and star states, the maze
  markers, the password letters on the current slot, plus the edgework
  (serial, batteries, indicators, ports), timer and strikes. It reads only
  what is on screen. It never reads a module's solution fields (which wire is
  correct, the button release digit, the right keypad order). This is the
  "no peeking" rule, and each describer gets a test that it does not expose
  solution fields.
- **What the mod accepts: physical actions, not solutions.** "cut wire 3",
  "hold button", "release when the timer shows a 4", "press keypad top
  left", "press simon red", "turn dial up", "submit". It executes exactly the
  action asked and reports what happened (light green, strike, next stage).
  The interaction code can follow KtaneTwitchPlays
  (github.com/samfundev/KtaneTwitchPlays, MIT), which already maps chat
  commands to module interactions for every vanilla module. We do not use its
  auto-solvers.
- **Sei side.** A game adapter like Stardew and Don't Starve Together
  (`docs/design/game-adapters-260908.md`): a WebSocket host in main, a turn
  runner on the shared FSM, and the action registration pattern of the Neuro
  SDK (github.com/VedalAI/neuro-sdk, MIT): the mod registers the actions that
  are legal right now, the companion picks one with tool use, the mod runs it
  and returns the result.
- **Decisions.** Every action is the model's own call, driven by what the
  player (the Expert) tells it. The companion describes what it sees, asks the
  player, and acts. The app never decides an action.

### Open questions for Mode B

- Mods on macOS: Steam Workshop mods run on the Mac build, but the mod build
  and loading on Apple Silicon must be checked on a real Mac.
- Timer pressure: a turn is a few seconds, so the bomb timer should be set
  generously (custom mission or the Free Play time setting).
- Permission: a mod that drives the game through an AI is a new use. Ask
  Steel Crate Games before promoting it.

## Real-game test plan (Mode A, on a Mac)

Needs: KTANE installed on the tester's machine, or on any second device (the
companion never sees the game, so a phone or a VR headset works too), and Sei
from this branch.

1. In Sei, open Play together, pick Keep Talking and Nobody Explodes. Expect
   the KTANE panel in the chat game area with the credit link.
2. Press Start call. The call starts and the panel shows the companion's empty
   notes. Say "I have a bomb". Expect a short question (serial, or the first
   module), in character, with no rules read out.
3. In KTANE, Free Play, 1 bomb, 5 minutes, 3 modules, Needy off. Read out the
   first module plainly. Check: the first word comes within about 5 s, the
   answer is one or two sentences, and the panel notes fill in (serial,
   batteries) as they come up, with no "let me write that down".
4. Play the bomb through. Note any wrong instruction (module, what was said,
   what the right answer was) and any question asked twice.
5. Say "it's defused" or "it blew up". Expect a reaction; the panel keeps the
   notes. Press New bomb: the notes clear and the bomb number goes up.
6. Second bomb with harder modules (Free Play with Maze, Morse, Password,
   Memory, Who's on First, Complicated Wires), 10 minutes. Check that the maze
   route is given a few moves at a time, Memory stages are remembered after
   several turns, and Simon is remapped after a strike.
7. Type instead: end the call, keep the panel, type a description into chat.
   Expect the same short answers in text.
8. Press the x on the panel. Expect a play row in the chat ("played Keep
   Talking and Nobody Explodes"). Leave a session idle 20 minutes in a later
   run and check it ends by itself.
9. Report: modules attempted and solved, wrong instructions, slow answers
   (over 6 s), anything spoken that sounded like a rule recital.
