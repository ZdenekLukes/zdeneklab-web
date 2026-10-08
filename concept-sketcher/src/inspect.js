// INSPECT (read-only): the dimensions of one model entity, for a person.
// Every value is taken deterministically from a model and its validation
// (resolved numbers + the parameter each number came from). Nothing here
// mutates a model, and nothing here is read by validate, export or the hash.
//
// Entity keys: PART · PART.FEATURE (mirror pairs fold onto the mirrored
// feature) · JOINT · FASTENER · VOLUME · PART.INTERFACE.

import { featureDefs } from './resolve.js?v=d776a80047f5';

const PARAM_REF = /^=([A-Za-z_][A-Za-z0-9_]*)$/;
const OPEN_REF = /^OPEN:(Q\w+)$/;

// 4 -> "4.0", 3.6 -> "3.6", 295 -> "295", 0.4000000001 -> "0.4"
export function fmtNum(n) {
  const r = Math.round(n * 1000) / 1000;
  if (Object.is(r, -0)) return '0.0';
  return Number.isInteger(r) && Math.abs(r) < 10 ? r.toFixed(1) : String(r);
}
const mm = (n) => `${fmtNum(n)} mm`;
const plain = (n) => String(Math.round(n * 1000) / 1000);        // inside "a × b × c" triples
const openText = (x) => (typeof x === 'string' && OPEN_REF.test(x) ? `OPEN (${x.slice(5)})` : x);

function safeDefs(model) {
  try { return featureDefs(model); } catch { return {}; }
}

// The parameter behind a raw model value ("=pin_d"), with its status.
function source(model, raw) {
  if (typeof raw !== 'string') return raw === undefined ? null : { status: 'stated' };
  const m = raw.match(PARAM_REF);
  if (m) return { param: m[1], status: model.params?.[m[1]]?.status ?? 'unknown' };
  if (raw.startsWith('=')) return { status: 'derived', expr: raw.slice(1) };
  return null;
}

function row(id, label, value, { unit, src, text } = {}) {
  const shown = text ?? (typeof value === 'number' && unit === 'mm' ? mm(value) : value === undefined || value === null ? '—' : String(openText(value)));
  return { id, label, value: value ?? null, ...(unit ? { unit } : {}), text: shown, status: src?.status ?? null, ...(src?.param ? { param: src.param } : {}) };
}

// ---------------------------------------------------------------- entities

// The mirror root of a feature (PIN_L -> PIN_R), and the whole mirror group.
function mirrorRoot(defs, id) {
  let cur = id;
  const seen = new Set();
  while (defs[cur]?.mirror?.of && !seen.has(cur)) { seen.add(cur); cur = defs[cur].mirror.of; }
  return cur;
}
function mirrorGroup(defs, root) {
  return Object.keys(defs).filter((id) => mirrorRoot(defs, id) === root).sort((a, b) => (a === root ? -1 : b === root ? 1 : a.localeCompare(b)));
}

export function referenceParts(model) {
  return (model.parts || []).filter((p) => p.role === 'REFERENCE').map((p) => p.id).sort();
}

// Every inspectable entity of a model, in a stable order.
export function entities(model) {
  const defs = safeDefs(model);
  const out = [];
  for (const p of model.parts || []) out.push({ key: p.id, kind: 'part', label: `${p.id}${p.role === 'REFERENCE' ? ' (reference)' : p.role === 'PURCHASED' ? ' (purchased)' : ''}` });
  const roots = [...new Set(Object.keys(defs).map((id) => mirrorRoot(defs, id)))];
  for (const id of roots) {
    const host = defs[id]?.host;
    if (!host) continue;
    out.push({ key: `${host}.${id}`, kind: 'feature', label: `${host} · ${mirrorGroup(defs, id).join(' / ')}` });
  }
  for (const j of model.joints || []) out.push({ key: j.id, kind: 'joint', label: `${j.id} (joint)` });
  for (const f of model.fasteners || []) out.push({ key: f.id, kind: 'fastener', label: `${f.id} (fastener)` });
  for (const vol of model.volumes || []) out.push({ key: vol.id, kind: 'volume', label: `${vol.id} (volume)` });
  for (const i of model.interfaces || []) out.push({ key: `${i.part}.${i.id}`, kind: 'interface', label: `${i.part}.${i.id} (interface)` });
  return out;
}

