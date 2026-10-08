// The transaction boundary between an (untrusted) interpreter and the accepted
// concept model. evaluateProposal() never mutates its input; it dry-runs the
// ops on a copy and reports VALID / INVALID / STALE / CLARIFY. Architecture §F.

import { conceptHash, canonical } from './model.js?v=f5dbe684feae';
import { validate } from './validate.js?v=f5dbe684feae';
import { OPS, MECHANICAL, applyOps, parsePath, getPath, isOpenRef, locate } from './ops.js?v=f5dbe684feae';
import { isFactField, isNumericField, factNumbers, openSlots, COLLECTIONS } from './schema.js?v=f5dbe684feae';
import { exportAll } from './export.js?v=f5dbe684feae';
import { numbersIn as statedNumbers } from './interpret/normalize.js?v=f5dbe684feae';
import { checkProtectedRemainder, deriveScope } from './scope.js?v=f5dbe684feae';

export const PROPOSAL_FORMAT = 'AI_CONCEPT_PROPOSAL';

const REQUIRED = {
  ADD_PARAM: ['name', 'param'], ADD_PART: ['part'], ADD_FEATURE: ['feature'], ADD_JOINT: ['joint'],
  ADD_RULE: ['rule'], ADD_QUESTION: ['question'], SET: ['path', 'value'], UNSET: ['path'],
  DELETE: ['collection', 'id'], ANSWER_QUESTION: ['id', 'answer'],
  ADD_INTERFACE: ['interface'], ADD_FASTENER: ['fastener'], ADD_VOLUME: ['volume'],
};

export const normalizeText = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9+\-%.]+/g, ' ').trim();

// Parse + schema. Returns { proposal } or { errors }.
export function parseProposal(text) {
  let p;
  try { p = typeof text === 'string' ? JSON.parse(text) : structuredClone(text); } catch (e) { return { errors: [`proposal is not valid JSON: ${e.message}`] }; }
  const errors = [];
  if (!p || typeof p !== 'object') return { errors: ['proposal must be a JSON object'] };
  if (p.format !== PROPOSAL_FORMAT) errors.push(`format must be "${PROPOSAL_FORMAT}"`);
  if (p.schema !== 1) errors.push('schema must be 1');
  if (!p.base || typeof p.base.hash !== 'string' || !Number.isInteger(p.base.revision)) errors.push('base {revision, hash} is required');
  if (typeof p.utterance !== 'string' || !p.utterance.trim()) errors.push('utterance (the user\'s words) is required');
  if (typeof p.summary !== 'string') errors.push('summary is required');
  if (!Array.isArray(p.ops)) errors.push('ops must be an array');
  if (p.clarification !== undefined && p.clarification !== null && typeof p.clarification !== 'string') errors.push('clarification must be a string or null');
  // S2: utterance ids and the earlier utterances that evidence may quote (only those in context)
  const known = ['format', 'schema', 'base', 'utterance', 'summary', 'source', 'clarification', 'ops', 'utterance_id', 'context'];
  for (const k of Object.keys(p)) if (!known.includes(k)) errors.push(`unknown proposal key "${k}"`);
  if (p.utterance_id !== undefined && (typeof p.utterance_id !== 'string' || !p.utterance_id)) errors.push('utterance_id must be a non-empty string');
  if (p.context !== undefined && !(Array.isArray(p.context) && p.context.every((u) => u && typeof u.id === 'string' && typeof u.text === 'string' && Object.keys(u).every((k) => k === 'id' || k === 'text')))) {
    errors.push('context must be a list of {id, text} utterances');
  }
  (Array.isArray(p.ops) ? p.ops : []).forEach((op, i) => {
    if (!op || !OPS.includes(op.op)) { errors.push(`op ${i + 1}: unknown op ${JSON.stringify(op?.op)}`); return; }
    for (const f of REQUIRED[op.op]) if (op[f] === undefined) errors.push(`op ${i + 1} (${op.op}): missing "${f}"`);
    const allowed = ['op', 'evidence', ...REQUIRED[op.op], ...(op.op === 'ANSWER_QUESTION' ? ['facts'] : [])];
    for (const k of Object.keys(op)) if (!allowed.includes(k)) errors.push(`op ${i + 1} (${op.op}): unknown key "${k}"`);
    const quoteOk = (v) => typeof v === 'string' || (v && typeof v === 'object' && typeof v.u === 'string' && typeof v.quote === 'string' && Object.keys(v).every((k) => k === 'u' || k === 'quote'));
    const evOk = op.evidence === undefined || quoteOk(op.evidence)
      || (op.evidence && typeof op.evidence === 'object' && !Array.isArray(op.evidence) && !('u' in op.evidence) && Object.values(op.evidence).every(quoteOk));
    if (!evOk) errors.push(`op ${i + 1}: evidence must be a quote, {u, quote}, or an object {field: quote | {u, quote}}`);
  });
  return errors.length ? { errors } : { proposal: p };
}

