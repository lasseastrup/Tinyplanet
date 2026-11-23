const MUTE_KEY = 'tinyplanet.game.muted';
const VOLUME = 0.8;

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
    /* storage unavailable */
  }
}

/**
 * Small synthesized sound effects (no audio files): blaster shots, impacts, pops, splashes, the
 * warp between worlds and a soft engine hum. Audio starts on the first key press or tap.
 */
export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private engineGain: GainNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;
  muted: boolean;

  constructor() {
    this.muted = storageGet(MUTE_KEY) === '1';
    window.addEventListener('pointerdown', this.unlock);
    window.addEventListener('keydown', this.unlock);
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.hidden) void this.ctx.suspend();
      else void this.ctx.resume();
    });
  }

  private readonly unlock = (): void => {
    if (this.ctx) {
      if (this.ctx.state === 'suspended' && !document.hidden) void this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : VOLUME;
    this.master.connect(comp);

    const len = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    // Engine: two detuned saws a fifth apart through a low-pass that opens with speed.
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 200;
    this.engineFilter.Q.value = 2;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineFilter.connect(this.engineGain).connect(this.master);
    for (const [f, d] of [[55, -6], [82.5, 7], [110, 3]] as const) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = f;
      osc.detune.value = d;
      osc.connect(this.engineFilter);
      osc.start();
    }
  };

  setMuted(muted: boolean): void {
    this.muted = muted;
    storageSet(MUTE_KEY, muted ? '1' : '0');
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(muted ? 0 : VOLUME, this.ctx.currentTime, 0.05);
  }

  private get live(): AudioContext | null {
    return this.ctx && this.master && !this.muted && this.ctx.state === 'running' ? this.ctx : null;
  }

  /** Engine level: 0 = silent, 1 = cruising; boost 0..1 opens it up. */
  engine(level: number, boost: number): void {
    const ctx = this.live;
    if (!ctx || !this.engineGain || !this.engineFilter) return;
    const t = ctx.currentTime;
    this.engineGain.gain.setTargetAtTime(level * (0.05 + 0.04 * boost), t, 0.15);
    this.engineFilter.frequency.setTargetAtTime(170 + 260 * boost, t, 0.2);
  }

  /** Blaster shot; pan -1 (left) … 1 (right). */
  shoot(pan: number): void {
    const ctx = this.live;
    if (!ctx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(1500 + Math.random() * 250, t);
    osc.frequency.exponentialRampToValueAtTime(240, t + 0.11);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 2800;
    const gain = this.envelope(ctx, t, 0.055, 0.004, 0.12);
    osc.connect(filter).connect(gain).connect(this.panner(ctx, pan));
    osc.start(t);
    osc.stop(t + 0.14);
  }

  /** A bolt hitting the ground (quiet: there are many). */
  impact(): void {
    const ctx = this.live;
    if (!ctx) return;
    const t = ctx.currentTime;
    this.noiseBurst(ctx, t, 'bandpass', 900, 0.8, 0.09, 0.14);
    this.thump(ctx, t, 140, 50, 0.08, 0.12);
  }

  splash(): void {
    const ctx = this.live;
    if (!ctx) return;
    const t = ctx.currentTime;
    const f = this.noiseBurst(ctx, t, 'lowpass', 5000, 0.5, 0.08, 0.3);
    f.frequency.exponentialRampToValueAtTime(700, t + 0.3);
  }

  /** Something blown apart. */
  pop(): void {
    const ctx = this.live;
    if (!ctx) return;
    const t = ctx.currentTime;
    const f = this.noiseBurst(ctx, t, 'lowpass', 2600, 0.7, 0.22, 0.5);
    f.frequency.exponentialRampToValueAtTime(180, t + 0.45);
    this.thump(ctx, t, 170, 42, 0.3, 0.3);
  }

  /** Leaving for another world. */
  warp(): void {
    const ctx = this.live;
    if (!ctx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(160, t);
    osc.frequency.exponentialRampToValueAtTime(1300, t + 0.9);
    const gain = this.envelope(ctx, t, 0.09, 0.5, 0.95);
    osc.connect(gain).connect(this.master!);
    osc.start(t);
    osc.stop(t + 1);
    const f = this.noiseBurst(ctx, t, 'bandpass', 300, 1.5, 0.08, 1.0, 0.6);
    f.frequency.exponentialRampToValueAtTime(3000, t + 0.9);
  }

  private envelope(ctx: AudioContext, t: number, peak: number, attack: number, end: number): GainNode {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + end);
    return g;
  }

  private panner(ctx: AudioContext, pan: number): AudioNode {
    if (typeof ctx.createStereoPanner !== 'function') return this.master!;
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    p.connect(this.master!);
    return p;
  }

  private noiseBurst(
    ctx: AudioContext,
    t: number,
    type: BiquadFilterType,
    freq: number,
    q: number,
    peak: number,
    end: number,
    attack = 0.004,
  ): BiquadFilterNode {
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(freq, t);
    filter.Q.value = q;
    src.connect(filter).connect(this.envelope(ctx, t, peak, attack, end)).connect(this.master!);
    src.start(t, Math.random() * 0.5);
    src.stop(t + end + 0.02);
    return filter;
  }

  private thump(ctx: AudioContext, t: number, f0: number, f1: number, peak: number, end: number): void {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(f1, t + end);
    osc.connect(this.envelope(ctx, t, peak, 0.005, end)).connect(this.master!);
    osc.start(t);
    osc.stop(t + end + 0.02);
  }
}
