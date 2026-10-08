// Core V2 mechanics for the resolver (schema 2 only; architecture CORE_V2 §3, §9, §10).
// Interfaces (FACE / AXIS), HOLE features, placement of FIXED / REVOLUTE /
// PRISMATIC joints, fasteners and typed volumes. Deterministic and
// axis-aligned (90° orientations only). There is no solver: a joint translates
// its child so that link 1 coincides; further links are only checked.

import { num } from './model.js?v=f69a5921169d';
import { ROUND_KINDS, nominalDiameter, IFACE_REF } from './schema.js?v=f69a5921169d';

export const DIRS = { '+X': [1, 0, 0], '-X': [-1, 0, 0], '+Y': [0, 1, 0], '-Y': [0, -1, 0], '+Z': [0, 0, 1], '-Z': [0, 0, -1] };
const EPS = 1e-6;
const add = (a, b) => a.map((v, i) => v + b[i]);
const sub = (a, b) => a.map((v, i) => v - b[i]);
const mul = (a, s) => a.map((v) => v * s);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.sqrt(dot(a, a));
const unit = (i, s = 1) => { const v = [0, 0, 0]; v[i] = s; return v; };
export const dirName = (v) => Object.keys(DIRS).find((k) => len(sub(DIRS[k], v)) < EPS) ?? null;
const axisIndex = (v) => [0, 1, 2].find((i) => Math.abs(v[i]) > 0.5);
const parallel = (a, b) => len(cross(a, b)) < EPS;
const lineDistance = (p, lp, ld) => { const d = sub(p, lp); return len(sub(d, mul(ld, dot(d, ld)))); };
export const rot = (R, v) => add(add(mul(R.x, v[0]), mul(R.y, v[1])), mul(R.z, v[2]));

// In-plane face axes: the two other local axes in x → y → z order, never flipped.
const faceAxes = (normal) => { const [i, j] = [0, 1, 2].filter((k) => k !== axisIndex(normal)); return { a: unit(i), b: unit(j) }; };

export const splitRef = (ref) => { const m = IFACE_REF.exec(ref ?? ''); return m ? { part: m[1], name: m[2] } : null; };

// ------------------------------------------------------------------ local interfaces
// Map name → { type, point, dir, kind, a?, b?, hole? } in part-local coordinates.
export function localInterfaces(model, part, localFeatures, P, errors) {
  const m = new Map();
  const h = part.size.map((s) => s / 2);
  const face = (name, point, dir, kind) => m.set(name, { type: 'FACE', point, dir, kind, ...faceAxes(dir) });
  const round = ROUND_KINDS.includes(part.kind);
  for (const [k, d] of Object.entries(DIRS)) {
    if (round && k[1] !== 'X') continue;                          // a round part has end faces only
    face(k, mul(d, h[axisIndex(d)]), d, 'FACE');
    if (part.kind === 'SHELL' && part.open !== k) face(`INNER${k}`, mul(d, h[axisIndex(d)] - part.wall), mul(d, -1), 'INNER');
  }
  if (round) m.set('AXIS', { type: 'AXIS', point: [0, 0, 0], dir: [1, 0, 0], kind: 'ROUND_AXIS' });
  for (const i of model.interfaces || []) {
    if (i.part !== part.id) continue;
    try {
      const point = i.at.map((v) => num(v, P));
      const e = { type: i.type, point, dir: DIRS[i.dir], kind: 'DECLARED' };
      m.set(i.id, i.type === 'FACE' ? { ...e, ...faceAxes(e.dir) } : e);
    } catch (e) { errors.push(`interface ${part.id}.${i.id}: ${e.message}`); }
  }
  for (const f of localFeatures) {
    const name = f.id.slice(part.id.length + 1);
    if (f.type === 'TAB') m.set(name, { type: 'AXIS', point: f.pos, dir: f.dir, kind: 'TAB' });
    if (f.type === 'EYE') m.set(name, { type: 'AXIS', point: f.pos, dir: f.axis, kind: 'EYE' });
  }
  return m;
}

