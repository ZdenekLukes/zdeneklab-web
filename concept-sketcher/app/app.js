// S1.1 app: conversation (left) + deterministic 3D (right) + accepted state.
// The UI never edits the model. It sends user text to the interpreter, shows
// the evaluated proposal as a structured review, and passes the user's
// ACCEPT/REJECT to the session. Zoom is inspection only.

import { conceptHash } from '../src/model.js';
import { validate } from '../src/validate.js';
import { buildScene, buildProposalOverlay, zoomTargets } from '../src/scene.js';
import { reviewProposal } from '../src/proposal.js';
import { createSession, acceptedModel, evaluate, accept, evaluateLive, acceptLive, reject, checkout, freeze, historyView, exportSession, importSession, acceptedArtifacts } from '../src/session.js';
import { interpret, DEMO_SENTENCES } from '../src/interpret/fixture_interpreter.js';
import { liveConfig, requestLiveIntent, storedGitHubToken, storeGitHubToken, clearGitHubToken } from './live_client.js';
import { createViewer } from '../view/render3d.js';

const LIVE = liveConfig();
const STORE = LIVE.live ? `concept-sketcher.live.${LIVE.seed || 'blank'}.session` : 'concept-sketcher.s1.session';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const isPhone = () => matchMedia('(max-width: 760px)').matches;

let session;
let pending = null;          // { text, evaluation, card, targets, zoomIndex }
let viewer;

const sceneOf = (model) => buildScene(model, validate(model));
function save() { try { localStorage.setItem(STORE, exportSession(session)); } catch { /* storage unavailable: session stays in memory */ } }

// ---------------------------------------------------------------- 3D
function render3d() {
  const model = acceptedModel(session);
  const acceptedScene = sceneOf(model);
  let overlay = null;
  const ps = $('pstate');
  ps.style.display = 'none';
  if (pending) {
    const ev = pending.evaluation;
    if (ev.status === 'VALID') {
      overlay = buildProposalOverlay(acceptedScene, sceneOf(ev.candidate));
      pending.targets = zoomTargets(overlay);
      ps.textContent = '+ PROPOSAL — not accepted'; ps.style.background = '#1f9d55'; ps.style.display = 'block';
    } else {
      pending.targets = [];
      ps.textContent = `✕ PROPOSAL ${ev.status} — nothing drawn`; ps.style.background = '#d93025'; ps.style.display = 'block';
    }
  }
  viewer.show(acceptedScene, overlay);
}

function show3d(on) {
  document.body.classList.toggle('show3d', on);
  viewer.resize();
  renderStatus();
}

function zoomNext() {
  if (!pending?.targets?.length) return;
  pending.zoomIndex = ((pending.zoomIndex ?? -1) + 1) % pending.targets.length;
  const t = pending.targets[pending.zoomIndex];
  if (isPhone()) show3d(true);
  viewer.frame(t.bounds);
  renderDecision();
}
function wholeModel() {
  if (pending) pending.zoomIndex = -1;
  viewer.whole();
  renderDecision();
}

// ---------------------------------------------------------------- bars
function renderStatus() {
  const model = acceptedModel(session);
  const v = validate(model);
  const p = pending?.evaluation;
  $('status').innerHTML = `
    <span>REV <b>${model.meta.revision}</b></span>
    <span title="${esc(conceptHash(model))}">#${conceptHash(model).slice(7, 15)}</span>
    <span>${esc(v.state.replace('_', ' '))}</span>
    <span class="tag ${v.errors.length ? 'err' : 'ok'}">${v.errors.length ? '✕' : '✓'} ERR ${v.errors.length}</span>
    <span class="tag ${v.open.length ? 'open' : 'ok'}">${v.open.length ? '?' : '✓'} OPEN ${v.open.length}${v.open.length ? ` (${v.open.join(', ')})` : ''}</span>
    <span class="tag prop">PROPOSAL ${p ? p.status : '—'}</span>
    <span class="sp"></span>
    <button type="button" id="toggle3d">${document.body.classList.contains('show3d') ? '◂ Chat' : '3D ▸'}</button>
    <button type="button" id="histBtn">History</button>
    <button type="button" id="exportBtn">Export</button>`;
  $('toggle3d').onclick = () => show3d(!document.body.classList.contains('show3d'));
  $('histBtn').onclick = () => { renderHistory(); $('history').classList.add('open'); };
  $('exportBtn').onclick = () => { renderExports(); $('exports').classList.add('open'); };
}

