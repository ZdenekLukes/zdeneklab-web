// Live Intent adapter. There is no separate Live transaction boundary: a Live
// intent (or a Property Editor edit, which is expressed as one) is compiled to
// closed ops and evaluated by the SAME evaluator as every other proposal
// (src/proposal.js evaluateProposal) — evidence, OPEN-question, answer,
// placeholder and un-block rules, derived scope + protected remainder,
// validation and exportability all apply unchanged.
//
// opts.utterance (required): the user's actual words, supplied by the caller
//   that received them. The intent's own `utterance` field is model output and
//   is never used as evidence.
// opts.base: {revision, hash} of the accepted model the intent was requested
//   for. When the accepted model has moved on, the result is STALE.
// opts.scope: an optional narrower caller/UI scope (both must hold).

import { conceptHash } from './model.js?v=68431d732f1e';
import { evaluateProposal, attachUtteranceEvidence, PROPOSAL_FORMAT } from './proposal.js?v=68431d732f1e';
import { compileLiveIntent } from './live_intent.js?v=68431d732f1e';

// Compile an intent to the proposal text the common evaluator receives.
export function liveIntentProposal(accepted, text, opts = {}) {
  const utterance = typeof opts.utterance === 'string' ? opts.utterance.trim() : '';
  if (!utterance) return { errors: ['the user\'s own utterance is required to evaluate a live intent (it is the evidence; the intent\'s copy is never trusted)'] };
  const compiled = compileLiveIntent(accepted, text);
  if (compiled.errors) return compiled;
  if (compiled.status === 'CLARIFY') return compiled;
  const base = opts.base ?? { revision: accepted.meta.revision, hash: conceptHash(accepted) };
  const proposal = {
    format: PROPOSAL_FORMAT, schema: 1, base, utterance,
    summary: compiled.intent.summary, source: opts.source ?? 'live-intent',
    ops: attachUtteranceEvidence(accepted, compiled.ops, utterance),
  };
  return { ...compiled, proposal, proposalText: JSON.stringify(proposal) };
}

export function evaluateLiveIntent(accepted, text, opts = {}) {
  const out = {
    status: 'INVALID', errors: [], warnings: [], intent: null, proposal: null, ops: [],
    scope: null, candidate: null, validation: null, created_questions: [],
  };
  const compiled = liveIntentProposal(accepted, text, opts);
  if (compiled.errors) { out.errors = compiled.errors; return out; }
  out.intent = compiled.intent;
  if (compiled.status === 'CLARIFY') {
    out.status = 'CLARIFY';
    out.question = compiled.question;
    out.choices = compiled.choices;          // UI only: a tapped choice is sent as the user's next message
    return out;
  }
  out.created_questions = compiled.created_questions || [];
  const ev = evaluateProposal(accepted, compiled.proposalText, { scope: opts.scope, affects: compiled.affects, exportAll: opts.exportAll });
  return { ...out, ...ev, intent: compiled.intent, created_questions: out.created_questions, ops: ev.proposal?.ops ?? [] };
}
