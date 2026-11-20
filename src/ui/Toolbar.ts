import type { Surface } from '../terrain/blocks';
import type { AoEShape } from '../terrain/raycast';
import type { MeasureState } from '../tools/ToolController';
import type { AtlasMeasureMode } from '../atlas/measureRules';
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

  // ---- Atlas parity (optional until the scene wires them) -------------------------------------
  /** A mode chosen in the six-name Atlas bar; pushed to Atlas via setMeasureTool. When present,
   *  the bar shows the six real modes (ruler and line apart); absent, the legacy four shapes. */
  onMeasureMode?(mode: AtlasMeasureMode): void;
  /** The "Players see it" toggle; pushed to Atlas as measureTool.players. */
  onMeasurePlayers?(players: boolean): void;
  /** The next line's width in cells (1-20); pushed to Atlas as measureTool.lineWidth. */
  onMeasureLineWidth?(cells: number): void;
}

const TOOLS: ReadonlyArray<{ tool: Tool; label: string; hint: string }> = [
  { tool: 'orbit', label: 'Orbit', hint: 'Left drag rotates, right drag pans, wheel zooms, Arrows pan, [ / ] or Alt+Q/E turn 90°, Home/Alt+H or double click centers. Click a token to select, right click for menu, Ctrl+hover for statblock.' },
  { tool: 'raise', label: 'Raise', hint: 'Paint columns up by one layer. Right drag rotates, Arrows pan.' },
  { tool: 'lower', label: 'Lower', hint: 'Paint columns down by one layer. Right drag rotates, Arrows pan.' },
  { tool: 'build', label: 'Build', hint: 'Click to add, rotate or remove single blocks. Hold Alt to remove, Alt+R to turn the piece (Alt+Shift+R the other way). Right drag rotates.' },
  { tool: 'move', label: 'Move', hint: 'Drag a token; it snaps to the grid and is written back to Atlas. Double click centers camera.' },
  { tool: 'measure', label: 'Measure', hint: '3D Ruler & AoE: drag or click-click to measure. Shift+Click adds a waypoint, Alt disables snap, Shift on release reverses Keep, Esc/right-click cancels.' },
  { tool: 'los', label: 'LoS', hint: '3D Line of Sight: click origin token or cell, sweep to target (green = clear, yellow = partial cover, red = blocked). Click to lock, Esc/right-click resets.' },
];

/** The legacy four-name bar, shown until the scene wires onMeasureMode. */
const LEGACY_MEASURE_SHAPES: ReadonlyArray<{ shape: AoEShape; label: string; hint: string }> = [
  { shape: 'line', label: 'Line', hint: '3D multi-waypoint ruler' },
  { shape: 'sphere', label: 'Sphere', hint: '3D spherical AoE & terrain projection' },
  { shape: 'cone', label: 'Cone', hint: '3D cone AoE & terrain projection' },
  { shape: 'cube', label: 'Cube', hint: '3D cube AoE & terrain projection' },
];

/** The six real Atlas modes, shown once the scene wires onMeasureMode. Hints follow Atlas' own
 *  semantics: a circle is a plan circle, a square is a box from the middle of its near side, a
 *  line is a rectangle as long as the drag and its width wide, ranges are labelled rings. */
const ATLAS_MEASURE_MODES: ReadonlyArray<{ mode: AtlasMeasureMode; label: string; hint: string }> = [
  { mode: 'ruler', label: 'Ruler', hint: 'Measure a path. Shift+Click adds a corner; the climb folds into the diagonal rule once.' },
  { mode: 'circle', label: 'Circle', hint: 'A circle on the plan, as far as the drag, projected onto every surface it covers.' },
  { mode: 'cone', label: 'Cone', hint: 'A cone from the origin towards the drag, opening the collection\'s angle.' },
  { mode: 'square', label: 'Square', hint: 'A box from the middle of its near side, as long and as wide as the drag.' },
  { mode: 'line', label: 'Line', hint: 'A rectangle as long as the drag and its width wide; its middle line covers every cell it crosses.' },
  { mode: 'ranges', label: 'Ranges', hint: 'Labelled rings around a token: its range bands, or its movement steps.' },
];

/** Atlas' own line-width bounds (measureTypes.ts MAX_LINE_WIDTH = 20, default 1). */
const MIN_LINE_WIDTH = 1;
const MAX_LINE_WIDTH = 20;

