import type { AtlasMeasure, AtlasMeasureChanges, AtlasPoint, AtlasSceneRules, AtlasTokenAura } from '../atlas/types';
import type { AtlasMeasureMode } from '../atlas/measureRules';
import type { AreaTokenTarget } from '../terrain/measureGeometry';
import type { BlockChange, BlockMap, Rotation } from '../terrain/blocks';
import type { AoEShape } from '../terrain/raycast';
import type { BlockShape } from '../terrain/shapes';
import type { SceneRenderer } from '../view/SceneRenderer';
import { isQuarterCellToken } from '../tokens/tokenSizes';

export type BuildMode = 'add' | 'rotate' | 'remove';

export interface BuildState {
  mode: BuildMode;
  shape: BlockShape;
  rot: Rotation;
  /** Top colour for new blocks, `#rrggbb`; null = the map's preset. */
  top: string | null;
}

/**
 * The measure tool's local choices.
 *
 * `shape` is the legacy four-name union the current producers still read; it stays required so
 * they compile. `mode` is the Atlas six-name mode and wins once a producer sets it. The Look
 * fields mirror Atlas's MeasureToolOptions so a measurement created here can be handed to Atlas
 * unchanged (players -> hidden, lineWidth in cells -> width in pixels).
 */
export interface MeasureState {
  shape: AoEShape;
  keep: boolean;
  /** The Atlas mode; when present it is what the tool draws and stores. */
  mode?: AtlasMeasureMode;
  /** Players see it (Atlas stores the inverse as `hidden`). */
  players?: boolean;
  /** '#rrggbb', or null for the theme's accent. */
  color?: string | null;
  /** The Look effect name, or null for the plain wash. */
  effect?: string | null;
  /** Width of the next line, in cells (1-20). */
  lineWidth?: number;
}

export interface ToolContext {
  readonly view: SceneRenderer;
  map(): BlockMap;
  build(): BuildState;
  measure(): MeasureState;
  unit(): { distance: number; label: string };
  canEdit(): boolean;
  canMove(): boolean;
  brush(): number;
  altRemove(): boolean;
  grid(): { size: number; offsetX: number; offsetY: number; snapToGrid?: boolean } | null;
  diameterOf(id: string): number | null;
  onStrokeEnd(changes: BlockChange[]): void;
  onSelect(id: string | null): void;
  onHover(id: string | null, clientX: number, clientY: number): void;
  onMoveToken(id: string, x: number, y: number, floorCeiling?: number): void;
  onMeasurePinCountChange?(count: number): void;

  // ---- Atlas parity (optional until the scene wires them) -------------------------------------
  /** The rules this scene measures and moves by, as Atlas resolves them. */
  rules?(): AtlasSceneRules;
  /** Kept measurements + auras of the level shown, as Atlas holds them. */
  measures?(): readonly AtlasMeasure[];
  selectedIds?(): readonly string[];
  /** Logical token footprints for area coverage and ranges (never the TileShare-offset position). */
  tokenTargets?(): readonly AreaTokenTarget[];
  isPlayerView?(): boolean;
  /** Keep a measurement in Atlas; returns its id, or null at the level's cap. */
  onAddMeasure?(payload: {
    shape: Exclude<AtlasMeasureMode, 'ranges'>;
    points: readonly AtlasPoint[];
    widthCells?: number;
    color?: string | null;
    players?: boolean;
    effect?: string | null;
    follows?: string;
    aura?: number;
  }): string | null;
  onUpdateMeasure?(id: string, changes: AtlasMeasureChanges): boolean;
  onDeleteMeasure?(id: string): boolean;
  onClearMeasures?(): boolean;
  onSelectMany?(ids: readonly string[]): void;
  onMeasureTool?(updates: Record<string, unknown>): boolean;
  onSetTokenAuras?(auras: readonly AtlasTokenAura[], look?: { color?: string | null; hidden?: boolean }): boolean;
}

export interface ToolHandler {
  onDown?(e: PointerEvent, tokenHit: string | null): void;
  onMove?(e: PointerEvent): void;
  onUp?(e: PointerEvent): void;
  onDoubleClick?(e: MouseEvent): void;
  onRightClick?(): boolean;
  onAltChange?(on: boolean, lastEvent: PointerEvent | null): void;
  onRefresh?(lastEvent: PointerEvent | null): void;
  onLeave?(): void;
  onCancel?(): void;
}

export const CLICK_SLOP_PX = 5;

/**
 * Where a token of `diameter` cells lands when dropped at (x, z), in world pixels.
 *
 * THREE RULES, Atlas' own (`grid/gridPlacement.ts`, `snapTokenCenter`):
 *   - a QUARTER-cell footprint (Tiny, diameter 0.5) takes the quarter of the cell the pointer lies
 *     in: the cell's centre, moved a quarter cell towards the pointer on each axis. It used to fall
 *     through to the even branch below — `Math.round(0.5)` is 0, which reads as even — and landed on
 *     the corner where four cells meet, which is no quarter of any of them.
 *   - an ODD whole footprint centres on its cell;
 *   - an EVEN one centres where cells meet, half a cell down and right of the cell it starts from.
 *
 * Small (diameter 0.75) rounds to 1 and so shares Medium's cell: Atlas' own comment, "Small only
 * changes the artwork, not the occupied cell".
 */
export function snapCenter(
  x: number,
  z: number,
  diameter: number,
  grid: { size: number; offsetX: number; offsetY: number },
): { x: number; y: number } {
  const gx = x - grid.offsetX / grid.size;
  const gz = z - grid.offsetY / grid.size;
  if (isQuarterCellToken(diameter)) {
    // The cell the pointer lies in, its centre, then a quarter cell towards the pointer's side.
    // A tie goes up and left, as Atlas' `point <= cell` does.
    const cx = Math.floor(gx), cz = Math.floor(gz);
    const centreX = cx + 0.5, centreZ = cz + 0.5;
    return {
      x: grid.offsetX + (centreX + (gx <= centreX ? -0.25 : 0.25)) * grid.size,
      y: grid.offsetY + (centreZ + (gz <= centreZ ? -0.25 : 0.25)) * grid.size,
    };
  }
  const even = Math.round(diameter) % 2 === 0;
  const snap = (g: number): number => (even ? Math.round(g) : Math.floor(g) + 0.5);
  return { x: grid.offsetX + snap(gx) * grid.size, y: grid.offsetY + snap(gz) * grid.size };
}

/**
 * The one surface/token pick the measure and LoS tools share, in world units.
 *
 * A token hit returns the token's LOGICAL centre (its stored x/y over the grid), never the
 * TileShare-offset visual position, so diagonal rules count whole cells. Otherwise it is the
 * terrain pick, snapped to a cell centre when `snap` is on. Height is the picked surface's.
 */
export function pickPoint(
  ctx: ToolContext,
  e: PointerEvent,
  snap: boolean,
  tokenHit: string | null,
): [number, number, number] | null {
  if (tokenHit !== null) {
    const target = ctx.tokenTargets?.().find((t) => t.id === tokenHit);
    const grid = ctx.grid();
    if (target && grid && grid.size > 0) {
      const info = ctx.view.tokenDragInfo(tokenHit);
      const y = info ? info.groundY + (info.lift ?? 0) : 0;
      return [target.x, y, target.z];
    }
  }
  const p = ctx.view.pickMeasurePoint(e, snap);
  return p ? [p.x, p.y, p.z] : null;
}