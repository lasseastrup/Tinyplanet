import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GeneratorClient } from '../planet/GeneratorClient';
import type { MoonResult, TerrainResult } from '../planet/generator';
import {
  sanitizeParams,
  shapeParamsOf,
  SHAPE_KEYS,
  SOFT_REGEN_KEYS,
  type ParamKey,
  type PlanetParams,
} from '../planet/params';
import { PlanetView } from '../render/PlanetView';
import { PostFX } from '../render/PostFX';
import { qualitySettings, type QualityLevel, type QualitySettings } from '../render/quality';
import { SpaceBackground } from '../render/SpaceBackground';

export interface AppEvents {
  change?: (params: PlanetParams, changed: ParamKey[]) => void;
  busy?: (busy: boolean) => void;
  generated?: (info: TerrainResult) => void;
}

const FOV = 35;

export class App {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly planet: PlanetView;
  readonly space: SpaceBackground;
  readonly post: PostFX;
  private readonly generator = new GeneratorClient();

  params: PlanetParams;
  quality: QualitySettings;
  events: AppEvents = {};

  private pixelRatio = 1;
  private maxPixelRatio = 2;
  private readonly timer = new THREE.Timer();
  private time = 0;
  private fullTimer: number | undefined;
  private fullPending = false;
  private frameTimes: number[] = [];
  private lastAdapt = 0;
  private fitDistance = 5;
  private viewW = 1;
  private viewH = 1;
  private insets = { right: 0, bottom: 0 };
  private targetInsets = { right: 0, bottom: 0 };
  private hasTerrain = false;
  /** Camera dolly animation (fly-in on first load, gentle swoosh when switching planets). */
  private dolly: { t: number; duration: number; base: number; curve: (t: number) => number } | null = null;
  private disposed = false;
  private paused = false;
  /** Set to render frames on demand only (e.g. for screenshots in tests). */
  manualFrames = false;

  constructor(
    private readonly container: HTMLElement,
    initial: PlanetParams,
    level: QualityLevel,
  ) {
    this.params = sanitizeParams(initial);
    this.quality = qualitySettings(level);

    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.classList.add('planet-canvas');
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 3000);
    this.camera.position.set(0, 1.6, 6.2);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.enablePan = false;
    this.controls.rotateSpeed = 0.55;
    this.controls.zoomSpeed = 0.9;
    this.controls.minDistance = 1.7;
    this.controls.maxDistance = 30;
    this.controls.addEventListener('start', () => {
      this.dolly = null;
    });

    this.planet = new PlanetView(this.quality.defines);
    this.scene.add(this.planet.root);

    this.space = new SpaceBackground(this.planet.uniforms.uTime);
    this.scene.add(this.space.group);

    this.post = new PostFX(this.renderer, this.planet.uniforms, this.quality);

    this.generator.onResult((res, req) => {
      if (res.terrain) {
        this.planet.setTerrain(res.terrain, req.shape.heightScale, req.shape.lowPoly);
        if (!this.hasTerrain) this.startDolly(2.4, (t) => 1.9 - 0.9 * (1 - Math.pow(1 - t, 3)));
        this.hasTerrain = true;
        this.events.generated?.(res.terrain);
      }
      if (res.moons) this.planet.setMoons(res.moons as MoonResult[], req.shape.lowPoly);
    });
    this.generator.onBusy((busy) => this.events.busy?.(busy));

    this.planet.applyParams(this.params);
    this.applyLook();
    this.space.build(this.renderer, this.scene, this.params.seed);
    this.regenerate({ terrain: true, moons: true }, true);

