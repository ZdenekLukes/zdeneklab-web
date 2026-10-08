// Accepted-revision history. A session is an immutable value: accept/checkout/
// freeze return a new session; reject returns the very same object. Each
// revision stores its canonical model, so restoring is exact; the exported
// history (root + ops) replays deterministically to the same hashes.

import { canonical, conceptHash, legacyConceptHashV1, loadConcept } from './model.js?v=d776a80047f5';
import { validate, freezeConcept } from './validate.js?v=d776a80047f5';
import { applyOps } from './ops.js?v=d776a80047f5';
import { evaluateProposal, attachUtteranceEvidence, PROPOSAL_FORMAT } from './proposal.js?v=d776a80047f5';
import { evaluateLiveIntent } from './live_edit.js?v=d776a80047f5';
import { deriveScope, checkProtectedRemainder } from './scope.js?v=d776a80047f5';
import { exportAll } from './export.js?v=d776a80047f5';

// Exported history format. Format 1 (no `format` key) is what the app wrote
// before 2026-10-03 (main ≤ f625e61); format 2 is written from Phase 1.1 on.
export const HISTORY_FORMAT = 2;
// Provenance marker for a revision that the pre-2026-10-03 product accepted but
// the current transaction boundary refuses. See importSession.
export const LEGACY_POLICY = 'accepted-before-2026-10-03';

const deepFreeze = (o) => { Object.values(o).forEach((v) => v && typeof v === 'object' && deepFreeze(v)); return Object.freeze(o); };
const strip = (model) => { const { history, resolved, ...m } = model; return m; };

// Each revision stores its model as exact JSON in authored key order (so exports
// read like the authored file); identity and integrity use the canonical hash.
function entry(model, fields) {
  return { ...fields, revision: model.meta.revision, hash: conceptHash(model), model: JSON.stringify(model) };
}

// No model becomes an accepted revision before schema + semantic validation
// succeeds: an invalid start model is refused, never silently accepted.
export function createSession(model, { summary = 'start', source = 'import' } = {}) {
  let m;
  try { m = strip(loadConcept(model)); } catch (e) { throw new Error(`model is not readable JSON: ${e.message}`); }
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error('model must be a JSON object');
  if (!Number.isInteger(m.meta?.revision)) throw new Error('model needs meta.revision');
  const v = validate(m);
  if (v.errors.length) throw new Error(`model is invalid: ${v.errors.join('; ')}`);
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

// F3 invariant: only a valid, exportable model enters the history.
function assertExportable(model, what) {
  const v = validate(model);
  if (v.errors.length) throw new Error(`${what} is invalid: ${v.errors.join('; ')}`);
  try { exportAll(model, v, `${artifactBase(model)}.aiconcept`); } catch (e) { throw new Error(`${what} is not exportable: ${e.message}`); }
  return v;
}

export function evaluate(s, proposalText, opts = {}) {
  return evaluateProposal(acceptedModel(s), proposalText, opts);
}

// Live Intent / Property Editor: compiled to closed ops and evaluated by the
// same evaluator as every proposal (src/live_edit.js). opts.utterance is the
// user's own words (required); opts.base the revision the intent was made for.
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
  assertExportable(model, 'accepted revision');
  const said = ev.proposal.utterance_id ? { utterance_id: ev.proposal.utterance_id, ...(ev.proposal.context?.length ? { context: ev.proposal.context } : {}) } : {};
  const rev = entry(model, { parent: s.head, kind: 'ops', summary: ev.proposal.summary, source: ev.proposal.source ?? null,
    utterance: ev.proposal.utterance, ...said, ops: ev.proposal.ops });
  return deepFreeze({ root: s.root, head: rev.revision, revisions: [...s.revisions, rev] });
}