// ------------------------------------------------------------------ HOLE (E6)
// A hole on an interface of its host: along an AXIS, or into a FACE (along the
// inward normal, at `offset` in face coordinates). THROUGH runs through the
// material on that axis: a SHELL wall, a FRAME bar, otherwise the part's extent.
export function localHoles(model, part, defs, ifaces, P, errors) {
  const out = [];
  for (const d of Object.values(defs)) {
    if (d.host !== part.id || d.type !== 'HOLE') continue;
    const modelId = `${part.id}.${d.id}`;
    try {
      const ref = splitRef(d.on);
      if (!ref || ref.part !== part.id) throw new Error(`on "${d.on}" must be an interface of its host ${part.id}`);
      const on = ifaces.get(ref.name);
      if (!on) throw new Error(`on "${d.on}": no such interface`);
      if (on.type === 'AXIS' && d.offset) throw new Error('offset applies to a hole on a FACE only');
      if (d.profile === 'RECT' && on.type !== 'FACE') throw new Error('a RECT opening must sit on a FACE');
      const off = (d.offset || [0, 0]).map((v) => num(v, P));
      if (d.array && on.type !== 'FACE') throw new Error('a CIRCULAR array must sit on a FACE');
      if (d.array && d.profile !== 'ROUND') throw new Error('a CIRCULAR array currently supports ROUND holes only');
      const positions = d.array ? (() => {
        const count = d.array.count;
        const radius = num(d.array.radius, P);
        const start = num(d.array.start_deg, P) * Math.PI / 180;
        if (!Number.isInteger(count) || count < 2 || count > 128) throw new Error('a CIRCULAR array count must be an integer from 2 to 128');
        if (!(radius > 0)) throw new Error('a CIRCULAR array radius must be > 0');
        return Array.from({ length: count }, (_, k) => {
          const a = start + 2 * Math.PI * k / count;
          return add(add(on.point, mul(on.a, off[0] + radius * Math.cos(a))), mul(on.b, off[1] + radius * Math.sin(a)));
        });
      })() : [on.type === 'FACE' ? add(add(on.point, mul(on.a, off[0])), mul(on.b, off[1])) : on.point];
      const dir = on.type === 'FACE' ? mul(on.dir, -1) : on.dir;
      const A = axisIndex(dir), s = dir[A];
      const size = d.profile === 'ROUND' ? { d: num(d.size.d, P) } : { a: num(d.size.a, P), b: num(d.size.b, P) };
      positions.forEach((pos, k) => {
        let from = pos, to;
        if (d.depth !== 'THROUGH') to = add(pos, mul(dir, num(d.depth, P)));
        else if (on.type === 'AXIS') {
          from = [...pos]; to = [...pos];
          from[A] = -s * part.size[A] / 2; to[A] = s * part.size[A] / 2;
        } else {
          const thick = part.kind === 'SHELL' ? part.wall : part.kind === 'FRAME' ? part.bar : part.size[A];
          to = add(pos, mul(dir, thick));
        }
        const suffix = d.array ? `[${k}]` : '';
        out.push({ id: `${modelId}${suffix}`, model_id: modelId, type: 'HOLE', kind: d.kind, profile: d.profile, size, pos, dir, from, to,
          index: d.array ? k : null, pattern: d.array ? { ...d.array, radius: num(d.array.radius, P), start_deg: num(d.array.start_deg, P) } : null,
          ...(on.type === 'FACE' ? { a: on.a, b: on.b } : {}) });
        ifaces.set(`${d.id}${suffix}`, { type: 'AXIS', point: pos, dir, kind: 'HOLE', hole: d.kind });
      });
    } catch (e) {
      errors.push(`feature ${modelId}: ${e.message}`);
    }
  }
  return out;
}

export function worldHole(f, inst) {
  const w = { id: f.id, model_id: f.model_id, type: 'HOLE', kind: f.kind, profile: f.profile, size: f.size,
    position: add(inst.origin, rot(inst.R, f.pos)), axis: dirName(rot(inst.R, f.dir)),
    from: add(inst.origin, rot(inst.R, f.from)), to: add(inst.origin, rot(inst.R, f.to)) };
  if (f.a) { w.a_axis = dirName(rot(inst.R, f.a)); w.b_axis = dirName(rot(inst.R, f.b)); }
  return w;
}

