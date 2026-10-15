import type { App } from '../app/App';
import { hashString, randomSeed } from '../core/rng';
import { planetName } from '../planet/names';
import type { ParamKey, PlanetParams } from '../planet/params';
import { getPreset, PRESETS } from '../planet/presets';
import { randomPlanet } from '../planet/randomize';
import type { QualityLevel } from '../render/quality';
import { ICONS, type IconName } from './icons';
import { TABS, type ColorKey, type Control } from './schema';

export type ExportDetail = 'low' | 'medium' | 'high';

export interface UIHandlers {
  exportGLB(detail: ExportDetail): Promise<void>;
  exportJSON(): void;
  share(): Promise<void>;
  copyLink(): Promise<void>;
  screenshot(): Promise<void>;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, html?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

function iconButton(icon: IconName, label: string, className = 'icon-btn'): HTMLButtonElement {
  const b = el('button', className, ICONS[icon]);
  b.type = 'button';
  b.title = label;
  b.setAttribute('aria-label', label);
  return b;
}

const MOBILE_QUERY = '(max-width: 760px)';

export class UI {
  private readonly bindings: Array<(p: PlanetParams) => void> = [];
  private readonly presetButtons = new Map<string, HTMLButtonElement>();
  private readonly tabButtons = new Map<string, HTMLButtonElement>();
  private readonly tabPages = new Map<string, HTMLElement>();
  private readonly nameEl: HTMLElement;
  private readonly subtitleEl: HTMLElement;
  private readonly busyEl: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly toastEl: HTMLElement;
  private toastTimer: number | undefined;
  private panelOpen: boolean;
  private activeTab = TABS[0].id;
  private exportDetail: ExportDetail = 'medium';
  private readonly mobile = window.matchMedia(MOBILE_QUERY);

  constructor(
    private readonly root: HTMLElement,
    private readonly app: App,
    private readonly handlers: UIHandlers,
  ) {
    root.classList.add('ui');

    // --- Top bar ------------------------------------------------------------------------
    const top = el('header', 'topbar');
    const titleBlock = el('div', 'title-block');
    const brand = el('div', 'brand', 'Tiny Planet');
    const nameRow = el('div', 'name-row');
    this.nameEl = el('h1', 'planet-name');
    this.nameEl.title = 'Tap to rename — the name seeds the planet';
    this.nameEl.tabIndex = 0;
    this.busyEl = el('span', 'busy');
    nameRow.append(this.nameEl, this.busyEl);
    this.subtitleEl = el('div', 'subtitle');
    titleBlock.append(brand, nameRow, this.subtitleEl);

    const actions = el('div', 'top-actions');
    const shotBtn = iconButton('camera', 'Save screenshot');
    const shareBtn = iconButton('share', 'Share this planet');
    const panelBtn = iconButton('sliders', 'Customize', 'icon-btn panel-toggle');
    actions.append(shotBtn, shareBtn, panelBtn);
    top.append(titleBlock, actions);

    // --- Bottom: presets + randomize ------------------------------------------------------
    const bottom = el('footer', 'bottombar');
    const presetStrip = el('div', 'presets');
    for (const p of PRESETS) {
      const b = el('button', 'preset');
      b.type = 'button';
      b.title = `${p.kind} — tap again for a variation`;
      const dot = el('span', 'preset-dot');
      dot.style.background = `radial-gradient(circle at 32% 30%, ${p.swatch[0]} 0%, ${p.swatch[0]} 35%, ${p.swatch[1]} 100%)`;
      b.append(dot, el('span', 'preset-label', p.label));
      b.addEventListener('click', () => this.choosePreset(p.id));
      this.presetButtons.set(p.id, b);
      presetStrip.append(b);
    }
    const dice = el('button', 'dice-btn', `${ICONS.dice}<span>Surprise me</span>`);
    dice.type = 'button';
    dice.title = 'Random planet (R)';
    dice.addEventListener('click', () => this.randomize());
    bottom.append(presetStrip, dice);

    // --- Panel ------------------------------------------------------------------------------
    this.panel = el('aside', 'panel');
    const handle = el('div', 'panel-handle');
    handle.append(el('span'));
    const tabsBar = el('nav', 'tabs');
    const pages = el('div', 'pages');
    for (const tab of TABS) {
      const tb = el('button', 'tab', `${ICONS[tab.icon]}<span>${tab.label}</span>`);
      tb.type = 'button';
      tb.addEventListener('click', () => this.selectTab(tab.id));
      this.tabButtons.set(tab.id, tb);
      tabsBar.append(tb);
      const page = el('section', 'page');
      for (const c of tab.controls) page.append(this.buildControl(c));
      this.tabPages.set(tab.id, page);
      pages.append(page);
    }
    this.panel.append(handle, tabsBar, pages);

    this.toastEl = el('div', 'toast');
    const showUi = iconButton('eye', 'Show interface', 'icon-btn show-ui');
    root.append(top, bottom, this.panel, this.toastEl, showUi);

    // --- Events -----------------------------------------------------------------------------
    shotBtn.addEventListener('click', () => void this.handlers.screenshot());
    shareBtn.addEventListener('click', () => void this.handlers.share());
    panelBtn.addEventListener('click', () => this.setPanelOpen(!this.panelOpen));
    handle.addEventListener('click', () => this.setPanelOpen(!this.panelOpen));
    showUi.addEventListener('click', () => this.setHidden(false));
    this.setupNameEditing();
    this.setupSheetDrag(handle);
    window.addEventListener('keydown', this.onKey);
    this.mobile.addEventListener('change', () => this.updateInsets());
    window.addEventListener('resize', () => this.updateInsets());

    // Open by default only where there's room for both the planet and the panel.
    this.panelOpen = !this.mobile.matches && window.innerWidth >= 1000 && window.innerHeight >= 560;
    this.selectTab(this.activeTab);
    this.setPanelOpen(this.panelOpen);
    this.refresh(app.params);
  }

