// Exporters: Concept Contract (md), Coder Prompt (md), Skeleton Spec (json).
// Pure templates over the model + validation. No AI, no invented content:
// every ID printed here comes from the model. They are total over validated
// models: VALID must imply exportable (architecture Core V2 §7, F3).

import { featureDefs } from './resolve.js?v=d776a80047f5';
import { conceptHash } from './model.js?v=d776a80047f5';
import { maturityLine } from './scene.js?v=d776a80047f5';
import { projectEntity, projectParams, nominalDiameter } from './schema.js?v=d776a80047f5';

const fmtParam = (p) => (p.expr !== undefined ? `= ${p.expr}` : String(p.value));
const edgeName = (part, edge) => (part.edge_names?.[edge] ? `${edge} (${part.edge_names[edge]})` : edge);

function featureSentence(model, d, v) {
  const part = model.parts.find((p) => p.id === d.host);
  const id = `${d.host}.${d.id}`;
  const inst = v.resolved.instances.find((i) => i.part === d.host);
  const w = inst?.features.find((f) => f.model_id === id);
  const mirror = d.mirror ? ` Mirror of ${d.host}.${d.mirror.of} in local plane ${d.mirror.plane}${d.mirror.pair_by_index ? ', paired by index' : ''}.` : '';
  if (d.type === 'TAB') {
    return `${id} — TAB on edge ${edgeName(part, d.edge)} of ${d.host}, flush with the ${d.at.from} end (offset ${d.at.offset}), `
      + `pointing along the edge normal = world ${w?.direction} (horizontal: ${w && w.direction[1] !== 'Z' ? 'yes' : 'no'}). `
      + `Size len ${d.size.len}, w ${d.size.w}, t ${d.size.t}.${mirror}`;
  }
  if (d.type === 'EYE') {
    const arr = d.array ? ` Repeated along the edge: pitch ${d.array.pitch}, margin ${d.array.margin} on the host face, count derived by the array rule, centred.` : '';
    return `${id} — EYE on the ${d.face} face of edge ${edgeName(part, d.edge)} of ${d.host}, protruding inward by its depth; `
      + `bore axis = edge normal = world ${w?.bore_axis} (direction of insertion). Size bore ${d.size.bore}, depth ${d.size.depth}.${arr}${mirror}`;
  }
  if (d.type === 'SPRING') {
    const eff = d.effect?.changes_distance_between ? ` Effect: changes the distance between ${d.effect.changes_distance_between.join(' and ')}.` : '';
    const re = d.reacts_against ? ` Reacts against ${[].concat(d.reacts_against).join(', ')}.` : '';
    return `${id} — SPRING (${d.form}) in edge ${edgeName(part, d.edge)} of ${d.host}, centred, span ${d.span.length} of the edge; `
      + `compliance ${d.compliance} = world axis ${w?.compliance_axis}.${eff}${re}${mirror}`;
  }
  if (d.type === 'HOLE') {
    const size = d.profile === 'ROUND' ? `Ø${d.size.d}` : `${d.size.a} × ${d.size.b} (face a × b)`;
    const at = d.offset ? ` at face offset [${d.offset.join(', ')}]` : '';
    const depth = d.depth === 'THROUGH' ? 'through the material' : `depth ${d.depth}`;
    return `${id} — HOLE ${d.kind}, ${d.profile} ${size}, on ${d.on}${at}; entry world [${w?.position.join(', ')}], axis into the material world ${w?.axis}, ${depth}.`;
  }
  return `${id} — ${d.type}`;
}

// ------------------------------------------------------------------ schema 2 sentences (Core V2 §11)
// OPEN:Qn is printed as UNRESOLVED; a slot whose question was answered only in words says so.
function valueText(model, x) {
  if (!String(x).startsWith('OPEN:')) return typeof x === 'object' ? JSON.stringify(x) : String(x);
  const q = (model.questions || []).find((y) => y.id === String(x).slice(5));
  return `UNRESOLVED (${q?.id ?? String(x).slice(5)}${q?.status === 'STATED' ? ', answered only in words' : ''})`;
}
const answersOf = (model, path) => (model.questions || []).filter((q) => q.status === 'ANSWERED' && (q.facts || []).some((p) => p === path || path.startsWith(`${p}/`) || p.startsWith(`${path}/`)));
const answerNote = (model, path) => answersOf(model, path).map((q) => ` [answers ${q.id}: "${q.answer}"]`).join('');
const fmtV = (p) => `[${p.join(', ')}]`;

