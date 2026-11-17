import type { HudValue } from '../atlas/resources';
import type { FacingAngle } from '../terrain/blocks';
import { WIDGET_ICON_PATHS, WIDGET_ICON_VIEW_BOX, resolveWidgetIconKey } from './WidgetIcons';

export interface HudCondition {
  id: string;
  name: string;
  color: string;
  icon: string;
  value?: number | string;
}

export interface HudToken {
  id: string;
  footX: number;
  footY: number;
  headY: number;
  cell: number;
  size: number;
  depth: number;
  visible: boolean;
  name: string;
  instanceNumber: number | null;
  hidden: boolean;
  defeated: boolean;
  selected: boolean;
  rotation: number;
  flipX: boolean;
  facing: FacingAngle;
  atlasSize: number;
  elevationText: string;
  showNameplate: boolean;
  showInstanceBadge: boolean;
  conditions: HudCondition[];
  bars: HudValue[];
  right: HudValue[];
  left: HudValue[];
}

export interface TokenHudHandlers {
  onStepResource(tokenId: string, key: string, delta: number): void;
  onStepElevation(tokenId: string, delta: number): void;
  onToggleCondition(tokenId: string, conditionId: string): void;
  onOpenEditor(tokenId: string): void;
  onRotateToken(tokenId: string, rotation: number): void;
  onResizeToken(tokenId: string, size: number): void;
  onToggleFlip(tokenId: string): void;
  onSetFacing(tokenId: string, facing: FacingAngle): void;
}

const RING_R = 15.5;
const RING_LENGTH = 2 * Math.PI * RING_R;
const REFERENCE_CELL = 70;
const MAX_VISIBLE_CONDITIONS = 5;
const ATLAS_SIZES = [1, 1.5, 2, 2.5] as const;
const DEG = Math.PI / 180;

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));
const ratio = (v: HudValue): number => (v.max > 0 ? clamp01(v.current / v.max) : 0);

function appendIconSvg(parent: HTMLElement, rawIcon: string, cls: string): void {
  if (rawIcon === 'eye-off') {
    const svg = parent.createSvg('svg', { cls, attr: { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2.2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } });
    svg.createSvg('path', { attr: { d: 'M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49' } });
    svg.createSvg('path', { attr: { d: 'M14.084 14.158a3 3 0 0 1-4.242-4.242' } });
    svg.createSvg('path', { attr: { d: 'M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143' } });
    svg.createSvg('path', { attr: { d: 'm2 2 20 20' } });
    return;
  }

  const key = resolveWidgetIconKey(rawIcon);
  const svg = parent.createSvg('svg', { cls, attr: { viewBox: WIDGET_ICON_VIEW_BOX, fill: 'currentColor' } });
  if (key) {
    svg.createSvg('path', { attr: { d: WIDGET_ICON_PATHS[key] } });
  } else {
    svg.createSvg('circle', { attr: { cx: '256', cy: '256', r: '140' } });
  }
}

export function isPointCoveredByCloserToken(
  px: number,
  py: number,
  self: HudToken,
  allTokens: readonly HudToken[],
): boolean {
  for (const other of allTokens) {
    if (!other.visible || other.id === self.id) continue;
    if (other.depth >= self.depth - 1e-5) continue;
    const cx = other.footX;
    const cy = (other.headY + other.footY) * 0.5;
    const r = Math.max(10, other.size * 0.4);
    const dx = px - cx;
    const dy = py - cy;
    if (dx * dx + dy * dy <= r * r) return true;
  }
  return false;
}

function nextAtlasSize(current: number, dir: -1 | 1): number {
  let closestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < ATLAS_SIZES.length; i++) {
    const d = Math.abs(ATLAS_SIZES[i]! - current);
    if (d < bestDist) {
      bestDist = d;
      closestIdx = i;
    }
  }
  const nextIdx = Math.min(ATLAS_SIZES.length - 1, Math.max(0, closestIdx + dir));
  return ATLAS_SIZES[nextIdx]!;
}

function facingForScreenDir(dir: 'up' | 'right' | 'down' | 'left', cameraAzimuthDeg: number): FacingAngle {
  const camSnap = Math.round(cameraAzimuthDeg / 90) * 90;
  const offset = dir === 'up' ? 0 : dir === 'right' ? 90 : dir === 'down' ? 180 : 270;
  return ((((camSnap + offset) % 360) + 360) % 360) as FacingAngle;
}