// Live ACCEPT is the same transaction: re-evaluated from the current accepted
// head through the common evaluator. History stores the evaluated closed ops
// (with the user's words as their evidence) for exact replay, the compact intent
// for inspection, and the derived scope; the LLM output is never a replacement model.
export function acceptLive(s, intentText, opts = {}) {
  const ev = evaluateLive(s, intentText, opts);
  if (ev.status !== 'VALID') {
    const e = new Error(`cannot accept a ${ev.status} live intent: ${ev.errors.join('; ')}`);
    e.evaluation = ev;
    throw e;
  }
  const model = applyOps(acceptedModel(s), ev.proposal.ops);
  model.meta.revision = nextRevision(s);
  model.freeze = { state: 'DRAFT' };
  assertExportable(model, 'accepted live revision');
  const rev = entry(model, {
    parent: s.head,
    kind: 'live_ops',
    summary: ev.proposal.summary,
    source: ev.proposal.source ?? 'live-intent',
    utterance: ev.proposal.utterance,
    ops: ev.proposal.ops,
    intent: ev.intent,
    scope: { allow: ev.scope.allow, affects: ev.scope.affects },
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
  model.history = { format: HISTORY_FORMAT, root: JSON.parse(s.root), head: s.head, revisions: history(s).slice(1) };
  return JSON.stringify(model, null, 2) + '\n';
}

// Import replays the whole history through the same transaction boundary that
// accepted it. Every revision (ordinary proposal or Live intent, schema 1 or 2)
// must evaluate VALID against its parent, stay inside its derived scope, validate,
// export and reproduce its recorded hash. Anything else fails explicitly; nothing
// is repaired or replaced. Histories exported before hash v2 record hash v1
// values: those are accepted as replay checks only, and the session continues
// with v2 hashes (the final model comparison still covers the whole file).
//
// Bounded migration of history format 1 (files written before 2026-10-03, when
// the Live path accepted under weaker rules): a revision that the current
// boundary refuses is replayed under the rules the product applied then —
// its recorded ops apply with the one reducer, stay inside their derived scope,
// the resulting model validates and exports, and it reproduces its recorded
// hash. It is kept exactly as accepted and marked `legacy` (policy, and why the
// current rules refuse it). This admits no state that a validated plain model
// would not, invents nothing, and changes no current rule: new edits always use
// the current boundary. A format-2 export keeps the marker so the revision
// replays the same way again. Unknown formats, invalid states, broken hashes
// and unknown markers are refused.
export function importSession(text, opts = {}) {
  let file;
  try { file = loadConcept(text); } catch (e) { throw new Error(`file is not readable JSON: ${e.message}`); }
  if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error('file must be a JSON object');
  if (!file.history) return createSession(file, opts);
  const h = file.history;
  if (!h || typeof h !== 'object' || !Array.isArray(h.revisions) || !h.root) throw new Error('history must have root and revisions');
  if (h.format !== undefined && h.format !== HISTORY_FORMAT) throw new Error(`unsupported history format ${JSON.stringify(h.format)}`);
  const formatOne = h.format === undefined;
  let s;
  try { s = createSession(h.root); } catch (e) { throw new Error(`history root: ${e.message}`); }
  for (const r of h.revisions) {
    if (!r || typeof r !== 'object') throw new Error('history revision must be an object');
    if (s.revisions.some((x) => x.revision === r.revision)) throw new Error(`history revision ${r.revision} is duplicated`);
    let parent;
    try { parent = acceptedModel(checkout(s, r.parent)); } catch (e) { throw new Error(`history revision ${r.revision}: ${e.message}`); }
    let model, scope = r.scope, legacy;
    if (r.legacy !== undefined && r.legacy?.policy !== LEGACY_POLICY) throw new Error(`history revision ${r.revision} has an unknown legacy marker`);
    if (r.kind === 'ops' || r.kind === 'live_ops') {
      if (!Array.isArray(r.ops) || !r.ops.length) throw new Error(`history revision ${r.revision} has no ops`);
      const legacyAllowed = formatOne || r.legacy?.policy === LEGACY_POLICY;
      const said = typeof r.utterance === 'string' && r.utterance.trim();
      if (!said && !legacyAllowed) throw new Error(`history revision ${r.revision} has no user utterance`);
      const again = said ? evaluateProposal(parent, JSON.stringify({ format: PROPOSAL_FORMAT, schema: 1,
        base: { revision: parent.meta.revision, hash: conceptHash(parent) }, utterance: r.utterance, summary: r.summary ?? '', source: r.source ?? 'import',
        ...(r.utterance_id ? { utterance_id: r.utterance_id } : {}), ...(r.context ? { context: r.context } : {}),
        ops: r.kind === 'live_ops' ? attachUtteranceEvidence(parent, r.ops, r.utterance) : r.ops })) : null;
      if (again?.status === 'VALID') {
        if (r.kind === 'live_ops') scope = { allow: again.scope.allow, affects: again.scope.affects };
        if (r.legacy) legacy = r.legacy;
        model = applyOps(parent, r.ops);
      } else if (legacyAllowed) {
        try { model = applyOps(parent, r.ops); } catch (e) { throw new Error(`history revision ${r.revision} does not apply: ${e.message}`); }
        const derived = deriveScope(parent, r.ops);
        const guard = checkProtectedRemainder(parent, { ...model, freeze: parent.freeze }, derived);
        if (!guard.ok) throw new Error(`history revision ${r.revision} changes ${guard.forbidden.join(', ')} outside its ops`);
        if (r.kind === 'live_ops') scope = { allow: derived.allow, affects: derived.affects };
        legacy = r.legacy ?? { policy: LEGACY_POLICY, refused_now: (again ? again.errors : ['no user utterance recorded']).slice(0, 3) };
      } else {
        throw new Error(`history revision ${r.revision} is not a valid proposal: ${again.errors.join('; ')}`);
      }
      model.meta.revision = r.revision;
      model.freeze = { state: 'DRAFT' };
    } else if (r.kind === 'freeze') {
      model = parent;
      model.meta.revision = r.revision;
      const f = freezeConcept(model, r.at);
      if (!f.ok) throw new Error(`history revision ${r.revision} does not freeze: ${f.errors.join('; ')}`);
      model = f.model;
    } else throw new Error(`unknown history kind "${r.kind}"`);
    assertExportable(model, `history revision ${r.revision}`);
    const e = entry(model, { parent: r.parent, kind: r.kind, summary: r.summary, source: r.source, utterance: r.utterance,
      ...(r.utterance_id ? { utterance_id: r.utterance_id } : {}), ...(r.context ? { context: r.context } : {}), ops: r.ops,
      ...(r.intent ? { intent: r.intent } : {}), ...(scope ? { scope } : {}), ...(r.at ? { at: r.at } : {}), ...(legacy ? { legacy } : {}) });
    if (e.hash !== r.hash && legacyConceptHashV1(model) !== r.hash) throw new Error(`history does not replay: revision ${r.revision} hash ${e.hash} ≠ recorded ${r.hash}`);
    s = deepFreeze({ root: s.root, head: e.revision, revisions: [...s.revisions, e] });
  }
  let s2;
  try { s2 = checkout(s, h.head); } catch (e) { throw new Error(`history head: ${e.message}`); }
  const replayed = acceptedModel(s2), stated = strip(file);
  if (canonical(replayed) !== canonical(stated) && !legacyFreezeOnly(replayed, stated)) throw new Error('exported model does not equal its replayed head revision');
  return s2;
}

// A head frozen before hash v2 records freeze.hash v1. It is the same model when
// that is the only difference and the recorded value is the v1 hash of the file.
function legacyFreezeOnly(replayed, stated) {
  if (!replayed.freeze?.hash || !stated.freeze?.hash || stated.freeze.hash !== legacyConceptHashV1(stated)) return false;
  const a = structuredClone(replayed), b = structuredClone(stated);
  delete a.freeze.hash; delete b.freeze.hash;
  return canonical(a) === canonical(b);
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
      revision: n, parent: r.parent, summary: r.summary, kind: r.kind, utterance: r.utterance, hash: r.hash, legacy: Boolean(r.legacy),
      current: n === s.head, onCurrentLine: line.has(n), branch,
      text: `REV ${n}${r.parent === null ? ' (start)' : ` · parent REV ${r.parent}${branch ? ` — branch: continues from REV ${r.parent}, not from REV ${prev}` : ''}`}`
        + `${children.length > 1 ? ` · ${children.length} continuations: REV ${children.join(', REV ')}` : ''}`
        + `${line.has(n) ? '' : ' · not part of the current concept'}${n === s.head ? ' · CURRENT' : ''}`,
    };
  });
}