function interfaceSentence(model, i, v) {
  const ref = `${i.part}.${i.id}`;
  const w = v.resolved.interfaces?.[ref];
  if (!w) return `${ref} — ${i.type} on ${i.part} (not placed).`;
  return i.type === 'AXIS' ? `${ref} — AXIS on ${i.part}: world line through ${fmtV(w.point)}, direction ${w.dir}.`
    : `${ref} — FACE on ${i.part}: world point ${fmtV(w.point)}, outward normal ${w.dir} (face axes a = ${w.a}, b = ${w.b}).`;
}

function motionJointSentence(model, j, v) {
  const info = v.resolved.joints?.[j.id];
  const val = (x) => valueText(model, x);
  const path = (k) => `joints/${j.id}/${k}`;
  const L = [`${j.id} — ${val(j.motion)}: ${j.part} relative to ${info?.parent ?? '?'}.`];
  if (info?.axis) L.push(`Axis: ${info.axis.interface} — world line through ${fmtV(info.axis.point)}, direction ${info.axis.dir}${j.motion === 'REVOLUTE' ? `; positive rotation: right-hand rule about ${info.axis.dir}` : `; positive = along ${info.axis.dir}`}.`);
  L.push(`Links: ${j.links.map((l, n) => `${l.child} ${info?.links[n].kind === 'SEATED' ? 'seated on' : 'on'} ${l.parent}`).join('; ')} (${info?.links[0].kind === 'SEATED' ? `gap ${j.offset} along the parent normal` : `offset ${j.offset} along the parent axis`}).`);
  if (j.limits !== undefined) {
    const u = j.motion === 'REVOLUTE' ? '°' : ' mm';
    const end = (k) => {
      const a = j.limits[k];
      if (typeof a === 'number') return `${a}${u}`;
      const name = /^=\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(a)?.[1];
      const p = name ? model.params?.[name] : undefined;
      return `${info?.limits?.[k] ?? '?'}${u} (${a}${p ? `, ${p.status ?? (p.expr !== undefined ? 'derived' : 'rough')}` : ''})`;
    };
    const lim = j.limits === 'NONE' ? 'none (continuous)' : typeof j.limits === 'object' ? `${end('min')} … ${end('max')} from the modelled pose (0 = as modelled)` : val(j.limits);
    L.push(`Limits: ${lim}.${answerNote(model, path('limits'))}`);
  }
  if (j.method !== undefined) L.push(`Method: ${val(j.method)}.${answerNote(model, path('method'))}`);
  if (j.fit !== undefined) L.push(`Fit: ${val(j.fit)}.${answerNote(model, path('fit'))}`);
  if (j.anti_rotation !== undefined) L.push(`Anti-rotation: ${val(j.anti_rotation)}.`);
  if (j.fasteners !== undefined) L.push(`Fasteners: ${val(j.fasteners)}.`);
  const fs = (model.fasteners || []).filter((f) => f.joint === j.id).map((f) => f.id);
  if (fs.length) L.push(`Realised by fasteners ${fs.join(', ')}.`);
  L.push(`Assembly: ${j.part} moves along ${val(j.assembly.direction)} to install (removal = reverse); removable: ${val(j.assembly.removable)}.${answerNote(model, path('assembly'))}`);
  if (j.intent) L.push(`Intent: ${j.intent}`);
  return L.join(' ');
}

function fastenerSentence(model, f, v) {
  const w = v.resolved.fasteners?.[f.id];
  const j = (model.joints || []).find((x) => x.id === f.joint);
  const holes = Object.fromEntries(v.resolved.instances.flatMap((i) => i.features).filter((x) => x.type === 'HOLE').map((x) => [x.id, x]));
  const h = (r) => `${r} (${holes[r]?.kind} Ø${holes[r]?.size.d})`;
  const nominal = nominalDiameter(f.size);
  return `${f.id} — ${valueText(model, f.kind)} ${valueText(model, f.size)}${nominal ? ` (nominal Ø${nominal})` : ''}, realises ${f.joint}${j ? ` (${j.part} FIXED to ${v.resolved.joints?.[j.id]?.parent ?? '?'}, method ${valueText(model, j.method)})` : ''}. `
    + `Head side: ${h(f.through[0])}${f.through.length > 1 ? `, then ${f.through.slice(1).map(h).join(', ')}` : ''}${f.into ? `; threads into ${h(f.into)}` : '; ends in a nut after the last hole'}. `
    + (w ? `Axis (derived from the holes): world line through ${fmtV(w.axis_point)} (head end), insertion direction ${w.insert_dir}. ` : '')
    + 'Not part of the concept: screw length, head type, washers, how the thread is made (tapped, insert, self-tapping) — a downstream design step decides them explicitly; a skeleton does not need them.';
}

