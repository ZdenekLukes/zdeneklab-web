// resolved -> scene.json: a flat list of world-space primitives for the preview.
// No geometry decisions happen in the viewer; it only draws what is listed here.
// Elements named by an OPEN question are drawn in the UNRESOLVED style.

import { AXES, add, sub, mul, dot, cross, len, roundDeep, axisAligned } from './resolve.js?v=cefb80df528e';
import { nominalDiameter } from './schema.js?v=cefb80df528e';

const axisVector = (axes, basis, k) => AXES[axes?.[k]] || basis?.[k];
const rotLocal = (axes, v, basis = null) => ['x', 'y', 'z'].reduce((acc, k, i) => add(acc, mul(axisVector(axes, basis, k), v[i])), [0, 0, 0]);
const worldSize = (axes, s) => rotLocal(axes, s).map(Math.abs);

export function maturityLine(v) {
  if (v.state === 'SKELETON_READY') return 'SKELETON READY';
  if (v.state === 'CONCEPT_FROZEN') {
    return v.gates.SKELETON_READY.ok ? 'CONCEPT FROZEN — SKELETON READY GATE PASSES (not yet marked)'
      : `CONCEPT FROZEN — NOT SKELETON READY (blocked by ${v.gates.SKELETON_READY.blocked_by.join(', ')})`;
  }
  return 'DRAFT — NOT FROZEN';
}

