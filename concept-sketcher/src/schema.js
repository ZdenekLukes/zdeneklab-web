// Closed schema for `schema: 2` (Core V2 safety core, docs/CORE_V2_ARCHITECTURE.md §5).
// One declarative table drives the validator, the op reducer (ADD / SET),
// the evidence rules (which fields are mechanical facts) and the Skeleton
// Spec projection. A key that is not in this table does not exist: it is an
// ERROR everywhere, so no mechanical meaning can enter as an unknown property.
// `schema: 1` is frozen legacy and is not described here.
//
// Field flags: req (required), fact (a mechanical fact: needs the user's
// words as evidence), open (may hold OPEN:Qn), set (reachable by SET/UNSET),
// numeric (a fact whose numbers must occur in the user's words).
//
// Core V2 mechanical language (E3–E7, E9): interfaces (FACE / AXIS),
// FIXED / REVOLUTE / PRISMATIC joints, HOLE, fasteners, keep-out / access /
// removal volumes, round ROD / CYLINDER and hollow SHELL parts.

const OPEN_RE = /^OPEN:Q\w+$/;
export const isOpen = (v) => typeof v === 'string' && OPEN_RE.test(v);

const AXES = ['+X', '-X', '+Y', '-Y', '+Z', '-Z'];
const EDGES = ['+X', '-X', '+Y', '-Y'];
export const PART_KINDS = ['BLOCK', 'PLATE', 'FRAME', 'SHELL', 'ROD', 'CYLINDER', 'ENVELOPE'];
export const ROUND_KINDS = ['ROD', 'CYLINDER'];
export const MOTIONS = ['FIXED', 'REVOLUTE', 'PRISMATIC'];
export const METHODS = { FIXED: ['FORM_FIT', 'FASTENERS', 'CLAMPED', 'BONDED'], REVOLUTE: ['FORM_FIT'], PRISMATIC: ['FORM_FIT'] };
export const HOLE_KINDS = ['CLEARANCE', 'THREADED', 'BORE', 'OPENING'];
export const VOLUME_PURPOSES = ['KEEP_OUT', 'SERVICE_ACCESS', 'REMOVAL_PATH'];
// Nominal fastener sizes: ISO metric coarse, or a unified inch size "n/d-tpi UNC".
export const FASTENER_SIZE = /^(M(1\.6|2|2\.5|3|4|5|6|8|10|12)|\d+\/\d+-\d+ UNC)$/;
export function nominalDiameter(size) {
  if (!FASTENER_SIZE.test(size ?? '')) return null;
  if (size.startsWith('M')) return Number(size.slice(1));
  const [, n, d] = /^(\d+)\/(\d+)/.exec(size);
  return Math.round((25.4 * Number(n)) / Number(d) * 1e6) / 1e6;
}
export const FITS = ['LOOSE', 'CLEARANCE', 'SLIDING', 'SNUG', 'PRESS'];
export const LATTICE_PATTERNS = ['DIAMOND', 'HONEYCOMB'];
export const QUESTION_STATUS = ['OPEN', 'ANSWERED', 'STATED'];

// ---------------------------------------------------------------- spec builders
const T = (t, extra = {}) => ({ t, ...extra });
const text = T('text'), id = T('id'), num = T('num'), number = T('number'), int = T('int'), bool = T('bool'), any = T('any');
const en = (...v) => T('enum', { v });
const re = (rx, what) => T('re', { rx, what });
const list = (of, min = 0) => T('list', { of, min });
const tuple = (of, n) => T('tuple', { of, n });
const map = (keys, of) => T('map', { keys, of });   // keys: array of allowed keys, or a RegExp
const obj = (fields) => T('obj', { fields });
const f = (s, flags = '') => ({ s, ...Object.fromEntries(flags.split(' ').filter(Boolean).map((k) => [k, true])) });