    window.addEventListener('resize', this.onResize);
    document.addEventListener('visibilitychange', this.onVisibility);
    const canvas = this.renderer.domElement;
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.paused = true;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      // Render-target contents (e.g. the baked nebula) are lost with the context.
      this.space.build(this.renderer, this.scene, this.params.seed, true);
      this.paused = document.hidden;
      this.timer.reset();
    });
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, this.quality.maxPixelRatio);
    this.onResize();
    this.frameCamera(true);
  }

  start(): void {
    this.timer.connect(document);
    this.renderer.setAnimationLoop((t) => this.frame(t));
  }

  /** Render a single frame immediately (used for screenshots). */
  renderOnce(dt = 0): void {
    this.animateDolly(1e3);
    this.updateDetailBoost();
    if (this.insets.right !== this.targetInsets.right || this.insets.bottom !== this.targetInsets.bottom) {
      this.insets = { ...this.targetInsets };
      this.applyView();
    }
    this.time += dt;
    this.planet.update(this.time, dt);
    this.controls.update();
    this.post.render(this.scene, this.camera, dt);
  }

  get ready(): boolean {
    return this.hasTerrain;
  }

  /** True while terrain is being generated or a refinement pass is pending. */
  get generating(): boolean {
    return this.generator.busy || this.fullPending;
  }

  private frame(timestamp: number): void {
    if (this.disposed || this.paused) return;
    this.timer.update(timestamp);
    const dt = Math.min(this.timer.getDelta(), 0.1);
    if (this.manualFrames) return;
    this.time += dt;
    this.animateInsets(dt);
    this.animateDolly(dt);
    this.updateDetailBoost();
    this.planet.update(this.time, dt);
    this.controls.update();
    this.post.render(this.scene, this.camera, dt);
    this.adaptResolution(dt);
  }

  /** Animate the camera distance as base·curve(t) over `duration` seconds (curve(1) must be 1). */
  private startDolly(duration: number, curve: (t: number) => number): void {
    if (this.dolly) this.animateDolly(1e3); // finish any running dolly first
    const base = this.camera.position.distanceTo(this.controls.target);
    this.dolly = { t: 0, duration, base, curve };
    this.setCameraDistance(base * curve(0));
  }

  private animateDolly(dt: number): void {
    const d = this.dolly;
    if (!d) return;
    d.t = Math.min(1, d.t + dt / d.duration);
    // Absolute distances: clamping by the controls can't make the camera creep over time.
    this.setCameraDistance(d.base * d.curve(d.t));
    if (d.t >= 1) this.dolly = null;
  }

  private setCameraDistance(distance: number): void {
    const offset = this.camera.position.clone().sub(this.controls.target).setLength(distance);
    this.camera.position.copy(this.controls.target).add(offset);
  }

  /** More cloud/terrain octaves when the camera is close (continuous, so detail fades in). */
  private updateDetailBoost(): void {
    const dist = this.camera.position.distanceTo(this.controls.target);
    const boost = this.quality.level === 'low' ? 0 : THREE.MathUtils.clamp((3.9 - dist) / 0.9, 0, 2);
    this.planet.uniforms.uDetailBoost.value = boost;
  }

  /** Reserve screen space (px) covered by UI so the planet stays centred in the visible area. */
  setViewInsets(right: number, bottom: number): void {
    this.targetInsets = { right: Math.max(0, right), bottom: Math.max(0, bottom) };
  }

  private animateInsets(dt: number): void {
    const t = this.targetInsets;
    const c = this.insets;
    if (Math.abs(t.right - c.right) < 0.5 && Math.abs(t.bottom - c.bottom) < 0.5) {
      if (c.right !== t.right || c.bottom !== t.bottom) {
        this.insets = { ...t };
        this.applyView();
      }
      return;
    }
    const k = 1 - Math.exp(-dt * 9);
    c.right += (t.right - c.right) * k;
    c.bottom += (t.bottom - c.bottom) * k;
    this.applyView();
  }

  private applyView(): void {
    const W = this.viewW;
    const H = this.viewH;
    const r = Math.min(this.insets.right, W * 0.6);
    const b = Math.min(this.insets.bottom, H * 0.7);
    const tanHalf = Math.tan((FOV * Math.PI) / 360);
    this.camera.fov = (Math.atan(tanHalf * ((H + b) / H)) * 360) / Math.PI;
    this.camera.aspect = (W + r) / (H + b);
    if (r > 0 || b > 0) this.camera.setViewOffset(W + r, H + b, r, b, W, H);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
    this.frameCamera(false);
  }

  /** Patch parameters; decides what needs regenerating. */
  setParams(patch: Partial<PlanetParams>): void {
    const next = sanitizeParams({ ...this.params, ...patch }, this.params);
    const changed = (Object.keys(next) as ParamKey[]).filter((k) => next[k] !== this.params[k]);
    if (changed.length === 0) return;
    const prev = this.params;
    this.params = next;

    const shape = changed.some((k) => SHAPE_KEYS.has(k) && k !== 'moons');
    const moons = changed.includes('moons') || changed.includes('seed') || changed.includes('lowPoly');
    const soft = changed.some((k) => SOFT_REGEN_KEYS.has(k));

    this.planet.applyParams(next);
    this.applyLook();
    if (changed.includes('seed')) this.space.build(this.renderer, this.scene, next.seed);
    if (changed.includes('rings') || changed.includes('ringOuter')) {
      if ((prev.rings > 0) !== (next.rings > 0) || changed.includes('ringOuter')) this.frameCamera(false);
    }

    if (this.hasTerrain && (changed.includes('seed') || changed.includes('preset'))) {
      this.startDolly(1.1, (t) => 1 + 0.14 * Math.sin(Math.PI * t) * (1 - 0.3 * t));
    }
    if (shape) this.regenerate({ terrain: true, moons }, true);
    else if (moons) this.regenerate({ terrain: false, moons: true }, false);
    else if (soft) this.scheduleFull({ terrain: true, moons: false }, 350);

    this.events.change?.(next, changed);
  }

  /** Replace all parameters (e.g. a preset). */
  replaceParams(p: PlanetParams): void {
    this.setParams(p);
  }

  private regenerate(what: { terrain: boolean; moons: boolean }, preview: boolean): void {
    const shape = shapeParamsOf(this.params, this.quality.maxFrequency);
    if (preview && what.terrain && !shape.lowPoly) {
      this.generator.request(shape, what, true);
      this.scheduleFull({ terrain: true, moons: false }, 220);
    } else {
      if (what.terrain) {
        // This request already delivers full-quality terrain; a pending refinement is redundant.
        window.clearTimeout(this.fullTimer);
        this.fullPending = false;
      }
      this.generator.request(shape, what, false);
    }
  }

  private scheduleFull(what: { terrain: boolean; moons: boolean }, delay: number): void {
    window.clearTimeout(this.fullTimer);
    this.fullPending = true;
    this.fullTimer = window.setTimeout(() => {
      this.fullPending = false;
      this.generator.request(shapeParamsOf(this.params, this.quality.maxFrequency), what, false);
    }, delay);
  }

  setQuality(level: QualityLevel): void {
    if (level === this.quality.level) return;
    this.quality = qualitySettings(level);
    this.planet.setQuality(this.quality.defines);
    this.post.setQuality(this.quality);
    this.maxPixelRatio = Math.min(window.devicePixelRatio || 1, this.quality.maxPixelRatio);
    this.pixelRatio = this.maxPixelRatio;
    this.onResize();
    this.regenerate({ terrain: true, moons: false }, false);
  }

  private applyLook(): void {
    const p = this.params;
    this.renderer.toneMappingExposure = p.exposure;
    this.post.setLook(p.bloom * 0.9, 3.4);
    this.space.setSun(this.planet.uniforms.uSunDir.value, new THREE.Color(1, 0.95, 0.88), p.sunIntensity);
  }

  private readonly onVisibility = () => {
    this.paused = document.hidden;
    if (!this.paused) this.timer.reset();
  };

  private readonly onResize = () => {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.maxPixelRatio = Math.min(window.devicePixelRatio || 1, this.quality.maxPixelRatio);
    this.pixelRatio = Math.min(this.pixelRatio, this.maxPixelRatio);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;
    this.viewW = w;
    this.viewH = h;
    this.post.setSize(w * this.pixelRatio, h * this.pixelRatio);
    this.space.setPixelRatio(this.pixelRatio);
    this.applyView();
  };

  /** Keep the planet nicely framed for the current aspect ratio. */
  private frameCamera(reset: boolean): void {
    const p = this.params;
    const radius = Math.max(1.22, p.rings > 0.001 ? p.ringOuter * 0.92 : 0);
    const tanHalf = Math.tan((FOV * Math.PI) / 360);
    // Visible region (excluding UI insets), relative to the full viewport height.
    const visH = Math.max(0.25, (this.viewH - Math.min(this.insets.bottom, this.viewH * 0.7)) / this.viewH);
    const visW = Math.max(0.25, (this.viewW - Math.min(this.insets.right, this.viewW * 0.6)) / this.viewH);
    const fit = Math.max(radius / (tanHalf * visH * 0.72), radius / (tanHalf * visW * 0.84));
    const offset = this.camera.position.clone().sub(this.controls.target);
    const current = offset.length();
    const next = reset || !Number.isFinite(current) || current === 0 ? fit : (current * fit) / this.fitDistance;
    if (this.dolly) this.dolly.base = reset ? fit : (this.dolly.base * fit) / this.fitDistance;
    this.fitDistance = fit;
    if (reset) offset.set(0, 0.26, 1);
    offset.setLength(THREE.MathUtils.clamp(next, this.controls.minDistance, this.controls.maxDistance));
    this.camera.position.copy(this.controls.target).add(offset);
    this.controls.maxDistance = Math.max(12, fit * 3);
  }

  /** Lower the render resolution if the device can't keep up (and raise it again if it can). */
  private adaptResolution(dt: number): void {
    this.frameTimes.push(dt);
    if (this.frameTimes.length < 90) return;
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    this.frameTimes.length = 0;
    const now = performance.now();
    if (now - this.lastAdapt < 2500) return;
    let next = this.pixelRatio;
    // Thresholds tolerate 30 Hz display caps (e.g. iOS Low Power Mode) without degrading resolution.
    if (avg > 1 / 28 && this.pixelRatio > 0.75) next = Math.max(0.75, this.pixelRatio - 0.25);
    else if (avg < 1 / 55 && this.pixelRatio < this.maxPixelRatio) next = Math.min(this.maxPixelRatio, this.pixelRatio + 0.25);
    if (next !== this.pixelRatio) {
      this.pixelRatio = next;
      this.lastAdapt = now;
      this.onResize();
    }
  }

  /** Capture the current view as a PNG blob (centred, ignoring UI insets). */
  screenshot(): Promise<Blob | null> {
    const saved = { ...this.insets };
    this.insets = { right: 0, bottom: 0 };
    this.applyView();
    this.post.render(this.scene, this.camera, 0);
    const result = new Promise<Blob | null>((resolve) => this.renderer.domElement.toBlob((b) => resolve(b), 'image/png'));
    this.insets = saved;
    this.applyView();
    return result;
  }

  dispose(): void {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.timer.dispose();
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.generator.dispose();
    this.planet.dispose();
    this.space.dispose();
    this.post.dispose();
    this.controls.dispose();
    this.renderer.dispose();
  }
}
