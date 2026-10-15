import * as THREE from 'three';

/** Objects on this layer cast sun shadows (terrain, props, puffy clouds). */
export const SHADOW_LAYER = 2;

/**
 * A directional shadow map for the sun: an orthographic depth render of the shadow casters,
 * sampled with hardware PCF (sampler2DShadow) by the planet shaders via `sunShadowMap()`.
 */
export class SunShadow {
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 4);
  /** World → shadow clip space. */
  readonly matrix = new THREE.Matrix4();
  private target: THREE.WebGLRenderTarget;
  /** Depth-only caster material; the slope-scaled offset keeps surfaces from shadowing themselves. */
  private readonly depthOnly = new THREE.MeshBasicMaterial({
    colorWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: 1.5,
    polygonOffsetUnits: 2,
  });
  private size: number;

  constructor(size: number) {
    this.size = size;
    this.target = SunShadow.createTarget(size);
    this.camera.layers.set(SHADOW_LAYER);
  }

  private static createTarget(size: number): THREE.WebGLRenderTarget {
    // Only the depth texture is used; keep the (required) colour buffer as small as possible.
    const target = new THREE.WebGLRenderTarget(size, size, {
      format: THREE.RedFormat,
      type: THREE.UnsignedByteType,
      generateMipmaps: false,
    });
    const depth = new THREE.DepthTexture(size, size, THREE.UnsignedIntType);
    depth.format = THREE.DepthFormat;
    depth.compareFunction = THREE.LessEqualCompare;
    depth.minFilter = THREE.LinearFilter;
    depth.magFilter = THREE.LinearFilter;
    target.depthTexture = depth;
    return target;
  }

  get texture(): THREE.DepthTexture {
    return this.target.depthTexture!;
  }

  get mapSize(): number {
    return this.size;
  }

  setSize(size: number): void {
    if (size === this.size) return;
    this.size = size;
    this.target.depthTexture?.dispose();
    this.target.dispose();
    this.target = SunShadow.createTarget(size);
  }

  /** World units covered by one shadow-map texel. */
  get texelWorld(): number {
    return (this.camera.right - this.camera.left) / this.size;
  }

  /**
   * Render the casters as seen from the sun.
   * @param radius radius around `center` that holds every caster
   */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, center: THREE.Vector3, sunDir: THREE.Vector3, radius: number): void {
    const cam = this.camera;
    cam.left = -radius;
    cam.right = radius;
    cam.top = radius;
    cam.bottom = -radius;
    cam.near = 0.01;
    cam.far = radius * 2 + 0.2;
    cam.up.set(0, 1, 0);
    if (Math.abs(sunDir.y) > 0.99) cam.up.set(1, 0, 0);
    cam.position.copy(center).addScaledVector(sunDir, radius + 0.1);
    cam.lookAt(center);
    cam.updateMatrixWorld();
    cam.updateProjectionMatrix();
    this.matrix.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);

    const prevTarget = renderer.getRenderTarget();
    const prevOverride = scene.overrideMaterial;
    const prevAutoClear = renderer.autoClear;
    scene.overrideMaterial = this.depthOnly;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.target);
    renderer.clear(false, true, false);
    renderer.render(scene, cam);
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
    scene.overrideMaterial = prevOverride;
  }

  dispose(): void {
    this.target.depthTexture?.dispose();
    this.target.dispose();
    this.depthOnly.dispose();
  }
}