const partRef = re(/^[A-Z][A-Z0-9_]*$/, 'a part id');
const faceRef = re(/^[A-Z][A-Z0-9_]*\.[+-][XYZ]$/, '"PART.±A" (a face of a part)');
const elementRef = re(/^[A-Z][A-Z0-9_]*(\.[A-Z][A-Z0-9_]*)?$/, '"ID" or "PART.FEATURE"');
// PART.NAME: a declared interface, a feature port (TAB, EYE[k], HOLE), or an implicit
// interface: a box face (+X … -Z), a SHELL inner wall face (INNER+X …), a round part's AXIS.
export const IFACE_REF = /^([A-Z][A-Z0-9_]*)\.([+-][XYZ]|INNER[+-][XYZ]|[A-Z][A-Z0-9_]*(\[\d+\])?)$/;
const ifaceRef = re(IFACE_REF, '"PART.NAME" (an interface)');
const holeRef = re(/^[A-Z][A-Z0-9_]*\.[A-Z][A-Z0-9_]*$/, '"PART.HOLE"');

const size3 = tuple(num, 3);

const MANUFACTURING = obj({
  process: f(en('FDM'), 'req'),
  supports: f(en('FORBID', 'ALLOW'), 'req'),
  bridges: f(en('AVOID', 'ALLOW'), 'req'),
  self_supporting: f(en('REQUIRED', 'PREFERRED', 'NONE'), 'req'),
});
const PRODUCTION = obj({
  repeatable: f(bool, 'req'),
  default_quantity: f(int, 'req'),
});

const PART = obj({
  id: f(id, 'req'),
  kind: f(en(...PART_KINDS), 'req fact set'),
  role: f(en('PRODUCED', 'REFERENCE'), 'req fact set'),
  size: f(size3, 'req set'),
  bar: f(num, 'set'),
  wall: f(num, 'set'),
  open: f(en(...AXES, 'NONE'), 'fact set'),
  orient: f(obj({ z: f(en(...AXES), 'req'), y: f(en(...AXES), 'req') }), 'req fact set'),
  place: f(obj({ at: f(size3, 'req'), anchor: f(en('BOTTOM_CENTRE', 'CENTRE'), 'req') }), 'set'),
  edge_names: f(map(EDGES, text), 'set'),
  manufacturing: f(MANUFACTURING, 'fact set'),
  production: f(PRODUCTION, 'fact set'),
  intent: f(text, 'set'),
});

