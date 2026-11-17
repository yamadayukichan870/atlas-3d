import type { Surface } from '../terrain/blocks';
import type { AoEShape } from '../terrain/raycast';
import type { MeasureState } from '../tools/ToolController';
import type { CameraKind, Tool, ViewPreset } from '../view/SceneRenderer';

export interface ToolbarHandlers {
  onTool(tool: Tool): void;
  onBrush(size: number): void;
  onMeasureShape(shape: AoEShape): void;
  onMeasureKeep(): void;
  onMeasureClear(): void;
  onPreset(preset: ViewPreset): void;
  onRotateView(deltaDeg: number): void;
  onCenter(): void;
  onCamera(kind: CameraKind): void;
  onGrid(on: boolean): void;
  onUndo(): void;
  onSurface(surface: Surface): void;
  onLayer(): void;
  onSliceToggle(): void;
  onSliceStep(delta: -1 | 1): void;
  onExit?(): void;
  onDock?(): void;
}

const TOOLS: ReadonlyArray<{ tool: Tool; label: string; hint: string }> = [
  { tool: 'orbit', label: 'Orbit', hint: 'Left drag rotates, right drag pans, wheel zooms, Arrows pan, [ / ] or Alt+Q/E turn 90°, Home/Alt+H or double click centers. Click a token to select, right click for menu, Ctrl+hover for statblock.' },
  { tool: 'raise', label: 'Raise', hint: 'Paint columns up by one layer. Right drag rotates, Arrows pan.' },
  { tool: 'lower', label: 'Lower', hint: 'Paint columns down by one layer. Right drag rotates, Arrows pan.' },
  { tool: 'build', label: 'Build', hint: 'Click to add, rotate or remove single blocks. Hold Alt to remove, R to turn the piece. Right drag rotates.' },
  { tool: 'move', label: 'Move', hint: 'Drag a token; it snaps to the grid and is written back to Atlas. Double click centers camera.' },
  { tool: 'measure', label: 'Measure', hint: '3D Ruler & AoE: drag or click-click to measure distance & ΔH. Space or Shift+Click adds waypoints, Alt disables snap, Esc/right-click cancels.' },
  { tool: 'los', label: 'LoS', hint: '3D Line of Sight: click origin token or cell, sweep to target (green = clear, yellow = partial cover, red = blocked). Click to lock, Esc/right-click resets.' },
];

const MEASURE_SHAPES: ReadonlyArray<{ shape: AoEShape; label: string; hint: string }> = [
  { shape: 'line', label: 'Line', hint: '3D multi-waypoint ruler' },
  { shape: 'sphere', label: 'Sphere', hint: '3D spherical AoE & terrain projection' },
  { shape: 'cone', label: 'Cone', hint: '3D cone AoE & terrain projection' },
  { shape: 'cube', label: 'Cube', hint: '3D cube AoE & terrain projection' },
];

export class Toolbar {
  readonly el: HTMLElement;
  private readonly toolButtons = new Map<Tool, HTMLButtonElement>();
  private readonly brushButtons = new Map<number, HTMLButtonElement>();
  private readonly measureBar: HTMLElement;
  private readonly measureShapeButtons = new Map<AoEShape, HTMLButtonElement>();
  private readonly measureKeepButton: HTMLButtonElement;
  private readonly measureClearButton: HTMLButtonElement;
  private readonly surfaceButton: HTMLButtonElement;
  private readonly layerButton: HTMLButtonElement;
  private readonly sliceDownButton: HTMLButtonElement;
  private readonly sliceButton: HTMLButtonElement;
  private readonly sliceUpButton: HTMLButtonElement;
  private readonly status: HTMLElement;

