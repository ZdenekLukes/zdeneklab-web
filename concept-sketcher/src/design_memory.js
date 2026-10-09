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
export const EVIDENCE_BUDGET = 7000;   // characters of evidence lines per AI request
// a stated quantity: a number with a length/angle/mass/volume unit, or a × dimension
const QUANTITY = /\d\s*(?:mm|cm|m\b|milimetr|°|stup|deg|%|g\b|kg|ml|l\b|litr)|\d\s*[×xX*]\s*\d/iu;

// Typed claims are a convenience index over the literal journal, so they are
// extracted only from unambiguous wording. A number counts for a key only when it
// sits next to that key's own words in the same clause, and never from a clause
// about another component (a hole, a lid, a base, an arm …). Everything else stays
// as literal evidence: no claim is better than a wrong "user stated" value
// (e.g. "otvor v delší stěně (80 mm)" is not a wall thickness).
const NUM = '(-?\\d+(?:[.,]\\d+)?)';
const BOX_WORDS = /krabic|krabič|box|pouzd|enclosure|skříň|skrin/;
const OTHER_PART = /vík|viko|lid|cover|podstav|základn|zakladn|ramen|opěr|oper|desk|vlož|vloz|plášť|plast|čep|cep\b|tyč|tyc|mušl|musl|čepel|rukoj|hlav|nádob|nadob|tělo|telo|body|base|arm|plate|knob|otvor|díra|dír|hole|výřez|vyrez|kabel|šroub|sroub|screw|průměr|prumer|ø/;
const WALL_WORDS = /stěn|sten|wall/;
const THICK_WORDS = /tloušť|tloust|thick|siln/;
const HEIGHT_WORDS = /výšk|vysk|vysok|height/;
const clauses = (t) => t.split(/[.;:!?]\s+|,\s+|\n+/u).map((c) => c.trim()).filter(Boolean);
const sentences = (t) => t.split(/[.;!?]\s+|\n+/u).map((c) => c.trim()).filter(Boolean);
const numbers = (t) => [...t.matchAll(new RegExp(`${NUM}\\s*(?:mm|milimetr\\w*)?`, 'giu'))].map((m) => fmt(asNumber(m[1])));
// the first number after a key word in the clause ("stěny mají 2,5 mm, ne 2 mm" -> 2.5)
const after = (c, re) => { const m = new RegExp(`(?:${re.source})\\S*[^\\d]{0,24}?${NUM}\\s*(?:mm|milimetr\\w*)`, 'iu').exec(c); return m ? fmt(asNumber(m[1])) : null; };
const before = (c, re) => { const m = new RegExp(`${NUM}\\s*(?:mm|milimetr\\w*)\\s*(?:${re.source})`, 'iu').exec(c); return m ? fmt(asNumber(m[1])) : null; };
// a reply that is only a quantity ("2 mm", "2,5") answers the question it follows
const quantityOnly = (t) => /^\s*(?:je to|asi|cca|zhruba)?\s*-?\d+(?:[.,]\d+)?\s*(?:mm|milimetr\w*)?\s*\.?\s*$/iu.test(t);
const DIM_FILLER = /\b(?:to|je|jsou|na|tobě|tobe|ok|ano|vnější|vnejsi|vnitřní|rozměr\w*|rozmer\w*|outer|dimensions?|mm|celkem|cca|asi)\b/giu;