// Words that describe a fit. A concrete fit must be justified by the user's
// own fit word — "tabs into the eyes" does not say how tight (fit is a
// mechanical fact, architecture §F). Lexical, deterministic, EN + CS.
export const FIT_TERMS = /\b(loose|loosely|clearance|play|sliding|slide|snug|snugly|tight|tightly|press|pressed|interference|volne|volny|volna|vule|vuli|posuvn\w*|tesne|tesny|tesna|nalis\w*|natlac\w*|zalis\w*)\b/;

// Mechanical facts an op sets to a concrete value (each needs evidence).
// `model` is the state the op applies to; for schema 2 the fact fields come
// from the closed schema table.
export function concreteFacts(op, model) {
  if (model?.schema === 2) return concreteFactsV2(op, model);
  const facts = [];
  const scan = (coll, entity) => {
    for (const f of MECHANICAL[coll] || []) if (entity?.[f] !== undefined && !isOpenRef(entity[f])) facts.push({ field: f, what: `${coll}/${entity.id}/${f}` });
  };
  if (op.op === 'ADD_PART') scan('parts', op.part);
  if (op.op === 'ADD_FEATURE') scan('features', op.feature);
  if (op.op === 'ADD_JOINT') scan('joints', op.joint);
  if (op.op === 'ADD_RULE') facts.push({ field: 'rule', what: `rules/${op.rule?.id} (a MUST/MUST NOT is the user's statement)` });
  if (op.op === 'ANSWER_QUESTION') facts.push({ field: 'answer', what: `questions/${op.id}/answer` });
  if (op.op === 'SET') {
    const { collection, id, field } = parsePath(op.path);
    if (MECHANICAL[collection]?.includes(field) && !isOpenRef(op.value)) facts.push({ field, what: `${collection}/${id}/${field}` });
  }
  return facts;
}

// A value states something concrete unless it is (entirely) OPEN:Qn.
const hasConcrete = (v) => (Array.isArray(v) ? v.some(hasConcrete) : v && typeof v === 'object' ? Object.values(v).some(hasConcrete) : !isOpenRef(v));

function concreteFactsV2(op, model) {
  const facts = [];
  const scan = (coll, entity) => {
    for (const [k, v] of Object.entries(entity || {})) {
      if (isFactField(coll, entity, k, v) && hasConcrete(v)) facts.push({ field: k, what: `${coll}/${entity.id}/${k}`, value: v, numeric: isNumericField(coll, entity, k) });
    }
  };
  if (op.op === 'ADD_PART') scan('parts', op.part);
  if (op.op === 'ADD_FEATURE') scan('features', op.feature);
  if (op.op === 'ADD_JOINT') scan('joints', op.joint);
  if (op.op === 'ADD_QUESTION') scan('questions', op.question);
  if (op.op === 'ADD_INTERFACE') scan('interfaces', op.interface);
  if (op.op === 'ADD_FASTENER') scan('fasteners', op.fastener);
  if (op.op === 'ADD_VOLUME') scan('volumes', op.volume);
  if (op.op === 'ADD_RULE') facts.push({ field: 'rule', what: `rules/${op.rule?.id} (a MUST/MUST NOT is the user's statement)` });
  if (op.op === 'ANSWER_QUESTION') facts.push({ field: 'answer', what: `questions/${op.id}/answer` });
  if (op.op === 'SET') {
    const { collection, id, field } = parsePath(op.path);
    let entity = null;
    try { entity = collection === 'meta' ? model.meta : locate(model, collection, id); } catch { /* reported by the reducer */ }
    if (collection !== 'meta' && collection !== 'params' && isFactField(collection, entity, field, op.value) && hasConcrete(op.value)) {
      facts.push({ field, what: `${collection}/${id}/${field}`, value: op.value, numeric: isNumericField(collection, entity, field) });
    }
  }
  return facts;
}

// PLACEHOLDER (schema 2): a number the AI assumed. It leaves that status only through
// the user's own words stating the value — never silently.
function placeholderRule(state, op, p, tag) {
  const { collection, id } = parsePath(op.path);
  if (collection !== 'params' || state.params?.[id]?.status !== 'placeholder') return [];
  const after = applyOps(state, [op]).params[id];
  if (after?.status === 'placeholder') return [];
  const given = evidenceFor(op, 'value', 1);
  const quote = quoteText(given);
  const source = utteranceOf(p, given);
  if (!quote || source === undefined || !normalizeText(source).includes(normalizeText(quote))) {
    return [`${tag}: parameter ${id} is a PLACEHOLDER; confirming or replacing it needs the user's words stating the value — it is never promoted silently`];
  }
  const value = after?.value;
  if (typeof value !== 'number' || !statedNumbers(quote).some((x) => Math.abs(x - value) < 1e-9)) {
    return [`${tag}: parameter ${id} is a PLACEHOLDER; the evidence "${quote}" does not state its value ${value}`];
  }
  return [];
}

