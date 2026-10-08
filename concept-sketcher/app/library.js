// Product Library (Phase 2C): the local list of products in this browser.
//
// A product is one autosave slot `concept-sketcher.project.<slug>.session`
// holding its .aiconcept with the full accepted history (src/session.js
// exportSession), plus two companions owned by the same slot:
// `<slot>.backup` (the previous autosave) and `<slot>.conversation` (the Live
// thread, app/conversation.js). The slot key is the product's identity and never
// changes; it is chosen once, when the product is created or imported, and is
// always a key that holds nothing yet, so creating or importing never
// overwrites another product.
//
// The index `concept-sketcher.projects.v1` is display metadata only: rows
// {key, id, title, revision, hash, updated, name?, created?}. `name` is the
// library name the user gave the product; renaming changes only this row,
// never the accepted model (meta.title stays as accepted, the hash does not
// change). The index is never truncated. Slots the index misses (older builds
// kept only 30 rows; a lost index) are still listed, read from the slot
// itself; listing never writes.
//
// All functions take the Storage to use (localStorage in the app, a fake one
// in tests) and throw on storage errors instead of hiding them.

export const PROJECT_INDEX = 'concept-sketcher.projects.v1';
export const ACTIVE_PROJECT = 'concept-sketcher.projects.active';
const PREFIX = 'concept-sketcher.project.';
const SUFFIX = '.session';
export const NAME_MAX = 80;

export const slug = (s) => String(s || 'concept').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'concept';
export const projectKey = (id) => `${PREFIX}${slug(id)}${SUFFIX}`;
export const isProjectKey = (k) => typeof k === 'string' && k.startsWith(PREFIX) && k.endsWith(SUFFIX) && k.length > PREFIX.length + SUFFIX.length;
// Every key a product owns. Deleting a product removes exactly these.
export const ownKeys = (key) => [key, `${key}.backup`, `${key}.conversation`];

export const displayName = (row) => String(row?.name || row?.title || row?.id || 'Untitled product');

export function cleanName(name) {
  const n = String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!n) throw new Error('the name is empty');
  if (n.length > NAME_MAX) throw new Error(`the name is longer than ${NAME_MAX} characters`);
  return n;
}

function storageKeys(storage) {
  const out = [];
  for (let i = 0; i < storage.length; i++) { const k = storage.key(i); if (k !== null) out.push(k); }
  return out;
}

// Index rows as stored; anything unusable is ignored (never repaired here).
export function readIndex(storage) {
  let rows;
  try { rows = JSON.parse(storage.getItem(PROJECT_INDEX) || '[]'); } catch { return []; }
  if (!Array.isArray(rows)) return [];
  const seen = new Set();
  return rows.filter((r) => r && typeof r === 'object' && isProjectKey(r.key) && !seen.has(r.key) && seen.add(r.key));
}

function writeIndex(storage, rows) {
  const text = JSON.stringify(rows);
  storage.setItem(PROJECT_INDEX, text);
  if (storage.getItem(PROJECT_INDEX) !== text) throw new Error('the product list does not read back');
}

// meta of a saved slot, without validating it (display only; opening validates).
export function slotMeta(raw) {
  try {
    const m = JSON.parse(raw)?.meta;
    return m && typeof m === 'object' ? { id: typeof m.id === 'string' ? m.id : null, title: typeof m.title === 'string' ? m.title : null, revision: Number.isInteger(m.revision) ? m.revision : null } : null;
  } catch { return null; }
}

// The library, most recently modified first. Index rows whose slot is gone are
// left out; slots the index misses are added (unlisted: true). Never writes.
export function listProducts(storage) {
  const rows = readIndex(storage).filter((r) => storage.getItem(r.key) !== null).map((r) => ({ ...r }));
  const known = new Set(rows.map((r) => r.key));
  for (const k of storageKeys(storage)) {
    if (!isProjectKey(k) || known.has(k)) continue;
    const m = slotMeta(storage.getItem(k));
    rows.push({ key: k, id: m?.id ?? null, title: m?.title ?? null, revision: m?.revision ?? null, updated: null, unlisted: true });
  }
  const time = (r) => { const t = Date.parse(r.updated); return Number.isFinite(t) ? t : -Infinity; };
  return rows.sort((a, b) => time(b) - time(a) || displayName(a).localeCompare(displayName(b)) || a.key.localeCompare(b.key));
}

// A model id and slot key that no product uses yet: "box", then "box-2", "box-3"…
// The slot must hold nothing and no index row may name it or the id.
export function freeSlot(storage, wanted) {
  const rows = readIndex(storage);
  const base = slug(wanted);
  for (let n = 1; ; n++) {
    const id = n === 1 ? base : `${base.slice(0, 55)}-${n}`;
    const key = projectKey(id);
    if (storage.getItem(key) === null && storage.getItem(`${key}.backup`) === null && storage.getItem(`${key}.conversation`) === null
      && !rows.some((r) => r.key === key || r.id === id)) return { id, key };
  }
}

// Write a new product's slot. The key must be free (freeSlot); on any failure
// the partial write is removed and the error is thrown, so a product either is
// stored completely or not at all.
export function storeNewProduct(storage, key, raw) {
  if (!isProjectKey(key)) throw new Error('not a product slot');
  if (storage.getItem(key) !== null) throw new Error('that slot is already used by another product');
  try {
    storage.setItem(key, raw);
    if (storage.getItem(key) !== raw) throw new Error('the saved product does not read back');
  } catch (e) {
    try { storage.removeItem(key); } catch { /* nothing more to undo */ }
    throw e;
  }
}

// Record the current state of a product in the index (the autosave calls this).
// Keeps the row's name and creation time; `changed` moves its modified time.
export function recordProduct(storage, { key, id, title, revision, hash }, { changed = true, now = new Date().toISOString() } = {}) {
  const rows = readIndex(storage);
  const i = rows.findIndex((r) => r.key === key);
  const old = i >= 0 ? rows[i] : null;
  const row = { ...(old || {}), key, id, title, revision, hash, updated: changed || !old?.updated ? now : old.updated, ...(old?.created ? {} : { created: old?.updated || now }) };
  if (i >= 0) rows[i] = row; else rows.push(row);
  writeIndex(storage, rows);
  return row;
}

// Rename = the index row's name only. The slot (model, history, hash) is untouched.
export function renameProduct(storage, key, name) {
  const clean = cleanName(name);
  const raw = storage.getItem(key);
  if (!isProjectKey(key) || raw === null) throw new Error('that product is not in this browser');
  const rows = readIndex(storage);
  let row = rows.find((r) => r.key === key);
  if (!row) {
    const m = slotMeta(raw);
    row = { key, id: m?.id ?? null, title: m?.title ?? null, revision: m?.revision ?? null, hash: null, updated: null };
    rows.push(row);
  }
  row.name = clean;
  writeIndex(storage, rows);
  return clean;
}

// Remove one product: its slot, backup, conversation and index row. Nothing else.
export function deleteProduct(storage, key) {
  if (!isProjectKey(key)) throw new Error('not a product slot');
  for (const k of ownKeys(key)) storage.removeItem(k);
  const rows = readIndex(storage);
  if (rows.some((r) => r.key === key)) writeIndex(storage, rows.filter((r) => r.key !== key));
  if (storage.getItem(ACTIVE_PROJECT) === key) storage.removeItem(ACTIVE_PROJECT);
}
