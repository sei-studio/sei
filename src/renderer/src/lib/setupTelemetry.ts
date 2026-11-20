/**
 * Renderer side of `game_setup_step` (261104, shape only). The props are
 * built by the shared builder and rebuilt again in main's analytics:track
 * handler, so nothing but closed enums and codes can leave the machine.
 */
import { GAME_SETUP_EVENT, setupStepProps, type SetupStepInput } from '@shared/setupTelemetry';
import { sei } from './ipcClient';

export function trackSetupStep(input: SetupStepInput): void {
  try {
    sei.track(GAME_SETUP_EVENT, setupStepProps(input));
  } catch {
    /* analytics is never load-bearing */
  }
}