// An unresolved question (OPEN, or STATED words the language cannot hold) leaves
// the SKELETON_READY gate only by being answered with structured facts. Turning
// its `blocks` off would close the gate without any answer, so no proposal may
// do it — whatever words or evidence accompany it.
function unblockRule(state, op, tag) {
  const { collection, id, field } = parsePath(op.path);
  if (collection !== 'questions' || field !== 'blocks') return [];
  const q = (state.questions || []).find((x) => x.id === id);
  if (!q || !['OPEN', 'STATED'].includes(q.status)) return [];
  const next = op.op === 'UNSET' ? undefined : op.value;
  if (next === q.blocks) return [];
  return [`${tag}: question ${id} is ${q.status}; an unresolved question cannot stop blocking ${q.blocks} — it is closed only by an ANSWER_QUESTION with structured facts`];
}

const openRefsIn = (v) => (isOpenRef(v) ? [v] : v && typeof v === 'object' ? [...new Set(Object.values(v).flatMap(openRefsIn))] : []);

// Numbers stated in words (digits incl. decimal comma, CS/EN number words, units): see interpret/normalize.js.
export const numbersIn = (text) => statedNumbers(text);

// The user's words given for one fact of an op (string evidence only covers a single-fact op).
export function evidenceFor(op, field, nFacts) {
  const single = typeof op.evidence === 'string' || (op.evidence && typeof op.evidence.u === 'string');
  if (single) return nFacts === 1 ? op.evidence : undefined;
  return op.evidence?.[field];
}
// The quoted words and the utterance they are quoted from (a plain string quotes the current utterance).
const quoteText = (ev) => (ev && typeof ev === 'object' ? ev.quote : ev);
function utteranceOf(p, ev) {
  if (!ev || typeof ev !== 'object' || ev.u === p.utterance_id) return p.utterance;
  return (p.context || []).find((u) => u.id === ev.u)?.text;
}

// Evidence, OPEN and reference rules, checked against the model state before each op.
function boundaryRules(accepted, p) {
  const errors = [];
  const answered = new Set(p.ops.filter((o) => o.op === 'ANSWER_QUESTION').map((o) => o.id));
  const answerEvidence = new Map(p.ops.filter((o) => o.op === 'ANSWER_QUESTION').map((o) => [o.id, quoteText(evidenceFor(o, 'answer', 1))]));
  let state = structuredClone(accepted);
  p.ops.forEach((op, i) => {
    const tag = `op ${i + 1} (${op.op}${op.path ? ' ' + op.path : ''})`;
    try {
      const facts = concreteFacts(op, state);
      if (facts.length && !op.evidence) {
        errors.push(`${tag}: sets ${facts.map((f) => f.what).join(', ')} without evidence from the user's words — a mechanical fact may not be invented`);
      } else if (facts.length > 1 && typeof op.evidence === 'string') {
        errors.push(`${tag}: sets ${facts.length} mechanical facts (${facts.map((f) => f.field).join(', ')}); give the user's words per fact as evidence {field: quote}`);
      } else {
        for (const f of facts) {
          const given = evidenceFor(op, f.field, facts.length);
          const quote = quoteText(given);
          const ev = normalizeText(quote);
          const source = utteranceOf(p, given);
          if (!ev) errors.push(`${tag}: ${f.what} has no evidence from the user's words — a mechanical fact may not be invented`);
          else if (source === undefined) errors.push(`${tag}: evidence for ${f.field} quotes utterance ${given.u}, which is not in this proposal's context`);
          else if (!normalizeText(source).includes(ev)) errors.push(`${tag}: evidence "${quote}" for ${f.field} does not occur in the user's words`);
          else if (f.field === 'fit' && !FIT_TERMS.test(ev)) errors.push(`${tag}: fit evidence "${quote}" does not state a fit (loose / clearance / sliding / snug / press …) — fit is never chosen for the user`);
          else if (f.numeric) {
            const said = statedNumbers(quote);
            const missing = factNumbers(f.value).filter((n) => !said.some((x) => Math.abs(x - n) < 1e-9));
            if (missing.length) errors.push(`${tag}: evidence "${quote}" for ${f.field} does not state ${missing.join(', ')} — a number in a mechanical fact comes from the user's words`);
          }
        }
      }
      if (op.op === 'SET' || op.op === 'UNSET') {
        const current = getPath(state, op.path);
        // an OPEN fact, also one nested inside the value being replaced (e.g. assembly.direction)
        for (const ref of openRefsIn(current)) {
          const q = ref.slice(5);
          const where = isOpenRef(current) ? `${op.path} is ${current}` : `${op.path} contains ${ref}`;
          if (!answered.has(q)) errors.push(`${tag}: ${where}; changing it requires ANSWER_QUESTION ${q} in the same proposal — an OPEN fact is never filled silently`);
          else if (!normalizeText(answerEvidence.get(q))) errors.push(`${tag}: the answer to ${q} has no evidence`);
        }
      }
      if (op.op === 'SET' || op.op === 'UNSET') errors.push(...unblockRule(state, op, tag));
      if (accepted.schema === 2 && (op.op === 'SET' || op.op === 'UNSET')) errors.push(...placeholderRule(state, op, p, tag));
      if (op.op === 'DELETE' && op.collection === 'questions') {
        const q = (state.questions || []).find((x) => x.id === op.id);
        if (q?.status === 'OPEN') errors.push(`${tag}: an OPEN question cannot be deleted; it can only be answered`);
        if (q?.status === 'STATED') errors.push(`${tag}: a STATED question (the user's words) cannot be deleted; it can only be answered with structured facts`);
      }
      state = applyOps(state, [op]);
    } catch (e) {
      errors.push(`${tag}: ${e.message}`);
    }
  });
  if (accepted.schema === 2 && !errors.length) errors.push(...answerRulesV2(accepted, state, p));
  return errors;
}

