import { describe, expect, it } from 'vitest';
import type { DrawChatMessage, DrawGalleryEntry } from '../../shared/drawIpc';
import {
  buildDrawTurnBlock,
  buildGuessTurnBlock,
  buildTurnEndBlock,
  roundsRecap,
  turnEndLine,
} from './drawPrompts';

const AI = 'Marv';
const PLAYER = 'Ouen';

function msg(over: Partial<DrawChatMessage>): DrawChatMessage {
  return { id: 'x', from: 'player', text: '', at: 0, ...over };
}

function entry(over: Partial<DrawGalleryEntry>): DrawGalleryEntry {
  return { round: 1, drawer: 'player', word: 'horn', strokes: [], guessed: false, ...over };
}

function guessBlock(over: Partial<Parameters<typeof buildGuessTurnBlock>[0]> = {}): string {
  return buildGuessTurnBlock({
    round: 1,
    rounds: 3,
    aiName: AI,
    playerName: PLAYER,
    turnChat: [],
    priorChat: [],
    secondsLeft: 120,
    said: [],
    unchanged: false,
    strokeCount: 4,
    gallery: [],
    ...over,
  });
}

describe('system lines in the model prompt', () => {
  // 260728, the bug this whole field exists for: beginTurn wrote "Round 1 of 3.
  // Your turn to draw: horn." into the chat log, and the log is replayed
  // verbatim into the GUESSER's prompt. The character was handed the answer,
  // and the second person read as addressed to it, which is how it came to
  // believe it had drawn the player's words.
  it('never shows the guesser the word the player is drawing', () => {
    const block = guessBlock({
      turnChat: [
        msg({
          system: true,
          text: 'Round 1 of 3. Your turn to draw.',
          modelText: `Round 1 of 3. ${PLAYER} draws, you guess.`,
        }),
      ],
    });
    expect(block).not.toContain('horn');
    expect(block).toContain(`${PLAYER} draws, you guess.`);
  });

  it('prefers modelText over text wherever it is set', () => {
    const block = guessBlock({
      priorChat: [msg({ system: true, text: 'PLAYER FACING', modelText: 'MODEL FACING' })],
    });
    expect(block).toContain('MODEL FACING');
    expect(block).not.toContain('PLAYER FACING');
  });

  it('falls back to text on system lines that need no second wording', () => {
    const block = guessBlock({ priorChat: [msg({ system: true, text: 'Time. It was "grass".' })] });
    expect(block).toContain('Time. It was "grass".');
  });

  it('leaves what the two of them actually said alone', () => {
    const block = guessBlock({
      turnChat: [msg({ from: 'ai', text: 'is that a boat' })],
    });
    expect(block).toContain(`${AI}: is that a boat`);
  });
});

describe('roundsRecap', () => {
  // The character claimed a word IT had drawn had been drawn by the player.
  // Chat only ever implies attribution; this states it.
  it('names the character as the drawer of its own turns', () => {
    const recap = roundsRecap({
      gallery: [entry({ drawer: 'ai', word: 'grass', guessed: true })],
      playerName: PLAYER,
    });
    expect(recap).toContain('YOU drew "grass"');
    expect(recap).toContain(`${PLAYER} got it.`);
  });

  it('names the player as the drawer of theirs', () => {
    const recap = roundsRecap({
      gallery: [entry({ drawer: 'player', word: 'horn', guessed: false })],
      playerName: PLAYER,
    });
    expect(recap).toContain(`${PLAYER} drew "horn"`);
    expect(recap).toContain('You never got it.');
  });

  it('keeps both sides of a round distinct', () => {
    const recap = roundsRecap({
      gallery: [
        entry({ round: 1, drawer: 'player', word: 'horn', guessed: true }),
        entry({ round: 1, drawer: 'ai', word: 'grass', guessed: false }),
      ],
      playerName: PLAYER,
    });
    expect(recap).toContain(`- Round 1: ${PLAYER} drew "horn". You got it.`);
    expect(recap).toContain('- Round 1: YOU drew "grass". Ouen never got it.');
  });

  it('says so plainly when nothing has been played', () => {
    expect(roundsRecap({ gallery: [], playerName: PLAYER })).toContain('first turn');
  });
});

