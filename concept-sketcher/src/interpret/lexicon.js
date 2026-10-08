// Mechanically relevant words (CS / EN, folded stems). Used by the response parser to
// catch omission: mechanical words that no ledger entry accounts for, and mechanical
// text declared NOT_MECHANICAL. Deterministic and deliberately conservative: everyday
// words that are only sometimes mechanical ("right", "back", "up" alone) are not listed,
// so a false alarm cannot block ordinary talk; the gold evaluation covers the rest.

import { fold, quantities, nominals } from './normalize.js?v=ade26ee692ab';

const STEMS = [
  // parts and features
  'sroub', 'srouby', 'srouba', 'sroubk', 'matk', 'dira', 'diru', 'diry', 'der', 'otvor', 'vyrez', 'drazk', 'cep', 'cepy', 'cepu', 'hridel', 'osa', 'osou', 'osy',
  'pant', 'klou', 'vik', 'kryt', 'drzak', 'drzac', 'svork', 'desk', 'trubk', 'tyc', 'valec', 'krabic', 'pouzdr', 'sten', 'kolo', 'kola', 'ozuben', 'pastor',
  'remen', 'kladk', 'pruzin', 'pruzn', 'konektor', 'kabel', 'modul', 'kamer',
  'screw', 'bolt', 'nut!', 'nuts', 'hole', 'bore', 'opening', 'cutout', 'slot', 'pin', 'shaft', 'axle', 'axis', 'hinge', 'pivot', 'lid', 'cover', 'bracket', 'clamp', 'plate',
  'tube', 'rod!', 'rods', 'cylinder', 'enclosure', 'housing', 'gear', 'pinion', 'belt', 'pulley', 'spring', 'connector', 'cable', 'module', 'camera',
  // relations, motion, retention
  'otac', 'otoc', 'toci', 'tocit', 'rotac', 'naklap', 'naklon', 'posuv', 'vysuv', 'kolejn', 'prevod', 'pomer', 'zacvak', 'zaklap', 'cvakn', 'prisroub', 'prilep', 'lepen', 'nalis', 'lisov',
  'tesn', 'vul', 'toleranc', 'zavit', 'vyjm', 'sund', 'odnim', 'odebr', 'servis', 'pristup', 'doraz', 'pevne', 'pevny', 'nehyb', 'uchyc', 'upevn', 'drzi', 'drzet',
  'rotate', 'rotation', 'turn', 'spin', 'swing', 'tilt', 'slide', 'sliding', 'rail', 'ratio', 'mesh', 'snap', 'clip', 'latch', 'flex', 'fasten', 'glue', 'bond',
  'press', 'fit!', 'fits', 'tight', 'loose', 'clearance', 'tolerance', 'thread', 'tapped', 'remov', 'detach', 'service', 'access', 'keep', 'limit', 'stop', 'fixed', 'attach', 'mount',
  // directions and geometry words that are unambiguous
  'nahoru', 'dolu', 'vzhuru', 'svisl', 'vodorov', 'do stran', 'kolm', 'rovnobez', 'zrcadl', 'symetr', 'prumer', 'sirk', 'vysk', 'delk', 'tloust', 'hloub',
  'upward', 'downward', 'sideways', 'vertical', 'horizontal', 'perpendicular', 'parallel', 'mirror', 'symmetric', 'diameter', 'width', 'height', 'length', 'thick', 'depth',
  // materials and loads (outside the language, still mechanically relevant)
  'alumin', 'hlinik', 'ocel', 'steel', 'plast', 'kg', 'gram', 'kilogram', 'zatiz', 'load', 'weight', 'hmotnost',
  // negated intent
  'nesmi', 'nechci', 'nedava', 'must not', 'mustn', "don't want", 'no hole', 'no screw',
];
// a stem matches a word start; "!" = the whole word only ("nut" but not Czech "nutne")
const STEM_RE = new RegExp(`(^|[^a-z])(${STEMS.map((s) => s.replace(/!$/, '').replace(/[.*+?^${}()|[\]\\']/g, '\\$&') + (s.endsWith('!') ? '(?![a-z])' : '')).join('|')})`, 'g');

// Mechanical hits with offsets in the original text.
export function mechanicalHits(text) {
  const f = fold(text);
  const hits = [];
  for (const m of f.matchAll(STEM_RE)) hits.push({ start: m.index + m[1].length, end: m.index + m[1].length + m[2].length, word: m[2] });
  for (const q of quantities(text)) hits.push({ start: q.start, end: q.end, word: f.slice(q.start, q.end) });
  for (const n of nominals(text)) { const i = f.indexOf(n.toLowerCase().split(' ')[0]); if (i >= 0) hits.push({ start: i, end: i + n.split(' ')[0].length, word: n }); }
  return hits;
}

// A plain question the user asks (why / what …?) is conversation, even when it names a part.
const INTERROGATIVE = /^(why|what|which|how|where|when|is|are|does|proc|co|jak|kde|kdy|ktery|ktera|ktere|je|jsou)\b[^]*\?\s*$/;
export const isInterrogative = (text) => INTERROGATIVE.test(fold(text).trim());