// Schema 2 (architecture Core V2 §4.2): an answer is structured or it is STATED.
// - every fact an ANSWERED question lists is set or created by an op of this
//   proposal (with that op's own evidence) and is a mechanical fact;
// - every fact belongs to THAT question: it fills a slot bound to the question,
//   or it is (or refers to) an element the question is about — judged by the
//   question as accepted (or as created by this proposal), never by an `about`
//   edited in the same proposal. A fact bound to another question's slot can
//   never answer this one;
// - a no-op assignment establishes nothing. A fact whose value does not change
//   supports an answer only when it is the very element the question is about:
//   the user confirms the value already shown for what was asked (accepted
//   context stays usable without being restated);
// - every slot bound to the question before the proposal is now one of its
//   facts, re-bound to another OPEN question, or removed — never silently kept
//   or filled outside the answer;
// - a STATED answer (facts: []) leaves its slots OPEN.
// Only the answers in THIS proposal are checked: questions answered in earlier
// accepted revisions, and edits that answer nothing, are unaffected.
const valueAt = (model, path) => {
  const [coll, id, ...rest] = path.split('/');
  const entity = coll === 'params' ? model.params?.[id] : (model[coll] || []).find((e) => e.id === id);
  if (!rest.length) return entity;
  try { return getPath(model, path); } catch { return undefined; }
};
const covers = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

