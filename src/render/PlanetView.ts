import * as THREE from 'three';
import { Rng, mixSeed } from '../core/rng';
import { buildBiomeLut, biomeLutKey, LUT_SIZE } from '../planet/biomes';
import type { MeshData, MoonResult, TerrainResult } from '../planet/generator';
import { buildIcosphere } from '../planet/icosphere';
import type { PlanetParams } from '../planet/params';
import { buildRingProfile, RING_TEX_SIZE } from '../planet/rings';
import { createAuroraGeometry, createAuroraMaterial } from './materials/aurora';
import { createCloudMaterial } from './materials/clouds';
import { createOceanMaterial } from './materials/ocean';
import { createRingGeometry, createRingMaterial } from './materials/rings';
import { createTerrainMaterial } from './materials/terrain';
import type { QualityDefines } from './quality';

const DEG = Math.PI / 180;

export interface SharedUniforms {
  [name: string]: THREE.IUniform;
  uTime: THREE.IUniform<number>;
  uSunDir: THREE.IUniform<THREE.Vector3>;
  uSunColor: THREE.IUniform<THREE.Color>;
  uAmbient: THREE.IUniform<THREE.Color>;
  uPlanetCenter: THREE.IUniform<THREE.Vector3>;
  uPlanetRadius: THREE.IUniform<number>;
  uAtmoOn: THREE.IUniform<number>;
  uAtmoInner: THREE.IUniform<number>;
  uAtmoOuter: THREE.IUniform<number>;
  uBetaR: THREE.IUniform<THREE.Vector3>;
  uBetaM: THREE.IUniform<THREE.Vector3>;
  uScaleR: THREE.IUniform<number>;
  uScaleM: THREE.IUniform<number>;
  uSeaLevel: THREE.IUniform<number>;
  uHasOcean: THREE.IUniform<number>;
  uTempOffset: THREE.IUniform<number>;
  uHumidOffset: THREE.IUniform<number>;
  uSnowLine: THREE.IUniform<number>;
  uCloudRadius: THREE.IUniform<number>;
  uCloudInvMatrix: THREE.IUniform<THREE.Matrix4>;
  uCloudCoverage: THREE.IUniform<number>;
  uCloudScale: THREE.IUniform<number>;
  uCloudTime: THREE.IUniform<number>;
  uCloudOpacity: THREE.IUniform<number>;
  uCloudShadow: THREE.IUniform<number>;
  uCloudOffset: THREE.IUniform<THREE.Vector3>;
  uStorms: THREE.IUniform<THREE.Vector4[]>;
  uRingOn: THREE.IUniform<number>;
  uRingNormal: THREE.IUniform<THREE.Vector3>;
  uRingInner: THREE.IUniform<number>;
  uRingOuter: THREE.IUniform<number>;
  uRingOpacity: THREE.IUniform<number>;
  uRingTex: THREE.IUniform<THREE.Texture | null>;
  uMoonCount: THREE.IUniform<number>;
  uMoons: THREE.IUniform<THREE.Vector4[]>;
}

function createSharedUniforms(): SharedUniforms {
  return {
    uTime: { value: 0 },
    uSunDir: { value: new THREE.Vector3(1, 0, 0) },
    uSunColor: { value: new THREE.Color(1, 1, 1) },
    uAmbient: { value: new THREE.Color(0.02, 0.03, 0.05) },
    uPlanetCenter: { value: new THREE.Vector3() },
    uPlanetRadius: { value: 1 },
    uAtmoOn: { value: 1 },
    uAtmoInner: { value: 1 },
    uAtmoOuter: { value: 1.2 },
    uBetaR: { value: new THREE.Vector3() },
    uBetaM: { value: new THREE.Vector3() },
    uScaleR: { value: 0.05 },
    uScaleM: { value: 0.02 },
    uSeaLevel: { value: 0 },
    uHasOcean: { value: 1 },
    uTempOffset: { value: 0 },
    uHumidOffset: { value: 0 },
    uSnowLine: { value: 0.12 },
    uCloudRadius: { value: 1.07 },
    uCloudInvMatrix: { value: new THREE.Matrix4() },
    uCloudCoverage: { value: 0.5 },
    uCloudScale: { value: 1.6 },
    uCloudTime: { value: 0 },
    uCloudOpacity: { value: 1 },
    uCloudShadow: { value: 0.5 },
    uCloudOffset: { value: new THREE.Vector3() },
    uStorms: { value: [new THREE.Vector4(0, 1, 0, 0), new THREE.Vector4(0, 1, 0, 0), new THREE.Vector4(0, 1, 0, 0), new THREE.Vector4(0, 1, 0, 0)] },
    uRingOn: { value: 0 },
    uRingNormal: { value: new THREE.Vector3(0, 1, 0) },
    uRingInner: { value: 1.5 },
    uRingOuter: { value: 2.4 },
    uRingOpacity: { value: 0 },
    uRingTex: { value: null },
    uMoonCount: { value: 0 },
    uMoons: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
  };
}

