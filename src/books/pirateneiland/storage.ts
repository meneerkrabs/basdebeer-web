// The bookmark ("boekenlegger", BASWIN.INI [Boekenlegger] Pagina). The game/movie flags live in shared.ts.

export const LEGGER_KEY = 'bdb-pirateneiland-legger';

export function readLegger(): number {
  try {
    const n = parseInt(localStorage.getItem(LEGGER_KEY) ?? '0', 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function writeLegger(page: number) {
  try {
    localStorage.setItem(LEGGER_KEY, String(page));
  } catch { /* storage unavailable: no bookmark */ }
}