const FEATURE_BASE = {
  id: f(id, 'req'),
  host: f(partRef, 'req'),
  type: f(en('TAB', 'EYE', 'SPRING'), 'req'),
  edge: f(en(...EDGES), 'req fact set'),
};
const FEATURES = {
  TAB: obj({ ...FEATURE_BASE,
    at: f(obj({ from: f(en(...AXES), 'req'), offset: f(num) }), 'req fact set'),
    dir: f(en('EDGE_NORMAL'), 'req fact set'),
    size: f(obj({ len: f(num, 'req'), w: f(num, 'req'), t: f(num, 'req') }), 'req set') }),
  EYE: obj({ ...FEATURE_BASE,
    face: f(en('INNER'), 'req fact set'),
    bore_axis: f(en('EDGE_NORMAL'), 'req fact set'),
    size: f(obj({ bore: f(num, 'req'), depth: f(num, 'req') }), 'req set'),
    z: f(en('MID'), 'set'),
    array: f(obj({ along: f(en('EDGE'), 'req'), span: f(en('HOST_FACE'), 'req'), pitch: f(num, 'req'), margin: f(num, 'req'),
      count: f(en('DERIVED')), placement: f(en('CENTRED'), 'req') }), 'set') }),
  SPRING: obj({ ...FEATURE_BASE,
    form: f(en('INTEGRATED_FLEXURE'), 'set'),
    span: f(obj({ at: f(en('MID'), 'req'), length: f(re(/^\d+(\.\d+)?%$/, '"<n>%"'), 'req'), extension: f(num) }), 'req set'),
    compliance: f(en('ALONG_EDGE', 'EDGE_NORMAL'), 'req fact set'),
    travel: f(num, 'set'),
    effect: f(obj({ changes_distance_between: f(tuple(faceRef, 2), 'req') }), 'set'),
    reacts_against: f(list(faceRef, 1), 'set') }),
  PIN: obj({ ...FEATURE_BASE,
    type: f(en('PIN'), 'req'),
    intent: f(text, 'set'),
    at: f(obj({ from: f(en(...AXES), 'req'), offset: f(num) }), 'req fact set'),
    dir: f(en('EDGE_NORMAL'), 'req fact set'),
    size: f(obj({ len: f(num, 'req'), d: f(num, 'req') }), 'req set') }),
};
const HOLE = obj({
  id: f(id, 'req'),
  host: f(partRef, 'req'),
  type: f(en('HOLE'), 'req'),
  kind: f(en(...HOLE_KINDS), 'req fact set'),
  on: f(ifaceRef, 'req fact set'),
  offset: f(tuple(num, 2), 'set'),
  profile: f(en('ROUND', 'RECT'), 'req fact set'),
  size: f(obj({ d: f(num), a: f(num), b: f(num) }), 'req set'),
  depth: f(T('depth'), 'req set'),
});
FEATURES.HOLE = HOLE;
const LATTICE = obj({
  id: f(id, 'req'),
  host: f(partRef, 'req'),
  type: f(en('LATTICE'), 'req'),
  pattern: f(en(...LATTICE_PATTERNS), 'req fact open set'),
  max_opening: f(obj({ op: f(en('LT', 'LE'), 'req'), value: f(num, 'req') }), 'req fact set'),
  rib: f(num, 'set'),
  intent: f(text, 'set'),
});
FEATURES.LATTICE = LATTICE;
const MIRROR_FIELD = f(obj({ of: f(id, 'req'), plane: f(en('YZ', 'XZ', 'XY'), 'req'), pair_by_index: f(bool) }), 'req fact set');
const MIRROR = obj({ id: f(id, 'req'), mirror: MIRROR_FIELD });

// The only joint of the safety core: V1 INSERTS_INTO, with every field typed.
// assembly_motion and anti_rotation have no typed value yet (E4), so they can
// only be OPEN:Qn — an answer in words becomes STATED, never a closed fact.
const JOINT = obj({
  id: f(id, 'req'),
  type: f(en('INSERTS_INTO'), 'req fact'),
  part: f(partRef, 'req'),
  links: f(list(obj({ male: f(elementRef, 'req'), female: f(re(/^[A-Z][A-Z0-9_]*\.[A-Z][A-Z0-9_]*(\[[a-z]\])?$/, '"PART.FEATURE" or "PART.FEATURE[i]"'), 'req') }), 1), 'req fact set'),
  index: f(obj({ var: f(re(/^[a-z]$/, 'one lower-case letter'), 'req'), domain: f(en('ANY'), 'req'), preview: f(list(int, 1), 'req') }), 'set'),
  engage: f(num, 'req set'),
  dof: f(re(/^(FIXED|(ROTATE|SLIDE)\([XYZ]\))$/, 'FIXED, ROTATE(X|Y|Z) or SLIDE(X|Y|Z)'), 'req fact open set'),
  fit: f(en(...FITS), 'req fact open set'),
  assembly_motion: f(T('none'), 'req fact open set'),
  anti_rotation: f(T('none'), 'fact open set'),
  intent: f(text, 'set'),
});

// E3: a named location where parts interact, in part-local coordinates.
const INTERFACE = obj({
  id: f(id, 'req'),
  part: f(partRef, 'req fact'),
  type: f(en('FACE', 'AXIS'), 'req fact'),
  at: f(size3, 'req set'),
  dir: f(en(...AXES), 'req fact set'),
  intent: f(text, 'set'),
});

