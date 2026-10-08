// validate(model) -> { errors, warnings, open, rules, gates, resolved }.
// ERROR blocks CONCEPT_FROZEN. OPEN questions with blocks: SKELETON_READY block
// SKELETON_READY. Nothing is ever defaulted: a missing answer is an ERROR.
// `schema: 1` is frozen legacy. `schema: 2` (Core V2 safety core) is strict:
// closed schema (src/schema.js), answers bound to structured facts, and
// STATED answers (words the language cannot hold) keep blocking SKELETON_READY.

import { motionDefinitionErrors } from './motion.js?v=d776a80047f5';
import { conceptHash, legacyConceptHashV1 } from './model.js?v=d776a80047f5';
import { resolve, featureDefs } from './resolve.js?v=d776a80047f5';
import { checkModel, openSlots, isFactField, isOpen, COLLECTIONS, METHODS, PART_ROLES } from './schema.js?v=d776a80047f5';

const PART_KINDS = ['BLOCK', 'PLATE', 'FRAME', 'ROD', 'CYLINDER', 'ENVELOPE'];
const STATES = ['DRAFT', 'CONCEPT_FROZEN', 'SKELETON_READY'];
// Fit is a mechanical fact (never defaulted): one of these, or OPEN:Qn.
export const FITS = ['LOOSE', 'CLEARANCE', 'SLIDING', 'SNUG', 'PRESS'];

