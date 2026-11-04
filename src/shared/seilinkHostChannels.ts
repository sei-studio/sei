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
} as const;
