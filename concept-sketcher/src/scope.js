// LIVE EDIT safety boundary.
//
// A local edit is allowed to change only explicitly approved model paths.
// The scope is NOT supplied by the language model. A deterministic intent
// compiler / UI selection creates it before the proposal is evaluated.
//
// Paths use the same stable entity notation as ops:
//   parts/BRACKET_L
//   joints/J_L/assembly/removable
//   features/H1/offset
//
// Arrays of entities are compared by id, so moving BRACKET_L can never be
// hidden as "the parts array changed". Runtime-only freeze state is ignored:
// every accepted mechanical edit intentionally returns the concept to DRAFT.

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
      if (!Object.hasOwn(before, key) || !Object.hasOwn(after, key)) out.add(join(path, key));
      else diffInto(before[key], after[key], join(path, key), out);
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
