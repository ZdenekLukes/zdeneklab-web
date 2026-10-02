// Accepted-revision history. A session is an immutable value: accept/checkout/
// freeze return a new session; reject returns the very same object. Each
// revision stores its canonical model, so restoring is exact; the exported
// history (root + ops) replays deterministically to the same hashes.

import { canonical, conceptHash, loadConcept } from './model.js';
import { validate, freezeConcept } from './validate.js';
import { applyOps } from './ops.js';
import { evaluateProposal, PROPOSAL_FORMAT } from './proposal.js';
import { evaluateLiveIntent } from './live_edit.js';
import { exportAll } from './export.js';

const deepFreeze = (o) => { Object.values(o).forEach((v) => v && typeof v === 'object' && deepFreeze(v)); return Object.freeze(o); };
const strip = (model) => { const { history, resolved, ...m } = model; return m; };

// Each revision stores its model as exact JSON in authored key order (so exports
// read like the authored file); identity and integrity use the canonical hash.
function entry(model, fields) {
  return { ...fields, revision: model.meta.revision, hash: conceptHash(model), model: JSON.stringify(model) };
}

export function createSession(model, { summary = 'start', source = 'import' } = {}) {
  const m = strip(loadConcept(model));
  if (!Number.isInteger(m.meta?.revision)) throw new Error('model needs meta.revision');
  const first = entry(m, { parent: null, kind: 'root', summary, source, utterance: null, ops: [] });
  return deepFreeze({ root: first.model, head: first.revision, revisions: [first] });
}

const headEntry = (s) => s.revisions.find((r) => r.revision === s.head);
// exact stored JSON of the accepted model (byte-identity checks use this)
export const acceptedCanonical = (s) => headEntry(s).model;
export const acceptedModel = (s) => JSON.parse(acceptedCanonical(s));   // always a fresh copy
export const history = (s) => s.revisions.map(({ model, ...r }) => r);
const nextRevision = (s) => Math.max(...s.revisions.map((r) => r.revision)) + 1;
const artifactBase = (model) => `${model.meta.id}-rev${model.meta.revision}`;

// F3 invariant: a valid revision that enters the history can always be exported.
function assertExportable(model, what) {
  const v = validate(model);
  if (v.errors.length) return v;
  try { exportAll(model, v, `${artifactBase(model)}.aiconcept`); } catch (e) { throw new Error(`${what} is not exportable: ${e.message}`); }
  return v;
}

export function evaluate(s, proposalText, opts = {}) {
  return evaluateProposal(acceptedModel(s), proposalText, opts);
}

// Product-path evaluator: compact Live Intent -> deterministic closed ops.
// The intent never mutates the accepted session; ACCEPT re-runs this evaluator.
export function evaluateLive(s, intentText, opts = {}) {
  return evaluateLiveIntent(acceptedModel(s), intentText, opts);
}

// ACCEPT re-evaluates the proposal text against the current accepted model;
// it never trusts an earlier evaluation or candidate object.
export function accept(s, proposalText, opts = {}) {
  const ev = evaluate(s, proposalText, opts);
  if (ev.status !== 'VALID') {
    const e = new Error(`cannot accept a ${ev.status} proposal: ${ev.errors.join('; ')}`);
    e.evaluation = ev;
    throw e;
  }
  const model = applyOps(acceptedModel(s), ev.proposal.ops);
  model.meta.revision = nextRevision(s);
  model.freeze = { state: 'DRAFT' };
  const v = assertExportable(model, 'accepted revision');
  if (v.errors.length) throw new Error(`accepted model would not validate: ${v.errors.join('; ')}`);
  const said = ev.proposal.utterance_id ? { utterance_id: ev.proposal.utterance_id, ...(ev.proposal.context?.length ? { context: ev.proposal.context } : {}) } : {};
  const rev = entry(model, { parent: s.head, kind: 'ops', summary: ev.proposal.summary, source: ev.proposal.source ?? null,
    utterance: ev.proposal.utterance, ...said, ops: ev.proposal.ops });
  return deepFreeze({ root: s.root, head: rev.revision, revisions: [...s.revisions, rev] });
}

// Live ACCEPT is also atomic and re-evaluated from the current accepted head.
// History stores the compiled closed ops for exact replay and the compact intent
// for inspection; the LLM output is never a replacement model.
export function acceptLive(s, intentText, opts = {}) {
  const ev = evaluateLive(s, intentText, opts);
  if (ev.status !== 'VALID') {
    const e = new Error(`cannot accept a ${ev.status} live intent: ${ev.errors.join('; ')}`);
    e.evaluation = ev;
    throw e;
  }
  const model = applyOps(acceptedModel(s), ev.ops);
  model.meta.revision = nextRevision(s);
  model.freeze = { state: 'DRAFT' };
  const v = assertExportable(model, 'accepted live revision');
  if (v.errors.length) throw new Error(`accepted live model would not validate: ${v.errors.join('; ')}`);
  const rev = entry(model, {
    parent: s.head,
    kind: 'live_ops',
    summary: ev.intent.summary,
    source: 'live-intent',
    utterance: ev.intent.utterance ?? null,
    ops: ev.ops,
    intent: ev.intent,
    scope: ev.scope ? { allow: ev.scope.allow, label: ev.scope.label } : null,
  });
  return deepFreeze({ root: s.root, head: rev.revision, revisions: [...s.revisions, rev] });
}

// REJECT: the accepted model and the session are unchanged (same object).
export function reject(s) { return s; }

