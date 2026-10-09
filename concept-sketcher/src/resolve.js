// resolve(model) -> resolved scene. Deterministic, pure, no solver:
// params -> part geometry -> feature instances (array/mirror) -> 90° orientation
// -> placement (root parts by `place`, attached parts by translating along the
// first joint link; further links are only checked).

import { evalParams, num } from './model.js?v=88a79953eb30';
import { localInterfaces, localHoles, worldHole, worldInterface, placeMotionJoint, resolveFasteners, resolveVolumes, splitRef, DIRS } from './mechanics.js?v=88a79953eb30';
import { ROUND_KINDS } from './schema.js?v=88a79953eb30';

export const AXES = {
  '+X': [1, 0, 0], '-X': [-1, 0, 0], '+Y': [0, 1, 0], '-Y': [0, -1, 0], '+Z': [0, 0, 1], '-Z': [0, 0, -1],
};
const EPS = 1e-6;

export const add = (a, b) => a.map((v, i) => v + b[i]);
export const sub = (a, b) => a.map((v, i) => v - b[i]);
export const mul = (a, s) => a.map((v) => v * s);
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a) => Math.sqrt(dot(a, a));
export const round = (v) => {
  if (Array.isArray(v)) return v.map(round);
  const r = Math.round(v * 1e6) / 1e6;
  return Object.is(r, -0) ? 0 : r;
};

export function axisName(v) {
  for (const [k, a] of Object.entries(AXES)) if (len(sub(a, v)) < EPS) return k;
  return null;
}
// Unsigned axis letter: "X" | "Y" | "Z".
export const axisLetter = (v) => { const n = axisName(v); return n ? n[1] : null; };

// orient {z, y} -> rotation: world directions of local x, y, z (x = y × z).
export function orientation(o) {
  if (Array.isArray(o?.euler_deg)) {
    if (o.z !== undefined || o.y !== undefined) throw new Error('orient must use either {z,y} or {euler_deg}, not both');
    if (o.euler_deg.length !== 3 || !o.euler_deg.every(Number.isFinite)) throw new Error('orient.euler_deg needs [x,y,z] finite degrees');
    const [ax, ay, az] = o.euler_deg.map((v) => v * Math.PI / 180);
    const cx = Math.cos(ax), sx = Math.sin(ax), cy = Math.cos(ay), sy = Math.sin(ay), cz = Math.cos(az), sz = Math.sin(az);
    // Intrinsic XYZ, equivalently world matrix Rz * Ry * Rx; columns are the
    // world directions of local x/y/z.
    const x = [cz * cy, sz * cy, -sy];
    const y = [cz * sy * sx - sz * cx, sz * sy * sx + cz * cx, cy * sx];
    const z = [cz * sy * cx + sz * sx, sz * sy * cx - cz * sx, cy * cx];
    return { x: round(x), y: round(y), z: round(z), names: { x: axisName(x), y: axisName(y), z: axisName(z) }, euler_deg: [...o.euler_deg] };
  }
  const z = AXES[o?.z], y = AXES[o?.y];
  if (!z || !y) throw new Error(`orient needs z and y from ±X ±Y ±Z, got ${JSON.stringify(o)}`);
  if (Math.abs(dot(z, y)) > EPS) throw new Error(`orient z=${o.z} and y=${o.y} are not perpendicular`);
  const x = cross(y, z);
  return { x, y, z, names: { x: axisName(x), y: o.y, z: o.z } };
}
const rot = (R, v) => add(add(mul(R.x, v[0]), mul(R.y, v[1])), mul(R.z, v[2]));

const EDGE = { '+X': [0, 1], '-X': [0, -1], '+Y': [1, 1], '-Y': [1, -1] }; // [axis, sign]
const unit = (axis, s = 1) => { const v = [0, 0, 0]; v[axis] = s; return v; };
const MIRROR_FLIP = { YZ: 0, XZ: 1, XY: 2 };