export function validate(model, opts = {}) {
  const errors = [], warnings = [];
  const v2 = model.schema === 2;
  if (v2) {
    const closed = checkModel(model);
    if (closed.length) return structuralFailure(model, closed);
  } else {
    if (model.format !== 'AI_CONCEPT') errors.push('format must be "AI_CONCEPT"');
    if (model.schema !== 1) errors.push('schema must be 1 or 2');
  }

  const partIds = new Set((model.parts || []).map((p) => p.id));
  const featureIds = new Set((model.features || []).map((f) => f.id));
  const jointIds = new Set((model.joints || []).map((j) => j.id));
  const questions = Object.fromEntries((model.questions || []).map((q) => [q.id, q]));
  const allIds = [...(model.parts || []), ...(model.features || []), ...(model.joints || []),
    ...(model.rules || []), ...(model.questions || []), ...(model.interfaces || []), ...(model.fasteners || []), ...(model.volumes || [])].map((x) => x.id);
  for (const id of new Set(allIds.filter((id, i) => allIds.indexOf(id) !== i))) errors.push(`duplicate id "${id}"`);

  for (const p of model.parts || []) {
    if (!v2 && !PART_KINDS.includes(p.kind)) errors.push(`part ${p.id}: unknown kind "${p.kind}"`);
    const roles = v2 ? PART_ROLES : ['PRODUCED', 'REFERENCE'];
    if (!roles.includes(p.role)) errors.push(`part ${p.id}: role must be ${roles.join(' or ')}`);
  }
  let defs = {};
  try { defs = featureDefs(model); } catch (e) { errors.push(e.message); }
  for (const d of Object.values(defs)) {
    if (!partIds.has(d.host)) errors.push(`feature ${d.id}: unknown host "${d.host}"`);
  }
  const ids2 = (coll) => new Set((v2 ? model[coll] || [] : []).map((x) => x.id));
  const fastenerIds = ids2('fasteners'), volumeIds = ids2('volumes');
  const knownRef = (ref) => {
    const m = /^([A-Z0-9_]+)(?:\.([A-Z0-9_]+))?$/.exec(ref);
    if (!m) return false;
    if (!m[2]) return partIds.has(m[1]) || jointIds.has(m[1]) || fastenerIds.has(m[1]) || volumeIds.has(m[1]);
    return partIds.has(m[1]) && (defs[m[2]]?.host === m[1] || (v2 && (model.interfaces || []).some((i) => i.id === m[2] && i.part === m[1])));
  };

  // questions
  for (const q of model.questions || []) {
    if (v2) errors.push(...questionErrorsV2(model, q));
    else {
      if (!['OPEN', 'ANSWERED'].includes(q.status)) errors.push(`question ${q.id}: status must be OPEN or ANSWERED`);
      if (q.status === 'ANSWERED' && !(typeof q.answer === 'string' && q.answer.trim())) errors.push(`question ${q.id}: ANSWERED without an answer`);
      if (q.status === 'OPEN' && q.answer) errors.push(`question ${q.id}: OPEN but carries an answer`);
      if (!['SKELETON_READY', 'NONE'].includes(q.blocks)) errors.push(`question ${q.id}: blocks must be SKELETON_READY or NONE`);
    }
    for (const a of q.about || []) if (!knownRef(a)) errors.push(`question ${q.id}: about references unknown "${a}"`);
  }
  if (v2) {
    // every OPEN:Qn slot is bound to an unanswered, blocking question
    for (const { path, q } of openSlots(model)) {
      const Q = questions[q];
      if (!Q) errors.push(`${path} refers to unknown question ${q}`);
      else if (!['OPEN', 'STATED'].includes(Q.status)) errors.push(`${path} is bound to ${q}, which is ${Q.status} — an answered question cannot leave its fact OPEN`);
      else if (Q.blocks !== 'SKELETON_READY') errors.push(`${path} is bound to ${q}, which must block SKELETON_READY`);
    }
    errors.push(...referenceErrorsV2(model, partIds));
    errors.push(...mechanicsErrorsV2(model, partIds, defs));
  }

  // joints: required answers are an answer or OPEN:Qn, never absent
  const { resolved, errors: re, warnings: rw } = resolve(model, opts);
  errors.push(...re);
  warnings.push(...rw);
  for (const j of model.joints || []) {
    if (v2 && !('type' in j)) { errors.push(...motionJointErrorsV2(model, j, resolved)); continue; }
    if (j.type !== 'INSERTS_INTO') { errors.push(`joint ${j.id}: type "${j.type}" not supported in S0`); continue; }
    if ((model.parts || []).find((p) => p.id === j.part)?.place) {
      errors.push(`joint ${j.id}: part ${j.part} also has a free "place"; a part is placed either by place or by a joint, not both`);
    }
    const coaxial = resolved?.joints?.[j.id]?.coaxial;
    if (v2) {
      errors.push(...jointErrorsV2(j, resolved));
      for (const l of j.links || []) {
        if (!knownRef(l.male)) errors.push(`joint ${j.id}: unknown male "${l.male}"`);
        if (!knownRef(l.female.replace(/\[[a-z]\]$/, ''))) errors.push(`joint ${j.id}: unknown female "${l.female}"`);
      }
      if (j.index && resolved) errors.push(...indexErrors(j, resolved));
      continue;
    }
    const required = ['dof', 'fit', 'assembly_motion'];
    if (coaxial) required.push('anti_rotation');
    if (j.dof !== undefined && !/^(FIXED|OPEN:Q\w+|(SLIDE|ROTATE|FLEX)\(.+\))$/.test(j.dof)) {
      errors.push(`joint ${j.id}: dof "${j.dof}" must be FIXED, SLIDE(..), ROTATE(..), FLEX(..) or OPEN:Qn`);
    }
    // All links on one axis leave rotation about that axis unconstrained by the
    // links themselves. While anti_rotation is an OPEN question, the DOF is open
    // too and must say so with the same question; it cannot claim FIXED.
    if (coaxial && typeof j.anti_rotation === 'string' && j.anti_rotation.startsWith('OPEN:') && j.dof !== j.anti_rotation) {
      errors.push(`joint ${j.id}: dof "${j.dof}" contradicts anti_rotation ${j.anti_rotation} — the links are coaxial, so rotation about their axis is unresolved; dof must be "${j.anti_rotation}"`);
    }
    for (const key of required) {
      const v = j[key];
      if (v === undefined || v === null || v === '') {
        errors.push(`joint ${j.id}: ${key} is required (an answer or OPEN:Qn); no default is applied`);
      } else if (key === 'fit' && !(typeof v === 'string' && v.startsWith('OPEN:')) && !FITS.includes(v)) {
        errors.push(`joint ${j.id}: fit "${v}" must be one of ${FITS.join(', ')} or OPEN:Qn`);
      } else if (typeof v === 'string' && v.startsWith('OPEN:')) {
        const q = questions[v.slice(5)];
        if (!q) errors.push(`joint ${j.id}: ${key} refers to unknown question ${v.slice(5)}`);
        else if (q.status !== 'OPEN') errors.push(`joint ${j.id}: ${key} refers to ${q.id}, which is not OPEN`);
      }
    }
    for (const l of j.links || []) {
      if (!knownRef(l.male)) errors.push(`joint ${j.id}: unknown male "${l.male}"`);
      if (!knownRef(l.female.replace(/\[[a-z]\]$/, ''))) errors.push(`joint ${j.id}: unknown female "${l.female}"`);
    }
    if (j.index && resolved) errors.push(...indexErrors(j, resolved));
  }

  // rules
  const rules = {};
  for (const r of model.rules || []) {
    if (!r.check) { rules[r.id] = 'TEXT_ONLY'; continue; }
    const fail = resolved ? checkRule(r.check, model, resolved, knownRef) : 'not evaluated (model does not resolve)';
    rules[r.id] = fail ? 'FAIL' : 'PASS';
    if (fail) errors.push(`rule ${r.id} FAIL (${r.kind}: ${r.text}) — ${fail}`);
  }

  errors.push(...motionDefinitionErrors(model, resolved));

  // freeze + gates
  const state = model.freeze?.state ?? 'DRAFT';
  if (!STATES.includes(state)) errors.push(`freeze.state must be one of ${STATES.join(', ')}`);
  if (state !== 'DRAFT' && model.freeze?.hash !== conceptHash(model)) {
    errors.push(model.freeze?.hash && model.freeze.hash === legacyConceptHashV1(model)
      ? `freeze.hash was computed with the legacy concept hash (v1, which ignored interfaces, fasteners and volumes) — freeze the concept again to record ${conceptHash(model)}`
      : `freeze.hash does not match the model (edited after freeze?) — expected ${conceptHash(model)}`);
  }
  const open = (model.questions || []).filter((q) => q.status === 'OPEN').map((q) => q.id);
  const stated = (model.questions || []).filter((q) => q.status === 'STATED').map((q) => q.id);
  const unresolvedStatus = v2 ? ['OPEN', 'STATED'] : ['OPEN'];
  const placeholders = v2 ? Object.entries(model.params || {}).filter(([, p]) => p.status === 'placeholder').map(([k]) => k) : [];
  if (v2) for (const k of placeholders) if (model.params[k].expr !== undefined) errors.push(`parameter ${k}: a PLACEHOLDER is an assumed literal value, not an expression`);
  const blocking = [...(model.questions || []).filter((q) => unresolvedStatus.includes(q.status) && q.blocks === 'SKELETON_READY').map((q) => q.id),
    ...placeholders.map((k) => `PLACEHOLDER:${k}`)];
  const conceptOk = errors.length === 0;
  const gates = {
    CONCEPT_FROZEN: { ok: conceptOk, reasons: conceptOk ? [] : ['ERRORS present'] },
    SKELETON_READY: { ok: conceptOk && blocking.length === 0, blocked_by: blocking },
  };
  if (state === 'SKELETON_READY' && blocking.length) {
    errors.push(`SKELETON_READY refused: blocked by ${v2 ? '' : 'OPEN '}${blocking.join(', ')}${v2 ? ` (OPEN or STATED${placeholders.length ? ' questions, PLACEHOLDER values' : ''})` : ''}`);
    gates.CONCEPT_FROZEN.ok = gates.SKELETON_READY.ok = false;
  }
  return { state, errors, warnings, open, ...(v2 ? { stated, placeholders } : {}), rules, gates, resolved };
}