// Restore: the head moves to an earlier accepted revision; its model is exact.
export function checkout(s, revision) {
  if (!s.revisions.some((r) => r.revision === revision)) throw new Error(`no revision ${revision}`);
  return deepFreeze({ ...s, head: revision });
}

// FREEZE CONCEPT is a user command, not an AI op.
export function freeze(s, at) {
  const m = acceptedModel(s);
  m.meta.revision = nextRevision(s);
  const r = freezeConcept(m, at);
  if (!r.ok) throw new Error(`cannot freeze: ${r.errors.join('; ')}`);
  assertExportable(r.model, 'frozen revision');
  const rev = entry(r.model, { parent: s.head, kind: 'freeze', summary: 'CONCEPT FREEZE', source: 'user', utterance: null, ops: [], at });
  return deepFreeze({ root: s.root, head: rev.revision, revisions: [...s.revisions, rev] });
}

// .aiconcept with replayable history (history is not part of the hash).
export function exportSession(s) {
  const model = acceptedModel(s);
  model.history = { root: JSON.parse(s.root), head: s.head, revisions: history(s).slice(1) };
  return JSON.stringify(model, null, 2) + '\n';
}

export function importSession(text) {
  const file = loadConcept(text);
  if (!file.history) return createSession(file);
  let s = createSession(file.history.root);
  for (const r of file.history.revisions) {
    let model = acceptedModel(checkout(s, r.parent));
    if (r.kind === 'ops' && model.schema === 2) {
      // schema 2: a history revision must pass the same transaction boundary as a live proposal
      const again = evaluateProposal(model, JSON.stringify({ format: PROPOSAL_FORMAT, schema: 1,
        base: { revision: model.meta.revision, hash: conceptHash(model) }, utterance: r.utterance, summary: r.summary, source: r.source ?? 'import',
        ...(r.utterance_id ? { utterance_id: r.utterance_id } : {}), ...(r.context ? { context: r.context } : {}), ops: r.ops }));
      if (again.status !== 'VALID') throw new Error(`history revision ${r.revision} is not a valid proposal: ${again.errors.join('; ')}`);
    }
    if (r.kind === 'ops' || r.kind === 'live_ops') {
      model = applyOps(model, r.ops);
      model.meta.revision = r.revision;
      model.freeze = { state: 'DRAFT' };
    } else if (r.kind === 'freeze') {
      model.meta.revision = r.revision;
      const f = freezeConcept(model, r.at);
      if (!f.ok) throw new Error(`history revision ${r.revision} does not freeze: ${f.errors.join('; ')}`);
      model = f.model;
    } else throw new Error(`unknown history kind "${r.kind}"`);
    assertExportable(model, `history revision ${r.revision}`);
    const e = entry(model, { parent: r.parent, kind: r.kind, summary: r.summary, source: r.source, utterance: r.utterance,
      ...(r.utterance_id ? { utterance_id: r.utterance_id } : {}), ...(r.context ? { context: r.context } : {}), ops: r.ops,
      ...(r.intent ? { intent: r.intent } : {}), ...(r.scope ? { scope: r.scope } : {}), ...(r.at ? { at: r.at } : {}) });
    if (e.hash !== r.hash) throw new Error(`history does not replay: revision ${r.revision} hash ${e.hash} ≠ recorded ${r.hash}`);
    s = deepFreeze({ root: s.root, head: e.revision, revisions: [...s.revisions, e] });
  }
  const s2 = checkout(s, file.history.head);
  if (canonical(acceptedModel(s2)) !== canonical(strip(file))) throw new Error('exported model does not equal its replayed head revision');
  return s2;
}

// Downloads from the ACCEPTED model only, through the canonical S0 exporters.
// Pending proposals live outside the session, so they cannot reach these.
export function acceptedArtifacts(s) {
  const model = acceptedModel(s);
  const v = validate(model);
  const base = artifactBase(model);
  const out = { [`${base}.aiconcept`]: exportSession(s) };
  if (v.resolved) {
    const x = exportAll(model, v, `${base}.aiconcept`);
    out[`${base}.concept_contract.md`] = x.contract;
    out[`${base}.coder_prompt.md`] = x.prompt;
    out[`${base}.skeleton_spec.json`] = x.spec;
  }
  return out;
}

// Plain-text parentage for the history list (no graphical tree).
export function historyView(s) {
  const byRev = new Map(s.revisions.map((r) => [r.revision, r]));
  const line = new Set();
  for (let r = byRev.get(s.head); r; r = byRev.get(r.parent)) line.add(r.revision);
  const ordered = s.revisions.map((r) => r.revision).sort((a, b) => a - b);
  return ordered.map((n) => {
    const r = byRev.get(n);
    const prev = ordered[ordered.indexOf(n) - 1];
    const branch = r.parent !== null && r.parent !== prev;
    const children = s.revisions.filter((c) => c.parent === n).map((c) => c.revision);
    return {
      revision: n, parent: r.parent, summary: r.summary, kind: r.kind, utterance: r.utterance, hash: r.hash,
      current: n === s.head, onCurrentLine: line.has(n), branch,
      text: `REV ${n}${r.parent === null ? ' (start)' : ` · parent REV ${r.parent}${branch ? ` — branch: continues from REV ${r.parent}, not from REV ${prev}` : ''}`}`
        + `${children.length > 1 ? ` · ${children.length} continuations: REV ${children.join(', REV ')}` : ''}`
        + `${line.has(n) ? '' : ' · not part of the current concept'}${n === s.head ? ' · CURRENT' : ''}`,
    };
  });
}
