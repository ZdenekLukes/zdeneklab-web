// The closed op vocabulary and the reducer. applyOps() is the only code that
// changes a concept model. It is pure: it returns a new model and never
// touches its input. Unknown ops, unknown ids, non-whitelisted paths and
// duplicate ids throw — nothing is ever guessed or created implicitly.
// For `schema: 2` models every added entity and every SET is checked against
// the closed schema table (src/schema.js): an undeclared key never enters.

import { checkEntity, settable as settableV2 } from './schema.js?v=82722beda481';

export const OPS = ['ADD_PARAM', 'ADD_PART', 'ADD_FEATURE', 'ADD_JOINT', 'ADD_RULE', 'ADD_QUESTION',
  'SET', 'UNSET', 'DELETE', 'ANSWER_QUESTION', 'ADD_INTERFACE', 'ADD_FASTENER', 'ADD_VOLUME'];

const COLLECTIONS = { parts: 'part', features: 'feature', joints: 'joint', rules: 'rule', questions: 'question',
  interfaces: 'interface', fasteners: 'fastener', volumes: 'volume' };
const ADD = { ADD_PART: 'parts', ADD_FEATURE: 'features', ADD_JOINT: 'joints', ADD_RULE: 'rules', ADD_QUESTION: 'questions',
  ADD_INTERFACE: 'interfaces', ADD_FASTENER: 'fasteners', ADD_VOLUME: 'volumes' };
// Core V2 collections exist only in schema 2.
const V2_ONLY = new Set(['interfaces', 'fasteners', 'volumes']);

// Fields an op may SET/UNSET, per collection. Everything else (format, schema,
// meta.id, meta.revision, freeze, resolved, history, question status/answer)
// is not reachable by SET/UNSET.
export const SETTABLE = {
  params: ['value', 'expr', 'status', 'note'],
  parts: ['kind', 'role', 'size', 'bar', 'orient', 'place', 'intent', 'edge_names'],
  features: ['edge', 'face', 'at', 'dir', 'bore_axis', 'compliance', 'size', 'span', 'array', 'z', 'form', 'effect', 'reacts_against', 'mirror'],
  joints: ['dof', 'fit', 'assembly_motion', 'anti_rotation', 'engage', 'index', 'links', 'intent'],
  rules: ['kind', 'text', 'check'],
  questions: ['text', 'options', 'options_note', 'about', 'blocks'],
  meta: ['title', 'intent'],
};

// Mechanically meaningful facts (architecture §F rule 3). Setting one of these
// to a concrete value requires evidence from the user's own words.
export const MECHANICAL = {
  parts: ['orient', 'kind'],
  features: ['edge', 'face', 'at', 'dir', 'bore_axis', 'compliance', 'mirror'],
  joints: ['type', 'links', 'dof', 'fit', 'assembly_motion', 'anti_rotation'],
};

export const isOpenRef = (v) => typeof v === 'string' && v.startsWith('OPEN:');

export function parsePath(path) {
  if (typeof path !== 'string') throw new Error(`path must be a string, got ${JSON.stringify(path)}`);
  const parts = path.split('/');
  if (parts[0] === 'meta') {
    if (parts.length !== 2) throw new Error(`path "${path}": meta paths are meta/<field>`);
    return { collection: 'meta', id: null, field: parts[1], sub: [] };
  }
  if (parts.length < 3 || parts.some((p) => p === '')) throw new Error(`path "${path}" must be <collection>/<id>/<field>[/<sub>…]`);
  const [collection, id, field, ...sub] = parts;
  return { collection, id, field, sub };
}

// The object a path points into (throws if it does not exist).
export function locate(model, collection, id) {
  if (collection === 'meta') return model.meta;
  if (collection === 'params') {
    if (!model.params || !Object.hasOwn(model.params, id)) throw new Error(`unknown parameter "${id}"`);
    return model.params[id];
  }
  if (!COLLECTIONS[collection] || (V2_ONLY.has(collection) && model.schema !== 2)) throw new Error(`unknown collection "${collection}"`);
  const obj = (model[collection] || []).find((x) => x.id === id);
  if (!obj) throw new Error(`unknown ${COLLECTIONS[collection]} "${id}"`);
  return obj;
}

export function getPath(model, path) {
  const { collection, id, field, sub } = parsePath(path);
  let v = locate(model, collection, id)[field];
  for (const k of sub) v = v?.[k];
  return v;
}

function setPath(model, path, value, unset) {
  const { collection, id, field, sub } = parsePath(path);
  const v2 = model.schema === 2;
  const entity = v2 && collection !== 'meta' ? locate(model, collection, id) : null;
  const editable = v2 ? settableV2(collection, entity, field) : SETTABLE[collection]?.includes(field);
  if (!editable) throw new Error(`path "${path}": field "${field}" is not editable by ops`);
  let target = locate(model, collection, id);
  const keys = [field, ...sub];
  for (const k of keys.slice(0, -1)) {
    if (!target[k] || typeof target[k] !== 'object') throw new Error(`path "${path}": "${k}" does not exist`);
    target = target[k];
  }
  const last = keys.at(-1);
  if (unset) {
    if (!Object.hasOwn(target, last)) throw new Error(`path "${path}" does not exist`);
    delete target[last];
  } else {
    if (value === undefined) throw new Error(`SET "${path}" needs a value`);
    target[last] = structuredClone(value);
  }
  if (entity) {
    const errs = checkEntity(collection, entity, `${collection}/${id}`);
    if (errs.length) throw new Error(`${unset ? 'UNSET' : 'SET'} "${path}": ${errs.join('; ')}`);
  }
}