export function buildScene(model, v) {
  const r = v.resolved;
  const prims = [], arrows = [], markers = [];
  const style = (role, unresolved) => (unresolved?.length ? 'unresolved' : role === 'REFERENCE' ? 'reference' : 'produced');

  for (const inst of r.instances) {
    const st = style(inst.role, inst.unresolved);
    const base = { part: inst.part, instance: inst.id, style: st, unresolved: inst.unresolved || [] };
    const [L, W, T] = inst.size;
    if (model.schema === 2 && (inst.kind === 'SHELL' || inst.d !== undefined)) {
      prims.push(...roundOrShell(inst, base, model.parts.find((p) => p.id === inst.part)));
      for (const f of inst.features) prims.push(...featurePrims(inst, f, style));
      continue;
    }
    const boxes = inst.kind === 'FRAME'
      ? [['bar+Y', [0, W / 2 - inst.bar / 2, 0], [L, inst.bar, T]], ['bar-Y', [0, -(W / 2 - inst.bar / 2), 0], [L, inst.bar, T]],
        ['bar+X', [L / 2 - inst.bar / 2, 0, 0], [inst.bar, W - 2 * inst.bar, T]], ['bar-X', [-(L / 2 - inst.bar / 2), 0, 0], [inst.bar, W - 2 * inst.bar, T]]]
      : [['body', [0, 0, 0], [L, W, T]]];
    for (const [sub_, c, s] of boxes) {
      const spring = inst.features.find((f) => f.type === 'SPRING' && sub_ === `bar${f.edge}` && f.run_axis === f.compliance_axis);
      if (spring) {
        const run = spring.edge.endsWith('X') ? 1 : 0;
        const gap = spring.size.length;
        const rigid = (s[run] - gap) / 2;
        if (rigid <= 0) throw new Error(`flexure ${spring.id}: span exceeds its rail`);
        for (const sign of [-1, 1]) {
          const cc = [...c], ss = [...s]; ss[run] = rigid; cc[run] = sign * (gap + rigid) / 2;
          prims.push({ id: `${inst.id}#${sub_}:${sign}`, shape: 'box', ...base, center: add(inst.origin, rotLocal(inst.axes, cc, inst.basis)), size: worldSize(inst.axes, ss) });
        }
      } else if (axisAligned(inst.axes)) prims.push({ id: `${inst.id}#${sub_}`, shape: 'box', ...base, center: add(inst.origin, rotLocal(inst.axes, c)), size: worldSize(inst.axes, s) });
      else prims.push({ id: `${inst.id}#${sub_}`, shape: 'box', ...base, center: add(inst.origin, rotLocal(inst.axes, c, inst.basis)), size: s, basis: inst.basis });
    }
    for (const f of inst.features) {
      const fst = style(inst.role, f.unresolved);
      const fb = { id: f.id, part: inst.part, instance: inst.id, style: fst, unresolved: f.unresolved || [] };
      if (f.type === 'EYE') {
        const a = AXES[f.bore_axis];
        prims.push({ ...fb, shape: 'ring', center: add(f.position, mul(a, f.size.depth / 2)), axis: f.bore_axis[1],
          inner_d: f.size.bore, outer_d: f.size.bore + 2, length: f.size.depth });
      } else if (f.type === 'TAB') {
        const d = AXES[f.direction];
        const sizeW = [0, 0, 0].map((_, k) => (Math.abs(d[k]) ? f.size.len : AXES[inst.axes.z][k] ? f.size.t : f.size.w));
        prims.push({ ...fb, shape: 'box', center: sub(f.position, mul(d, f.size.len / 2)), size: sizeW });
        arrows.push({ id: `${f.id}#dir`, from: f.position, dir: f.direction, length: 12, style: fst, label: f.direction });
      } else if (f.type === 'PIN') {
        const d = AXES[f.direction];
        prims.push({ ...fb, shape: 'cylinder', center: sub(f.position, mul(d, f.size.len / 2)), axis: f.direction[1], d: f.size.d, length: f.size.len });
        arrows.push({ id: `${f.id}#dir`, from: f.position, dir: f.direction, length: 10, style: fst, label: f.direction });
      } else if (f.type === 'LATTICE') {
        if (!String(f.pattern).startsWith('OPEN:')) prims.push(...latticePrims(inst, f, fb));
      } else if (f.type === 'HOLE') {
        prims.push(...featurePrims(inst, f, style));
      } else if (f.type === 'SPRING') {
        const run = f.compliance_axis === 'X' ? [1, 0, 0] : f.compliance_axis === 'Y' ? [0, 1, 0] : [0, 0, 1];
        const amp = model.schema === 2 ? (f.run_axis !== f.compliance_axis ? AXES['+' + f.run_axis] : rotLocal(inst.axes, f.edge?.endsWith('X') ? [1, 0, 0] : [0, 1, 0])) : f.compliance_axis === 'X' ? [0, 1, 0] : [1, 0, 0];
        const top = model.schema === 2 ? f.position : add(f.position, [0, 0, inst.size[2] / 2 + 0.5]);
        const n = 10, a = (inst.bar ?? 4) * 0.4;
        const points = Array.from({ length: n + 1 }, (_, k) =>
          add(add(top, mul(run, -f.size.length / 2 + (k * f.size.length) / n)), mul(amp, k === 0 || k === n ? 0 : (k % 2 ? a : -a))));
        prims.push({ ...fb, shape: 'zigzag', points });
        for (const s of [1, -1]) arrows.push({ id: `${f.id}#${s > 0 ? '+' : '-'}${f.compliance_axis}`, from: add(top, [0, 0, 4]),
          dir: `${s > 0 ? '+' : '-'}${f.compliance_axis}`, length: 14, style: fst, label: `compliance ±${f.compliance_axis}` });
      }
    }
  }

  const labels = [];
  if (model.schema === 2) mechanicsPrims(model, v, prims, arrows, labels);

  // one badge per OPEN (or STATED) question, placed on the first tagged element
  for (const q of model.questions || []) {
    if (q.status !== 'OPEN' && q.status !== 'STATED') continue;
    const tagged = prims.filter((p) => p.unresolved.includes(q.id));
    const anchor = tagged.find((p) => p.shape !== 'box' || !p.id.includes('#')) || tagged[0];
    const at = anchor ? add(anchor.center ?? anchor.points[0], [0, 0, 12 + 8 * markers.length]) : [0, 0, 0];
    markers.push({ question: q.id, text: q.text, about: q.about, at, elements: tagged.length, ...(q.status === 'STATED' ? { status: 'STATED' } : {}) });
  }

  return roundDeep({
    format: 'AI_CONCEPT_SCENE', concept: model.meta.id, revision: model.meta.revision, hash: model.freeze?.hash ?? null,
    maturity: v.state, banner: `${maturityLine(v)} · ${v.open.length} OPEN${v.open.length ? ` (${v.open.join(', ')})` : ''}${v.stated?.length ? ` · ${v.stated.length} STATED (${v.stated.join(', ')})` : ''}${v.placeholders?.length ? ` · ${v.placeholders.length} PLACEHOLDER` : ''}`,
    units: model.units, up: '+Z', primitives: prims, arrows, markers, ...(model.schema === 2 ? { labels } : {}),
  });
}

