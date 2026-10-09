// Edit scope: what a transaction may change, and the guard that proves it.
//
// The enforcement scope is DERIVED deterministically from the validated closed
// ops and the accepted model (deriveScope). It is never taken from an
// interpreter or language model: an AI may name semantic targets, but those
// only have to be consistent with its own edits — they never authorize a change.
// A UI/caller may additionally pass a narrower scope; both must hold.
//
// Paths use the same stable entity notation as ops:
//   parts/BRACKET_L
//   joints/J_L/assembly/removable
//   features/H1/offset
//
// Arrays of entities are compared by id, so moving BRACKET_L can never be
// hidden as "the parts array changed". Runtime-only freeze state is ignored:
// every accepted mechanical edit intentionally returns the concept to DRAFT.

import { parseExpr, exprNames } from './model.js?v=88a79953eb30';

const IGNORED_ROOTS = new Set(['freeze', 'resolved', 'history']);

const isObject = (v) => v !== null && typeof v === 'object';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const join = (base, key) => base ? `${base}/${key}` : String(key);

function entityArray(v) {
  return Array.isArray(v) && v.every((x) => isObject(x) && typeof x.id === 'string');
}

function diffInto(before, after, path, out) {
  if (same(before, after)) return;

  if (!path && ((before === undefined && after !== undefined) || (before !== undefined && after === undefined))) {
    out.add(path || '<root>');
    return;
  }

  if (entityArray(before) && entityArray(after)) {
    const a = new Map(before.map((x) => [x.id, x]));
    const b = new Map(after.map((x) => [x.id, x]));
    const ids = [...new Set([...a.keys(), ...b.keys()])].sort();
    for (const id of ids) {
      const p = join(path, id);
      if (!a.has(id) || !b.has(id)) out.add(p);
      else diffInto(a.get(id), b.get(id), p, out);
    }
    return;
  }

  if (Array.isArray(before) || Array.isArray(after)) {
    out.add(path);
    return;
  }

  if (isObject(before) && isObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const key of keys) {
      if (!path && IGNORED_ROOTS.has(key)) continue;
      const hasA = Object.hasOwn(before, key), hasB = Object.hasOwn(after, key);
      // an absent entity collection is the empty collection: creating the first
      // entity changes that entity's path, not the whole collection
      if (hasA && hasB) diffInto(before[key], after[key], join(path, key), out);
      else if (!hasA && entityArray(after[key])) diffInto([], after[key], join(path, key), out);
      else if (!hasB && entityArray(before[key])) diffInto(before[key], [], join(path, key), out);
      else out.add(join(path, key));
    }
    return;
  }

  out.add(path);
}

export function changedPaths(before, after) {
  const out = new Set();
  diffInto(before, after, '', out);
  return [...out].filter(Boolean).sort();
}

export function normalizeScope(scope) {
  if (!scope || typeof scope !== 'object') throw new Error('scope is required');
  if (!Array.isArray(scope.allow) || scope.allow.length === 0) throw new Error('scope.allow must be a non-empty list');
  const allow = scope.allow.map((p) => {
    if (typeof p !== 'string' || !p.trim() || p.startsWith('/') || p.endsWith('/') || p.includes('//')) {
      throw new Error(`invalid scope path ${JSON.stringify(p)}`);
    }
    return p.trim();
  });
  return Object.freeze({ allow: [...new Set(allow)].sort(), label: typeof scope.label === 'string' ? scope.label : '' });
}

const coveredBy = (path, prefix) => path === prefix || path.startsWith(`${prefix}/`);

export function checkProtectedRemainder(before, after, scope) {
  const s = normalizeScope(scope);
  const changed = changedPaths(before, after);
  const forbidden = changed.filter((p) => !s.allow.some((a) => coveredBy(p, a)));
  return {
    ok: forbidden.length === 0,
    allow: s.allow,
    changed,
    forbidden,
  };
}

// Convenience for a deterministic UI/compiler that wants to authorize a whole
// existing entity. Field-level scopes are preferred whenever the intent already
// identifies the field being edited.
export function entityScope(collection, id, label = '') {
  if (typeof collection !== 'string' || typeof id !== 'string' || !collection || !id) throw new Error('entityScope needs collection and id');
  return normalizeScope({ allow: [`${collection}/${id}`], label });
}

// ---------------------------------------------------------------- derived scope
const ENTITY_COLLECTIONS = ['parts', 'interfaces', 'features', 'joints', 'fasteners', 'volumes', 'rules', 'questions'];
const ADD_COLLECTION = { ADD_PART: 'parts', ADD_FEATURE: 'features', ADD_JOINT: 'joints', ADD_RULE: 'rules', ADD_QUESTION: 'questions',
  ADD_INTERFACE: 'interfaces', ADD_FASTENER: 'fasteners', ADD_VOLUME: 'volumes' };
