import { CLICK_SLOP_PX, snapCenter, type ToolContext, type ToolHandler } from './ToolController';

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

interface MarqueeRect { x0: number; y0: number; x1: number; y1: number }

/**
 * The select-and-move tool: Atlas' own `move`, and the 3D map's only neutral tool.
 *
 * MERGED FROM OrbitTool AND MoveTokenTool, which each held half of one gesture. Verified in
 * both upstreams that this is ONE tool, not two: Atlas installs its drag plugin ONCE on the
 * viewport (`new MouseDrag(viewport, { mouseButtons: 'right', pressDrag: true })`, "The right
 * button pans, for a mouse alone"), so selecting and moving with the left and navigating with
 * the right are the same tool; its toolbar catalog has one `move` id, no orbit. IsoCON puts
 * rotate/pan on the right/middle, swapped by `PanWithRight`, and leaves the left free for tokens.
 *
 * THREE LEFT-BUTTON GESTURES, told apart by where the press landed and how far it moved:
 *   - press on a token, drag      -> move that token (written back to Atlas on release)
 *   - press on a token, Shift     -> add/remove it from the selection, no drag
 *   - press on empty ground, drag -> a MARQUEE: a screen rectangle that selects every token
 *                                    whose centre falls inside it; Shift makes it additive
 *   - a clean click on empty ground deselects; a clean Shift+click there keeps the set
 *
 * The camera is never this tool's — right drag pans and the pressed wheel rotates in EVERY
 * tool, because CameraController owns the mapping, not the dispatcher. The left button is
 * mapped to null in OrbitControls, so a left-drag on empty ground is free for the marquee.
 */
export class MoveTokenTool implements ToolHandler {
  private drag: DragState | null = null;
  /** The press, for the clean-click deselect and for the marquee's origin. */
  private down: { x: number; y: number; token: string | null; shift: boolean; pointerId: number } | null = null;
  /** The screen rectangle while a left-drag on empty ground is selecting. */
  private marquee: MarqueeRect | null = null;

  constructor(private readonly ctx: ToolContext) {}

  onDown(e: PointerEvent, tokenHit: string | null): void {
    this.down = { x: e.clientX, y: e.clientY, token: tokenHit, shift: e.shiftKey, pointerId: e.pointerId };
    if (tokenHit === null) return;
    // Additive: the press is about the set, so it takes no drag and leaves the grab offsets alone.
    if (e.shiftKey) {
      this.addToSelection(tokenHit);
      return;
    }
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
    if (this.drag) {
      this.moveDrag(e);
      return;
    }
    const down = this.down;
    if (down && down.token === null) {
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      if (!this.marquee && moved >= CLICK_SLOP_PX) {
        this.marquee = { x0: down.x, y0: down.y, x1: e.clientX, y1: e.clientY };
        // Keep the gesture alive when the pointer leaves the canvas mid-drag.
        try { this.ctx.view.canvas.setPointerCapture(down.pointerId); } catch { /* not active */ }
      }
      if (this.marquee) {
        this.marquee.x1 = e.clientX;
        this.marquee.y1 = e.clientY;
        this.ctx.view.setMarquee(this.marquee);
        return;
      }
    }
    this.ctx.onHover(this.ctx.view.pickToken(e), e.clientX, e.clientY);
  }