function renderDecision() {
  const d = $('decision');
  if (!pending) { d.className = ''; d.innerHTML = ''; return; }
  const ev = pending.evaluation;
  const valid = ev.status === 'VALID';
  const t = pending.targets?.[pending.zoomIndex ?? -1];
  const n = pending.targets?.length ?? 0;
  d.className = `show ${valid ? '' : 'bad'}`;
  d.innerHTML = `
    <div class="dtext">${valid ? `+ Proposal — not accepted yet${t ? ` · 🔍 ${esc(t.label)} (${pending.zoomIndex + 1}/${n})` : ''}` : `✕ Proposal ${esc(ev.status)} — cannot be accepted`}</div>
    <div class="dbtns">
      ${valid ? `<button type="button" id="zoomBtn" title="Zoom to change">🔍 ${t ? 'Next' : 'Zoom'}<span class="long"> ${t ? '▸' : 'to change'}</span></button>
      <button type="button" id="wholeBtn" title="Whole model">⤢ <span class="long">Whole model</span><span class="short">All</span></button>` : ''}
      <button type="button" class="primary" id="acceptBtn" ${valid ? '' : 'disabled'}>✓ Accept</button>
      <button type="button" class="danger" id="rejectBtn">✕ ${valid ? 'Reject' : 'Dismiss'}</button>
    </div>`;
  if (valid) { $('zoomBtn').onclick = zoomNext; $('wholeBtn').onclick = wholeModel; }
  $('acceptBtn').onclick = onAccept;
  $('rejectBtn').onclick = onReject;
}

// ---------------------------------------------------------------- sheets
function renderHistory() {
  const rows = historyView(session).slice().reverse();
  $('revs').innerHTML = rows.map((r) => `
    <div class="rev ${r.current ? 'cur' : ''} ${r.onCurrentLine ? '' : 'off'}">
      <div><div>${esc(r.text)}</div><div>${esc(r.summary)}</div>
        <div class="muted">${r.utterance ? `you said: “${esc(r.utterance)}”` : esc(r.kind)} · #${esc(r.hash.slice(7, 15))}</div></div>
      ${r.current ? '<span class="muted">current</span>' : `<button type="button" data-rev="${r.revision}">Restore</button>`}
    </div>`).join('') + `<p class="muted">Restore moves the current concept to that exact revision. Accepting a proposal afterwards starts a branch from it; nothing is deleted.</p>
    <div class="dbtns" style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" id="freezeBtn">Freeze concept</button><button type="button" id="resetBtn" class="danger">Start over</button></div>`;
  $('revs').querySelectorAll('button[data-rev]').forEach((b) => {
    b.onclick = () => { supersede(); session = checkout(session, Number(b.dataset.rev)); save(); sys(`Restored REV ${b.dataset.rev} exactly (no reconstruction). New proposals will branch from it.`); refresh(); renderHistory(); };
  });
  $('freezeBtn').onclick = () => {
    try { supersede(); session = freeze(session, new Date().toISOString()); save(); sys(`CONCEPT FROZEN as REV ${session.head}.`); refresh(); renderHistory(); } catch (e) { sys(e.message); }
  };
  $('resetBtn').onclick = async () => { supersede(); session = await startSession(true); sys('Started over from the S1 start revision.'); refresh(); renderHistory(); };
}