// Ids referenced by anything else in the model (DELETE is refused for these).
function references(model, id) {
  const hits = [];
  for (const f of model.features || []) {
    if (f.host === id || f.mirror?.of === id) hits.push(`feature ${f.id}`);
  }
  for (const j of model.joints || []) {
    const refs = [j.part, ...(j.links || []).flatMap((l) => [l.male, l.female])].map((r) => String(r).replace(/\[[a-z0-9]+\]$/, ''));
    if (refs.some((r) => r === id || r.split('.')[1] === id || r.split('.')[0] === id)) hits.push(`joint ${j.id}`);
    for (const k of ['dof', 'assembly_motion', 'anti_rotation', 'fit']) if (j[k] === `OPEN:${id}`) hits.push(`joint ${j.id}.${k}`);
  }
  for (const q of model.questions || []) if ((q.about || []).some((a) => a === id || a.split('.')[1] === id)) hits.push(`question ${q.id}`);
  return hits;
}

export function applyOp(model, op) {
  if (!op || typeof op !== 'object') throw new Error('op must be an object');
  if (!OPS.includes(op.op)) throw new Error(`unknown op "${op.op}"`);
  if (op.op === 'ADD_PARAM') {
    if (typeof op.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(op.name)) throw new Error('ADD_PARAM needs a valid name');
    if (Object.hasOwn(model.params, op.name)) throw new Error(`parameter "${op.name}" already exists`);
    if (model.schema === 2) {
      const errs = checkEntity('params', op.param, `params/${op.name}`);
      if (errs.length) throw new Error(errs.join('; '));
    }
    model.params[op.name] = structuredClone(op.param);
  } else if (ADD[op.op]) {
    const coll = ADD[op.op];
    if (V2_ONLY.has(coll) && model.schema !== 2) throw new Error(`${op.op} is a schema 2 op`);
    const entity = op[COLLECTIONS[coll]];
    if (!entity || typeof entity.id !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(entity.id)) throw new Error(`${op.op} needs ${COLLECTIONS[coll]}.id (UPPER_CASE)`);
    const all = Object.keys(COLLECTIONS).flatMap((c) => (model[c] || []).map((x) => x.id));
    if (all.includes(entity.id)) throw new Error(`id "${entity.id}" already exists`);
    if (op.op === 'ADD_QUESTION' && entity.status !== 'OPEN') throw new Error('ADD_QUESTION must create an OPEN question');
    if (model.schema === 2) {
      if (op.op === 'ADD_QUESTION' && (entity.answer !== undefined || entity.facts !== undefined)) throw new Error('ADD_QUESTION must not carry an answer or facts');
      const errs = checkEntity(coll, entity);
      if (errs.length) throw new Error(errs.join('; '));
    }
    (model[coll] ||= []).push(structuredClone(entity));
  } else if (op.op === 'SET' || op.op === 'UNSET') {
    setPath(model, op.path, op.value, op.op === 'UNSET');
  } else if (op.op === 'DELETE') {
    if (!COLLECTIONS[op.collection] || (V2_ONLY.has(op.collection) && model.schema !== 2)) throw new Error(`DELETE: unknown collection "${op.collection}"`);
    locate(model, op.collection, op.id);
    const refs = references(model, op.id).filter((r) => !r.endsWith(` ${op.id}`));
    if (refs.length) throw new Error(`DELETE ${op.id}: still referenced by ${refs.join(', ')}`);
    model[op.collection] = model[op.collection].filter((x) => x.id !== op.id);
  } else if (op.op === 'ANSWER_QUESTION') {
    const q = locate(model, 'questions', op.id);
    // schema 2: a STATED question stays answerable — later structured facts (or new words) replace the words
    const answerable = q.status === 'OPEN' || (model.schema === 2 && q.status === 'STATED');
    if (!answerable) throw new Error(`question ${op.id} is not OPEN`);
    if (typeof op.answer !== 'string' || !op.answer.trim()) throw new Error(`ANSWER_QUESTION ${op.id} needs an answer`);
    if (model.schema !== 2 && op.facts !== undefined) throw new Error('facts are a schema 2 construct');
    if (model.schema === 2) {
      // facts: the structured facts that answer the question; [] = the words cannot be structured (STATED)
      if (!Array.isArray(op.facts) || op.facts.some((p) => typeof p !== 'string')) {
        throw new Error(`ANSWER_QUESTION ${op.id} needs facts: a list of model paths, or [] to record the words as STATED`);
      }
    }
    q.status = model.schema === 2 && op.facts.length === 0 ? 'STATED' : 'ANSWERED';
    q.answer = op.answer;
    q.answered_by = 'user (accepted proposal)';
    delete q.facts;
    if (model.schema === 2 && op.facts.length) q.facts = [...op.facts];
    delete q.options_note;
  }
  return model;
}

// Pure: returns a new model; the input is never modified.
export function applyOps(model, ops) {
  if (!Array.isArray(ops)) throw new Error('ops must be an array');
  const m = structuredClone(model);
  ops.forEach((op, i) => {
    try { applyOp(m, op); } catch (e) { throw new Error(`op ${i + 1} (${op?.op}): ${e.message}`); }
  });
  return m;
}