export function worldInterface(inst, i) {
  const w = { type: i.type, point: add(inst.origin, rot(inst.R, i.point)), dir: dirName(rot(inst.R, i.dir)), kind: i.kind };
  if (i.a) { w.a = dirName(rot(inst.R, i.a)); w.b = dirName(rot(inst.R, i.b)); }
  return w;
}

// ------------------------------------------------------------------ joints (E4)
const MALE = ['ROUND_AXIS', 'TAB'];
const isFemale = (i) => i.kind === 'EYE' || (i.kind === 'HOLE' && ['BORE', 'CLEARANCE'].includes(i.hole));
const physicalPair = (a, b) => (MALE.includes(a.kind) && isFemale(b)) || (isFemale(a) && MALE.includes(b.kind));

// ctx: { parts, ifaces (partId → Map), instOf(partId) → [inst], place(inst), makeInstance, P, errors, warnings }
export function placeMotionJoint(j, ctx) {
  const E = (msg) => { ctx.errors.push(`joint ${j.id}: ${msg}`); };
  const child = ctx.parts[j.part];
  if (!child) return E(`unknown part "${j.part}"`);
  const refs = j.links.map((l) => ({ c: splitRef(l.child), p: splitRef(l.parent), l }));
  if (refs.some((r) => !r.c || !r.p)) return E('every link needs a child and a parent interface "PART.NAME"');
  if (refs.some((r) => r.c.part !== j.part)) return E(`every link child must be an interface of ${j.part}`);
  const parent = refs[0].p.part;
  if (refs.some((r) => r.p.part !== parent)) return E('all links must share one parent part');
  if (parent === j.part) return E('a part cannot be joined to itself');
  const pInsts = ctx.instOf(parent);
  if (pInsts.length !== 1) return E(`parent ${parent} must have exactly one placed instance`);
  const pInst = pInsts[0];
  const lookup = (partId, name, ref) => {
    const i = ctx.ifaces[partId]?.get(name);
    if (!i) E(`unknown interface "${ref}"`);
    return i;
  };
  const locals = refs.map((r) => ({ c: lookup(j.part, r.c.name, r.l.child), p: lookup(parent, r.p.name, r.l.parent) }));
  if (locals.some((x) => !x.c || !x.p)) return;
  let offset;
  try { offset = num(j.offset, ctx.P); } catch (e) { return E(e.message); }
  const R = child.R;
  const world = (inst, i) => ({ point: add(inst.origin, rot(inst.R, i.point)), dir: rot(inst.R, i.dir) });
  // link 1 places the child (translation only)
  const { c: c0, p: p0l } = locals[0];
  if (c0.type !== p0l.type) return E(`link 1 connects a ${c0.type} to a ${p0l.type}; a link joins AXIS to AXIS or FACE to FACE`);
  const p0 = world(pInst, p0l);
  const cd = rot(R, c0.dir);
  if (c0.type === 'AXIS' && !parallel(cd, p0.dir)) return E(`link 1: ${j.links[0].child} points ${dirName(cd)}, parent axis ${j.links[0].parent} points ${dirName(p0.dir)} — not parallel`);
  if (c0.type === 'FACE' && len(add(cd, p0.dir)) > EPS) return E(`link 1: face ${j.links[0].child} faces ${dirName(cd)}, it must face ${dirName(mul(p0.dir, -1))} (against ${j.links[0].parent})`);
  const origin = sub(add(p0.point, mul(p0.dir, offset)), rot(R, c0.point));
  const inst = ctx.makeInstance(child, j.part, null, origin);
  ctx.place(inst);
  // further links: checked, never placing
  let residual = 0, coaxial = c0.type === 'AXIS';
  locals.forEach(({ c, p }, n) => {
    if (n === 0) return;
    if (c.type !== p.type) { E(`link ${n + 1} connects a ${c.type} to a ${p.type}`); return; }
    const cw = world(inst, c), pw = world(pInst, p);
    if (c.type === 'AXIS') {
      if (!parallel(cw.dir, pw.dir)) E(`link ${n + 1}: ${j.links[n].child} is not parallel to ${j.links[n].parent}`);
      residual = Math.max(residual, lineDistance(cw.point, pw.point, pw.dir));
      if (!parallel(pw.dir, p0.dir) || lineDistance(pw.point, p0.point, p0.dir) > EPS) coaxial = false;
    } else {
      if (len(add(cw.dir, pw.dir)) > EPS) E(`link ${n + 1}: face ${j.links[n].child} must face against ${j.links[n].parent}`);
      residual = Math.max(residual, Math.abs(dot(sub(cw.point, pw.point), pw.dir) - offset));
      coaxial = false;
    }
  });
  if (residual > 0.01) ctx.warnings.push(`joint ${j.id}: links disagree by ${Math.round(residual * 1e6) / 1e6} mm`);
  const info = { motion: j.motion, parent, links: j.links.map((l, n) => ({ child: l.child, parent: l.parent, kind: locals[n].c.type === 'AXIS' ? 'COAXIAL' : 'SEATED' })),
    offset, coaxial, physical: c0.type === 'AXIS' && physicalPair(c0, p0l), residual };
  // the joint axis (REVOLUTE / PRISMATIC)
  if (j.axis) {
    const a = splitRef(j.axis);
    if (!a || (a.part !== parent && a.part !== j.part)) E(`axis "${j.axis}" must be an interface of ${parent} or ${j.part}`);
    else {
      const al = lookup(a.part, a.name, j.axis);
      if (al && al.type !== 'AXIS') E(`axis "${j.axis}" is a FACE; a joint axis must be an AXIS interface`);
      else if (al) {
        const aw = world(a.part === parent ? pInst : inst, al);
        info.axis = { interface: j.axis, point: aw.point, dir: dirName(aw.dir) };
        if (c0.type === 'AXIS' && (!parallel(aw.dir, p0.dir) || lineDistance(p0.point, aw.point, aw.dir) > EPS)) {
          E(`link 1 (${j.links[0].parent}) does not lie on the joint axis ${j.axis}`);
        }
        if (c0.type === 'FACE' && j.motion === 'REVOLUTE' && !parallel(aw.dir, p0.dir)) E(`a REVOLUTE joint on seated faces turns about their normal; axis ${j.axis} is not normal to ${j.links[0].parent}`);
        if (c0.type === 'FACE' && j.motion === 'PRISMATIC' && Math.abs(dot(aw.dir, p0.dir)) > EPS) E(`a PRISMATIC joint on seated faces slides in their plane; axis ${j.axis} is not parallel to ${j.links[0].parent}`);
      }
    }
  }
  if (j.limits && typeof j.limits === 'object') {
    let min, max;
    try { min = num(j.limits.min, ctx.P); max = num(j.limits.max, ctx.P); } catch (e) { E(`limits: ${e.message}`); return info; }
    if (!Number.isFinite(min) || !Number.isFinite(max)) { E(`limits resolve to ${min} … ${max}; both must be finite numbers`); return info; }
    const authored = ['min', 'max'].some((k) => typeof j.limits[k] === 'string') ? { authored: { min: j.limits.min, max: j.limits.max } } : {};
    info.limits = { min, max, unit: j.motion === 'REVOLUTE' ? 'deg' : 'mm', zero: 'MODELLED_POSE', ...authored };
  }
  else if (j.limits !== undefined) info.limits = j.limits;
  return info;
}