// E4: FIXED / REVOLUTE / PRISMATIC between interfaces (no `type`: that is INSERTS_INTO).
const MOTION_JOINT = obj({
  id: f(id, 'req'),
  part: f(partRef, 'req'),
  motion: f(en(...MOTIONS), 'req fact open set'),
  links: f(list(obj({ child: f(ifaceRef, 'req'), parent: f(ifaceRef, 'req') }), 1), 'req fact set'),
  offset: f(num, 'req set'),
  axis: f(ifaceRef, 'fact set'),
  limits: f(T('limits'), 'fact open set numeric'),
  method: f(en(...new Set(Object.values(METHODS).flat())), 'fact open set'),
  fit: f(en(...FITS), 'fact open set'),
  assembly: f(obj({ direction: f(en(...AXES), 'req open'), removable: f(en('YES', 'NO'), 'req open') }), 'req fact set'),
  anti_rotation: f(T('none'), 'fact open set'),
  fasteners: f(T('none'), 'fact open set'),
  intent: f(text, 'set'),
});

// E5: a fastener joining parts through holes; its axis is derived from the holes.
const FASTENER = obj({
  id: f(id, 'req'),
  kind: f(en('SCREW', 'BOLT_NUT'), 'req fact open set'),
  size: f(re(FASTENER_SIZE, 'a nominal size (M1.6 … M12, or "n/d-tpi UNC")'), 'req fact open set numeric'),
  joint: f(id, 'req set'),
  through: f(list(holeRef, 1), 'req fact set'),
  into: f(holeRef, 'fact set'),
  intent: f(text, 'set'),
});

// E7: a volume with a typed meaning, standing on a face interface.
const VOLUME = obj({
  id: f(id, 'req'),
  purpose: f(en(...VOLUME_PURPOSES), 'req fact set'),
  for: f(elementRef, 'req fact set'),
  on: f(ifaceRef, 'req fact set'),
  offset: f(tuple(num, 2), 'set'),
  size: f(obj({ a: f(num, 'req'), b: f(num, 'req'), depth: f(num, 'req') }), 'req set'),
  allow: f(list(partRef, 1), 'fact set'),
  intent: f(text, 'set'),
});

const DIRECTION_VALUE = en(...AXES, '±X', '±Y', '±Z');
const CHECKS = {
  PARALLEL: obj({ type: f(en('PARALLEL'), 'req'), parts: f(list(partRef, 1), 'req') }),
  DIRECTION: obj({ type: f(en('DIRECTION'), 'req'), features: f(map(/^[A-Z][A-Z0-9_]*\.[A-Z][A-Z0-9_]*$/, DIRECTION_VALUE), 'req') }),
  FORBID_DIRECTION: obj({ type: f(en('FORBID_DIRECTION'), 'req'), part: f(partRef, 'req'), world: f(en(...AXES), 'req') }),
  KIND: obj({ type: f(en('KIND'), 'req'), part: f(partRef, 'req'), kind: f(en(...PART_KINDS), 'req') }),
  CLOSED_WORLD: obj({ type: f(en('CLOSED_WORLD'), 'req') }),
};
// A rule always has a machine check in schema 2: a prose-only requirement is a
// STATED question, never a TEXT_ONLY rule.
const RULE = obj({
  id: f(id, 'req'),
  kind: f(en('MUST', 'MUST_NOT'), 'req set'),
  text: f(text, 'req set'),
  check: f(T('check'), 'req set'),
});

const QUESTION = obj({
  id: f(id, 'req'),
  status: f(en(...QUESTION_STATUS), 'req'),
  blocks: f(en('SKELETON_READY', 'NONE'), 'req set'),
  about: f(list(elementRef), 'req set'),
  text: f(text, 'req set'),
  options: f(list(text), 'req set'),
  options_note: f(text, 'set'),
  answer: f(text),
  answered_by: f(text),
  facts: f(list(re(/^[a-z_]+\/[A-Za-z0-9_]+(\/[A-Za-z0-9_+-]+)*$/, 'a model path'), 1)),
});