function flipAxisName(name, axis) {
  if (!name) return name;
  return name[1] === 'XYZ'[axis] ? (name[0] === '+' ? '-' : '+') + name[1] : name;
}

// Expand `mirror` definitions into full feature definitions.
export function featureDefs(model) {
  const byId = Object.fromEntries((model.features || []).map((f) => [f.id, f]));
  const out = {};
  function def(id, seen = []) {
    if (out[id]) return out[id];
    const f = byId[id];
    if (!f) throw new Error(`unknown feature "${id}"`);
    if (!f.mirror) return (out[id] = { ...f });
    if (seen.includes(id)) throw new Error(`mirror cycle at "${id}"`);
    const src = def(f.mirror.of, [...seen, id]);
    const axis = MIRROR_FLIP[f.mirror.plane];
    if (axis === undefined) throw new Error(`feature "${id}": mirror plane must be YZ, XZ or XY`);
    const d = structuredClone(src);
    delete d.id; delete d.mirror;
    d.edge = flipAxisName(d.edge, axis);
    if (d.at?.from) d.at.from = flipAxisName(d.at.from, axis);
    const { mirror, ...own } = f;
    return (out[id] = { ...d, ...own, mirror });
  }
  for (const id of Object.keys(byId)) def(id);
  return out;
}

// Array rule (architecture §D.3): the only source of pattern counts/positions.
export function arrayPositions(faceLen, margin, pitch) {
  const usable = faceLen - 2 * margin;
  if (usable < 0 || pitch <= 0) return { usable, count: 0, xs: [] };
  const count = Math.floor(usable / pitch + 1e-9) + 1;
  const xs = Array.from({ length: count }, (_, k) => (k - (count - 1) / 2) * pitch);
  return { usable, count, xs };
}

function edgeGeom(part, edge, face) {
  const e = EDGE[edge];
  if (!e) throw new Error(`edge must be one of +X -X +Y -Y, got "${edge}"`);
  const [axis, s] = e;
  const run = 1 - axis;
  const half = part.size[axis] / 2;
  const isFrame = part.kind === 'FRAME';
  const bar = isFrame ? part.bar : 0;
  if (face === 'INNER' && !isFrame) throw new Error(`INNER face on ${part.id}, which is not a FRAME`);
  const surface = face === 'INNER' ? s * (half - bar) : s * half;
  const faceLen = face === 'INNER' ? part.size[run] - 2 * bar : part.size[run];
  const centreline = isFrame ? s * (half - bar / 2) : s * half;
  return { axis, s, run, n: unit(axis, s), runUnit: unit(run), surface, faceLen, centreline, outer: s * half };
}