// ------------------------------------------------------------------ bodies (for volume checks)
// World axis-aligned body primitives of one placed instance.
export function bodyPrimitives(inst) {
  const [L, W, T] = inst.size;
  const box = (c, s) => {
    const cw = add(inst.origin, rot(inst.R, c));
    const sw = [0, 1, 2].map((k) => Math.abs(inst.R.x[k]) * s[0] + Math.abs(inst.R.y[k]) * s[1] + Math.abs(inst.R.z[k]) * s[2]);
    return { part: inst.part, kind: 'box', min: sub(cw, mul(sw, 0.5)), max: add(cw, mul(sw, 0.5)), center: cw, size: sw };
  };
  if (ROUND_KINDS.includes(inst.kind)) {
    const A = axisIndex(inst.R.x);
    return [{ part: inst.part, kind: 'cyl', axis: A, center: inst.origin, r: W / 2, lo: inst.origin[A] - L / 2, hi: inst.origin[A] + L / 2 }];
  }
  if (inst.kind === 'FRAME') {
    const b = inst.bar;
    return [box([0, W / 2 - b / 2, 0], [L, b, T]), box([0, -(W / 2 - b / 2), 0], [L, b, T]),
      box([L / 2 - b / 2, 0, 0], [b, W - 2 * b, T]), box([-(L / 2 - b / 2), 0, 0], [b, W - 2 * b, T])];
  }
  if (inst.kind === 'SHELL') {
    const out = [];
    for (const [k, d] of Object.entries(DIRS)) {
      if (k === inst.openLocal) continue;
      const A = axisIndex(d);
      const c = mul(d, inst.size[A] / 2 - inst.wall / 2);
      const s = [...inst.size]; s[A] = inst.wall;
      out.push({ ...box(c, s), wall: k });
    }
    return out;
  }
  return [box([0, 0, 0], inst.size)];
}

