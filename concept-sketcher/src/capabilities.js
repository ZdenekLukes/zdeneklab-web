// Capability manifest for the S2 interpreter (docs/S2_ARCHITECTURE_AND_EVAL.md §11).
// Two sources, no second catalog:
//   - what EXISTS comes from the schema table (src/schema.js): every construct and enum
//     below is looked up there at build time, and a reference that does not resolve is an error;
//   - what is UNSUPPORTED comes from the Generality Gate V2 classification
//     (test/generality_v2.test.js MATRIX / RESIDUE). This file only adds, per capability,
//     the words that announce it and how to record it (STATED).
// test/s2_manifest.test.js keeps both in lock-step with those sources.

import { entitySpec, fieldSpec, FASTENER_SIZE } from './schema.js';
import { OPS } from './ops.js';

// Gate V2 SUPPORTED rows → the schema constructs that carry them ("collection[:variant].field[.sub]").
export const SUPPORTED = [
  { cap: 'multiple parts', uses: ['parts.kind', 'parts.role'] },
  { cap: 'arbitrary joint graph', uses: ['joints:motion.links'], residue: 'closed kinematic loops' },
  { cap: 'attachment topology', uses: ['interfaces.type', 'interfaces.dir', 'joints:motion.links'] },
  { cap: 'fasteners', uses: ['fasteners.kind', 'fasteners.through', 'fasteners.into', 'fasteners.joint'] },
  { cap: 'bolts', uses: ['fasteners.kind'] },
  { cap: 'threads', uses: ['fasteners.size', 'features:HOLE.kind'], residue: 'thread detail (pitch, length, realisation)' },
  { cap: 'purchased / reference parts', uses: ['parts.role'] },
  { cap: 'keepouts', uses: ['volumes.purpose'] },
  { cap: 'envelopes', uses: ['parts.kind'] },
  { cap: 'connector access / openings', uses: ['features:HOLE.kind', 'features:HOLE.profile', 'volumes.purpose'] },
  { cap: 'service access', uses: ['volumes.purpose', 'volumes.allow'] },
  { cap: 'removal path', uses: ['volumes.purpose', 'joints:motion.assembly.removable'], residue: 'curved or multi-step removal paths' },
  { cap: 'assembly motion', uses: ['joints:motion.assembly.direction', 'joints:motion.assembly.removable'], residue: 'insertion mechanism for closed geometry' },
  { cap: 'rotational DOF', uses: ['joints:motion.motion'] },
  { cap: 'hinge axis', uses: ['joints:motion.axis'] },
  { cap: 'motion limits', uses: ['joints:motion.limits'] },
  { cap: 'fit', uses: ['joints:motion.fit'] },
  { cap: 'contact', uses: ['joints:motion.links', 'interfaces.type'], residue: 'non-planar contact (line, V-groove, area detail)' },
  { cap: 'anti-rotation', uses: ['joints:motion.anti_rotation', 'joints:motion.method'] },
  { cap: 'compliance direction (edge section)', uses: ['features:SPRING.compliance'] },
  { cap: 'feature mirror / symmetry', uses: ['features:MIRROR.mirror'] },
  { cap: 'linear arrays along an edge', uses: ['features:EYE.array'] },
  { cap: 'round geometry (tube, gear, shaft)', uses: ['parts.kind'] },
];

