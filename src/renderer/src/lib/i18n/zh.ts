/**
 * Simplified-Chinese dictionary, keyed by the exact English UI string.
 *
 * Rules:
 *  - Keys are the literal English strings passed to t(); a missing key just
 *    renders English, so never invent keys that no call site uses.
 *  - `{name}`-style placeholders must survive translation verbatim.
 *  - Chinese copy uses Chinese punctuation (，。！？「」), and the no-em-dash
 *    rule applies to BOTH languages: no em dash in any value.
 *  - The dictionary is split into per-surface part files under ./zh/ so the
 *    localization sweep can fill them independently; later spreads win on a
 *    duplicate key, so keep shared strings in common.ts only.
 */
import { ZH_COMMON } from './zh/common';
import { ZH_SCREENS_A } from './zh/screens-a';
import { ZH_SCREENS_B } from './zh/screens-b';
import { ZH_ONBOARD } from './zh/onboard';
import { ZH_MODALS } from './zh/modals';
import { ZH_CHATUI } from './zh/chatui';
import { ZH_GAMES } from './zh/games';
import { ZH_MISC } from './zh/misc';

export const ZH: Record<string, string> = {
  ...ZH_COMMON,
  ...ZH_SCREENS_A,
  ...ZH_SCREENS_B,
  ...ZH_ONBOARD,
  ...ZH_MODALS,
  ...ZH_CHATUI,
  ...ZH_GAMES,
  ...ZH_MISC,
};
