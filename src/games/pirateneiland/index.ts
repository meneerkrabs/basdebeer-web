import type { MinigameRegistry } from '../types.ts';

/**
 * {PLAY_GAME}NAME~lostPage~ in the Pirateneiland scripts -> TfrmG1..G6 of BBOEK32.EXE.
 * Exit codes: 2 = won, 3 = lost (the script then jumps to lostPage).
 */
export const pirateneilandGames: MinigameRegistry = {
  GROTSPEL: () => import('./g6-grot.ts'),
  MEMORYSPEL: () => import('./g5-memory.ts'),
  KOKOSSPEL: () => import('./g4-kokos.ts'),
  MOTTENSPEL: () => import('./g1-motten.ts'),
  KISTENSPEL: () => import('./g2-kisten.ts'),
  ROEISPEL: () => import('./g3-roeien.ts'),
};