// Gate V2 UNSUPPORTED rows and residue: the interpreter records the user's words as STATED.
export const UNSUPPORTED = [
  { cap: 'purchased vs environment distinction', gate: 'row', en: ['purchased', 'bought', 'off-the-shelf'], cs: ['koupen', 'kupovan', 'nakupovan'] },
  { cap: 'tolerance', gate: 'row', en: ['tolerance', '±0.', 'within'], cs: ['toleranc', 'presnost'] },
  { cap: 'flexure element / snap-fit', gate: 'row', en: ['snap', 'clip in', 'click', 'flex', 'living hinge'], cs: ['zacvak', 'zaklap', 'cvakn', 'pruzn', 'ohebn'] },
  { cap: 'part-level mirror / symmetric parts', gate: 'row', en: ['mirror image', 'mirrored copy'], cs: ['zrcadlov', 'zrcadlen'] },
  { cap: 'circular / face arrays', gate: 'row', en: ['around the circle', 'circular pattern', 'evenly around'], cs: ['po obvodu', 'kruhov', 'dokola'] },
  { cap: 'transmission', gate: 'row', en: ['gear', 'mesh', 'belt', 'pulley', 'drives'], cs: ['ozuben', 'zaber', 'remen', 'pohani', 'prevod'] },
  { cap: 'coupled motion', gate: 'row', en: ['turn together', 'move together', 'in sync'], cs: ['toci spolu', 'otaci spolu', 'spolu', 'synchron'] },
  { cap: 'transmission ratio', gate: 'row', en: ['ratio', ':1', 'twice as fast', 'reduction'], cs: ['pomer', 'prevod', 'ku jedne', 'dvakrat rychleji'] },
  { cap: 'arbitrary orientation / angles', gate: 'row', en: ['tilted by', 'at an angle', 'degrees from'], cs: ['sikmo', 'pod uhlem', 'naklonen'] },
  { cap: 'closed kinematic loops', gate: 'residue', en: ['four-bar', 'linkage', 'closed loop'], cs: ['ctyrklou', 'uzavren'] },
  { cap: 'thread detail (pitch, length, realisation)', gate: 'residue', en: ['pitch', 'thread length', 'heat-set', 'insert', 'self-tapping'], cs: ['stoupani', 'delka zavitu', 'zalis', 'samorezn'] },
  { cap: 'curved or multi-step removal paths', gate: 'residue', en: ['then slide', 'curved path', 'tilt and lift'], cs: ['pak vysunout', 'oblouk', 'naklonit a vytahnout'] },
  { cap: 'insertion mechanism for closed geometry', gate: 'residue', en: ['flex the', 'spring open', 'squeeze in'], cs: ['roztahnout', 'zmacknout a vlozit'] },
  { cap: 'non-planar contact (line, V-groove, area detail)', gate: 'residue', en: ['v-groove', 'line contact', 'point contact'], cs: ['v-drazk', 'primkov', 'bodov'] },
];

// Mechanically relevant, but no construct at all (not in the Gate matrix): also STATED.
export const OUTSIDE_LANGUAGE = [
  { cap: 'material', en: ['aluminium', 'aluminum', 'steel', 'plastic', 'petg', 'pla', 'wood'], cs: ['hlinik', 'ocel', 'plast', 'drev'] },
  { cap: 'load / strength', en: ['kg', 'load', 'strong enough', 'hold weight'], cs: ['unese', 'zatizen', 'pevnost', 'udrzi'] },
  { cap: 'surface finish', en: ['smooth', 'polished', 'textured'], cs: ['hladk', 'lesk', 'textur'] },
  { cap: 'separate springs, cables, motors, electrics as active elements', en: ['coil spring', 'motor', 'cable tension'], cs: ['pruzina', 'motor', 'napnuti'] },
];

// "joints:motion.limits" → the field spec in the schema table (or null).
export function resolveUse(ref) {
  const [head, ...path] = ref.split('.');
  const [coll, variant] = head.split(':');
  const example = { features: { MIRROR: { id: 'X', mirror: {} } }, joints: { motion: {}, INSERTS_INTO: { type: 'INSERTS_INTO' } } }[coll]?.[variant]
    ?? (coll === 'features' ? { type: variant } : {});
  if (!entitySpec(coll, example)) return null;
  let spec = fieldSpec(coll, example, path[0]);
  for (const k of path.slice(1)) spec = spec?.s?.fields?.[k];
  return spec ?? null;
}

const enumOf = (ref) => resolveUse(ref)?.s?.v ?? null;