interface MoonInstance {
  mesh: THREE.Mesh;
  info: MoonResult;
  angle: number;
}

export class PlanetView {
  /** Add this to your scene. */
  readonly root = new THREE.Group();
  /** Holds everything aligned with the planet's spin axis (rings, moons' orbital plane). */
  readonly tilt = new THREE.Group();
  /** Rotates with the planet surface. */
  readonly spin = new THREE.Group();
  readonly cloudPivot = new THREE.Group();

  readonly uniforms: SharedUniforms = createSharedUniforms();

  readonly terrain: THREE.Mesh;
  readonly ocean: THREE.Mesh;
  readonly clouds: THREE.Mesh;
  readonly cirrus: THREE.Mesh;
  readonly ringBack: THREE.Mesh;
  readonly ringFront: THREE.Mesh;
  readonly aurora: THREE.Mesh;

  private readonly terrainMat: THREE.ShaderMaterial;
  private readonly oceanMat: THREE.ShaderMaterial;
  private readonly moonMat: THREE.ShaderMaterial;
  private readonly cloudMat: THREE.ShaderMaterial;
  private readonly cirrusMat: THREE.ShaderMaterial;
  private readonly ringBackMat: THREE.ShaderMaterial;
  private readonly ringFrontMat: THREE.ShaderMaterial;
  private readonly auroraMat: THREE.ShaderMaterial;

  private readonly biomeTex: THREE.DataTexture;
  private readonly ringTex: THREE.DataTexture;
  private lutKey = '';
  private ringKey = '';
  private auroraSeed = -1;
  private stormSeed = -1;

  private readonly cloudGeo: THREE.BufferGeometry;
  private readonly cloudGeoLowPoly: THREE.BufferGeometry;
  private moons: MoonInstance[] = [];
  private params: PlanetParams | null = null;
  private meshHeightScale = 0.06;
  private flat = false;

  terrainInfo: TerrainResult | null = null;

