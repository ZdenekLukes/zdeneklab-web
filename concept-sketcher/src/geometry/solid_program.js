// Solid program: the physical material of a resolved concept, as plain data,
// independent of any geometry library (POC, docs/GEOMETRY_ENGINE_POC.md).
//
//   resolved model (src/resolve.js) ──► solidProgram() ──► engine (manifold_engine.js) ──► meshes
//
// One solid per placed part instance: material = ∪ adds − ∪ cuts, in world
// coordinates (the resolver's 90° placements). Adds are the base body and the
// additive features (TAB, PIN); cuts are the inner cavity of a SHELL, the opening
// of a FRAME and every HOLE. The canonical .aiconcept, validation and the AI
// contract never see this structure; replacing the engine only replaces the
// module that executes it.
//
// Instances whose features the program does not cover yet (EYE, SPRING, LATTICE)
// and REFERENCE parts stay with the existing scene primitives and are listed in
// `skipped`. Annotations (interfaces, axes, limits, volumes, fasteners) are not
// material and are never part of a solid.

import { featureDefs, AXES, axisAligned } from '../resolve.js?v=cefb80df528e';

export const SOLID_PROGRAM = 'AI_CONCEPT_SOLIDS';
export const COVERED_FEATURES = ['TAB', 'PIN', 'HOLE'];
// Cuts reach this far past the surfaces they open, so no zero-thickness skin can remain.
export const CUT_OVERRUN = 0.01;

const add = (a, b) => a.map((v, i) => v + b[i]);
const sub = (a, b) => a.map((v, i) => v - b[i]);
const mul = (a, s) => a.map((v) => v * s);
const mid = (a, b) => a.map((v, i) => (v + b[i]) / 2);
const r6 = (v) => (Array.isArray(v) ? v.map(r6) : Object.is(Math.round(v * 1e6) / 1e6, -0) ? 0 : Math.round(v * 1e6) / 1e6);
const axisIndex = (name) => 'XYZ'.indexOf(name[1]);
// Round outlines: 16–64 sides by circumference (bounded tessellation), the same in every engine.
export const roundSegments = (d) => Math.max(16, Math.min(64, 4 * Math.ceil((Math.PI * d) / 10)));

// Local box size → world size for an axis-aligned instance (axes: world names of local x, y, z).
const worldSize = (axes, s) => [0, 1, 2].map((k) => Math.abs(AXES[axes.x][k]) * s[0] + Math.abs(AXES[axes.y][k]) * s[1] + Math.abs(AXES[axes.z][k]) * s[2]);
const box = (center, size, extra = {}) => ({ type: 'box', center: r6(center), size: r6(size), ...extra });
const cylinder = (center, axis, d, length, extra = {}) => ({ type: 'cylinder', center: r6(center), axis, d: r6(d), length: r6(length), segments: roundSegments(d), ...extra });

function body(inst, localOpen) {
  const { size, origin } = inst;
  if (inst.d !== undefined) return { adds: [cylinder(origin, inst.axis[1], inst.d, size[0])], cuts: [] };
  // World-axis-aligned bodies use world sizes. Free Euler bodies retain local
  // dimensions and transform every additive AND subtractive primitive.
  const free = !axisAligned(inst.axes);
  const ws = free ? size : worldSize(inst.axes, size);
  const basis = free ? r6([inst.basis.x, inst.basis.y, inst.basis.z]) : null;
  const place = (c) => free
    ? add(origin, [0, 1, 2].map((i) => inst.basis.x[i] * c[0] + inst.basis.y[i] * c[1] + inst.basis.z[i] * c[2]))
    : add(origin, c);
  const shapedBox = (c, s, extra = {}) => box(place(c), s, { ...(basis ? { basis } : {}), ...extra });
  const adds = [shapedBox([0, 0, 0], ws)];
  if (inst.kind === 'SHELL') {
    const lo = ws.map((s) => -s / 2 + inst.wall), hi = ws.map((s) => s / 2 - inst.wall);
    const opening = free ? localOpen : inst.open;
    if (opening && opening !== 'NONE') {
      const k = axisIndex(opening);
      if (opening[0] === '+') hi[k] = ws[k] / 2 + CUT_OVERRUN; else lo[k] = -ws[k] / 2 - CUT_OVERRUN;
    }
    return { adds, cuts: [shapedBox(mid(lo, hi), sub(hi, lo), { role: 'cavity' })] };
  }
  if (inst.kind === 'FRAME') {
    const localOpening = [size[0] - 2 * inst.bar, size[1] - 2 * inst.bar, size[2] + 2 * CUT_OVERRUN];
    return { adds, cuts: [shapedBox([0, 0, 0], free ? localOpening : worldSize(inst.axes, localOpening), { role: 'opening' })] };
  }
  return { adds, cuts: [] };
}