  // ---------------------------------------------------------------------------------------
  refresh(p: PlanetParams, changed?: ParamKey[]): void {
    for (const b of this.bindings) b(p);
    this.nameEl.textContent = p.name;
    const preset = getPreset(p.preset);
    const moons = p.moons === 0 ? 'no moons' : p.moons === 1 ? '1 moon' : `${p.moons} moons`;
    const extras = [preset?.kind ?? 'Custom world', moons];
    if (p.rings > 0.001) extras.push('rings');
    this.subtitleEl.textContent = extras.join(' · ');
    for (const [id, b] of this.presetButtons) b.classList.toggle('active', id === p.preset);
    if (changed?.includes('preset')) this.presetButtons.get(p.preset)?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }

  setBusy(busy: boolean): void {
    this.busyEl.classList.toggle('on', busy);
  }

  /** One-time gesture hint for first-time visitors. */
  showHint(canvas: HTMLElement): void {
    try {
      if (localStorage.getItem('tinyplanet.hinted')) return;
      localStorage.setItem('tinyplanet.hinted', '1');
    } catch {
      /* storage unavailable: show the hint anyway */
    }
    const touch = window.matchMedia('(pointer: coarse)').matches;
    const hint = el('div', 'hint', touch ? 'Drag to spin · Pinch to zoom' : 'Drag to spin · Scroll to zoom');
    this.root.append(hint);
    const hide = () => {
      hint.classList.remove('show');
      window.setTimeout(() => hint.remove(), 600);
      canvas.removeEventListener('pointerdown', hide);
    };
    window.setTimeout(() => hint.classList.add('show'), 1400);
    window.setTimeout(hide, 7000);
    canvas.addEventListener('pointerdown', hide);
  }

  toast(message: string): void {
    this.toastEl.textContent = message;
    this.toastEl.classList.add('show');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('show'), 2200);
  }

  // ---------------------------------------------------------------------------------------
  private choosePreset(id: string): void {
    const preset = getPreset(id);
    if (!preset) return;
    navigator.vibrate?.(8);
    if (this.app.params.preset === id) {
      this.app.setParams(randomPlanet(id));
      this.toast(`New ${preset.label} variation`);
    } else {
      this.app.setParams(preset.params);
    }
  }

  private randomize(): void {
    navigator.vibrate?.(10);
    this.app.setParams(randomPlanet());
  }

  private selectTab(id: string): void {
    this.activeTab = id;
    for (const [tid, b] of this.tabButtons) b.classList.toggle('active', tid === id);
    for (const [tid, page] of this.tabPages) page.classList.toggle('active', tid === id);
  }

