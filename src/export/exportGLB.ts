import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { hexToLinear } from '../core/math';
import { colorContext, terrainAlbedo, waterColor } from '../planet/colors';
import type { MeshData } from '../planet/generator';
import type { PlanetParams } from '../planet/params';
import { buildRingProfile, RING_TEX_SIZE } from '../planet/rings';
import type { PlanetView } from '../render/PlanetView';
import { slug } from './deliver';

/**
 * Build a plain, engine-friendly scene (standard PBR materials + vertex colours) from the
 * current planet and export it as binary glTF. Clouds, atmosphere and other shader effects
 * are not part of the export; the full parameter set is stored in the root node's extras.
 */
export async function exportPlanetGLB(view: PlanetView, params: PlanetParams, mesh: MeshData, heightScale: number): Promise<Blob> {
  const root = new THREE.Group();
  root.name = slug(params.name) || 'tiny-planet';
  root.userData = { generator: 'Tiny Planet', params };

  const tilt = new THREE.Group();
  tilt.name = 'Axis';
  tilt.rotation.z = -THREE.MathUtils.degToRad(params.axialTilt);
  root.add(tilt);

  const pos = new THREE.BufferAttribute(mesh.positions, 3);
  const nor = new THREE.BufferAttribute(mesh.normals, 3);
  const dat = new THREE.BufferAttribute(mesh.data, 4);
  const occ = mesh.ao;
  const index = mesh.indices ? new THREE.BufferAttribute(mesh.indices, 1) : null;

  // --- Terrain with baked vertex colours ---------------------------------------------------
  const ctx = colorContext(params);
  const V = pos.count;
  const colors = new Uint8Array(V * 3);
  const c = [0, 0, 0];
  for (let i = 0; i < V; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const len = Math.hypot(x, y, z) || 1;
    const slope = 1 - Math.max(0, (nor.getX(i) * x + nor.getY(i) * y + nor.getZ(i) * z) / len);
    terrainAlbedo(ctx, dat.getX(i), dat.getY(i), dat.getZ(i), dat.getW(i), slope, c);
    const ao = 0.3 + 0.7 * occ[i];
    colors[i * 3] = toByte(c[0] * ao);
    colors[i * 3 + 1] = toByte(c[1] * ao);
    colors[i * 3 + 2] = toByte(c[2] * ao);
  }
  const terrain = new THREE.BufferGeometry();
  terrain.setAttribute('position', pos);
  terrain.setAttribute('normal', nor);
  terrain.setAttribute('color', new THREE.BufferAttribute(colors, 3, true));
  if (index) terrain.setIndex(index);
  const terrainMat = new THREE.MeshStandardMaterial({ name: 'Terrain', vertexColors: true, roughness: 0.92, metalness: 0 });
  if (params.liquid === 'lava') {
    terrainMat.roughness = 0.8;
  }
  const terrainMesh = new THREE.Mesh(terrain, terrainMat);
  terrainMesh.name = 'Terrain';
  tilt.add(terrainMesh);

  // --- Ocean: same topology, only triangles that touch water --------------------------------
  if (params.liquid !== 'none') {
    const oceanR = 1 + params.seaLevel * heightScale;
    const triCount = index ? index.count / 3 : V / 3;
    const vi = (t: number, k: number) => (index ? index.getX(t * 3 + k) : t * 3 + k);
    const keep: number[] = [];
    for (let t = 0; t < triCount; t++) {
      for (let k = 0; k < 3; k++) {
        if (dat.getX(vi(t, k)) < params.seaLevel + 0.004) {
          keep.push(vi(t, 0), vi(t, 1), vi(t, 2));
          break;
        }
      }
    }
    if (keep.length > 0) {
      const remap = new Map<number, number>();
      const oPos: number[] = [];
      const oNor: number[] = [];
      const oCol: number[] = [];
      const oIdx: number[] = [];
      const wc = [0, 0, 0, 0];
      const lava = params.liquid === 'lava';
      const lavaHot = hexToLinear(params.cShallow);
      for (const v of keep) {
        let ni = remap.get(v);
        if (ni === undefined) {
          ni = remap.size;
          remap.set(v, ni);
          const x = pos.getX(v);
          const y = pos.getY(v);
          const z = pos.getZ(v);
          const len = Math.hypot(x, y, z) || 1;
          oPos.push((x / len) * oceanR, (y / len) * oceanR, (z / len) * oceanR);
          oNor.push(x / len, y / len, z / len);
          if (lava) oCol.push(toByte(lavaHot[0]), toByte(lavaHot[1]), toByte(lavaHot[2]), 255);
          else {
            waterColor(params, params.seaLevel - dat.getX(v), wc);
            oCol.push(toByte(wc[0]), toByte(wc[1]), toByte(wc[2]), toByte(wc[3]));
          }
        }
        oIdx.push(ni);
      }
      const ocean = new THREE.BufferGeometry();
      ocean.setAttribute('position', new THREE.Float32BufferAttribute(oPos, 3));
      ocean.setAttribute('normal', new THREE.Float32BufferAttribute(oNor, 3));
      ocean.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(oCol), 4, true));
      ocean.setIndex(oIdx);
      const oceanMat = lava
        ? new THREE.MeshStandardMaterial({
            name: 'Lava',
            vertexColors: true,
            emissive: new THREE.Color(params.cDeep),
            emissiveIntensity: 1.5,
            roughness: 0.6,
          })
        : new THREE.MeshStandardMaterial({
            name: 'Water',
            vertexColors: true,
            transparent: true,
            roughness: 0.12,
            metalness: 0,
          });
      const oceanMesh = new THREE.Mesh(ocean, oceanMat);
      oceanMesh.name = 'Ocean';
      tilt.add(oceanMesh);
    }
  }

  // --- Rings ---------------------------------------------------------------------------------
  if (params.rings > 0.001) {
    tilt.add(buildRingMesh(params));
  }

  // --- Moons ---------------------------------------------------------------------------------
  const moonColor = hexToLinear(params.cMoon);
  view.moonMeshes.forEach((m, i) => {
    const g = m.geometry;
    const mp = g.getAttribute('position') as THREE.BufferAttribute;
    const md = g.getAttribute('aData') as THREE.BufferAttribute;
    const mao = g.getAttribute('aAO') as THREE.BufferAttribute | undefined;
    const col = new Uint8Array(mp.count * 3);
    for (let v = 0; v < mp.count; v++) {
      const shade = (1 - 0.42 * md.getZ(v)) * (1 + md.getW(v) * 0.35) * (mao ? 0.3 + 0.7 * mao.getX(v) : 1);
      col[v * 3] = toByte(moonColor[0] * shade);
      col[v * 3 + 1] = toByte(moonColor[1] * shade);
      col[v * 3 + 2] = toByte(moonColor[2] * shade);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', mp.clone());
    geo.setAttribute('normal', (g.getAttribute('normal') as THREE.BufferAttribute).clone());
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3, true));
    const gi = g.getIndex();
    if (gi) geo.setIndex(gi.clone());
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ name: `Moon${i + 1}`, vertexColors: true, roughness: 0.95 }));
    mesh.name = `Moon${i + 1}`;
    mesh.position.copy(m.position);
    mesh.rotation.copy(m.rotation);
    mesh.scale.copy(m.scale);
    tilt.add(mesh);
  });

  const exporter = new GLTFExporter();
  const result = await exporter.parseAsync(root, { binary: true });
  disposeTree(root);
  return new Blob([result as ArrayBuffer], { type: 'model/gltf-binary' });
}

