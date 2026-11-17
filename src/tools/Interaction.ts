import type { BlockChange, BlockMap } from '../terrain/blocks';
import type { SceneRenderer, Tool } from '../view/SceneRenderer';
import { BuildTool } from './BuildTool';
import { LosTool } from './LosTool';
import { MeasureTool } from './MeasureTool';
import { MoveTokenTool } from './MoveTokenTool';
import { OrbitTool } from './OrbitTool';
import { SculptTool } from './SculptTool';
import { CLICK_SLOP_PX, type BuildState, type MeasureState, type ToolContext, type ToolHandler } from './ToolController';

export interface InteractionHooks {
  map(): BlockMap;
  build(): BuildState;
  measure(): MeasureState;
  unit(): { distance: number; label: string };
  canEdit(): boolean;
  onStrokeEnd(changes: BlockChange[]): void;
  onSelect(id: string | null): void;
  onHover(id: string | null, clientX: number, clientY: number): void;
  onHoverTerrain?(point: { x: number; y: number; z: number } | null): void;
  onContextMenu(id: string, clientX: number, clientY: number): void;
  diameterOf(id: string): number | null;
  onMoveToken(id: string, x: number, y: number, floorCeiling?: number): void;
  onMeasurePinCountChange?(count: number): void;
  canMove(): boolean;
  grid(): { size: number; offsetX: number; offsetY: number; snapToGrid?: boolean } | null;
}

/**
 * Lightweight pointer dispatcher delegating to the active tool handler
 * (`OrbitTool`, `SculptTool`, `BuildTool`, `MoveTokenTool`, `MeasureTool`, `LosTool`).
 */
export class Interaction {
  tool: Tool = 'orbit';
  brush = 1;
  private altRemove = false;
  private rightDown: { x: number; y: number } | null = null;
  private last: PointerEvent | null = null;
  private readonly abort = new AbortController();
  private readonly measureTool: MeasureTool;
  private readonly losTool: LosTool;
  private readonly handlers: Record<Tool, ToolHandler>;

  constructor(private readonly view: SceneRenderer, private readonly hooks: InteractionHooks) {
    const ctx: ToolContext = {
      view,
      map: () => hooks.map(),
      build: () => hooks.build(),
      measure: () => hooks.measure(),
      unit: () => hooks.unit(),
      canEdit: () => hooks.canEdit(),
      canMove: () => hooks.canMove(),
      brush: () => this.brush,
      altRemove: () => this.altRemove,
      grid: () => hooks.grid(),
      diameterOf: (id) => hooks.diameterOf(id),
      onStrokeEnd: (changes) => hooks.onStrokeEnd(changes),
      onSelect: (id) => hooks.onSelect(id),
      onHover: (id, x, y) => hooks.onHover(id, x, y),
      onMoveToken: (id, x, y, floorCeiling) => hooks.onMoveToken(id, x, y, floorCeiling),
      onMeasurePinCountChange: (count) => hooks.onMeasurePinCountChange?.(count),
    };

    this.measureTool = new MeasureTool(ctx);
    this.losTool = new LosTool(ctx);

    this.handlers = {
      orbit: new OrbitTool(ctx),
      raise: new SculptTool(ctx, 'raise'),
      lower: new SculptTool(ctx, 'lower'),
      build: new BuildTool(ctx),
      move: new MoveTokenTool(ctx),
      measure: this.measureTool,
      los: this.losTool,
    };

    const { signal } = this.abort;
    const canvas = view.canvas;
    canvas.addEventListener('pointerdown', (e) => this.onDown(e), { signal });
    canvas.addEventListener('pointermove', (e) => this.onMove(e), { signal });
    canvas.addEventListener('pointerup', (e) => this.onUp(e), { signal });
    canvas.addEventListener('pointercancel', () => this.active().onCancel?.(), { signal });
    canvas.addEventListener('pointerleave', (e) => {
      this.hooks.onHover(null, e.clientX, e.clientY);
      this.hooks.onHoverTerrain?.(null);
      this.active().onLeave?.();
    }, { signal });
    canvas.addEventListener('dblclick', (e) => this.active().onDoubleClick?.(e), { signal });
    canvas.addEventListener('contextmenu', (e) => this.onContextMenu(e), { signal });
  }

  setTool(tool: Tool): void {
    this.active().onCancel?.();
    this.tool = tool;
    this.view.setTool(tool);
    this.view.setCursor(null, this.brush, tool);
    this.view.setGhost(null);
    this.view.setMoveTarget(null);
  }

  setAlt(on: boolean): void {
    if (this.altRemove === on) return;
    this.altRemove = on;
    this.active().onAltChange?.(on, this.last);
  }

  refreshGhost(): void {
    if (this.tool === 'build') this.active().onRefresh?.(this.last);
    else this.view.setGhost(null);
  }

  addMeasureWaypoint(): boolean {
    return this.tool === 'measure' && this.measureTool.addWaypoint();
  }

  unpinMeasure(id: string): void {
    this.measureTool.unpin(id);
  }

  clearPinnedMeasures(): void {
    this.measureTool.clearPinned();
  }

  cancelActiveTool(): void {
    this.active().onCancel?.();
  }

  refreshTactical(): void {
    this.measureTool.refresh();
    this.losTool.refresh();
  }

  dispose(): void {
    this.abort.abort();
  }

  private active(): ToolHandler {
    return this.handlers[this.tool];
  }

  private onDown(e: PointerEvent): void {
    if (e.button === 2) this.rightDown = { x: e.clientX, y: e.clientY };
    if (e.button !== 0) return;
    this.last = e;
    const tokenHit = this.view.pickToken(e);
    this.active().onDown?.(e, tokenHit);
  }

  private onMove(e: PointerEvent): void {
    this.last = e;
    const terrainPt = this.view.pickGroundOrPlane(e, 0);
    this.hooks.onHoverTerrain?.(terrainPt ? { x: terrainPt.x, y: terrainPt.y, z: terrainPt.z } : null);
    this.active().onMove?.(e);
  }

  private onUp(e: PointerEvent): void {
    if (e.button !== 0) return;
    this.active().onUp?.(e);
  }

  private onContextMenu(e: MouseEvent): void {
    e.preventDefault();
    const down = this.rightDown;
    this.rightDown = null;
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) >= CLICK_SLOP_PX) return;
    if (this.active().onRightClick?.()) return;
    if (this.tool !== 'orbit' && this.tool !== 'move') return;
    const token = this.view.pickToken(e);
    if (token !== null) this.hooks.onContextMenu(token, e.clientX, e.clientY);
  }
}