function indexErrors(j, resolved) {
  const errors = [];
  const female = j.links[0].female.replace(/\[[a-z]\]$/, '');
  const count = resolved.patterns[female]?.count ?? 0;
  for (const i of resolved.joints[j.id]?.indices || []) {
    if (!Number.isInteger(i) || i < 0 || i >= count) errors.push(`joint ${j.id}: index ${i} outside 0..${count - 1}`);
  }
  return errors;
}

// ------------------------------------------------------------------ schema 2

// A schema-2 model with undeclared keys or wrong types is not interpreted at all.
function structuralFailure(model, errors) {
  const state = model?.freeze?.state ?? 'DRAFT';
  return { state, errors, warnings: [], open: [], stated: [], rules: {},
    gates: { CONCEPT_FROZEN: { ok: false, reasons: ['ERRORS present'] }, SKELETON_READY: { ok: false, blocked_by: [] } }, resolved: null };
}

// "collection/id[/field[/sub…]]" -> { entity, field, value } or an error text.
export function lookupFact(model, path) {
  const [coll, id, field, ...sub] = String(path).split('/');
  if (!COLLECTIONS.includes(coll)) return { error: `"${path}" is not in a mechanical collection` };
  const entity = (model[coll] || []).find((e) => e.id === id);
  if (!entity) return { error: `"${path}": no ${coll} entity ${id}` };
  if (field === undefined) return { entity };
  let value = entity[field];
  for (const k of sub) value = value?.[k];
  if (!isFactField(coll, entity, field, entity[field])) return { error: `"${path}": ${field} is not a mechanical fact` };
  if (value === undefined) return { error: `"${path}" does not exist` };
  if (isOpen(value) || (value && typeof value === 'object' && JSON.stringify(value).includes('"OPEN:'))) return { error: `"${path}" is still ${JSON.stringify(value)}` };
  return { entity, field, value };
}

