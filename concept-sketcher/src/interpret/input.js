// The interpreter input package (S2 design §4). Everything is derived deterministically
// from the accepted model, the pending proposal and the last utterances. It carries no
// evaluation data of any kind: the builder never sees a corpus case.

import { validate } from '../validate.js?v=cefb80df528e';
import { openSlots } from '../schema.js?v=cefb80df528e';
import { manifest } from '../capabilities.js?v=cefb80df528e';
import { RESPONSE_PROTOCOL, DISPOSITIONS, OP_REQUIRED } from './protocol.js?v=cefb80df528e';
import { POLICY, POLICY_VERSION } from './policy.js?v=cefb80df528e';

const AXES = { '+X': [1, 0, 0], '-X': [-1, 0, 0], '+Y': [0, 1, 0], '-Y': [0, -1, 0], '+Z': [0, 0, 1], '-Z': [0, 0, -1] };
const r6 = (v) => v.map((x) => Math.round(x * 1e6) / 1e6 + 0);
const nameOf = (v) => Object.keys(AXES).find((k) => AXES[k].every((c, i) => Math.abs(c - v[i]) < 1e-9));

// Every interface a proposal may name, declared and implicit, with its world pose.
function interfacesOf(model, r) {
  const out = [];
  for (const inst of r.instances) {
    if (r.instances.filter((i) => i.part === inst.part).length !== 1) continue;           // indexed instances are addressed through their joint
    const world = (k) => AXES[inst.axes[k]];
    const toWorld = (local) => r6(inst.origin.map((o, i) => o + ['x', 'y', 'z'].reduce((s, k, j) => s + world(k)[i] * local[j], 0)));
    const dirWorld = (local) => nameOf(['x', 'y', 'z'].reduce((s, k, j) => s.map((c, i) => c + world(k)[i] * local[j]), [0, 0, 0]));
    const round = inst.d !== undefined;
    for (const [k, d] of Object.entries(AXES)) {
      const A = d.findIndex((x) => x !== 0);
      if (round && A !== 0) continue;
      const [ia, ib] = [0, 1, 2].filter((x) => x !== A);
      const unit = (x) => [0, 1, 2].map((y) => (y === x ? 1 : 0));
      out.push({ ref: `${inst.part}.${k}`, type: 'FACE', point: toWorld(d.map((x) => x * inst.size[A] / 2)), dir: dirWorld(d), a: dirWorld(unit(ia)), b: dirWorld(unit(ib)) });
      if (inst.kind === 'SHELL' && dirWorld(d) !== inst.open) out.push({ ref: `${inst.part}.INNER${k}`, type: 'FACE', point: toWorld(d.map((x) => x * (inst.size[A] / 2 - inst.wall))), dir: dirWorld(d.map((x) => -x)) });
    }
    if (round) out.push({ ref: `${inst.part}.AXIS`, type: 'AXIS', point: inst.origin, dir: inst.axis });
    for (const f of inst.features) {
      if (f.type === 'TAB') out.push({ ref: f.id, type: 'AXIS', point: f.position, dir: f.direction, port: 'TAB' });
      if (f.type === 'EYE') out.push({ ref: f.id, type: 'AXIS', point: f.position, dir: f.bore_axis, port: 'EYE' });
      if (f.type === 'HOLE') out.push({ ref: f.id, type: 'AXIS', point: f.position, dir: f.axis, port: `HOLE ${f.kind}` });
    }
  }
  for (const [ref, w] of Object.entries(r.interfaces || {})) if (!out.some((x) => x.ref === ref)) out.push({ ref, type: w.type, point: w.point, dir: w.dir, declared: true });
  return out;
}

// A compact, deterministic digest for reference resolution ("the upper half", "the tube axis").
export function digest(model) {
  const v = validate(model);
  const r = v.resolved;
  if (!r) return { errors: v.errors };
  const slots = openSlots(model);
  return {
    parts: r.instances.map((i) => ({ id: i.id, kind: i.kind, role: i.role, centre: i.origin, size: i.size,
      ...(i.d !== undefined ? { round: { d: i.d, axis: i.axis } } : {}), ...(i.wall !== undefined ? { shell: { wall: i.wall, open: i.open } } : {}),
      intent: (model.parts || []).find((p) => p.id === i.part)?.intent })),
    interfaces: interfacesOf(model, r),
    joints: (model.joints || []).map((j) => ({ id: j.id, part: j.part, ...(j.type ? { type: j.type } : { motion: j.motion }), parent: r.joints[j.id]?.parent,
      axis: r.joints[j.id]?.axis, limits: j.limits, method: j.method, fit: j.fit, assembly: j.assembly })),
    fasteners: Object.entries(r.fasteners || {}).map(([id, f]) => ({ id, kind: f.kind, size: f.size, joint: f.joint, axis_point: f.axis_point, insert_dir: f.insert_dir })),
    volumes: Object.entries(r.volumes || {}).map(([id, w]) => ({ id, purpose: w.purpose, for: w.for, dir: w.dir, checks: w.checks })),
    questions: (model.questions || []).map((q) => ({ id: q.id, status: q.status, text: q.text, about: q.about,
      slots: slots.filter((s) => s.q === q.id).map((s) => s.path), ...(q.facts ? { facts: q.facts } : {}) })),
    placeholders: v.placeholders || [],
    skeleton_ready: v.gates.SKELETON_READY,
  };
}

const authoring = (model) => { const { history, resolved, ...m } = model; return m; };

// turns: [{ id, text, outcome }] most recent last (≤ 6 are kept); pending: an unaccepted proposal or null.
export function buildInput({ model, utterance, turns = [], pending = null, selection = [] }) {
  if (model.schema !== 2) throw new Error('the S2 interpreter works on schema-2 concepts only');
  return {
    protocol: RESPONSE_PROTOCOL,
    policy_version: POLICY_VERSION,
    policy: POLICY,
    capabilities: manifest(),
    response_format: {
      keys: ['protocol', 'version', 'utterance_id', 'understood', 'ledger', 'proposal', 'clarification', 'reply'],
      ledger_entry: { id: 'L<n>', u: 'utterance id', quote: 'exact words', disposition: DISPOSITIONS, ops: 'op numbers (1-based)', ref: 'resolved entity id (optional)' },
      proposal: '{ summary, ops } or null — ops from capabilities.ops; op.evidence names ledger ids ({field: "L<n>"} per fact)',
      op_keys: OP_REQUIRED,
      clarification: '{ question (one), about: [entity ids], ledger: [CLARIFY ledger ids], options: [examples] } or null',
    },
    model: authoring(model),
    derived: digest(model),
    pending,
    turns: turns.slice(-6).map((t) => ({ id: t.id, text: t.text, ...(t.outcome ? { outcome: t.outcome } : {}) })),
    selection,
    utterance: { id: utterance.id, text: utterance.text, lang: utterance.lang ?? null, source: utterance.source ?? 'text' },
  };
}