  constructor(quality: QualityDefines) {
    this.root.name = 'TinyPlanet';
    this.root.add(this.tilt);
    this.tilt.add(this.spin);
    this.tilt.add(this.cloudPivot);

    this.biomeTex = new THREE.DataTexture(new Uint8Array(LUT_SIZE * LUT_SIZE * 4), LUT_SIZE, LUT_SIZE);
    this.biomeTex.colorSpace = THREE.SRGBColorSpace;
    this.biomeTex.magFilter = THREE.LinearFilter;
    this.biomeTex.minFilter = THREE.LinearFilter;
    this.biomeTex.wrapS = this.biomeTex.wrapT = THREE.ClampToEdgeWrapping;

    this.ringTex = new THREE.DataTexture(new Uint8Array(RING_TEX_SIZE * 4), RING_TEX_SIZE, 1);
    this.ringTex.colorSpace = THREE.SRGBColorSpace;
    this.ringTex.magFilter = THREE.LinearFilter;
    this.ringTex.minFilter = THREE.LinearMipmapLinearFilter;
    this.ringTex.generateMipmaps = true;
    this.ringTex.wrapS = this.ringTex.wrapT = THREE.ClampToEdgeWrapping;
    this.uniforms.uRingTex.value = this.ringTex;

    const u = this.uniforms;
    this.terrainMat = createTerrainMaterial(u, quality, { flat: false, moon: false });
    this.terrainMat.uniforms.uBiomeLUT.value = this.biomeTex;
    this.oceanMat = createOceanMaterial(u, quality, { flat: false });
    this.moonMat = createTerrainMaterial(u, quality, { flat: false, moon: true });
    this.cloudMat = createCloudMaterial(u, quality, { cirrus: false });
    this.cirrusMat = createCloudMaterial(u, quality, { cirrus: true });
    this.ringBackMat = createRingMaterial(u, quality, false);
    this.ringFrontMat = createRingMaterial(u, quality, true);
    this.auroraMat = createAuroraMaterial(u);

    const placeholder = new THREE.BufferGeometry();
    this.terrain = new THREE.Mesh(placeholder, this.terrainMat);
    this.terrain.name = 'Terrain';
    this.ocean = new THREE.Mesh(placeholder, this.oceanMat);
    this.ocean.name = 'Ocean';
    this.ocean.renderOrder = 1;
    this.spin.add(this.terrain, this.ocean);

    const sphere = sphereGeometry(40);
    this.cloudGeo = sphere;
    this.cloudGeoLowPoly = sphereGeometry(18);
    this.clouds = new THREE.Mesh(sphere, this.cloudMat);
    this.clouds.name = 'Clouds';
    this.clouds.renderOrder = 3;
    this.cirrus = new THREE.Mesh(sphere, this.cirrusMat);
    this.cirrus.name = 'Cirrus';
    this.cirrus.renderOrder = 4;
    this.cloudPivot.add(this.clouds, this.cirrus);

    const ringGeo = createRingGeometry(256);
    this.ringBack = new THREE.Mesh(ringGeo, this.ringBackMat);
    this.ringBack.renderOrder = 2;
    this.ringFront = new THREE.Mesh(ringGeo, this.ringFrontMat);
    this.ringFront.renderOrder = 5;
    this.ringBack.name = 'RingsBack';
    this.ringFront.name = 'Rings';
    this.tilt.add(this.ringBack, this.ringFront);

    this.aurora = new THREE.Mesh(new THREE.BufferGeometry(), this.auroraMat);
    this.aurora.name = 'Aurora';
    this.aurora.renderOrder = 6;
    this.spin.add(this.aurora);
  }

  get currentParams(): PlanetParams | null {
    return this.params;
  }

  /** Swap in a freshly generated terrain mesh. */
  setTerrain(result: TerrainResult, heightScale: number, lowPoly: boolean): void {
    const old = this.terrain.geometry;
    const g = meshToGeometry(result.mesh);
    this.terrain.geometry = g;
    this.ocean.geometry = g;
    old.dispose();
    this.terrainInfo = result;
    this.meshHeightScale = heightScale;
    this.setFlat(lowPoly);
    if (this.params) this.applyParams(this.params);
  }

  setMoons(results: MoonResult[], lowPoly: boolean): void {
    for (const m of this.moons) {
      this.tilt.remove(m.mesh);
      m.mesh.geometry.dispose();
    }
    this.moons = results.map((info, i) => {
      const mesh = new THREE.Mesh(meshToGeometry(info.mesh), this.moonMat);
      mesh.name = `Moon${i + 1}`;
      this.tilt.add(mesh);
      return { mesh, info, angle: info.phase };
    });
    setDefine(this.moonMat, 'FLAT_SHADED', lowPoly);
    if (this.params) this.applyParams(this.params);
  }

  get moonMeshes(): THREE.Mesh[] {
    return this.moons.map((m) => m.mesh);
  }

  private setFlat(flat: boolean): void {
    if (flat === this.flat) return;
    this.flat = flat;
    setDefine(this.terrainMat, 'FLAT_SHADED', flat);
    setDefine(this.oceanMat, 'FLAT_SHADED', flat);
    setDefine(this.cloudMat, 'FLAT_SHADED', flat);
    this.clouds.geometry = flat ? this.cloudGeoLowPoly : this.cloudGeo;
  }