// ANSWERED needs structured facts; words alone make a question STATED, which keeps blocking.
function questionErrorsV2(model, q) {
  const errors = [];
  const hasAnswer = typeof q.answer === 'string' && q.answer.trim() !== '';
  if (q.status === 'OPEN' && (q.answer !== undefined || q.facts !== undefined)) errors.push(`question ${q.id}: OPEN but carries an answer or facts`);
  if (q.status === 'STATED') {
    if (!hasAnswer) errors.push(`question ${q.id}: STATED without the user's words (answer)`);
    if (q.facts !== undefined) errors.push(`question ${q.id}: STATED carries facts — with structured facts it would be ANSWERED`);
  }
  if (q.status === 'ANSWERED') {
    if (!hasAnswer) errors.push(`question ${q.id}: ANSWERED without an answer`);
    if (!q.facts?.length) errors.push(`question ${q.id}: ANSWERED without facts — an answer in words alone is STATED, not ANSWERED`);
    for (const p of q.facts || []) {
      const r = lookupFact(model, p);
      if (r.error) errors.push(`question ${q.id}: fact ${r.error}`);
    }
  }
  return errors;
}

// References the V1 checks do not cover (a dangling reference would otherwise pass).
function referenceErrorsV2(model, partIds) {
  const errors = [];
  const facePart = (ref) => ref.split('.')[0];
  for (const f of model.features || []) {
    for (const r of [...(f.effect?.changes_distance_between || []), ...(f.reacts_against || [])]) {
      if (!partIds.has(facePart(r))) errors.push(`feature ${f.id}: unknown part in "${r}"`);
    }
  }
  for (const r of model.rules || []) {
    for (const p of [...(r.check.parts || []), ...(r.check.part ? [r.check.part] : [])]) {
      if (!partIds.has(p)) errors.push(`rule ${r.id}: unknown part "${p}"`);
    }
  }
  return errors;
}

// INSERTS_INTO in schema 2: the DOF must agree with the link geometry. Links
// that share one axis (a single link always does) leave rotation about it
// free, so anything but ROTATE about that axis needs anti_rotation — which has
// no typed answer in the safety core and can only be OPEN (same question as dof).
function jointErrorsV2(j, resolved) {
  const errors = [];
  const info = resolved?.joints?.[j.id];
  if (!info) return errors;
  const axial = j.links.length === 1 || info.coaxial;
  const inst = resolved.instances.find((i) => i.part === j.part);
  const letters = j.links.map((l) => inst?.features.find((x) => x.model_id === l.male)?.direction?.[1]);
  const axis = letters[0];
  const m = /^(ROTATE|SLIDE)\(([XYZ])\)$/.exec(j.dof);
  if (m?.[1] === 'ROTATE' && !axial) errors.push(`joint ${j.id}: dof ${j.dof} needs links on one axis; these links are not coaxial, so they block rotation`);
  else if (m?.[1] === 'ROTATE' && m[2] !== axis) errors.push(`joint ${j.id}: dof ${j.dof} contradicts the links, whose common axis is ${axis}`);
  if (m?.[1] === 'SLIDE' && letters.some((a) => a !== m[2])) errors.push(`joint ${j.id}: dof ${j.dof} must run along the insertion axis of every link (${[...new Set(letters)].join(', ')})`);
  const needAntiRotation = axial && j.dof !== `ROTATE(${axis})`;
  if (needAntiRotation && j.anti_rotation === undefined) {
    errors.push(`joint ${j.id}: anti_rotation is required (OPEN:Qn) — the links share axis ${axis}, so rotation about it is unresolved`);
  } else if (!needAntiRotation && j.anti_rotation !== undefined) {
    errors.push(`joint ${j.id}: anti_rotation does not apply — ${axial ? `rotation about ${axis} is the stated DOF` : 'the links are not coaxial'}`);
  }
  if (isOpen(j.anti_rotation) && j.dof !== j.anti_rotation) {
    errors.push(`joint ${j.id}: dof "${j.dof}" contradicts anti_rotation ${j.anti_rotation} — the links share one axis, so rotation about it is unresolved; dof must be "${j.anti_rotation}"`);
  }
  return errors;
}