const VOLUME_MEANING = {
  KEEP_OUT: 'Nothing may occupy it',
  SERVICE_ACCESS: 'It must stay free and reach outside the produced geometry, so it can be reached',
  REMOVAL_PATH: 'It must stay free and reach outside, and the part must be able to leave through it (reverse of its assembly direction)',
};
function volumeSentence(model, vol, v) {
  const w = v.resolved.volumes?.[vol.id];
  const except = [...(model.parts.some((p) => p.id === vol.for) ? [vol.for] : []), ...(vol.allow || [])];
  return `${vol.id} — ${vol.purpose} for ${vol.for}: ${vol.size.a} × ${vol.size.b} on face ${vol.on}${vol.offset ? ` at offset [${vol.offset.join(', ')}]` : ''}, extending ${vol.size.depth} along world ${w?.dir}; `
    + `world box ${w ? `${fmtV(w.box_min)} … ${fmtV(w.box_max)}` : '?'}. ${VOLUME_MEANING[vol.purpose]}${except.length ? ` (except ${except.join(', ')})` : ''}.`
    + `${vol.allow ? ` Removed before this volume is used: ${vol.allow.join(', ')}.` : ''}`
    + `${w ? ` Checks: ${Object.entries(w.checks).map(([k, x]) => `${k.replace('_', ' ')} ${x}`).join(' · ')}.` : ''}`;
}

function partSentence(p, v) {
  const inst = v.resolved.instances.find((i) => i.part === p.id);
  if (p.kind === 'SHELL' || (inst && inst.d !== undefined) || (inst && v.resolved.interfaces)) return partSentenceV2(p, inst);
  const axes = inst ? ` Local x → world ${inst.axes.x}, y → ${inst.axes.y}, z (normal) → ${inst.axes.z}.` : '';
  const how = p.place ? ` Placed with its bottom centre at [${p.place.at.join(', ')}].` : ' Placed only by its joint.';
  return `${p.id} — ${p.kind}${p.kind === 'FRAME' ? ' (open rectangular frame, bar ' + p.bar + ')' : ''}, ${p.role}, `
    + `size [${p.size.join(', ')}] (local x, y, z).${axes}${how} Intent: ${p.intent}`;
}

function partSentenceV2(p, inst) {
  const shape = inst?.d !== undefined ? ` (round: Ø${inst.d}, length ${p.size[0]} along its axis = world ${inst.axis})`
    : p.kind === 'SHELL' ? ` (hollow box: wall ${p.wall}, open side ${inst?.open ?? p.open})` : p.kind === 'FRAME' ? ` (open rectangular frame, bar ${p.bar})` : '';
  const axes = inst ? ` Local x → world ${inst.axes.x}, y → ${inst.axes.y}, z (normal) → ${inst.axes.z}. World centre [${inst.origin.join(', ')}].` : '';
  const how = p.place ? ` Placed with its ${p.place.anchor === 'BOTTOM_CENTRE' ? 'bottom centre' : 'centre'} at [${p.place.at.join(', ')}].` : ' Placed only by its joint.';
  return `${p.id} — ${p.kind}${shape}, ${p.role}, size [${p.size.join(', ')}] (local x, y, z).${axes}${how}${p.intent ? ` Intent: ${p.intent}` : ''}`;
}

function jointSentence(j, model, v) {
  if (!('type' in j)) return motionJointSentence(model, j, v);
  const idx = j.index ? ` Index ${j.index.var}: ${j.index.domain === 'ANY' ? 'any valid eye pair' : j.index.domain}; example configuration ${j.index.var} = ${(j.index.preview || []).join(', ')}.` : '';
  const links = j.links.map((l) => `${l.male} INSERTS_INTO ${l.female}`).join('; ');
  const val = (x) => (String(x).startsWith('OPEN:') ? `UNRESOLVED (${String(x).slice(5)})` : x);
  return `${j.id} — ${j.type} of ${j.part}: ${links}.${idx} Engage ${j.engage}. DOF: ${val(j.dof)}. Fit ${j.fit}. `
    + `Assembly motion: ${val(j.assembly_motion)}. Anti-rotation: ${val(j.anti_rotation)}. Intent: ${j.intent}`;
}