// Scene item id ("DIVIDER@2.PIN_L#dir", "BASE.EYE_A[3]", "SEAT#axis") -> entity key.
export function entityOf(itemId, model) {
  const base = String(itemId).split('#')[0];
  const [head, ...rest] = base.split('.');
  const part = head.replace(/@\d+$/, '');
  if (!rest.length) {
    const known = (c) => (model[c] || []).some((x) => x.id === part);
    return ['parts', 'joints', 'fasteners', 'volumes'].some(known) ? part : null;
  }
  const sub = rest.join('.').replace(/\[\d+\]$/, '');
  if ((model.interfaces || []).some((i) => i.part === part && i.id === sub)) return `${part}.${sub}`;
  const defs = safeDefs(model);
  if (defs[sub]?.host === part) return `${part}.${mirrorRoot(defs, sub)}`;
  return (model.parts || []).some((p) => p.id === part) ? part : null;
}

// ---------------------------------------------------------------- resolved lookups

const instancesOf = (v, part) => (v.resolved?.instances || []).filter((i) => i.part === part);
function resolvedFeatures(v, host, fid) {
  const inst = instancesOf(v, host)[0];
  if (!inst) return [];
  const id = `${inst.id}.${fid}`;
  return inst.features.filter((f) => f.id === id || f.id.startsWith(`${id}[`));
}
const featureRef = (ref) => { const [part, f] = String(ref).split('.'); return { part, feature: f?.replace(/\[[a-z]\]$/, '') }; };

// The single round size of a feature (pin Ø, eye bore, round hole Ø), with its source.
function roundSize(model, v, defs, host, fid) {
  const d = defs[fid];
  const rf = resolvedFeatures(v, host, fid)[0];
  if (!d || !rf) return null;
  if (d.type === 'PIN') return { value: rf.size?.d, src: source(model, d.size?.d), what: 'Pin diameter' };
  if (d.type === 'EYE') return { value: rf.size?.bore, src: source(model, d.size?.bore), what: 'Eye bore' };
  if (d.type === 'HOLE' && rf.profile === 'ROUND') return { value: rf.size?.d, src: source(model, d.size?.d), what: 'Hole Ø' };
  return null;
}

// Pin-into-eye mating: the other side of every INSERTS_INTO link touching the group,
// and the diametral clearance when it is unambiguous (one value on each side).
function matingRows(model, v, defs, host, group) {
  const rows = [];
  for (const j of model.joints || []) {
    if (j.type !== 'INSERTS_INTO') continue;
    const pairs = [];
    for (const l of j.links || []) {
      const m = featureRef(l.male), f = featureRef(l.female);
      if (m.part === host && group.includes(m.feature)) pairs.push({ self: m, other: f, selfIsMale: true });
      else if (f.part === host && group.includes(f.feature)) pairs.push({ self: f, other: m, selfIsMale: false });
    }
    if (!pairs.length) continue;
    const others = [...new Set(pairs.map((p) => `${p.other.part}.${p.other.feature}`))];
    rows.push(row('mates', 'Mates with', others.join(' / '), { text: `${others.join(' / ')} · ${j.id} (INSERTS_INTO)` }));
    const sizes = pairs.map((p) => ({ self: roundSize(model, v, defs, p.self.part, p.self.feature), other: roundSize(model, v, defs, p.other.part, p.other.feature), male: p.selfIsMale }));
    const otherVals = [...new Set(sizes.map((s) => s.other?.value))];
    const selfVals = [...new Set(sizes.map((s) => s.self?.value))];
    const s0 = sizes[0];
    if (s0.other && otherVals.length === 1 && typeof otherVals[0] === 'number') {
      rows.push(row('mate_size', s0.other.what, otherVals[0], { unit: 'mm', src: s0.other.src }));
    }
    if (s0.self && s0.other && selfVals.length === 1 && otherVals.length === 1 && typeof selfVals[0] === 'number' && typeof otherVals[0] === 'number') {
      const [shaft, bore] = s0.male ? [selfVals[0], otherVals[0]] : [otherVals[0], selfVals[0]];
      const c = Math.round((bore - shaft) * 1000) / 1000;
      rows.push(row('clearance', 'Diametral clearance', c, { unit: 'mm', text: c < 0 ? `${mm(c)} (interference)` : mm(c) }));
    } else if (s0.self && s0.other) {
      rows.push(row('clearance', 'Diametral clearance', null, { text: 'not derivable (sizes differ between links)' }));
    }
    rows.push(row('fit', 'Fit', j.fit ?? null));
  }
  return rows;
}

