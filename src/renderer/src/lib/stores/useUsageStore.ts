/**
 * Playtime usage summary (261110): the profile's own count of off-cloud LLM
 * use (ChatGPT plan replies, own-key tokens and estimated spend), read from
 * main's ledger (main/usage/llmUsageLedger.ts) on demand. Account scoped:
 * cleared by resetAccountScopedState (lib/scopeReset.ts).
 */
import { create } from 'zustand';
import type { UsageSummary } from '@shared/llmUsage';
import { sei } from '../ipcClient';

interface UsageState {
  summary: UsageSummary | null;
  load: () => Promise<void>;
  reset: () => void;
}

let loadSeq = 0;

export const useUsageStore = create<UsageState>((set) => ({
  summary: null,
  load: async () => {
    const seq = ++loadSeq;
    try {
      const summary = (await sei.usageSummary?.()) ?? null;
      if (seq === loadSeq) set({ summary });
    } catch {
      /* keep what we had; the page shows zeros until a read works */
    }
  },
  reset: () => {
    loadSeq += 1;
    set({ summary: null });
  },
}));
