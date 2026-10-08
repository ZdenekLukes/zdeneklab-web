// S1 stand-in for the LLM. Deterministic: the same text + model give the same
// proposal text. Like a real LLM it only returns TEXT; it has no access to the
// session and cannot change anything. Its output passes the same transaction
// boundary (src/proposal.js) a real model's output will pass in S2.
// It knows a handful of intents (English and Czech trigger phrases); anything
// else gets a clarification reply, never a guess.

import { conceptHash } from '../model.js?v=ade26ee692ab';
import { normalizeText } from '../proposal.js?v=ade26ee692ab';

const INTENTS = [
  { id: 'dont-know', triggers: ["i don't know", 'i dont know', 'not sure yet', 'zatim nevim', 'nevim'] },
  { id: 'eyes', triggers: ['opposing eye rows on the long sides', 'eye rows on the long sides', 'eyes on the long sides',
    'proti sobe ocka', 'ocka na dlouhych stranach'] },
  { id: 'tabs-sideways', triggers: ['must point sideways', 'point sideways', 'do stran', 'do boku'] },
  { id: 'seat', triggers: ['tabs into the eyes', 'tabs go into the eyes', 'taby do ocek', 'zasun taby'] },
  { id: 'fit', triggers: ['should fit', 'must fit', 'fit is', 'fit them', 'fit snug', 'fit loose', 'sedet', 'maji sedet', 'uloz'] },
  { id: 'deeper-eyes', triggers: ['eyes deeper', 'deeper eyes', 'hlubsi ocka'] },
  { id: 'stronger', triggers: ['make it stronger', 'stronger', 'pevnejsi', 'zpevni'] },
];

export const DEMO_SENTENCES = [
  'Add opposing eye rows on the long sides.',
  'Those divider tabs point the wrong way. They must point sideways.',
  'Put the divider tabs into the eyes.',
  'The tabs should fit snugly in the eyes.',
  'Make the eyes deeper, 6 mm.',
  'Make it stronger.',
  "I don't know yet.",
  'Na dlouhých stranách budou proti sobě očka.',
];

function match(text) {
  const t = normalizeText(text);
  for (const intent of INTENTS) {
    const trig = intent.triggers.find((x) => t.includes(normalizeText(x)));
    if (trig) return { intent: intent.id, evidence: trig };
  }
  return null;
}

// fit words the user may say → fit value (the matched word is the evidence)
const FIT_WORDS = [
  [/press[- ]?fit|pressed in|nalis\w*|natlac\w*/, 'PRESS'],
  [/snug\w*|tight\w*|tesne|tesny|tesna/, 'SNUG'],
  [/sliding|slide|posuvn\w*/, 'SLIDING'],
  [/clearance|with play|s vuli/, 'CLEARANCE'],
  [/loose\w*|volne|volny|volna/, 'LOOSE'],
];
function detectFit(text) {
  const t = normalizeText(text);
  for (const [re, value] of FIT_WORDS) { const m = re.exec(t); if (m) return { value, evidence: m[0] }; }
  return null;
}

const nextQ = (model, n = 1) => {
  const used = new Set((model.questions || []).map((q) => q.id));
  const out = [];
  for (let i = 1; out.length < n; i++) if (!used.has(`Q${i}`)) out.push(`Q${i}`);
  return out;
};

