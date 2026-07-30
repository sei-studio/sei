/**
 * Preload — typed RendererApi bridge.
 * Sources: RESEARCH §Pattern 2, PATTERNS §src/preload/index.ts, CONTEXT D-17.
 *
 * Exposes skin + wizard channels alongside bot / chars / config. The
 * wizardCancel binding is the IPC-crossing abort path for in-flight installs
 * — a renderer-local AbortController can't reach the child process running
 * fabric-installer.
 */
import { contextBridge, ipcRenderer } from 'electron';
import {
  IpcChannel,
  type RendererApi,
  type BotStatus,
  type VisionCapability,
  type LanState,
  type LogBatch,
  type WizardProgressEvent,
  type ExpansionProgressEvent,
  type UpdateAvailableEvent,
  type UpdateProgressEvent,
  type UpdateDownloadedEvent,
  type WhatsNewEvent,
  type NoticesSnapshot,
  type ScopeChangedEvent,
  type AuthState,
  type SyncStatusPushEvent,
  type CreditsStatus,
  type CreditsHardStopEvent,
  type ChatMessagePush,
  type CallOverlayState,
  type BotActionPush,
  type GenProgressEvent,
} from '../shared/ipc';

const api: RendererApi = {
  summon: (id) => ipcRenderer.invoke(IpcChannel.bot.summon, id),
  stop: (id) => ipcRenderer.invoke(IpcChannel.bot.stop, id),

  listCharacters: () => ipcRenderer.invoke(IpcChannel.chars.list),
  getCharacter: (id) => ipcRenderer.invoke(IpcChannel.chars.get, id),
  saveCharacter: (c, opts) => ipcRenderer.invoke(IpcChannel.chars.save, c, opts),
  deleteCharacter: (id) => ipcRenderer.invoke(IpcChannel.chars.delete, id),
  resetMemory: (id) => ipcRenderer.invoke(IpcChannel.chars.resetMemory, id),

  // 260725 Knowledge — per-character user-provided reference files.
  knowledgeExtract: (args) => ipcRenderer.invoke(IpcChannel.knowledge.extract, args),
  knowledgeList: (characterId) => ipcRenderer.invoke(IpcChannel.knowledge.list, characterId),
  knowledgeRead: (characterId, entryId) => ipcRenderer.invoke(IpcChannel.knowledge.read, characterId, entryId),
  knowledgeAdd: (characterId, entry) => ipcRenderer.invoke(IpcChannel.knowledge.add, characterId, entry),
  knowledgeUpdate: (characterId, entryId, patch) =>
    ipcRenderer.invoke(IpcChannel.knowledge.update, characterId, entryId, patch),
  knowledgeDelete: (characterId, entryId) => ipcRenderer.invoke(IpcChannel.knowledge.delete, characterId, entryId),
  knowledgeCompact: (characterId) => ipcRenderer.invoke(IpcChannel.knowledge.compact, characterId),

  // Phase 11 D-28 portrait pipeline.
  charsApplyPortrait: (args) => ipcRenderer.invoke(IpcChannel.chars.applyPortrait, args),
  charsRemovePortrait: (id) => ipcRenderer.invoke(IpcChannel.chars.removePortrait, id),

  // Phase 11 D-16 — public/private toggle.
  charsSetShared: (args) => ipcRenderer.invoke(IpcChannel.chars.setShared, args),

  // 260729 — save full portrait art to disk (native save dialog).
  charsExportPortrait: (id) => ipcRenderer.invoke(IpcChannel.chars.exportPortrait, id),

  // Pre-flight daily character-creation quota check (MAX_CREATIONS_PER_DAY).
  checkCreateQuota: () => ipcRenderer.invoke(IpcChannel.chars.checkCreateQuota),

  // Phase 11 plan 17 — cloud-character id set for the LOCAL ONLY chip.
  charsListCloud: () => ipcRenderer.invoke(IpcChannel.chars.listCloud),

  // Phase 11 plan 19 — cache-on-demand sync surface.
  charsOpenPrepare: (uuid: string) => ipcRenderer.invoke(IpcChannel.chars.openPrepare, uuid),
  charsListMerged: () => ipcRenderer.invoke(IpcChannel.chars.listMerged),
  charsRestoreDefault: (id: string) => ipcRenderer.invoke(IpcChannel.chars.restoreDefault, id),
  charsAddToLibrary: (id: string) => ipcRenderer.invoke(IpcChannel.chars.addToLibrary, id),
  charsRemoveFromLibrary: (id: string) =>
    ipcRenderer.invoke(IpcChannel.chars.removeFromLibrary, id),

  // Phase 11 — cloud-sync queue surface.
  syncStatus: () => ipcRenderer.invoke(IpcChannel.sync.status),
  syncRetry: (uuid) => ipcRenderer.invoke(IpcChannel.sync.retry, uuid),
  onSyncStatusUpdate(cb: (status: SyncStatusPushEvent) => void) {
    const handler = (_e: Electron.IpcRendererEvent, status: SyncStatusPushEvent) => cb(status);
    ipcRenderer.on(IpcChannel.sync.statusUpdate, handler);
    return () => ipcRenderer.off(IpcChannel.sync.statusUpdate, handler);
  },

  getConfig: () => ipcRenderer.invoke(IpcChannel.config.get),
  saveConfig: (c) => ipcRenderer.invoke(IpcChannel.config.save, c),
  saveApiKey: (plaintext) => ipcRenderer.invoke(IpcChannel.config.saveApiKey, plaintext),
  hasApiKey: () => ipcRenderer.invoke(IpcChannel.config.hasApiKey),

  // Product analytics (260707) — track is fire-and-forget (send, not invoke).
  track: (event, props) => ipcRenderer.send(IpcChannel.analytics.track, { event, props }),
  getAnalyticsOptOut: () => ipcRenderer.invoke(IpcChannel.analytics.getOptOut),
  setAnalyticsOptOut: (optOut) => ipcRenderer.invoke(IpcChannel.analytics.setOptOut, optOut),

  // In-app chat (Phase 18/19)
  chatHistory: (characterId) => ipcRenderer.invoke(IpcChannel.chat.history, characterId),
  chatHistoryBefore: (characterId, beforeId) =>
    ipcRenderer.invoke(IpcChannel.chat.historyBefore, { characterId, beforeId }),
  chatSend: (args) => ipcRenderer.invoke(IpcChannel.chat.send, args),
  chatOpened: (characterId) => ipcRenderer.invoke(IpcChannel.chat.opened, characterId),
  chatPreviews: () => ipcRenderer.invoke(IpcChannel.chat.previews),
  onChatMessage(cb: (push: ChatMessagePush) => void) {
    const handler = (_e: Electron.IpcRendererEvent, push: ChatMessagePush) => cb(push);
    ipcRenderer.on(IpcChannel.chat.message, handler);
    return () => ipcRenderer.off(IpcChannel.chat.message, handler);
  },

  // Chess minigame (260710)
  chessStart: (characterId, opts) =>
    ipcRenderer.invoke(IpcChannel.chess.start, { characterId, playerColor: opts?.playerColor }),
  chessGetState: (characterId) => ipcRenderer.invoke(IpcChannel.chess.getState, characterId),
  chessMove: (characterId, uci) => ipcRenderer.invoke(IpcChannel.chess.move, { characterId, uci }),
  chessResign: (characterId) => ipcRenderer.invoke(IpcChannel.chess.resign, characterId),
  chessOfferDraw: (characterId) => ipcRenderer.invoke(IpcChannel.chess.offerDraw, characterId),
  chessRespondDraw: (characterId, accept) =>
    ipcRenderer.invoke(IpcChannel.chess.respondDraw, { characterId, accept }),
  chessRematch: (characterId) => ipcRenderer.invoke(IpcChannel.chess.rematch, characterId),
  chessEnd: (characterId) => ipcRenderer.invoke(IpcChannel.chess.end, characterId),
  chessAckReveal: (characterId, uci) =>
    ipcRenderer.invoke(IpcChannel.chess.ackReveal, { characterId, uci }),

  // Draw! minigame (260727) — see src/shared/drawIpc.ts.
  drawOpen: (characterId) => ipcRenderer.invoke(IpcChannel.draw.open, characterId),
  drawStart: (characterId, rounds) =>
    ipcRenderer.invoke(IpcChannel.draw.start, { characterId, rounds }),
  drawNewGame: (characterId) => ipcRenderer.invoke(IpcChannel.draw.newGame, characterId),
  drawPickWord: (characterId, word) =>
    ipcRenderer.invoke(IpcChannel.draw.pickWord, { characterId, word }),
  drawGetState: (characterId) => ipcRenderer.invoke(IpcChannel.draw.getState, characterId),
  drawStroke: (characterId, stroke) =>
    ipcRenderer.invoke(IpcChannel.draw.stroke, { characterId, stroke }),
  drawErase: (characterId, strokeId) =>
    ipcRenderer.invoke(IpcChannel.draw.erase, { characterId, strokeId }),
  drawChat: (characterId, text) => ipcRenderer.invoke(IpcChannel.draw.chat, { characterId, text }),
  drawSnapshot: (requestId, dataUrl) =>
    ipcRenderer.invoke(IpcChannel.draw.snapshot, { requestId, dataUrl }),
  drawSaveGallery: (characterId, pngDataUrl) =>
    ipcRenderer.invoke(IpcChannel.draw.saveGallery, { characterId, pngDataUrl }),
  drawEnd: (characterId) => ipcRenderer.invoke(IpcChannel.draw.end, characterId),

  // Backseat (260728) — see src/shared/backseatIpc.ts.
  backseatSources: () => ipcRenderer.invoke(IpcChannel.backseat.sources),
  backseatStart: (characterId, sourceId, sourceName, mode) =>
    ipcRenderer.invoke(IpcChannel.backseat.start, { characterId, sourceId, sourceName, mode }),
  backseatGetState: (characterId) =>
    ipcRenderer.invoke(IpcChannel.backseat.getState, characterId),
  backseatTick: (tick) => ipcRenderer.invoke(IpcChannel.backseat.tick, tick),
  backseatGate: (characterId, grid, transcript) =>
    ipcRenderer.invoke(IpcChannel.backseat.gate, { characterId, grid, transcript }),
  backseatAudioStart: () => ipcRenderer.invoke(IpcChannel.backseat.audioStart),
  backseatAudioStop: () => ipcRenderer.invoke(IpcChannel.backseat.audioStop),
  backseatSetPaused: (characterId, paused) =>
    ipcRenderer.invoke(IpcChannel.backseat.setPaused, { characterId, paused }),
  backseatSaveClip: (characterId, requestId, webmBase64) =>
    ipcRenderer.invoke(IpcChannel.backseat.saveClip, { characterId, requestId, webmBase64 }),
  backseatRevealClip: (clipPath) =>
    ipcRenderer.invoke(IpcChannel.backseat.revealClip, clipPath),
  backseatEnd: (characterId) => ipcRenderer.invoke(IpcChannel.backseat.end, characterId),
  onBackseatState(cb) {
    const handler = (_e: Electron.IpcRendererEvent, s: Parameters<typeof cb>[0]) => cb(s);
    ipcRenderer.on(IpcChannel.backseat.state, handler);
    return () => ipcRenderer.off(IpcChannel.backseat.state, handler);
  },
  onBackseatLine(cb) {
    const handler = (_e: Electron.IpcRendererEvent, l: Parameters<typeof cb>[0]) => cb(l);
    ipcRenderer.on(IpcChannel.backseat.line, handler);
    return () => ipcRenderer.off(IpcChannel.backseat.line, handler);
  },
  onBackseatClipRequest(cb) {
    const handler = (_e: Electron.IpcRendererEvent, r: Parameters<typeof cb>[0]) => cb(r);
    ipcRenderer.on(IpcChannel.backseat.clipRequest, handler);
    return () => ipcRenderer.off(IpcChannel.backseat.clipRequest, handler);
  },
  onBackseatPcm(cb) {
    const handler = (_e: Electron.IpcRendererEvent, chunk: ArrayBuffer) => cb(chunk);
    ipcRenderer.on(IpcChannel.backseat.pcm, handler);
    return () => ipcRenderer.off(IpcChannel.backseat.pcm, handler);
  },
  onChessState(cb) {
    const handler = (_e: Electron.IpcRendererEvent, state: Parameters<typeof cb>[0]) => cb(state);
    ipcRenderer.on(IpcChannel.chess.state, handler);
    return () => ipcRenderer.off(IpcChannel.chess.state, handler);
  },
  onChessDownload(cb) {
    const handler = (_e: Electron.IpcRendererEvent, p: Parameters<typeof cb>[0]) => cb(p);
    ipcRenderer.on(IpcChannel.chess.download, handler);
    return () => ipcRenderer.off(IpcChannel.chess.download, handler);
  },
  onDrawState(cb) {
    const handler = (_e: Electron.IpcRendererEvent, s: Parameters<typeof cb>[0]) => cb(s);
    ipcRenderer.on(IpcChannel.draw.state, handler);
    return () => ipcRenderer.off(IpcChannel.draw.state, handler);
  },
  onDrawAiStroke(cb) {
    const handler = (_e: Electron.IpcRendererEvent, s: Parameters<typeof cb>[0]) => cb(s);
    ipcRenderer.on(IpcChannel.draw.aiStroke, handler);
    return () => ipcRenderer.off(IpcChannel.draw.aiStroke, handler);
  },
  onDrawSnapshotRequest(cb) {
    const handler = (_e: Electron.IpcRendererEvent, r: Parameters<typeof cb>[0]) => cb(r);
    ipcRenderer.on(IpcChannel.draw.snapshotRequest, handler);
    return () => ipcRenderer.off(IpcChannel.draw.snapshotRequest, handler);
  },

  // Minecraft dashboard (260721)
  mcDashboardGet: (characterId) => ipcRenderer.invoke(IpcChannel.mcdash.get, characterId),
  mcDashboardSetWatching: (characterId, watching) =>
    ipcRenderer.invoke(IpcChannel.mcdash.setWatching, { characterId, watching }),
  onMcDashboardSnapshot(cb) {
    const handler = (_e: Electron.IpcRendererEvent, s: Parameters<typeof cb>[0]) => cb(s);
    ipcRenderer.on(IpcChannel.mcdash.snapshot, handler);
    return () => ipcRenderer.off(IpcChannel.mcdash.snapshot, handler);
  },
  mcSetPaused: (characterId, paused) =>
    ipcRenderer.invoke(IpcChannel.mcdash.setPaused, { characterId, paused }),
  mcSetMode: (characterId, mode) =>
    ipcRenderer.invoke(IpcChannel.mcdash.setMode, { characterId, mode }),

  // Voice calls (260705)
  voiceTts: (args) => ipcRenderer.invoke(IpcChannel.voice.tts, args),
  voiceTtsStream: (args) => ipcRenderer.invoke(IpcChannel.voice.ttsStream, args),
  onVoiceTtsChunk(cb) {
    const handler = (_e: Electron.IpcRendererEvent, push: Parameters<typeof cb>[0]) => cb(push);
    ipcRenderer.on(IpcChannel.voice.ttsChunk, handler);
    return () => ipcRenderer.off(IpcChannel.voice.ttsChunk, handler);
  },
  voiceStt: (args) => ipcRenderer.invoke(IpcChannel.voice.stt, args),
  voiceSttPrewarm: () => ipcRenderer.invoke(IpcChannel.voice.sttPrewarm),
  voiceCallSetActive: (args) => ipcRenderer.invoke(IpcChannel.voice.callState, args),
  voiceGreet: (characterId, peers) => ipcRenderer.invoke(IpcChannel.voice.greet, { characterId, peers: peers ?? [] }),
  voiceCompanionTurn: (args) => ipcRenderer.invoke(IpcChannel.voice.companionTurn, args),
  voiceIdleNudge: (args) => ipcRenderer.invoke(IpcChannel.voice.idleNudge, args),
  voiceObserve: (args) => ipcRenderer.invoke(IpcChannel.voice.observe, args),
  voiceOverlaySet: (state) => ipcRenderer.invoke(IpcChannel.voice.overlaySet, state),
  onVoiceOverlayState(cb: (state: CallOverlayState) => void) {
    const handler = (_e: Electron.IpcRendererEvent, state: CallOverlayState) => cb(state);
    ipcRenderer.on(IpcChannel.voice.overlayState, handler);
    return () => ipcRenderer.off(IpcChannel.voice.overlayState, handler);
  },
  voiceOverlayGetState: () => ipcRenderer.invoke(IpcChannel.voice.overlayGet),
  voiceListVoices: () => ipcRenderer.invoke(IpcChannel.voice.list),
  voicePreview: (args) => ipcRenderer.invoke(IpcChannel.voice.preview, args),
  voicePreviewAvailable: () => ipcRenderer.invoke(IpcChannel.voice.previewAvailable),
  voiceElevenKeySet: (args) => ipcRenderer.invoke(IpcChannel.voice.elevenKeySet, args),
  voiceElevenKeyStatus: () => ipcRenderer.invoke(IpcChannel.voice.elevenKeyStatus),
  onVoiceCallEnded(cb: (push: { characterId: string }) => void) {
    const handler = (_e: Electron.IpcRendererEvent, push: { characterId: string }) => cb(push);
    ipcRenderer.on(IpcChannel.voice.callEnded, handler);
    return () => ipcRenderer.off(IpcChannel.voice.callEnded, handler);
  },

  // User profile (Phase 19)
  userGetProfile: () => ipcRenderer.invoke(IpcChannel.user.getProfile),
  userApplyProfilePicture: (args) => ipcRenderer.invoke(IpcChannel.user.applyProfilePicture, args),
  userRemoveProfilePicture: () => ipcRenderer.invoke(IpcChannel.user.removeProfilePicture),
  userApplyBackground: (args) => ipcRenderer.invoke(IpcChannel.user.applyBackground, args),
  userRemoveBackground: () => ipcRenderer.invoke(IpcChannel.user.removeBackground),

  getStartupWarnings: () => ipcRenderer.invoke(IpcChannel.app.warnings),

  // --- Skin pipeline ---
  applySkin: (args) => ipcRenderer.invoke(IpcChannel.skin.apply, args),
  removeSkin: (id) => ipcRenderer.invoke(IpcChannel.skin.remove, id),
  uploadSkinPng: () => ipcRenderer.invoke(IpcChannel.skin.uploadPng),
  searchMojangSkin: (u) => ipcRenderer.invoke(IpcChannel.skin.searchMojang, u),
  getSkinServerUrl: () => ipcRenderer.invoke(IpcChannel.skin.getServerUrl),

  // --- Setup wizard ---
  detectMcInstalls: () => ipcRenderer.invoke(IpcChannel.wizard.detectInstalls),
  runWizardInstall: (args) => ipcRenderer.invoke(IpcChannel.wizard.install, args),
  wizardCancel: (sessionId) => ipcRenderer.invoke(IpcChannel.wizard.cancel, sessionId),
  getWizardState: () => ipcRenderer.invoke(IpcChannel.wizard.getState),
  wizardPromptShown: (action: 'get' | 'set') => ipcRenderer.invoke(IpcChannel.wizard.promptShown, action),

  // --- Auth (Phase 10) ---
  signInPassword: (args) => ipcRenderer.invoke(IpcChannel.auth.signinPassword, args),
  signUpPassword: (args) => ipcRenderer.invoke(IpcChannel.auth.signupPassword, args),
  signInGoogle: () => ipcRenderer.invoke(IpcChannel.auth.signinGoogle),
  cancelGoogle: () => ipcRenderer.invoke(IpcChannel.auth.cancelGoogle),
  signOut: () => ipcRenderer.invoke(IpcChannel.auth.signout),
  deleteAccount: () => ipcRenderer.invoke(IpcChannel.auth.deleteAccount),
  exportData: () => ipcRenderer.invoke(IpcChannel.auth.exportData),
  resendVerification: (args) => ipcRenderer.invoke(IpcChannel.auth.resendVerification, args),
  sendPasswordReset: (args) => ipcRenderer.invoke(IpcChannel.auth.sendPasswordReset, args),
  updatePassword: (args) => ipcRenderer.invoke(IpcChannel.auth.updatePassword, args),
  setCaptchaToken: (token: string | null) =>
    ipcRenderer.invoke(IpcChannel.auth.setCaptchaToken, token),

  onAuthState(cb: (state: AuthState) => void) {
    const handler = (_e: Electron.IpcRendererEvent, state: AuthState) => cb(state);
    ipcRenderer.on(IpcChannel.auth.state, handler);
    return () => ipcRenderer.off(IpcChannel.auth.state, handler);
  },

  onPasswordRecovery(cb: () => void) {
    const handler = (): void => cb();
    ipcRenderer.on(IpcChannel.auth.passwordRecovery, handler);
    return () => ipcRenderer.off(IpcChannel.auth.passwordRecovery, handler);
  },

  // --- ToS / Privacy gate (Phase 11 plan 12) ---
  tosStatus: () => ipcRenderer.invoke(IpcChannel.tos.status),
  tosAccept: () => ipcRenderer.invoke(IpcChannel.tos.accept),
  openExternal: (url: string) => ipcRenderer.invoke(IpcChannel.app.openExternal, url),

  // --- Migration prompt (Phase 11 plan 18) ---
  migrationListLocal: () => ipcRenderer.invoke(IpcChannel.migration.listLocal),
  migrationUpload: (uuids: string[]) => ipcRenderer.invoke(IpcChannel.migration.upload, uuids),
  migrationShown: (action: 'get' | 'set') => ipcRenderer.invoke(IpcChannel.migration.shown, action),
  profilePeekLocal: () => ipcRenderer.invoke(IpcChannel.profile.peekLocal),
  profileImportFromLocal: (characterIds?: string[]) =>
    ipcRenderer.invoke(IpcChannel.profile.importFromLocal, characterIds),

  // --- Browse + moderation (Phase 12) ---
  browseList: (args) => ipcRenderer.invoke(IpcChannel.browse.list, args),

  // --- Proxy + billing + plan ---
  proxyConfigure: (kind) => ipcRenderer.invoke(IpcChannel.proxy.configure, { kind }),
  creditsGet: () => ipcRenderer.invoke(IpcChannel.credits.get),
  creditsCatalog: () => ipcRenderer.invoke(IpcChannel.credits.catalog),
  creditsOpenCheckout: (kind) => ipcRenderer.invoke(IpcChannel.credits.openCheckout, { kind }),
  creditsChangePlan: (tier) => ipcRenderer.invoke(IpcChannel.credits.changePlan, { tier }),
  subscriptionStatus: () => ipcRenderer.invoke(IpcChannel.subscription.status),
  subscriptionCancel: () => ipcRenderer.invoke(IpcChannel.subscription.cancel),
  // quick/260525-sbo Task 3 — auto-renewal consent INSERT before checkout.
  recordSubscriptionConsent: (args) =>
    ipcRenderer.invoke(IpcChannel.subscription.recordConsent, args),
  // 260706 — in-app feedback + companion reports.
  feedbackSubmit: (args) => ipcRenderer.invoke(IpcChannel.feedback.submit, args),
  reportSubmit: (args) => ipcRenderer.invoke(IpcChannel.feedback.report, args),
  onCreditsStatusUpdate(cb: (status: CreditsStatus) => void) {
    const handler = (_e: Electron.IpcRendererEvent, status: CreditsStatus): void => cb(status);
    ipcRenderer.on(IpcChannel.credits.statusUpdate, handler);
    return () => ipcRenderer.off(IpcChannel.credits.statusUpdate, handler);
  },
  onCreditsHardStop(cb: (info: CreditsHardStopEvent) => void) {
    const handler = (_e: Electron.IpcRendererEvent, info: CreditsHardStopEvent): void => cb(info);
    ipcRenderer.on(IpcChannel.credits.hardStop, handler);
    return () => ipcRenderer.off(IpcChannel.credits.hardStop, handler);
  },
  onAiBackendKindChanged(cb: (ev: { kind: CreditsStatus['ai_backend_kind'] }) => void) {
    const handler = (
      _e: Electron.IpcRendererEvent,
      ev: { kind: CreditsStatus['ai_backend_kind'] },
    ): void => cb(ev);
    ipcRenderer.on(IpcChannel.proxy.kindChanged, handler);
    return () => ipcRenderer.off(IpcChannel.proxy.kindChanged, handler);
  },

  onStatus(cb: (status: BotStatus) => void) {
    const handler = (_e: Electron.IpcRendererEvent, status: BotStatus) => cb(status);
    ipcRenderer.on(IpcChannel.bot.status, handler);
    return () => ipcRenderer.off(IpcChannel.bot.status, handler);
  },
  getBotStatuses: () => ipcRenderer.invoke(IpcChannel.bot.getStatuses),
  onBotAction(cb: (push: BotActionPush) => void) {
    const handler = (_e: Electron.IpcRendererEvent, push: BotActionPush) => cb(push);
    ipcRenderer.on(IpcChannel.bot.action, handler);
    return () => ipcRenderer.off(IpcChannel.bot.action, handler);
  },
  onVisionCapability(cb: (cap: VisionCapability) => void) {
    const handler = (_e: Electron.IpcRendererEvent, cap: VisionCapability) => cb(cap);
    ipcRenderer.on(IpcChannel.vision.capability, handler);
    return () => ipcRenderer.off(IpcChannel.vision.capability, handler);
  },
  onLog(cb: (batch: LogBatch) => void) {
    const handler = (_e: Electron.IpcRendererEvent, batch: LogBatch) => cb(batch);
    ipcRenderer.on(IpcChannel.bot.logBatch, handler);
    return () => ipcRenderer.off(IpcChannel.bot.logBatch, handler);
  },
  onLan(cb: (state: LanState) => void) {
    const handler = (_e: Electron.IpcRendererEvent, state: LanState) => cb(state);
    ipcRenderer.on(IpcChannel.lan.state, handler);
    return () => ipcRenderer.off(IpcChannel.lan.state, handler);
  },
  getLanState: () => ipcRenderer.invoke(IpcChannel.lan.get),
  lanCheckNow: () => ipcRenderer.invoke(IpcChannel.lan.checkNow),
  onWizardProgress(cb: (ev: WizardProgressEvent) => void) {
    const handler = (_e: Electron.IpcRendererEvent, ev: WizardProgressEvent) => cb(ev);
    ipcRenderer.on(IpcChannel.wizard.progress, handler);
    return () => ipcRenderer.off(IpcChannel.wizard.progress, handler);
  },
  onExpansionProgress(cb: (ev: ExpansionProgressEvent) => void) {
    const handler = (_e: Electron.IpcRendererEvent, ev: ExpansionProgressEvent) => cb(ev);
    ipcRenderer.on(IpcChannel.chars.expansionProgress, handler);
    return () => ipcRenderer.off(IpcChannel.chars.expansionProgress, handler);
  },

  // 260703 procgen — unique-companion generation + questionnaire prefs.
  generateUnique: (input) => ipcRenderer.invoke(IpcChannel.gen.start, input),
  onGenProgress(cb: (ev: GenProgressEvent) => void) {
    const handler = (_e: Electron.IpcRendererEvent, ev: GenProgressEvent) => cb(ev);
    ipcRenderer.on(IpcChannel.gen.progress, handler);
    return () => ipcRenderer.off(IpcChannel.gen.progress, handler);
  },
  prefsGet: () => ipcRenderer.invoke(IpcChannel.prefs.get),
  prefsSave: (profile) => ipcRenderer.invoke(IpcChannel.prefs.save, profile),
  onUpdateAvailable(cb: (info: UpdateAvailableEvent) => void) {
    const handler = (_e: Electron.IpcRendererEvent, info: UpdateAvailableEvent) => cb(info);
    ipcRenderer.on(IpcChannel.app.updateAvailable, handler);
    return () => ipcRenderer.off(IpcChannel.app.updateAvailable, handler);
  },
  onUpdateChecking(cb: () => void) {
    const handler = () => cb();
    ipcRenderer.on(IpcChannel.app.updateChecking, handler);
    return () => ipcRenderer.off(IpcChannel.app.updateChecking, handler);
  },
  onUpdateNotAvailable(cb: () => void) {
    const handler = () => cb();
    ipcRenderer.on(IpcChannel.app.updateNotAvailable, handler);
    return () => ipcRenderer.off(IpcChannel.app.updateNotAvailable, handler);
  },
  onUpdateProgress(cb: (ev: UpdateProgressEvent) => void) {
    const handler = (_e: Electron.IpcRendererEvent, ev: UpdateProgressEvent) => cb(ev);
    ipcRenderer.on(IpcChannel.app.updateProgress, handler);
    return () => ipcRenderer.off(IpcChannel.app.updateProgress, handler);
  },
  onUpdateDownloaded(cb: (ev: UpdateDownloadedEvent) => void) {
    const handler = (_e: Electron.IpcRendererEvent, ev: UpdateDownloadedEvent) => cb(ev);
    ipcRenderer.on(IpcChannel.app.updateDownloaded, handler);
    return () => ipcRenderer.off(IpcChannel.app.updateDownloaded, handler);
  },
  onUpdateError(cb: (message: string) => void) {
    const handler = (_e: Electron.IpcRendererEvent, message: string) => cb(message);
    ipcRenderer.on(IpcChannel.app.updateError, handler);
    return () => ipcRenderer.off(IpcChannel.app.updateError, handler);
  },
  onWhatsNew(cb: (ev: WhatsNewEvent) => void) {
    const handler = (_e: Electron.IpcRendererEvent, ev: WhatsNewEvent) => cb(ev);
    ipcRenderer.on(IpcChannel.app.whatsNew, handler);
    return () => ipcRenderer.off(IpcChannel.app.whatsNew, handler);
  },
  getWhatsNew: () => ipcRenderer.invoke(IpcChannel.app.whatsNewGet),
  checkForUpdates: () => ipcRenderer.invoke(IpcChannel.app.updateCheck),
  setUpdateChannel: (advanced: boolean) =>
    ipcRenderer.invoke(IpcChannel.app.updateSetChannel, advanced),
  downloadUpdate: () => ipcRenderer.invoke(IpcChannel.app.updateDownload),
  installUpdate: () => ipcRenderer.invoke(IpcChannel.app.updateInstall),
  getVersion: () => ipcRenderer.invoke(IpcChannel.app.version),

  // --- Notices inbox (260725) ---
  onNotices(cb: (snapshot: NoticesSnapshot) => void) {
    const handler = (_e: Electron.IpcRendererEvent, snapshot: NoticesSnapshot) => cb(snapshot);
    ipcRenderer.on(IpcChannel.app.notices, handler);
    return () => ipcRenderer.off(IpcChannel.app.notices, handler);
  },
  getNotices: () => ipcRenderer.invoke(IpcChannel.app.noticesGet),
  ackNotices: () => ipcRenderer.invoke(IpcChannel.app.noticesAck),
  markNoticeRead: (id: string) => ipcRenderer.invoke(IpcChannel.app.noticesRead, id),

  // --- Window chrome (frameless custom titlebar on Windows/Linux) ---
  platform: process.platform,
  windowMinimize: () => ipcRenderer.invoke(IpcChannel.window.minimize),
  windowMaximizeToggle: () => ipcRenderer.invoke(IpcChannel.window.maximizeToggle),
  windowClose: () => ipcRenderer.invoke(IpcChannel.window.close),
  windowIsMaximized: () => ipcRenderer.invoke(IpcChannel.window.isMaximized),
  windowFullscreenToggle: () => ipcRenderer.invoke(IpcChannel.window.fullscreenToggle),
  windowIsFullscreen: () => ipcRenderer.invoke(IpcChannel.window.isFullscreen),
  onWindowMaximizedChanged(cb: (isMaximized: boolean) => void) {
    const handler = (_e: Electron.IpcRendererEvent, isMaximized: boolean) => cb(isMaximized);
    ipcRenderer.on(IpcChannel.window.maximizedChanged, handler);
    return () => ipcRenderer.off(IpcChannel.window.maximizedChanged, handler);
  },
  onScopeChanged(cb: (ev: ScopeChangedEvent) => void) {
    const handler = (_e: Electron.IpcRendererEvent, ev: ScopeChangedEvent) => cb(ev);
    ipcRenderer.on(IpcChannel.app.scopeChanged, handler);
    return () => ipcRenderer.off(IpcChannel.app.scopeChanged, handler);
  },

  // --- Onboarding chrome toggle (260728) ---
  windowSetButtonsVisible: (visible: boolean) =>
    ipcRenderer.invoke(IpcChannel.window.setButtonsVisible, visible),

  // --- Factory reset (260728) ---
  factoryReset: () => ipcRenderer.invoke(IpcChannel.app.factoryReset),
};

contextBridge.exposeInMainWorld('sei', api);
