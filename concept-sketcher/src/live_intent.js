// Live Intent Contract v1.
//
// This is deliberately smaller than .aiconcept and the old S2 protocol.
// The model proposes a local PATCH or asks one CLARIFY question. Its `targets`
// are semantic hints that its own edits, deletes and answer facts must stay
// inside (a consistency check). They are never an authorization: the
// enforcement scope is derived from the compiled ops (src/scope.js deriveScope).
//
// Safety chain (one boundary for every mutation, see src/live_edit.js):
//   intent -> compile closed ops -> AI_CONCEPT_PROPOSAL with the user's own
//   utterance -> evaluateProposal (evidence, OPEN, answer, placeholder rules,
//   derived scope + protected remainder, validate, export) -> review -> ACCEPT

import { OPS, parsePath } from './ops.js?v=14dc3aea2f1a';

export const LIVE_INTENT_FORMAT = 'AI_CONCEPT_INTENT';
export const LIVE_INTENT_SCHEMA = 1;

const TARGET_COLLECTIONS = new Set(['params','parts','features','joints','rules','questions','interfaces','fasteners','volumes','meta']);
const CREATE_COLLECTIONS = new Set(['params','parts','features','joints','rules','interfaces','fasteners','volumes']);
const ADD_OP = {
  parts: ['ADD_PART','part'],
  features: ['ADD_FEATURE','feature'],
  joints: ['ADD_JOINT','joint'],
  rules: ['ADD_RULE','rule'],
  interfaces: ['ADD_INTERFACE','interface'],
  fasteners: ['ADD_FASTENER','fastener'],
  volumes: ['ADD_VOLUME','volume'],
};

const obj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const knownKeys = (o, allowed, tag, errors) => {
  for (const k of Object.keys(o || {})) if (!allowed.includes(k)) errors.push(`${tag}: unknown key "${k}"`);
};
const coveredBy = (path, root) => path === root || path.startsWith(`${root}/`);

function validTarget(path) {
  if (typeof path !== 'string' || !path || path.startsWith('/') || path.endsWith('/') || path.includes('//')) return false;
  const [collection, id] = path.split('/');
  if (!TARGET_COLLECTIONS.has(collection)) return false;
  if (collection === 'meta') return path.split('/').length === 2;
  return Boolean(id);
}

function nextQuestionIds(model, count) {
  const used = new Set((model.questions || []).map((q) => q.id));
  const ids = [];
  let n = 1;
  while (ids.length < count) {
    const id = `Q${n++}`;
    if (!used.has(id)) { used.add(id); ids.push(id); }
  }
  return ids;
}

