// Deterministic evaluator for the Live Intent path.
// No evidence ledger and no prompt-training protocol: safety comes from the
// closed ops reducer, derived scope, protected-remainder guard, validator,
// exportability check, user-visible diff, and ACCEPT re-evaluation.

import { applyOps } from './ops.js';
import { validate } from './validate.js';
import { exportAll } from './export.js';
import { checkProtectedRemainder } from './scope.js';
import { compileLiveIntent } from './live_intent.js';

export function evaluateLiveIntent(accepted, text, opts = {}) {
  const out = {
    status: 'INVALID',
    errors: [],
    warnings: [],
    intent: null,
    ops: [],
    scope: null,
    candidate: null,
    validation: null,
    created_questions: [],
  };

  const compiled = compileLiveIntent(accepted, text);
  if (compiled.errors) { out.errors = compiled.errors; return out; }
  out.intent = compiled.intent;

  if (compiled.status === 'CLARIFY') {
    out.status = 'CLARIFY';
    out.question = compiled.question;
    return out;
  }

  out.ops = compiled.ops;
  out.scope = compiled.scope;
  out.created_questions = compiled.created_questions || [];

  let candidate;
  try { candidate = applyOps(accepted, out.ops); }
  catch (e) { out.errors = [e.message]; return out; }

  candidate.freeze = { state: 'DRAFT' };

  let guard;
  try { guard = checkProtectedRemainder(accepted, candidate, out.scope); }
  catch (e) { out.errors = [`invalid edit scope: ${e.message}`]; return out; }
  out.scope = { ...out.scope, changed: guard.changed, forbidden: guard.forbidden };
  out.candidate = candidate;
  if (!guard.ok) {
    out.errors = guard.forbidden.map((p) => `protected remainder changed outside edit scope: ${p}`);
    return out;
  }

  const v = validate(candidate);
  out.validation = v;
  out.warnings = v.warnings;
  if (v.errors.length) { out.errors = v.errors; return out; }

  try {
    (opts.exportAll ?? exportAll)(candidate, v, `${candidate.meta.id}-rev${candidate.meta.revision}.aiconcept`);
  } catch (e) {
    out.errors = [`not exportable: ${e.message}`];
    return out;
  }

  out.status = 'VALID';
  return out;
}