// ---------------------------------------------------------------- per kind

function partRows(model, v, p) {
  const inst = instancesOf(v, p.id);
  const rows = [row('role', 'Role', p.role, { text: p.role === 'REFERENCE' ? 'REFERENCE — context only, not printed' : p.role === 'PURCHASED' ? 'PURCHASED — assembly item, not generated for printing' : p.role })];
  rows.push(row('kind', 'Kind', p.kind));
  if (inst[0]) {
    const s = inst[0].size;
    const srcs = (Array.isArray(p.size) ? p.size : []).map((x) => source(model, x)).filter((x) => x?.param && x.status !== 'fixed');
    const status = srcs.length ? srcs.map((x) => `${x.param} ${x.status}`).join(', ') : null;
    if (inst[0].d !== undefined) rows.push(row('size', 'Size', `Ø${plain(inst[0].d)} × ${plain(s[0])}`, { text: `Ø${fmtNum(inst[0].d)} × ${mm(s[0])}` }));
    else rows.push({ ...row('size', 'Size', s.map(plain).join(' × '), { text: `${s.map(plain).join(' × ')} mm` }), status });
  }
  if (p.bar !== undefined) rows.push(row('bar', 'Frame bar', inst[0]?.bar ?? null, { unit: 'mm', src: source(model, p.bar) }));
  if (p.wall !== undefined) rows.push(row('wall', 'Wall', inst[0]?.wall ?? null, { unit: 'mm', src: source(model, p.wall) }));
  if (p.manufacturing) rows.push(row('process', 'Process', [p.manufacturing.process, p.manufacturing.supports && `supports ${p.manufacturing.supports}`].filter(Boolean).join(' · ')));
  if (p.production) rows.push(row('quantity', 'Quantity', `${p.production.default_quantity ?? 1}${p.production.repeatable ? ' (repeatable)' : ''}`));
  if (inst.length > 1 || inst[0]?.id !== p.id) rows.push(row('instances', 'Shown as', inst.map((i) => i.id).join(', ') || '—'));
  return rows;
}