  constructor(root: HTMLElement, handlers: ToolbarHandlers) {
    const wrap = root.createDiv({ cls: 'atlas3d-toolbar' });
    this.el = wrap;
    const group = (): HTMLElement => wrap.createDiv({ cls: 'atlas3d-group' });
    const button = (parent: HTMLElement, text: string, hint: string, onClick: () => void, extraCls?: string): HTMLButtonElement => {
      const cls = extraCls ? `atlas3d-btn ${extraCls}` : 'atlas3d-btn';
      const el = parent.createEl('button', { text, cls, attr: { 'aria-label': hint, title: hint } });
      el.addEventListener('click', onClick);
      return el;
    };

    const tools = group();
    for (const { tool, label, hint } of TOOLS) {
      this.toolButtons.set(tool, button(tools, label, hint, () => handlers.onTool(tool)));
    }
    const brush = group();
    for (const size of [1, 2, 3]) {
      this.brushButtons.set(size, button(brush, `${size}×${size}`, `Brush size ${size}×${size} cells`, () => handlers.onBrush(size)));
    }
    button(brush, 'Undo', 'Undo the last terrain stroke (Ctrl/Cmd+Z)', () => handlers.onUndo());

    const camera = group();
    button(camera, 'Iso', 'Isometric view', () => handlers.onPreset('iso'));
    button(camera, 'Top', 'Top-down view, like the 2D map', () => handlers.onPreset('top'));
    button(camera, '⟲', 'Rotate view 90° left ([ or Alt+Q)', () => handlers.onRotateView(-90), 'atlas3d-btn-icon');
    button(camera, '⟳', 'Rotate view 90° right (] or Alt+E)', () => handlers.onRotateView(90), 'atlas3d-btn-icon');
    button(camera, '⌖', 'Center camera on selected token or map (Home or Alt+H)', () => handlers.onCenter(), 'atlas3d-btn-icon');
    let ortho = true;
    const cam = button(camera, 'Ortho', 'Switch between orthographic and perspective', () => {
      ortho = !ortho;
      cam.setText(ortho ? 'Ortho' : 'Persp');
      handlers.onCamera(ortho ? 'ortho' : 'persp');
    });

    const view = group();
    let grid = true;
    const gridBtn = button(view, 'Grid', 'Show or hide cell outlines', () => {
      grid = !grid;
      gridBtn.toggleClass('is-off', !grid);
      handlers.onGrid(grid);
    });
    this.surfaceButton = button(view, 'Map image', 'Show the map image on the terrain, or the blocks\' own colours', () => {
      handlers.onSurface(this.surfaceButton.dataset.surface === 'image' ? 'colors' : 'image');
    });
    this.layerButton = button(view, 'Layer 1', 'Height of one layer: a whole cell (true cubes, slab = half) or half a cell', () => handlers.onLayer());

    const slice = view.createDiv({ cls: 'atlas3d-slice' });
    this.sliceDownButton = button(slice, '−', 'Cut one layer lower (PageDown)', () => handlers.onSliceStep(-1), 'atlas3d-btn-icon');
    this.sliceButton = button(slice, 'Slice: All', 'Toggle vertical cutaway to see under bridges and roofs', () => handlers.onSliceToggle());
    this.sliceUpButton = button(slice, '+', 'Raise vertical cut by one layer (PageUp)', () => handlers.onSliceStep(1), 'atlas3d-btn-icon');

    if (handlers.onExit || handlers.onDock) {
      const session = group();
      if (handlers.onExit) button(session, '2D', 'Back to the 2D map', () => handlers.onExit?.());
      if (handlers.onDock) button(session, 'Into Atlas', 'Show this 3D map inside Atlas\'s own view, under its interface', () => handlers.onDock?.());
    }

    this.measureBar = wrap.createDiv({ cls: 'atlas3d-group atlas3d-measure-bar is-hidden' });
    for (const { shape, label, hint } of MEASURE_SHAPES) {
      this.measureShapeButtons.set(shape, button(this.measureBar, label, hint, () => handlers.onMeasureShape(shape)));
    }
    this.measureKeepButton = button(this.measureBar, 'Keep', 'Pin measurements on the 3D map', () => handlers.onMeasureKeep());
    this.measureClearButton = button(this.measureBar, 'Clear', 'Remove all pinned 3D measurements', () => handlers.onMeasureClear());

    this.status = root.createDiv({ cls: 'atlas3d-status' });
    this.setTool('orbit');
    this.setBrush(1);
    this.setSlice(null, 0);
    this.setMeasureState({ shape: 'line', keep: false }, 0);
  }

  setTool(tool: Tool): void {
    for (const [name, el] of this.toolButtons) el.toggleClass('is-active', name === tool);
    this.measureBar.toggleClass('is-hidden', tool !== 'measure');
    this.status.setText(TOOLS.find((t) => t.tool === tool)?.hint ?? '');
  }

  setMeasureState(state: MeasureState, pinCount: number): void {
    for (const [shape, el] of this.measureShapeButtons) el.toggleClass('is-active', shape === state.shape);
    this.measureKeepButton.toggleClass('is-active', state.keep);
    this.measureClearButton.disabled = pinCount === 0;
  }

  setCanEdit(canEdit: boolean): void {
    for (const tool of ['raise', 'lower', 'build', 'move'] as const) {
      const btn = this.toolButtons.get(tool);
      if (btn) btn.disabled = !canEdit;
    }
    for (const btn of this.brushButtons.values()) btn.disabled = !canEdit;
  }

  setSurface(surface: Surface, hasImage: boolean): void {
    const effective: Surface = hasImage ? surface : 'colors';
    this.surfaceButton.dataset.surface = effective;
    this.surfaceButton.setText(effective === 'image' ? 'Map image' : 'Block colours');
    this.surfaceButton.disabled = !hasImage;
    this.surfaceButton.toggleClass('is-off', !hasImage);
  }

  setLayer(height: number): void {
    this.layerButton.setText(`Layer ${height === 1 ? '1' : height === 0.5 ? '½' : String(height)}`);
  }

  setSlice(layer: number | null, maxLayer: number): void {
    const active = layer !== null;
    this.sliceButton.setText(active ? `Slice ≤ ${layer}` : 'Slice: All');
    this.sliceButton.toggleClass('is-active', active);
    this.sliceButton.disabled = !active && maxLayer <= 0;
    this.sliceDownButton.disabled = (!active && maxLayer <= 0) || (active && layer <= 0);
    this.sliceUpButton.disabled = !active;
  }

  setBrush(size: number): void {
    for (const [n, el] of this.brushButtons) el.toggleClass('is-active', n === size);
  }

  say(text: string | null, tool: Tool): void {
    this.status.setText(text ?? TOOLS.find((t) => t.tool === tool)?.hint ?? '');
  }
}