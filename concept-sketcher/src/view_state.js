// Viewer state (UI only): reference visibility, section cut, exploded view and
// the inspected entity. None of it is part of the model: these functions read
// a model and its validation, never write to it, and the result is never
// passed to validate, export, a proposal or the concept hash.
//
// Section and explode follow Mechanical Studio's semantics
// (tools/mechanical_studio/frontend: sectionPlane(), sectionRange(), explodeOffset()).

import { referenceParts } from './inspect.js?v=82722beda481';

export const SECTION_AXES = ['X', 'Y', 'Z'];

export function defaultViewState() {
  return { showReference: true, section: { on: false, axis: 'Z', pos: 0, flip: false }, explode: 0, selected: null, isolatePart: null };
}

// The section plane as THREE.Plane parameters { normal, constant }: three.js keeps
// a fragment where normal·p + constant >= 0. Unflipped, the half on the positive
// side of the axis is removed (Mechanical Studio: kept half is dot(n, p) <= pos);
// flip keeps that half instead without moving the plane.
export function sectionPlane(section) {
  const k = SECTION_AXES.indexOf(section?.axis);
  if (!section?.on || k < 0 || !Number.isFinite(section.pos)) return null;
  const s = section.flip ? 1 : -1;
  const normal = [0, 0, 0];
  normal[k] = s;
  return { normal, constant: -s * section.pos };
}

// The slider runs through the given bounds on that axis, a hair beyond each face.
export function sectionRange(bounds, axis) {
  const k = SECTION_AXES.indexOf(axis);
  if (!bounds || k < 0) return null;
  const lo = Math.floor((bounds.min[k] - 0.5) * 10) / 10;
  const hi = Math.ceil((bounds.max[k] + 0.5) * 10) / 10;
  return { lo, hi, mid: Math.round((bounds.min[k] + bounds.max[k]) * 5) / 10 };
}

// Scene item id -> the instance it moves with ("DIVIDER@2.PIN_R#dir" -> "DIVIDER@2").
export const instanceOfItem = (id) => String(id).split('#')[0].split('.')[0];

const DIRS = { '+X': [1, 0, 0], '-X': [-1, 0, 0], '+Y': [0, 1, 0], '-Y': [0, -1, 0], '+Z': [0, 0, 1], '-Z': [0, 0, -1] };
const neg = (d) => d.map((x) => -x || 0);

// Snap a vector to its dominant world axis (ties: Z, then Y, then X); a null vector -> +Z.
function dominantAxis(vec) {
  let best = 2;
  for (const k of [1, 0]) if (Math.abs(vec[k]) > Math.abs(vec[best]) + 1e-9) best = k;
  if (Math.abs(vec[best]) < 1e-9) return [0, 0, 1];
  const out = [0, 0, 0];
  out[best] = Math.sign(vec[best]);
  return out;
}

function boxOf(instances) {
  if (!instances.length) return null;
  const lo = [0, 1, 2].map((k) => Math.min(...instances.map((i) => i.origin[k] - Math.abs(i.size[k] ?? 0) / 2)));
  const hi = [0, 1, 2].map((k) => Math.max(...instances.map((i) => i.origin[k] + Math.abs(i.size[k] ?? 0) / 2)));
  return { lo, hi, centre: lo.map((x, k) => (x + hi[k]) / 2), extent: Math.max(...hi.map((x, k) => x - lo[k])) };
}

// Exploded view: one deterministic offset per PRODUCED instance, scaled by amount
// (0 … 1). A part joined to a parent moves away from it along the joint's
// removal direction when the model states one unambiguously (typed joint
// assembly.direction, or male features of an INSERTS_INTO that all point the
// same way); otherwise along the dominant axis from the parent's centre (or
// the assembly centre for unjoined parts). Children inherit their parent's
// offset. REFERENCE parts never move.
export function explodeOffsets(model, v, amount) {
  const a = Math.max(0, Math.min(1, Number(amount) || 0));
  const insts = (v.resolved?.instances || []).filter((i) => i.role !== 'REFERENCE');
  const out = {};
  for (const i of v.resolved?.instances || []) out[i.id] = [0, 0, 0];
  if (!a || !insts.length) return out;
  const refs = new Set(referenceParts(model));
  const box = boxOf(insts);
  const step = 0.6 * box.extent * a;

  // parent part + stated removal direction per child part
  const parent = {}, removal = {};
  for (const j of model.joints || []) {
    if (refs.has(j.part)) continue;
    if (j.type === 'INSERTS_INTO') {
      const host = String(j.links?.[0]?.female ?? '').split('.')[0];
      if (host && host !== j.part && !refs.has(host)) parent[j.part] ??= host;
      const inst = insts.find((i) => i.part === j.part);
      const dirs = new Set((j.links || []).map((l) => inst?.features.find((f) => f.id === `${inst.id}.${String(l.male).split('.')[1]}`)?.direction).filter(Boolean));
      if (dirs.size === 1 && DIRS[[...dirs][0]]) removal[j.part] ??= neg(DIRS[[...dirs][0]]);
    } else {
      const host = v.resolved?.joints?.[j.id]?.parent ?? String(j.links?.[0]?.parent ?? '').split('.')[0];
      if (host && host !== j.part && !refs.has(host)) parent[j.part] ??= host;
      if (DIRS[j.assembly?.direction]) removal[j.part] ??= neg(DIRS[j.assembly.direction]);
    }
  }
  const roots = [...new Set(insts.map((i) => i.part))].filter((p) => !parent[p]);
  const fixedRoot = roots.length === 1 ? roots[0] : null;     // one unjoined base stays put

  const memo = {};
  const offsetOf = (inst, seen = new Set()) => {
    if (memo[inst.id]) return memo[inst.id];
    if (seen.has(inst.id)) return [0, 0, 0];
    seen.add(inst.id);
    const p = parent[inst.part];
    const pInst = p ? insts.find((i) => i.part === p) : null;
    let res;
    if (!pInst) {
      res = inst.part === fixedRoot ? [0, 0, 0] : dominantAxis(inst.origin.map((x, k) => x - box.centre[k])).map((d) => d * step);
    } else {
      const base = offsetOf(pInst, seen);
      let dir = removal[inst.part] ?? dominantAxis(inst.origin.map((x, k) => x - pInst.origin[k]));
      // a child must not fold back onto the base: if its direction cancels the parent's, keep going the parent's way
      if (Math.hypot(...base.map((x, k) => x + dir[k] * step)) < step * 0.5) dir = dominantAxis(base);
      res = base.map((x, k) => x + dir[k] * step);
    }
    return (memo[inst.id] = res.map((x) => Math.round(x * 1000) / 1000 || 0));
  };
  for (const i of insts) out[i.id] = offsetOf(i);
  return out;
}

// A copy of the view state with one change applied; the input is never modified.
export function updateView(view, patch) {
  return { ...view, ...patch, section: { ...view.section, ...(patch.section || {}) } };
}