export function parseLiveIntent(text) {
  let x;
  try { x = typeof text === 'string' ? JSON.parse(text) : structuredClone(text); }
  catch (e) { return { errors: [`intent is not valid JSON: ${e.message}`] }; }

  const errors = [];
  if (!obj(x)) return { errors: ['intent must be an object'] };
  knownKeys(x, ['format','schema','action','summary','utterance','targets','edits','creates','deletes','mirrors','answers','unknowns','question'], 'intent', errors);
  if (x.format !== LIVE_INTENT_FORMAT) errors.push(`format must be "${LIVE_INTENT_FORMAT}"`);
  if (x.schema !== LIVE_INTENT_SCHEMA) errors.push(`schema must be ${LIVE_INTENT_SCHEMA}`);
  if (!['PATCH','CLARIFY'].includes(x.action)) errors.push('action must be PATCH or CLARIFY');
  if (typeof x.summary !== 'string') errors.push('summary is required');
  if (x.utterance !== undefined && typeof x.utterance !== 'string') errors.push('utterance must be a string');

  const list = (k) => {
    if (x[k] === undefined) x[k] = [];
    if (!Array.isArray(x[k])) { errors.push(`${k} must be an array`); return []; }
    return x[k];
  };
  const targets = list('targets'), edits = list('edits'), creates = list('creates'), deletes = list('deletes'), mirrors = list('mirrors'), answers = list('answers'), unknowns = list('unknowns');

  targets.forEach((p,i) => { if (!validTarget(p)) errors.push(`targets[${i}] is not a valid model path`); });

  edits.forEach((e,i) => {
    if (!obj(e)) { errors.push(`edits[${i}] must be an object`); return; }
    knownKeys(e, ['path','value'], `edits[${i}]`, errors);
    if (typeof e.path !== 'string') errors.push(`edits[${i}].path is required`);
    else {
      try { parsePath(e.path); } catch (err) { errors.push(`edits[${i}].path: ${err.message}`); }
      if (!targets.some((t) => coveredBy(e.path, t))) errors.push(`edits[${i}].path "${e.path}" is outside declared targets`);
    }
    if (!Object.hasOwn(e,'value')) errors.push(`edits[${i}].value is required`);
  });

  creates.forEach((c,i) => {
    if (!obj(c)) { errors.push(`creates[${i}] must be an object`); return; }
    knownKeys(c, ['collection','name','entity'], `creates[${i}]`, errors);
    if (!CREATE_COLLECTIONS.has(c.collection)) errors.push(`creates[${i}].collection is not creatable`);
    if (c.collection === 'params') {
      if (typeof c.name !== 'string' || !c.name) errors.push(`creates[${i}].name is required for params`);
      if (!obj(c.entity)) errors.push(`creates[${i}].entity must be a parameter object`);
    } else if (!obj(c.entity) || typeof c.entity.id !== 'string') {
      errors.push(`creates[${i}].entity.id is required`);
    }
  });

  deletes.forEach((d,i) => {
    if (!obj(d)) { errors.push(`deletes[${i}] must be an object`); return; }
    knownKeys(d, ['collection','id'], `deletes[${i}]`, errors);
    const root = `${d.collection}/${d.id}`;
    if (!CREATE_COLLECTIONS.has(d.collection) || d.collection === 'params') errors.push(`deletes[${i}].collection is not deletable here`);
    if (typeof d.id !== 'string' || !d.id) errors.push(`deletes[${i}].id is required`);
    if (!targets.some((t) => coveredBy(root, t))) errors.push(`deletes[${i}] "${root}" is outside declared targets (a target must cover the whole entity)`);
  });

  mirrors.forEach((m,i) => {
    if (!obj(m)) { errors.push(`mirrors[${i}] must be an object`); return; }
    knownKeys(m, ['source','id','plane'], `mirrors[${i}]`, errors);
    if (typeof m.source !== 'string' || !m.source) errors.push(`mirrors[${i}].source is required`);
    if (typeof m.id !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(m.id)) errors.push(`mirrors[${i}].id must be UPPER_CASE`);
    if (!['YZ','XZ','XY'].includes(m.plane)) errors.push(`mirrors[${i}].plane must be YZ, XZ or XY`);
  });

  answers.forEach((a,i) => {
    if (!obj(a)) { errors.push(`answers[${i}] must be an object`); return; }
    knownKeys(a, ['id','answer','facts'], `answers[${i}]`, errors);
    if (typeof a.id !== 'string' || !a.id) errors.push(`answers[${i}].id is required`);
    if (typeof a.answer !== 'string' || !a.answer.trim()) errors.push(`answers[${i}].answer is required`);
    if (!Array.isArray(a.facts) || !a.facts.every((p) => typeof p === 'string')) {
      errors.push(`answers[${i}].facts must be a list of model paths (or [] for STATED)`);
    } else {
      for (const p of a.facts) {
        try { parsePath(p); } catch (err) { errors.push(`answers[${i}].facts: ${err.message}`); continue; }
        if (!targets.some((t) => coveredBy(p, t))) errors.push(`answers[${i}].fact "${p}" is outside declared targets`);
      }
    }
  });

  unknowns.forEach((u,i) => {
    if (!obj(u)) { errors.push(`unknowns[${i}] must be an object`); return; }
    knownKeys(u, ['question','about'], `unknowns[${i}]`, errors);
    if (typeof u.question !== 'string' || !u.question.trim()) errors.push(`unknowns[${i}].question is required`);
    if (!Array.isArray(u.about) || !u.about.every((a) => typeof a === 'string')) errors.push(`unknowns[${i}].about must be a list of ids`);
  });

  if (x.action === 'CLARIFY') {
    if (typeof x.question !== 'string' || !x.question.trim()) errors.push('CLARIFY requires question');
    if (edits.length || creates.length || deletes.length || mirrors.length || answers.length || unknowns.length) errors.push('CLARIFY cannot mutate the model');
  } else {
    if (x.question !== undefined) errors.push('PATCH must not carry question');
    if (!edits.length && !creates.length && !deletes.length && !mirrors.length && !answers.length && !unknowns.length) errors.push('PATCH has no changes, answers or unknowns');
  }

  return errors.length ? { errors } : { intent: x };
}

