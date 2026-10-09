// Live conversation thread in the browser (Phase 2B).
//
// One thread per project, stored next to the project's autosave under
// `<project key>.conversation`. A thread belongs to one accepted state
// (base = session head + concept hash): when the accepted model changes
// (Accept, history checkout, backup restore) the next turn starts a new thread,
// and a stored thread whose base no longer matches is discarded on load. So a
// thread never outlives the accepted state it was talking about.
//
// The thread is context, never design data: user turns are the user's words,
// assistant turns record questions and proposals with their outcome. Nothing
// here is applied to the model; proposals still go through the evaluator and
// an explicit Accept. No credentials are ever written here.

import { boundRecent } from '../src/live_context.js?v=3e2243632c73';

export const MAX_STORED_TURNS = 80;

const sameBase = (a, b) => Boolean(a && b && a.head === b.head && a.hash === b.hash);

export function newThread(base) { return { v: 1, base, seq: 0, turns: [] }; }

export function loadThread(storage, key, base) {
  try {
    const t = JSON.parse(storage.getItem(key) || 'null');
    if (t && t.v === 1 && sameBase(t.base, base) && Number.isInteger(t.seq) && Array.isArray(t.turns)) return t;
  } catch { /* unreadable or unavailable storage: start fresh */ }
  return newThread(base);
}

export function storeThread(storage, key, thread) {
  try { storage.setItem(key, JSON.stringify(thread)); return true; } catch { return false; }
}

export function threadMatches(thread, base) { return sameBase(thread?.base, base); }

// Append a turn; returns { thread, id }. The stored thread keeps the newest MAX_STORED_TURNS.
export function addTurn(thread, turn) {
  const id = `t${thread.seq + 1}`;
  const all = [...thread.turns, { id, ...turn }];
  let turns = all.slice(-MAX_STORED_TURNS);
  if (all.length > MAX_STORED_TURNS) {
    const first = all.find((t) => t.role === 'user');
    if (first && !turns.some((t) => t.id === first.id)) turns = [first, ...all.slice(-(MAX_STORED_TURNS - 1))];
  }
  return { id, thread: { ...thread, seq: thread.seq + 1, turns } };
}

export function updateTurn(thread, id, patch) {
  return { ...thread, turns: thread.turns.map((t) => (t.id === id ? { ...t, ...patch } : t)) };
}

const OUTCOME = {
  pending: 'waiting for the user to accept or reject; not applied',
  rejected: 'rejected by the user; not applied',
  superseded: 'replaced by a newer message; not applied',
  refused: 'refused by the checks; not applied',
  stale: 'made for an older state; not applied',
};

// What the AI is told about one turn.
function toRecent(t) {
  if (t.role === 'user') return { role: 'user', text: t.text };
  if (t.kind === 'question') {
    const options = Array.isArray(t.choices) && t.choices.length ? ` Options offered: ${t.choices.map((c) => c.label).join(' | ')}` : '';
    return { role: 'assistant', text: `Asked: ${t.text}${options}` };
  }
  if (t.kind === 'proposal') return { role: 'assistant', text: `Proposed: ${t.text} (${OUTCOME[t.outcome] || 'not applied'})` };
  if (t.kind === 'refused') return { role: 'assistant', text: 'My reply could not be used (refused by the checks); nothing was changed.' };
  return null;
}

// The bounded context sent with the next message.
export function recentOf(thread) {
  return boundRecent((thread?.turns || []).map(toRecent).filter(Boolean));
}