export class Toolbar {
  readonly el: HTMLElement;
  private readonly toolButtons = new Map<Tool, HTMLButtonElement>();
  private readonly brushButtons = new Map<number, HTMLButtonElement>();
  private readonly brushGroup: HTMLElement;
  private readonly undoButton: HTMLButtonElement;
  private readonly measureBar: HTMLElement;
  private readonly legacyShapeButtons = new Map<AoEShape, HTMLButtonElement>();
  private readonly modeButtons = new Map<AtlasMeasureMode, HTMLButtonElement>();
  private readonly measureKeepButton: HTMLButtonElement;
  private readonly measureClearButton: HTMLButtonElement;
  private readonly playersButton: HTMLButtonElement | null = null;
  private readonly widthWrap: HTMLElement | null = null;
  private readonly widthValue: HTMLElement | null = null;
  private readonly widthDown: HTMLButtonElement | null = null;
  private readonly widthUp: HTMLButtonElement | null = null;
  private readonly surfaceButton: HTMLButtonElement;
  private readonly layerButton: HTMLButtonElement;
  private readonly sliceDownButton: HTMLButtonElement;
  private readonly sliceButton: HTMLButtonElement;
  private readonly sliceUpButton: HTMLButtonElement;
  private readonly camButton: HTMLButtonElement;
  private readonly gridButton: HTMLButtonElement;
  private readonly status: HTMLElement;

  private cameraKind: CameraKind = 'ortho';
  private gridOn = true;
  private canEdit = true;
  /** The measure choices as last set, so the new controls' clicks read fresh values. */
  private mode: AtlasMeasureMode = 'ruler';
  private players = true;
  private lineWidth = 1;

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

    this.brushGroup = group();
    for (const size of [1, 2, 3]) {
      this.brushButtons.set(size, button(this.brushGroup, `${size}×${size}`, `Brush size ${size}×${size} cells`, () => handlers.onBrush(size)));
    }
    this.undoButton = button(this.brushGroup, 'Undo', 'Undo the last terrain stroke (Ctrl/Cmd+Z)', () => handlers.onUndo());

    const camera = group();
    button(camera, 'Iso', 'Isometric view', () => handlers.onPreset('iso'));
    button(camera, 'Top', 'Top-down view, like the 2D map', () => handlers.onPreset('top'));
    button(camera, '⟲', 'Rotate view 90° left ([ or Alt+Q)', () => handlers.onRotateView(-90), 'atlas3d-btn-icon');
    button(camera, '⟳', 'Rotate view 90° right (] or Alt+E)', () => handlers.onRotateView(90), 'atlas3d-btn-icon');
    button(camera, '⌖', 'Center camera on selected token or map (Home or Alt+H)', () => handlers.onCenter(), 'atlas3d-btn-icon');
    this.camButton = button(camera, 'Ortho', 'Switch between orthographic and perspective', () => {
      this.setCamera(this.cameraKind === 'ortho' ? 'persp' : 'ortho');
      handlers.onCamera(this.cameraKind);
    });

