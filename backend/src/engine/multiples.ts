// Shared "Nx" ladder used by both wallet PnL and watchlist baseline alerts.
// We alert when price crosses 2x, 3x, 5x, 10x, … exactly once per rung.

export const MULTIPLE_LADDER = [2, 3, 5, 10, 25, 50, 100, 250, 500, 1000];

/**
 * Given the current multiple and the highest rung already alerted, return the
 * top rung newly crossed (so a jump from 1x→6x reports 5x), or null if none.
 */
export function highestNewRung(
  currentMultiple: number,
  maxAlerted: number,
): number | null {
  let hit: number | null = null;
  for (const rung of MULTIPLE_LADDER) {
    if (currentMultiple >= rung && rung > maxAlerted) hit = rung;
  }
  return hit;
}
