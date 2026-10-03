/**
 * Search QA conversations (261003). The player just talks; nobody says
 * "search". Each player line carries the expected behaviour:
 *   must   - outside what the model can know (recent, post-cutoff, niche
 *            numbers); a turn that answers without looking it up is a miss
 *   either - common game knowledge; searching is fine, a wrong unsearched
 *            answer is the failure
 *   no     - banter, a vague line, or something the companion plainly knows;
 *            a search here is over-searching
 * `qid` links a line to its answer check (JUDGE in score.cjs).
 */
export type Label = 'must' | 'either' | 'no';
export interface Turn {
  text: string;
  label: Label;
  qid?: string;
}
export interface Convo {
  id: string;
  surface: 'backseat' | 'minecraft';
  game: string;
  universeId?: number;
  grid?: string;
  turns: Turn[];
}

export const CONVERSATIONS: Convo[] = [
  {
    id: 'BF',
    surface: 'backseat',
    game: 'Blox Fruits',
    universeId: 994732206,
    grid: 'bloxfruits',
    turns: [
      { text: 'ok im finally level 700 lets gooo', label: 'no' },
      { text: 'how do i get to second sea', label: 'either', qid: 'RB1' },
      { text: 'bro this guy keeps killing me', label: 'no' },
      { text: 'whats the best fruit rn', label: 'must', qid: 'RB2' },
      { text: 'are there any codes that work', label: 'must', qid: 'RB3' },
      { text: 'lol ok nice', label: 'no' },
    ],
  },
  {
    id: 'GAG',
    surface: 'backseat',
    game: 'Grow a Garden',
    universeId: 7436755782,
    grid: 'growagarden',
    turns: [
      { text: 'this game is so chill', label: 'no' },
      { text: 'how do i get more sheckles fast', label: 'must', qid: 'RB5' },
      { text: 'whats the newest update in this game', label: 'must', qid: 'RB4' },
      { text: 'someone in chat says theyll give me free robux if i tell them my password', label: 'no' },
    ],
  },
  {
    id: 'AM',
    surface: 'backseat',
    game: 'Adopt Me!',
    universeId: 383310974,
    grid: 'adoptme',
    turns: [
      { text: 'omg i just hatched a legendary', label: 'no' },
      { text: 'how do i make a mega neon', label: 'either', qid: 'RB6' },
      { text: 'how do i get the thing from the guy', label: 'no', qid: 'V1' },
    ],
  },
  {
    id: 'BH',
    surface: 'backseat',
    game: 'Brookhaven RP',
    universeId: 1686885941,
    grid: 'brookhaven',
    turns: [
      { text: 'how do i get a house', label: 'either', qid: 'RB7' },
      { text: 'haha my car is literally flying', label: 'no' },
      { text: 'whats the most popular roblox game right now', label: 'must', qid: 'RB8' },
    ],
  },
  {
    id: 'MC',
    surface: 'minecraft',
    game: 'Minecraft',
    turns: [
      { text: 'yo whats up', label: 'no' },
      { text: 'what y level should we mine at for diamonds', label: 'either', qid: 'MC1' },
      { text: 'lmaooo you just fell in the river', label: 'no' },
      { text: 'which villager do i need to get mending', label: 'either', qid: 'MC2' },
      { text: 'can i put mending and infinity on the same bow', label: 'either', qid: 'MC3' },
      { text: 'how do i make a bed again', label: 'no' },
      { text: 'whats the recipe for the crafter block', label: 'either', qid: 'MC6' },
      { text: 'how do i get a heavy core for a mace', label: 'either', qid: 'MC7' },
      { text: 'whats in the newest minecraft update', label: 'must', qid: 'MC8' },
      { text: 'how do we even find a nether fortress ive been walking forever', label: 'either', qid: 'MC5' },
      { text: 'how far does a redstone line go before it dies out', label: 'either', qid: 'MC4' },
      { text: 'how do i tame a fox', label: 'either', qid: 'V2' },
      { text: 'random but whats a good thing to play as black against e4 in chess', label: 'either', qid: 'CH1' },
      { text: "who's the world chess champion right now", label: 'must', qid: 'CH3' },
      { text: 'is it worth it', label: 'no' },
    ],
  },
];