const openQs = (m) => (m.questions || []).filter((q) => q.status === 'OPEN');
const answeredQs = (m) => (m.questions || []).filter((q) => q.status === 'ANSWERED');
const statedQs = (m) => (m.questions || []).filter((q) => q.status === 'STATED');
const factsNote = (q) => (q.facts?.length ? ` Structured facts: ${q.facts.join(', ')}.` : '');

function openSection(model) {
  return openQs(model).map((q) => [
    `### ${q.id} — UNRESOLVED (blocks ${q.blocks})`,
    '', q.text, '',
    `Concerns: ${(q.about || []).join(', ')}`,
    `Example options (examples only, not defaults, not recommendations): ${(q.options || []).join(' · ') || 'none'}`,
  ].join('\n')).join('\n\n');
}

// PLACEHOLDER: a number the AI assumed for display; the user has not stated it.
const placeholdersOf = (m) => (m.schema === 2 ? Object.entries(m.params || {}).filter(([, p]) => p.status === 'placeholder') : []);
function placeholderSection(model) {
  const text = JSON.stringify({ parts: model.parts, interfaces: model.interfaces, features: model.features, joints: model.joints, volumes: model.volumes });
  return placeholdersOf(model).map(([k, p]) => {
    const used = [...new Set([...text.matchAll(new RegExp(`"id":"([A-Z0-9_]+)"[^{}]*?=[^"]*\\b${k}\\b`, 'g'))].map((m) => m[1]))];
    return `- ${k} = ${p.value} — PLACEHOLDER, not stated by the user${used.length ? `; used by ${used.join(', ')}` : ''}. Blocks SKELETON_READY until the user states the value.`;
  }).join('\n');
}

// STATED: the user answered in words the structured language cannot hold.
// It is a requirement for a human design step, never a skeleton fact.
function statedSection(model) {
  return statedQs(model).map((q) => [
    `### ${q.id} — STATED, NOT STRUCTURED (blocks ${q.blocks})`,
    '', q.text, '',
    `The user stated: "${q.answer}"`,
    `Concerns: ${(q.about || []).join(', ')}`,
    'The concept language cannot represent this answer as a structured fact. Do not implement it from this text and do not choose a mechanism for it; restate it in QUESTIONS.md.',
  ].join('\n')).join('\n\n');
}

export function conceptContract(model, v) {
  const defs = featureDefs(model);
  const L = [];
  L.push(maturityLine(v), '');
  L.push(`# Concept Contract — ${model.meta.title}`, '');
  L.push(`Concept \`${model.meta.id}\`, revision ${model.meta.revision}, ${model.freeze?.hash ?? 'not frozen'}.`, '');
  L.push(`**Intent.** ${model.meta.intent}`, '');
  L.push('**Closed world.** Only the parts and features listed here exist.', '');
  L.push('## Parts', '', ...(model.parts || []).map((p) => `- ${partSentence(p, v)}`), '');
  if (model.interfaces?.length) L.push('## Interfaces', '', ...model.interfaces.map((i) => `- ${interfaceSentence(model, i, v)}`), '');
  L.push('## Features', '', ...Object.values(defs).map((d) => `- ${featureSentence(model, d, v)}`), '');
  L.push('## Joints', '', ...(model.joints || []).map((j) => `- ${jointSentence(j, model, v)}`), '');
  if (model.fasteners?.length) L.push('## Fasteners', '', ...model.fasteners.map((f) => `- ${fastenerSentence(model, f, v)}`), '');
  if (model.volumes?.length) L.push('## Volumes', '', ...model.volumes.map((x) => `- ${volumeSentence(model, x, v)}`), '');
  L.push('## Rules', '', ...(model.rules || []).map((r) => `- ${r.id} ${r.kind}: ${r.text}`), '');
  L.push('## Parameters', '', '| name | value | status | note |', '|---|---|---|---|',
    ...Object.entries(model.params || {}).map(([k, p]) => `| ${k} | ${fmtParam(p)} | ${p.status ?? (p.expr ? 'derived' : 'rough')} | ${p.note ?? ''} |`), '');
  if (placeholdersOf(model).length) L.push('## PLACEHOLDER — numbers assumed, not stated by the user', '', placeholderSection(model), '');
  L.push('## OPEN — not mechanically defined', '');
  L.push('The intent is understood, but the mechanism is not fully defined. These questions stay open until the user answers them. No downstream tool or agent may resolve them.', '');
  L.push(openSection(model) || 'None.', '');
  if (statedQs(model).length) L.push('## STATED — answered in words, not structured', '', statedSection(model), '');
  L.push('## Answered', '', ...answeredQs(model).map((q) => `- ${q.id}: ${q.text} — ${q.answer} (${q.answered_by})${factsNote(q)}`), '');
  return L.join('\n');
}

