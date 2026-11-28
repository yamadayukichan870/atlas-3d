/**
 * A token's footprint, as Atlas holds it. Ported from
 * `pixi/token-renderer/tokenSizing.ts` and `tokenSizeOptions.ts`.
 *
 * THE STORE HOLDS A MULTIPLIER, THE MENU SHOWS THE FOOTPRINT. `size` is n where the diameter is
 * 2n − 1 cells: Tiny is stored 0.75 and reads 0,5×0,5; Small is 0.875 and reads 0,75×0,75; Large
 * is 1.5 and reads 2×2. Confusing the two is what made a resize land on the wrong cell.
 *
 * THE LADDER IS NOT INTEGERS. Atlas' own `resizedTokenSize` steps through
 * [0.75, 0.875, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5]. Stepping `size ± 1` with a floor of 1 — what
 * our HUD arrows did — can never reach Tiny or Small, and jumps Medium straight to 3 cells.
 *
 * Pure: no three.js, no DOM, so the ladder and the snapping are tested in Node.
 */

/** Atlas' TOKEN_SIZE_OPTIONS, in its order. The label key is Atlas'; the text is ours to localise. */
export const TOKEN_SIZE_OPTIONS: readonly { readonly id: string; readonly size: number }[] = [
  { id: 'tiny', size: 0.75 },
  { id: 'small', size: 0.875 },
  { id: 'medium', size: 1 },
  { id: 'large', size: 1.5 },
  { id: 'huge', size: 2 },
  { id: 'gargantuan', size: 2.5 },
];

/** Atlas' CREATURE_SIZE_MULTIPLIERS: the word a statblock's size field carries. */
const CREATURE_SIZE_MULTIPLIERS: Readonly<Record<string, number>> = {
  tiny: 0.75, small: 0.875, medium: 1, large: 1.5, huge: 2, gargantuan: 2.5,
};

/** Atlas' resizedTokenSize ladder: eleven rungs, up to a 9×9 footprint. */
const SIZE_LADDER: readonly number[] = [0.75, 0.875, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5];

/** Diameter in cells covered by a token of the given size multiplier. Atlas' own formula. */
export function tokenDiameterInCells(size: number): number {
  return 2 * size - 1;
}

/**
 * The size `steps` rungs away from `initialSize`, clamped to the ladder. Atlas' own rule: find the
 * NEAREST rung first, so a token whose stored size is off-ladder (an older file, a hand edit) steps
 * from where it reads, not from a rung it is not on.
 */
export function resizedTokenSize(initialSize: number, steps: number): number {
  if (steps === 0) return initialSize;
  const from = Number.isFinite(initialSize) ? initialSize : 1;
  const index = SIZE_LADDER.reduce((nearest, size, i) =>
    Math.abs(size - from) < Math.abs(SIZE_LADDER[nearest]! - from) ? i : nearest, 0);
  return SIZE_LADDER[Math.max(0, Math.min(SIZE_LADDER.length - 1, index + steps))]!;
}

/** Size multiplier for a creature size word ("Large", "Huge or larger"); undefined when unknown. */
export function tokenSizeFromCreatureSize(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const word = value.trim().toLowerCase().split(/\s+/)[0] ?? '';
  return CREATURE_SIZE_MULTIPLIERS[word];
}

/** Whether a footprint is a quarter-cell one — Tiny — which snaps to quarters, not to centres. */
export function isQuarterCellToken(diameter: number): boolean {
  return Number.isFinite(diameter) && diameter > 0 && diameter <= 0.5;
}