  setQuality(quality: QualityDefines): void {
    for (const m of [this.terrainMat, this.oceanMat, this.moonMat, this.cloudMat, this.cirrusMat, this.ringBackMat, this.ringFrontMat]) {
      Object.assign(m.defines, quality);
      m.needsUpdate = true;
    }
  }

  /** Oceans sit at this radius (also the reference "ground" for the atmosphere). */
  get oceanRadius(): number {
    const p = this.params;
    return 1 + (p ? p.seaLevel : 0) * this.meshHeightScale;
  }

  get atmosphereRadius(): number {
    return this.uniforms.uAtmoOuter.value;
  }

  applyParams(p: PlanetParams): void {
    this.params = p;
    const u = this.uniforms;
    const oceanR = 1 + p.seaLevel * this.meshHeightScale;
    const hasOcean = p.liquid !== 'none';
    const lava = p.liquid === 'lava';

    // Sun
    const az = p.sunAzimuth * DEG;
    const el = p.sunElevation * DEG;
    u.uSunDir.value.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).normalize();
    u.uSunColor.value.setRGB(1.0, 0.96, 0.9).multiplyScalar(2.0 * p.sunIntensity);

    // Atmosphere: scattering coefficients derived from the chosen sky colour.
    const sky = new THREE.Color(p.cSky);
    const mx = Math.max(sky.r, sky.g, sky.b, 1e-4);
    const scaleR = p.atmoHeight * 0.26;
    const scaleM = p.atmoHeight * 0.11;
    const kR = (0.2 * p.atmoDensity) / scaleR;
    u.uBetaR.value.set(Math.pow(sky.r / mx, 0.6) * kR, Math.pow(sky.g / mx, 0.6) * kR, Math.pow(sky.b / mx, 0.6) * kR);
    const haze = new THREE.Color(p.cHaze);
    const kM = (0.1 * p.haze * p.atmoDensity) / scaleM;
    u.uBetaM.value.set(haze.r * kM, haze.g * kM, haze.b * kM);
    u.uScaleR.value = scaleR;
    u.uScaleM.value = scaleM;
    u.uAtmoInner.value = oceanR;
    u.uAtmoOuter.value = oceanR + p.atmoHeight;
    u.uAtmoOn.value = p.atmoDensity > 0.001 ? 1 : 0;
    u.uPlanetRadius.value = oceanR;

    const atmoAmbient = Math.min(1, p.atmoDensity);
    u.uAmbient.value
      .setRGB(0.012, 0.014, 0.02)
      .add(new THREE.Color(p.cSky).multiplyScalar(0.05 * atmoAmbient));

    // Climate
    u.uSeaLevel.value = p.seaLevel;
    u.uHasOcean.value = hasOcean ? 1 : 0;
    u.uTempOffset.value = p.temperature;
    u.uHumidOffset.value = p.humidity;
    u.uSnowLine.value = p.snowLine;

    // Surface
    const lutKey = biomeLutKey(p);
    if (lutKey !== this.lutKey) {
      this.lutKey = lutKey;
      (this.biomeTex.image.data as Uint8Array).set(buildBiomeLut(p));
      this.biomeTex.needsUpdate = true;
    }
    const tu = this.terrainMat.uniforms;
    tu.uSnowColor.value.set(p.cSnow);
    tu.uRockColor.value.set(p.cRock);
    tu.uSandColor.value.set(p.cSand);
    (tu.uSeabedColor.value as THREE.Color).set(p.cSand).multiplyScalar(0.35).lerp(new THREE.Color(p.cDeep), 0.45);
    tu.uDetailBump.value = 0.0028 * Math.max(0.3, this.meshHeightScale / 0.06);
    tu.uCityLights.value = p.cityLights;
    tu.uCityColor.value.set(p.cCity);
    tu.uLava.value = lava ? 1 : 0;
    tu.uLavaColor.value.set(p.cShallow);

    this.moonMat.uniforms.uMoonColor.value.set(p.cMoon);
    this.moonMat.uniforms.uDetailBump.value = 0.0;

