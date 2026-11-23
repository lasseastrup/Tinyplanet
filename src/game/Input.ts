export interface Controls {
  /** -1 (left) … 1 (right) */
  turn: number;
  /** -1 (down) … 1 (up) */
  climb: number;
  boost: boolean;
  fire: boolean;
}

export type Action = 'newWorld' | 'mute' | 'hud';

const STICK_RANGE = 52;
const DEADZONE = 0.16;

const KEYS = {
  left: ['ArrowLeft', 'KeyA'],
  right: ['ArrowRight', 'KeyD'],
  up: ['ArrowUp', 'KeyW'],
  down: ['ArrowDown', 'KeyS'],
  boost: ['ShiftLeft', 'ShiftRight'],
  fire: ['Space', 'KeyJ', 'Enter'],
} as const;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, parent: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  parent.append(e);
  return e;
}

/**
 * Unified flight controls from the keyboard, the mouse, on-screen touch controls (a floating
 * stick on the left, fire and boost buttons on the right) and gamepads.
 */
export class Input {
  private readonly keys = new Set<string>();
  private mouseFire = false;
  private stickId = -1;
  private stickX = 0;
  private stickY = 0;
  private stickOrigin = { x: 0, y: 0 };
  private touchFire = new Set<number>();
  private touchBoost = new Set<number>();
  private readonly stickBase: HTMLElement;
  private readonly stickKnob: HTMLElement;
  private readonly touchLayer: HTMLElement;
  private padButtons: boolean[] = [];
  private actionListener: (a: Action) => void = () => {};
  /** True once touch controls are showing (first touch, or a coarse pointer). */
  touch = false;
  /** Ignore everything (e.g. while warping to another world). */
  enabled = true;

