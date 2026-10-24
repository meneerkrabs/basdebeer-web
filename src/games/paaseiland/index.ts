import type { MinigameRegistry } from '../types.ts';

/** {PLAY_GAME}n~ in the Paaseiland scripts -> TfrmGn. */
export const paaseilandGames: MinigameRegistry = {
  '1': () => import('./g1-rongorongo.ts'),
  '2': () => import('./g2-sorteer.ts'),
  '3': () => import('./g3-geheugen.ts'),
  '4': () => import('./g4-voetbal.ts'),
  '5': () => import('./g5-harmonica.ts'),
};