// Promotion is a separate, explicit step and is refused while blocking questions are OPEN.
export function markSkeletonReady(model) {
  const v = validate(model);
  if (v.state !== 'CONCEPT_FROZEN') return { ok: false, reason: `state is ${v.state}, must be CONCEPT_FROZEN` };
  if (!v.gates.SKELETON_READY.ok) return { ok: false, reason: 'blocked', blocked_by: v.gates.SKELETON_READY.blocked_by, errors: v.errors };
  return { ok: true, model: { ...model, freeze: { ...model.freeze, state: 'SKELETON_READY' } } };
}

export function freezeConcept(model, at) {
  const m = structuredClone(model);
  m.freeze = { state: 'CONCEPT_FROZEN', revision: m.meta.revision, at, hash: conceptHash(m) };
  const v = validate(m);
  if (!v.gates.CONCEPT_FROZEN.ok) return { ok: false, errors: v.errors };
  m.freeze.skeleton_ready = { ready: false, blocked_by: v.gates.SKELETON_READY.blocked_by };
  return { ok: true, model: m };
}

const featuresOf = (resolved, modelId) =>
  resolved.instances.flatMap((i) => i.features).filter((f) => f.model_id === modelId);
const worldDir = (f) => f.direction ?? f.bore_axis ?? (f.compliance_axis ? '±' + f.compliance_axis : null);

// Returns null on PASS or a failure description.
function checkRule(c, model, resolved, knownRef) {
  const insts = (part) => resolved.instances.filter((i) => i.part === part);
  switch (c.type) {
    case 'PARALLEL': {
      const normals = c.parts.flatMap((p) => insts(p).map((i) => i.axes.z[1]));
      return new Set(normals).size <= 1 ? null : `normals ${[...new Set(normals)].join(', ')}`;
    }
    case 'DIRECTION': {
      const bad = [];
      for (const [id, want] of Object.entries(c.features)) {
        if (!knownRef(id)) { bad.push(`unknown ${id}`); continue; }
        for (const f of featuresOf(resolved, id)) {
          const got = worldDir(f);
          const ok = want.startsWith('±') ? got && got[1] === want[1] : got === want;
          if (!ok) bad.push(`${f.id} is ${got}, must be ${want}`);
        }
      }
      return bad.length ? bad.join('; ') : null;
    }
    case 'FORBID_DIRECTION': {
      const bad = insts(c.part).flatMap((i) => i.features).filter((f) => worldDir(f) === c.world);
      return bad.length ? bad.map((f) => `${f.id} points ${c.world}`).join('; ') : null;
    }
    case 'KIND': {
      const p = model.parts.find((x) => x.id === c.part);
      return p?.kind === c.kind ? null : `${c.part} is ${p?.kind}, must be ${c.kind}`;
    }
    case 'CLOSED_WORLD': {
      const extra = resolved.instances.filter((i) => !model.parts.some((p) => p.id === i.part));
      return extra.length ? `undeclared ${extra.map((i) => i.id).join(', ')}` : null;
    }
    default:
      return `unknown check type ${c.type}`;
  }
}

// ------------------------------------------------------------------ schema 2 mechanics (E3–E7)
const partOfRef = (ref) => String(ref).split('.')[0];
const parentPart = (j) => ('type' in j ? j.links?.[0]?.female : j.links?.[0]?.parent)?.split('.')[0];

