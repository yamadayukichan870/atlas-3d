import { makeBlock, type BlockChange } from '../terrain/blocks';
import type { ToolContext, ToolHandler } from './ToolController';

export class SculptTool implements ToolHandler {
  private stroke: { touched: Set<string>; changes: BlockChange[] } | null = null;

  constructor(private readonly ctx: ToolContext, private readonly kind: 'raise' | 'lower') {}

  onDown(e: PointerEvent): void {
    if (!this.ctx.canEdit()) return;
    this.ctx.onHover(null, e.clientX, e.clientY);
    this.stroke = { touched: new Set(), changes: [] };
    this.paint(e);
  }

  onMove(e: PointerEvent): void {
    if (this.stroke) {
      this.paint(e);
      return;
    }
    this.ctx.view.setCursor(this.ctx.canEdit() ? this.ctx.view.pickCell(e) : null, this.ctx.brush(), this.kind);
  }

  onUp(): void {
    if (!this.stroke) return;
    const { changes } = this.stroke;
    this.stroke = null;
    if (changes.length > 0) this.ctx.onStrokeEnd(changes);
  }

  onLeave(): void {
    if (!this.stroke) this.ctx.view.setCursor(null, this.ctx.brush(), this.kind);
  }

  onCancel(): void {
    if (this.stroke?.changes.length) this.ctx.onStrokeEnd(this.stroke.changes);
    this.stroke = null;
    this.ctx.view.setCursor(null, this.ctx.brush(), this.kind);
  }

  private paint(e: PointerEvent): void {
    const stroke = this.stroke;
    const cell = this.ctx.view.pickCell(e);
    if (!stroke || !cell) return;
    const brush = this.ctx.brush();
    this.ctx.view.setCursor(cell, brush, this.kind);
    const map = this.ctx.map();
    const top = this.ctx.build().top ?? undefined;
    const first = -Math.floor((brush - 1) / 2);

    for (let dy = 0; dy < brush; dy++) {
      for (let dx = 0; dx < brush; dx++) {
        const cx = cell.cx + first + dx;
        const cz = cell.cy + first + dy;
        const key = `${cx},${cz}`;
        if (!this.ctx.view.inBounds(cx, cz) || stroke.touched.has(key)) continue;
        stroke.touched.add(key);
        const layer = map.topLayer(cx, cz);
        const change = this.kind === 'raise'
          ? map.place(makeBlock(cx, layer + 1, cz, 'Solid', 0, top))
          : (layer > 0 ? map.remove(cx, layer, cz) : null);
        if (change) {
          stroke.changes.push(change);
          this.ctx.view.touchCell(change.x, change.z);
        }
      }
    }
  }
}