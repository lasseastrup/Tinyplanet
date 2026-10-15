import * as THREE from 'three';

interface ControlsEventMap {
  start: object;
  end: object;
}

const LN_095 = -Math.log(0.95);

/**
 * Camera controls for looking at a globe. Dragging turns the globe in the drag direction with no
 * pole limits (the view rolls naturally as you pass over a pole); the wheel and a two-finger pinch
 * zoom. Movement eases out after release.
 *
 * The camera's `up` vector is part of the controls' state; anything that tilts the camera after
 * update() (by rotating its quaternion) does not feed back into the orbit.
 */
export class GlobeControls extends THREE.EventDispatcher<ControlsEventMap> {
  readonly target = new THREE.Vector3();
  minDistance = 0;
  maxDistance = Infinity;
  /** Radians of turn per screen height of drag, divided by 2π (as in OrbitControls). */
  rotateSpeed = 1;
  zoomSpeed = 1;
  enableDamping = true;
  /** Fraction of the pending movement applied each update. */
  dampingFactor = 0.07;
  enabled = true;

  private readonly camera: THREE.PerspectiveCamera;
  private readonly dom: HTMLElement;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  /** Pending turn about the camera's up and right axes, and pending log-distance change. */
  private yaw = 0;
  private pitch = 0;
  private zoom = 0;
  private pinch = 0;

  constructor(camera: THREE.PerspectiveCamera, dom: HTMLElement) {
    super();
    this.camera = camera;
    this.dom = dom;
    dom.style.touchAction = 'none';
    dom.addEventListener('pointerdown', this.onPointerDown);
    dom.addEventListener('pointermove', this.onPointerMove);
    dom.addEventListener('pointerup', this.onPointerUp);
    dom.addEventListener('pointercancel', this.onPointerUp);
    dom.addEventListener('wheel', this.onWheel, { passive: false });
    dom.addEventListener('contextmenu', this.onContextMenu);
  }

  /** Apply pending movement and aim the camera at the target. Call once per frame. */
  update(): void {
    const cam = this.camera;
    const offset = _offset.copy(cam.position).sub(this.target);
    let dist = offset.length();
    if (dist < 1e-9) {
      offset.set(0, 0, 1);
      dist = 1e-9;
    }
    const back = offset.divideScalar(dist);
    // Keep the up vector perpendicular to the view direction (it drifts as it is rotated).
    const up = _up.copy(cam.up).addScaledVector(back, -cam.up.dot(back));
    if (up.lengthSq() < 1e-12) up.set(0, 1, 0).addScaledVector(back, -back.y);
    up.normalize();

    const f = this.enableDamping ? this.dampingFactor : 1;
    const yaw = this.yaw * f;
    const pitch = this.pitch * f;
    const zoom = this.zoom * f;
    this.yaw = Math.abs(this.yaw - yaw) < 1e-6 ? 0 : this.yaw - yaw;
    this.pitch = Math.abs(this.pitch - pitch) < 1e-6 ? 0 : this.pitch - pitch;
    this.zoom = Math.abs(this.zoom - zoom) < 1e-6 ? 0 : this.zoom - zoom;

    if (yaw !== 0 || pitch !== 0) {
      const right = _right.crossVectors(up, back).normalize();
      _q.setFromAxisAngle(up, yaw).multiply(_q2.setFromAxisAngle(right, pitch));
      back.applyQuaternion(_q);
      up.applyQuaternion(_q);
    }
    if (zoom !== 0) dist *= Math.exp(zoom);
    dist = THREE.MathUtils.clamp(dist, this.minDistance, this.maxDistance);
    // Don't bank zoom past the limits, or zooming back would feel stuck for a moment.
    if ((dist <= this.minDistance && this.zoom < 0) || (dist >= this.maxDistance && this.zoom > 0)) this.zoom = 0;

    cam.position.copy(this.target).addScaledVector(back, dist);
    cam.up.copy(up);
    cam.lookAt(this.target);
  }

  dispose(): void {
    const dom = this.dom;
    dom.removeEventListener('pointerdown', this.onPointerDown);
    dom.removeEventListener('pointermove', this.onPointerMove);
    dom.removeEventListener('pointerup', this.onPointerUp);
    dom.removeEventListener('pointercancel', this.onPointerUp);
    dom.removeEventListener('wheel', this.onWheel);
    dom.removeEventListener('contextmenu', this.onContextMenu);
  }

  /** Turn the globe by a drag of (dx, dy) pixels. */
  private rotateBy(dx: number, dy: number): void {
    const k = (2 * Math.PI * this.rotateSpeed) / Math.max(1, this.dom.clientHeight);
    // The camera moves opposite to the drag so the surface follows the pointer.
    this.yaw -= dx * k;
    this.pitch -= dy * k;
  }

  private pinchDistance(): number {
    const [a, b] = [...this.pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (!this.enabled) return;
    this.dom.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 1) this.dispatchEvent({ type: 'start' });
    if (this.pointers.size === 2) this.pinch = this.pinchDistance();
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    const p = this.pointers.get(e.pointerId);
    if (!p || !this.enabled) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (this.pointers.size === 1) {
      this.rotateBy(dx, dy);
    } else if (this.pointers.size === 2) {
      // Two fingers: pinch to zoom, move together to turn.
      this.rotateBy(dx / 2, dy / 2);
      const d = this.pinchDistance();
      if (this.pinch > 0 && d > 0) this.zoom += Math.log(this.pinch / d);
      this.pinch = d;
    }
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (!this.pointers.delete(e.pointerId)) return;
    if (this.dom.hasPointerCapture(e.pointerId)) this.dom.releasePointerCapture(e.pointerId);
    this.pinch = this.pointers.size === 2 ? this.pinchDistance() : 0;
    if (this.pointers.size === 0) this.dispatchEvent({ type: 'end' });
  };

  private readonly onWheel = (e: WheelEvent): void => {
    if (!this.enabled) return;
    e.preventDefault();
    this.dispatchEvent({ type: 'start' });
    // Normalise line and page scrolling to pixels, then zoom like OrbitControls (5% per 100 px).
    const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.dom.clientHeight : 1;
    this.zoom += Math.sign(e.deltaY) * Math.abs(e.deltaY * scale) * 0.01 * this.zoomSpeed * LN_095;
    this.dispatchEvent({ type: 'end' });
  };

  private readonly onContextMenu = (e: Event): void => {
    if (this.enabled) e.preventDefault();
  };
}

const _offset = new THREE.Vector3();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
