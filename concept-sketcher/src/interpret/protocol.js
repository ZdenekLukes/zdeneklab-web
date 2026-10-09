// Closed interpreter response protocol (S2 design §5–§7). An interpreter (any LLM,
// or a fake) returns TEXT. This parser is the only thing that turns it into a
// proposal, and the proposal still goes through evaluateProposal() and ACCEPT.
// Anything outside the protocol refuses the whole response; nothing is repaired.

import { conceptHash, parseExpr } from '../model.js?v=13cdbd7449da';
import { OPS } from '../ops.js?v=13cdbd7449da';
import { PROPOSAL_FORMAT } from '../proposal.js?v=13cdbd7449da';
import { fold, quantities, ranges, justifies, assemblyDirection } from './normalize.js?v=13cdbd7449da';
import { mechanicalHits, isInterrogative } from './lexicon.js?v=13cdbd7449da';

export const RESPONSE_PROTOCOL = 'CS_INTERPRETER_RESPONSE';
export const DISPOSITIONS = ['STRUCTURED', 'OPEN', 'STATED', 'CLARIFY', 'NOT_MECHANICAL'];
const TOP_KEYS = ['protocol', 'version', 'utterance_id', 'understood', 'ledger', 'proposal', 'clarification', 'reply'];
const LEDGER_KEYS = ['id', 'u', 'quote', 'disposition', 'ops', 'ref'];
export const OP_REQUIRED = { ADD_PARAM: ['name', 'param'], ADD_PART: ['part'], ADD_FEATURE: ['feature'], ADD_JOINT: ['joint'], ADD_RULE: ['rule'],
  ADD_QUESTION: ['question'], SET: ['path', 'value'], UNSET: ['path'], DELETE: ['collection', 'id'], ANSWER_QUESTION: ['id', 'answer', 'facts'],
  ADD_INTERFACE: ['interface'], ADD_FASTENER: ['fastener'], ADD_VOLUME: ['volume'] };

// Error codes are stable: the evaluator maps them to critical-failure classes.
const err = (code, msg) => ({ code, msg });

const entityExists = (model, id) => typeof id === 'string'
  && ['parts', 'interfaces', 'features', 'joints', 'fasteners', 'volumes', 'rules', 'questions'].some((c) => (model[c] || []).some((e) => e.id === id));

// Find a quote in an utterance: exact, then case- and diacritics-insensitive. Offsets are ours, never the model's.
export function locateQuote(text, quote) {
  if (typeof quote !== 'string' || !quote.trim()) return null;
  let i = text.indexOf(quote);
  if (i >= 0) return [i, i + quote.length];
  i = fold(text).indexOf(fold(quote));
  return i >= 0 ? [i, i + fold(quote).length] : null;
}

