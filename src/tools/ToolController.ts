import type { BlockChange, BlockMap, Rotation } from '../terrain/blocks';
import type { AoEShape } from '../terrain/raycast';
import type { BlockShape } from '../terrain/shapes';
import type { SceneRenderer } from '../view/SceneRenderer';

export type BuildMode = 'add' | 'rotate' | 'remove';

export interface BuildState {
  mode: BuildMode;
  shape: BlockShape;
  rot: Rotation;
  /** Top colour for new blocks, `#rrggbb`; null = the map's preset. */
  top: string | null;
}

export interface MeasureState {
  shape: AoEShape;
  keep: boolean;
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

export function snapCenter(
  x: number,
  z: number,
  diameter: number,
  grid: { size: number; offsetX: number; offsetY: number },
): { x: number; y: number } {
  const gx = x - grid.offsetX / grid.size;
  const gz = z - grid.offsetY / grid.size;
  const even = Math.round(diameter) % 2 === 0;
  const snap = (g: number): number => (even ? Math.round(g) : Math.floor(g) + 0.5);
  return { x: grid.offsetX + snap(gx) * grid.size, y: grid.offsetY + snap(gz) * grid.size };
}