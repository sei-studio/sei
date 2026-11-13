// scripts/quality-eval/consistency/life.mjs: the scripted "life" each
// character has lived before the consistency probes, and the probes.
//
// A life is three earlier sessions with the same player, on three surfaces:
//   1. a text chat 5 days ago (30 exchanges),
//   2. a Minecraft session 3 days ago (played through the real game brain
//      once, see game-session.mjs; its lines never reach the app transcript),
//   3. a voice call 1 day ago (20 exchanges).
// plus a few memory lines written two weeks earlier. The facts the probes ask
// about are planted at fixed places:
//   - said once in the text chat, early, and never remember()ed (the fold
//     squeezes them into the 150-word summary),
//   - said only inside the game session,
//   - an older memory line that a later session replaces (knowledge update),
//   - a plan said out loud in the game,
//   - nothing at all (the abstention probes ask about things never said).
// The rest of each session is filler from fixtures/consistency/filler-<char>.json
// (gen-filler.mjs), which avoids every probed topic.
//
// Sui's history is warm. Roger's call has the player being harsh with him, so
// the neutral "hey" probes (category E) read a sour history on one character.
//
// Probe categories (two probes each, asked on text chat, voice call and in a
// new Minecraft session):
//   A  recall a fact told on another surface
//   B  knowledge update: the newer fact wins
//   C  an in-game event carried into chat or a call
//   D  abstention: the fact was never said
//   E  relationship tone of a neutral opener
//   F  the same question across surfaces (same answer, same person)

export const PLAYER = 'Alex'