const overlap = (a, b) => [0, 1, 2].every((i) => Math.min(a.max[i], b.max[i]) - Math.max(a.min[i], b.min[i]) > EPS);
const inside = (inner, outer) => [0, 1, 2].every((i) => inner.min[i] >= outer.min[i] - EPS && inner.max[i] <= outer.max[i] + EPS);
function boxHitsCylinder(b, c) {
  const A = c.axis;
  if (Math.min(b.max[A], c.hi) - Math.max(b.min[A], c.lo) <= EPS) return false;
  const [i, k] = [0, 1, 2].filter((x) => x !== A);
  const dx = Math.max(b.min[i] - c.center[i], 0, c.center[i] - b.max[i]);
  const dy = Math.max(b.min[k] - c.center[k], 0, c.center[k] - b.max[k]);
  return Math.hypot(dx, dy) < c.r - EPS;
}

// The space an OPENING hole frees in its wall (axis-aligned).
function openingPrism(h) {
  const A = axisIndex(DIRS[h.axis]);
  const lo = Math.min(h.from[A], h.to[A]), hi = Math.max(h.from[A], h.to[A]);
  if (h.profile === 'ROUND') return { kind: 'cyl', axis: A, center: h.position, r: h.size.d / 2, lo, hi };
  const min = [...h.position], max = [...h.position];
  const ai = axisIndex(DIRS[h.a_axis]), bi = axisIndex(DIRS[h.b_axis]);
  min[ai] -= h.size.a / 2; max[ai] += h.size.a / 2; min[bi] -= h.size.b / 2; max[bi] += h.size.b / 2;
  min[A] = lo; max[A] = hi;
  return { kind: 'box', min, max };
}
function prismContains(p, box) {
  if (p.kind === 'box') return inside(box, p);
  const A = p.axis;
  if (box.min[A] < p.lo - EPS || box.max[A] > p.hi + EPS) return false;
  const [i, k] = [0, 1, 2].filter((x) => x !== A);
  return [[box.min[i], box.min[k]], [box.min[i], box.max[k]], [box.max[i], box.min[k]], [box.max[i], box.max[k]]]
    .every(([x, y]) => Math.hypot(x - p.center[i], y - p.center[k]) <= p.r + EPS);
}