// The elements a question is about: "ID" names that entity, "PART.ELEMENT"
// names that feature/interface (not the whole part).
function aboutIds(q) {
  return new Set((q?.about || []).map((ref) => String(ref).split('.').at(-1).replace(/\[.*\]$/, '')));
}
// Ids an entity refers to (host, part, links, through, mirror.of, …), by exact token.
function refTokens(value, out = new Set()) {
  if (Array.isArray(value)) value.forEach((v) => refTokens(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => refTokens(v, out));
  else if (typeof value === 'string' && !value.startsWith('=')) value.split(/[.:[\]\s]+/).forEach((t) => t && out.add(t));
  return out;
}

function answerRulesV2(accepted, candidate, p) {
  const errors = [];
  const touched = (path) => p.ops.some((o) => {
    if ((o.op === 'SET') && covers(o.path, path)) return true;
    const coll = { ADD_PART: 'parts', ADD_FEATURE: 'features', ADD_JOINT: 'joints', ADD_RULE: 'rules',
      ADD_INTERFACE: 'interfaces', ADD_FASTENER: 'fasteners', ADD_VOLUME: 'volumes' }[o.op];
    const e = coll && o[coll.slice(0, -1)];
    return Boolean(coll && e && (path === `${coll}/${e.id}` || path.startsWith(`${coll}/${e.id}/`)));
  });
  const changed = (path) => canonical(valueAt(accepted, path)) !== canonical(valueAt(candidate, path));
  const before = openSlots(accepted);
  const after = new Map(openSlots(candidate).map((x) => [x.path, x.q]));
  for (const op of p.ops.filter((o) => o.op === 'ANSWER_QUESTION')) {
    const facts = op.facts || [];
    const q = (accepted.questions || []).find((x) => x.id === op.id)
      ?? p.ops.find((o) => o.op === 'ADD_QUESTION' && o.question?.id === op.id)?.question;
    const about = aboutIds(q);
    const mine = before.filter((x) => x.q === op.id);
    for (const path of facts) {
      const [coll, id, field] = path.split('/');
      if (!COLLECTIONS.includes(coll)) { errors.push(`ANSWER_QUESTION ${op.id}: fact "${path}" is not in a mechanical collection`); continue; }
      if (field !== undefined) {
        const entity = (candidate[coll] || []).find((e) => e.id === id);
        if (!isFactField(coll, entity, field, entity?.[field])) { errors.push(`ANSWER_QUESTION ${op.id}: "${path}" is not a mechanical fact`); continue; }
      }
      if (!touched(path)) { errors.push(`ANSWER_QUESTION ${op.id}: fact "${path}" is not established by this proposal — an answer must be backed by a structured change the user's words justify`); continue; }
      const other = before.find((x) => x.q !== op.id && covers(x.path, path));
      if (other) { errors.push(`ANSWER_QUESTION ${op.id}: fact "${path}" fills ${other.path}, which belongs to ${other.q} — a fact answers only its own question`); continue; }
      const direct = mine.some((x) => covers(x.path, path)) || about.has(id);
      if (!changed(path) && !about.has(id)) { errors.push(`ANSWER_QUESTION ${op.id}: fact "${path}" does not change (it already is ${JSON.stringify(valueAt(accepted, path))}) — a no-op assignment cannot answer a question unless it confirms the element the question is about`); continue; }
      const entity = valueAt(candidate, `${coll}/${id}`);
      const associated = direct || [...refTokens(entity)].some((t) => t !== id && about.has(t));
      if (!associated) errors.push(`ANSWER_QUESTION ${op.id}: fact "${path}" is not associated with ${op.id} (about: ${(q?.about || []).join(', ') || 'nothing'}${mine.length ? `; bound slots: ${mine.map((x) => x.path).join(', ')}` : ''}) — a fact answers only the question it belongs to`);
    }
    for (const { path } of mine) {
      const now = after.get(path);
      let exists = true;
      try { exists = getPath(candidate, path) !== undefined; } catch { exists = false; }
      if (!exists) continue;                                          // the slot no longer applies (e.g. UNSET anti_rotation)
      if (now === op.id) { if (facts.length) errors.push(`ANSWER_QUESTION ${op.id}: ${path} is still OPEN:${op.id} — list it as a fact with its structured value, re-bind it to a new question, or record the answer as STATED (facts: [])`); continue; }
      if (now !== undefined) continue;                                // re-bound to another question (checked by the validator)
      if (!facts.some((x) => path === x || path.startsWith(`${x}/`))) errors.push(`ANSWER_QUESTION ${op.id}: ${path} was bound to ${op.id} and now has a value, but it is not listed in facts`);
    }
  }
  return errors;
}

// Returns an evaluation. Never mutates `accepted`.
export function evaluateProposal(accepted, text, opts = {}) {
  const out = { status: 'INVALID', errors: [], warnings: [], proposal: null, candidate: null, validation: null, newOpen: [], answered: [], scope: null };
  const { proposal, errors } = parseProposal(text);
  if (!proposal) { out.errors = errors; return out; }
  out.proposal = proposal;
  if (proposal.base.hash !== conceptHash(accepted) || proposal.base.revision !== accepted.meta.revision) {
    out.status = 'STALE';
    out.errors = [`proposal was made for revision ${proposal.base.revision} (${proposal.base.hash.slice(0, 15)}…), accepted is revision ${accepted.meta.revision} (${conceptHash(accepted).slice(0, 15)}…)`];
    return out;
  }
  if (proposal.ops.length === 0) {
    if (!proposal.clarification) { out.errors = ['proposal has no ops and no clarification']; return out; }
    out.status = 'CLARIFY';
    return out;
  }
  const rule = boundaryRules(accepted, proposal);
  if (rule.length) { out.errors = rule; return out; }
  let candidate;
  try { candidate = applyOps(accepted, proposal.ops); } catch (e) { out.errors = [e.message]; return out; }
  candidate.freeze = { state: 'DRAFT' };       // any change leaves the frozen state

  // Edit scope: derived from the validated ops and the accepted model, never from
  // the interpreter. The candidate may change only those paths (protected
  // remainder). A caller (UI selection) may narrow it further with opts.scope;
  // both must hold. Nothing an interpreter declares can widen either.
  let derived, guard, requested = null;
  try {
    derived = deriveScope(accepted, proposal.ops, opts.affects || []);
    guard = checkProtectedRemainder(accepted, candidate, derived);
    if (opts.scope) requested = checkProtectedRemainder(accepted, candidate, opts.scope);
  } catch (e) { out.errors = [`invalid edit scope: ${e.message}`]; return out; }
  const forbidden = [...new Set([...guard.forbidden, ...(requested?.forbidden || [])])].sort();
  out.scope = { allow: requested ? requested.allow.filter((a) => derived.allow.some((d) => d === a || d.startsWith(`${a}/`) || a.startsWith(`${d}/`))) : derived.allow,
    derived: derived.allow, requested: requested ? requested.allow : null, affects: derived.affects, changed: guard.changed, forbidden };
  if (forbidden.length) {
    out.candidate = candidate;
    out.errors = forbidden.map((p) => `protected remainder changed outside edit scope: ${p}`);
    return out;
  }

  const v = validate(candidate);
  out.candidate = candidate;
  out.validation = v;
  out.warnings = v.warnings;
  if (v.errors.length) { out.errors = v.errors; return out; }
  // F3: VALID includes "every canonical exporter succeeds for this candidate"
  try { (opts.exportAll ?? exportAll)(candidate, v, `${candidate.meta.id}-rev${candidate.meta.revision}.aiconcept`); } catch (e) {
    out.errors = [`not exportable: ${e.message}`];
    return out;
  }
  const wasOpen = new Set((accepted.questions || []).filter((q) => q.status === 'OPEN').map((q) => q.id));
  out.newOpen = v.open.filter((q) => !wasOpen.has(q));
  out.answered = [...wasOpen].filter((q) => !v.open.includes(q));
  if (v.stated) out.stated = v.stated.filter((q) => wasOpen.has(q));
  out.status = 'VALID';
  return out;
}

// Structured intents (Live AI, Property Editor) carry no per-fact quotes. They
// enter the boundary with the user's actual utterance — supplied by the caller
// that received it, never copied from interpreter output — as the evidence for
// every fact an op sets. The ordinary rules then apply unchanged: numbers in a
// numeric fact and a concrete fit must occur in those words, a PLACEHOLDER only
// changes when the words state its value, OPEN slots need an answer, and every
// answered fact must be established by this proposal. Existing evidence is kept.
export function attachUtteranceEvidence(model, ops, utterance) {
  let state = structuredClone(model);
  return ops.map((op) => {
    const out = structuredClone(op);
    try {
      if (out.evidence === undefined) {
        const fields = concreteFacts(out, state).map((f) => f.field);
        if (out.op === 'SET' && String(out.path).startsWith('params/')) fields.push('value');
        if (fields.length) out.evidence = Object.fromEntries([...new Set(fields)].map((f) => [f, utterance]));
      }
      state = applyOps(state, [out]);
    } catch { /* the evaluator reports the failing op */ }
    return out;
  });
}

// Plain-language line for one op (shown on the proposal card).
export function describeOp(op, model) {
  const quotes = typeof op.evidence === 'string' ? [op.evidence] : Object.values(op.evidence || {});
  const ev = quotes.length ? ` — from ${[...new Set(quotes)].map((q) => `"${q}"`).join(', ')}` : '';
  switch (op.op) {
    case 'ADD_FEATURE': {
      const f = op.feature;
      if (f.mirror) return `Add ${f.id}: mirror of ${f.mirror.of} across ${f.mirror.plane}${f.mirror.pair_by_index ? ', paired one-to-one' : ''}${ev}`;
      const arr = f.array ? `, repeated every ${String(f.array.pitch).replace(/^=/, '')}` : '';
      return `Add ${f.type} ${f.id} on ${f.host} edge ${f.edge}${f.face ? ` (${f.face.toLowerCase()} face)` : ''}${arr}${ev}`;
    }
    case 'ADD_JOINT': {
      const j = op.joint;
      if (!('type' in j)) {
        const show = (v) => (v === undefined ? '—' : isOpenRef(v) ? `OPEN (${v.slice(5)})` : typeof v === 'object' ? JSON.stringify(v) : v);
        return `Join ${j.part} to ${j.links?.map((l) => `${l.child} ↔ ${l.parent}`).join(' and ')}: ${show(j.motion)}${j.axis ? ` about ${j.axis}` : ''}, limits ${show(j.limits)}, method ${show(j.method)}, fit ${show(j.fit)}, assembly ${show(j.assembly)}${ev}`;
      }
      const facts = ['dof', 'assembly_motion', 'anti_rotation'].map((k) => `${k} ${isOpenRef(j[k]) ? `OPEN (${j[k].slice(5)})` : j[k]}`).join(', ');
      return `Connect ${j.links.map((l) => `${l.male} ${j.type === 'INSERTS_INTO' ? 'into' : '↔'} ${l.female}`).join(' and ')}; ${facts}${ev}`;
    }
    case 'ADD_QUESTION': return `Record OPEN question ${op.question.id}: ${op.question.text}`;
    case 'ADD_INTERFACE': { const i = op.interface; return `Add ${i.type} interface ${i.part}.${i.id} (${i.dir})${ev}`; }
    case 'ADD_FASTENER': { const x = op.fastener; return `Add ${x.size} ${x.kind} ${x.id}: through ${x.through?.join(', ')}${x.into ? ` into ${x.into}` : ''} (joint ${x.joint})${ev}`; }
    case 'ADD_VOLUME': { const x = op.volume; return `Add ${x.purpose} volume ${x.id} for ${x.for} on ${x.on}${ev}`; }
    case 'ADD_RULE': return `Add rule ${op.rule.id} ${op.rule.kind}: ${op.rule.text}${ev}`;
    case 'ADD_PART': return `Add part ${op.part.id} (${op.part.kind})${ev}`;
    case 'ADD_PARAM': return `Add parameter ${op.name}${op.param?.status === 'placeholder' ? ` = ${op.param.value} — PLACEHOLDER (assumed, not stated by you)` : ''}`;
    case 'SET': {
      let old;
      try { old = getPath(model, op.path); } catch { old = undefined; }
      return `Change ${op.path.replace(/^(\w+)\//, '')}: ${JSON.stringify(old)} → ${JSON.stringify(op.value)}${ev}`;
    }
    case 'UNSET': return `Remove ${op.path.replace(/^(\w+)\//, '')}${ev}`;
    case 'DELETE': return `Delete ${op.collection.replace(/s$/, '')} ${op.id}${ev}`;
    case 'ANSWER_QUESTION': {
      const how = !Array.isArray(op.facts) ? '' : op.facts.length ? ` — structured as ${op.facts.join(', ')}`
        : ' — STATED: the language cannot hold this as a fact; it keeps blocking SKELETON READY';
      return `Answer ${op.id}: "${op.answer}"${how}${ev}`;
    }
    default: return JSON.stringify(op);
  }
}

// ---------------------------------------------------------------- review
// Human-readable, structured review of a proposal: for every op the target,
// each field with NOW → PROPOSED and the user's words it is based on, plus the
// effect on resolved directions and OPEN questions created / resolved.
// Pure: derived from the accepted model and the evaluation only.

const DIR_WORDS = { '-Z': 'down (−Z)', '+Z': 'up (+Z)', '+X': 'sideways (+X)', '-X': 'sideways (−X)', '+Y': 'sideways (+Y)', '-Y': 'sideways (−Y)' };
const fmt = (v) => (v === undefined ? '—' : isOpenRef(v) ? `OPEN (${v.slice(5)})` : typeof v === 'string' ? v : JSON.stringify(v));

function entityOf(model, coll, id) { return (model[coll] || []).find((x) => x.id === id); }
function hostOf(model, f) { return f?.host ?? (f?.mirror ? hostOf(model, entityOf(model, 'features', f.mirror.of)) : undefined); }
function edgeLabel(model, featureOrHost, edge) {
  const part = entityOf(model, 'parts', featureOrHost);
  return part?.edge_names?.[edge] ? `${edge} (${part.edge_names[edge]})` : edge;
}
function targetLabel(model, coll, id) {
  if (coll === 'features') {
    const f = entityOf(model, 'features', id);
    const type = f?.type ?? (f?.mirror ? entityOf(model, 'features', f.mirror.of)?.type : undefined);
    return `${type ?? 'feature'} ${hostOf(model, f) ?? '?'}.${id}`;
  }
  if (coll === 'params') return `parameter ${id}`;
  return `${COLL_NAME[coll] ?? coll} ${id}`;
}
const COLL_NAME = { parts: 'part', joints: 'joint', rules: 'rule', questions: 'question', meta: 'concept' };

function worldDirections(model) {
  const r = validate(model).resolved;
  const out = new Map();
  for (const inst of r?.instances || []) for (const f of inst.features) {
    if (out.has(f.model_id)) continue;
    out.set(f.model_id, f.direction ?? f.bore_axis ?? (f.compliance_axis ? `±${f.compliance_axis}` : null));
  }
  return out;
}

export function reviewProposal(accepted, ev) {
  const p = ev.proposal;
  if (!p) return { items: [], effects: [], opens: [], resolves: [] };
  const mech = (coll, field) => (accepted.schema === 2 ? isFactField(coll, null, field) : (MECHANICAL[coll] || []).includes(field));
  const items = p.ops.map((op, i) => {
    const facts = concreteFacts(op, accepted);
    const why = (field) => evidenceFor(op, field, facts.length) ?? null;
    const row = (label, coll, field, now, next) => ({ field: label, now: fmt(now), proposed: fmt(next), mechanical: mech(coll, field) || field === 'rule' || field === 'answer',
      evidence: mech(coll, field) || field === 'rule' || field === 'answer' ? (isOpenRef(next) ? null : why(field)) : null, open: isOpenRef(next) ? next.slice(5) : null });
    const base = { n: i + 1, op: op.op };
    switch (op.op) {
      case 'SET': case 'UNSET': {
        const { collection, id, field, sub } = parsePath(op.path);
        let now; try { now = getPath(accepted, op.path); } catch { now = undefined; }
        const name = [field, ...sub].join('.');
        const host = collection === 'features' ? hostOf(accepted, entityOf(accepted, 'features', id)) : null;
        const atText = (v) => (v && typeof v === 'object' && v.from ? `flush with the ${edgeLabel(accepted, host, v.from)} end${v.offset ? ` + ${v.offset}` : ''}` : v);
        const shown = collection === 'features' && field === 'edge' ? [edgeLabel(accepted, host, now), edgeLabel(accepted, host, op.value)]
          : collection === 'features' && field === 'at' && !sub.length ? [atText(now), atText(op.value)] : [now, op.value];
        return { ...base, kind: 'CHANGE', target: targetLabel(accepted, collection, id), rows: [row(name, collection, field, shown[0], op.op === 'UNSET' ? undefined : shown[1])] };
      }
      case 'ADD_FEATURE': {
        const f = op.feature;
        const rows = f.mirror ? [row('mirror of', 'features', 'mirror', undefined, `${f.mirror.of} across ${f.mirror.plane}${f.mirror.pair_by_index ? ', paired 1:1' : ''}`)]
          : (MECHANICAL.features.filter((k) => f[k] !== undefined).map((k) => row(k, 'features', k, undefined, k === 'edge' ? edgeLabel(accepted, f.host, f.edge) : f[k])));
        if (f.array) rows.push(row('repeat', 'features', 'array', undefined, `every ${String(f.array.pitch).replace(/^=/, '')}, margin ${String(f.array.margin).replace(/^=/, '')}`));
        const src = entityOf(ev.candidate ?? accepted, 'features', f.mirror?.of);
        return { ...base, kind: 'ADD', target: `${f.type ?? src?.type ?? 'feature'} ${f.host ?? hostOf(ev.candidate ?? accepted, src) ?? '?'}.${f.id}`, rows };
      }
      case 'ADD_JOINT': {
        const j = op.joint;
        const v2Keys = ['motion', 'links', 'axis', 'limits', 'method', 'fit', 'assembly', 'anti_rotation', 'fasteners'];
        const rows = ('type' in j ? ['type', 'links', 'dof', 'fit', 'assembly_motion', 'anti_rotation'] : v2Keys).filter((k) => j[k] !== undefined)
          .map((k) => row(k, 'joints', k, undefined, k === 'links' ? j.links.map((l) => (l.male ? `${l.male} → ${l.female}` : `${l.child} ↔ ${l.parent}`)).join('; ') : j[k]));
        return { ...base, kind: 'ADD', target: `joint ${j.id} (${j.part})`, rows };
      }
      case 'ADD_PART': return { ...base, kind: 'ADD', target: `part ${op.part.id}`, rows: MECHANICAL.parts.filter((k) => op.part[k] !== undefined).map((k) => row(k, 'parts', k, undefined, op.part[k])) };
      case 'ADD_INTERFACE': case 'ADD_FASTENER': case 'ADD_VOLUME': {
        const coll = { ADD_INTERFACE: 'interfaces', ADD_FASTENER: 'fasteners', ADD_VOLUME: 'volumes' }[op.op];
        const e = op[coll.slice(0, -1)];
        return { ...base, kind: 'ADD', target: `${coll.slice(0, -1)} ${e.id}`,
          rows: Object.keys(e).filter((k) => k !== 'id').map((k) => row(k, coll, k, undefined, e[k])) };
      }
      case 'ADD_QUESTION': return { ...base, kind: 'OPEN', target: `question ${op.question.id}`, rows: [{ field: 'asks', now: '—', proposed: op.question.text, mechanical: false, evidence: null, open: op.question.id }] };
      case 'ANSWER_QUESTION': {
        const rows = [row('answer', 'questions', 'answer', 'OPEN', op.answer)];
        if (Array.isArray(op.facts)) rows.push({ field: 'structured as', now: '—', mechanical: false, evidence: null, open: op.facts.length ? null : op.id,
          proposed: op.facts.length ? op.facts.join(', ') : 'STATED — not a structured fact; still blocks SKELETON READY' });
        return { ...base, kind: 'ANSWER', target: `question ${op.id}`, rows };
      }
      case 'ADD_RULE': return { ...base, kind: 'RULE', target: `rule ${op.rule.id} (${op.rule.kind})`, rows: [row('rule', 'rules', 'rule', undefined, op.rule.text)] };
      case 'ADD_PARAM': return { ...base, kind: 'ADD', target: `parameter ${op.name}`, rows: [{ ...row('value', 'params', 'value', undefined, op.param.value ?? `= ${op.param.expr}`),
        ...(op.param.status === 'placeholder' ? { placeholder: true, proposed: `${op.param.value} (PLACEHOLDER — assumed, not stated by you)` } : {}) }] };
      case 'DELETE': return { ...base, kind: 'REMOVE', target: targetLabel(accepted, op.collection, op.id), rows: [] };
      default: return { ...base, kind: op.op, target: '?', rows: [] };
    }
  });
  const effects = [];
  if (ev.candidate) {
    const a = worldDirections(accepted), c = worldDirections(ev.candidate);
    for (const [id, d] of c) {
      const before = a.get(id);
      if (before !== d) effects.push({ target: id, now: before ? DIR_WORDS[before] ?? before : 'does not exist', proposed: DIR_WORDS[d] ?? d });
    }
    for (const [id, d] of a) if (!c.has(id)) effects.push({ target: id, now: DIR_WORDS[d] ?? d, proposed: 'removed' });
  }
  return { items, effects, opens: ev.newOpen ?? [], resolves: ev.answered ?? [] };
}