function extractClaims(text, question, seq) {
  const src = text.toLowerCase();
  const context = (question || '').toLowerCase();
  const claims = [];
  const triples = [...text.matchAll(/(-?\d+(?:[.,]\d+)?)\s*(?:mm)?\s*[×xX*]\s*(-?\d+(?:[.,]\d+)?)\s*(?:mm)?\s*[×xX*]\s*(-?\d+(?:[.,]\d+)?)\s*(?:mm)?/gu)];
  if (triples.length === 1 && !OTHER_PART.test(src)) {
    const rest = text.replace(triples[0][0], ' ').replace(/[^\p{L}]+/gu, ' ').replace(DIM_FILLER, ' ').trim();
    if (BOX_WORDS.test(src) || (BOX_WORDS.test(context) && !OTHER_PART.test(context)) || !rest) {
      claims.push({ key: 'box.outer_dimensions_mm', value: triples[0].slice(1, 4).map((x) => fmt(asNumber(x))), seq });
    }
  }
  let wall = null;
  for (const c of clauses(src)) {
    if (OTHER_PART.test(c)) continue;
    const v = after(c, WALL_WORDS) ?? (WALL_WORDS.test(context) && THICK_WORDS.test(c) ? after(c, THICK_WORDS) : null);
    if (v !== null) { wall = v; break; }
  }
  if (wall === null && quantityOnly(text) && WALL_WORDS.test(context) && !OTHER_PART.test(context)) wall = numbers(text)[0];
  if (wall !== null && wall !== undefined) claims.push({ key: 'box.wall_mm', value: wall, seq });
  let lid = null;
  for (const sn of sentences(src)) {
    if (!/vík|viko|lid/.test(sn)) continue;
    for (const c of clauses(sn)) {
      if (/celkov|total|overall|včetn|vcetn|s vík|s vik|with (?:the )?lid/.test(c)) continue;   // height of the whole, not of the lid
      lid = after(c, HEIGHT_WORDS) ?? before(c, HEIGHT_WORDS); if (lid !== null) break;
    }
    if (lid !== null) break;
  }
  if (lid === null && quantityOnly(text) && /vík|viko|lid/.test(context) && HEIGHT_WORDS.test(context)) lid = numbers(text)[0];
  if (lid !== null && lid !== undefined) claims.push({ key: 'lid.height_mm', value: lid, seq });
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
  // Evidence the AI receives: a fixed budget filled in priority order, never the
  // whole journal. 1 the first request and the source of every latest claim;
  // 2 statements lexically relevant to the current message; 3 every stated
  // quantity (dimensions, angles, counts with units), newest first, so a requirement
  // stated long ago and before several Accepts stays retrievable; 4 the latest
  // turns; 5 a little coverage per typed topic. A statement repeated word for word
  // is sent once (its newest occurrence).
  const query = clean(utterance + ' ' + lastQuestion);
  const qTopics = topicOf(query);
  const newestByText = new Map();
  for (const e of entries) newestByText.set(e.text, e.seq);
  const live = entries.filter((e) => newestByText.get(e.text) === e.seq);
  const bySeq = new Map(entries.map((e) => [e.seq, e]));
  const tiers = [];
  tiers.push([entries[0], ...facts.map((f) => bySeq.get(f.seq)).filter(Boolean)]);
  const terms = [...new Set((query.toLowerCase().match(/[a-zá-ž0-9_]{4,}/gu) || []))]
    .filter((t) => !/^(kter|jake|jaké|nebo|prosi|prosím|tento|that|with|have|should|bude|mají|jsou|jste|tuhle|dalsi|další)$/.test(t));
  tiers.push(terms.length ? live.map((e) => ({
    e, score: terms.reduce((score, word) => score + (e.text.toLowerCase().includes(word) ? 2 : 0)
      + ((e.question || '').toLowerCase().includes(word) ? 1 : 0), 0),
  })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score || b.e.seq - a.e.seq).slice(0, 12).map((x) => x.e) : []);
  tiers.push(live.filter((e) => QUANTITY.test(e.text)).reverse());
  tiers.push(live.slice(-10).reverse());
  tiers.push(Object.keys(TOPICS).flatMap((topic) => live.filter((e) => e.topics.includes(topic)).slice(-(qTopics.includes(topic) ? 5 : 2))).reverse());
  const output = []; const taken = new Set(); let used = 0;
  const add = (e) => {
    if (!e || taken.has(e.seq)) return;
    const line = { seq: e.seq, text: e.text.slice(0, 950),
      ...(e.question ? { answered_question: e.question.slice(0, 350) } : {}),
      ...(e.revision != null ? { revision_when_stated: e.revision } : {}) };
    const size = JSON.stringify(line).length;
    if (used + size <= EVIDENCE_BUDGET || !output.length) { output.push(line); used += size; taken.add(e.seq); }
  };
  for (const tier of tiers) tier.forEach(add);
  output.sort((a, b) => a.seq - b.seq);
  return { entries: entries.length, facts, evidence: output };
}

export const memoryEvidenceWords = (view) => Array.isArray(view?.evidence)
  ? view.evidence.filter((e) => typeof e.text === 'string').map((e) => e.text).join('\n') : '';