  private moveDrag(e: PointerEvent): void {
    const drag = this.drag;
    if (!drag) return;
    const grid = this.ctx.grid();
    if (!grid) return;
    let wx: number;
    let wz: number;
    let floorCeiling: number;
    if (drag.lift > 0.02) {
      const planeHit = this.ctx.view.pickPlane(e, drag.dragPlaneY);
      if (!planeHit) return;
      wx = planeHit.x + drag.grabOffset.x;
      wz = planeHit.z + drag.grabOffset.z;
      floorCeiling = drag.dragPlaneY;
    } else {
      const surfaceHit = this.ctx.view.pickMoveSurfaceAt(
        e.clientX + drag.screenOffset.x,
        e.clientY + drag.screenOffset.y,
        drag.dragPlaneY,
      );
      if (surfaceHit) {
        wx = surfaceHit.point.x;
        wz = surfaceHit.point.z;
        floorCeiling = surfaceHit.floorCeiling;
      } else {
        const fallbackHit = this.ctx.view.pickPlane(e, drag.dragPlaneY);
        if (!fallbackHit) return;
        wx = fallbackHit.x + drag.grabOffset.x;
        wz = fallbackHit.z + drag.grabOffset.z;
        floorCeiling = drag.startGroundY;
      }
    }
    // 1. Free, smooth movement preview following the grabbed token without initial jump
    const freePx = { x: Math.round(wx * grid.size), y: Math.round(wz * grid.size) };
    this.ctx.view.previewToken(drag.id, freePx, floorCeiling);
    // 2. Final landing target (snapped to grid unless snapToGrid is off) + FFT landing tile marker
    const snap = grid.snapToGrid !== false;
    const targetPx = snap ? snapCenter(wx, wz, drag.diameter, grid) : freePx;
    drag.targetPx = targetPx;
    drag.targetFloorY = floorCeiling;
    this.ctx.view.setMoveTarget({
      x: targetPx.x / grid.size,
      z: targetPx.y / grid.size,
      diameter: drag.diameter,
      snap,
      floorCeiling,
    });
  }

  onUp(e: PointerEvent): void {
    const down = this.down;
    this.down = null;
    if (this.marquee) {
      const rect = this.marquee;
      this.marquee = null;
      this.ctx.view.setMarquee(null);
      if (down) { try { this.ctx.view.canvas.releasePointerCapture(down.pointerId); } catch { /* not held */ } }
      this.selectInRect(rect, down?.shift === true);
      return;
    }
    if (!this.drag) {
      // A clean click on empty ground deselects. A press that moved past the slop became a
      // marquee (handled above); Shift is additive, so it never clears the set.
      if (down && down.token === null && !down.shift
        && Math.hypot(e.clientX - down.x, e.clientY - down.y) < CLICK_SLOP_PX) {
        this.ctx.onSelect(null);
      }
      return;
    }
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
    this.down = null;
    if (this.marquee) {
      this.marquee = null;
      this.ctx.view.setMarquee(null);
    }
    if (!this.drag) return;
    this.ctx.view.setMoveTarget(null);
    this.ctx.view.previewToken(this.drag.id, null);
    this.drag = null;
  }

  /**
   * Selects every token whose on-screen centre falls in the marquee. The centre is the midpoint
   * of the HUD box (foot/head), the same box the HUD draws, so what you see boxed is what gets
   * picked. Additive keeps the current set and unions the pick; otherwise the pick replaces it.
   * Written through onSelectMany — Atlas' own selection, the door a measured area's Select uses.
   */
  private selectInRect(rect: MarqueeRect, additive: boolean): void {
    const x0 = Math.min(rect.x0, rect.x1), x1 = Math.max(rect.x0, rect.x1);
    const y0 = Math.min(rect.y0, rect.y1), y1 = Math.max(rect.y0, rect.y1);
    const picked = this.ctx.view.screenPoints()
      .filter((p) => {
        if (!p.visible) return false;
        const cy = (p.footY + p.headY) / 2;
        return p.footX >= x0 && p.footX <= x1 && cy >= y0 && cy <= y1;
      })
      .map((p) => p.id);
    const base = additive ? (this.ctx.selectedIds?.() ?? []) : [];
    const next = [...new Set([...base, ...picked])];
    const many = this.ctx.onSelectMany;
    if (many) { many(next); return; }
    this.ctx.onSelect(next[next.length - 1] ?? null);
  }

  /**
   * Adds the token to the selection, or takes it out when it was already in. The set goes through
   * onSelectMany — Atlas' own selection — so taking the last one out clears it there too. A scene
   * that has not wired the many-door falls back to selecting the last one picked.
   */
  private addToSelection(id: string): void {
    const current = this.ctx.selectedIds?.() ?? [];
    const next = current.includes(id)
      ? current.filter((t) => t !== id)
      : [...current, id];
    const many = this.ctx.onSelectMany;
    if (many) { many(next); return; }
    this.ctx.onSelect(next[next.length - 1] ?? null);
  }
}