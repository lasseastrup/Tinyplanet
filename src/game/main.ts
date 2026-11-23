import '../style.css';
import '../ui/ui.css';
import './game.css';
import { App } from '../app/App';
import { FAMILIES, customWorld, makeWorld } from './worlds';
import { encodeParams, paramsFromHash } from '../planet/share';
import { detectDefaultQuality, type QualityLevel } from '../render/quality';
import { Game } from './Game';
import { Hud } from './Hud';
import { Input } from './Input';
import { Sfx } from './Sfx';

function initialQuality(search: URLSearchParams): QualityLevel {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem('tinyplanet.quality');
  } catch {
    /* storage unavailable */
  }
  const q = search.get('quality') ?? stored;
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
  msg.innerHTML = '<h1>Tiny Planet</h1><p>Flying needs WebGL 2, which isn’t available in this browser.<br>Try a recent Chrome, Safari, Firefox or Edge.</p>';
  document.body.appendChild(msg);
  throw new Error('WebGL2 not supported');
}

const search = new URLSearchParams(location.search);
const viewport = document.getElementById('viewport')!;
const uiRoot = document.getElementById('ui')!;
const loader = document.getElementById('loader');

// A planet handed over from the editor (#p=…) is flown as it is; otherwise start on a tiny
// Pocket, Isle or Snowglobe world (?world=isle&seed=42 picks one).
const handed = paramsFromHash(location.hash);
const asked = search.get('world');
const family = FAMILIES.find((f) => f === asked) ?? FAMILIES[Math.floor(Math.random() * FAMILIES.length)];
const seed = Number(search.get('seed'));
const firstWorld = handed ? customWorld(handed) : makeWorld(family, true, Number.isInteger(seed) && seed > 0 ? seed >>> 0 : undefined);
if (handed) history.replaceState(null, '', location.pathname + location.search);

const app = new App(viewport, firstWorld.params, initialQuality(search));
const sfx = new Sfx();
const hud = new Hud(uiRoot, {
  newWorld: () => game.nextWorld(),
  toggleMute: () => toggleMute(),
  editorUrl: () => `./#p=${encodeParams(game.current.editorParams)}`,
});
const input = new Input(app.renderer.domElement, uiRoot);
const game = new Game(app, hud, input, sfx, firstWorld);

function toggleMute(): void {
  sfx.setMuted(!sfx.muted);
  hud.setMuted(sfx.muted);
}
hud.setMuted(sfx.muted);

input.onAction((action) => {
  if (action === 'newWorld') game.nextWorld();
  else if (action === 'mute') toggleMute();
  else if (action === 'hud') hud.toggleHidden();
});

app.setCameraRig(game);
app.events.props = (placement) => game.onProps(placement);
app.events.generated = () => game.onGenerated();
game.onFirstArrival = () => {
  if (!loader) return;
  loader.classList.add('done');
  document.body.classList.add('ready');
  window.setTimeout(() => loader.remove(), 900);
};

// iOS: stop pinch-zoom of the page itself.
document.addEventListener('gesturestart', (e) => e.preventDefault());

app.start();

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('Service worker registration failed', err));
  });
}

declare global {
  interface Window {
    __tinyplanetGame?: Game;
  }
}
window.__tinyplanetGame = game;