  private setPanelOpen(open: boolean): void {
    this.panelOpen = open;
    this.root.classList.toggle('panel-open', open);
    this.updateInsets();
  }

  private setHidden(hidden: boolean): void {
    this.root.classList.toggle('hidden', hidden);
    this.updateInsets();
  }

  private updateInsets(): void {
    const hidden = this.root.classList.contains('hidden');
    if (!this.panelOpen || hidden) {
      this.app.setViewInsets(0, 0);
      return;
    }
    if (this.mobile.matches) {
      this.app.setViewInsets(0, Math.round(window.innerHeight * 0.48));
    } else {
      this.app.setViewInsets(this.panel.offsetWidth + 24, 0);
    }
  }

  private readonly onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t && (t.isContentEditable || t.tagName === 'INPUT')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'r' || e.key === 'R') this.randomize();
    else if (e.key === 'h' || e.key === 'H') this.setHidden(!this.root.classList.contains('hidden'));
    else if (e.key === 'Escape') this.setPanelOpen(false);
  };

  private setupNameEditing(): void {
    const name = this.nameEl;
    let before = '';
    const commit = () => {
      name.contentEditable = 'false';
      name.classList.remove('editing');
      const text = (name.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
      if (!text || text === before) {
        name.textContent = before;
        return;
      }
      this.app.setParams({ name: text, seed: hashString(text.toLowerCase()) });
      this.toast(`Planet seeded from “${text}”`);
    };
    const start = () => {
      if (name.isContentEditable) return;
      before = name.textContent ?? '';
      name.contentEditable = 'true';
      name.classList.add('editing');
      name.focus();
      const range = document.createRange();
      range.selectNodeContents(name);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    };
    name.addEventListener('click', start);
    name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !name.isContentEditable) {
        e.preventDefault();
        start();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        name.blur();
      } else if (e.key === 'Escape') {
        name.textContent = before;
        name.blur();
      }
    });
    name.addEventListener('blur', () => {
      if (name.isContentEditable) commit();
    });
  }

  /** Drag the bottom sheet handle down to close it on phones. */
  private setupSheetDrag(handle: HTMLElement): void {
    let startY = 0;
    let dragging = false;
    handle.addEventListener('pointerdown', (e) => {
      if (!this.mobile.matches) return;
      dragging = true;
      startY = e.clientY;
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointerup', (e) => {
      if (!dragging) return;
      dragging = false;
      const dy = e.clientY - startY;
      if (dy > 40) this.setPanelOpen(false);
      else if (dy < -40) this.setPanelOpen(true);
    });
  }

  // ---------------------------------------------------------------------------------------
  private buildControl(c: Control): HTMLElement {
    switch (c.kind) {
      case 'heading': {
        const h = el('div', 'ctl-heading', c.label);
        if (c.hint) h.append(el('small', '', c.hint));
        return h;
      }
      case 'slider':
        return this.buildSlider(c);
      case 'color': {
        return this.buildSwatches([[c.key, c.label]]);
      }
      case 'swatches':
        return this.buildSwatches(c.items);
      case 'segmented':
        return this.buildSegmented(c);
      case 'seed':
        return this.buildSeed();
      case 'actions': {
        const wrap = el('div', 'ctl-actions');
        for (const item of c.items) {
          const b = el('button', 'action-btn', `${ICONS[item.icon]}<span>${item.label}</span>`);
          b.type = 'button';
          b.addEventListener('click', () => this.runAction(item.id));
          wrap.append(b);
        }
        return wrap;
      }
    }
  }

  private runAction(id: string): void {
    if (id === 'export-glb') void this.handlers.exportGLB(this.exportDetail);
    else if (id === 'export-json') this.handlers.exportJSON();
    else if (id === 'copy-link') void this.handlers.copyLink();
    else if (id === 'hide-ui') this.setHidden(true);
  }

  private buildSlider(c: Extract<Control, { kind: 'slider' }>): HTMLElement {
    const row = el('label', 'ctl ctl-slider');
    const head = el('div', 'ctl-head');
    const value = el('span', 'ctl-value');
    head.append(el('span', 'ctl-label', c.label), value);
    const input = el('input');
    input.type = 'range';
    input.min = String(c.min);
    input.max = String(c.max);
    input.step = String(c.step);
    const fmt = c.fmt ?? ((v: number) => v.toFixed(2));
    const show = (v: number) => {
      value.textContent = fmt(v);
      const t = Math.min(1, Math.max(0, (v - c.min) / (c.max - c.min)));
      input.style.setProperty('--fill', `${(t * 100).toFixed(2)}%`);
    };
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      show(v);
      this.app.setParams({ [c.key]: v } as Partial<PlanetParams>);
    });
    // Double-click / double-tap the label to reset to the preset value.
    head.addEventListener('dblclick', (e) => {
      e.preventDefault();
      const base = getPreset(this.app.params.preset)?.params;
      if (base) this.app.setParams({ [c.key]: base[c.key] } as Partial<PlanetParams>);
    });
    this.bindings.push((p) => {
      const v = p[c.key];
      if (document.activeElement !== input) input.value = String(v);
      show(v);
    });
    row.append(head, input);
    return row;
  }

  private buildSwatches(items: Array<[ColorKey, string]>): HTMLElement {
    const grid = el('div', 'swatches');
    for (const [key, label] of items) {
      const item = el('label', 'swatch');
      const chip = el('span', 'swatch-chip');
      const input = el('input');
      input.type = 'color';
      input.addEventListener('input', () => {
        chip.style.background = input.value;
        this.app.setParams({ [key]: input.value } as Partial<PlanetParams>);
      });
      chip.append(input);
      item.append(chip, el('span', 'swatch-label', label));
      this.bindings.push((p) => {
        input.value = p[key];
        chip.style.background = p[key];
      });
      grid.append(item);
    }
    return grid;
  }

  private buildSegmented(c: Extract<Control, { kind: 'segmented' }>): HTMLElement {
    const row = el('div', 'ctl ctl-seg');
    row.append(el('span', 'ctl-label', c.label));
    const group = el('div', 'segmented');
    const buttons: HTMLButtonElement[] = [];
    for (const o of c.options) {
      const b = el('button', 'seg', o.label);
      b.type = 'button';
      b.dataset.value = o.value;
      b.addEventListener('click', () => {
        if (c.key === 'exportDetail') {
          this.exportDetail = o.value as ExportDetail;
          this.syncSegment(buttons, o.value);
        } else if (c.key === 'quality') {
          this.app.setQuality(o.value as QualityLevel);
          this.syncSegment(buttons, o.value);
          try {
            localStorage.setItem('tinyplanet.quality', o.value);
          } catch {
            /* storage unavailable */
          }
        } else if (c.key === 'lowPoly') {
          this.app.setParams({ lowPoly: o.value === 'true' });
        } else {
          this.app.setParams({ liquid: o.value as PlanetParams['liquid'] });
        }
      });
      buttons.push(b);
      group.append(b);
    }
    row.append(group);
    this.bindings.push((p) => {
      const v = c.key === 'quality' ? this.app.quality.level : c.key === 'exportDetail' ? this.exportDetail : String(p[c.key]);
      this.syncSegment(buttons, v);
    });
    return row;
  }

  private syncSegment(buttons: HTMLButtonElement[], value: string): void {
    for (const b of buttons) b.classList.toggle('active', b.dataset.value === value);
  }

  private buildSeed(): HTMLElement {
    const row = el('div', 'ctl ctl-seed');
    row.append(el('span', 'ctl-label', 'Seed'));
    const input = el('input', 'seed-input');
    input.type = 'text';
    input.inputMode = 'numeric';
    input.spellcheck = false;
    input.addEventListener('change', () => {
      const raw = input.value.trim();
      if (!raw) return;
      const seed = /^\d+$/.test(raw) ? Number(raw) >>> 0 : hashString(raw.toLowerCase());
      this.app.setParams({ seed, name: planetName(seed) });
    });
    const reroll = iconButton('refresh', 'New seed (same settings)', 'icon-btn small');
    reroll.addEventListener('click', () => {
      const seed = randomSeed();
      this.app.setParams({ seed, name: planetName(seed) });
    });
    row.append(input, reroll);
    this.bindings.push((p) => {
      if (document.activeElement !== input) input.value = String(p.seed);
    });
    return row;
  }
}
