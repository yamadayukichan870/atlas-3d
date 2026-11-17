import { formatCellLabel, type CellNumberMode } from '../grid/cellNumbers';
import type { BlockMap } from '../terrain/blocks';
import type { Layout } from '../terrain/layout';
import type { BlockShape } from '../terrain/shapes';

export interface TerrainInfoSample {
  cx: number;
  cz: number;
  y: number;
  map: BlockMap;
  layout: Layout;
  cellNumberMode: CellNumberMode;
  unitDistance: number;
  unitLabel: string;
  ceilingY: number;
}

const SHAPE_LABELS: Record<BlockShape, string> = {
  Solid: 'Cube',
  Slope: 'Ramp',
  Steps: 'Steps',
  Slab: 'Slab',
  Liquid: 'Water',
};

function formatNumber(n: number): string {
  const r = Math.round(n * 100) / 100;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

/**
 * Discrete HUD readout showing cell coordinate (matching Atlas numbering),
 * elevation (cells + Atlas units), block shape and terrain mark under the cursor.
 */
export class TerrainInfoWidget {
  private readonly el: HTMLElement;
  private readonly coordEl: HTMLElement;
  private readonly elevEl: HTMLElement;
  private readonly shapeEl: HTMLElement;
  private readonly markEl: HTMLElement;

  constructor(root: HTMLElement) {
    this.el = root.createDiv({ cls: 'atlas3d-terrain-info is-hidden' });
    this.coordEl = this.el.createSpan({ cls: 'atlas3d-tinfo-coord' });
    this.elevEl = this.el.createSpan({ cls: 'atlas3d-tinfo-elev' });
    this.shapeEl = this.el.createSpan({ cls: 'atlas3d-tinfo-shape' });
    this.markEl = this.el.createSpan({ cls: 'atlas3d-tinfo-mark' });
  }

  update(sample: TerrainInfoSample | null): void {
    if (!sample) {
      this.el.addClass('is-hidden');
      return;
    }

    const { cx, cz, map, layout, cellNumberMode, unitDistance, unitLabel, ceilingY } = sample;
    const formatted = formatCellLabel(cx, cz, layout, cellNumberMode);
    const coord = formatted || `${cx}, ${cz}`;

    const block = map.walkableBlockAt(cx, cz, ceilingY);
    const elevCells = block ? map.surfaceHeight(cx, cz, ceilingY) : 0;
    const elevUnits = elevCells * unitDistance;
    const elevText = elevCells > 0
      ? `ELEV ${formatNumber(elevCells)} (+${formatNumber(elevUnits)} ${unitLabel})`
      : 'ELEV 0';

    const shapeText = block ? SHAPE_LABELS[block.shape] : 'Ground';
    const markText = block?.marks?.trim() ?? '';

    this.el.removeClass('is-hidden');
    this.coordEl.setText(coord);
    this.elevEl.setText(elevText);
    this.shapeEl.setText(shapeText);
    this.markEl.setText(markText);
    this.markEl.toggleClass('is-hidden', markText === '');
  }

  dispose(): void {
    this.el.remove();
  }
}