// Structural checks of interfaces, holes, fasteners and volumes; geometric checks live in the resolver.
function mechanicsErrorsV2(model, partIds, defs) {
  const errors = [];
  for (const i of model.interfaces || []) {
    if (!partIds.has(i.part)) errors.push(`interface ${i.id}: unknown part "${i.part}"`);
    if (i.id === 'AXIS') errors.push('interface AXIS: the name is reserved for the axis of a round part');
  }
  const kindOf = Object.fromEntries((model.parts || []).map((p) => [p.id, p.kind]));
  for (const d of Object.values(defs)) {
    if (d.mirror && d.type === 'HOLE') errors.push(`feature ${d.id}: a mirror applies to TAB, EYE and SPRING only`);
    if (['TAB', 'EYE', 'SPRING'].includes(d.type) && ['ROD', 'CYLINDER'].includes(kindOf[d.host])) errors.push(`feature ${d.id}: a ${d.type} sits on an edge; a round ${kindOf[d.host]} has no edges (use an interface and a HOLE)`);
    if (d.type !== 'HOLE') continue;
    const need = d.profile === 'ROUND' ? ['d'] : ['a', 'b'];
    const size = Object.keys(d.size || {});
    if (need.some((k) => !size.includes(k)) || size.some((k) => !need.includes(k))) errors.push(`feature ${d.id}: a ${d.profile} hole has size {${need.join(', ')}}`);
    if (d.kind === 'THREADED' && d.profile !== 'ROUND') errors.push(`feature ${d.id}: a THREADED hole is ROUND`);
    if (d.kind === 'OPENING' && d.depth !== 'THROUGH') errors.push(`feature ${d.id}: an OPENING goes THROUGH`);
  }
  const children = {};
  for (const j of model.joints || []) (children[j.part] ||= []).push(j.id);
  for (const [p, js] of Object.entries(children)) if (js.length > 1) errors.push(`part ${p}: is the part of joints ${js.join(', ')} — a part is placed by one joint`);
  const holes = Object.fromEntries(Object.values(defs).filter((d) => d.type === 'HOLE').map((d) => [`${d.host}.${d.id}`, d]));
  for (const fa of model.fasteners || []) {
    const E = (m) => errors.push(`fastener ${fa.id}: ${m}`);
    const j = (model.joints || []).find((x) => x.id === fa.joint);
    if (!j || 'type' in j) E(`joint "${fa.joint}" must be a FIXED joint (FIXED / REVOLUTE / PRISMATIC family)`);
    else if (j.motion !== 'FIXED' || !['FASTENERS', 'CLAMPED'].includes(j.method)) E(`joint ${j.id} must be FIXED with method FASTENERS or CLAMPED (is ${j.motion}, ${j.method ?? 'no method'})`);
    for (const r of fa.through) {
      if (!holes[r]) E(`"${r}" is not a HOLE`);
      else if (holes[r].kind !== 'CLEARANCE') E(`passes through ${r}, which is ${holes[r].kind}; a fastener passes through CLEARANCE holes`);
    }
    if (fa.kind === 'SCREW' && !fa.into) E('a SCREW threads into a THREADED hole: "into" is required');
    if (fa.kind === 'BOLT_NUT' && fa.into) E('a BOLT_NUT ends in a nut: it has no "into" hole');
    if (fa.into && !holes[fa.into]) E(`"${fa.into}" is not a HOLE`);
    else if (fa.into && holes[fa.into].kind !== 'THREADED') E(`threads into ${fa.into}, which is ${holes[fa.into].kind}; "into" must be THREADED`);
    const ps = new Set([...fa.through, ...(fa.into ? [fa.into] : [])].map(partOfRef));
    if (ps.size < 2) E('its holes must be in at least two parts — a fastener joins parts');
    if (j && !('type' in j) && [...ps].some((p) => p !== j.part && p !== parentPart(j))) E(`its holes must be in the parts of joint ${j.id} (${j.part}, ${parentPart(j)})`);
  }
  for (const vol of model.volumes || []) {
    const [p, feat] = String(vol.for).split('.');
    const served = feat ? partIds.has(p) && defs[feat]?.host === p : partIds.has(p) || (model.fasteners || []).some((f) => f.id === p);
    if (!served) errors.push(`volume ${vol.id}: for "${vol.for}" is not a part, fastener or feature`);
    for (const p of vol.allow || []) if (!partIds.has(p)) errors.push(`volume ${vol.id}: allow references unknown part "${p}"`);
  }
  return errors;
}