describe('turn blocks state the role outright', () => {
  it('tells the guesser it has no word and is not drawing', () => {
    expect(guessBlock()).toContain('You have NO word this turn and you are NOT drawing.');
  });

  it('tells the drawer not to guess', () => {
    const block = buildDrawTurnBlock({
      round: 2,
      rounds: 3,
      word: 'grass',
      aiName: AI,
      playerName: PLAYER,
      turnChat: [],
      priorChat: [],
      secondsLeft: 100,
      strokesUsed: 0,
      resuming: false,
      gallery: [],
    });
    expect(block).toContain('Do NOT guess this turn');
    expect(block).toContain('Your word is: GRASS');
  });
});

describe('the instructions come after the chat log', () => {
  // 260728. The chat sections used to be appended to the END of every block,
  // and they are the biggest thing in it, so the last text the model read
  // before answering was chat from the PREVIOUS turn. Live capture: the
  // character guessed the player's drawing correctly and its turn-end line was
  // "hehe ok you're reading these too fast, that's not fair" — the drawer's
  // frame, continued straight out of the banter sitting at the bottom of the
  // prompt. Position is the fix, so position is what this pins.
  it('puts the role statement below the chat on a guessing turn', () => {
    const block = guessBlock({
      priorChat: [msg({ from: 'ai', text: 'watch this' })],
    });
    expect(block.indexOf('watch this')).toBeLessThan(block.indexOf('# YOUR TURN TO GUESS'));
    expect(block.trimEnd()).toMatch(/Right now: you are GUESSING\..*name it\..*$/s);
  });

  it('puts the role statement below the chat on a drawing turn', () => {
    const block = buildDrawTurnBlock({
      round: 2,
      rounds: 3,
      word: 'grass',
      aiName: AI,
      playerName: PLAYER,
      turnChat: [],
      priorChat: [msg({ from: 'ai', text: 'watch this' })],
      secondsLeft: 100,
      strokesUsed: 0,
      resuming: false,
      gallery: [],
    });
    expect(block.indexOf('watch this')).toBeLessThan(block.indexOf('# YOUR TURN TO DRAW'));
    expect(block.trimEnd()).toContain('Right now: you are DRAWING GRASS');
  });

  it('closes the turn-end beat by naming who was drawing', () => {
    const block = buildTurnEndBlock({
      round: 1,
      rounds: 3,
      aiName: AI,
      playerName: PLAYER,
      drawer: 'player',
      word: 'horn',
      guessed: true,
      winningLine: 'is it a horn',
      scores: { player: 0, ai: 1 },
      turnChat: [],
      priorChat: [msg({ from: 'ai', text: 'watch this' })],
      gameOver: false,
      gallery: [entry({ guessed: true })],
    });
    expect(block.indexOf('watch this')).toBeLessThan(block.indexOf('# TURN OVER'));
    expect(block.trimEnd()).toMatch(
      /Right now: the turn just ended\. Ouen was the one drawing, YOU were guessing\.$/,
    );
  });
});

describe('turnEndLine', () => {
  it('names the guesser to the player and says "you" to the character', () => {
    const r = turnEndLine({
      guessed: true,
      word: 'horn',
      guesser: 'ai',
      aiName: AI,
      playerName: PLAYER,
    });
    expect(r.text).toBe('Marv got it. It was "horn".');
    expect(r.modelText).toBe('You got it. It was "horn".');
  });

  it('names the player in both when the player got it', () => {
    const r = turnEndLine({
      guessed: true,
      word: 'grass',
      guesser: 'player',
      aiName: AI,
      playerName: PLAYER,
    });
    expect(r.text).toBe('Ouen got it. It was "grass".');
    expect(r.modelText).toBe('Ouen got it. It was "grass".');
  });

  it('needs no second wording for a timeout', () => {
    const r = turnEndLine({
      guessed: false,
      word: 'horn',
      guesser: 'ai',
      aiName: AI,
      playerName: PLAYER,
    });
    expect(r.modelText).toBe(r.text);
  });
});
