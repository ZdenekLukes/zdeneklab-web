// Concept model: loading, canonical form, hashing and parameter evaluation.
// Pure functions, no dependencies, runs in Node and in the browser.

export const AUTHORING_KEYS = [
  'format', 'schema', 'meta', 'units', 'world',
  'params', 'parts', 'features', 'joints', 'rules', 'questions',
];

export function loadConcept(input) {
  const model = typeof input === 'string' ? JSON.parse(input) : input;
  return structuredClone(model);
}

// Sorted keys, no whitespace. Arrays keep their order.
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function conceptHash(model) {
  const authoring = {};
  for (const k of AUTHORING_KEYS) if (k in model) authoring[k] = model[k];
  return 'sha256:' + sha256(canonical(authoring));
}

// ---------------------------------------------------------------- expressions
// Grammar: expr = term (('+'|'-') term)* ; term = factor (('*'|'/') factor)* ;
// factor = number | name | '(' expr ')' | '-' factor

function tokenize(src) {
  const tokens = [];
  const re = /\s*(?:(\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|(.))/y;
  let m;
  while (re.lastIndex < src.length && (m = re.exec(src))) {
    if (m[1] !== undefined) tokens.push({ num: Number(m[1]) });
    else if (m[2] !== undefined) tokens.push({ name: m[2] });
    else if (m[3] !== undefined && m[3].trim()) {
      if (!'+-*/()'.includes(m[3])) throw new Error(`bad character "${m[3]}" in "${src}"`);
      tokens.push({ op: m[3] });
    }
  }
  return tokens;
}

export function parseExpr(src) {
  const t = tokenize(src);
  let i = 0;
  const peek = () => t[i];
  const eat = (op) => (t[i] && t[i].op === op ? (i++, true) : false);
  function factor() {
    const tok = t[i++];
    if (!tok) throw new Error(`unexpected end of "${src}"`);
    if (tok.num !== undefined) return { num: tok.num };
    if (tok.name !== undefined) return { name: tok.name };
    if (tok.op === '(') { const e = expr(); if (!eat(')')) throw new Error(`missing ")" in "${src}"`); return e; }
    if (tok.op === '-') return { op: 'neg', a: factor() };
    throw new Error(`unexpected "${tok.op}" in "${src}"`);
  }
  function term() {
    let a = factor();
    while (peek() && (peek().op === '*' || peek().op === '/')) a = { op: t[i++].op, a, b: factor() };
    return a;
  }
  function expr() {
    let a = term();
    while (peek() && (peek().op === '+' || peek().op === '-')) a = { op: t[i++].op, a, b: term() };
    return a;
  }
  const ast = expr();
  if (i !== t.length) throw new Error(`trailing tokens in "${src}"`);
  return ast;
}

export function exprNames(ast, out = new Set()) {
  if (ast.name) out.add(ast.name);
  if (ast.a) exprNames(ast.a, out);
  if (ast.b) exprNames(ast.b, out);
  return out;
}

export function evalAst(ast, env) {
  if (ast.num !== undefined) return ast.num;
  if (ast.name !== undefined) {
    if (!(ast.name in env)) throw new Error(`unknown parameter "${ast.name}"`);
    return env[ast.name];
  }
  if (ast.op === 'neg') return -evalAst(ast.a, env);
  const a = evalAst(ast.a, env), b = evalAst(ast.b, env);
  return ast.op === '+' ? a + b : ast.op === '-' ? a - b : ast.op === '*' ? a * b : a / b;
}

// Evaluates all params in dependency order. `overrides` replace literal values.
// Returns { values, errors }.
export function evalParams(params = {}, overrides = {}) {
  const errors = [];
  for (const k of Object.keys(overrides)) {
    if (!(k in params)) errors.push(`override of unknown parameter "${k}"`);
    else if (params[k].expr !== undefined) errors.push(`parameter "${k}" is derived (expr) and cannot be overridden`);
  }
  const asts = {};
  for (const [k, p] of Object.entries(params)) {
    if (p.expr !== undefined) {
      try { asts[k] = parseExpr(p.expr); } catch (e) { errors.push(`parameter "${k}": ${e.message}`); }
    } else if (typeof p.value !== 'number') errors.push(`parameter "${k}" has neither a numeric value nor an expr`);
  }
  const values = {};
  const state = {};
  function visit(k, stack) {
    if (state[k] === 'done') return;
    if (state[k] === 'visiting') { errors.push(`parameter cycle: ${[...stack, k].join(' -> ')}`); return; }
    state[k] = 'visiting';
    const p = params[k];
    if (p.expr !== undefined && asts[k]) {
      for (const d of exprNames(asts[k])) {
        if (!(d in params)) { errors.push(`parameter "${k}" references unknown "${d}"`); continue; }
        visit(d, [...stack, k]);
      }
      try { values[k] = evalAst(asts[k], values); } catch (e) { /* reported via cycle/unknown */ }
    } else {
      values[k] = k in overrides ? overrides[k] : p.value;
    }
    state[k] = 'done';
  }
  for (const k of Object.keys(params)) visit(k, []);
  return { values, errors: [...new Set(errors)] };
}

// A number in the model: literal or "=expr".
export function num(v, P) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.startsWith('=')) return evalAst(parseExpr(v.slice(1)), P);
  throw new Error(`not a number or "=expr": ${JSON.stringify(v)}`);
}

// ---------------------------------------------------------------- SHA-256
// Inline so it also works where WebCrypto is unavailable (file://).
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256(str) {
  const bytes = new TextEncoder().encode(str);
  const bitLen = bytes.length * 8;
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, Math.floor(bitLen / 2 ** 32));
  dv.setUint32(padded.length - 4, bitLen >>> 0);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const W = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let t = 0; t < 16; t++) W[t] = dv.getUint32(off + t * 4);
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(W[t - 15], 7) ^ rotr(W[t - 15], 18) ^ (W[t - 15] >>> 3);
      const s1 = rotr(W[t - 2], 17) ^ rotr(W[t - 2], 19) ^ (W[t - 2] >>> 10);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[t] + W[t]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  return [...H].map((x) => x.toString(16).padStart(8, '0')).join('');
}
