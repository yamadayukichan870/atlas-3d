import { segmentBlockedByTerrain } from '../terrain/raycast';
import type { Vec3 } from '../terrain/shapes';
import type { LosDisplay, LosRayDisplay } from '../view/TacticalOverlays';
import type { ToolContext, ToolHandler } from './ToolController';

const RAY_HEIGHTS: ReadonlyArray<{ name: 'base' | 'torso' | 'head'; offset: number }> = [
  { name: 'base', offset: 0.22 },
  { name: 'torso', offset: 0.55 },
  { name: 'head', offset: 0.9 },
];

export class LosTool implements ToolHandler {
  private origin: Vec3 | null = null;
  private target: Vec3 | null = null;
  private locked = false;

  constructor(private readonly ctx: ToolContext) {}

  onDown(e: PointerEvent): void {
    const pt = this.pickPoint(e);
    if (!pt) return;

    if (this.origin === null || this.locked) {
      this.origin = pt;
      this.target = pt;
      this.locked = false;
      this.evaluate();
      return;
    }

    this.target = pt;
    this.locked = true;
    this.evaluate();
  }

  onMove(e: PointerEvent): void {
    if (this.origin === null || this.locked) return;
    const pt = this.pickPoint(e);
    if (!pt) return;
    this.target = pt;
    this.evaluate();
  }

  onRightClick(): boolean {
    if (this.origin === null) return false;
    this.clear();
    return true;
  }

  onCancel(): void {
    this.clear();
  }

  refresh(): void {
    if (this.origin !== null && this.target !== null) this.evaluate();
  }

  private clear(): void {
    this.origin = null;
    this.target = null;
    this.locked = false;
    this.ctx.view.setLos(null);
  }

  private pickPoint(e: MouseEvent): Vec3 | null {
    const tokenHit = this.ctx.view.pickToken(e);
    if (tokenHit) {
      const info = this.ctx.view.tokenDragInfo(tokenHit);
      if (info) return [info.x, info.groundY + info.lift, info.z];
    }
    const grid = this.ctx.grid();
    const snap = !this.ctx.altRemove() && (grid?.snapToGrid !== false);
    const p = this.ctx.view.pickMeasurePoint(e, snap);
    return p ? [p.x, p.y, p.z] : null;
  }

  private evaluate(): void {
    const origin = this.origin;
    const target = this.target;
    const info = this.ctx.view.tacticalContext();
    if (!origin || !target || !info) {
      this.ctx.view.setLos(null);
      return;
    }

    const rays: LosRayDisplay[] = [];
    let blockedCount = 0;

    for (const h of RAY_HEIGHTS) {
      const start: Vec3 = [origin[0], origin[1] + h.offset, origin[2]];
      const end: Vec3 = [target[0], target[1] + h.offset, target[2]];
      const hit = segmentBlockedByTerrain(info.map, info.layout, start, end, info.maxLayer);
      if (hit.blocked) blockedCount++;
      rays.push({
        name: h.name,
        start,
        end,
        blocked: hit.blocked,
        hitPoint: hit.hitPoint,
      });
    }

    const status: LosDisplay['status'] = blockedCount === 0 ? 'clear' : blockedCount === 3 ? 'blocked' : 'partial';
    const label = status === 'clear'
      ? 'LoS: Clear (3/3)'
      : status === 'partial'
        ? `LoS: Partial Cover (${3 - blockedCount}/3)`
        : 'LoS: Blocked (0/3)';

    this.ctx.view.setLos({
      origin,
      target,
      status,
      rays: rays as [LosRayDisplay, LosRayDisplay, LosRayDisplay],
      label,
      locked: this.locked,
    });
  }
}