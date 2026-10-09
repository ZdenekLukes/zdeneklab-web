// Durable design requirements memory. Not part of the accepted CAD model.
// Every record is a literal USER utterance, optionally paired with the question
// it answered (the question is context, never an authoritative requirement).
// A lossless journal is saved with the product; only a bounded evidence view is
// sent to the AI. No model-generated summaries can become user facts.
export const MEMORY_FORMAT = 'CONCEPT_REQUIREMENTS_V1';
export const emptyMemory = () => ({ format: MEMORY_FORMAT, seq: 0, entries: [] });
const clean = (s) => String(s ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim();
const asNumber = (s) => Number(String(s).replace(',', '.'));
const has = (s, re) => re.test(s.toLowerCase());
const TOPICS = {
  box: /krabic|krabič|box|pouzd|enclosure|rozměr|dimension|vnější|outer|šířk|hloubk|výšk/,
  wall: /stěn|sten|tloušť|tloust|wall|thick|dno|bottom|base/,
  lid: /vík|viko|lid|cover|zavřen|closed/,
  hinge: /pant|čep|cep|hinge|pin|kloub|pivot|nevyjímat|nevynd|integrovan/,
  hole: /otvor|dír|dir|hole|bore|výřez|vyrez|slot/,
  fastener: /šroub|sroub|matic|závit|zavit|screw|thread|mount/,
  material: /materiál|material|tisk|print|pla|petg|kov|metal/,
  shape: /tvar|shape|hrana|edge|roh|corner|zaoblen|rounded|profil|profile/,
};
const topicOf = (s) => Object.entries(TOPICS).filter(([, re]) => has(s, re)).map(([key]) => key);
const isAnswer = (s) => /^(ano|ne|yes|no|jo|jasn|samozřej|ok|dobře|vlevo|vpravo|nahoře|dole|uprostřed|pev|voln|integrovan|odnímat|nevyjímat)/i.test(s);
const fmt = (v) => Number(v.toFixed(6));

function extractClaims(text, question, seq) {
  const src = text.toLowerCase();
  const context = (question || '').toLowerCase();
  const claims = [];
  const triple = /(-?\d+(?:[.,]\d+)?)\s*(?:mm)?\s*[×xX*]\s*(-?\d+(?:[.,]\d+)?)\s*(?:mm)?\s*[×xX*]\s*(-?\d+(?:[.,]\d+)?)\s*(?:mm)?/u.exec(text);
  if (triple && !/vík|viko|lid|cover/.test(src + ' ' + context)) {
    claims.push({ key: 'box.outer_dimensions_mm', value: triple.slice(1, 4).map((x) => fmt(asNumber(x))), seq });
  }
  // A single width/depth/height may be stated after a specific clarifying
  // question. Preserve it as a sourced claim, not an inferred other dimension.
  const mm = /(-?\d+(?:[.,]\d+)?)\s*(?:mm|milimetr|milimetrů)\b/iu.exec(text);
  const numeral = mm || (/^\s*(-?\d+(?:[.,]\d+)?)\s*$/u.exec(text));
  if (numeral) {
    const val = fmt(asNumber(numeral[1]));
    const w = src + ' ' + context;
    if (/stěn|sten|tloušť|tloust|wall|thick/.test(w) && !/vík|viko|lid/.test(src)) {
      claims.push({ key: 'box.wall_mm', value: val, seq });
    } else if (/vík|viko|lid/.test(w) && /výšk|vysk|height|vysok/.test(w)) {
      claims.push({ key: 'lid.height_mm', value: val, seq });
    }
  }
  const hinge = src + ' ' + context;
  if (/pant|hinge|čep|cep|pin/.test(hinge)) {
    if (/nevyjímateln|nevyjimateln|neodnímateln|neodnimateln|nevyndateln|non.removable|fixed pin/.test(src))
      claims.push({ key: 'hinge.pin_removable', value: false, seq });
    else if (/vyjímateln|vyjimateln|odnímateln|odnimateln|removable/.test(src))
      claims.push({ key: 'hinge.pin_removable', value: true, seq });
    if (/integrovan|integrat|součást|soucast|built.in/.test(src))
      claims.push({ key: 'hinge.integrated', value: true, seq });
    if (/zadní hran|zadni hran|rear edge|back edge/.test(src))
      claims.push({ key: 'hinge.edge', value: 'back', seq });
    if (/přední hran|predni hran|front edge/.test(src))
      claims.push({ key: 'hinge.edge', value: 'front', seq });
  }
  return claims;
}

export function appendMemory(memory, utterance, { question = '', revision = null } = {}) {
  const text = clean(utterance);
  if (!text) return memory;
  if (text.length > 16000) throw new Error('design requirement is longer than 16000 characters');
  const seq = memory.seq + 1;
  const context = clean(question).slice(0, 1200);
  const topics = [...new Set([...topicOf(text), ...(isAnswer(text) ? topicOf(context) : [])])];
  const entry = { seq, text, ...(context ? { question: context } : {}),
    topics, claims: extractClaims(text, context, seq),
    ...(revision == null ? {} : { revision }) };
  return { format: MEMORY_FORMAT, seq, entries: [...memory.entries, entry] };
}

export function validateMemory(raw) {
  if (raw == null) return emptyMemory();
  if (!raw || raw.format !== MEMORY_FORMAT || !Number.isSafeInteger(raw.seq) || raw.seq < 0 || !Array.isArray(raw.entries)) {
    throw new Error('invalid design-memory format');
  }
  let last = 0;
  const entries = raw.entries.map((e) => {
    if (!e || !Number.isSafeInteger(e.seq) || e.seq <= last || e.seq > raw.seq ||
      typeof e.text !== 'string' || !e.text.trim() || e.text.length > 16000 ||
      (e.question !== undefined && (typeof e.question !== 'string' || e.question.length > 1200))) {
      throw new Error('invalid or out-of-order design-memory entry');
    }
    last = e.seq;
    // Never trust cached classifications from files; derive from the user's
    // original words, making imports deterministic and provenance verifiable.
    const topics = [...new Set([...topicOf(e.text), ...(isAnswer(e.text) ? topicOf(e.question || '') : [])])];
    return { seq: e.seq, text: e.text, ...(e.question ? { question: e.question } : {}),
      topics, claims: extractClaims(e.text, e.question || '', e.seq),
      ...(Number.isInteger(e.revision) ? { revision: e.revision } : {}) };
  });
  return { format: MEMORY_FORMAT, seq: raw.seq, entries };
}

export function memoryFromConcept(raw) {
  const doc = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return validateMemory(doc?.history?.design_memory);
}

export function exportWithMemory(sessionJson, memory) {
  const parsed = typeof sessionJson === 'string' ? JSON.parse(sessionJson) : structuredClone(sessionJson);
  if (!parsed.history || typeof parsed.history !== 'object') throw new Error('memory export requires a session history');
  parsed.history.design_memory = validateMemory(memory);
  return JSON.stringify(parsed, null, 2) + '\n';
}

export function memoryView(memory, utterance = '', accepted = null, lastQuestion = '') {
  const entries = validateMemory(memory).entries;
  if (!entries.length) return { facts: [], evidence: [], entries: 0 };
  // Latest explicit user claim wins. Both the source and the value remain
  // available; status is "stated" unless verified from the accepted CAD model.
  const latest = new Map();
  for (const e of entries) for (const f of e.claims) latest.set(f.key, { ...f, text: e.text });
  const facts = [...latest.values()].map((f) => {
    const k = f.key, box = accepted?.parts?.find((p) => p.id === 'BOX' || p.kind === 'SHELL');
    let acceptedInModel = false;
    if (box && k === 'box.outer_dimensions_mm') acceptedInModel = JSON.stringify(box.size) === JSON.stringify(f.value);
    if (box && k === 'box.wall_mm') acceptedInModel = box.wall === f.value;
    return { ...f, status: acceptedInModel ? 'accepted_in_model' : 'user_stated_not_accepted' };
  });
  // Relevant user statements from across the entire journal, selected from
  // typed topics plus exact word overlap; all eight topic groups get a limited
  // amount of coverage so a hinge/lid decision remains visible after 300 turns.
  const query = clean(utterance + ' ' + lastQuestion);
  const qTopics = topicOf(query);
  const chosen = new Map();
  const pick = (e) => chosen.set(e.seq, e);
  pick(entries[0]);
  for (const topic of Object.keys(TOPICS)) {
    const matches = entries.filter((e) => e.topics.includes(topic));
    const weight = qTopics.includes(topic) ? 5 : 2;
    matches.slice(-weight).forEach(pick);
  }
  // Lexical retrieval across the complete, untruncated journal supports
  // arbitrary part/feature names beyond the finite typed categories.
  const terms = [...new Set((query.toLowerCase().match(/[a-zá-ž0-9_]{4,}/gu) || []))]
    .filter((t) => !/^(kter|jake|jaké|nebo|prosi|prosím|tento|that|with|have|should|bude|mají|jsou|jste|tuhle|dalsi|další)$/.test(t));
  if (terms.length) entries.map((e) => ({
    e, score: terms.reduce((score, word) => score + (e.text.toLowerCase().includes(word) ? 2 : 0)
      + ((e.question || '').toLowerCase().includes(word) ? 1 : 0), 0),
  })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score || b.e.seq - a.e.seq)
    .slice(0, 12).forEach((x) => pick(x.e));
  entries.slice(-10).forEach(pick);
  for (const f of facts) { const e = entries.find((x) => x.seq === f.seq); if (e) pick(e); }
  const ranked = [...chosen.values()].sort((a, b) => a.seq - b.seq);
  // Budget is fixed, not proportional to the journal size. Pin source of the
  // first statement and latest claims; prioritize latest/relevant evidence.
  const latestSeq = new Set(facts.map((f) => f.seq));
  const mandatory = new Set([entries[0].seq, ...latestSeq]);
  const output = []; let used = 0;
  const add = (e) => {
    const line = { seq: e.seq, text: e.text.slice(0, 950),
      ...(e.question ? { answered_question: e.question.slice(0, 350) } : {}),
      ...(e.revision != null ? { revision_when_stated: e.revision } : {}) };
    const size = JSON.stringify(line).length;
    if (used + size <= 7000 || !output.length) { output.push(line); used += size; }
  };
  ranked.filter((e) => mandatory.has(e.seq)).forEach(add);
  ranked.filter((e) => !mandatory.has(e.seq)).sort((a, b) => b.seq - a.seq).forEach(add);
  output.sort((a, b) => a.seq - b.seq);
  return { entries: entries.length, facts, evidence: output };
}

export const memoryEvidenceWords = (view) => Array.isArray(view?.evidence)
  ? view.evidence.filter((e) => typeof e.text === 'string').map((e) => e.text).join('\n') : '';