// status `placeholder` (S2): a number the AI assumed for display, not stated by the user.
// It blocks SKELETON_READY and leaves that status only through the user's words.
const MOTION_CONTROL = obj({
  label: f(text, 'req'), min: f(num, 'req'), max: f(num, 'req'), step: f(number, 'req'),
  unit: f(en('mm', 'deg'), 'req'), about: f(list(elementRef, 1), 'req'),
  joint: f(id), note: f(text),
});
const PARAM = obj({ motion: f(MOTION_CONTROL, 'set'), value: f(number, 'set'), expr: f(text, 'set'), status: f(en('fixed', 'target', 'rough', 'placeholder'), 'set'), note: f(text, 'set') });

const MODEL = obj({
  format: f(en('AI_CONCEPT'), 'req'),
  schema: f(en(2), 'req'),
  meta: f(obj({ id: f(re(/^[a-z0-9][a-z0-9-]*$/, 'a lower-case slug'), 'req'), title: f(text, 'req set'), revision: f(int, 'req'),
    intent: f(text, 'req set'), closed_world: f(en(true), 'req') }), 'req'),
  units: f(en('mm'), 'req'),
  world: f(obj({ up: f(en('+Z'), 'req'), origin: f(text), x: f(text), y: f(text) }), 'req'),
  params: f(map(/^[A-Za-z_][A-Za-z0-9_]*$/, PARAM), 'req'),
  parts: f(T('entities', { coll: 'parts' }), 'req'),
  interfaces: f(T('entities', { coll: 'interfaces' })),
  features: f(T('entities', { coll: 'features' })),
  joints: f(T('entities', { coll: 'joints' })),
  fasteners: f(T('entities', { coll: 'fasteners' })),
  volumes: f(T('entities', { coll: 'volumes' })),
  rules: f(T('entities', { coll: 'rules' })),
  questions: f(T('entities', { coll: 'questions' })),
  freeze: f(obj({ state: f(en('DRAFT', 'CONCEPT_FROZEN', 'SKELETON_READY'), 'req'), revision: f(int), at: f(text), hash: f(text), previous_hash: f(text),
    skeleton_ready: f(obj({ ready: f(bool, 'req'), blocked_by: f(list(text), 'req') })) })),
  history: f(any),                       // exported sessions only; replayed and re-validated by importSession
});

// The spec of one entity (features and rule checks depend on their type).
export function entitySpec(coll, entity) {
  if (coll === 'parts') return PART;
  if (coll === 'joints') return entity && typeof entity === 'object' && 'type' in entity ? JOINT : MOTION_JOINT;
  if (coll === 'interfaces') return INTERFACE;
  if (coll === 'fasteners') return FASTENER;
  if (coll === 'volumes') return VOLUME;
  if (coll === 'rules') return RULE;
  if (coll === 'questions') return QUESTION;
  if (coll === 'params') return PARAM;
  if (coll === 'features') {
    if (entity && typeof entity === 'object' && 'mirror' in entity) return MIRROR;
    return FEATURES[entity?.type] ?? obj({ ...FEATURE_BASE, type: f(en('TAB', 'EYE', 'SPRING', 'PIN', 'HOLE', 'LATTICE'), 'req') });
  }
  return null;
}
export const COLLECTIONS = ['parts', 'interfaces', 'features', 'joints', 'fasteners', 'volumes', 'rules', 'questions'];

