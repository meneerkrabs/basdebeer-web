import type { MinigameRegistry } from '../types.ts';

/** {PLAY_GAME}n~ in the Paaseiland scripts -> TfrmGn. */
export const paaseilandGames: MinigameRegistry = {
  '1': () => import('./g1-rongorongo.ts'),
};