const aabbOf = (prims) => {
  const pts = prims.flatMap((p) => (p.kind === 'box' ? [p.min, p.max] : [0, 1].map((s) => {
    const v = [...p.center].map((c) => c + (s ? p.r : -p.r)); v[p.axis] = s ? p.hi : p.lo; return v;
  })));
  if (!pts.length) return null;
  return { min: [0, 1, 2].map((i) => Math.min(...pts.map((p) => p[i]))), max: [0, 1, 2].map((i) => Math.max(...pts.map((p) => p[i]))) };
};

// ------------------------------------------------------------------ fasteners (E5)
export function resolveFasteners(model, ctx, holeOf) {
  const out = {};
  for (const fa of model.fasteners || []) {
    const E = (msg) => ctx.errors.push(`fastener ${fa.id}: ${msg}`);
    const refs = [...fa.through, ...(fa.into ? [fa.into] : [])];
    const holes = refs.map((r) => holeOf(r));
    if (holes.some((h) => !h)) { E(`unknown or unplaced hole ${refs.filter((r, i) => !holes[i]).join(', ')}`); continue; }
    if (holes.some((h) => h.profile !== 'ROUND')) { E('a fastener passes through ROUND holes only'); continue; }
    const head = holes[0];
    const ins = DIRS[head.axis];
    let ok = true;
    holes.forEach((h, n) => {
      if (!parallel(DIRS[h.axis], ins) || lineDistance(h.position, head.position, ins) > EPS) { E(`${refs[n]} is not on the fastener axis through ${refs[0]}`); ok = false; }
    });
    if (fa.into && ok && holes.at(-1).axis !== head.axis) { E(`${fa.into} must be entered from the head side (${head.axis})`); ok = false; }
    const t = holes.map((h) => dot(sub(h.position, head.position), ins));
    if (ok && t.some((x, n) => n > 0 && x < t[n - 1] - EPS)) { E(`holes must be listed from the head side along ${head.axis}: ${refs.join(' → ')}`); ok = false; }
    const nominal = nominalDiameter(fa.size);
    if (nominal !== null) {
      fa.through.forEach((r, n) => { if (holes[n].size.d < nominal - EPS) { E(`clearance hole ${r} Ø${holes[n].size.d} is smaller than ${fa.size}`); ok = false; } });
      if (fa.into && Math.abs(holes.at(-1).size.d - nominal) > EPS) { E(`threaded hole ${fa.into} Ø${holes.at(-1).size.d} does not match ${fa.size} (Ø${nominal})`); ok = false; }
    }
    const endHole = holes.at(-1);
    const end = dot(sub(endHole.from, head.position), ins) > dot(sub(endHole.to, head.position), ins) ? endHole.from : endHole.to;
    out[fa.id] = { kind: fa.kind, size: fa.size, joint: fa.joint, head_part: fa.through[0].split('.')[0], axis_point: head.position,
      insert_dir: head.axis, end_point: end, holes: refs, check: ok ? 'PASS' : 'FAIL' };
  }
  return out;
}