// ------------------------------------------------------------------ schema 2 (Core V2 §10)
const letter = (dir) => dir[1];
const mid = (a, b) => a.map((x, i) => (x + b[i]) / 2);

// Round parts are drawn round; a SHELL as its walls (the open side is missing).
function roundOrShell(inst, base, def) {
  if (inst.d !== undefined) {
    // a round part tilted off the world axes runs along its own local x (the basis)
    const along = inst.axis ? { axis: letter(inst.axis) } : { axis: null, dir: inst.basis.x };
    return [{ id: `${inst.id}#body`, shape: 'cylinder', ...base, center: inst.origin, ...along, d: inst.d, length: inst.size[0] }];
  }
  if (!axisAligned(inst.axes)) {
    // freely rotated SHELL: walls built in the part's own frame, drawn with its basis
    const s = inst.size;
    return Object.entries(AXES).filter(([k]) => k !== def?.open).map(([k, d]) => {
      const A = d.findIndex((x) => x !== 0);
      const size = [...s]; size[A] = inst.wall;
      return { id: `${inst.id}#wall${k}`, shape: 'box', ...base, center: add(inst.origin, rotLocal(inst.axes, mul(d, s[A] / 2 - inst.wall / 2), inst.basis)), size, basis: inst.basis };
    });
  }
  const ws = worldSize(inst.axes, inst.size);
  return Object.entries(AXES).filter(([k]) => k !== inst.open).map(([k, d]) => {
    const A = d.findIndex((x) => x !== 0);
    const size = [...ws]; size[A] = inst.wall;
    return { id: `${inst.id}#wall${k}`, shape: 'box', ...base, center: add(inst.origin, mul(d, ws[A] / 2 - inst.wall / 2)), size };
  });
}

function latticePrims(inst, f, base) {
  const bar = inst.bar || 0;
  const halfX = Math.max(0, inst.size[0] / 2 - bar);
  const halfY = Math.max(0, inst.size[1] / 2 - bar);
  if (!(halfX > 0 && halfY > 0)) return [];
  const gap = Math.max(3, Number(f.max_opening?.value || 10) * 0.8);
  const z = 0;
  const world = (p) => add(inst.origin, rotLocal(inst.axes, p));
  const lines = [];
  const addLine = (id, a, b) => lines.push({ ...base, id: `${f.id}#${id}`, shape: 'polyline', points: [world(a), world(b)] });

  if (f.pattern === 'DIAMOND') {
    let n = 0;
    for (let c = -halfX - halfY; c <= halfX + halfY + 1e-9; c += gap) {
      const pts = [];
      for (const x of [-halfX, halfX]) { const y = x - c; if (y >= -halfY && y <= halfY) pts.push([x, y, z]); }
      for (const y of [-halfY, halfY]) { const x = y + c; if (x >= -halfX && x <= halfX) pts.push([x, y, z]); }
      if (pts.length >= 2) addLine(`d1-${n++}`, pts[0], pts[1]);
    }
    n = 0;
    for (let c = -halfX - halfY; c <= halfX + halfY + 1e-9; c += gap) {
      const pts = [];
      for (const x of [-halfX, halfX]) { const y = -x + c; if (y >= -halfY && y <= halfY) pts.push([x, y, z]); }
      for (const y of [-halfY, halfY]) { const x = c - y; if (x >= -halfX && x <= halfX) pts.push([x, y, z]); }
      if (pts.length >= 2) addLine(`d2-${n++}`, pts[0], pts[1]);
    }
    return lines;
  }

  if (f.pattern === 'HONEYCOMB') {
    const r = Math.max(2, gap / 1.8);
    const dx = 1.5 * r, dy = Math.sqrt(3) * r;
    let n = 0;
    for (let x = -halfX - r; x <= halfX + r; x += dx) {
      const col = Math.round((x + halfX + r) / dx);
      for (let y = -halfY - r; y <= halfY + r; y += dy) {
        const cy = y + (col % 2 ? dy / 2 : 0);
        const pts = Array.from({ length: 6 }, (_, k) => {
          const a = Math.PI / 3 * k;
          return [x + r * Math.cos(a), cy + r * Math.sin(a), z];
        });
        for (let k = 0; k < 6; k++) {
          const a = pts[k], b = pts[(k + 1) % 6];
          if ([a,b].every((p) => p[0] >= -halfX && p[0] <= halfX && p[1] >= -halfY && p[1] <= halfY)) addLine(`h-${n++}`, a, b);
        }
      }
    }
  }
  return lines;
}

