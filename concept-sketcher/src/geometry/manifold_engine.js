// Geometry engine of the preview: executes a solid program (solid_program.js)
// with Manifold (manifold-3d, Apache-2.0, WebAssembly; vendor/manifold-3.5.3).
// Manifold guarantees closed, oriented (manifold) output for every boolean.
// The engine is loaded lazily, once; every Manifold object is deleted after use
// (WebAssembly memory is not garbage-collected), and finished meshes are kept in
// a small cache so an unchanged solid is never rebuilt.

export const ENGINE = 'manifold-3d 3.5.3';
const CACHE_SIZE = 64;

let loading = null;
export function loadManifoldEngine() {
  return (loading ||= (async () => {
    const t0 = performance.now();
    const { default: Module } = await import('../../vendor/manifold-3.5.3/manifold.js?v=c5009ee32250');
    const wasm = await Module();
    wasm.setup();
    return createManifoldEngine(wasm, performance.now() - t0);
  })());
}

export function createManifoldEngine(wasm, loadMs = null) {
  const { Manifold } = wasm;
  const cache = new Map();
  const TO_AXIS = { X: [0, 90, 0], Y: [-90, 0, 0], Z: null };   // Manifold cylinders run along Z

  // One shape of the program → Manifold; every intermediate object is recorded for deletion.
  function shape(s, own) {
    const keep = (m) => (own.push(m), m);
    if (s.type === 'box') {
      let m = keep(Manifold.cube(s.size, true));
      if (s.basis) {
        const [x, y, z] = s.basis;
        m = keep(m.transform([x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, 0, 0, 0, 1]));
      }
      return keep(m.translate(s.center));
    }
    if (s.type === 'cylinder') {
      let m = keep(Manifold.cylinder(s.length, s.d / 2, s.d / 2, s.segments, true));
      if (TO_AXIS[s.axis]) m = keep(m.rotate(TO_AXIS[s.axis]));
      return keep(m.translate(s.center));
    }
    throw new Error(`unknown shape "${s.type}"`);
  }
  const combine = (list, own) => (list.length === 1 ? list[0] : own[own.push(Manifold.union(list)) - 1]);

  function buildSolid(solid) {
    const key = JSON.stringify([solid.adds, solid.cuts]);
    if (cache.has(key)) { const m = cache.get(key); cache.delete(key); cache.set(key, m); return m; }
    const own = [];
    const t0 = performance.now();
    try {
      const body = combine(solid.adds.map((s) => shape(s, own)), own);
      const result = solid.cuts.length ? own[own.push(body.subtract(combine(solid.cuts.map((s) => shape(s, own)), own))) - 1] : body;
      const status = String(result.status?.() ?? 'NoError');
      if (status !== 'NoError') throw new Error(`Manifold status ${status}`);
      const mesh = result.getMesh();
      const n = mesh.numProp;
      const positions = new Float32Array((mesh.vertProperties.length / n) * 3);
      for (let i = 0, j = 0; i < mesh.vertProperties.length; i += n, j += 3) positions.set(mesh.vertProperties.subarray(i, i + 3), j);
      const out = Object.freeze({ positions, indices: Uint32Array.from(mesh.triVerts), volume: result.volume(), genus: result.genus(),
        triangles: mesh.triVerts.length / 3, status, ms: performance.now() - t0 });
      cache.set(key, out);
      if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
      return out;
    } finally {
      for (const m of own) m.delete();
    }
  }

  return {
    name: ENGINE, loadMs,
    // program → { solids: Map id → mesh, errors: [{ id, error }], ms }
    build(program) {
      const t0 = performance.now(), solids = new Map(), errors = [];
      for (const s of program.solids) {
        try { solids.set(s.id, buildSolid(s)); } catch (e) { errors.push({ id: s.id, error: e.message }); }
      }
      return { solids, errors, ms: performance.now() - t0 };
    },
  };
}
