import './style.css';
import './ui/ui.css';
import { App } from './app/App';
import { copyText, deliverFile, slug } from './export/deliver';
import { DEFAULT_PARAMS, sanitizeParams, shapeParamsOf, type PlanetParams } from './planet/params';
import { getPreset } from './planet/presets';
import { encodeParams, paramsFromHash, shareUrl } from './planet/share';
import { detectDefaultQuality, type QualityLevel } from './render/quality';
import { UI } from './ui/UI';

const STORAGE_KEY = 'tinyplanet.last';
const EXPORT_FREQUENCY = { low: 32, medium: 64, high: 112 } as const;
const QUALITY_KEY = 'tinyplanet.quality';

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode / storage disabled */
  }
}

function initialParams(search: URLSearchParams): PlanetParams {
  const presetId = search.get('preset');
  if (presetId && getPreset(presetId)) return getPreset(presetId)!.params;
  const fromHash = paramsFromHash(location.hash);
  if (fromHash) return fromHash;
  const saved = storageGet(STORAGE_KEY);
  if (saved) {
    try {
      const obj = JSON.parse(saved) as Record<string, unknown>;
      const base = (typeof obj.preset === 'string' && getPreset(obj.preset)?.params) || DEFAULT_PARAMS;
      return sanitizeParams(obj, base);
    } catch {
      /* ignore corrupt state */
    }
  }
  return DEFAULT_PARAMS;
}

function initialQuality(search: URLSearchParams): QualityLevel {
  const q = search.get('quality') ?? storageGet(QUALITY_KEY);
  return q === 'low' || q === 'medium' || q === 'high' ? q : detectDefaultQuality();
}

function supportsWebGL2(): boolean {
  try {
    return !!document.createElement('canvas').getContext('webgl2');
  } catch {
    return false;
  }
}

if (!supportsWebGL2()) {
  document.getElementById('loader')?.remove();
  const msg = document.createElement('div');
  msg.className = 'unsupported';
  msg.innerHTML =
    '<h1>Tiny Planet</h1><p>This app needs WebGL 2, which isn’t available in this browser.<br>Try a recent Chrome, Safari, Firefox or Edge.</p>';
  document.body.appendChild(msg);
  throw new Error('WebGL2 not supported');
}

const search = new URLSearchParams(location.search);
const viewport = document.getElementById('viewport')!;
const uiRoot = document.getElementById('ui')!;
const loader = document.getElementById('loader');

const app = new App(viewport, initialParams(search), initialQuality(search));

const ui = new UI(uiRoot, app, {
  async exportGLB(detail) {
    if (!app.ready) return;
    ui.toast('Packing your planet…');
    try {
      const [{ exportPlanetGLB }, { generateTerrain }] = await Promise.all([import('./export/exportGLB'), import('./planet/generator')]);
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const shape = shapeParamsOf(app.params, 1000);
      // Game-friendly resolution (low-poly planets keep their own facet count).
      const frequency = shape.lowPoly ? undefined : EXPORT_FREQUENCY[detail];
      const terrain = generateTerrain(shape, false, frequency);
      const blob = await exportPlanetGLB(app.planet, app.params, terrain.mesh, shape.heightScale);
      const result = await deliverFile(blob, `${slug(app.params.name) || 'tiny-planet'}.glb`, app.params.name);
      if (result === 'downloaded') ui.toast('Saved 3D model (.glb)');
    } catch (err) {
      console.error(err);
      ui.toast('Export failed');
    }
  },
  exportJSON() {
    const json = JSON.stringify({ generator: 'Tiny Planet', version: 1, params: app.params }, null, 2);
    void deliverFile(new Blob([json], { type: 'application/json' }), `${slug(app.params.name) || 'tiny-planet'}.json`, app.params.name).then(
      (r) => r === 'downloaded' && ui.toast('Saved planet settings (.json)'),
    );
  },
  async share() {
    const url = shareUrl(app.params);
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: app.params.name, text: `Meet ${app.params.name}, my tiny planet 🪐`, url });
        return;
      } catch (err) {
        if ((err as DOMException)?.name === 'AbortError') return;
      }
    }
    if (await copyText(url)) ui.toast('Link copied — paste it anywhere');
  },
  async copyLink() {
    if (await copyText(shareUrl(app.params))) ui.toast('Link copied');
  },
  async screenshot() {
    const blob = await app.screenshot();
    if (!blob) return;
    const result = await deliverFile(blob, `${slug(app.params.name) || 'tiny-planet'}.png`, app.params.name);
    if (result === 'downloaded') ui.toast('Screenshot saved');
  },
});

// Keep the URL (and last-visited planet) in sync, so reloads and home-screen launches restore it.
let syncTimer: number | undefined;
app.events.change = (params, changed) => {
  ui.refresh(params, changed);
  window.clearTimeout(syncTimer);
  syncTimer = window.setTimeout(() => {
    history.replaceState(null, '', `${location.pathname}${location.search}#p=${encodeParams(params)}`);
    storageSet(STORAGE_KEY, JSON.stringify(params));
  }, 400);
};
app.events.busy = (busy) => ui.setBusy(busy);
app.events.generated = () => {
  if (loader && !loader.classList.contains('done')) {
    loader.classList.add('done');
    document.body.classList.add('ready');
    window.setTimeout(() => loader.remove(), 900);
    ui.showHint(app.renderer.domElement);
  }
};

window.addEventListener('hashchange', () => {
  const p = paramsFromHash(location.hash);
  if (p && encodeParams(p) !== encodeParams(app.params)) app.setParams(p);
});

// iOS: stop pinch-zoom of the page itself (the planet handles its own pinch).
document.addEventListener('gesturestart', (e) => e.preventDefault());

app.start();

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('Service worker registration failed', err));
  });
}

declare global {
  interface Window {
    __tinyplanet?: App;
  }
}
window.__tinyplanet = app;
