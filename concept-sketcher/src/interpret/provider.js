// Interpreter Provider boundary (S2 design §3). A provider is untrusted and model-neutral:
//
//   interface InterpreterProvider {
//     id: string                                   // "fake:oracle", "recorded:<run>", later "<vendor>:<model>@<version>"
//     interpret(input) → Promise<{ text: string, meta?: object }>
//   }
//
// It receives the input package (interpret/input.js) and returns TEXT. It has no access to
// the session, the model object or any mutation path; interpretTurn() alone decides what
// happens to that text (parse → proposal → evaluateProposal → review → the user's ACCEPT).

import { acceptedModel, evaluate } from '../session.js?v=f5dbe684feae';
import { reviewProposal } from '../proposal.js?v=f5dbe684feae';
import { buildInput } from './input.js?v=f5dbe684feae';
import { parseResponse } from './protocol.js?v=f5dbe684feae';

export async function callProvider(provider, input) {
  if (!provider || typeof provider.id !== 'string' || typeof provider.interpret !== 'function') throw new Error('not an InterpreterProvider');
  const res = await provider.interpret(structuredClone(input));          // a copy: the provider cannot alias app state
  if (!res || typeof res.text !== 'string') throw new Error(`provider ${provider.id} must return { text }`);
  return { text: res.text, meta: res.meta ?? {} };
}

// A provider built from a function (fakes, recordings). The function sees only the input package.
export const functionProvider = (id, fn) => ({ id, interpret: async (input) => ({ text: await fn(input) }) });

// One user turn through the whole boundary. Nothing here mutates the session: the result
// carries an evaluation; only accept(session, proposalText) can create a revision.
export async function interpretTurn({ session, provider, utterance, turns = [], pending = null, selection = [] }) {
  const model = acceptedModel(session);
  const input = buildInput({ model, utterance, turns, pending, selection });
  const { text, meta } = await callProvider(provider, input);
  const parsed = parseResponse(text, { utterance, context: turns.slice(-6), model, source: provider.id });
  if (!parsed.ok) return { input, raw: text, meta, parsed, outcome: ['REJECTED'], evaluation: null, review: null };
  const evaluation = parsed.proposalText ? evaluate(session, parsed.proposalText) : null;
  const review = evaluation?.proposal ? reviewProposal(model, evaluation) : null;
  return { input, raw: text, meta, parsed, outcome: parsed.outcome, evaluation, review, proposalText: parsed.proposalText };
}