// FIXED / REVOLUTE / PRISMATIC: which facts each motion needs, and pending slots.
function motionJointErrorsV2(model, j, resolved) {
  const errors = [];
  const E = (m) => errors.push(`joint ${j.id}: ${m}`);
  const has = (k) => j[k] !== undefined;
  if ((model.parts || []).find((p) => p.id === j.part)?.place) E(`part ${j.part} also has a free "place"; a part is placed either by place or by a joint, not both`);
  if (isOpen(j.motion)) {
    for (const k of ['method', 'axis', 'limits']) if (has(k)) E(`${k} depends on the motion, which is ${j.motion}; leave it out until the motion is known`);
  } else {
    if (!has('method')) E(`method is required (${METHODS[j.motion].join(', ')} or OPEN:Qn)`);
    else if (!isOpen(j.method) && !METHODS[j.motion].includes(j.method)) E(`method ${j.method} does not apply to ${j.motion} (${METHODS[j.motion].join(', ')})`);
    if (j.motion === 'FIXED') for (const k of ['axis', 'limits']) { if (has(k)) E(`a FIXED joint has no ${k}`); }
    else {
      if (!has('axis')) E(`a ${j.motion} joint needs an explicit axis (an AXIS interface)`);
      if (!has('limits')) E(`a ${j.motion} joint needs limits ({min, max}${j.motion === 'REVOLUTE' ? ', NONE' : ''} or OPEN:Qn)`);
      const l = j.limits;
      if (l === 'NONE' && j.motion === 'PRISMATIC') E('a PRISMATIC joint cannot be unlimited');
      // limits may be literals or "=param"; the numeric rules apply to the resolved values
      const r = l && typeof l === 'object' ? (resolved?.joints?.[j.id]?.limits ?? (typeof l.min === 'number' && typeof l.max === 'number' ? l : null)) : null;
      if (r && typeof r === 'object') {
        if (!(r.min < r.max)) E(`limits min ${r.min} must be less than max ${r.max}`);
        if (j.motion === 'REVOLUTE' && (r.min < -360 || r.max > 360)) E('REVOLUTE limits are degrees within −360 … 360');
      }
    }
  }
  // a glued joint is permanent: removable YES contradicts method BONDED (removable NO or OPEN:Qn are fine)
  if (j.method === 'BONDED' && j.assembly?.removable === 'YES') E('a BONDED joint cannot be removable (removable YES contradicts method BONDED) — reopen the method or state how the part is held');
  const info = resolved?.joints?.[j.id];
  if (!info) return errors;
  const coaxialLink = info.links[0].kind === 'COAXIAL';
  if (coaxialLink && !has('fit')) E('fit is required for a pin-in-bore (AXIS) link (LOOSE … PRESS or OPEN:Qn)');
  if (!coaxialLink && has('fit')) E('fit applies to AXIS links only; these faces are seated');
  // FORM_FIT = the linked geometry itself holds / guides the part: that needs a physical pin-in-bore
  // pair. Seated faces alone hold nothing (a snap, a groove, a pocket are not in the language).
  if (j.method === 'FORM_FIT' && !isOpen(j.motion) && !info.physical) {
    E(j.motion === 'FIXED' && info.links[0].kind === 'SEATED'
      ? `FORM_FIT on seated faces claims a retention the structure does not show — seated faces hold nothing; state how ${j.part} is held (FASTENERS, CLAMPED, BONDED) or leave method OPEN`
      : `FORM_FIT means link 1 itself is the bearing, which needs a round male (ROD / CYLINDER axis, TAB) in a bore (HOLE BORE / CLEARANCE, EYE); ${j.links[0].child} and ${j.links[0].parent} are not such a pair — the construction is OPEN until stated`);
  }
  const needAnti = j.motion === 'FIXED' && info.coaxial && j.method === 'FORM_FIT' && j.fit !== 'PRESS';
  if (needAnti && !has('anti_rotation')) E('anti_rotation is required (OPEN:Qn): the links share one axis and nothing stated prevents rotation about it');
  if (!needAnti && has('anti_rotation')) E('anti_rotation does not apply to this joint');
  const needFasteners = j.motion === 'FIXED' && j.method === 'FASTENERS' && !(model.fasteners || []).some((f) => f.joint === j.id);
  if (needFasteners && !has('fasteners')) E('method FASTENERS without any fastener: fasteners must be OPEN:Qn until they are stated');
  if (!needFasteners && has('fasteners')) E('fasteners (pending) applies only to FIXED + FASTENERS without fastener entities');
  return errors;
}