function featureRows(model, v, defs, host, root) {
  const group = mirrorGroup(defs, root);
  const d = defs[root];
  const rf = resolvedFeatures(v, host, root);
  const f = rf[0];
  const rows = [row('type', 'Type', d.type ?? '—')];
  const dirs = group.map((id) => resolvedFeatures(v, host, id)[0]).map((x) => x?.direction ?? x?.bore_axis ?? x?.axis).filter(Boolean);
  if (d.type === 'PIN' && f) {
    rows.push(row('d', 'Diameter', f.size.d, { unit: 'mm', src: source(model, d.size?.d) }));
    rows.push(row('len', 'Length', f.size.len, { unit: 'mm', src: source(model, d.size?.len) }));
  } else if (d.type === 'EYE' && f) {
    rows.push(row('bore', 'Bore', f.size.bore, { unit: 'mm', src: source(model, d.size?.bore) }));
    rows.push(row('depth', 'Depth', f.size.depth, { unit: 'mm', src: source(model, d.size?.depth) }));
    if (d.array) {
      rows.push(row('count', 'Count', rf.length * group.length, { text: group.length > 1 ? `${rf.length} × ${group.length} (${group.join(' / ')})` : String(rf.length) }));
      rows.push(row('pitch', 'Pitch', v.resolved.params?.[d.array.pitch?.match?.(PARAM_REF)?.[1]] ?? d.array.pitch, { unit: 'mm', src: source(model, d.array.pitch) }));
      rows.push(row('margin', 'Margin', v.resolved.params?.[d.array.margin?.match?.(PARAM_REF)?.[1]] ?? d.array.margin, { unit: 'mm', src: source(model, d.array.margin) }));
    }
  } else if (d.type === 'TAB' && f) {
    for (const k of ['len', 'w', 't']) if (f.size?.[k] !== undefined) rows.push(row(k, { len: 'Length', w: 'Width', t: 'Thickness' }[k], f.size[k], { unit: 'mm', src: source(model, d.size?.[k]) }));
  } else if (d.type === 'LATTICE') {
    rows.push(row('pattern', 'Pattern', d.pattern));
    const mo = d.max_opening;
    if (mo) {
      const val = v.resolved.params?.[String(mo.value).match(PARAM_REF)?.[1]] ?? mo.value;
      rows.push(row('max_opening', 'Max opening', val, { text: `${{ LT: '<', LE: '≤', GT: '>', GE: '≥', EQ: '=' }[mo.op] ?? mo.op} ${typeof val === 'number' ? mm(val) : val}`, src: source(model, mo.value) }));
    }
    if (d.rib !== undefined) rows.push(row('rib', 'Rib', v.resolved.params?.[String(d.rib).match(PARAM_REF)?.[1]] ?? d.rib, { unit: 'mm', src: source(model, d.rib) }));
  } else if (d.type === 'SPRING' && f) {
    if (d.travel !== undefined) rows.push(row('travel', 'Travel', v.resolved.params?.[String(d.travel).match(PARAM_REF)?.[1]] ?? d.travel, { unit: 'mm', src: source(model, d.travel) }));
    if (f.size?.length !== undefined) rows.push(row('span', 'Span', f.size.length, { unit: 'mm', text: `${mm(f.size.length)}${d.span?.length ? ` (${d.span.length} of edge)` : ''}` }));
    rows.push(row('compliance', 'Compliance', f.compliance_axis ? `±${f.compliance_axis}` : d.compliance ?? '—'));
  } else if (d.type === 'HOLE' && f) {
    rows.push(row('kind', 'Kind', f.kind ?? d.kind));
    if (f.profile === 'ROUND') rows.push(row('d', 'Diameter', f.size.d, { unit: 'mm', src: source(model, d.size?.d) }));
    else rows.push(row('ab', 'Opening', `${plain(f.size.a)} × ${plain(f.size.b)}`, { text: `${plain(f.size.a)} × ${plain(f.size.b)} mm` }));
    if (f.from && f.to) rows.push(row('depth', 'Depth', Math.hypot(...f.to.map((x, i) => x - f.from[i])), { unit: 'mm' }));
  }
  if (dirs.length && d.type !== 'LATTICE' && d.type !== 'SPRING') rows.push(row('dir', 'Direction', dirs.join(' / ')));
  return [...rows, ...matingRows(model, v, defs, host, group)];
}

function jointRows(model, v, j) {
  if (j.type === 'INSERTS_INTO') {
    const info = v.resolved?.joints?.[j.id];
    return [
      row('type', 'Type', 'INSERTS_INTO'),
      row('links', 'Links', (j.links || []).map((l) => `${l.male} → ${l.female}`).join('; ')),
      row('engage', 'Engagement', info?.engage ?? null, { unit: 'mm', src: source(model, j.engage) }),
      row('fit', 'Fit', j.fit ?? null),
      row('dof', 'DOF', j.dof ?? null),
      row('anti_rotation', 'Anti-rotation', j.anti_rotation ?? null),
      row('assembly_motion', 'Assembly', j.assembly_motion ?? null),
      ...(info?.indices ? [row('indices', 'Shown at index', info.indices.join(', '))] : []),
    ];
  }
  const info = v.resolved?.joints?.[j.id];
  const lim = info?.limits && typeof info.limits === 'object' ? `${fmtNum(info.limits.min)} … ${fmtNum(info.limits.max)}${info.limits.unit === 'deg' ? '°' : ' mm'}` : info?.limits === 'NONE' ? 'continuous' : null;
  return [
    row('motion', 'Motion', j.motion ?? null),
    row('links', 'Links', (j.links || []).map((l) => `${l.child} → ${l.parent}`).join('; ')),
    row('method', 'Method', j.method ?? null),
    row('fit', 'Fit', j.fit ?? null),
    ...(lim || j.limits !== undefined ? [row('limits', 'Limits', lim ?? j.limits)] : []),
    ...(j.assembly ? [row('assembly', 'Assembly', `${openText(j.assembly.direction)} · removable ${openText(j.assembly.removable)}`)] : []),
  ];
}