interface Part {
  text: HTMLElement;
  fill?: HTMLElement;
  ring?: SVGCircleElement;
}

interface Entry {
  root: HTMLElement;
  topWrap: HTMLElement;
  name: HTMLElement;
  badges: HTMLElement;
  conditionsEl: HTMLElement;
  condNodes: HTMLElement[];
  bars: HTMLElement;
  elevRow: HTMLElement;
  elevLabel: HTMLElement;
  facingBtns: Map<'up' | 'right' | 'down' | 'left', HTMLButtonElement>;
  handlesEl: HTMLElement;
  rotateBtn: HTMLButtonElement | null;
  flipBtn: HTMLButtonElement | null;
  sizeDownBtn: HTMLButtonElement | null;
  sizeUpBtn: HTMLButtonElement | null;
  left: HTMLElement;
  right: HTMLElement;
  signature: string;
  parts: Map<string, Part>;
  latestToken: HudToken | null;
  cameraAzimuthDeg: number;
}

/**
 * Floating 2D HUD overlay for tokens: Atlas-faithful segmented wheels (`#1a1a1a` / `#888` / `#111114`),
 * pill bars with 10% ticks, radial condition arc (`-85°` to `-175°`), 2D occlusion,
 * single-selection handles (rotate, flip, Atlas size) and 4-way FFT/Wakfu facing cross.
 */
export class TokenHud {
  private readonly layer: HTMLElement;
  private readonly entries = new Map<string, Entry>();

  constructor(root: HTMLElement, private readonly handlers: TokenHudHandlers) {
    this.layer = root.createDiv({ cls: 'atlas3d-tokens' });
  }

  update(tokens: readonly HudToken[], cameraAzimuthDeg: number = 0): void {
    const present = new Set<string>();
    const selectedCount = tokens.reduce((acc, t) => acc + (t.visible && t.selected ? 1 : 0), 0);

    for (const token of tokens) {
      present.add(token.id);
      const show = token.visible && (
        token.selected
        || token.bars.length > 0
        || token.conditions.length > 0
        || token.showNameplate
        || token.hidden
        || token.defeated
      );
      const entry = this.entries.get(token.id);
      if (!show) {
        entry?.root.addClass('is-hidden');
        continue;
      }
      this.draw(entry ?? this.createEntry(token.id), token, tokens, selectedCount === 1, cameraAzimuthDeg);
    }

    for (const [id, entry] of this.entries) {
      if (present.has(id)) continue;
      entry.root.remove();
      this.entries.delete(id);
    }
  }

  private createEntry(id: string): Entry {
    const root = this.layer.createDiv({ cls: 'atlas3d-token-hud' });
    const topWrap = root.createDiv({ cls: 'atlas3d-token-top' });
    const name = topWrap.createDiv({ cls: 'atlas3d-token-name' });
    const badges = topWrap.createDiv({ cls: 'atlas3d-token-badges' });
    const conditionsEl = root.createDiv({ cls: 'atlas3d-conditions' });
    const handlesEl = root.createDiv({ cls: 'atlas3d-token-handles' });
    const bars = root.createDiv({ cls: 'atlas3d-token-bars' });
    const elevRow = createDiv({ cls: 'atlas3d-elev-row' });
    const elevLabel = createSpan({ cls: 'atlas3d-elev-label' });
    const left = root.createDiv({ cls: 'atlas3d-token-wheels is-left' });
    const right = root.createDiv({ cls: 'atlas3d-token-wheels is-right' });

    const entry: Entry = {
      root,
      topWrap,
      name,
      badges,
      conditionsEl,
      condNodes: [],
      bars,
      elevRow,
      elevLabel,
      facingBtns: new Map(),
      handlesEl,
      rotateBtn: null,
      flipBtn: null,
      sizeDownBtn: null,
      sizeUpBtn: null,
      left,
      right,
      signature: '',
      parts: new Map(),
      latestToken: null,
      cameraAzimuthDeg: 0,
    };
    this.entries.set(id, entry);
    return entry;
  }

