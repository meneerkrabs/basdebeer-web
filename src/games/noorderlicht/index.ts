import type { MinigameRegistry } from '../types.ts';

/**
 * {PLAY_GAME}n~ in the Noorderlicht scripts (spec 7.1). Some forms serve two games
 * (GMG: 3 mine cart / 6 ski; GIS: 7 ice floes / 9 mountain).
 * Results: 0 = stop (book closes), 1 = next page, 2 = previous page.
 */
export const noorderlichtGames: MinigameRegistry = {
  '1': () => import('./gsb.ts'),
  '2': () => import('./gtq.ts'),
  '3': () => import('./gmg.ts').then((m) => ({ default: m.gmgGame('mine'), title: m.title })),
  '4': () => import('./gso.ts'),
  '5': () => import('./gsd.ts'),
  '6': () => import('./gmg.ts').then((m) => ({ default: m.gmgGame('ski'), title: m.title })),
  '7': () => import('./gis.ts'),
  '8': () => import('./gbd.ts'),
  '9': () => import('./gis.ts').then((m) => ({ default: m.gisGame(1), title: m.title })),
};
