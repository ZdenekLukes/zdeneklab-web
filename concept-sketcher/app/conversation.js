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

import { boundRecent, CONTEXT_LIMITS } from '../src/live_context.js?v=cefb80df528e';

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

// Why the checks refused an AI reply, as the AI will read it in the next turn: the
// evaluator's schema/validation messages, sanitized (no control characters, long
// quotes of user text shortened, one line per distinct problem, bounded) so the
// model can correct its next reply. Context only; never a fact or a change.
export const REASON_LIMITS = Object.freeze({ count: 4, chars: 300 });
export function refusalReasons(details, limits = REASON_LIMITS) {
  if (!Array.isArray(details)) return [];
  const seen = new Set(), out = [];
  let used = 0;
  for (const d of details) {
    if (typeof d !== 'string') continue;
    let r = d.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
      .replace(/"([^"]{40,})"/g, (_, q) => `"${q.slice(0, 32)}…"`);
    // "part BODY: a CYLINDER is round…" and "part LID: a CYLINDER is round…" are one problem
    const problem = r.replace(/^(?:op \d+ \([A-Z_]+\): )*(?:part|feature|joint|question|interface)\s+[\w.]+:\s*/i, '');
    if (!r || seen.has(problem)) continue;
    if (r.length > 120) r = `${r.slice(0, 117)}…`;
    if (out.length === limits.count || used + r.length > limits.chars) break;
    seen.add(problem); out.push(r); used += r.length;
  }
  return out;
}
const reasonText = (t) => (Array.isArray(t.reasons) && t.reasons.length ? ` Reasons: ${t.reasons.join(' | ')}` : '');

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
  if (t.kind === 'proposal') {
    // the reasons go last, so a long summary is shortened to keep them inside the per-turn limit
    const reasons = t.outcome === 'refused' ? reasonText(t) : '';
    const tail = ` (${OUTCOME[t.outcome] || 'not applied'})${reasons}`;
    let head = `Proposed: ${t.text}`;
    if (reasons && head.length + tail.length > CONTEXT_LIMITS.turnChars) head = `${head.slice(0, Math.max(20, CONTEXT_LIMITS.turnChars - tail.length - 1))}…`;
    return { role: 'assistant', text: `${head}${tail}` };
  }
  if (t.kind === 'refused') return { role: 'assistant', text: `My reply could not be used (refused by the checks); nothing was changed.${reasonText(t)}` };
  return null;
}

// The bounded context sent with the next message.
export function recentOf(thread) {
  return boundRecent((thread?.turns || []).map(toRecent).filter(Boolean));
}
