import { MAX_LAYERS, makeBlock, normalizeRotation, type BlockChange } from '../terrain/blocks';
import { blockAtHit, placementCell } from '../terrain/placement';
import type { Vec3 } from '../terrain/shapes';
import type { BuildMode, ToolContext, ToolHandler } from './ToolController';

const GHOST_ADD = 0x9be29b;
const GHOST_REMOVE = 0xf87171;
const GHOST_ROTATE = 0xfbbf24;

const vec = (v: { x: number; y: number; z: number }): Vec3 => [v.x, v.y, v.z];

export class BuildTool implements ToolHandler {
  private stroke: { mode: BuildMode; touched: Set<string>; changes: BlockChange[]; layer: number | null } | null = null;

  constructor(private readonly ctx: ToolContext) {}

  onDown(e: PointerEvent): void {
    if (!this.ctx.canEdit()) return;
    this.ctx.onHover(null, e.clientX, e.clientY);
    this.stroke = { mode: this.effectiveMode(), touched: new Set(), changes: [], layer: null };
    this.applyAt(e);
  }

  onMove(e: PointerEvent): void {
    if (this.stroke) {
      this.applyAt(e);
      return;
    }
    this.updateGhost(e);
  }

  onUp(e: PointerEvent): void {
    if (!this.stroke) return;
    const { changes } = this.stroke;
    this.stroke = null;
    if (changes.length > 0) this.ctx.onStrokeEnd(changes);
    this.updateGhost(e);
  }

  onAltChange(_on: boolean, lastEvent: PointerEvent | null): void {
    if (lastEvent && !this.stroke) this.updateGhost(lastEvent);
  }

  onRefresh(lastEvent: PointerEvent | null): void {
    if (lastEvent && !this.stroke) this.updateGhost(lastEvent);
  }

  onLeave(): void {
    if (!this.stroke) this.ctx.view.setGhost(null);
  }

  onCancel(): void {
    if (this.stroke?.changes.length) this.ctx.onStrokeEnd(this.stroke.changes);
    this.stroke = null;
    this.ctx.view.setGhost(null);
  }

  private effectiveMode(): BuildMode {
    return this.ctx.altRemove() ? 'remove' : this.ctx.build().mode;
  }

  private record(change: BlockChange | null): void {
    if (!change || !this.stroke) return;
    this.stroke.changes.push(change);
    this.ctx.view.touchCell(change.x, change.z);
  }

  private applyAt(e: PointerEvent): void {
    const stroke = this.stroke;
    const hit = this.ctx.view.pickSurface(e);
    if (!stroke || !hit) return;
    const map = this.ctx.map();
    const state = this.ctx.build();
    const grid = this.ctx.view.placementGrid;
    const point = vec(hit.point);
    const normal = vec(hit.normal);

    if (stroke.mode === 'add') {
      const t = placementCell(point, normal, grid);
      if (!this.ctx.view.inBounds(t.x, t.z) || t.y < 1 || t.y > MAX_LAYERS) return;
      if (stroke.layer === null) stroke.layer = t.y;
      else if (t.y !== stroke.layer) return;
      const key = `${t.x},${t.y},${t.z}`;
      if (stroke.touched.has(key)) return;
      stroke.touched.add(key);
      this.record(map.place(makeBlock(t.x, t.y, t.z, state.shape, state.rot, state.top ?? undefined)));
      return;
    }

    const at = blockAtHit(point, normal, grid);
    const block = map.get(at.x, at.y, at.z);
    if (!block) return;
    const key = `${at.x},${at.y},${at.z}`;
    if (stroke.touched.has(key)) return;
    if (stroke.mode === 'remove') {
      if (stroke.layer === null) stroke.layer = at.y;
      else if (at.y !== stroke.layer) return;
      stroke.touched.add(key);
      this.record(map.remove(at.x, at.y, at.z));
    } else {
      stroke.touched.add(key);
      this.record(map.place({ ...block, rot: normalizeRotation(block.rot + 90) }));
    }
  }

  private updateGhost(e: PointerEvent): void {
    if (!this.ctx.canEdit()) { this.ctx.view.setGhost(null); return; }
    const hit = this.ctx.view.pickSurface(e);
    if (!hit) { this.ctx.view.setGhost(null); return; }
    const state = this.ctx.build();
    const grid = this.ctx.view.placementGrid;
    const point = vec(hit.point);
    const normal = vec(hit.normal);
    const mode = this.effectiveMode();

    if (mode === 'add') {
      const t = placementCell(point, normal, grid);
      if (!this.ctx.view.inBounds(t.x, t.z) || t.y < 1 || t.y > MAX_LAYERS) { this.ctx.view.setGhost(null); return; }
      const color = state.top ? Number.parseInt(state.top.slice(1), 16) : GHOST_ADD;
      this.viewSetGhost({ ...t, shape: state.shape, rot: state.rot, color });
      return;
    }

    const at = blockAtHit(point, normal, grid);
    const block = this.ctx.map().get(at.x, at.y, at.z);
    if (!block) { this.ctx.view.setGhost(null); return; }
    this.viewSetGhost({
      x: block.x,
      y: block.y,
      z: block.z,
      shape: block.shape,
      rot: mode === 'rotate' ? normalizeRotation(block.rot + 90) : block.rot,
      color: mode === 'remove' ? GHOST_REMOVE : GHOST_ROTATE,
    });
  }

  private viewSetGhost(spec: Parameters<ToolContext['view']['setGhost']>[0]): void {
    this.ctx.view.setGhost(spec);
  }
}