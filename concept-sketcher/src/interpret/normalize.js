// Deterministic CS / EN normalization of the user's words (S2 design §7).
// It converts what the user SAID (numbers, units, ranges, approximations,
// nominal sizes, vertical directions). It never supplies a value the words do
// not contain: "a small hole" yields nothing.

// Lower case, no diacritics; keeps digits, sign, decimal separators and the
// characters needed for units, ranges and nominal sizes.
export const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const CS_UNITS = { nula: 0, nuly: 0, nule: 0, jedna: 1, jeden: 1, jedno: 1, jedne: 1, jednu: 1, jednoho: 1, dva: 2, dve: 2, dvou: 2, dvema: 2,
  tri: 3, trech: 3, tremi: 3, ctyri: 4, ctyr: 4, ctyrech: 4, ctyrmi: 4, pet: 5, peti: 5, sest: 6, sesti: 6, sedm: 7, sedmi: 7,
  osm: 8, osmi: 8, devet: 9, deviti: 9 };
const CS_TEENS = { deset: 10, jedenact: 11, dvanact: 12, trinact: 13, ctrnact: 14, patnact: 15, sestnact: 16, sedmnact: 17, osmnact: 18, devatenact: 19 };
const CS_TENS = { dvacet: 20, tricet: 30, ctyricet: 40, padesat: 50, sedesat: 60, sedmdesat: 70, osmdesat: 80, devadesat: 90 };
const EN_UNITS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const EN_TEENS = { ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const EN_TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
// Czech words also used with an -i / -ti ending ("deseti", "dvaceti")
const stripCs = (w) => (w.endsWith('i') && (CS_TEENS[w.slice(0, -1)] !== undefined || CS_TENS[w.slice(0, -1)] !== undefined) ? w.slice(0, -1) : w);

function wordValue(w) {
  const c = stripCs(w);
  if (c === 'sto' || c === 'hundred') return { v: 100, hundred: true };
  for (const t of [CS_UNITS, CS_TEENS, CS_TENS, EN_UNITS, EN_TEENS, EN_TENS]) if (t[c] !== undefined) return { v: t[c], tens: t === CS_TENS || t === EN_TENS, unit: t === CS_UNITS || t === EN_UNITS };
  // Czech inverted compounds: "petadvacet" = 25 (unit + "a" + tens)
  const m = /^([a-z]+?)a(dvacet|tricet|ctyricet|padesat|sedesat|sedmdesat|osmdesat|devadesat)i?$/.exec(w);
  if (m && CS_UNITS[m[1]] !== undefined) return { v: CS_TENS[m[2]] + CS_UNITS[m[1]], compound: true };
  return null;
}
// "one" / "jeden" are references as often as numbers ("that one", "jeden z nich"):
// they count only right before a unit.
const WEAK = new Set(['one', 'jedna', 'jeden', 'jedno', 'jedne', 'jednu', 'jednoho']);

const UNIT_RE = /^(mm|mil+imet\w*|cm|centimet\w*|m|metr\w*|meters?|metres?|in|inch(es)?|palc\w*|palec|"|°|deg(ree)?s?|stupn\w*|stupen|stupnu)$/;
function unitOf(tok) {
  if (!tok || !UNIT_RE.test(tok)) return null;
  if (/^(mm|mil+imet)/.test(tok)) return { unit: 'mm', f: 1 };
  if (/^(cm|centimet)/.test(tok)) return { unit: 'mm', f: 10 };
  if (/^(m|metr|meter|metre)/.test(tok)) return { unit: 'mm', f: 1000 };
  if (/^(in|inch|palc|palec|")/.test(tok)) return { unit: 'mm', f: 25.4 };
  return { unit: 'deg', f: 1 };
}
const APPROX = new Set(['asi', 'zhruba', 'cca', 'priblizne', 'tak', 'kolem', 'okolo', 'about', 'roughly', 'around', 'approximately', 'approx', 'circa', '~', 'nejak']);
const SYMMETRIC = /(na kazdou stranu|na obe strany|do obou stran|na obe dve strany|either way|each way|both ways|either side|each side|±|\+-|\+\/-|plus minus|plus or minus|plus\/minus)/;

// Tokens with character offsets in the ORIGINAL text.
function tokens(text) {
  const f = fold(text);
  const out = [];
  const re = /\d+(?:[.,]\d+)?|[a-z]+|±|°|"|~|\+\/-|\+-|[+\-–]/g;
  let m;
  while ((m = re.exec(f))) out.push({ t: m[0], start: m.index, end: m.index + m[0].length });
  return out;
}

// Every stated quantity: { value, unit: 'mm' | 'deg' | null, raw, approx, start, end }.
export function quantities(text) {
  const toks = tokens(text);
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i].t;
    let raw = null, j = i;
    if (/^\d/.test(t)) {
      // "1,2 a 3" style lists have a space after the comma; "2,5" (no space) is a decimal comma
      raw = Number(t.replace(',', '.'));
      if (toks[i - 1]?.t === '-' && toks[i - 1].end === toks[i].start && !/^\d/.test(toks[i - 2]?.t ?? '')) raw = -raw;
    } else {
      const w = wordValue(t);
      if (!w) continue;
      const half = (toks[i + 1]?.t === 'a' && toks[i + 2]?.t === 'pul') || (toks[i + 1]?.t === 'and' && toks[i + 3]?.t === 'half');
      if (WEAK.has(t) && !unitOf(toks[i + 1]?.t) && !half && !['hundred', 'sto'].includes(toks[i + 1]?.t)) continue;
      raw = w.v;
      if (w.hundred) {                                     // a bare "sto" / "hundred"
        let k = i + 1;
        if (toks[k]?.t === 'and') k++;
        const rest = toks[k] && wordValue(toks[k].t);
        if (rest && !rest.hundred) {
          let r = rest.v; let e = k;
          const n2 = toks[k + 1] && wordValue(toks[k + 1].t);
          if (rest.tens && n2?.unit && n2.v > 0) { r += n2.v; e = k + 1; }
          raw += r; j = e;
        }
      }
      // "dvacet pet", "twenty five", "twenty-five"
      const next = toks[i + 1]?.t === '-' ? toks[i + 2] : toks[i + 1];
      const nw = next && wordValue(next.t);
      if (w.tens && nw?.unit && nw.v > 0) { raw += nw.v; j = toks.indexOf(next); }
      // "sto", "dve ste", "one hundred (and) eighty"
    }
    // hundreds: <n> sto|sta|set|ste|hundred [and] <rest>
    if (['sto', 'hundred'].includes(toks[j + 1]?.t) || ['sta', 'set', 'ste'].includes(toks[j + 1]?.t)) {
      raw *= 100; j += 1;
      let k = j + 1;
      if (toks[k]?.t === 'and') k++;
      const rest = toks[k] && wordValue(toks[k].t);
      if (rest) {
        let r = rest.v; let e = k;
        const n2 = toks[k + 1] && wordValue(toks[k + 1].t);
        if (rest.tens && n2?.unit && n2.v > 0) { r += n2.v; e = k + 1; }
        raw += r; j = e;
      }
    }
    // "a pul" / "and a half"
    if (toks[j + 1]?.t === 'a' && toks[j + 2]?.t === 'pul') { raw += 0.5; j += 2; }
    else if (toks[j + 1]?.t === 'and' && toks[j + 2]?.t === 'a' && toks[j + 3]?.t === 'half') { raw += 0.5; j += 3; }
    // a spoken sign: "minus deseti", "minus 10" (not "plus minus 10", which is a symmetric range)
    const signed = toks[i - 1]?.t === 'minus' && toks[i - 2]?.t !== 'plus' && !(toks[i - 2]?.t === 'or' && toks[i - 3]?.t === 'plus');
    if (signed) raw = -raw;
    const u = unitOf(toks[j + 1]?.t);
    const approx = [toks[i - 1]?.t, toks[i - 2]?.t].some((x) => APPROX.has(x));
    out.push({ raw, value: u ? Math.round(raw * u.f * 1e9) / 1e9 : raw, unit: u?.unit ?? null, approx, start: signed ? toks[i - 1].start : toks[i].start, end: (u ? toks[j + 1] : toks[j]).end });
    i = j + (u ? 1 : 0);
  }
  return out;
}

// Ranges: symmetric ("tricet stupnu na kazdou stranu", "±30") and explicit ("od 0 do 90", "0-90", "0 to 90").
export function ranges(text) {
  const f = fold(text);
  const q = quantities(text);
  const out = [];
  if (SYMMETRIC.test(f)) for (const x of q) out.push({ min: -Math.abs(x.value), max: Math.abs(x.value), unit: x.unit, symmetric: true, approx: x.approx });
  for (let k = 0; k + 1 < q.length; k++) {
    const between = f.slice(q[k].end, q[k + 1].start).trim();
    const before = f.slice(Math.max(0, q[k].start - 8), q[k].start);
    if (/\d\/\d/.test(f.slice(Math.max(0, q[k].start - 3), q[k].end))) continue;   // "1/4-20" is a nominal size, not a range
    if (/^(do|az|to|-|–|a|and)$/.test(between) && (between !== 'a' || /mezi\s*$/.test(before)) && (between !== 'and' || /between\s*$/.test(before))) {
      // "od 0 do 90 stupnu": the unit after the second number applies to the first as well
      const factor = q[k + 1].unit && q[k + 1].raw !== 0 ? q[k + 1].value / q[k + 1].raw : 1;
      const first = q[k].unit ? q[k].value : q[k].raw * factor;
      out.push({ min: first, max: q[k + 1].value, unit: q[k + 1].unit ?? q[k].unit, symmetric: false, approx: q[k].approx || q[k + 1].approx });
    }
  }
  return out;
}

// Nominal fastener sizes: "M3", "sroubek M3", "M 3", "M2,5", "1/4-20".
export function nominals(text) {
  const f = fold(text);
  const out = [];
  for (const m of f.matchAll(/\bm\s?(\d+(?:[.,]\d+)?)\b/g)) out.push(`M${m[1].replace(',', '.')}`);
  for (const m of f.matchAll(/\b(\d+)\/(\d+)\s*-\s*(\d+)\b/g)) out.push(`${m[1]}/${m[2]}-${m[3]} UNC`);
  return out;
}

// Only the vertical is deterministic (world up = +Z). Left / right / front / back are not (§7.2).
export function directions(text) {
  const f = fold(text);
  const out = [];
  if (/\b(nahoru|vzhuru|up|upward|upwards|upright)\b/.test(f)) out.push('+Z');
  if (/\b(dolu|down|downward|downwards)\b/.test(f)) out.push('-Z');
  const horizontal = /\b(doleva|vlevo|leva|levy|leve|left|doprava|vpravo|prava|pravy|prave|right|dopredu|vpredu|forward|front|dozadu|vzadu|back|backward|do stran|sideways|stranou)\b/.test(f);
  return { vertical: out, horizontal_ambiguous: horizontal };
}

// Assembly direction from the user's words (Core V2: assembly.direction = the direction the part
// moves when it is installed; a REMOVAL_PATH runs the reverse way, check C17). Removal words invert
// the stated motion, insertion words keep it. Only an explicit axis ("+X", "−Y") or the vertical
// (world up = +Z) counts; "do strany" / "doleva" without an axis is ambiguous and yields no sign.
const REMOVAL = /\b(vynd\w*|vyjm\w*|vyjim\w*|vytah\w*|sund\w*|vysouv\w*|vysun\w*|odnim\w*|odejm\w*|lifts? (?:out|off)|lifted (?:out|off)|comes? (?:out|off)|slides? out|pull(?:s|ed)? out|taken out|removed|removable|remove)\b/;
const INSERTION = /\b(vklad\w*|vloz\w*|zasouv\w*|zasun\w*|nasaz\w*|nasad\w*|nasouv\w*|inserted|inserts?|slides? in|drops? in|goes in|installed|pushed (?:in|on)|put in)\b/;
const INVERT = { '+X': '-X', '-X': '+X', '+Y': '-Y', '-Y': '+Y', '+Z': '-Z', '-Z': '+Z' };
export function assemblyDirection(text) {
  const f = fold(text).replace(/\u2212/g, '-');
  const sense = REMOVAL.test(f) ? 'removal' : INSERTION.test(f) ? 'insertion' : null;
  const axis = /(^|[^a-z0-9])([+-])\s?([xyz])(?![a-z0-9])/.exec(f);
  let motion = axis ? `${axis[2]}${axis[3].toUpperCase()}` : null;
  if (!motion) {
    if (/\b(shora|from above|from the top)\b/.test(f)) motion = '-Z';
    else if (/\b(nahoru|vzhuru|up|upward|upwards)\b/.test(f)) motion = '+Z';
    else if (/\b(dolu|down|downward|downwards)\b/.test(f)) motion = '-Z';
  }
  const ambiguous = !motion && directions(text).horizontal_ambiguous;
  if (!sense || !motion) return { sense, motion, direction: null, ambiguous };
  return { sense, motion, direction: sense === 'removal' ? INVERT[motion] : motion, ambiguous: false };
}

// Every number the words state, raw and unit-converted, plus nominal size numbers
// (used by the boundary's numeric-fact rule).
export function numbersIn(text) {
  const out = [];
  for (const x of quantities(text)) out.push(x.raw, x.value, Math.abs(x.value));   // limits are compared by magnitude
  for (const n of nominals(text)) out.push(...(n.match(/\d+(\.\d+)?/g) || []).map(Number));
  return [...new Set(out)];
}

// Is `value` stated by these words (as a number, a converted quantity, a range end or a nominal size)?
export function justifies(text, value) {
  const v = Math.abs(Number(value));
  if (!Number.isFinite(v)) return false;
  const eq = (a) => Math.abs(Math.abs(a) - v) < 1e-9;
  return quantities(text).some((q) => eq(q.value) || eq(q.raw)) || ranges(text).some((r) => eq(r.min) || eq(r.max))
    || nominals(text).some((n) => (n.match(/\d+(\.\d+)?/g) || []).map(Number).some(eq));
}