// ---------------------------------------------------------------- checking
function checkValue(v, spec, path, out, open) {
  if (open && isOpen(v)) return;
  const bad = (what) => out.push(`${path}: ${JSON.stringify(v)} must be ${what}${open ? ' or OPEN:Qn' : ''}`);
  switch (spec.t) {
    case 'any': return;
    case 'none': return out.push(`${path}: ${JSON.stringify(v)} is not allowed — schema 2 has no typed value for this fact yet; it can only be OPEN:Qn (an answer in words makes the question STATED)`);
    case 'text': if (typeof v !== 'string' || !v.trim()) bad('non-empty text'); return;
    case 'id': if (typeof v !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(v)) bad('an UPPER_CASE id'); return;
    case 'number': if (typeof v !== 'number' || !Number.isFinite(v)) bad('a number'); return;
    case 'num': if (!((typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.startsWith('=') && v.length > 1))) bad('a number or "=expr"'); return;
    case 'int': if (!Number.isInteger(v)) bad('an integer'); return;
    case 'bool': if (typeof v !== 'boolean') bad('true or false'); return;
    case 'enum': if (!spec.v.includes(v)) bad(`one of ${spec.v.join(', ')}`); return;
    case 're': if (typeof v !== 'string' || !spec.rx.test(v)) bad(spec.what); return;
    case 'tuple':
      if (!Array.isArray(v) || v.length !== spec.n) return bad(`a list of ${spec.n}`);
      v.forEach((x, i) => checkValue(x, spec.of, `${path}/${i}`, out));
      return;
    case 'list':
      if (!Array.isArray(v) || v.length < spec.min) return bad(spec.min ? `a list with at least ${spec.min} item(s)` : 'a list');
      v.forEach((x, i) => checkValue(x, spec.of, `${path}/${i}`, out));
      return;
    case 'map':
      if (!v || typeof v !== 'object' || Array.isArray(v)) return bad('an object');
      for (const [k, x] of Object.entries(v)) {
        const okKey = Array.isArray(spec.keys) ? spec.keys.includes(k) : spec.keys.test(k);
        if (!okKey) out.push(`${path}/${k}: unknown key`);
        else checkValue(x, spec.of, `${path}/${k}`, out);
      }
      return;
    case 'obj': return checkFields(v, spec.fields, path, out);
    case 'limits':
      if (v === 'NONE') return;
      if (!v || typeof v !== 'object' || Array.isArray(v)) return bad('{min, max} or NONE');
      for (const k of Object.keys(v)) if (!['min', 'max'].includes(k)) out.push(`${path}/${k}: unknown key`);
      for (const k of ['min', 'max']) {
        const okNum = typeof v[k] === 'number' && Number.isFinite(v[k]);
        const okExpr = typeof v[k] === 'string' && v[k].startsWith('=') && v[k].length > 1;     // "=param": exact / rough / placeholder provenance lives on the parameter
        if (!okNum && !okExpr) out.push(`${path}/${k}: ${JSON.stringify(v[k])} must be a number or "=expr"`);
      }
      return;
    case 'depth': if (v !== 'THROUGH' && !(typeof v === 'number' && v > 0) && !(typeof v === 'string' && v.startsWith('=') && v.length > 1)) bad('THROUGH, a positive number or "=expr"'); return;
    case 'check': {
      const c = CHECKS[v?.type];
      if (!c) return out.push(`${path}/type: ${JSON.stringify(v?.type)} must be one of ${Object.keys(CHECKS).join(', ')}`);
      return checkValue(v, c, path, out);
    }
    case 'entities':
      if (!Array.isArray(v)) return bad('a list');
      v.forEach((e, i) => out.push(...checkEntity(spec.coll, e, `${spec.coll}/${e && typeof e.id === 'string' ? e.id : i}`)));
      return;
    default: throw new Error(`schema: unknown spec type ${spec.t}`);
  }
}

function checkFields(v, fields, path, out) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out.push(`${path}: must be an object`);
  for (const k of Object.keys(v)) if (!Object.hasOwn(fields, k)) out.push(`${path}/${k}: unknown key`);
  for (const [k, fl] of Object.entries(fields)) {
    if (!Object.hasOwn(v, k) || v[k] === undefined) { if (fl.req) out.push(`${path}/${k}: required`); continue; }
    checkValue(v[k], fl.s, `${path}/${k}`, out, fl.open);
  }
}