const ADD_KEY = { parts: 'part', features: 'feature', joints: 'joint', rules: 'rule', questions: 'question',
  interfaces: 'interface', fasteners: 'fastener', volumes: 'volume' };

// id -> "collection/id" for every existing entity, and every parameter name.
function index(model) {
  const ids = new Map();
  for (const c of ENTITY_COLLECTIONS) for (const e of model[c] || []) if (typeof e?.id === 'string') ids.set(e.id, `${c}/${e.id}`);
  const params = new Set(Object.keys(model.params || {}));
  return { ids, params };
}

// Existing entities and parameters a value refers to: entity ids inside
// "PART.FEATURE[i]", "PART.+Z", "OPEN:Q3", and parameter names inside "=expr".
function referencesIn(value, idx, out = new Set()) {
  if (Array.isArray(value)) { for (const v of value) referencesIn(v, idx, out); return out; }
  if (value && typeof value === 'object') { for (const v of Object.values(value)) referencesIn(v, idx, out); return out; }
  if (typeof value !== 'string') return out;
  if (value.startsWith('=')) {
    try { for (const n of exprNames(parseExpr(value.slice(1)))) if (idx.params.has(n)) out.add(`params/${n}`); } catch { /* invalid expr: reported by the validator */ }
    return out;
  }
  for (const token of value.split(/[.:[\]\s]+/)) if (idx.ids.has(token)) out.add(idx.ids.get(token));
  return out;
}

// SET parts/X/size/0 changes the array parts/X/size as a value (changedPaths
// compares non-entity arrays as a whole), so the allowed path is the field.
const fieldPath = (path) => {
  const segs = path.split('/');
  while (segs.length > 3 && /^\d+$/.test(segs.at(-1))) segs.pop();
  return segs.join('/');
};

// deriveScope(accepted, ops) -> { allow, affects }
//   allow   — the only model paths the transaction may change (protected-remainder guard);
//   affects — existing entities/parameters the change refers to or depends on. They are
//             NOT changed (the guard proves it) but the user sees them, e.g. the part a
//             new joint attaches, the source of a mirror, a parameter used by a new feature.
// Rules per closed op:
//   SET/UNSET path         allow the path (array element -> its field); affects: references in the new value
//   ADD_PARAM name          allow params/<name>; affects: parameters its expr uses
//   ADD_<entity> e          allow <collection>/<e.id>; affects: every existing id / parameter e references
//   DELETE c/id             allow c/id; affects: existing entities that reference id
//   ANSWER_QUESTION id      allow questions/<id>; affects: the entities its facts name
// `extraAffects` lets a compiler add references that are not visible in the op
// itself (e.g. the source part of a deterministic mirror).
export function deriveScope(accepted, ops, extraAffects = []) {
  if (!Array.isArray(ops) || !ops.length) throw new Error('a scope is derived from at least one op');
  const idx = index(accepted);
  const allow = new Set(), affects = new Set(extraAffects);
  for (const op of ops) {
    if (op.op === 'SET' || op.op === 'UNSET') {
      allow.add(fieldPath(op.path));
      referencesIn(op.value, idx, affects);
    } else if (op.op === 'ADD_PARAM') {
      allow.add(`params/${op.name}`);
      referencesIn(op.param, idx, affects);
    } else if (ADD_COLLECTION[op.op]) {
      const coll = ADD_COLLECTION[op.op];
      const e = op[ADD_KEY[coll]];
      allow.add(`${coll}/${e?.id}`);
      referencesIn(e, idx, affects);
    } else if (op.op === 'DELETE') {
      allow.add(`${op.collection}/${op.id}`);
      for (const c of ENTITY_COLLECTIONS) for (const e of accepted[c] || []) {
        if (e.id !== op.id && referencesIn(e, { ids: new Map([[op.id, op.id]]), params: new Set() }).size) affects.add(`${c}/${e.id}`);
      }
    } else if (op.op === 'ANSWER_QUESTION') {
      allow.add(`questions/${op.id}`);
      for (const f of op.facts || []) { const [c, id] = String(f).split('/'); if (c && id) affects.add(`${c}/${id}`); }
    } else {
      throw new Error(`no scope rule for op ${JSON.stringify(op.op)}`);
    }
  }
  const allowList = [...allow].sort();
  const affectList = [...affects].filter((a) => !allowList.some((p) => coveredBy(a, p) || coveredBy(p, a))).sort();
  return { allow: allowList, affects: affectList };
}
