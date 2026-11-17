import { CLICK_SLOP_PX, type ToolContext, type ToolHandler } from './ToolController';

export class OrbitTool implements ToolHandler {
  private down: { x: number; y: number; token: string | null } | null = null;

  constructor(private readonly ctx: ToolContext) {}

  onDown(e: PointerEvent, tokenHit: string | null): void {
    this.down = { x: e.clientX, y: e.clientY, token: tokenHit };
    if (tokenHit !== null) this.ctx.onSelect(tokenHit);
  }

  onMove(e: PointerEvent): void {
    this.ctx.onHover(this.ctx.view.pickToken(e), e.clientX, e.clientY);
  }

  onUp(e: PointerEvent): void {
    const down = this.down;
    this.down = null;
    if (down && down.token === null && Math.hypot(e.clientX - down.x, e.clientY - down.y) < CLICK_SLOP_PX) {
      this.ctx.onSelect(null);
    }
  }

  onDoubleClick(e: MouseEvent): void {
    const tokenId = this.ctx.view.pickToken(e);
    if (tokenId !== null && this.ctx.view.focusOnToken(tokenId)) return;
    const point = this.ctx.view.pickGroundOrPlane(e, 0);
    if (point) this.ctx.view.focusOnPoint(point);
  }

  onCancel(): void {
    this.down = null;
  }
}