// Local feature instances of one part.
function localFeatures(part, defs, P, errors) {
  const out = [];
  for (const d of Object.values(defs)) {
    if (d.host !== part.id) continue;
    const modelId = `${part.id}.${d.id}`;
    try {
      if (d.type === 'LATTICE') {
        const pattern = typeof d.pattern === 'string' && d.pattern.startsWith('OPEN:') ? d.pattern : d.pattern;
        out.push({ id: modelId, model_id: modelId, type: 'LATTICE', pos: [0, 0, 0],
          pattern, max_opening: { op: d.max_opening.op, value: num(d.max_opening.value, P) },
          rib: d.rib !== undefined ? num(d.rib, P) : null });
        continue;
      }
      const g = edgeGeom(part, d.edge, d.face);
      if (d.type === 'TAB') {
        if (d.dir !== 'EDGE_NORMAL') throw new Error('TAB dir must be EDGE_NORMAL in S0');
        const size = { len: num(d.size.len, P), w: num(d.size.w, P), t: num(d.size.t, P) };
        const from = AXES[d.at?.from];
        if (!from || Math.abs(from[g.run]) !== 1) throw new Error(`TAB at.from must point along the edge (${'XYZ'[g.run]})`);
        const endS = from[g.run];
        const runPos = endS * (part.size[g.run] / 2) - endS * (size.w / 2 + num(d.at.offset ?? 0, P));
        const pos = [0, 0, 0];
        pos[g.axis] = g.outer + g.s * size.len;
        pos[g.run] = runPos;
        out.push({ id: modelId, model_id: modelId, type: 'TAB', pos, dir: g.n, runUnit: g.runUnit, size });
      } else if (d.type === 'PIN') {
        if (d.dir !== 'EDGE_NORMAL') throw new Error('PIN dir must be EDGE_NORMAL');
        const size = { len: num(d.size.len, P), d: num(d.size.d, P) };
        const from = AXES[d.at?.from];
        if (!from || Math.abs(from[g.run]) !== 1) throw new Error(`PIN at.from must point along the edge (${'XYZ'[g.run]})`);
        const endS = from[g.run];
        const runPos = endS * (part.size[g.run] / 2) - endS * (size.d / 2 + num(d.at.offset ?? 0, P));
        const pos = [0, 0, 0];
        pos[g.axis] = g.outer + g.s * size.len;
        pos[g.run] = runPos;
        out.push({ id: modelId, model_id: modelId, type: 'PIN', pos, dir: g.n, size });
      } else if (d.type === 'EYE') {
        if (d.face !== 'INNER') throw new Error('EYE must sit on the INNER face in S0');
        if (d.bore_axis !== 'EDGE_NORMAL') throw new Error('EYE bore_axis must be EDGE_NORMAL in S0');
        const size = { bore: num(d.size.bore, P), depth: num(d.size.depth, P) };
        const mouth = g.surface - g.s * size.depth;
        let runs = [0];
        let pattern = null;
        if (d.array) {
          if (d.array.span !== 'HOST_FACE' || d.array.placement !== 'CENTRED') throw new Error('array needs span HOST_FACE and placement CENTRED');
          const pitch = num(d.array.pitch, P), margin = num(d.array.margin, P);
          const a = arrayPositions(g.faceLen, margin, pitch);
          if (a.count === 0) throw new Error(`array has no room: usable span ${a.usable}`);
          runs = a.xs;
          pattern = { face_len: g.faceLen, margin, pitch, usable: a.usable, count: a.count };
        }
        runs.forEach((rp, k) => {
          const pos = [0, 0, 0];
          pos[g.axis] = mouth;
          pos[g.run] = rp;
          out.push({ id: d.array ? `${modelId}[${k}]` : modelId, model_id: modelId, type: 'EYE', index: d.array ? k : null,
            pos, axis: g.n, size, pattern, pairOf: d.mirror?.pair_by_index ? `${part.id}.${d.mirror.of}` : null });
        });
      } else if (d.type === 'SPRING') {
        if (!['ALONG_EDGE', 'EDGE_NORMAL'].includes(d.compliance)) throw new Error('SPRING needs explicit compliance ALONG_EDGE or EDGE_NORMAL');
        const pct = String(d.span?.length ?? '');
        if (!/^\d+(\.\d+)?%$/.test(pct) || d.span?.at !== 'MID') throw new Error('SPRING span needs at MID and length "<n>%"');
        const extension = num(d.span.extension ?? 0, P);
        const length = (g.faceLen - extension) * parseFloat(pct) / 100 + extension;
        if (!Number.isFinite(extension) || extension < 0 || !(length > 0) || (part.kind === 'FRAME' && d.compliance === 'ALONG_EDGE' && length >= part.size[g.run] - 2 * part.bar)) throw new Error('SPRING extension/span exceeds available rail');
        const pos = [0, 0, 0];
        pos[g.axis] = g.centreline;
        out.push({ id: modelId, model_id: modelId, type: 'SPRING', pos,
          compliance: d.compliance === 'ALONG_EDGE' ? g.runUnit : g.n, size: { length },
          edge: d.edge, runUnit: g.runUnit });
      } else {
        throw new Error(`feature type "${d.type}" not supported in S0`);
      }
    } catch (e) {
      errors.push(`feature ${modelId}: ${e.message}`);
    }
  }
  return out;
}