function buildRingMesh(params: PlanetParams): THREE.Mesh {
  const segments = 128;
  const inner = params.ringInner;
  const outer = Math.max(params.ringOuter, inner + 0.05);
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    positions.push(ca * inner, 0, sa * inner, ca * outer, 0, sa * outer);
    normals.push(0, 1, 0, 0, 1, 0);
    uvs.push(0, 0.5, 1, 0.5);
    if (i < segments) {
      const b = i * 2;
      idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);

  const profile = buildRingProfile(params.seed, params.cRing1, params.cRing2);
  const canvas = document.createElement('canvas');
  canvas.width = RING_TEX_SIZE;
  canvas.height = 4;
  const g2d = canvas.getContext('2d')!;
  const img = g2d.createImageData(RING_TEX_SIZE, 4);
  for (let row = 0; row < 4; row++) {
    for (let i = 0; i < RING_TEX_SIZE; i++) {
      const o = (row * RING_TEX_SIZE + i) * 4;
      img.data[o] = profile[i * 4];
      img.data[o + 1] = profile[i * 4 + 1];
      img.data[o + 2] = profile[i * 4 + 2];
      img.data[o + 3] = Math.round(profile[i * 4 + 3] * params.rings);
    }
  }
  g2d.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  // Unlit (KHR_materials_unlit): rings read well under any game lighting setup.
  const mat = new THREE.MeshBasicMaterial({
    name: 'Rings',
    map: tex,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'Rings';
  return mesh;
}

function toByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

function disposeTree(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.geometry.dispose();
      const mat = mesh.material as THREE.MeshStandardMaterial | THREE.MeshBasicMaterial;
      mat.map?.dispose();
      mat.dispose();
    }
  });
}
