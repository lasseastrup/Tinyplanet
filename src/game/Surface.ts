import * as THREE from 'three';
import { sampleSurface, type SurfaceHit, type SurfaceMesh } from '../planet/props';
import type { PlanetView } from '../render/PlanetView';

/**
 * Ground queries in planet-local space (the frame of PlanetView.spin): the terrain mesh as
 * rendered, and the sea surface on top of it.
 */
export class Surface {
  private mesh: SurfaceMesh | null = null;
  private readonly hit: SurfaceHit = { radius: 1, height: 0, nx: 0, ny: 1, nz: 0 };
  private lastTerrain = 1;
  oceanRadius = 1;
  hasOcean = false;
  /** Set by ground(): the surface normal there and whether it is water. */
  readonly normal = new THREE.Vector3(0, 1, 0);
  water = false;

  /** Pick up the planet's current terrain mesh and sea level. */
  sync(planet: PlanetView): void {
    const info = planet.terrainInfo;
    const p = planet.currentParams;
    this.mesh = info ? info.mesh : null;
    this.hasOcean = !!p && p.liquid !== 'none';
    this.oceanRadius = planet.oceanRadius;
  }

  get ready(): boolean {
    return this.mesh !== null;
  }

  /** Radius of the terrain under direction (x, y, z), ignoring the sea. */
  terrain(x: number, y: number, z: number): number {
    if (this.mesh && sampleSurface(this.mesh, x, y, z, this.hit)) this.lastTerrain = this.hit.radius;
    return this.lastTerrain;
  }

  /** Radius of whatever lies below direction (x, y, z): land or the sea surface. */
  ground(x: number, y: number, z: number): number {
    const r = this.terrain(x, y, z);
    if (this.hasOcean && r < this.oceanRadius) {
      this.water = true;
      this.normal.set(x, y, z).normalize();
      return this.oceanRadius;
    }
    this.water = false;
    this.normal.set(this.hit.nx, this.hit.ny, this.hit.nz);
    return r;
  }

  groundAt(v: THREE.Vector3): number {
    return this.ground(v.x, v.y, v.z);
  }
}