export function compileLiveIntent(model, text) {
  const parsed = parseLiveIntent(text);
  if (!parsed.intent) return parsed;
  const x = parsed.intent;
  if (x.action === 'CLARIFY') return { intent: x, status: 'CLARIFY', question: x.question, ops: [], affects: [] };

  const ops = [];
  const affects = [];

  for (const e of x.edits) ops.push({ op: 'SET', path: e.path, value: structuredClone(e.value) });

  for (const c of x.creates) {
    if (c.collection === 'params') {
      ops.push({ op: 'ADD_PARAM', name: c.name, param: structuredClone(c.entity) });
    } else {
      const [op,key] = ADD_OP[c.collection] || [];
      if (!op || !OPS.includes(op)) return { errors: [`no closed op for collection ${c.collection}`] };
      ops.push({ op, [key]: structuredClone(c.entity) });
    }
  }

  for (const d of x.deletes) ops.push({ op: 'DELETE', collection: d.collection, id: d.id });

  const planeAxis = { YZ: 0, XZ: 1, XY: 2 };
  const flipAxis = (name, axis) => name?.[1] === 'XYZ'[axis] ? `${name[0] === '+' ? '-' : '+'}${name[1]}` : name;
  for (const m of x.mirrors) {
    const source = (model.parts || []).find((p) => p.id === m.source);
    if (!source) return { errors: [`mirror source ${m.source} does not exist`] };
    if (!source.place) return { errors: [`mirror source ${m.source} must be a free-standing placed part`] };
    if ((model.features || []).some((f) => f.host === source.id) || (model.interfaces || []).some((i) => i.part === source.id) || (model.joints || []).some((j) => j.part === source.id || JSON.stringify(j.links || []).includes(`${source.id}.`))) {
      return { errors: [`mirror source ${m.source} must not have features, interfaces or joints; mirror those explicitly`] };
    }
    const axis = planeAxis[m.plane];
    const part = structuredClone(source);
    part.id = m.id;
    part.place.at[axis] *= -1;
    if (part.orient?.z) {
      part.orient.z = flipAxis(part.orient.z, axis);
      part.orient.y = flipAxis(part.orient.y, axis);
    } else if (part.orient?.euler_deg) {
      return { errors: [`mirror source ${m.source}: mirror of an Euler-oriented part is not representable as a proper rotation`] };
    }
    ops.push({ op: 'ADD_PART', part });
    affects.push(`parts/${source.id}`);          // the mirror is derived from its source; the source itself is not changed
  }

  for (const a of x.answers) {
    const q = (model.questions || []).find((x) => x.id === a.id);
    if (!q) return { errors: [`answer refers to unknown question ${a.id}`] };
    if (!['OPEN','STATED'].includes(q.status)) return { errors: [`question ${a.id} is not answerable`] };

    // Frozen Core V2 deliberately does not treat params/<name>/value as a
    // question fact. Live Intent may still use such paths to express the
    // user's numeric answer, but they must be backed by an edit. We keep the
    // user's full intent for inspection and store only Core-V2-compatible
    // facts on the accepted question. If no compatible fact remains, the
    // answer becomes STATED and therefore keeps blocking SKELETON_READY.
    const paramFacts = a.facts.filter((p) => p.startsWith('params/'));
    for (const p of paramFacts) {
      if (!x.edits.some((e) => e.path === p || e.path.startsWith(`${p}/`) || p.startsWith(`${e.path}/`))) {
        return { errors: [`answer ${a.id}: parameter fact "${p}" is not established by an edit`] };
      }
    }
    const coreFacts = a.facts.filter((p) => !p.startsWith('params/'));
    ops.push({ op: 'ANSWER_QUESTION', id: a.id, answer: a.answer, facts: coreFacts });
  }

  const qids = nextQuestionIds(model, x.unknowns.length);
  x.unknowns.forEach((u,i) => {
    const id = qids[i];
    ops.push({ op: 'ADD_QUESTION', question: {
      id, status: 'OPEN', blocks: 'SKELETON_READY',
      about: [...u.about], text: u.question, options: [],
    }});
  });

  return { intent: x, status: 'PATCH', ops, affects: [...new Set(affects)].sort(), created_questions: qids };
}