// ---------------------------------------------------------------- public

export function inspect(model, v, key) {
  if (!key) return null;
  const defs = safeDefs(model);
  const part = (model.parts || []).find((p) => p.id === key);
  if (part) return { key, kind: 'part', title: key, role: part.role, rows: partRows(model, v, part) };
  const joint = (model.joints || []).find((j) => j.id === key);
  if (joint) return { key, kind: 'joint', title: `${key} (joint)`, role: null, rows: jointRows(model, v, joint) };
  const fast = (model.fasteners || []).find((f) => f.id === key);
  if (fast) return { key, kind: 'fastener', title: `${key} (fastener)`, role: null, rows: [row('kind', 'Kind', fast.kind), row('size', 'Size', fast.size), row('joint', 'Joint', fast.joint), row('through', 'Through', (fast.through || []).join(', '))] };
  const vol = (model.volumes || []).find((x) => x.id === key);
  if (vol) {
    const w = v.resolved?.volumes?.[key];
    const size = w ? w.box_max.map((x, i) => x - w.box_min[i]) : null;
    return { key, kind: 'volume', title: `${key} (volume)`, role: null, rows: [row('purpose', 'Purpose', vol.purpose), ...(size ? [row('size', 'Size', size.map(plain).join(' × '), { text: `${size.map(plain).join(' × ')} mm` })] : []), ...(w ? [row('check', 'Check', Object.values(w.checks).includes('FAIL') ? 'FAIL' : 'PASS')] : [])] };
  }
  const [host, sub] = key.split('.');
  const iface = (model.interfaces || []).find((i) => i.part === host && i.id === sub);
  if (iface) return { key, kind: 'interface', title: key, role: null, rows: [row('type', 'Type', iface.type), row('dir', 'Direction', iface.dir ?? null)] };
  if (sub && defs[sub]?.host === host) {
    const root = mirrorRoot(defs, sub);
    const hostPart = (model.parts || []).find((p) => p.id === host);
    return { key: `${host}.${root}`, kind: 'feature', title: `${host} · ${mirrorGroup(defs, root).join(' / ')}`, role: hostPart?.role ?? null, rows: featureRows(model, v, defs, host, root) };
  }
  return null;
}

// NOW -> PROPOSED for one entity: rows of both sides paired by row id.
export function inspectChange(accepted, vA, candidate, vC, key) {
  const a = inspect(accepted, vA, key);
  const c = inspect(candidate, vC, key);
  if (!a && !c) return null;
  const ids = [...new Set([...(a?.rows || []).map((r) => r.id), ...(c?.rows || []).map((r) => r.id)])];
  const pick = (x, id) => x?.rows.find((r) => r.id === id) ?? null;
  const rows = ids.map((id) => {
    const now = pick(a, id), proposed = pick(c, id);
    const changed = !now || !proposed || now.text !== proposed.text || now.status !== proposed.status;
    return { id, label: (proposed ?? now).label, now, proposed, changed };
  });
  return { key: (c ?? a).key, kind: (c ?? a).kind, title: (c ?? a).title, role: (c ?? a).role, state: !a ? 'ADDED' : !c ? 'REMOVED' : rows.some((r) => r.changed) ? 'CHANGED' : 'SAME', rows };
}

// The entities whose inspected dimensions differ between two models.
export function changedEntities(accepted, vA, candidate, vC) {
  const keys = [...new Set([...entities(accepted), ...entities(candidate)].map((e) => e.key))];
  return keys.filter((k) => inspectChange(accepted, vA, candidate, vC, k)?.state !== 'SAME');
}