  private draw(
    entry: Entry,
    token: HudToken,
    allTokens: readonly HudToken[],
    singleSelected: boolean,
    cameraAzimuthDeg: number,
  ): void {
    entry.root.removeClass('is-hidden');
    entry.latestToken = token;
    entry.cameraAzimuthDeg = cameraAzimuthDeg;

    const showHandles = token.selected && singleSelected;
    const all = [...token.bars, ...token.left, ...token.right];
    const condSig = token.conditions.map((c) => `${c.id}:${c.value ?? ''}`).join(',');
    const resSig = all.map((v) => `${v.key}${v.fixed ? '=' : ''}:${v.max}`).join(',');
    const badgeSig = `${token.hidden ? 'H' : ''}${token.defeated ? 'D' : ''}${token.showInstanceBadge ? (token.instanceNumber ?? '') : ''}`;
    const signature = `${token.selected ? 1 : 0}|${showHandles ? 1 : 0}|${resSig}|${token.bars.length},${token.left.length},${token.right.length}|${condSig}|${badgeSig}`;

    if (signature !== entry.signature) {
      entry.signature = signature;
      this.build(entry, token, showHandles);
    }

    for (const v of all) {
      const part = entry.parts.get(v.key);
      if (!part) continue;
      part.text.setText(v.fixed ? String(v.max) : part.fill ? `${v.current}/${v.max}` : String(v.current));
      if (part.fill) part.fill.style.width = `${ratio(v) * 100}%`;
      if (part.ring) {
        part.ring.setAttribute('stroke-dasharray', `${ratio(v) * RING_LENGTH} ${RING_LENGTH}`);
      }
    }

    const { root } = entry;
    const centerY = (token.headY + token.footY) * 0.5;
    root.style.left = `${token.footX - token.size / 2}px`;
    root.style.top = `${token.headY}px`;
    root.style.width = `${token.size}px`;
    root.style.height = `${token.size}px`;
    root.style.zIndex = String(Math.max(1, Math.round((1 - token.depth) * 10000)));
    root.toggleClass('is-selected', token.selected);
    root.toggleClass('is-ghost', token.hidden);
    root.toggleClass('is-defeated', token.defeated);

    entry.name.setText(token.showNameplate ? token.name : '');
    entry.elevLabel.setText(token.elevationText);

    const scale = Math.min(1.3, Math.max(0.55, token.cell / REFERENCE_CELL));
    entry.topWrap.style.transform = `translateX(-50%) scale(${scale})`;
    entry.bars.style.transform = `translateX(-50%) scale(${scale})`;
    entry.left.style.transform = `translateY(-50%) scale(${scale})`;
    entry.right.style.transform = `translateY(-50%) scale(${scale})`;

    // Radial condition arc (-85° to -175°) around token circle perimeter
    const condTotal = entry.condNodes.length;
    if (condTotal > 0) {
      const r = token.size * 0.5 + 11 * scale;
      const startDeg = condTotal === 1 ? -115 : -85;
      const endDeg = condTotal === 1 ? -115 : Math.max(-175, -85 - (condTotal - 1) * 20);
      for (let i = 0; i < condTotal; i++) {
        const node = entry.condNodes[i]!;
        const angleDeg = condTotal === 1 ? startDeg : startDeg + ((endDeg - startDeg) * i) / (condTotal - 1);
        const rad = angleDeg * DEG;
        const localX = token.size * 0.5 + Math.cos(rad) * r;
        const localY = token.size * 0.5 + Math.sin(rad) * r;
        node.style.left = `${localX}px`;
        node.style.top = `${localY}px`;
        node.style.transform = `translate(-50%, -50%) scale(${scale})`;

        const covered = !token.selected
          && isPointCoveredByCloserToken(token.footX - token.size * 0.5 + localX, token.headY + localY, token, allTokens);
        node.toggleClass('is-occluded', covered);
      }
    }

    // 2D occlusion for top nameplate/badges & bottom bars on non-selected tokens
    if (!token.selected) {
      const topCovered = isPointCoveredByCloserToken(token.footX, token.headY - 12 * scale, token, allTokens);
      const barsCovered = isPointCoveredByCloserToken(token.footX, token.footY + 14 * scale, token, allTokens);
      entry.topWrap.toggleClass('is-occluded', topCovered);
      entry.bars.toggleClass('is-occluded', barsCovered);
    } else {
      entry.topWrap.removeClass('is-occluded');
      entry.bars.removeClass('is-occluded');
    }

    // Update live handle states when 1 token is selected
    if (showHandles) {
      if (entry.flipBtn) entry.flipBtn.toggleClass('is-active', token.flipX);
      if (entry.sizeDownBtn) entry.sizeDownBtn.disabled = token.atlasSize <= ATLAS_SIZES[0];
      if (entry.sizeUpBtn) entry.sizeUpBtn.disabled = token.atlasSize >= ATLAS_SIZES[ATLAS_SIZES.length - 1]!;
      for (const [dir, btn] of entry.facingBtns) {
        const targetFacing = facingForScreenDir(dir, cameraAzimuthDeg);
        btn.toggleClass('is-active', token.facing === targetFacing);
      }
      if (entry.rotateBtn) {
        entry.rotateBtn.title = `Rotate token (${Math.round(token.rotation)}° — drag, hold Shift for 45° snap)`;
      }
      void centerY;
    }
  }

