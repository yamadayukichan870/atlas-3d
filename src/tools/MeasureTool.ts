import { segmentBlockedByTerrain as _unused, type AoEShape } from '../terrain/raycast';
import type { Vec3 } from '../terrain/shapes';
import type { MeasureDisplay } from '../view/TacticalOverlays';
import { CLICK_SLOP_PX, type ToolContext, type ToolHandler } from './ToolController';

void _unused;

const SHAPE_NAMES: Record<AoEShape, string> = {
  line: 'Line',
  sphere: 'Sphere',
  cone: 'Cone',
  cube: 'Cube',
};

function formatUnits(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

export class MeasureTool implements ToolHandler {
  private points: Vec3[] = [];
  private active = false;
  private dragStart: { x: number; y: number } | null = null;
  private dragged = false;
  private pinned: MeasureDisplay[] = [];
  private nextPinId = 1;

  constructor(private readonly ctx: ToolContext) {}

  hasPinned(): boolean {
    return this.pinned.length > 0;
  }

  unpin(id: string): void {
    const next = this.pinned.filter((p) => p.id !== id);
    if (next.length === this.pinned.length) return;
    this.pinned = next;
    this.syncOverlay();
  }

  clearPinned(): void {
    if (this.pinned.length === 0) return;
    this.pinned = [];
    this.syncOverlay();
  }

  refresh(): void {
    this.syncOverlay();
  }

  onDown(e: PointerEvent): void {
    const pt = this.pickPoint(e);
    if (!pt) return;

    if (!this.active) {
      this.active = true;
      this.points = [pt, pt];
      this.dragStart = { x: e.clientX, y: e.clientY };
      this.dragged = false;
      this.syncOverlay();
      return;
    }

    const shape = this.ctx.measure().shape;
    if (shape === 'line' && e.shiftKey) {
      this.points[this.points.length - 1] = pt;
      this.points.push(pt);
      this.dragStart = { x: e.clientX, y: e.clientY };
      this.dragged = false;
      this.syncOverlay();
      return;
    }

    this.points[this.points.length - 1] = pt;
    this.commitOrClear();
  }

  onMove(e: PointerEvent): void {
    if (!this.active) return;
    if (this.dragStart && Math.hypot(e.clientX - this.dragStart.x, e.clientY - this.dragStart.y) >= CLICK_SLOP_PX) {
      this.dragged = true;
    }
    const pt = this.pickPoint(e);
    if (!pt) return;
    this.points[this.points.length - 1] = pt;
    this.syncOverlay();
  }

  onUp(e: PointerEvent): void {
    if (!this.active) return;
    if (this.dragged) {
      const pt = this.pickPoint(e);
      if (pt) this.points[this.points.length - 1] = pt;
      this.commitOrClear();
    }
    this.dragStart = null;
  }

  onRightClick(): boolean {
    if (!this.active) return false;
    if (this.points.length > 2) {
      this.points.pop();
      this.syncOverlay();
      return true;
    }
    this.cancelActive();
    return true;
  }

  addWaypoint(): boolean {
    if (!this.active || this.ctx.measure().shape !== 'line' || this.points.length < 2) return false;
    const tip = this.points[this.points.length - 1]!;
    this.points.push([tip[0], tip[1], tip[2]]);
    this.syncOverlay();
    return true;
  }

  onAltChange(_on: boolean, lastEvent: PointerEvent | null): void {
    if (!this.active || !lastEvent) return;
    const pt = this.pickPoint(lastEvent);
    if (!pt) return;
    this.points[this.points.length - 1] = pt;
    this.syncOverlay();
  }

  onCancel(): void {
    this.cancelActive();
  }

  private cancelActive(): void {
    if (!this.active) return;
    this.active = false;
    this.points = [];
    this.dragStart = null;
    this.dragged = false;
    this.syncOverlay();
  }

  private commitOrClear(): void {
    const built = this.buildDisplay(false);
    if (this.ctx.measure().keep && built && built.radiusCells > 0.05) {
      this.pinned = [...this.pinned, { ...built, id: `pin-${this.nextPinId++}`, pinned: true, color: 0xf59e0b }];
    }
    this.active = false;
    this.points = [];
    this.dragStart = null;
    this.dragged = false;
    this.syncOverlay();
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

  private buildDisplay(isActive: boolean): MeasureDisplay | null {
    if (this.points.length < 2) return null;
    const { shape } = this.ctx.measure();
    const unit = this.ctx.unit();
    const origin = this.points[0]!;
    const tip = this.points[this.points.length - 1]!;

    let horizCells = 0;
    let dist3dCells = 0;
    for (let i = 1; i < this.points.length; i++) {
      const a = this.points[i - 1]!;
      const b = this.points[i]!;
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const dz = b[2] - a[2];
      horizCells += Math.hypot(dx, dz);
      dist3dCells += Math.hypot(dx, dy, dz);
    }

    const deltaYCells = tip[1] - origin[1];
    const horizUnits = horizCells * unit.distance;
    const dist3dUnits = dist3dCells * unit.distance;
    const deltaYUnits = deltaYCells * unit.distance;
    const hasHeight = Math.abs(deltaYCells) >= 0.08;
    const legs = this.points.length - 1;

    let label: string;
    let subLabel: string | undefined;
    const radiusCells = shape === 'cube'
      ? Math.max(1, horizCells)
      : Math.hypot(tip[0] - origin[0], tip[1] - origin[1], tip[2] - origin[2]);

    if (shape === 'line') {
      label = hasHeight
        ? `${formatUnits(horizUnits)} ${unit.label} (3D: ${formatUnits(dist3dUnits)} ${unit.label})`
        : `${formatUnits(horizUnits)} ${unit.label}`;
      const parts: string[] = [];
      if (hasHeight) parts.push(`ΔH ${deltaYUnits >= 0 ? '+' : ''}${formatUnits(deltaYUnits)} ${unit.label}`);
      if (legs > 1) parts.push(`${legs} legs`);
      if (parts.length > 0) subLabel = parts.join(' · ');
    } else {
      const radiusUnits = radiusCells * unit.distance;
      label = `${SHAPE_NAMES[shape]} ${formatUnits(radiusUnits)} ${unit.label}`;
      if (hasHeight) {
        subLabel = `ΔH ${deltaYUnits >= 0 ? '+' : ''}${formatUnits(deltaYUnits)} ${unit.label}`;
      }
    }

    return {
      id: isActive ? 'active' : 'preview',
      shape,
      points: this.points.map((p) => [...p] as Vec3),
      radiusCells,
      label,
      subLabel,
      color: 0x38bdf8,
      pinned: false,
    };
  }

  private syncOverlay(): void {
    const active = this.active ? this.buildDisplay(true) : null;
    this.ctx.view.setMeasure(active, this.pinned);
    this.ctx.onMeasurePinCountChange?.(this.pinned.length);
  }
}