    const view = group();
    this.gridButton = button(view, 'Grid', 'Show or hide cell outlines', () => {
      this.setGrid(!this.gridOn);
      handlers.onGrid(this.gridOn);
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

    // ---- the measure bar ---------------------------------------------------------------------
    this.measureBar = wrap.createDiv({ cls: 'atlas3d-group atlas3d-measure-bar is-hidden' });
    if (handlers.onMeasureMode) {
      const onMode = handlers.onMeasureMode;
      for (const { mode, label, hint } of ATLAS_MEASURE_MODES) {
        this.modeButtons.set(mode, button(this.measureBar, label, hint, () => onMode(mode)));
      }
    } else {
      for (const { shape, label, hint } of LEGACY_MEASURE_SHAPES) {
        this.legacyShapeButtons.set(shape, button(this.measureBar, label, hint, () => handlers.onMeasureShape(shape)));
      }
    }
    this.measureKeepButton = button(this.measureBar, 'Keep', 'Keep the measurement on the map (Shift on release reverses this)', () => handlers.onMeasureKeep());

    if (handlers.onMeasurePlayers) {
      const onPlayers = handlers.onMeasurePlayers;
      this.playersButton = button(this.measureBar, 'Players', 'Players see what is measured and kept', () => onPlayers(!this.players));
    }

    if (handlers.onMeasureLineWidth) {
      const onWidth = handlers.onMeasureLineWidth;
      this.widthWrap = this.measureBar.createDiv({ cls: 'atlas3d-width' });
      this.widthDown = button(this.widthWrap, '−', 'Narrower line (one cell less)', () => onWidth(Math.max(MIN_LINE_WIDTH, this.lineWidth - 1)), 'atlas3d-btn-icon');
      this.widthValue = this.widthWrap.createSpan({ cls: 'atlas3d-width-value', text: '1' });
      this.widthUp = button(this.widthWrap, '+', 'Wider line (one cell more)', () => onWidth(Math.min(MAX_LINE_WIDTH, this.lineWidth + 1)), 'atlas3d-btn-icon');
    }

    this.measureClearButton = button(this.measureBar, 'Clear', 'Remove every kept measurement of the level shown (Atlas\'s own Clear)', () => handlers.onMeasureClear());

    this.status = root.createDiv({ cls: 'atlas3d-status' });
    this.setTool('orbit');
    this.setBrush(1);
    this.setSlice(null, 0);
    this.setMeasureState({ shape: 'line', keep: false }, 0);
  }

  setTool(tool: Tool): void {
    for (const [name, el] of this.toolButtons) el.toggleClass('is-active', name === tool);
    this.measureBar.toggleClass('is-hidden', tool !== 'measure');
    // The brush sizes and Undo belong to the terrain tools; elsewhere they do nothing, so they hide.
    const usesBrush = tool === 'raise' || tool === 'lower' || tool === 'build';
    this.brushGroup.toggleClass('is-hidden', !usesBrush);
    this.status.setText(TOOLS.find((t) => t.tool === tool)?.hint ?? '');
  }

  setMeasureState(state: MeasureState, pinCount: number): void {
    // The Atlas mode wins where it is set; the legacy shape is the fallback.
    const mode: AtlasMeasureMode = state.mode ?? legacyModeOf(state.shape);
    this.mode = mode;
    this.players = state.players !== false;
    this.lineWidth = clampWidth(state.lineWidth);

    for (const [shape, el] of this.legacyShapeButtons) el.toggleClass('is-active', shape === state.shape);
    for (const [m, el] of this.modeButtons) el.toggleClass('is-active', m === mode);
    this.measureKeepButton.toggleClass('is-active', state.keep);
    this.measureClearButton.disabled = pinCount === 0;

    if (this.playersButton) this.playersButton.toggleClass('is-active', this.players);
    if (this.widthWrap && this.widthValue && this.widthDown && this.widthUp) {
      // The width only means anything for a line; hide it for the other modes.
      this.widthWrap.toggleClass('is-hidden', mode !== 'line');
      this.widthValue.setText(String(this.lineWidth));
      this.widthDown.disabled = this.lineWidth <= MIN_LINE_WIDTH;
      this.widthUp.disabled = this.lineWidth >= MAX_LINE_WIDTH;
    }
  }

  setCanEdit(canEdit: boolean): void {
    this.canEdit = canEdit;
    for (const tool of ['raise', 'lower', 'build', 'move'] as const) {
      const btn = this.toolButtons.get(tool);
      if (btn) btn.disabled = !canEdit;
    }
    for (const btn of this.brushButtons.values()) btn.disabled = !canEdit;
    // Without an editable grid there can be no terrain stroke, so there is nothing to undo.
    this.undoButton.disabled = !canEdit;
  }

  /** The camera kind as the scene holds it, so the button never drifts from the actual projection. */
  setCamera(kind: CameraKind): void {
    this.cameraKind = kind;
    this.camButton.setText(kind === 'ortho' ? 'Ortho' : 'Persp');
  }

  /** The grid visibility as the scene holds it, so the button reflects Atlas's grid.enabled too. */
  setGrid(on: boolean): void {
    this.gridOn = on;
    this.gridButton.toggleClass('is-off', !on);
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

/** The Atlas mode a legacy toolbar shape means. The old 'line' was the multi-waypoint ruler. */
function legacyModeOf(shape: AoEShape): AtlasMeasureMode {
  switch (shape) {
    case 'sphere': return 'circle';
    case 'cube': return 'square';
    case 'cone': return 'cone';
    default: return 'ruler';
  }
}

function clampWidth(cells: number | undefined): number {
  if (typeof cells !== 'number' || !Number.isFinite(cells)) return 1;
  return Math.min(MAX_LINE_WIDTH, Math.max(MIN_LINE_WIDTH, Math.round(cells)));
}