// ------------------------------------------------------------------ volumes (E7)
// ctx.instances: placed instances; ctx.holes: world HOLE features by part.
export function resolveVolumes(model, ctx) {
  const out = {};
  const prims = ctx.instances.flatMap((i) => bodyPrimitives(i));
  const produced = aabbOf(ctx.instances.filter((i) => i.role === 'PRODUCED').flatMap((i) => bodyPrimitives(i)));
  const partIds = new Set((model.parts || []).map((p) => p.id));
  for (const vol of model.volumes || []) {
    const E = (msg) => ctx.errors.push(`volume ${vol.id} (${vol.purpose}): ${msg}`);
    const ref = splitRef(vol.on);
    const insts = ref ? ctx.instOf(ref.part) : [];
    const li = ref && ctx.ifaces[ref.part]?.get(ref.name);
    if (!li || insts.length !== 1) { E(`on "${vol.on}" is not an interface of a placed part`); continue; }
    if (li.type !== 'FACE') { E(`on "${vol.on}" must be a FACE interface`); continue; }
    let off, size;
    try { off = (vol.offset || [0, 0]).map((v) => num(v, ctx.P)); size = ['a', 'b', 'depth'].map((k) => num(vol.size[k], ctx.P)); } catch (e) { E(e.message); continue; }
    if (size.some((x) => !(x > 0))) { E('size a, b and depth must be positive'); continue; }
    const inst = insts[0];
    const base = add(inst.origin, rot(inst.R, add(add(li.point, mul(li.a, off[0])), mul(li.b, off[1]))));
    const n = rot(inst.R, li.dir), a = rot(inst.R, li.a), b = rot(inst.R, li.b);
    const corners = [0, 1].flatMap((i) => [0, 1].flatMap((k) => [0, 1].map((m) =>
      add(add(add(base, mul(a, (i - 0.5) * size[0])), mul(b, (k - 0.5) * size[1])), mul(n, m * size[2])))));
    const box = { min: [0, 1, 2].map((x) => Math.min(...corners.map((c) => c[x]))), max: [0, 1, 2].map((x) => Math.max(...corners.map((c) => c[x]))) };
    const forPart = partIds.has(vol.for) ? vol.for : null;
    const exempt = new Set([...(forPart ? [forPart] : []), ...(vol.allow || [])]);
    const checks = {};
    const intruders = new Set();
    for (const p of prims) {
      if (exempt.has(p.part)) continue;
      if (p.kind === 'cyl') { if (boxHitsCylinder(box, p)) intruders.add(p.part); continue; }
      if (!overlap(box, p)) continue;
      const cut = { min: [0, 1, 2].map((i) => Math.max(box.min[i], p.min[i])), max: [0, 1, 2].map((i) => Math.min(box.max[i], p.max[i])) };
      const openings = (ctx.holes[p.part] || []).filter((h) => h.kind === 'OPENING').map(openingPrism);
      if (!openings.some((o) => prismContains(o, cut))) intruders.add(p.part);
    }
    checks.no_intrusion = intruders.size ? 'FAIL' : 'PASS';
    if (intruders.size) E(`${[...intruders].join(', ')} occupies the volume${vol.purpose === 'KEEP_OUT' ? '' : ' (an OPENING must contain the corridor where it crosses a wall)'}`);
    const A = axisIndex(n), s = n[A];
    if (vol.purpose !== 'KEEP_OUT') {
      const outside = !produced || (s > 0 ? box.max[A] >= produced.max[A] - EPS : box.min[A] <= produced.min[A] + EPS);
      checks.reaches_outside = outside ? 'PASS' : 'FAIL';
      if (!outside) E(`does not reach outside the produced geometry along ${dirName(n)}`);
    }
    if (vol.purpose === 'REMOVAL_PATH') {
      if (!forPart) { E(`for "${vol.for}" must be a part (the part that is removed)`); checks.removal = 'FAIL'; }
      else {
        const joint = (model.joints || []).find((j) => j.part === forPart && !('type' in j));
        const pa = aabbOf(ctx.instOf(forPart).flatMap((i) => bodyPrimitives(i)));
        const fits = pa && [0, 1, 2].filter((i) => i !== A).every((i) => pa.min[i] >= box.min[i] - EPS && pa.max[i] <= box.max[i] + EPS);
        const dir = joint?.assembly?.direction;
        const problems = [];
        if (!joint) problems.push(`${forPart} is not attached by a FIXED / REVOLUTE / PRISMATIC joint, so removal has no reference`);
        if (!fits) problems.push(`the cross-section of ${forPart} does not fit the corridor`);
        if (joint && DIRS[dir] && len(add(DIRS[dir], n)) > EPS) problems.push(`the corridor points ${dirName(n)}, but ${forPart} is removed along ${dirName(mul(DIRS[dir], -1))} (reverse of its assembly direction ${dir})`);
        if (joint?.assembly?.removable === 'NO') problems.push(`joint ${joint.id} says ${forPart} is not removable`);
        checks.removal = problems.length ? 'FAIL' : 'PASS';
        for (const p of problems) E(p);
      }
    }
    out[vol.id] = { purpose: vol.purpose, for: vol.for, on: vol.on, dir: dirName(n), box_min: box.min, box_max: box.max, checks };
  }
  return out;
}