// Errors of one entity (paths like "joints/SEAT/fit").
export function checkEntity(coll, entity, path = `${coll}/${entity?.id ?? '?'}`) {
  const out = [];
  const spec = entitySpec(coll, entity);
  if (!spec) return [`${path}: unknown collection "${coll}"`];
  checkValue(entity, spec, path, out);
  return out;
}

// Errors of a whole schema-2 model: every key at every depth must be declared.
export function checkModel(model) {
  const out = [];
  checkValue(model, MODEL, '', out);
  return out.map((e) => e.replace(/^\//, '')).map((e) => (e.startsWith(':') ? `model${e}` : e));
}

// ---------------------------------------------------------------- field queries
export function fieldSpec(coll, entity, field) {
  if (coll === 'meta') return MODEL.fields.meta.s.fields[field];
  const spec = entitySpec(coll, entity);
  return spec?.fields?.[field];
}

// Fields an op may SET/UNSET on this entity.
export const settable = (coll, entity, field) => Boolean(fieldSpec(coll, entity, field)?.set);

// A concrete value in this field is a mechanical fact (needs evidence).
// `blocks: NONE` is a fact too: the user must say the question does not matter for the skeleton.
export function isFactField(coll, entity, field, value) {
  if (coll === 'questions') return field === 'blocks' && value === 'NONE';
  return Boolean(fieldSpec(coll, entity, field)?.fact);
}

export const isNumericField = (coll, entity, field) => Boolean(fieldSpec(coll, entity, field)?.numeric);

// The numbers a numeric fact states (they must occur in the user's words).
export function factNumbers(value) {
  if (isOpen(value) || value === 'NONE') return [];
  if (value && typeof value === 'object') return ['min', 'max'].filter((k) => typeof value[k] === 'number').map((k) => Math.abs(value[k]));
  if (typeof value === 'string') return (value.match(/\d+(\.\d+)?/g) || []).map(Number);
  return typeof value === 'number' ? [Math.abs(value)] : [];
}

// Every field (at any depth) holding OPEN:Qn in the model: [{ path, q }].
export function openSlots(model) {
  const out = [];
  const walk = (value, spec, path) => {
    for (const [k, fl] of Object.entries(spec?.fields || {})) {
      const v = value?.[k];
      if (fl.open && isOpen(v)) out.push({ path: `${path}/${k}`, q: v.slice(5) });
      else if (fl.s.t === 'obj' && v && typeof v === 'object') walk(v, fl.s, `${path}/${k}`);
    }
  };
  for (const coll of COLLECTIONS) for (const e of model[coll] || []) walk(e, entitySpec(coll, e), `${coll}/${e.id}`);
  return out;
}

// Copy of `value` containing only declared keys (the Skeleton Spec never
// spreads raw model objects, so even a validator bug cannot leak a key).
export function project(value, spec) {
  if (!spec || value === null || typeof value !== 'object') return value;
  if (spec.t === 'obj') {
    const o = {};
    for (const k of Object.keys(value)) if (Object.hasOwn(spec.fields, k)) o[k] = project(value[k], spec.fields[k].s);
    return o;
  }
  if (spec.t === 'check') return project(value, CHECKS[value.type]);
  if (spec.t === 'list' || spec.t === 'tuple') return Array.isArray(value) ? value.map((x) => project(x, spec.of)) : value;
  if (spec.t === 'map') {
    const o = {};
    for (const [k, x] of Object.entries(value)) if (Array.isArray(spec.keys) ? spec.keys.includes(k) : spec.keys.test(k)) o[k] = project(x, spec.of);
    return o;
  }
  return value;
}

export function projectEntity(coll, entity) {
  let spec = entitySpec(coll, entity);
  // a resolved mirror definition carries its source's fields plus `mirror`
  if (coll === 'features' && entity.type && entity.mirror) spec = obj({ ...FEATURES[entity.type].fields, mirror: MIRROR_FIELD });
  return project(entity, spec);
}
export const projectParams = (params) => project(params, MODEL.fields.params.s);