// The entity schema as the interpreter needs it: every field with its type and flags (req = required,
// fact = a mechanical fact that needs the user's words as evidence, open = may hold OPEN:Qn,
// numeric = its numbers must be stated). Generated from the schema table, never written by hand.
const typeText = (spec) => {
  switch (spec.t) {
    case 'enum': return spec.v.join(' | ');
    case 're': return spec.what;
    case 'num': return 'number or "=expr"';
    case 'list': return `list of ${typeText(spec.of)}${spec.min ? ` (≥ ${spec.min})` : ''}`;
    case 'tuple': return `[${Array(spec.n).fill(typeText(spec.of)).join(', ')}]`;
    case 'map': return `map ${Array.isArray(spec.keys) ? spec.keys.join('|') : 'name'} → ${typeText(spec.of)}`;
    case 'obj': return `{ ${Object.entries(spec.fields).map(([k, fl]) => `${k}${fl.req ? '' : '?'}: ${typeText(fl.s)}`).join('; ')} }`;
    case 'limits': return '{ min: number or "=expr"; max: number or "=expr" } | NONE (degrees for REVOLUTE, mm for PRISMATIC)';
    case 'depth': return 'THROUGH | number | "=expr"';
    case 'check': return '{ type: PARALLEL | DIRECTION | FORBID_DIRECTION | KIND | CLOSED_WORLD, … }';
    case 'none': return 'OPEN:Qn only (no typed value exists yet)';
    case 'entities': return 'list';
    default: return spec.t;
  }
};
const VARIANTS = { parts: [['', {}]], interfaces: [['', {}]],
  features: [['HOLE', { type: 'HOLE' }], ['TAB', { type: 'TAB' }], ['EYE', { type: 'EYE' }], ['SPRING', { type: 'SPRING' }], ['MIRROR', { id: 'X', mirror: {} }]],
  joints: [['FIXED / REVOLUTE / PRISMATIC', {}], ['INSERTS_INTO', { type: 'INSERTS_INTO' }]],
  fasteners: [['', {}]], volumes: [['', {}]], rules: [['', {}]], questions: [['', {}]], params: [['', {}]] };
// The S2 research prompt is frozen. Product-only Live extensions may be
// accepted by the validator without silently changing the old S2 language.
const S2_HIDDEN_FIELDS = {
  parts: new Set(['manufacturing', 'production']),
  'features:SPRING': new Set(['travel']),
};

export function languageSchema({ motion = false } = {}) {
  const out = {};
  for (const [coll, variants] of Object.entries(VARIANTS)) {
    for (const [name, example] of variants) {
      let spec = entitySpec(coll, example);
      // Frozen S2 prompt versions retain their original vocabulary/fingerprints.
      // Live authoring explicitly opts into Motion V1.
      if (!motion && coll === 'params') { const { motion: ignored, ...fields } = spec.fields; spec = { ...spec, fields }; }
      if (!motion && coll === 'features' && name === 'SPRING') {
        const { extension: ignored, ...fields } = spec.fields.span.s.fields;
        spec = { ...spec, fields: { ...spec.fields, span: { ...spec.fields.span, s: { ...spec.fields.span.s, fields } } } };
      }
      const key = name ? `${coll}:${name}` : coll;
      const hidden = S2_HIDDEN_FIELDS[key] || new Set();
      out[key] = Object.fromEntries(Object.entries(spec.fields).filter(([k]) => !hidden.has(k)).map(([k, fl]) => [k,
        `${typeText(fl.s)}${['req', 'fact', 'open', 'numeric'].filter((f) => fl[f]).map((f) => ` [${f}]`).join('')}`]));
    }
  }
  return out;
}

// The manifest the interpreter receives: constructs and enums generated from the schema.
export function manifest() {
  for (const s of SUPPORTED) for (const u of s.uses) if (!resolveUse(u)) throw new Error(`capability "${s.cap}": ${u} is not in the schema`);
  return {
    version: 1,
    language: 'AI_CONCEPT schema 2',
    ops: OPS,
    enums: {
      part_kind: enumOf('parts.kind'), part_role: enumOf('parts.role'), interface_type: enumOf('interfaces.type'),
      motion: enumOf('joints:motion.motion'), method: enumOf('joints:motion.method'), fit: enumOf('joints:motion.fit'),
      hole_kind: enumOf('features:HOLE.kind'), hole_profile: enumOf('features:HOLE.profile'), fastener_kind: enumOf('fasteners.kind'),
      fastener_size: String(FASTENER_SIZE), volume_purpose: enumOf('volumes.purpose'), param_status: enumOf('params.status'),
      question_status: enumOf('questions.status'), direction: enumOf('interfaces.dir'),
    },
    supported: SUPPORTED.map((s) => ({ capability: s.cap, constructs: s.uses, ...(s.residue ? { not_covered: s.residue } : {}) })),
    unsupported: [...UNSUPPORTED, ...OUTSIDE_LANGUAGE].map((u) => ({ capability: u.cap, words: [...u.en, ...u.cs],
      record_as: 'STATED (ADD_QUESTION + ANSWER_QUESTION facts: []) about the involved entities; never the nearest supported construct' })),
    schema: languageSchema(),
    open_rule: '"I don\'t know" / "later" about a typed fact → that slot OPEN:Qn + ADD_QUESTION; never a typical value',
    placeholder_rule: 'a number the user did not state → a parameter {status: "placeholder"} referenced as "=name"; never an inline literal',
  };
}