    // Ocean
    this.ocean.visible = hasOcean;
    const ou = this.oceanMat.uniforms;
    ou.uOceanRadius.value = oceanR;
    ou.uShallow.value.set(p.cShallow);
    ou.uDeep.value.set(p.cDeep);
    ou.uClarity.value = p.oceanClarity;
    ou.uFoam.value = lava ? 0 : p.foam;
    ou.uWaves.value = p.waves;
    ou.uGlow.value = p.oceanGlow;
    ou.uLava.value = lava ? 1 : 0;
    (ou.uIceColor.value as THREE.Color).set(p.cSnow).lerp(new THREE.Color('#bfe3ff'), 0.25);
    ou.uSkyTint.value.set(p.cSky).multiplyScalar(0.5 * atmoAmbient).add(new THREE.Color(0.01, 0.012, 0.02));

    // Clouds
    const cloudR = oceanR + p.cloudAltitude;
    u.uCloudRadius.value = cloudR;
    u.uCloudCoverage.value = p.cloudCoverage;
    u.uCloudScale.value = p.cloudScale;
    u.uCloudOpacity.value = p.cloudOpacity;
    u.uCloudShadow.value = p.cloudShadows;
    this.cloudMat.uniforms.uRadius.value = cloudR;
    this.cirrusMat.uniforms.uRadius.value = cloudR + 0.022;
    this.cloudMat.uniforms.uCloudColor.value.set(p.cCloud);
    this.cirrusMat.uniforms.uCloudColor.value.set(p.cCloud);
    this.cirrusMat.uniforms.uCirrus.value = p.cirrus;
    this.cirrusMat.uniforms.uLayerOpacity.value = 0.5;
    this.clouds.visible = p.cloudCoverage > 0.001 && p.cloudOpacity > 0.001;
    this.cirrus.visible = p.cirrus > 0.001 && p.cloudOpacity > 0.001 && !this.flat;
    if (this.stormSeed !== p.seed) {
      this.stormSeed = p.seed;
      const rng = new Rng(mixSeed(p.seed, 0x5707));
      u.uCloudOffset.value.set(rng.range(-40, 40), rng.range(-40, 40), rng.range(-40, 40));
    }
    this.updateStorms(p);

    // Rings
    const ringsOn = p.rings > 0.001;
    u.uRingOn.value = ringsOn ? 1 : 0;
    u.uRingInner.value = p.ringInner;
    u.uRingOuter.value = Math.max(p.ringOuter, p.ringInner + 0.05);
    u.uRingOpacity.value = p.rings;
    this.ringBack.visible = this.ringFront.visible = ringsOn;
    const ringKey = `${p.seed}|${p.cRing1}|${p.cRing2}`;
    if (ringsOn && ringKey !== this.ringKey) {
      this.ringKey = ringKey;
      (this.ringTex.image.data as Uint8Array).set(buildRingProfile(p.seed, p.cRing1, p.cRing2));
      this.ringTex.needsUpdate = true;
    }

    // Aurora
    if (this.auroraSeed !== p.seed) {
      this.auroraSeed = p.seed;
      this.aurora.geometry.dispose();
      this.aurora.geometry = createAuroraGeometry(p.seed);
    }
    const au = this.auroraMat.uniforms;
    au.uAurora.value = p.aurora * (p.atmoDensity > 0.001 ? 1 : 0.35);
    au.uColorA.value.set(p.cAurora);
    const hsl = { h: 0, s: 0, l: 0 };
    new THREE.Color(p.cAurora).getHSL(hsl);
    au.uColorB.value.setHSL((hsl.h + 0.42) % 1, Math.min(1, hsl.s * 1.1), hsl.l * 0.8);
    this.aurora.visible = p.aurora > 0.001;
    this.aurora.scale.setScalar(oceanR);