function featurePrims(inst, f, style) {
  if (f.type !== 'HOLE') return [];
  const st = style(inst.role, f.unresolved);
  const b = { id: f.id, part: inst.part, instance: inst.id, style: st, unresolved: f.unresolved || [], role: 'hole', hole: f.kind };
  const length = len(sub(f.to, f.from));
  if (f.profile === 'ROUND') return [{ ...b, shape: 'ring', center: mid(f.from, f.to), axis: letter(f.axis), inner_d: f.size.d, outer_d: f.size.d + 1.2, length }];
  const size = [0, 0, 0];
  size[AXES[f.axis].findIndex((x) => x !== 0)] = length;
  size[AXES[f.a_axis].findIndex((x) => x !== 0)] = f.size.a;
  size[AXES[f.b_axis].findIndex((x) => x !== 0)] = f.size.b;
  return [{ ...b, shape: 'box', outline: true, center: mid(f.from, f.to), size }];
}

// Interfaces, joint axes with their limits, fasteners and volumes, each with a text label.
function mechanicsPrims(model, v, prims, arrows, labels) {
  const r = v.resolved;
  const unresolved = new Set([...v.open, ...(v.stated || [])]);
  const tags = (id, extra = []) => [...new Set([...(model.questions || []).filter((q) => unresolved.has(q.id) && (q.about || []).includes(id)).map((q) => q.id), ...extra])];
  const st = (t) => (t.length ? 'unresolved' : 'produced');
  for (const i of model.interfaces || []) {
    const ref = `${i.part}.${i.id}`;
    const w = r.interfaces[ref];
    if (!w) continue;
    const t = tags(ref);
    if (w.type === 'AXIS') prims.push({ id: `${ref}#axis`, shape: 'polyline', role: 'interface', style: st(t), unresolved: t, points: [add(w.point, mul(AXES[w.dir], -10)), add(w.point, mul(AXES[w.dir], 10))] });
    else arrows.push({ id: `${ref}#normal`, from: w.point, dir: w.dir, length: 8, style: st(t), label: ref });
    labels.push({ id: ref, at: w.point, text: ref });
  }
  for (const j of model.joints || []) {
    const info = r.joints[j.id];
    if ('type' in j || !info) continue;
    const openInJoint = JSON.stringify(j).match(/OPEN:Q\w+/g)?.map((x) => x.slice(5)) || [];
    const t = tags(j.id, openInJoint.filter((q) => unresolved.has(q)));
    const text = `${j.id} ${String(j.motion).replace('OPEN:', '? ')}${info.limits && typeof info.limits === 'object' ? ` ${info.limits.min}…${info.limits.max}${info.limits.unit === 'deg' ? '°' : ' mm'}` : info.limits === 'NONE' ? ' continuous' : ''}`;
    if (!info.axis) { labels.push({ id: j.id, at: r.interfaces[j.links[0].parent]?.point ?? [0, 0, 0], text }); continue; }
    const c = info.axis.point, d = AXES[info.axis.dir];
    prims.push({ id: `${j.id}#axis`, shape: 'polyline', role: 'axis', style: st(t), unresolved: t, points: [add(c, mul(d, -25)), add(c, mul(d, 25))] });
    if (j.motion === 'REVOLUTE' && info.limits) {
      const u = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].find((a) => Math.abs(dot(a, d)) < 1e-9);   // angle zero: first world axis ⟂ the joint axis
      const w = cross(d, u);
      const [lo, hi] = info.limits === 'NONE' ? [0, 360] : [info.limits.min, info.limits.max];
      const arc = Array.from({ length: 25 }, (_, k) => { const a = ((lo + ((hi - lo) * k) / 24) * Math.PI) / 180; return add(c, add(mul(u, 15 * Math.cos(a)), mul(w, 15 * Math.sin(a)))); });
      prims.push({ id: `${j.id}#limits`, shape: 'polyline', role: 'limits', style: st(t), unresolved: t, points: info.limits === 'NONE' ? arc : [c, ...arc, c] });
    }
    if (j.motion === 'PRISMATIC' && info.limits && typeof info.limits === 'object') {
      prims.push({ id: `${j.id}#limits`, shape: 'polyline', role: 'limits', style: st(t), unresolved: t, points: [add(c, mul(d, info.limits.min)), add(c, mul(d, info.limits.max))] });
    }
    labels.push({ id: j.id, at: add(c, mul(d, 27)), text });
  }
  for (const f of model.fasteners || []) {
    const w = r.fasteners[f.id];
    if (!w) continue;
    const t = tags(f.id, JSON.stringify(f).match(/OPEN:Q\w+/g)?.map((x) => x.slice(5)).filter((q) => unresolved.has(q)) || []);
    prims.push({ id: f.id, shape: 'cylinder', role: 'fastener', style: st(t), unresolved: t, center: mid(w.axis_point, w.end_point),
      axis: letter(w.insert_dir), d: nominalDiameter(f.size) ?? 2, length: len(sub(w.end_point, w.axis_point)) });
    labels.push({ id: f.id, at: w.axis_point, text: `${f.id} ${f.size.replace('OPEN:', '? ')} ${f.kind.replace('OPEN:', '? ')}` });
  }
  for (const vol of model.volumes || []) {
    const w = r.volumes[vol.id];
    if (!w) continue;
    const t = tags(vol.id);
    const failed = Object.values(w.checks).includes('FAIL');
    prims.push({ id: vol.id, shape: 'box', role: 'volume', purpose: vol.purpose, check: failed ? 'FAIL' : 'PASS', style: st(t), unresolved: t,
      center: mid(w.box_min, w.box_max), size: sub(w.box_max, w.box_min) });
    labels.push({ id: vol.id, at: mid(w.box_min, w.box_max), text: `${vol.purpose.replace('_', ' ')} ${vol.id}${failed ? ' ✕' : ''}` });
  }
}