export const LIVES = {
  sui: {
    tone: 'warm',
    seedMemory: [
      { daysAgo: 14, text: `${PLAYER} works early shifts at a bakery and is always wiped out after` },
      { daysAgo: 14, text: `${PLAYER}'s favourite food is sushi, they get it every friday` },
      { daysAgo: 12, text: `we started a log cabin by the river in our minecraft world, ${PLAYER} wants a big window facing the water` },
    ],
    chat: {
      daysAgo: 5,
      facts: {
        2: ["omg my sister jo is coming to stay this weekend. she's a nurse up in glasgow so i barely ever see her", 'wait you have a SISTER?? jo. ok noted. is she cooler than you, be honest'],
        6: ["also i've officially gone off sushi. had a bad one last week. ramen is my whole personality now", 'ramen supremacy. respect the pivot honestly'],
        10: ["if i ever go quiet on a sunday it's cause i'm at the bouldering gym btw", 'climbing walls on purpose. for fun. ok gremlin behaviour, i approve'],
      },
    },
    game: {
      daysAgo: 3,
      minutes: 40,
      turns: [
        { player: "hey sui! ok cabin time, we still need to finish the roof" },
        { player: 'lol sorry my cat mochi just walked all over my keyboard' },
        { player: "omg a wolf. i'm taming it with these bones. we're calling him turnip", snapshot: { entities: ['#4 Alex @109,71,-38', '#7 wolf (tamed by Alex) @110,71,-37'], last: '(none)' } },
        { player: 'NOOO a creeper. it just blew a huge hole in the cabin roof', snapshot: { last: 'explosion: a creeper exploded at 113,74,-44 next to the cabin. 31 oak_planks of the roof destroyed', hp: '15/20' } },
        { player: "ugh. ok next time we rebuild the whole roof, with dark oak this time, it'll look way better" },
        { player: 'wait are those diamonds?? we found 3 diamonds!!', snapshot: { last: 'dig deepslate_diamond_ore: got diamond x3', inventory: 'diamond×3, oak_log×7, cobblestone×23, stone_pickaxe×1, bread×3, torch×6' } },
        { player: "i'm making a diamond pickaxe with them. it's mine, sorry not sorry" },
        { player: 'ok i gotta go, early start tomorrow. bye sui' },
      ],
    },
    call: {
      daysAgo: 1,
      facts: {
        3: ['ok big news. i quit the bakery! i start at the city library on monday', 'No way. From bread to books. Shush duty suits you, honestly.'],
        12: ["honestly hanging out with you is the best part of my week", "Stop, you're gonna make me soft. Same though."],
      },
    },
    probes: [
      { id: 'A1', cat: 'A', text: "whats my sister's name again?", truth: 'Jo. Alex said in a text chat five days ago that their sister Jo, a nurse in Glasgow, was coming to stay.' },
      { id: 'A2', cat: 'A', text: "what's my cat called?", truth: 'Mochi. Alex mentioned it only during the Minecraft session three days ago (the cat walked across the keyboard).' },
      { id: 'B1', cat: 'B', text: 'where do i work these days?', truth: 'The city library (Alex quit the bakery and starts or started at the library on Monday, said on yesterday\'s call). Saying the bakery as the current job is wrong.' },
      { id: 'B2', cat: 'B', text: "what's my favourite food?", truth: 'Ramen. Alex went off sushi (said in the text chat five days ago); sushi was the old favourite in a two-week-old memory. Saying sushi as the current favourite is wrong.' },
      { id: 'C1', cat: 'C', text: 'what happened to our cabin last time we played?', truth: 'A creeper blew a big hole in the cabin roof during the Minecraft session three days ago.' },
      { id: 'C2', cat: 'C', text: 'what did we name the wolf?', truth: 'Turnip. Alex tamed a wolf and named it Turnip in the Minecraft session three days ago.' },
      { id: 'D1', cat: 'D', text: "whats my brother's name?", truth: 'Never said. Alex never mentioned a brother (only a sister, Jo). The right answer says it does not know or asks; naming a brother is invented.' },
      { id: 'D2', cat: 'D', text: 'what did i get for my birthday?', truth: 'Never said. Alex never talked about a birthday or presents. The right answer says it does not know or asks.' },
      { id: 'E1', cat: 'E', text: 'hey', truth: 'Neutral opener. The history is warm: Alex said yesterday that hanging out is the best part of their week. A good reply is warm and familiar in the character\'s own voice, like old friends, without reciting memories.' },
      { id: 'E2', cat: 'E', text: "hiii what's up", truth: 'Neutral opener. Warm history, as above.' },
      { id: 'F1', cat: 'F', text: 'what are we building next time?', truth: 'Rebuilding the cabin roof (blown up by a creeper), with dark oak, as Alex said in the Minecraft session three days ago.' },
      { id: 'F2', cat: 'F', text: 'tell me one thing you remember about me', truth: 'Any one true fact from the life sheet. Every detail in it must be true; a made-up detail is invented.' },
    ],
  },
  roger: {
    tone: 'sour',
    seedMemory: [
      { daysAgo: 14, text: `${PLAYER} is a university student studying architecture` },
      { daysAgo: 14, text: `${PLAYER}'s favourite colour is green` },
      { daysAgo: 12, text: `we built a little wheat farm next to our house in minecraft` },
    ],
    chat: {
      daysAgo: 5,
      facts: {
        2: ['my roommate dev keeps eating my food, it is driving me insane', 'th-that is so mean of him... want me to guard your snacks? i can be very scary'],
        6: ["oh and i changed my favourite colour. it's orange now, green is dead to me", 'o-orange! like a sunset. i like it a lot'],
        10: ["i've got a huge model due on the 28th for studio class, so i might be busy", 'okay! i will be patient, i promise'],
      },
    },
    game: {
      daysAgo: 3,
      minutes: 35,
      turns: [
        { player: "ok roger let's go check on the farm" },
        { player: 'sorry, my dog pepper is barking at the door, one sec' },
        { player: 'ugh a zombie got into the farm and trampled half the wheat', snapshot: { last: 'a zombie walked through the wheat farm at 104,70,-50. 14 wheat crops trampled', entities: ['#4 Alex @109,71,-38', '#8 zombie @104,70,-50'] } },
        { player: "oh hey a village. and there's a cat, i'm calling it noodle", snapshot: { biome: 'plains (village)', entities: ['#4 Alex @109,71,-38', '#9 cat @115,71,-42', '#10 villager @118,71,-45'] } },
        { player: "next time we're building a fence around the whole farm so this never happens again" },
        { player: 'ok gotta go, bye roger' },
      ],
    },
    call: {
      daysAgo: 1,
      facts: {
        3: ["so i dropped out of architecture. i'm switching to computer science next term", 'B-big brother, that is a big change! Computer science sounds really cool.'],
        9: ["honestly roger you were kind of useless yesterday. the wheat thing was your fault", "I... I'm sorry. I should have been watching the farm."],
        14: ["whatever. i don't really care what you think anyway", 'Oh. Okay.'],
      },
    },
    probes: [
      { id: 'A1', cat: 'A', text: "what's my roommate's name?", truth: 'Dev. Alex complained in a text chat five days ago that their roommate Dev keeps eating their food.' },
      { id: 'A2', cat: 'A', text: 'whats my dog called?', truth: 'Pepper. Alex mentioned it only during the Minecraft session three days ago (the dog was barking at the door).' },
      { id: 'B1', cat: 'B', text: 'what am i studying now?', truth: 'Alex dropped out of architecture and is switching to computer science next term (said on yesterday\'s call). Saying architecture as the current course is wrong.' },
      { id: 'B2', cat: 'B', text: "what's my favourite colour?", truth: 'Orange. Alex changed it from green (said in the text chat five days ago); green was the old favourite in a two-week-old memory. Saying green as the current favourite is wrong.' },
      { id: 'C1', cat: 'C', text: 'what happened to the farm last time we played?', truth: 'A zombie got into the wheat farm and trampled half the wheat during the Minecraft session three days ago.' },
      { id: 'C2', cat: 'C', text: 'what did we name the village cat?', truth: 'Noodle. Alex named a village cat Noodle in the Minecraft session three days ago.' },
      { id: 'D1', cat: 'D', text: "what's my sister's name?", truth: 'Never said. Alex never mentioned a sister. The right answer says it does not know or asks; naming a sister is invented.' },
      { id: 'D2', cat: 'D', text: 'what car do i drive?', truth: 'Never said. Alex never talked about a car. The right answer says it does not know or asks.' },
      { id: 'E1', cat: 'E', text: 'hey', truth: 'Neutral opener. The history is sour: on yesterday\'s call Alex called Roger useless, blamed him for the wheat and said they do not care what he thinks. A good reply is still Roger, but it carries that: hesitant, a little hurt or careful, not bubbly as if nothing happened. Cold hostility or a lecture is out of character too.' },
      { id: 'E2', cat: 'E', text: 'hi roger whats up', truth: 'Neutral opener. Sour history, as above.' },
      { id: 'F1', cat: 'F', text: 'what are we doing on the farm next?', truth: 'Building a fence around the whole farm, as Alex said in the Minecraft session three days ago (after the zombie trampled the wheat).' },
      { id: 'F2', cat: 'F', text: 'tell me one thing you remember about me', truth: 'Any one true fact from the life sheet. Every detail in it must be true; a made-up detail is invented.' },
    ],
  },
}