// Core V2 reading rules, printed only for schema-2 concepts.
const CORE_V2_SEMANTICS = [
  '- **Core V2 (schema 2).** The following definitions apply in addition:',
  '- ROD / CYLINDER: a circle of diameter `size[1]` (= `size[2]`) extruded `size[0]` along local x. SHELL: a hollow box with walls of thickness `wall`; the `open` side has no wall.',
  '- Interfaces `PART.NAME`: declared (`at` = point in part-local coordinates, `dir` = outward normal of a FACE or direction of an AXIS), or implicit: the box faces `PART.+X` … `PART.-Z` (centre of the outer face, outward normal; for a SHELL\'s open side the rim plane), SHELL inner wall faces `PART.INNER+X` … (normal into the cavity), `PART.AXIS` of a ROD / CYLINDER (its centre, local +x), and feature ports (TAB tip, EYE mouth, HOLE entry).',
  '- Face coordinates (a, b): along the two other local axes in x → y → z order (never flipped), from the face point.',
  '- A FIXED / REVOLUTE / PRISMATIC joint only translates its part: AXIS–AXIS link 1: the child point lies on the parent line at parent point + offset · parent direction, child axis parallel; FACE–FACE link 1: the child face point = parent point + offset · parent normal, child normal opposite. Further links are checks. Joints are placed in dependency order.',
  '- REVOLUTE turns about `axis`, PRISMATIC slides along it. `limits` are measured from the modelled pose (0 = as modelled): degrees, positive by the right-hand rule about the axis direction (REVOLUTE); millimetres along the axis direction (PRISMATIC). `NONE` = continuous rotation.',
  '- `method`: FORM_FIT = the linked geometry itself holds / guides the part; FASTENERS = the listed fasteners; CLAMPED = held by clamping; BONDED = glued. `assembly.direction` = the world direction in which the part moves to be installed; removal is the reverse.',
  '- HOLE: on an AXIS it runs along that axis; on a FACE it enters at `offset` (a, b) along the inward normal. THROUGH = through the material on that axis (a SHELL wall, a FRAME bar, otherwise the part). CLEARANCE: a fastener passes; THREADED: a fastener threads into it (nominal diameter; how the thread is made is not specified); BORE: a round seat for a shaft or pin; OPENING: a through cut-out.',
  '- Fastener: its axis comes from its holes; the head is at the first `through` hole; it is inserted along that hole\'s axis direction; a SCREW ends in `into`, a BOLT_NUT ends in a nut after the last hole. Length, head type, washers and the thread realisation are not specified: do not choose them.',
  '- Volume: a box standing on a FACE interface — cross-section a × b in face coordinates, `depth` along the outward normal. KEEP_OUT: nothing except `for` / `allow` may occupy it. SERVICE_ACCESS: also reaches outside the produced geometry. REMOVAL_PATH: also the `for` part leaves through it. You MUST NOT place any geometry inside a volume.',
];
const CORE_V2_REPORT = [
  'Core V2 additions to the report (allowed in addition to the keys above):',
  '```text',
  '  objects[]: axis?, d?  (ROD / CYLINDER: world axis name of local x, diameter);  wall?, open?  (SHELL)',
  '  features[] of type HOLE: { id, type: "HOLE", kind, profile, size, position /* entry */, axis /* world, into the material */ }',
  '  interfaces: [ { id: "PART.NAME", type, point, dir } ]        // every interface named in the model',
  '  joints: [ { id, motion, parent, axis?: { point, dir }, limits? } ]',
  '  fasteners: [ { id, kind, size, axis_point, insert_dir } ]',
  '  volumes: [ { id, purpose, box_min, box_max } ]',
  '```', '',
];