function worldFeature(f, inst, v2 = false) {
  if (f.type === 'HOLE') return worldHole(f, inst);
  const w = {
    id: inst.index === null ? f.id : f.id.replace(`${inst.part}.`, `${inst.id}.`),
    model_id: f.model_id, type: f.type, position: add(inst.origin, rot(inst.R, f.pos)),
  };
  if (f.type === 'TAB') { w.direction = axisName(rot(inst.R, f.dir)); w.size = f.size; w._run = rot(inst.R, f.runUnit); w._t = inst.R.z; }
  if (f.type === 'PIN') { w.direction = axisName(rot(inst.R, f.dir)); w.size = f.size; }
  if (f.type === 'LATTICE') { w.pattern = f.pattern; w.max_opening = f.max_opening; w.rib = f.rib; w.host_size = [...inst.size]; w.host_bar = inst.bar; w.host_axes = { ...inst.axes }; }
  if (f.type === 'EYE') { w.bore_axis = axisName(rot(inst.R, f.axis)); w.size = f.size; w.index = f.index; w._pairOf = f.pairOf; }
  if (f.type === 'SPRING') { w.compliance_axis = axisLetter(rot(inst.R, f.compliance)); w.size = f.size; if (v2) { w.edge = f.edge; w.run_axis = axisLetter(rot(inst.R, f.runUnit)); } }
  return w;
}

function makeInstance(part, id, index, origin) {
  const inst = { id, part: part.id, index, kind: part.kind, role: part.role, origin, R: part.R,
    axes: part.R.names, basis: { x: part.R.x, y: part.R.y, z: part.R.z }, size: part.size, bar: part.kind === 'FRAME' ? part.bar : null };
  // schema 2: round parts carry their axis and diameter, a SHELL its wall and open side
  if (ROUND_KINDS.includes(part.kind) && part.v2) inst.extra = { d: part.size[1], axis: axisName(part.R.x) };
  if (part.kind === 'SHELL') {
    Object.assign(inst, { wall: part.wall, openLocal: part.open });
    inst.extra = { wall: part.wall, open: part.open === 'NONE' ? 'NONE' : axisName(rot(part.R, DIRS[part.open])) };
  }
  return inst;
}