    // Orientation
    this.tilt.rotation.set(0, 0, -p.axialTilt * DEG);
  }

  private updateStorms(p: PlanetParams): void {
    const rng = new Rng(mixSeed(p.seed, 0x5708));
    const storms = this.uniforms.uStorms.value;
    for (let i = 0; i < 4; i++) {
      const hemi = rng.chance(0.5) ? 1 : -1;
      const lat = rng.range(8, 42) * DEG * hemi;
      const lon = rng.range(0, Math.PI * 2);
      const strength = rng.range(0.55, 1.0) * p.cloudStorms * (i < 2 || rng.chance(0.5) ? 1 : 0);
      storms[i].set(Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon), strength * hemi);
    }
  }

  private readonly tmpVec = new THREE.Vector3();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpAxis = new THREE.Vector3();

  /** Advance animation. `time` in seconds. */
  update(time: number, dt: number): void {
    const p = this.params;
    if (!p) return;
    const u = this.uniforms;
    u.uTime.value = time;

    this.spin.rotation.y += dt * p.spinSpeed * 0.35;
    this.cloudPivot.rotation.y = this.spin.rotation.y + time * p.cloudSpeed * 0.012;
    u.uCloudTime.value = time * p.cloudSpeed * 0.006;

    this.root.updateMatrixWorld(true);
    u.uCloudInvMatrix.value.copy(this.cloudPivot.matrixWorld).invert();
    u.uRingNormal.value.set(0, 1, 0).transformDirection(this.tilt.matrixWorld);
    this.root.getWorldPosition(u.uPlanetCenter.value);

    // Moons on inclined orbits, tidally locked.
    const atmoOuter = u.uAtmoOuter.value;
    const ringClear = p.rings > 0.001 ? p.ringOuter + 0.35 : 0;
    const base = Math.max(2.2, atmoOuter + 0.8, ringClear);
    let count = 0;
    for (let i = 0; i < this.moons.length; i++) {
      const m = this.moons[i];
      const radius = base + i * 0.75 + m.info.orbitFactor * 0.45;
      const size = p.moonSize * m.info.sizeFactor;
      m.angle += (dt * 0.35 * m.info.speedFactor) / Math.pow(radius / 2.2, 1.5);
      this.tmpVec.set(Math.cos(m.angle) * radius, 0, Math.sin(m.angle) * radius);
      this.tmpAxis.set(Math.cos(m.info.node), 0, Math.sin(m.info.node));
      this.tmpQuat.setFromAxisAngle(this.tmpAxis, m.info.inclination);
      this.tmpVec.applyQuaternion(this.tmpQuat);
      m.mesh.position.copy(this.tmpVec);
      m.mesh.rotation.set(0, -m.angle, 0);
      m.mesh.scale.setScalar(size);
      m.mesh.updateMatrixWorld(true);
      if (count < 4) {
        m.mesh.getWorldPosition(this.tmpVec);
        u.uMoons.value[count].set(this.tmpVec.x, this.tmpVec.y, this.tmpVec.z, size);
        count++;
      }
    }
    u.uMoonCount.value = count;
  }

  dispose(): void {
    this.terrain.geometry.dispose();
    this.cloudGeo.dispose();
    this.cloudGeoLowPoly.dispose();
    this.ringBack.geometry.dispose();
    this.aurora.geometry.dispose();
    for (const m of this.moons) m.mesh.geometry.dispose();
    for (const mat of [this.terrainMat, this.oceanMat, this.moonMat, this.cloudMat, this.cirrusMat, this.ringBackMat, this.ringFrontMat, this.auroraMat]) {
      mat.dispose();
    }
    this.biomeTex.dispose();
    this.ringTex.dispose();
  }
}

function setDefine(mat: THREE.ShaderMaterial, name: string, on: boolean): void {
  const has = name in mat.defines;
  if (on === has) return;
  if (on) mat.defines[name] = '';
  else delete mat.defines[name];
  mat.needsUpdate = true;
}

export function meshToGeometry(mesh: MeshData): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
  g.setAttribute('aData', new THREE.BufferAttribute(mesh.data, 4));
  if (mesh.indices) g.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  g.computeBoundingSphere();
  if (g.boundingSphere) g.boundingSphere.radius *= 1.05;
  return g;
}

function sphereGeometry(freq: number): THREE.BufferGeometry {
  const topo = buildIcosphere(freq);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(topo.directions.slice(), 3));
  g.setIndex(new THREE.BufferAttribute(topo.indices.slice(), 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1.6);
  return g;
}