// Every number an op states, with where it sits (literal numbers and numbers inside "=expr").
function numbersOf(value, path = '', out = []) {
  if (typeof value === 'number') out.push({ n: value, path });
  else if (typeof value === 'string' && value.startsWith('=')) {
    try {
      const walk = (ast, parentOp) => {
        if (ast.num !== undefined) out.push({ n: ast.num, path, expr: value, operandOf: parentOp });
        if (ast.a) walk(ast.a, ast.op);
        if (ast.b) walk(ast.b, ast.op);
      };
      walk(parseExpr(value.slice(1)), null);
    } catch { /* the boundary reports a bad expression */ }
  } else if (Array.isArray(value)) value.forEach((v, i) => numbersOf(v, `${path}/${i}`, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) numbersOf(v, `${path}/${k}`, out);
  return out;
}
// numbers of an op that are not the user's: text inside questions / answers is prose, not a value
function opNumbers(op) {
  if (op.op === 'ADD_QUESTION' || op.op === 'ANSWER_QUESTION' || op.op === 'DELETE') return [];
  const payload = { ...op }; delete payload.op; delete payload.evidence;
  if (op.op === 'ADD_RULE') delete payload.rule?.text;
  return numbersOf(payload);
}

// ctx: { utterance: {id, text}, context: [{id, text}] (earlier utterances in the input), model: accepted model, source }
export function parseResponse(raw, ctx) {
  const errors = [];
  let r;
  try { r = JSON.parse(raw); } catch (e) { return { ok: false, errors: [err('json', `response is not JSON: ${e.message}`)] }; }
  if (!r || typeof r !== 'object' || Array.isArray(r)) return { ok: false, errors: [err('shape', 'response must be a JSON object')] };
  for (const k of Object.keys(r)) if (!TOP_KEYS.includes(k)) errors.push(err('unknown_key', `unknown response key "${k}"`));
  for (const k of TOP_KEYS) if (!(k in r)) errors.push(err('shape', `response key "${k}" is required`));
  if (r.protocol !== RESPONSE_PROTOCOL || r.version !== 1) errors.push(err('shape', `protocol must be ${RESPONSE_PROTOCOL} version 1`));
  if (r.utterance_id !== ctx.utterance.id) errors.push(err('utterance_id', `utterance_id must be ${ctx.utterance.id}`));
  for (const k of ['understood', 'reply']) if (typeof r[k] !== 'string' || r[k].length > 600) errors.push(err('shape', `${k} must be text (≤ 600 characters)`));
  if (!Array.isArray(r.ledger)) errors.push(err('shape', 'ledger must be a list'));
  if (r.proposal !== null && !(r.proposal && typeof r.proposal === 'object' && !Array.isArray(r.proposal))) errors.push(err('shape', 'proposal must be an object or null'));
  if (r.clarification !== null && !(r.clarification && typeof r.clarification === 'object' && !Array.isArray(r.clarification))) errors.push(err('shape', 'clarification must be an object or null'));
  if (errors.length) return { ok: false, errors };

  const utterances = new Map([[ctx.utterance.id, ctx.utterance.text], ...(ctx.context || []).map((u) => [u.id, u.text])]);
  const ops = r.proposal ? r.proposal.ops : [];
  if (r.proposal) {
    for (const k of Object.keys(r.proposal)) if (!['summary', 'ops'].includes(k)) errors.push(err('unknown_key', `unknown proposal key "${k}"`));
    if (typeof r.proposal.summary !== 'string' || !Array.isArray(r.proposal.ops) || !r.proposal.ops.length) errors.push(err('shape', 'proposal needs a summary and at least one op (use null for no proposal)'));
  }
  if (errors.length) return { ok: false, errors };

  // ------------------------------------------------ ledger
  const ledger = [];
  const ids = new Set();
  for (const [n, e] of r.ledger.entries()) {
    const tag = `ledger ${n + 1}`;
    if (!e || typeof e !== 'object') { errors.push(err('shape', `${tag} must be an object`)); continue; }
    for (const k of Object.keys(e)) if (!LEDGER_KEYS.includes(k)) errors.push(err('unknown_key', `${tag}: unknown key "${k}"`));
    if (typeof e.id !== 'string' || !/^L\d+$/.test(e.id) || ids.has(e.id)) errors.push(err('shape', `${tag}: id must be a unique "L<n>"`));
    ids.add(e.id);
    if (!DISPOSITIONS.includes(e.disposition)) errors.push(err('shape', `${tag}: disposition must be one of ${DISPOSITIONS.join(', ')}`));
    if (e.ops !== undefined && !(Array.isArray(e.ops) && e.ops.every((i) => Number.isInteger(i) && i >= 1 && i <= ops.length))) errors.push(err('shape', `${tag}: ops must list op numbers 1…${ops.length}`));
    if (e.ref !== undefined && (typeof e.ref !== 'string' || !e.ref)) errors.push(err('shape', `${tag}: ref must be an id`));
    if (!utterances.has(e.u)) { errors.push(err('quote_not_in_context', `${tag}: utterance ${e.u} is not in the supplied context`)); continue; }
    const span = locateQuote(utterances.get(e.u), e.quote);
    if (!span) { errors.push(err('quote_not_found', `${tag}: "${e.quote}" does not occur in ${e.u}`)); continue; }
    ledger.push({ ...e, ops: e.ops || [], span });
  }
  if (errors.length) return { ok: false, errors };
  const byId = new Map(ledger.map((e) => [e.id, e]));

  // every op is accounted for by the ledger; evidence names ledger entries
  const linked = ops.map(() => new Set());
  for (const e of ledger) for (const i of e.ops) linked[i - 1].add(e.id);
  ops.forEach((op, i) => {
    const tag = `op ${i + 1}`;
    if (!op || typeof op !== 'object' || !OPS.includes(op.op)) { errors.push(err('unknown_op', `${tag}: ${JSON.stringify(op?.op)} is not a closed op`)); return; }
    for (const k of Object.keys(op)) if (!['op', 'evidence', ...OP_REQUIRED[op.op]].includes(k)) errors.push(err('unknown_key', `${tag} (${op.op}): unknown key "${k}"`));
    for (const k of OP_REQUIRED[op.op]) if (op[k] === undefined) errors.push(err('shape', `${tag} (${op.op}): "${k}" is required`));
    const refs = op.evidence === undefined ? [] : typeof op.evidence === 'string' ? [op.evidence] : (op.evidence && typeof op.evidence === 'object' && !Array.isArray(op.evidence) ? Object.values(op.evidence) : [null]);
    for (const ref of refs) {
      if (typeof ref !== 'string' || !byId.has(ref)) errors.push(err('evidence_ref', `${tag}: evidence must name ledger entries (got ${JSON.stringify(ref)})`));
      else linked[i].add(ref);
    }
    if (!linked[i].size) errors.push(err('op_unaccounted', `${tag} (${op.op}): no ledger entry accounts for it`));
  });
  if (errors.length) return { ok: false, errors };

  // dispositions are consistent with what the ops do
  const qops = (e) => e.ops.map((i) => ops[i - 1]);
  for (const e of ledger) {
    const tag = `ledger ${e.id} "${e.quote}"`;
    // STRUCTURED without ops only confirms something already in the model (ref names it)
    if (e.disposition === 'STRUCTURED' && !e.ops.length && !entityExists(ctx.model, e.ref)) errors.push(err('structured_without_ops', `${tag}: STRUCTURED needs the ops that carry it (or ref naming the existing entity it confirms)`));
    if (['CLARIFY', 'NOT_MECHANICAL'].includes(e.disposition) && e.ops.length) errors.push(err('shape', `${tag}: ${e.disposition} cannot carry ops`));
    if (e.disposition === 'STATED' && !qops(e).some((o) => o.op === 'ANSWER_QUESTION' && Array.isArray(o.facts) && o.facts.length === 0)) {
      errors.push(err('stated_without_question', `${tag}: STATED is recorded by ANSWER_QUESTION with facts: []`));
    }
    if (e.disposition === 'OPEN' && !qops(e).some((o) => o.op === 'ADD_QUESTION') && !(ctx.model.questions || []).some((q) => q.id === e.ref && q.status === 'OPEN')) {
      errors.push(err('open_without_question', `${tag}: OPEN needs ADD_QUESTION, or ref naming a question that is already OPEN`));
    }
    // NOT_MECHANICAL is not an escape hatch: mechanical words in it are refused (a plain why/what question excepted)
    if (e.disposition === 'NOT_MECHANICAL' && mechanicalHits(e.quote).length && !isInterrogative(e.quote)) {
      errors.push(err('not_mechanical_escape', `${tag}: declared NOT_MECHANICAL, but it states mechanics (${mechanicalHits(e.quote).map((h) => h.word).join(', ')})`));
    }
  }
  // omission: mechanical words of the current utterance that no ledger entry covers
  const current = ctx.utterance.text;
  const covered = ledger.filter((e) => e.u === ctx.utterance.id).map((e) => e.span);
  const uncovered = mechanicalHits(current).filter((h) => !covered.some(([a, b]) => h.start >= a && h.end <= b));
  if (uncovered.length && !isInterrogative(current)) {
    errors.push(err('unaccounted_mechanical_text', `mechanical words not accounted for by the ledger: ${[...new Set(uncovered.map((h) => current.slice(h.start, h.end)))].join(', ')}`));
  }

  // clarification: one question; the ops must not touch what it asks about
  const clar = r.clarification;
  if (clar) {
    for (const k of Object.keys(clar)) if (!['question', 'about', 'ledger', 'options'].includes(k)) errors.push(err('unknown_key', `clarification: unknown key "${k}"`));
    if (typeof clar.question !== 'string' || !clar.question.trim() || (clar.question.match(/\?/g) || []).length > 1) errors.push(err('shape', 'clarification.question must be one question'));
    if (!Array.isArray(clar.about) || !Array.isArray(clar.ledger) || !Array.isArray(clar.options)) errors.push(err('shape', 'clarification needs about, ledger and options lists'));
    else {
      for (const l of clar.ledger) if (byId.get(l)?.disposition !== 'CLARIFY') errors.push(err('shape', `clarification.ledger ${l} must be a CLARIFY entry`));
      const touched = JSON.stringify(ops);
      for (const a of clar.about) if (new RegExp(`(^|[^A-Z0-9_])${a}([^A-Z0-9_]|$)`).test(touched)) errors.push(err('clarify_conflict', `the ops touch ${a}, which the clarification asks about`));
    }
  }
  for (const e of ledger) if (e.disposition === 'CLARIFY' && !(clar?.ledger || []).includes(e.id)) errors.push(err('shape', `ledger ${e.id}: CLARIFY entries belong to the clarification`));

  // numbers: stated by the linked spans, or a PLACEHOLDER — never an unmarked assumption
  const placeholders = new Set([
    ...Object.entries(ctx.model.params || {}).filter(([, p]) => p.status === 'placeholder').map(([k]) => k),
    ...ops.filter((o) => o.op === 'ADD_PARAM' && o.param?.status === 'placeholder').map((o) => o.name)]);
  ops.forEach((op, i) => {
    if (op.op === 'ADD_PARAM' && op.param?.status === 'placeholder') return;                       // the assumed value itself
    if (op.op === 'SET' && /^params\/[^/]+\/value$/.test(op.path) && placeholders.has(op.path.split('/')[1])) return;
    const spans = [...linked[i]].map((l) => byId.get(l)).map((e) => fold(utterances.get(e.u)).slice(e.span[0], e.span[1]));
    for (const x of opNumbers(op)) {
      if (x.n === 0) continue;
      if (x.expr && x.n === 2 && ['*', '/'].includes(x.operandOf)) continue;                        // halving / doubling a named value
      if (spans.some((t) => justifies(t, x.n))) continue;
      errors.push(err('unjustified_number', `op ${i + 1} (${op.op}): ${x.n}${x.path ? ` at ${x.path}` : ''} is not stated in its evidence — use the user's number, or a PLACEHOLDER parameter`));
    }
  });
  // approximation is provenance: a number the user qualified ("tak", "zhruba", "about") lives in a parameter
  // with status "rough"; "rough" in turn needs those words. Neither may be dropped or invented.
  const approxOnly = (texts, n) => {
    const near = (x) => Math.abs(Math.abs(x) - Math.abs(n)) < 1e-9;
    const all = [...texts.flatMap((t) => quantities(t)).filter((q) => near(q.value) || near(q.raw)),
      ...texts.flatMap((t) => ranges(t)).filter((r) => near(r.min) || near(r.max))];
    return all.length > 0 && all.every((x) => x.approx);
  };
  ops.forEach((op, i) => {
    const texts = [...linked[i]].map((l) => byId.get(l)).map((e) => utterances.get(e.u).slice(e.span[0], e.span[1]));
    if (op.op === 'ADD_PARAM' && op.param?.status === 'rough' && typeof op.param.value === 'number' && !approxOnly(texts, op.param.value)) {
      errors.push(err('rough_without_approximation', `op ${i + 1} (ADD_PARAM ${op.name}): status "rough" says the user gave ${op.param.value} approximately, but its evidence does not qualify that number (tak / asi / zhruba / about …)`));
    }
    if (op.op === 'ADD_PARAM' && ['rough', 'placeholder'].includes(op.param?.status)) return;
    if (op.op === 'SET' && /^params\/[^/]+\/value$/.test(op.path) && placeholders.has(op.path.split('/')[1])) return;
    for (const x of opNumbers(op)) {
      if (x.n === 0 || (x.expr && x.n === 2)) continue;
      if (approxOnly(texts, x.n)) errors.push(err('approximation_lost', `op ${i + 1} (${op.op}): the user gave ${x.n} approximately; keep it as a parameter with status "rough" and reference it ("=name"), not as an exact value`));
    }
  });
  // assembly direction: derived from the user's words (removal words invert the motion), never a sign the provider chose
  const AXIS = /^[+-][XYZ]$/;
  ops.forEach((op, i) => {
    const set = [];
    if (op.op === 'SET' && /^joints\/[^/]+\/assembly\/direction$/.test(op.path) && AXIS.test(op.value)) set.push(op.value);
    if (op.op === 'SET' && /^joints\/[^/]+\/assembly$/.test(op.path) && AXIS.test(op.value?.direction)) set.push(op.value.direction);
    if (op.op === 'ADD_JOINT' && AXIS.test(op.joint?.assembly?.direction)) set.push(op.joint.assembly.direction);
    if (!set.length) return;
    const said = [...linked[i]].map((l) => byId.get(l)).map((e) => assemblyDirection(utterances.get(e.u).slice(e.span[0], e.span[1])));
    for (const d of set) {
      if (said.some((x) => x.direction === d)) continue;
      const other = said.find((x) => x.direction);
      if (other) errors.push(err('direction_mismatch', `op ${i + 1} (${op.op}): assembly direction ${d} contradicts the words (${other.sense} along ${other.motion} → assembly direction ${other.direction})`));
      else errors.push(err('direction_not_stated', `op ${i + 1} (${op.op}): assembly direction ${d} is not stated by its evidence — the user must say the direction (an axis or up / down) and whether the part is inserted or removed that way`));
    }
  });
  if (errors.length) return { ok: false, errors };

  // outcome (derived, never declared)
  const outcome = [];
  if (ops.length) outcome.push('PROPOSE');
  if (clar) outcome.push('CLARIFY');
  if (!outcome.length) {
    // no change: talk, a fact that stays OPEN, or a confirmation of what the model already says
    const unchanged = (e) => e.disposition === 'NOT_MECHANICAL' || (!e.ops.length && ['OPEN', 'STRUCTURED'].includes(e.disposition));
    if (!ledger.every(unchanged)) return { ok: false, errors: [err('dropped_meaning', 'the ledger names mechanical meaning, but there is neither a proposal nor a clarification')] };
    outcome.push('NO_CHANGE');
  }

  // the proposal for the existing transaction boundary: evidence becomes {u, quote}
  let proposalText = null;
  if (ops.length || clar) {
    const quote = (l) => { const e = byId.get(l); return { u: e.u, quote: utterances.get(e.u).slice(e.span[0], e.span[1]) }; };
    const outOps = ops.map((op) => {
      if (op.evidence === undefined) return op;
      const ev = typeof op.evidence === 'string' ? quote(op.evidence) : Object.fromEntries(Object.entries(op.evidence).map(([f, l]) => [f, quote(l)]));
      return { ...op, evidence: ev };
    });
    const usedOlder = [...new Set(ledger.filter((e) => e.u !== ctx.utterance.id).map((e) => e.u))];
    proposalText = JSON.stringify({ format: PROPOSAL_FORMAT, schema: 1,
      base: { revision: ctx.model.meta.revision, hash: conceptHash(ctx.model) },
      utterance: current, utterance_id: ctx.utterance.id,
      ...(usedOlder.length ? { context: usedOlder.map((id) => ({ id, text: utterances.get(id) })) } : {}),
      summary: r.proposal?.summary ?? 'clarification', source: ctx.source ?? 'interpreter', clarification: clar?.question ?? null, ops: outOps });
  }
  return { ok: true, errors: [], outcome, ledger, proposalText, clarification: clar ?? null, understood: r.understood, reply: r.reply,
    uncovered: uncovered.map((h) => current.slice(h.start, h.end)), quantities: quantities(current), ranges: ranges(current) };
}