// Proposal overlay: what a pending (not accepted) proposal would change, as a
// separate layer. The accepted scene is never modified; every overlay item is
// tagged layer 'proposal' and style 'proposed' (new/changed) or 'removed'.
const GEOM = ['shape', 'center', 'size', 'points', 'axis', 'inner_d', 'outer_d', 'length', 'from', 'dir', 'd'];
const geomKey = (p) => JSON.stringify(GEOM.map((k) => p[k]));

export function buildProposalOverlay(acceptedScene, candidateScene) {
  const diff = (a, c) => {
    const byId = new Map(a.map((p) => [p.id, p]));
    const cIds = new Set(c.map((p) => p.id));
    const proposed = c.filter((p) => !byId.has(p.id) || geomKey(byId.get(p.id)) !== geomKey(p))
      .map((p) => ({ ...p, layer: 'proposal', style: 'proposed' }));
    const removed = a.filter((p) => !cIds.has(p.id) || proposed.some((q) => q.id === p.id))
      .map((p) => ({ ...p, layer: 'proposal', style: 'removed' }));
    return [...proposed, ...removed];
  };
  const oldQ = new Set(acceptedScene.markers.map((m) => m.question));
  return {
    layer: 'proposal',
    primitives: diff(acceptedScene.primitives, candidateScene.primitives),
    arrows: diff(acceptedScene.arrows, candidateScene.arrows),
    markers: candidateScene.markers.filter((m) => !oldQ.has(m.question)).map((m) => ({ ...m, layer: 'proposal', style: 'proposed' })),
  };
}