const DESCRIBE = {
  '.aiconcept': 'Concept Model — the source of truth, with its accepted revision history',
  '.concept_contract.md': 'Concept Contract — human-readable description',
  '.coder_prompt.md': 'Coder Prompt — for a coding agent',
  '.skeleton_spec.json': 'Skeleton Spec — resolved frames, features and parameters',
};
function renderExports() {
  const files = acceptedArtifacts(session);
  const model = acceptedModel(session);
  $('expList').innerHTML = `<p class="muted">Everything below is generated from the <b>accepted REV ${model.meta.revision}</b> only.${pending ? ' The pending proposal is <b>not</b> included.' : ''}</p>`
    + Object.keys(files).map((name) => {
      const kind = Object.keys(DESCRIBE).find((k) => name.endsWith(k));
      return `<div class="exp"><div><div>${esc(DESCRIBE[kind])}</div><div class="muted">${esc(name)}</div></div><button type="button" data-f="${esc(name)}">Download</button></div>`;
    }).join('');
  $('expList').querySelectorAll('button[data-f]').forEach((b) => {
    b.onclick = () => {
      const current = acceptedArtifacts(session);          // regenerate at click time: always the accepted model
      const name = b.dataset.f;
      const blob = new Blob([current[name]], { type: name.endsWith('.md') ? 'text/markdown' : 'application/json' });
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(a.href);
    };
  });
}

// ---------------------------------------------------------------- chat
function addEl(html, cls) {
  const d = document.createElement('div');
  d.className = cls; d.innerHTML = html;
  $('log').appendChild(d);
  d.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  return d;
}
const user = (t) => addEl(esc(t), 'msg user');
const sys = (t) => addEl(esc(t), 'msg sys');

function setCardState(card, cls, text) {
  const pill = card.querySelector('.pill');
  pill.className = `pill ${cls}`;
  pill.textContent = text;
}

function supersede() {
  if (!pending) return;
  setCardState(pending.card, 'SUPERSEDED', 'NOT APPLIED');
  pending = null;
  viewer.whole();
}

function reviewHtml(model, ev) {
  const r = reviewProposal(model, ev);
  const items = r.items.map((it) => `
    <li><div class="tgt"><span class="kind">${esc(it.kind)}</span>${esc(it.target)}</div>
      <div class="rows">${it.rows.map((w) => `
        <span class="f">${esc(w.field)}${w.mechanical ? '<span class="fact" title="mechanical fact">FACT</span>' : ''}</span>
        <span><span class="now">${esc(w.now)}</span> → <span class="new">${esc(w.proposed)}</span></span>
        ${w.open ? `<span class="why open">? not stated by you → left OPEN (${esc(w.open)})</span>` : w.evidence ? `<span class="why">because you said: “${esc(w.evidence)}”</span>` : w.mechanical ? '<span class="why err">no words of yours given</span>' : ''}`).join('')}
      </div></li>`).join('');
  const effects = r.effects.length ? `<div class="box"><b>In 3D:</b> ${r.effects.map((e) => `${esc(e.target)}: <span class="now">${esc(e.now)}</span> → <span class="new">${esc(e.proposed)}</span>`).join('; ')}</div>` : '';
  const open = r.opens.length || r.resolves.length ? `<div class="box">${r.opens.length ? `<span class="pill OPEN">? OPEN</span> creates ${esc(r.opens.join(', '))} — recorded, not chosen. ` : ''}${r.resolves.length ? `<span class="pill ACCEPTED">✓</span> resolves ${esc(r.resolves.join(', '))}` : ''}</div>` : '';
  return { items, effects, open };
}

