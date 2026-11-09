/**
 * Channels between the SeiLink room host process and its own page (261104).
 * Host-internal: they never reach the main app, so they are not in
 * IpcChannel. src/preload/seilinkHost.ts spells the same names out (it may
 * not import this file) and seilinkHostChannels.test.ts keeps them equal.
 */
export const SEILINK_HOST_CHANNELS = {
  /** host -> page: SeilinkRoomPayload. */
  room: 'seilink-host:room',
  /** host -> page: the frame cap now. */
  fps: 'seilink-host:fps',
  /** host -> page: SeilinkPokeKind. */
  poke: 'seilink-host:poke',
  /** page -> host: SeilinkBox | null. */
  box: 'seilink-host:box',
  /** page -> host: frames drawn so far. */
  frames: 'seilink-host:frames',
  /** page -> host: first frame of the scene on screen. */
  firstFrame: 'seilink-host:first-frame',
  /** page -> host: mounted, send the room. */
  ready: 'seilink-host:ready',
  /** host -> page: busy (chatting with her, or a click just now). */
  busy: 'seilink-host:busy',
  /** page -> host (invoke): an avatar bridge call (SeilinkHostAvatarMethod, args), relayed to main. */
  call: 'seilink-host:call',
  /** host -> page: {characterId, manifest}, her imported avatar changed. */
  avatarManifest: 'seilink-host:avatar-manifest',
  /** host -> page: SeilinkHostLayout (M4). */
  layout: 'seilink-host:layout',
  /** host -> page: SeilinkDockState. */
  dockState: 'seilink-host:dock-state',
  /** host -> page: SeilinkDockAction, a press on that dock button. */
  dockPress: 'seilink-host:dock-press',
  /** page -> host: SeilinkDockButton[] | null. */
  dock: 'seilink-host:dock',
  /** page -> host: SeilinkDockAction, confirmed. */
  dockAction: 'seilink-host:dock-action',
  /** host -> page: SeilinkHostLine. */
  line: 'seilink-host:line',
  /** host -> page: boolean, her voice is playing in the main window (261110). */
  voice: 'seilink-host:voice',
  /** host -> page: number 0..1, her voice's level (261110). */
  level: 'seilink-host:level',
  /** host -> page: boolean, the cursor is over the dock (261110: it wakes up). */
  hover: 'seilink-host:hover',
  /** host -> page: a press went down on her (261110: she reacts at once). */
  press: 'seilink-host:press',
} as const;