export function resolve(model, opts = {}) {
  const errors = [], warnings = [];
  const { values: P, errors: pe } = evalParams(model.params, opts.params || {});
  errors.push(...pe);
  if (pe.length) return { resolved: null, errors, warnings };

  let defs;
  try { defs = featureDefs(model); } catch (e) { errors.push(e.message); return { resolved: null, errors, warnings }; }

  const v2 = model.schema === 2;
  const parts = {};
  for (const p of model.parts || []) {
    try {
      parts[p.id] = { id: p.id, kind: p.kind, role: p.role, size: p.size.map((v) => num(v, P)),
        bar: p.bar !== undefined ? num(p.bar, P) : null, R: orientation(p.orient), def: p };
      if (p.kind === 'FRAME' && !(parts[p.id].bar > 0)) errors.push(`part ${p.id}: FRAME needs bar > 0`);
      if (v2) partErrorsV2(parts[p.id], p, P, errors);
    } catch (e) { errors.push(`part ${p.id}: ${e.message}`); }
  }
  const local = {};
  const ifaces = {};
  const edgeDefs = v2 ? Object.fromEntries(Object.entries(defs).filter(([, d]) => d.type !== 'HOLE')) : defs;
  for (const part of Object.values(parts)) local[part.id] = localFeatures(part, edgeDefs, P, errors);
  if (v2) {
    for (const part of Object.values(parts)) {
      if (part.R.euler_deg && ((model.features || []).some((f) => f.host === part.id) || (model.interfaces || []).some((i) => i.part === part.id) || (model.joints || []).some((j) => j.part === part.id || JSON.stringify(j.links || []).includes(`${part.id}.`)))) {
        errors.push(`part ${part.id}: arbitrary euler orientation currently supports free-standing parts only; attached features/interfaces need an axis-aligned orientation`);
      }
    }
    for (const part of Object.values(parts)) {
      ifaces[part.id] = localInterfaces(model, part, local[part.id], P, errors);
      local[part.id].push(...localHoles(model, part, defs, ifaces[part.id], P, errors));
    }
  }

  const instances = [];
  const worldFeatures = {};
  const place = (inst) => {
    instances.push(inst);
    inst.features = local[inst.part].map((f) => worldFeature(f, inst, v2));
    for (const wf of inst.features) worldFeatures[wf.id] = wf;
  };

  for (const part of Object.values(parts)) {
    const pl = part.def.place;
    if (!pl) continue;
    const ext = [0, 1, 2].map((k) => Math.abs(part.R.x[k]) * part.size[0] + Math.abs(part.R.y[k]) * part.size[1] + Math.abs(part.R.z[k]) * part.size[2]);
    const at = v2 ? pl.at.map((v) => num(v, P)) : pl.at;
    const origin = pl.anchor === 'BOTTOM_CENTRE' ? [at[0], at[1], at[2] + ext[2] / 2] : [...at];
    place(makeInstance(part, part.id, null, origin));
  }

  const checks = {};
  const jointInfo = {};
  // INSERTS_INTO: translate the part so link 1's male tip sits at the female mouth + engage.
  const seat = (j) => {
    const part = parts[j.part];
    if (!part) { errors.push(`joint ${j.id}: unknown part "${j.part}"`); return; }
    const indices = j.index ? (opts.preview || j.index.preview || []) : [null];
    let engage;
    try { engage = num(j.engage, P); } catch (e) { errors.push(`joint ${j.id}: ${e.message}`); return; }
    let maxResidual = 0, fitOk = true, coaxial = true;
    for (const i of indices) {
      const sub_i = (s) => (j.index ? s.replace(`[${j.index.var}]`, `[${i}]`) : s);
      const links = j.links.map((l) => ({ male: l.male, female: sub_i(l.female) }));
      const males = links.map((l) => local[part.id].find((f) => f.model_id === l.male));
      const females = links.map((l) => worldFeatures[l.female]);
      if (males.some((m) => !m) || females.some((f) => !f)) {
        errors.push(`joint ${j.id}${i !== null ? ` at ${j.index.var}=${i}` : ''}: link target missing (${links.map((l) => l.female).join(', ')})`);
        continue;
      }
      // Placement: translate only, so that link 1 tip = mouth + engage * insertion axis.
      const f0 = females[0];
      const a0 = AXES[f0.bore_axis];
      const origin = sub(add(f0.position, mul(a0, engage)), rot(part.R, males[0].pos));
      const inst = makeInstance(part, i !== null ? `${part.id}@${i}` : part.id, i, origin);
      links.forEach((l, n) => {
        const md = axisName(rot(part.R, males[n].dir));
        if (md !== females[n].bore_axis) {
          errors.push(`joint ${j.id} link ${n + 1}: ${l.male} points ${md}, ${l.female} insertion axis is ${females[n].bore_axis}: incompatible`);
        }
        const tip = add(origin, rot(part.R, males[n].pos));
        const want = add(females[n].position, mul(AXES[females[n].bore_axis], engage));
        if (n > 0) maxResidual = Math.max(maxResidual, len(sub(tip, want)));
        // fit: tip inside the bore, axially and radially (tab cross-section corners)
        const a = AXES[females[n].bore_axis];
        const axial = dot(sub(tip, females[n].position), a);
        let radial;
        if (males[n].type === 'PIN') {
          radial = males[n].size.d / 2;
        } else {
          const hw = mul(rot(part.R, males[n].runUnit), males[n].size.w / 2);
          const ht = mul(part.R.z, males[n].size.t / 2);
          const corners = [[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([p, q]) => add(add(tip, mul(hw, p)), mul(ht, q)));
          radial = Math.max(...corners.map((c) => { const v = sub(c, females[n].position); return len(sub(v, mul(a, dot(v, a)))); }));
        }
        if (axial < -EPS || axial > females[n].size.depth + EPS || radial > females[n].size.bore / 2 + EPS) fitOk = false;
        if (n > 0) {
          const a1 = AXES[females[0].bore_axis], an = AXES[females[n].bore_axis];
          const d = sub(females[n].position, females[0].position);
          if (len(cross(a1, an)) > EPS || len(cross(d, a1)) > EPS) coaxial = false;
        }
      });
      place(inst);
    }
    checks[`${j.id}.link_residual_mm`] = round(maxResidual);
    checks[`${j.id}.fit`] = fitOk ? 'PASS' : 'FAIL';
    if (maxResidual > 0.01) warnings.push(`joint ${j.id}: links disagree by ${round(maxResidual)} mm`);
    if (!fitOk) warnings.push(`joint ${j.id}: male feature does not fit inside the female bore`);
    jointInfo[j.id] = { indices, engage, coaxial: j.links.length > 1 && coaxial };
  };
  const instOf = (partId) => instances.filter((i) => i.part === partId);
  if (!v2) for (const j of model.joints || []) seat(j);
  else {
    // schema 2: joints are placed in dependency order (a joint waits for its parent part), not in authored order
    const ctx = { parts, ifaces, instOf, place, makeInstance, P, errors, warnings };
    const parentOf = (j) => ('type' in j ? j.links?.[0]?.female : j.links?.[0]?.parent)?.split('.')[0];
    let pending = [...(model.joints || [])];
    for (let progress = true; progress && pending.length;) {
      progress = false;
      for (const j of [...pending]) {
        const parent = parentOf(j);
        if (!parent || !instOf(parent).length || instOf(j.part).length) continue;
        pending = pending.filter((x) => x !== j);
        progress = true;
        if ('type' in j) seat(j);
        else {
          const info = placeMotionJoint(j, ctx);
          if (info) { jointInfo[j.id] = info; checks[`${j.id}.link_residual_mm`] = round(info.residual); }
        }
      }
    }
    for (const j of pending) {
      errors.push(instOf(j.part).length ? `joint ${j.id}: part ${j.part} is already placed (by "place" or another joint)`
        : `joint ${j.id}: cannot be placed — its parent part is not placed (a joint loop or a missing parent)`);
    }
    for (const p of Object.values(parts)) if (!instOf(p.id).length) errors.push(`part ${p.id}: not placed — give it "place" or make it the part of one joint`);
  }

  // pairs by index
  for (const wf of Object.values(worldFeatures)) {
    if (wf._pairOf) {
      const other = worldFeatures[`${wf._pairOf}[${wf.index}]`];
      if (other) { wf.pair = other.id; other.pair = wf.id; }
    }
  }

  // unresolved tags from OPEN questions (and STATED ones: words the language cannot hold)
  const unresolved = {};
  for (const q of model.questions || []) {
    if (q.status !== 'OPEN' && q.status !== 'STATED') continue;
    unresolved[q.id] = [...(q.about || [])];
    for (const inst of instances) {
      if (q.about?.includes(inst.part)) (inst.unresolved ||= []).push(q.id);
      for (const wf of inst.features) if (q.about?.includes(wf.model_id)) (wf.unresolved ||= []).push(q.id);
    }
  }

  const patterns = {};
  for (const list of Object.values(local)) {
    for (const f of list) if (f.pattern && !patterns[f.model_id]) patterns[f.model_id] = { ...f.pattern, xs: [] };
  }
  for (const inst of instances) for (const wf of inst.features) {
    if (patterns[wf.model_id]) patterns[wf.model_id].xs.push(round(wf.position[0]));
  }

  const resolved = {
    state: 'INSTALLED',
    params: roundDeep(P),
    patterns: roundDeep(patterns),
    joints: roundDeep(jointInfo),
    instances: instances.map((inst) => roundDeep(cleanInstance(inst))),
    checks,
    unresolved,
  };
  if (v2) Object.assign(resolved, roundDeep(resolveMechanicsV2(model, { parts, ifaces, instances, instOf, worldFeatures, P, errors })));
  return { resolved, errors, warnings };
}

// schema 2: parts must carry exactly the geometry their kind needs.
function partErrorsV2(part, p, P, errors) {
  part.v2 = true;
  if (ROUND_KINDS.includes(p.kind) && !(part.size[1] > 0 && part.size[1] === part.size[2])) errors.push(`part ${p.id}: a ${p.kind} is round: size is [length, d, d] with d > 0`);
  if (p.kind === 'SHELL') {
    if (p.wall === undefined || p.open === undefined) { errors.push(`part ${p.id}: a SHELL needs wall and open`); part.wall = 0; part.open = 'NONE'; return; }
    part.wall = num(p.wall, P); part.open = p.open;
    if (!(part.wall > 0) || part.size.some((s) => 2 * part.wall >= s)) errors.push(`part ${p.id}: SHELL wall must be > 0 and less than half of every size`);
  } else if (p.wall !== undefined || p.open !== undefined) errors.push(`part ${p.id}: wall and open apply to a SHELL only`);
  if (p.kind !== 'FRAME' && p.bar !== undefined) errors.push(`part ${p.id}: bar applies to a FRAME only`);
}

// schema 2: world interfaces (declared and referenced), fasteners and volumes.
function resolveMechanicsV2(model, c) {
  const interfaces = {};
  const refs = new Set([
    ...(model.interfaces || []).map((i) => `${i.part}.${i.id}`),
    ...(model.joints || []).filter((j) => !('type' in j)).flatMap((j) => [...j.links.flatMap((l) => [l.child, l.parent]), ...(j.axis ? [j.axis] : [])]),
    ...(model.features || []).filter((f) => f.type === 'HOLE').map((f) => f.on),
    ...(model.volumes || []).map((v) => v.on),
  ]);
  for (const ref of [...refs].sort()) {
    const r = splitRef(ref);
    const insts = r ? c.instOf(r.part) : [];
    const li = r && c.ifaces[r.part]?.get(r.name);
    if (li && insts.length === 1) interfaces[ref] = { part: r.part, ...worldInterface(insts[0], li) };
  }
  const holes = {};
  for (const inst of c.instances) holes[inst.part] = inst.features.filter((f) => f.type === 'HOLE');
  const holeOf = (ref) => { const [p] = ref.split('.'); return c.instOf(p).length === 1 ? c.worldFeatures[ref] : undefined; };
  const fasteners = resolveFasteners(model, c, holeOf);
  const volumes = resolveVolumes(model, { ...c, holes });
  return { interfaces, fasteners, volumes };
}

function cleanInstance(inst) {
  const o = { id: inst.id, part: inst.part, kind: inst.kind, role: inst.role, origin: inst.origin, axes: inst.axes, size: inst.size };
  if (!inst.axes.x) o.basis = inst.basis;
  if (inst.bar !== null) o.bar = inst.bar;
  if (inst.extra) Object.assign(o, inst.extra);
  if (inst.index !== null) o.index = inst.index;
  o.features = inst.features.map((f) => {
    const { _run, _t, _pairOf, index, ...rest } = f;
    return rest;
  });
  if (inst.unresolved) o.unresolved = inst.unresolved;
  return o;
}

export function roundDeep(v) {
  if (typeof v === 'number') return round(v);
  if (Array.isArray(v)) return v.map(roundDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, roundDeep(x)]));
  return v;
}