function feature(inst, f, defs) {
  if (f.type === 'TAB') {
    const d = AXES[f.direction];
    const size = [0, 1, 2].map((k) => (Math.abs(d[k]) ? f.size.len : AXES[inst.axes.z][k] ? f.size.t : f.size.w));
    return { add: box(sub(f.position, mul(d, f.size.len / 2)), size, { feature: f.model_id }) };
  }
  if (f.type === 'PIN') {
    const d = AXES[f.direction];
    return { add: cylinder(sub(f.position, mul(d, f.size.len / 2)), f.direction[1], f.size.d, f.size.len, { feature: f.model_id }) };
  }
  if (f.type === 'HOLE') {
    const dir = AXES[f.axis];
    const through = defs[f.model_id]?.depth === 'THROUGH';
    const entry = sub(f.from, mul(dir, CUT_OVERRUN));
    const exit = through ? add(f.to, mul(dir, CUT_OVERRUN)) : f.to;
    const length = Math.abs(exit[axisIndex(f.axis)] - entry[axisIndex(f.axis)]);
    if (f.profile === 'ROUND') return { cut: cylinder(mid(entry, exit), f.axis[1], f.size.d, length, { feature: f.id, depth: through ? 'THROUGH' : 'BLIND' }) };
    const size = [0, 0, 0];
    size[axisIndex(f.axis)] = length; size[axisIndex(f.a_axis)] = f.size.a; size[axisIndex(f.b_axis)] = f.size.b;
    return { cut: box(mid(entry, exit), size, { feature: f.id, depth: through ? 'THROUGH' : 'BLIND' }) };
  }
  return null;
}

// model + validate(model) → { format, v, solids: [{ id, part, kind, role, adds, cuts }], skipped: [{ instance, reason }] }
export function solidProgram(model, v) {
  const out = { format: SOLID_PROGRAM, v: 1, solids: [], skipped: [] };
  if (model.schema !== 2 || !v?.resolved) {
    if (v?.resolved) for (const inst of v.resolved.instances) out.skipped.push({ instance: inst.id, reason: 'schema 1 concept: drawn with the existing primitives' });
    return out;
  }
  const localOpenByPart = new Map(model.parts.map((p) => [p.id, p.open]));
  let defs = {};
  try { defs = Object.fromEntries(Object.values(featureDefs(model)).map((d) => [`${d.host}.${d.id}`, d])); } catch { /* the resolver reports it */ }
  for (const inst of v.resolved.instances) {
    if (inst.role === 'REFERENCE') { out.skipped.push({ instance: inst.id, reason: 'reference part: drawn as a ghost, not as material' }); continue; }
    if (inst.kind === 'ENVELOPE') { out.skipped.push({ instance: inst.id, reason: 'envelope: a space claim, not material' }); continue; }
    if (inst.d !== undefined && !inst.axis) { out.skipped.push({ instance: inst.id, reason: 'arbitrarily rotated round part is not supported by the solid adapter' }); continue; }
    const other = [...new Set(inst.features.map((f) => f.type).filter((t) => !COVERED_FEATURES.includes(t)))];
    if (other.length) { out.skipped.push({ instance: inst.id, reason: `${other.join(', ')} not in the solid engine yet: drawn with the existing primitives` }); continue; }
    if (!axisAligned(inst.axes) && inst.features.length) { out.skipped.push({ instance: inst.id, reason: 'rotated part with features' }); continue; }
    const { adds, cuts } = body(inst, localOpenByPart.get(inst.part));
    for (const f of inst.features) {
      const r = feature(inst, f, defs);
      if (r?.add) adds.push(r.add);
      if (r?.cut) cuts.push(r.cut);
    }
    out.solids.push({ id: inst.id, part: inst.part, kind: inst.kind, role: inst.role, adds, cuts });
  }
  return out;
}

// Which solids a proposal changes: compare the accepted and candidate programs solid by solid.
export function solidChanges(accepted, candidate) {
  const key = (s) => JSON.stringify([s.adds, s.cuts]);
  const a = new Map(accepted.solids.map((s) => [s.id, key(s)]));
  const c = new Map(candidate.solids.map((s) => [s.id, key(s)]));
  return {
    changed: [...c.keys()].filter((id) => a.has(id) && a.get(id) !== c.get(id)),
    added: [...c.keys()].filter((id) => !a.has(id)),
    removed: [...a.keys()].filter((id) => !c.has(id)),
  };
}
