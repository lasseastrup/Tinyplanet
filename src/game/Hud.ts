import { ICONS, type IconName } from '../ui/icons';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, html?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

function iconButton(icon: IconName, label: string): HTMLButtonElement {
  const b = el('button', 'icon-btn', ICONS[icon]);
  b.type = 'button';
  b.title = label;
  b.setAttribute('aria-label', label);
  return b;
}

export interface HudHandlers {
  newWorld(): void;
  toggleMute(): void;
  /** URL of the editor with the current planet. */
  editorUrl(): string;
}

/** On-screen display: planet name, score, buttons, control hints and the warp fade. */
export class Hud {
  private readonly nameEl: HTMLElement;
  private readonly labelEl: HTMLElement;
  private readonly scoreEl: HTMLElement;
  private readonly soundBtn: HTMLButtonElement;
  private readonly fadeEl: HTMLElement;
  private readonly fadeText: HTMLElement;
  private readonly hint: HTMLElement;
  private hintTimer: number | undefined;
  private score = 0;

  constructor(
    private readonly root: HTMLElement,
    handlers: HudHandlers,
  ) {
    root.classList.add('hud');
    const top = el('header', 'hud-top');
    const title = el('div', 'title-block');
    title.append(el('div', 'brand', 'Tiny Planet · Flight'));
    this.nameEl = el('h1', 'planet-name');
    this.labelEl = el('div', 'subtitle');
    title.append(this.nameEl, this.labelEl);

    const actions = el('div', 'hud-actions');
    this.scoreEl = el('div', 'score-chip', `${ICONS.burst}<span>0</span>`);
    this.scoreEl.title = 'Things blasted';
    this.soundBtn = iconButton('sound', 'Sound on/off (M)');
    this.soundBtn.addEventListener('click', () => handlers.toggleMute());
    const editor = el('a', 'icon-btn', ICONS.sliders);
    editor.title = 'Open this planet in the editor';
    editor.setAttribute('aria-label', editor.title);
    editor.addEventListener('pointerdown', () => (editor.href = handlers.editorUrl()));
    editor.addEventListener('focus', () => (editor.href = handlers.editorUrl()));
    editor.href = './';
    const next = el('button', 'new-world', `${ICONS.dice}<span>New world</span>`);
    next.type = 'button';
    next.title = 'Fly to another world (N)';
    next.addEventListener('click', () => {
      next.blur();
      handlers.newWorld();
    });
    actions.append(this.scoreEl, this.soundBtn, editor, next);
    top.append(title, actions);

    this.hint = el('div', 'hud-hint');
    this.fadeEl = el('div', 'warp-fade');
    this.fadeText = el('div', 'warp-text');
    this.fadeEl.append(this.fadeText);
    root.append(top, this.hint, this.fadeEl);
    // Buttons mustn't keep focus: Space and Enter fire the blasters.
    root.addEventListener('pointerup', () => (document.activeElement as HTMLElement | null)?.blur?.());
  }

  setWorld(name: string, label: string): void {
    this.nameEl.textContent = name;
    this.labelEl.textContent = label;
  }

  addScore(n = 1): void {
    this.score += n;
    const span = this.scoreEl.querySelector('span')!;
    span.textContent = String(this.score);
    this.scoreEl.classList.remove('bump');
    void this.scoreEl.offsetWidth; // restart the animation
    this.scoreEl.classList.add('bump');
  }

  setMuted(muted: boolean): void {
    this.soundBtn.innerHTML = ICONS[muted ? 'mute' : 'sound'];
    this.soundBtn.classList.toggle('off', muted);
  }

  /** Cover the screen (true) while travelling between worlds. */
  setFade(on: boolean, text = ''): void {
    if (text) this.fadeText.textContent = text;
    this.fadeEl.classList.toggle('on', on);
  }

  toggleHidden(): void {
    this.root.classList.toggle('hidden');
  }

  /** Show the controls for a while. */
  showHint(touch: boolean): void {
    this.hint.innerHTML = touch
      ? '<span>Left thumb: steer &amp; climb</span><span>Right: fire &amp; boost</span>'
      : '<span><kbd>←</kbd><kbd>→</kbd> steer</span><span><kbd>↑</kbd><kbd>↓</kbd> altitude</span>' +
        '<span><kbd>Shift</kbd> boost</span><span><kbd>Space</kbd> fire</span><span><kbd>N</kbd> new world</span>';
    this.hint.classList.add('show');
    window.clearTimeout(this.hintTimer);
    this.hintTimer = window.setTimeout(() => this.hint.classList.remove('show'), 14000);
  }
}