export function coderPrompt(model, v, fileName) {
  const defs = featureDefs(model);
  const r = v.resolved;
  const div = (model.joints || []).find((j) => j.index);          // indexed joint (S0: SEAT), may be absent in a DRAFT
  const pattern = Object.entries(r.patterns)[0];                    // may be absent in a DRAFT
  const blocked = v.gates.SKELETON_READY.blocked_by;
  const source = model.freeze?.hash ?? `${conceptHash(model)} — DRAFT, not frozen`;
  const L = [];
  L.push(maturityLine(v), '');
  L.push(`# Coder Prompt — parametric skeleton for "${model.meta.id}" rev ${model.meta.revision}`, '');
  L.push(`Inputs: this prompt and \`${fileName}\` (the source of truth, ${source}). Read both. Do not use any other source.`, '');
  L.push('## 1. Task', '',
    'Write `skeleton.mjs`: an ES module with no dependencies exporting `build(params = {}, config = {})`, which returns the SKELETON REPORT of §8 for this concept.',
    '- `params`: overrides for parameters that have a literal `value`. Derived parameters (`expr`) are recomputed from them.',
    ...(div ? [`- \`config.dividers\`: list of eye-pair indices at which ${div.part} instances are seated. Default = the model's example configuration [${(div.index.preview || []).join(', ')}].`] : []),
    '- `build` must be deterministic and must compute everything from the parameters and the rules below. Do not hard-code resolved numbers.',
    'Also write `QUESTIONS.md` (§9).',
    'This is a skeleton: part frames, extents and feature poses. No meshes, no fillets, no print or production detail.', '');
  L.push('## 2. Closed world', '',
    (model.schema === 2 ? 'Only the parts, interfaces, features, holes, joints, fasteners and volumes listed in the `.aiconcept` exist. Do not add any part, feature, hole, fastener, rib, clip, slot, key, stop or any other geometry or attribute.'
      : 'Only the parts and features listed in the `.aiconcept` exist. Do not add legs, feet, pins, ribs, clips, slots, keys, flex cuts, extra or perpendicular dividers, or any other geometry or attribute.'),
    'Every object and feature you output carries its concept ID (grammar in §8). If something seems missing, write it in QUESTIONS.md — never design it.', '');
  L.push('## 3. Maturity and OPEN questions', '',
    blocked.length ? `The concept is ${v.state}. It is NOT skeleton-ready: ${blocked.join(', ')} are UNRESOLVED.`
      : `The concept is ${v.state}. No OPEN question blocks SKELETON READY in this revision.`,
    'You MUST NOT resolve them, pick or default any option, or add any geometry or attribute that implements an answer. Build only what is defined.',
    'Tag every element named in a question\'s `about` list with `unresolved: [<question id>, …]` and report the question as UNRESOLVED.',
    'An `about` entry `<PART>` covers every object of that part (e.g. every `<PART>@i`); `<PART>.<FEATURE>` covers every instance of that feature (`[k]` and `@i`). A joint id (e.g. SEAT) has no element of its own in the report.',
    'Report `maturity` exactly as given; never claim SKELETON_READY.', '',
    openSection(model), '', ...(statedQs(model).length ? [statedSection(model), ''] : []),
    ...(placeholdersOf(model).length ? ['### PLACEHOLDER values', '', placeholderSection(model),
      'They exist only so the concept can be drawn. Use them as given, report them in `placeholders`, never present them as requirements, and list each in QUESTIONS.md.', ''] : []));
  L.push('## 4. How to read the .aiconcept (semantics)', '',
    model.schema === 2 ? `- Units mm. World right-handed, +Z up, origin = ${model.world?.origin ?? 'as placed'}.` : '- Units mm. World right-handed, +Z up, origin = BOX floor centre.',
    '- Part local frame: origin at the centre of the part\'s box; local x, y, z extents = `size[0]`, `size[1]`, `size[2]` (z = thickness / normal).',
    '- `orient {z, y}`: world directions of local z and local y; local x = y × z (right-handed).',
    '- `place {at, anchor: BOTTOM_CENTRE}`: `at` is the world position of the bottom centre of the part\'s world-aligned box.',
    '- Edges of a rectangular / FRAME profile: `+X -X +Y -Y` in local coordinates; the edge normal points outward along that axis; the edge "runs" along the other in-plane axis.',
    '- FRAME: open rectangle with bar width `bar`. On edge e the OUTER face is at size/2 from the centre, the INNER face at size/2 − bar. INNER face length = size[run] − 2·bar; outer edge length = size[run].',
    '- TAB: sits on the outer edge and extends outward along the edge normal by `len`. `at.from` names the end of the edge it is flush with (offset from that end). Cross-section: `w` along the edge, `t` along the part\'s local z, centred at local z = 0. Report its tip-face centre.',
    '- EYE with `face: INNER`: protrudes inward from the inner face by `depth`. Mouth (entry point on the bore axis) = inner face − depth·normal. Bore axis = the edge normal (direction of insertion), diameter `bore`. `z: MID` = local z 0.',
    '- SPRING: integrated section of the host bar, centred (`at: MID`) on the bar centre line (size/2 − bar/2 from the centre), span = percentage of the outer edge length. `compliance: ALONG_EDGE` = along the edge\'s run axis; `EDGE_NORMAL` = along its normal. Report `compliance_axis` as the unsigned world axis letter.',
    '- `mirror {of, plane}`: copy of `of` reflected in the part-local plane (YZ flips local x, XZ flips local y). `pair_by_index`: instance k pairs with instance k of `of`.',
    '- **Array rule** (the only rule for patterns): face_len = length of the host face; usable = face_len − 2·margin; count = floor(usable / pitch + 1e-9) + 1; position_k = (k − (count − 1)/2)·pitch along the edge, k = 0 … count − 1. Instance IDs `<PART>.<FEATURE>[k]`.',
    '- Parameters: literal `value` or `expr` over other parameters.',
    '- Joint INSERTS_INTO with an index variable: one instance `<PART>@i` per configured i. Placement only translates the part (orientation always comes from `orient`): the tip centre of link 1\'s male feature = link 1\'s female mouth + engage · (female bore axis). Every further link must then coincide the same way.',
    ...(model.schema !== 2 || model.params?.frame_W ? ['- Resolution state INSTALLED: `frame_W` is the installed width; `frame_W_free` is the relaxed width. Geometry uses the installed state; report both parameters.'] : []),
    ...(model.schema === 2 ? CORE_V2_SEMANTICS : []), '');
  L.push('## 5. Parameters', '', '| name | value | status | note |', '|---|---|---|---|',
    ...Object.entries(model.params || {}).map(([k, p]) => `| ${k} | ${fmtParam(p)} | ${p.status ?? (p.expr ? 'derived' : 'rough')} | ${p.note ?? ''} |`), '');
  L.push('## 6. Parts, features, joints', '',
    ...(model.parts || []).map((p) => `- ${partSentence(p, v)}`),
    ...(model.interfaces || []).map((i) => `- ${interfaceSentence(model, i, v)}`),
    ...Object.values(defs).map((d) => `- ${featureSentence(model, d, v)}`),
    ...(model.joints || []).map((j) => `- ${jointSentence(j, model, v)}`),
    ...(model.fasteners || []).map((f) => `- ${fastenerSentence(model, f, v)}`),
    ...(model.volumes || []).map((x) => `- ${volumeSentence(model, x, v)}`), '');
  L.push('## 7. Rules', '', ...(model.rules || []).map((x) => `- ${x.id} ${x.kind}: ${x.text}`), '',
    ...answeredQs(model).map((q) => `Answered ${q.id}: ${q.text} — ${q.answer}${factsNote(q)}`), '');
  L.push('## 8. SKELETON REPORT (exact format)', '',
    '```text',
    `{ concept: string, revision: number, maturity: "CONCEPT_FROZEN" | "SKELETON_READY"${v.state === 'DRAFT' ? ' | "DRAFT"' : ''},`,
    '  params: { <every parameter of the model>: number },            // evaluated',
    '  objects: [ {',
    '      id,          // part id, or "<PART>@<i>" for indexed joint instances',
    '      part,        // model part id',
    '      kind, role,  // as in the model',
    '      origin,      // [x,y,z] world centre of the part box',
    '      axes,        // { x, y, z }: world axis names ("+X" … "-Z") of local x, y, z',
    '      size,        // [x,y,z] local extents',
    '      bar?,        // FRAME only',
    '      index?,      // joint index for indexed instances',
    '      features: [ {',
    '          id,             // "<PART>.<FEATURE>" | "<PART>.<FEATURE>[k]" | "<PART>@<i>.<FEATURE>"',
    '          type,           // TAB | EYE | SPRING',
    '          position,       // TAB: tip-face centre; EYE: mouth centre; SPRING: span centre on the bar centre line',
    '          direction?,     // TAB: world axis name',
    '          bore_axis?,     // EYE: world axis name, direction of insertion',
    '          compliance_axis?, // SPRING: "X" | "Y" | "Z"',
    '          size,           // TAB {len,w,t} | EYE {bore,depth} | SPRING {length}',
    '          pair?,          // EYE: id of the paired eye',
    '          unresolved?     // [question ids]',
    '      } ],',
    '      unresolved?  // [question ids]',
    '  } ],',
    '  questions: [ { id, status: "UNRESOLVED" | "ANSWERED", about: [ids as in the model] } ] }',
    '```', '',
    model.schema === 2 ? 'No other keys are allowed at any level. Every REFERENCE part is included as an object.' : 'No other keys are allowed at any level. The REFERENCE part BOX is included as an object with no features.', '',
    ...(model.schema === 2 ? CORE_V2_REPORT : []));
  L.push('## 9. QUESTIONS.md', '',
    'List anything you found unclear or missing, and restate the UNRESOLVED questions. You may note ideas, but none may appear in the report or in the geometry.', '');
  if (div && pattern) {
    L.push('## 10. Acceptance tests (run by an external checker)', '',
      'The checker calls `build` three times: (a) defaults; (b) params `{ box_W: 250, eye_pitch: 12 }`; (c) config `{ dividers: [0, 24] }`. Every run must pass all of:',
      '- C1 objects are exactly BOX (REFERENCE), BASE and one DIVIDER@i per configured index.',
      '- C2 closed world: every id exists in the model, feature types only TAB/EYE/SPRING, complete feature sets, no extra keys or invented elements.',
      '- C3 TAB_L points -Y, TAB_R +Y; no DIVIDER feature points -Z; every DIVIDER has normal ±X; all parallel.',
      '- C4 springs on both short sides, compliance axis Y; frame_W_free and frame_W both reported and correct.',
      '- C5 eyes follow the array rule; paired by index; bore axis ±Y; mouths on the inner faces.',
      '- C6 each divider is placed by the joint rule and both tab tips lie inside their paired eye bores (axially and radially).',
      '- C7 DIVIDER is an open frame.',
      `- C8 maturity ${v.state}; ${v.open.length ? `${v.open.join(', ')} UNRESOLVED; every element in their \`about\` lists tagged; ` : ''}nothing selects an option.`, '');
    L.push('## 11. Reference values for the defaults (self-check)', '',
      `- ${pattern[0]}: ${pattern[1].count} eyes, first at x = ${pattern[1].xs[0]}, last at x = ${pattern[1].xs.at(-1)}.`,
      ...r.instances.filter((i) => i.index !== undefined).map((i) => `- ${i.id}: origin [${i.origin.join(', ')}], axes x ${i.axes.x}, y ${i.axes.y}, z ${i.axes.z}.`), '');
  } else {
    L.push('## 10. Acceptance tests', '', 'None yet for this revision: the S0 checker (C1–C8) needs the seated divider (indexed joint) and the eye pattern.', '');
  }
  return L.join('\n');
}

export function skeletonSpec(model, v) {
  // schema 2: only declared keys are emitted (never a raw copy of model objects)
  const v2 = model.schema === 2;
  const pick = (coll, list) => (v2 && list ? list.map((e) => projectEntity(coll, e)) : list);
  return {
    format: 'AI_CONCEPT_SKELETON_SPEC', concept: model.meta.id, revision: model.meta.revision,
    hash: model.freeze?.hash ?? null, maturity: v.state, maturity_line: maturityLine(v),
    skeleton_ready: v.gates.SKELETON_READY,
    params: v2 ? projectParams(model.params) : model.params, parts: pick('parts', model.parts),
    ...(v2 ? { interfaces: pick('interfaces', model.interfaces || []) } : {}),
    features: pick('features', Object.values(featureDefs(model))), joints: pick('joints', model.joints),
    ...(v2 ? { fasteners: pick('fasteners', model.fasteners || []), volumes: pick('volumes', model.volumes || []) } : {}),
    ...(placeholdersOf(model).length ? { placeholders: placeholdersOf(model).map(([name, p]) => ({ name, value: p.value, provenance: 'PLACEHOLDER' })) } : {}),
    rules: pick('rules', model.rules), questions: pick('questions', model.questions),
    derivation: {
      array_rule: 'usable = face_len - 2*margin; count = floor(usable/pitch + 1e-9) + 1; x_k = (k - (count-1)/2)*pitch',
      placement: 'translate only: male tip centre = female mouth + engage * female bore axis (link 1); other links checked',
      ...(v2 ? { placement_v2: 'FIXED / REVOLUTE / PRISMATIC: translate only, link 1 coincides (AXIS: child point = parent point + offset * parent dir; FACE: child point = parent point + offset * parent normal, normals opposite); dependency order; limits from the modelled pose' } : {}),
      state: 'INSTALLED',
    },
    resolved_default: v.resolved,
    validation: { errors: v.errors, warnings: v.warnings, rules: v.rules, open: v.open },
  };
}

// All canonical exports of one validated model. The single implementation
// behind acceptedArtifacts() and the exportability check (F3): a proposal is
// VALID only if this succeeds for its candidate.
export function exportAll(model, v, fileName) {
  if (!v.resolved) throw new Error('model does not resolve');
  return {
    contract: conceptContract(model, v),
    prompt: coderPrompt(model, v, fileName),
    spec: JSON.stringify(skeletonSpec(model, v), null, 2) + '\n',
  };
}
