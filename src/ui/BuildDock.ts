import type { BlockShape } from '../terrain/shapes';
import type { BuildMode, BuildState } from '../tools/ToolController';

export interface BuildDockHandlers {
  onMode(mode: BuildMode): void;
  onShape(shape: BlockShape): void;
  onRotate(): void;
  onColor(hex: string | null): void;
}

const MODES: ReadonlyArray<{ mode: BuildMode; label: string }> = [
  { mode: 'add', label: 'Add' },
  { mode: 'rotate', label: 'Rotate' },
  { mode: 'remove', label: 'Remove' },
];

const SHAPES: ReadonlyArray<{ shape: BlockShape; label: string }> = [
  { shape: 'Solid', label: 'Cube' },
  { shape: 'Slope', label: 'Ramp' },
  { shape: 'Steps', label: 'Steps' },
  { shape: 'Slab', label: 'Slab' },
  { shape: 'Liquid', label: 'Water' },
];

const PALETTE: ReadonlyArray<{ name: string; hex: string }> = [
  { name: 'Meadow', hex: '#3E713E' },
  { name: 'Earth', hex: '#6F5A3C' },
  { name: 'Stone', hex: '#64748B' },
  { name: 'Snow', hex: '#E2E8F0' },
  { name: 'Desert', hex: '#D97706' },
  { name: 'Water', hex: '#0284C7' },
  { name: 'Dark', hex: '#18181B' },
];

export class BuildDock {
  private readonly el: HTMLElement;
  private readonly modeButtons = new Map<BuildMode, HTMLButtonElement>();
  private readonly shapeButtons = new Map<BlockShape, HTMLButtonElement>();
  private readonly swatches = new Map<string, HTMLElement>();
  private readonly rotateButton: HTMLButtonElement;

  constructor(root: HTMLElement, handlers: BuildDockHandlers) {
    const button = (parent: HTMLElement, text: string, hint: string, onClick: () => void): HTMLButtonElement => {
      const el = parent.createEl('button', { text, cls: 'atlas3d-btn', attr: { 'aria-label': hint } });
      el.addEventListener('click', onClick);
      return el;
    };

    this.el = root.createDiv({ cls: 'atlas3d-dock is-hidden' });
    const seg = this.el.createDiv({ cls: 'atlas3d-segment' });
    for (const { mode, label } of MODES) {
      this.modeButtons.set(mode, button(seg, label, `${label} blocks`, () => handlers.onMode(mode)));
    }
    this.el.createDiv({ cls: 'atlas3d-dock-label', text: 'Shape' });
    const shapes = this.el.createDiv({ cls: 'atlas3d-shapes' });
    for (const { shape, label } of SHAPES) {
      this.shapeButtons.set(shape, button(shapes, label, `${label} block`, () => handlers.onShape(shape)));
    }
    this.rotateButton = button(this.el, 'Turn 0° (R)', 'Turn the piece a quarter (R, Shift+R the other way)', () => handlers.onRotate());
    this.rotateButton.addClass('atlas3d-wide');
    this.el.createDiv({ cls: 'atlas3d-dock-label', text: 'Colour' });
    const palette = this.el.createDiv({ cls: 'atlas3d-palette' });
    const preset = palette.createDiv({ cls: 'atlas3d-swatch atlas3d-swatch-preset', attr: { 'aria-label': 'Map preset colours', role: 'button' } });
    preset.addEventListener('click', () => handlers.onColor(null));
    this.swatches.set('', preset);
    for (const { name, hex } of PALETTE) {
      const swatch = palette.createDiv({ cls: 'atlas3d-swatch', attr: { 'aria-label': name, role: 'button' } });
      swatch.style.background = hex;
      swatch.addEventListener('click', () => handlers.onColor(hex));
      this.swatches.set(hex.toLowerCase(), swatch);
    }
  }

  setVisible(visible: boolean): void {
    this.el.toggleClass('is-hidden', !visible);
  }

  setBuild(state: BuildState): void {
    for (const [mode, el] of this.modeButtons) el.toggleClass('is-active', mode === state.mode);
    for (const [shape, el] of this.shapeButtons) el.toggleClass('is-active', shape === state.shape);
    this.rotateButton.setText(`Turn ${state.rot}° (R)`);
    const chosen = state.top?.toLowerCase() ?? '';
    for (const [hex, el] of this.swatches) el.toggleClass('is-active', hex === chosen);
  }
}