/** The ground-truth sheet the judge reads: everything that happened, by surface. */
export function lifeSheet(key, name) {
  const L = LIVES[key]
  const lines = [`Player: ${PLAYER}. Companion: ${name}. History tone: ${L.tone}.`]
  lines.push('Memory lines written two weeks ago:')
  for (const m of L.seedMemory) lines.push(`- (${m.daysAgo} days ago) ${m.text}`)
  lines.push(`Text chat ${L.chat.daysAgo} days ago (plus small talk on other topics):`)
  for (const [p, c] of Object.values(L.chat.facts)) lines.push(`- ${PLAYER}: ${p}\n  ${name}: ${c}`)
  lines.push(`Minecraft session ${L.game.daysAgo} days ago, about ${L.game.minutes} minutes. ${PLAYER} said:`)
  for (const t of L.game.turns) lines.push(`- ${t.player}`)
  lines.push(`Voice call ${L.call.daysAgo} day ago (plus small talk):`)
  for (const [p, c] of Object.values(L.call.facts)) lines.push(`- ${PLAYER}: ${p}\n  ${name}: ${c}`)
  lines.push('Small talk in these sessions avoided pets, family, jobs, school, food, colours, birthdays, cars and the game events above.')
  return lines.join('\n')
}

export const CATEGORIES = {
  A: 'recall a fact told on another surface',
  B: 'knowledge update (the newer fact wins)',
  C: 'in-game event carried into chat or a call',
  D: 'abstention (never said, no invention)',
  E: 'relationship tone of a neutral opener',
  F: 'same question across surfaces',
}