// ZOOM TO CHANGE (inspection only). Axis-aligned bounds of scene items,
// derived only from the given scenes; nothing is mutated.
const DIRV = { '+X': [1, 0, 0], '-X': [-1, 0, 0], '+Y': [0, 1, 0], '-Y': [0, -1, 0], '+Z': [0, 0, 1], '-Z': [0, 0, -1] };
function itemPoints(p) {
  if (p.shape === 'box') return [0, 1].flatMap((i) => [0, 1].flatMap((j) => [0, 1].map((k) =>
    [p.center[0] + (i ? 1 : -1) * p.size[0] / 2, p.center[1] + (j ? 1 : -1) * p.size[1] / 2, p.center[2] + (k ? 1 : -1) * p.size[2] / 2])));
  if (p.shape === 'ring') { const r = Math.max(p.outer_d / 2, p.length / 2); return [p.center.map((c) => c - r), p.center.map((c) => c + r)]; }
  if (p.shape === 'zigzag' || p.shape === 'polyline') return p.points;
  if (p.shape === 'cylinder') { const r = Math.max(p.d, p.length) / 2; return [p.center.map((c) => c - r), p.center.map((c) => c + r)]; }
  if (p.from && p.dir) return [p.from, p.from.map((c, i) => c + DIRV[p.dir][i] * p.length)];
  if (p.at) return [p.at];
  return [];
}

export function posePoint(pose, x) {
  return pose.r.map((row, i) => row.reduce((sum, a, k) => sum + a * x[k], pose.t[i]));
}

export function boundsOf(items) {
  const pts = items.flatMap((p) => {
    let points = itemPoints(p);
    if (p.pose && ['ring', 'cylinder'].includes(p.shape)) {
      const [a,b] = points;
      points = [0,1].flatMap(i => [0,1].flatMap(j => [0,1].map(k => [i?b[0]:a[0],j?b[1]:a[1],k?b[2]:a[2]])));
    }
    return points.map(x => p.pose ? posePoint(p.pose, x) : x);
  });
  if (!pts.length) return null;
  const min = [0, 1, 2].map((i) => Math.min(...pts.map((p) => p[i])));
  const max = [0, 1, 2].map((i) => Math.max(...pts.map((p) => p[i])));
  const center = min.map((v, i) => (v + max[i]) / 2);
  const size = max.map((v, i) => v - min[i]);
  return roundDeep({ min, max, center, size, radius: Math.hypot(...size) / 2 });
}

export const sceneBounds = (scene) => boundsOf([...scene.primitives, ...scene.arrows]);

// Frame the proposal: its own items, grown by `context` mm on every side and to
// at least `minSize` mm, so surrounding accepted geometry stays visible.
export function zoomBounds(overlay, { context = 30, minSize = 70 } = {}) {
  const b = overlay ? boundsOf([...overlay.primitives, ...overlay.arrows, ...overlay.markers]) : null;
  if (!b) return null;
  const size = b.size.map((s) => Math.max(s + 2 * context, minSize));
  const min = b.center.map((c, i) => c - size[i] / 2);
  const max = b.center.map((c, i) => c + size[i] / 2);
  return roundDeep({ min, max, center: b.center, size, radius: Math.hypot(...size) / 2 });
}

// Zoom targets: "all changes" first, then one per changed element group
// (instance/pattern suffixes folded, removed + proposed state together).
export function zoomTargets(overlay, opts) {
  if (!overlay) return [];
  const all = zoomBounds(overlay, opts);
  if (!all) return [];
  const groups = new Map();
  for (const p of [...overlay.primitives, ...overlay.arrows]) {
    const key = p.id.split('#')[0].replace(/\[\d+\]$/, '').replace(/@\d+/, '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  const targets = [{ key: 'ALL', label: 'All changes', bounds: all }];
  if (groups.size > 1) {
    for (const [key, items] of groups) targets.push({ key, label: key, bounds: zoomBounds({ primitives: items, arrows: [], markers: [] }, opts) });
  }
  return targets;
}
