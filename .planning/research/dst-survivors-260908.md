# DST survivor roster brief (260908, sourced from dontstarve.wiki.gg, one page per survivor)

Purpose: the roster brief handed to the one-off "pick your survivor" LLM call
(plan section 8, decision 3) and, for the chosen survivor, appended to the DST
adapter's world primer. Stats are base values from the wiki character pages.
Re-verified 260908 (M2) against dontstarve.wiki.gg: Wolfgang's hunger is 300
and Mightiness is a separate 0-100 meter since the 2021 refresh (raised by
lifting and work, decaying over time and faster when hungry; Wimpy below 25,
Mighty at 75+); WX-78 is 100/100/100 before circuits (the wiki infobox; the
refresh kept the base stats and moved growth into circuits); Wickerbottom's
health is 125. The shipped copy of this table is `src/shared/dstSurvivors.ts`
(mirrored as data in `native/dst-mod/sei/scripts/sei/survivors.lua` and
`src/bot/adapter/dontstarve/survivors.js`; a vitest pins the three together).

Eligible for the companion body (v1): wilson, willow, wolfgang, wendy, wx78,
wickerbottom, waxwell, wigfrid, webber, winona, wortox, wormwood, warly, wurt,
walter. Excluded: wes (deliberate handicap, mute), wonkey (unlock-only
monkey), woodie (uncontrolled lunar transformations would fight the brain's
state), wanda (no natural healing, age meter needs watch juggling). DLC
survivors (wortox, wormwood, wurt, wanda) are spawned server-side by prefab
regardless of ownership; if a live test proves otherwise, drop them.

| prefab | name | health | hunger | sanity | perks | downsides / what the body must manage |
|---|---|---|---|---|---|---|
| wilson | Wilson | 150 | 150 | 200 | Grows a beard (winter insulation, beard hair for meat effigies). The only survivor with no drawbacks. | None. Safest generalist. |
| willow | Willow | 150 | 150 | 120 | Immune to fire damage; starts with a lighter and Bernie the bear; gains sanity near fire (up to +10/min). | Sanity drains and restores at 1.1x; suffers more from cold. Keep a fire lit at night. |
| wolfgang | Wolfgang | 150 to 300 | 300 | 200 | Mightiness meter (0 to 100): at 75 or more he is Mighty, deals 2x damage, works faster and carries heavy things without slowing; large hunger pool. | Mightiness decays over time (faster when hungry) and is raised by lifting dumbbells, rowing, and mining, chopping or digging work; below 25 he is Wimpy (0.75x damage and work). Afraid of the dark and of monsters (1.1x sanity drain). |
| wendy | Wendy | 150 | 150 | 200 | Abigail, her ghost sister, fights beside her (summon with the flower, heal with ectoherbology); sanity drains slower in the dark (0.75x). | Hits for 0.75x damage; relies on Abigail for fights. |
| wx78 | WX-78 | 100 | 100 | 100 | Eats spoiled food without penalty; installs circuits (scanned from creatures) that raise stats and add abilities; healed by lightning strikes. | Takes damage from wetness and rain; attracts lightning. Low base stats until circuits are installed. Stay dry, carry an umbrella. |
| wickerbottom | Wickerbottom | 125 | 150 | 250 | Crafts books with strong effects (grow plants, call lightning, sleep enemies); starts at a higher science tier. | Cannot sleep (no tents or bedrolls); loses sanity from stale or spoiled food. |
| waxwell | Maxwell | 75 | 150 | 200 | Sanity regenerates constantly (+6.67/min); splits his mind into shadow puppets that work and fight; starts with a dark sword, night armor and nightmare fuel. | Very frail at 75 health. Avoid direct fights; let puppets and armor do the work. |
| wigfrid | Wigfrid | 200 | 120 | 120 | Deals 1.25x damage, takes 0.75x; regains health and sanity on hits; starts with a battle helm and spear; battle songs. | Only eats meat. Hunt and cook meat only; small hunger and sanity pools. |
| webber | Webber | 175 | 175 | 100 | Spiders are neutral and can be befriended with food; can craft spider dens and eggs; eats monster meat safely; grows a beard. | Low sanity; pigs and most humanoid NPCs are hostile because he is a monster. |
| winona | Winona | 150 | 150 | 200 | Crafts faster and cheaper; builds catapults, spotlights and generators; starts with trusty tape; one free hit from the darkness. | Crafting bursts cost hunger. No other penalty. |
| wortox | Wortox | 200 | 175 | 150 | Collects souls from kills, eats them for hunger, hops (teleports) by spending souls, heals allies by releasing souls; takes half damage from sanity-based effects. | Normal food only restores half hunger; too many souls held drains sanity. Kill small creatures to keep souls. DLC. |
| wormwood | Wormwood | 150 | 150 | 200 | Plants seeds anywhere without farm plots; blooms in spring (faster movement); plant creatures are neutral; crafts living logs and bramble armor from his own body. | Food restores hunger but not health; loses sanity when plants nearby are cut or burned (including his own chopping); heals only from healing salves, poultices and the like. DLC. |
| warly | Warly | 150 | 250 | 200 | Portable crock pot and exclusive powerful dishes; spices add buffs. | Hunger drains 1.33x; only gourmet (crock pot) food satisfies him and repeating the same dish gives less each time. Cook constantly and vary meals. |
| wurt | Wurt | 150 | 200 | 150 | At home in the swamp (no penalty in marsh, faster on marsh turf); befriends and builds merm houses; vegetarian. | Cannot eat meat; merm loyalty needs fish and vegetables. DLC. |
| walter | Walter | 130 | 110 | 200 | Slingshot with many ammo types; Woby the dog carries items and grows into a mount; no sanity drain from darkness or monsters; sanity from trees; camp fire stories. | Loses sanity while injured (up to 12/min); takes extra damage from bees; small hunger pool. |

Not eligible (kept for the record): wes 113/113/150, mute, weaker in every stat;
woodie 150/150/200 with lucy the axe and lunar were-forms; wanda 175 health,
ageless watch, no natural healing; wonkey.

Sources: https://dontstarve.wiki.gg/wiki/Characters/DST and each survivor's page
under https://dontstarve.wiki.gg/wiki/<Name>.
