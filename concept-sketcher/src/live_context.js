// Conversation context for Live (Phase 2B).
//
// The accepted .aiconcept is the only source of confirmed design data. The
// conversation is a bounded thread of turns since the accepted model last
// changed; it lets a short answer ("Open box") be read together with the
// request it answers ("a box 100 × 100 × 100 mm").
//
// Two uses, both computed by this one module on the server and in the browser
// so that they agree byte for byte:
//   - boundRecent: the turns sent to the AI (role + text, bounded);
//   - threadWords: the user's own words of the thread, the evidence the
//     evaluator checks facts against. Only user turns count. Assistant turns
//     (questions, proposals) are context for the AI and never evidence.

import { concreteFacts } from './proposal.js?v=82722beda481';
import { applyOps } from './ops.js?v=82722beda481';
import { factNumbers } from './schema.js?v=82722beda481';
import { numbersIn as statedNumbers } from './interpret/normalize.js?v=82722beda481';

// Keep a practical mobile dialogue plus earlier explicit user requirements.
// The original request and older numeric corrections are pinned, while recent
// turns continue to provide the current clarification context.
export const CONTEXT_LIMITS = Object.freeze({ turns: 32, turnChars: 400, totalChars: 9500, olderNumericTurns: 6 });

const clean = (s) => String(s).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim();

// The turns the AI receives: [{role: 'user'|'assistant', text}], newest last.
// Anything else is dropped; long turns are cut; the oldest turns go first when
// the total would exceed the budget.
export function boundRecent(recent, limits = CONTEXT_LIMITS) {
  if (!Array.isArray(recent)) return [];
  const out = [];
  for (const t of recent) {
    if (!t || typeof t !== 'object' || (t.role !== 'user' && t.role !== 'assistant') || typeof t.text !== 'string') continue;
    const text = clean(t.text).slice(0, limits.turnChars);
    if (text) out.push({ role: t.role, text });
  }
  // A raw last-N window forgets the box dimensions after N/2 clarification
  // exchanges. Preserve the user's first request plus their newest earlier
  // numeric statements (including corrections) WITHOUT inventing a summary.
  // Assistant messages are never promoted to user facts.
  const olderEnd = Math.max(0, out.length - limits.turns);
  const firstUser = out.findIndex((t) => t.role === 'user');
  const olderNumeric = out.slice(0, olderEnd).flatMap((t, i) =>
    t.role === 'user' && /\d/.test(t.text) ? [i] : []).slice(-(limits.olderNumericTurns ?? 0));
  const anchors = [...new Set([...(firstUser >= 0 && firstUser < olderEnd ? [firstUser] : []), ...olderNumeric])]
    .sort((a, b) => a - b);
  const tailStart = Math.max(0, out.length - Math.max(1, limits.turns - anchors.length));
  const kept = [
    ...anchors.filter((i) => i < tailStart).map((i) => out[i]),
    ...out.slice(tailStart),
  ];
  let total = kept.reduce((n, t) => n + t.text.length, 0);
  // The very first user request is the anchor; trim intervening turns first.
  while (kept.length > 1 && total > limits.totalChars) {
    const drop = firstUser >= 0 && kept[0] === out[firstUser] && kept.length > 2 ? 1 : 0;
    total -= kept.splice(drop, 1)[0].text.length;
  }
  return kept;
}

// The user's own words of the thread: earlier user turns, then the current
// utterance. This is what a Live proposal's facts are checked against.
export function threadWords(recent, utterance) {
  const earlier = boundRecent(recent).filter((t) => t.role === 'user').map((t) => t.text);
  return [...earlier, clean(utterance)].filter(Boolean).join('\n');
}

// Where each number a Live proposal sets comes from among the user's messages
// of the thread. Display only: the evaluator has already checked that these
// numbers occur in the user's words; this shows WHICH message they come from,
// so a value the user later replaced ("2 mm … no, 2.4 mm") is visible before
// Accept. Covers the numbers the evaluator checks: numeric facts (joint limits,
// fastener sizes) and values set on parameters.
export function valueSources(accepted, ops, words) {
  const lines = String(words || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length || !Array.isArray(ops)) return [];
  const states = (l, nums) => nums.every((n) => statedNumbers(l).some((x) => Math.abs(x - n) < 1e-9));
  const out = [];
  let state = structuredClone(accepted);
  for (const op of ops) {
    const claims = [];
    try {
      for (const f of concreteFacts(op, state)) if (f.numeric) claims.push({ what: f.what, value: f.value });
      if (op.op === 'SET' && /^params\/[^/]+\/value$/.test(String(op.path))) claims.push({ what: op.path.replace(/\/value$/, ''), value: op.value });
      state = applyOps(state, [op]);
    } catch { /* the evaluator reports the failing op */ }
    for (const c of claims) {
      const nums = factNumbers(c.value);
      if (!nums.length) continue;
      const i = lines.findLastIndex((l) => states(l, nums));
      if (i >= 0) out.push({ what: c.what, value: c.value, from: lines[i], latest: i === lines.length - 1, last: lines.at(-1) });
    }
  }
  return out;
}
