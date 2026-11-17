import { snapCenter, type ToolContext, type ToolHandler } from './ToolController';

interface DragState {
  id: string;
  diameter: number;
  startGroundY: number;
  lift: number;
  dragPlaneY: number;
  grabOffset: { x: number; z: number };
  screenOffset: { x: number; y: number };
  targetPx: { x: number; y: number } | null;
  targetFloorY: number;
}

export class MoveTokenTool implements ToolHandler {
  private drag: DragState | null = null;

  constructor(private readonly ctx: ToolContext) {}

  onDown(e: PointerEvent, tokenHit: string | null): void {
    if (tokenHit === null) return;
    this.ctx.onSelect(tokenHit);
    const diameter = this.ctx.diameterOf(tokenHit);
    if (diameter === null || !this.ctx.canMove()) return;

    this.ctx.onHover(null, e.clientX, e.clientY);
    const info = this.ctx.view.tokenDragInfo(tokenHit);
    if (!info) return;

    const dragPlaneY = info.groundY + info.lift;
    const planeHit = this.ctx.view.pickPlane(e, dragPlaneY);
    const grabOffset = planeHit
      ? { x: info.x - planeHit.x, z: info.z - planeHit.z }
      : { x: 0, z: 0 };

    const baseClient = this.ctx.view.projectToClient(info.x, dragPlaneY, info.z);
    const screenOffset = baseClient
      ? { x: baseClient.x - e.clientX, y: baseClient.y - e.clientY }
      : { x: 0, y: 0 };

    this.drag = {
      id: tokenHit,
      diameter,
      startGroundY: info.groundY,
      lift: info.lift,
      dragPlaneY,
      grabOffset,
      screenOffset,
      targetPx: null,
      targetFloorY: info.groundY,
    };
  }

  onMove(e: PointerEvent): void {
    if (!this.drag) {
      this.ctx.onHover(this.ctx.view.pickToken(e), e.clientX, e.clientY);
      return;
    }
    const grid = this.ctx.grid();
    if (!grid) return;

    let wx: number;
    let wz: number;
    let floorCeiling: number;

    if (this.drag.lift > 0.02) {
      const planeHit = this.ctx.view.pickPlane(e, this.drag.dragPlaneY);
      if (!planeHit) return;
      wx = planeHit.x + this.drag.grabOffset.x;
      wz = planeHit.z + this.drag.grabOffset.z;
      floorCeiling = this.drag.dragPlaneY;
    } else {
      const surfaceHit = this.ctx.view.pickMoveSurfaceAt(
        e.clientX + this.drag.screenOffset.x,
        e.clientY + this.drag.screenOffset.y,
        this.drag.dragPlaneY,
      );
      if (surfaceHit) {
        wx = surfaceHit.point.x;
        wz = surfaceHit.point.z;
        floorCeiling = surfaceHit.floorCeiling;
      } else {
        const fallbackHit = this.ctx.view.pickPlane(e, this.drag.dragPlaneY);
        if (!fallbackHit) return;
        wx = fallbackHit.x + this.drag.grabOffset.x;
        wz = fallbackHit.z + this.drag.grabOffset.z;
        floorCeiling = this.drag.startGroundY;
      }
    }

    // 1. Free, smooth movement preview following the grabbed token without initial jump
    const freePx = {
      x: Math.round(wx * grid.size),
      y: Math.round(wz * grid.size),
    };
    this.ctx.view.previewToken(this.drag.id, freePx, floorCeiling);

    // 2. Final landing target (snapped to grid unless snapToGrid is off) + FFT landing tile marker
    const snap = grid.snapToGrid !== false;
    const targetPx = snap
      ? snapCenter(wx, wz, this.drag.diameter, grid)
      : freePx;
    this.drag.targetPx = targetPx;
    this.drag.targetFloorY = floorCeiling;

    this.ctx.view.setMoveTarget({
      x: targetPx.x / grid.size,
      z: targetPx.y / grid.size,
      diameter: this.drag.diameter,
      snap,
      floorCeiling,
    });
  }

  onUp(): void {
    if (!this.drag) return;
    const { id, targetPx, targetFloorY } = this.drag;
    this.drag = null;
    this.ctx.view.setMoveTarget(null);
    this.ctx.view.previewToken(id, null);
    if (targetPx) this.ctx.onMoveToken(id, targetPx.x, targetPx.y, targetFloorY);
  }

  onDoubleClick(e: MouseEvent): void {
    const tokenId = this.ctx.view.pickToken(e);
    if (tokenId !== null && this.ctx.view.focusOnToken(tokenId)) return;
    const point = this.ctx.view.pickGroundOrPlane(e, 0);
    if (point) this.ctx.view.focusOnPoint(point);
  }

  onCancel(): void {
    if (!this.drag) return;
    this.ctx.view.setMoveTarget(null);
    this.ctx.view.previewToken(this.drag.id, null);
    this.drag = null;
  }
}