function proposalCard(ev, model, proposalText) {
  const p = ev.proposal;
  const { items, effects, open } = p && p.ops.length ? reviewHtml(model, ev) : { items: '', effects: '', open: '' };
  const errs = ev.errors.length ? `<ul class="err">${ev.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : '';
  const html = `
    <div class="top"><span class="pill ${ev.status}">${ev.status === 'VALID' ? '+ PROPOSED' : ev.status}</span><span class="muted">${esc(p?.source ?? '')}</span></div>
    ${p?.clarification ? `<div>${esc(p.clarification)}</div>` : ''}
    ${p && p.ops.length ? `<div><b>AI proposes:</b> ${esc(p.summary)}</div><div class="muted">Now → proposed, and the words of yours each fact is based on:</div><ol class="changes">${items}</ol>` : ''}
    ${effects}${open}${errs}
    ${p && p.ops.length ? `<details><summary>Advanced: raw proposal JSON</summary><pre>${esc(JSON.stringify(JSON.parse(proposalText), null, 2))}</pre></details>` : ''}`;
  return addEl(html, 'card');
}

function liveIntentCard(ev, intentText) {
  const i = ev.intent;
  const errs = ev.errors.length ? `<ul class="err">${ev.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : '';
  if (ev.status === 'CLARIFY') {
    return addEl(`
      <div class="top"><span class="pill CLARIFY">CLARIFY</span><span class="muted">Live Intent</span></div>
      <div><b>Question:</b> ${esc(ev.question)}</div>
      <div class="muted">No model change was proposed.</div>
      <details><summary>Advanced: raw intent JSON</summary><pre>${esc(JSON.stringify(JSON.parse(intentText), null, 2))}</pre></details>`, 'card');
  }
  const scope = ev.scope?.allow || [];
  const changed = ev.scope?.changed || [];
  const answers = i?.answers || [];
  const unknowns = i?.unknowns || [];
  const html = `
    <div class="top"><span class="pill ${ev.status}">${ev.status === 'VALID' ? '+ PROPOSED' : ev.status}</span><span class="muted">Live Intent</span></div>
    ${i ? `<div><b>AI proposes:</b> ${esc(i.summary)}</div>` : ''}
    ${scope.length ? `<div class="box"><b>Editable scope:</b> ${scope.map(esc).join(' · ')}<br><span class="muted">Everything outside this scope is protected.</span></div>` : ''}
    ${changed.length ? `<div class="box"><b>Actual diff:</b> ${changed.map(esc).join(' · ')}</div>` : ''}
    ${answers.length ? `<div class="box"><b>Resolved:</b> ${answers.map((a) => `${esc(a.id)} = ${esc(a.answer)}`).join(' · ')}</div>` : ''}
    ${unknowns.length ? `<div class="box"><span class="pill OPEN">? OPEN</span> ${unknowns.map((u) => esc(u.question)).join(' · ')}</div>` : ''}
    ${errs}
    ${i ? `<details><summary>Advanced: raw intent JSON</summary><pre>${esc(JSON.stringify(JSON.parse(intentText), null, 2))}</pre></details>` : ''}`;
  return addEl(html, 'card');
}

function onAccept() {
  if (!pending) return;
  try {
    session = pending.kind === 'live'
      ? acceptLive(session, pending.text)
      : accept(session, pending.text);      // re-evaluated inside; never trusts the card
    setCardState(pending.card, 'ACCEPTED', `✓ ACCEPTED → REV ${session.head}`);
    pending = null;
    save();
    viewer.whole();
  } catch (e) {
    sys(`Not accepted: ${e.message}`);
  }
  refresh();
}

function onReject() {
  if (!pending) return;
  session = reject(session);
  setCardState(pending.card, 'REJECTED', '✕ REJECTED — nothing changed');
  pending = null;
  viewer.whole();
  refresh();
}

async function send(text) {
  if (!text.trim()) return;
  supersede();
  user(text);
  const model = acceptedModel(session);

  if (LIVE.live) {
    let intentText;
    const progress = LIVE.transport === 'github' ? addEl('GitHub POC: preparing…', 'msg sys') : null;
    const onProgress = (message) => { if (progress) progress.textContent = message; };

    const askGitHubToken = () => {
      const token = prompt('GitHub-only POC needs a fine-grained token for ZdenekLukes/concept-sketcher. It is stored only in this browser and sent only to api.github.com. Paste token:');
      if (!token) return false;
      storeGitHubToken(token);
      return true;
    };

    try {
      if (LIVE.transport === 'github' && !storedGitHubToken() && !askGitHubToken()) {
        if (progress) progress.textContent = 'GitHub POC cancelled — no token stored.';
        return;
      }
      try {
        intentText = await requestLiveIntent(LIVE, { utterance: text, model }, { onProgress });
      } catch (e) {
        if (LIVE.transport !== 'github' || !['GITHUB_TOKEN_REQUIRED', 'GITHUB_AUTH_FAILED'].includes(e.code)) throw e;
        clearGitHubToken();
        if (!askGitHubToken()) throw e;
        intentText = await requestLiveIntent(LIVE, { utterance: text, model }, { onProgress });
      }
    } catch (e) {
      if (progress) progress.textContent = `GitHub POC failed: ${e.message}`;
      else sys(`Live AI unavailable: ${e.message}`);
      return;
    }
    const ev = evaluateLive(session, intentText);
    const card = liveIntentCard(ev, intentText);
    pending = ev.status === 'CLARIFY' ? null : { kind: 'live', text: intentText, evaluation: ev, card, targets: [], zoomIndex: -1 };
    refresh();
    return;
  }

  const proposalText = interpret(text, model);        // untrusted text
  const ev = evaluate(session, proposalText);         // dry-run on a copy
  const card = proposalCard(ev, model, proposalText);
  pending = ev.status === 'CLARIFY' ? null : { kind: 'proposal', text: proposalText, evaluation: ev, card, targets: [], zoomIndex: -1 };
  refresh();
}

function refresh() { renderStatus(); render3d(); renderDecision(); }

async function startSession(fresh = false) {
  if (!fresh) {
    try { const saved = localStorage.getItem(STORE); if (saved) return importSession(saved); } catch { /* fall through to the start fixture */ }
  }
  const liveFixture = LIVE.seed === 'organizer' ? '../examples/organizer_live_seed.aiconcept' : '../examples/live_start.aiconcept';
  const fixture = LIVE.live ? liveFixture : '../examples/s1_start.aiconcept';
  const text = await (await fetch(fixture)).text();
  const s = createSession(text, {
    summary: LIVE.live ? (LIVE.seed === 'organizer' ? 'Live organizer seed' : 'Live Concept start') : 'S1 start: box, spring frame, divider with tabs pointing down',
    source: LIVE.live ? (LIVE.seed === 'organizer' ? 'examples/organizer_live_seed.aiconcept' : 'examples/live_start.aiconcept') : 'examples/s1_start.aiconcept',
  });
  try { localStorage.setItem(STORE, exportSession(s)); } catch { /* ignore */ }
  return s;
}

async function main() {
  viewer = createViewer($('view'));
  session = await startSession();
  if ($('modeLabel')) $('modeLabel').textContent = LIVE.live ? `LIVE · ${LIVE.transport === 'github' ? 'GitHub POC' : 'HTTP'}${LIVE.seed ? ` · ${LIVE.seed}` : ''}` : 'S1 · demo interpreter (no AI connected)';
  $('chips').innerHTML = LIVE.live ? '' : DEMO_SENTENCES.map((s) => `<button type="button">${esc(s)}</button>`).join('');
  $('chips').querySelectorAll('button').forEach((b) => { b.onclick = () => { document.body.classList.remove('showchips'); send(b.textContent); }; });
  $('examplesBtn').style.display = LIVE.live ? 'none' : '';
  $('examplesBtn').onclick = () => document.body.classList.toggle('showchips');
  $('form').onsubmit = (e) => { e.preventDefault(); const t = $('input').value; $('input').value = ''; void send(t); };
  $('closeHist').onclick = () => $('history').classList.remove('open');
  $('closeExp').onclick = () => $('exports').classList.remove('open');
  sys(LIVE.live
    ? `Live Concept: REV ${acceptedModel(session).meta.revision} · transport ${LIVE.transport}. Describe the concept or a local change. AI only proposes; scoped validation and Accept control every mutation.`
    : `Accepted concept: REV ${acceptedModel(session).meta.revision} — ${acceptedModel(session).meta.title}. Tell me what to change. I only propose; nothing changes until you accept.`);
  refresh();

  // Hooks for automated checks and temporary integration testing.
  window.__cs = {
    acceptedCanonical: () => JSON.stringify(acceptedModel(session)),
    head: () => session.head,
    pending: () => pending?.evaluation.status ?? null,
    artifacts: () => acceptedArtifacts(session),
    zoom: () => (pending?.targets?.[pending.zoomIndex] ?? null),
    injectIntent: (intent) => {
      const text = typeof intent === 'string' ? intent : JSON.stringify(intent);
      const ev = evaluateLive(session, text);
      const card = liveIntentCard(ev, text);
      pending = ev.status === 'CLARIFY' ? null : { kind: 'live', text, evaluation: ev, card, targets: [], zoomIndex: -1 };
      refresh();
      return ev.status;
    },
  };
}
main().catch((e) => sys(`Failed to start: ${e.message}`));