  private build(entry: Entry, token: HudToken, showHandles: boolean): void {
    entry.badges.empty();
    entry.conditionsEl.empty();
    entry.condNodes = [];
    entry.handlesEl.empty();
    entry.bars.empty();
    entry.left.empty();
    entry.right.empty();
    entry.parts.clear();
    entry.facingBtns.clear();
    entry.rotateBtn = null;
    entry.flipBtn = null;
    entry.sizeDownBtn = null;
    entry.sizeUpBtn = null;

    // Status & circular instance badges
    if (token.showInstanceBadge && token.instanceNumber !== null && token.instanceNumber > 0) {
      entry.badges.createSpan({ cls: 'atlas3d-badge atlas3d-badge-instance', text: String(token.instanceNumber) });
    }
    if (token.hidden) {
      const hiddenBadge = entry.badges.createSpan({ cls: 'atlas3d-badge atlas3d-badge-hidden', attr: { title: 'Hidden from players' } });
      appendIconSvg(hiddenBadge, 'eye-off', 'atlas3d-badge-icon');
    }
    if (token.defeated) {
      const deadBadge = entry.badges.createSpan({ cls: 'atlas3d-badge atlas3d-badge-defeated', attr: { title: 'Defeated' } });
      appendIconSvg(deadBadge, 'skull', 'atlas3d-badge-icon');
    }

    // Radial condition arc (-85° to -175°)
    const shownConditions = token.conditions.slice(0, MAX_VISIBLE_CONDITIONS);
    const overflowCount = token.conditions.length - shownConditions.length;
    for (const c of shownConditions) {
      const label = c.value !== undefined && c.value !== '' ? `${c.name} (${c.value})` : c.name;
      const chip = entry.conditionsEl.createEl('button', {
        cls: 'atlas3d-cond-chip',
        attr: { title: `${label} — click to toggle`, 'aria-label': label },
      });
      chip.style.borderColor = c.color;
      chip.style.color = c.color;
      appendIconSvg(chip, c.icon, 'atlas3d-cond-icon');
      if (c.value !== undefined && c.value !== '') {
        chip.createSpan({ cls: 'atlas3d-cond-val', text: String(c.value) });
      }
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        this.handlers.onToggleCondition(token.id, c.id);
      });
      entry.condNodes.push(chip);
    }

    if (overflowCount > 0) {
      const rest = token.conditions.slice(MAX_VISIBLE_CONDITIONS).map((c) => c.name).join(', ');
      const more = entry.conditionsEl.createSpan({
        cls: 'atlas3d-cond-chip atlas3d-cond-more',
        text: `+${overflowCount}`,
        attr: { title: rest },
      });
      entry.condNodes.push(more);
    }

    // Single-selection handles: Rotate, Flip, Size ‹ / ›
    if (showHandles) {
      const topHandles = entry.handlesEl.createDiv({ cls: 'atlas3d-top-handles' });

      const rotateBtn = topHandles.createEl('button', {
        cls: 'atlas3d-handle-btn atlas3d-handle-rotate',
        text: '↻',
        attr: { title: 'Drag to rotate token (Shift = 45° snap)', 'aria-label': 'Rotate token' },
      });
      this.bindRotateDrag(rotateBtn, entry);
      entry.rotateBtn = rotateBtn;

      const flipBtn = topHandles.createEl('button', {
        cls: 'atlas3d-handle-btn atlas3d-handle-flip',
        text: '⇄',
        attr: { title: 'Flip token horizontally (3D)', 'aria-label': 'Flip token horizontally' },
      });
      flipBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
      flipBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.handlers.onToggleFlip(token.id);
      });
      entry.flipBtn = flipBtn;

      const sizeDownBtn = entry.handlesEl.createEl('button', {
        cls: 'atlas3d-handle-btn atlas3d-size-btn is-left',
        text: '‹',
        attr: { title: 'Decrease token size', 'aria-label': 'Decrease token size' },
      });
      sizeDownBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
      sizeDownBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const cur = entry.latestToken?.atlasSize ?? 1;
        const next = nextAtlasSize(cur, -1);
        if (next !== cur) this.handlers.onResizeToken(token.id, next);
      });
      entry.sizeDownBtn = sizeDownBtn;

      const sizeUpBtn = entry.handlesEl.createEl('button', {
        cls: 'atlas3d-handle-btn atlas3d-size-btn is-right',
        text: '›',
        attr: { title: 'Increase token size', 'aria-label': 'Increase token size' },
      });
      sizeUpBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
      sizeUpBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const cur = entry.latestToken?.atlasSize ?? 1;
        const next = nextAtlasSize(cur, 1);
        if (next !== cur) this.handlers.onResizeToken(token.id, next);
      });
      entry.sizeUpBtn = sizeUpBtn;
    }

    // Resource pill bars with 10% tick dividers
    const stepper = (parent: HTMLElement, label: string, key: string, delta: number): void => {
      const btn = parent.createEl('button', { text: label, cls: 'atlas3d-step', attr: { 'aria-label': delta > 0 ? 'Add one' : 'Take one away' } });
      btn.addEventListener('pointerdown', (e) => e.stopPropagation());
      btn.addEventListener('click', (e) => { e.stopPropagation(); this.handlers.onStepResource(token.id, key, delta); });
    };
    const controls = token.selected;

    for (const v of token.bars) {
      const row = entry.bars.createDiv({ cls: 'atlas3d-bar-row' });
      if (controls && !v.fixed) stepper(row, '−', v.key, -1);
      const track = row.createDiv({ cls: 'atlas3d-bar-track', attr: { title: v.name } });
      const fill = track.createDiv({ cls: 'atlas3d-bar-fill' });
      fill.style.background = v.color;
      const ticks = track.createDiv({ cls: 'atlas3d-bar-ticks' });
      for (let t = 1; t <= 9; t++) {
        const tick = ticks.createDiv({ cls: 'atlas3d-bar-tick' });
        tick.style.left = `${t * 10}%`;
      }
      entry.parts.set(v.key, { text: track.createDiv({ cls: 'atlas3d-bar-text' }), fill });
      if (controls && !v.fixed) stepper(row, '+', v.key, 1);
    }

    if (!token.selected) return;

    // Quick row when selected: elevation stepper + 4-way FFT/Wakfu facing cross
    const quickRow = entry.bars.createDiv({ cls: 'atlas3d-quick-row' });
    entry.elevRow = quickRow.createDiv({ cls: 'atlas3d-elev-row' });
    const downBtn = entry.elevRow.createEl('button', { text: '▼', cls: 'atlas3d-elev-btn', attr: { 'aria-label': 'Lower token elevation' } });
    downBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    downBtn.addEventListener('click', (e) => { e.stopPropagation(); this.handlers.onStepElevation(token.id, -1); });
    entry.elevRow.appendChild(entry.elevLabel);
    const upBtn = entry.elevRow.createEl('button', { text: '▲', cls: 'atlas3d-elev-btn', attr: { 'aria-label': 'Raise token elevation' } });
    upBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    upBtn.addEventListener('click', (e) => { e.stopPropagation(); this.handlers.onStepElevation(token.id, 1); });

    if (showHandles) {
      const facingCross = quickRow.createDiv({ cls: 'atlas3d-facing-cross', attr: { title: 'Set ground facing direction' } });
      const dirs: ReadonlyArray<{ dir: 'up' | 'right' | 'down' | 'left'; glyph: string; label: string }> = [
        { dir: 'up', glyph: '▲', label: 'Face away from camera' },
        { dir: 'left', glyph: '◀', label: 'Face left' },
        { dir: 'right', glyph: '▶', label: 'Face right' },
        { dir: 'down', glyph: '▼', label: 'Face toward camera' },
      ];
      for (const { dir, glyph, label } of dirs) {
        const btn = facingCross.createEl('button', {
          cls: `atlas3d-facing-btn is-${dir}`,
          text: glyph,
          attr: { title: label, 'aria-label': label },
        });
        btn.addEventListener('pointerdown', (e) => e.stopPropagation());
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const angle = facingForScreenDir(dir, entry.cameraAzimuthDeg);
          this.handlers.onSetFacing(token.id, angle);
        });
        entry.facingBtns.set(dir, btn);
      }
      facingCross.createDiv({ cls: 'atlas3d-facing-core' });
    }

    // Atlas-style resource wheels (#1a1a1a fill, #888 border, #111114 segment dividers when max <= 8)
    const wheels = (side: HTMLElement, list: HudValue[], outer: 'left' | 'right'): void => {
      for (const v of list) {
        const row = side.createDiv({ cls: `atlas3d-wheel-row is-${outer}` });
        const wheel = row.createDiv({ cls: 'atlas3d-wheel is-clickable', attr: { title: `${v.name} — click to open token editor` } });
        wheel.addEventListener('pointerdown', (e) => e.stopPropagation());
        wheel.addEventListener('click', (e) => {
          e.stopPropagation();
          this.handlers.onOpenEditor(token.id);
        });
        const svg = wheel.createSvg('svg', { attr: { viewBox: '0 0 40 40' } });
        svg.createSvg('circle', { cls: 'atlas3d-ring-bg', attr: { cx: '20', cy: '20', r: '18.5' } });
        svg.createSvg('circle', { cls: 'atlas3d-ring-track', attr: { cx: '20', cy: '20', r: String(RING_R) } });
        const ring = svg.createSvg('circle', { cls: 'atlas3d-ring', attr: { cx: '20', cy: '20', r: String(RING_R), stroke: v.color } });

        if (!v.fixed && v.max > 1 && v.max <= 8) {
          const n = Math.round(v.max);
          for (let i = 0; i < n; i++) {
            const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
            const cos = Math.cos(a);
            const sin = Math.sin(a);
            svg.createSvg('line', {
              cls: 'atlas3d-ring-divider',
              attr: {
                x1: (20 + cos * 12.2).toFixed(2),
                y1: (20 + sin * 12.2).toFixed(2),
                x2: (20 + cos * 18.8).toFixed(2),
                y2: (20 + sin * 18.8).toFixed(2),
              },
            });
          }
        }

        svg.createSvg('circle', { cls: 'atlas3d-ring-border', attr: { cx: '20', cy: '20', r: '18.5' } });
        entry.parts.set(v.key, { text: wheel.createDiv({ cls: 'atlas3d-wheel-text' }), ring });
        if (!v.fixed) {
          const col = row.createDiv({ cls: 'atlas3d-wheel-steps' });
          stepper(col, '+', v.key, 1);
          stepper(col, '−', v.key, -1);
        }
      }
    };
    wheels(entry.left, token.left, 'left');
    wheels(entry.right, token.right, 'right');
  }

  private bindRotateDrag(handle: HTMLButtonElement, entry: Entry): void {
    let dragging = false;
    let lastSent = -1;

    const computeAngle = (clientX: number, clientY: number, shiftKey: boolean): number | null => {
      const t = entry.latestToken;
      if (!t) return null;
      const rect = this.layer.getBoundingClientRect();
      const cx = rect.left + t.footX;
      const cy = rect.top + (t.headY + t.footY) * 0.5;
      const rawDeg = (Math.atan2(clientY - cy, clientX - cx) * 180) / Math.PI + 90;
      const step = shiftKey ? 45 : 15;
      return ((Math.round(rawDeg / step) * step) % 360 + 360) % 360;
    };

    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !entry.latestToken) return;
      e.stopPropagation();
      e.preventDefault();
      dragging = true;
      lastSent = Math.round(entry.latestToken.rotation);
      handle.addClass('is-dragging');
      handle.setPointerCapture(e.pointerId);
    });

    handle.addEventListener('pointermove', (e) => {
      if (!dragging || !entry.latestToken) return;
      e.stopPropagation();
      const snapped = computeAngle(e.clientX, e.clientY, e.shiftKey);
      if (snapped === null || snapped === lastSent) return;
      lastSent = snapped;
      this.handlers.onRotateToken(entry.latestToken.id, snapped);
    });

    const endDrag = (e: PointerEvent): void => {
      if (!dragging) return;
      e.stopPropagation();
      dragging = false;
      handle.removeClass('is-dragging');
      if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
    };

    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);
    handle.addEventListener('click', (e) => e.stopPropagation());
  }
}