export function interpret(text, model) {
  const base = { revision: model.meta.revision, hash: conceptHash(model) };
  const reply = (clarification, summary = 'No change proposed.') =>
    JSON.stringify({ format: 'AI_CONCEPT_PROPOSAL', schema: 1, base, utterance: text, summary, source: 'fixture:clarify', clarification, ops: [] });
  const propose = (source, summary, ops, clarification = null) =>
    JSON.stringify({ format: 'AI_CONCEPT_PROPOSAL', schema: 1, base, utterance: text, summary, source: `fixture:${source}`, clarification, ops });
  const m = match(text);
  const has = (coll, id) => (model[coll] || []).some((x) => x.id === id);
  const open = (model.questions || []).filter((q) => q.status === 'OPEN').map((q) => q.id);

  if (!m) {
    return reply(`I can't turn that into a concept change yet. This S1 demo interpreter is deterministic and understands only these sentences: ${DEMO_SENTENCES.map((s) => `“${s}”`).join(' ')}`);
  }
  switch (m.intent) {
    case 'dont-know':
      return reply(open.length
        ? `Fine — ${open.join(', ')} stay OPEN. They are carried into every output and block SKELETON READY until you decide.`
        : 'Nothing is open at the moment.');
    case 'eyes': {
      if (has('features', 'EYE_A')) return reply('The long sides already have opposing eye rows (EYE_A / EYE_B).');
      return propose('eyes', 'Add a row of eyes on the inner face of long side LONG_A and a mirrored, one-to-one paired row on LONG_B.', [
        { op: 'ADD_FEATURE', evidence: { edge: m.evidence, face: m.evidence, bore_axis: m.evidence }, feature: { id: 'EYE_A', host: 'BASE', type: 'EYE', edge: '+Y', face: 'INNER',
          bore_axis: 'EDGE_NORMAL', size: { bore: '=eye_bore', depth: '=eye_d' }, z: 'MID',
          array: { along: 'EDGE', span: 'HOST_FACE', pitch: '=eye_pitch', margin: '=eye_margin', count: 'DERIVED', placement: 'CENTRED' } } },
        { op: 'ADD_FEATURE', evidence: m.evidence, feature: { id: 'EYE_B', mirror: { of: 'EYE_A', plane: 'XZ', pair_by_index: true } } },
      ]);
    }
    case 'tabs-sideways': {
      const tab = (model.features || []).find((f) => f.id === 'TAB_R');
      if (!tab) return reply('There are no divider tabs yet.');
      if (tab.edge === '+X') return reply('The divider tabs already point sideways (world ±Y).');
      return propose('tabs-sideways', 'Move TAB_R to the right edge of the divider, flush with its bottom end, so it points sideways (world +Y); TAB_L follows as its mirror (world −Y). Add rule R2 so this cannot regress.', [
        { op: 'SET', path: 'features/TAB_R/edge', value: '+X', evidence: m.evidence },
        { op: 'SET', path: 'features/TAB_R/at', value: { from: '-Y', offset: 0 }, evidence: m.evidence },
        { op: 'ADD_RULE', evidence: m.evidence, rule: { id: 'R2', kind: 'MUST', text: 'Divider tabs point sideways (horizontal, outward), not down.',
          check: { type: 'DIRECTION', features: { 'DIVIDER.TAB_L': '-Y', 'DIVIDER.TAB_R': '+Y' } } } },
      ]);
    }
    case 'seat': {
      if (has('joints', 'SEAT')) return reply('The divider tabs are already connected to the eyes (joint SEAT).');
      const fit = detectFit(text);
      const [qi, qr, qf] = nextQ(model, 3);
      const ops = [
        { op: 'ADD_QUESTION', question: { id: qi, status: 'OPEN', blocks: 'SKELETON_READY', about: ['SEAT', 'BASE.EYE_A', 'BASE.EYE_B', 'DIVIDER.TAB_L', 'DIVIDER.TAB_R'],
          text: 'How does a rigid divider with two outward tabs get into two closed, opposing eyes?',
          options: ['compliant eye', 'compliant divider', 'open / slotted eye', 'temporary frame displacement', 'other, user-defined'],
          options_note: 'Examples only. None is a default or a recommendation.' } },
        { op: 'ADD_QUESTION', question: { id: qr, status: 'OPEN', blocks: 'SKELETON_READY', about: ['SEAT', 'DIVIDER', 'DIVIDER.TAB_L', 'DIVIDER.TAB_R'],
          text: 'The two tabs are coaxial, which leaves a rotation about their axis. What prevents it, or is rotation acceptable?',
          options: ['explicit anti-rotation mechanism, user-defined', 'rotation is acceptable (explicit statement)'],
          options_note: 'Examples only. None is a default or a recommendation.' } },
      ];
      if (!fit) {
        ops.push({ op: 'ADD_QUESTION', question: { id: qf, status: 'OPEN', blocks: 'SKELETON_READY', about: ['SEAT', 'DIVIDER.TAB_L', 'DIVIDER.TAB_R', 'BASE.EYE_A', 'BASE.EYE_B'],
          text: 'How should the tabs fit in the eyes?',
          options: ['loose', 'clearance', 'sliding', 'snug', 'press fit'],
          options_note: 'Examples only. None is a default or a recommendation.' } });
      }
      const place = (model.parts || []).find((p) => p.id === 'DIVIDER')?.place;
      if (place) ops.push({ op: 'UNSET', path: 'parts/DIVIDER/place' });
      const evidence = { type: m.evidence, links: m.evidence, ...(fit ? { fit: fit.evidence } : {}) };
      ops.push({ op: 'ADD_JOINT', evidence, joint: { id: 'SEAT', type: 'INSERTS_INTO', part: 'DIVIDER',
        links: [{ male: 'DIVIDER.TAB_R', female: 'BASE.EYE_A[i]' }, { male: 'DIVIDER.TAB_L', female: 'BASE.EYE_B[i]' }],
        index: { var: 'i', domain: 'ANY', preview: [4, 12, 20] }, engage: '=tab_len - clear',
        dof: `OPEN:${qr}`, fit: fit ? fit.value : `OPEN:${qf}`, assembly_motion: `OPEN:${qi}`, anti_rotation: `OPEN:${qr}`,
        intent: 'A divider can be seated in any opposing eye pair.' } });
      const openList = fit ? `${qi}, ${qr}` : `${qi}, ${qr}, ${qf}`;
      return propose('seat', `Seat the divider by inserting TAB_R/TAB_L into an opposing eye pair (any pair; shown at 4, 12, 20). ${fit ? `Fit ${fit.value} as you said. ` : ''}How it gets in, what stops it rotating${fit ? '' : ' and how tight it fits'} is not said, so it is recorded as ${openList} (OPEN), not chosen.`,
        ops, `I don't know how the divider gets into the eyes, what stops it rotating${fit ? '' : ' or how tight the tabs should fit'}. I recorded ${fit ? 'both' : 'these'} as OPEN questions (${openList}) instead of choosing.`);
    }
    case 'fit': {
      const seat = (model.joints || []).find((j) => j.id === 'SEAT');
      if (!seat) return reply('There is no tab–eye connection yet to give a fit to.');
      const fit = detectFit(text);
      if (!fit) return reply('Which fit do you mean — loose, clearance, sliding, snug or press fit?');
      if (!String(seat.fit).startsWith('OPEN:')) {
        return propose('fit', `Change the tab–eye fit from ${seat.fit} to ${fit.value}.`, [{ op: 'SET', path: 'joints/SEAT/fit', value: fit.value, evidence: fit.evidence }]);
      }
      const q = seat.fit.slice(5);
      return propose('fit', `Answer ${q}: the tabs fit ${fit.value} in the eyes.`, [
        { op: 'ANSWER_QUESTION', id: q, answer: `Fit: ${fit.value} (user: "${fit.evidence}").`, evidence: fit.evidence },
        { op: 'SET', path: 'joints/SEAT/fit', value: fit.value, evidence: fit.evidence },
      ]);
    }
    case 'deeper-eyes': {
      const mm = /(\d+(?:[.,]\d+)?)\s*mm/.exec(text);
      const value = mm ? Number(mm[1].replace(',', '.')) : null;
      if (value === null) return reply('How deep should the eyes be (in mm)?');
      return propose('deeper-eyes', `Set the eye depth eye_d to ${value} mm (a rough number).`, [{ op: 'SET', path: 'params/eye_d/value', value }]);
    }
    case 'stronger':
      return reply('What should be stronger — the base frame, the dividers, or the tab–eye connection? And against what: bending, pulling out, or the spring force?');
    default:
      return reply('Not understood.');
  }
}