  constructor(
    private readonly canvas: HTMLElement,
    overlay: HTMLElement,
  ) {
    // Touch controls: a full-screen layer under the HUD buttons.
    this.touchLayer = el('div', 'touch-layer', overlay);
    this.stickBase = el('div', 'stick-base', this.touchLayer);
    this.stickKnob = el('div', 'stick-knob', this.stickBase);
    const fire = el('div', 'touch-btn fire', this.touchLayer);
    fire.innerHTML = '<span>FIRE</span>';
    const boost = el('div', 'touch-btn boost', this.touchLayer);
    boost.innerHTML = '<span>BOOST</span>';
    this.bindTouch(fire, this.touchFire);
    this.bindTouch(boost, this.touchBoost);
    this.touchLayer.addEventListener('pointerdown', this.onStickDown);
    this.touchLayer.addEventListener('pointermove', this.onStickMove);
    this.touchLayer.addEventListener('pointerup', this.onStickUp);
    this.touchLayer.addEventListener('pointercancel', this.onStickUp);
    this.touchLayer.addEventListener('contextmenu', (e) => e.preventDefault());
    if (window.matchMedia('(pointer: coarse)').matches) this.showTouch();

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    canvas.addEventListener('pointerdown', this.onCanvasDown);
    window.addEventListener('pointerup', this.onCanvasUp);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  onAction(listener: (a: Action) => void): void {
    this.actionListener = listener;
  }

  read(): Controls {
    const c: Controls = { turn: 0, climb: 0, boost: false, fire: false };
    if (!this.enabled) return c;
    const any = (codes: readonly string[]) => codes.some((k) => this.keys.has(k));
    c.turn = (any(KEYS.right) ? 1 : 0) - (any(KEYS.left) ? 1 : 0);
    c.climb = (any(KEYS.up) ? 1 : 0) - (any(KEYS.down) ? 1 : 0);
    c.boost = any(KEYS.boost);
    c.fire = any(KEYS.fire) || this.mouseFire;

    if (this.stickId >= 0) {
      c.turn += this.stickX;
      c.climb += this.stickY;
    }
    if (this.touchFire.size > 0) c.fire = true;
    if (this.touchBoost.size > 0) c.boost = true;
    this.readGamepads(c);

    c.turn = Math.max(-1, Math.min(1, c.turn));
    c.climb = Math.max(-1, Math.min(1, c.climb));
    return c;
  }

  private readGamepads(c: Controls): void {
    const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
    for (const pad of pads) {
      if (!pad || !pad.connected) continue;
      const dz = (v: number) => (Math.abs(v) < DEADZONE ? 0 : (v - Math.sign(v) * DEADZONE) / (1 - DEADZONE));
      c.turn += dz(pad.axes[0] ?? 0);
      c.climb -= dz(pad.axes[1] ?? 0);
      const pressed = (i: number) => !!pad.buttons[i]?.pressed;
      // A / right trigger fire, B / bumpers / left trigger boost; d-pad steers too.
      if (pressed(0) || pressed(7)) c.fire = true;
      if (pressed(1) || pressed(4) || pressed(5) || pressed(6)) c.boost = true;
      if (pressed(14)) c.turn -= 1;
      if (pressed(15)) c.turn += 1;
      if (pressed(12)) c.climb += 1;
      if (pressed(13)) c.climb -= 1;
      // Y: next world (on press, not hold).
      const y = pressed(3);
      if (y && !this.padButtons[3]) this.actionListener('newWorld');
      this.padButtons[3] = y;
    }
  }

  private showTouch(): void {
    if (this.touch) return;
    this.touch = true;
    document.body.classList.add('touch');
  }

  private bindTouch(button: HTMLElement, set: Set<number>): void {
    button.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      button.setPointerCapture(e.pointerId);
      set.add(e.pointerId);
      button.classList.add('down');
    });
    const up = (e: PointerEvent) => {
      set.delete(e.pointerId);
      if (set.size === 0) button.classList.remove('down');
    };
    button.addEventListener('pointerup', up);
    button.addEventListener('pointercancel', up);
  }

  private readonly onStickDown = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse') return;
    this.showTouch();
    if (this.stickId >= 0 || e.clientX > window.innerWidth * 0.55) return;
    e.preventDefault();
    this.touchLayer.setPointerCapture(e.pointerId);
    this.stickId = e.pointerId;
    this.stickOrigin = { x: e.clientX, y: e.clientY };
    this.stickX = this.stickY = 0;
    this.stickBase.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
    this.stickBase.classList.add('on');
    this.stickKnob.style.transform = '';
  };

  private readonly onStickMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.stickId) return;
    let dx = e.clientX - this.stickOrigin.x;
    let dy = e.clientY - this.stickOrigin.y;
    const len = Math.hypot(dx, dy);
    if (len > STICK_RANGE) {
      // Drag the stick along so turning back is immediate.
      const k = (len - STICK_RANGE) / len;
      this.stickOrigin.x += dx * k;
      this.stickOrigin.y += dy * k;
      dx -= dx * k;
      dy -= dy * k;
      this.stickBase.style.transform = `translate(${this.stickOrigin.x}px, ${this.stickOrigin.y}px)`;
    }
    const shape = (v: number) => {
      const a = Math.abs(v) / STICK_RANGE;
      return a < 0.12 ? 0 : Math.sign(v) * Math.min(1, (a - 0.12) / 0.8);
    };
    this.stickX = shape(dx);
    this.stickY = -shape(dy);
    this.stickKnob.style.transform = `translate(${dx}px, ${dy}px)`;
  };

  private readonly onStickUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.stickId) return;
    this.stickId = -1;
    this.stickX = this.stickY = 0;
    this.stickBase.classList.remove('on');
  };

  private readonly onCanvasDown = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse') {
      if (e.button === 0) this.mouseFire = true;
      return;
    }
    // The first touch switches the on-screen controls on (the touch layer then takes over).
    this.onStickDown(e);
  };

  private readonly onCanvasUp = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse' && e.button === 0) this.mouseFire = false;
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || t.tagName === 'INPUT')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // Keep Space/arrows from scrolling or pressing a focused button.
    if (e.code === 'Space' || e.code.startsWith('Arrow') || e.code === 'Enter') e.preventDefault();
    if (!e.repeat) {
      if (e.code === 'KeyN') this.actionListener('newWorld');
      else if (e.code === 'KeyM') this.actionListener('mute');
      else if (e.code === 'KeyH') this.actionListener('hud');
    }
    this.keys.add(e.code);
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  private readonly onBlur = (): void => {
    this.keys.clear();
    this.mouseFire = false;
    this.touchFire.clear();
    this.touchBoost.clear();
    this.stickId = -1;
    this.stickX = this.stickY = 0;
    this.stickBase.classList.remove('on');
  };

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.canvas.removeEventListener('pointerdown', this.onCanvasDown);
    window.removeEventListener('pointerup', this.onCanvasUp);
    this.touchLayer.remove();
  }
}
