/**
 * Cheap ambient occlusion from surface cavity: each vertex is compared with a blurred copy of
 * the height field, so valleys and crater floors come out darker and ridges slightly brighter.
 */
export function cavityOcclusion(heights: Float32Array, neighbors: Int32Array, frequency: number): Float32Array {
  const V = heights.length;
  // Keep the blur radius roughly constant on the sphere regardless of mesh resolution.
  const iterations = Math.max(2, Math.round(8 * Math.pow(frequency / 120, 2)));
  let a = heights.slice();
  let b = new Float32Array(V);
  for (let it = 0; it < iterations; it++) {
    for (let v = 0; v < V; v++) {
      let sum = a[v];
      let n = 1;
      for (let k = 0; k < 6; k++) {
        const u = neighbors[v * 6 + k];
        if (u < 0) break;
        sum += a[u];
        n++;
      }
      b[v] = sum / n;
    }
    const t = a;
    a = b;
    b = t;
  }
  const ao = new Float32Array(V);
  for (let v = 0; v < V; v++) {
    const cavity = a[v] - heights[v];
    ao[v] = Math.min(1.08, Math.max(0.5, 1 - cavity * (cavity > 0 ? 2.4 : 0.9)));
  }
  return ao;
}
