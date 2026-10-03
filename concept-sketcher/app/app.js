// S1.1 app: conversation (left) + deterministic 3D (right) + accepted state.
// The UI never edits the model. It sends user text to the interpreter, shows
// the evaluated proposal as a structured review, and passes the user's
// ACCEPT/REJECT to the session. Zoom is inspection only.

import { motionControls } from '../src/motion.js';
import { motionPreview } from '../src/motion_preview.js';
import { conceptHash } from '../src/model.js';
import { validate } from '../src/validate.js';
import { buildScene, buildProposalOverlay, zoomTargets, boundsOf } from '../src/scene.js';
import { inspect, inspectChange, changedEntities, entities, entityOf, referenceParts } from '../src/inspect.js';
import { defaultViewState, sectionPlane, sectionRange, explodeOffsets, instanceOfItem, updateView, SECTION_AXES } from '../src/view_state.js';
import { reviewProposal } from '../src/proposal.js';
import { createSession, acceptedModel, evaluate, accept, evaluateLive, acceptLive, reject, checkout, freeze, historyView, exportSession, importSession, acceptedArtifacts } from '../src/session.js';
import { interpret, DEMO_SENTENCES } from '../src/interpret/fixture_interpreter.js';
import { liveConfig, requestLiveIntent, storedGitHubToken, storeGitHubToken, clearGitHubToken } from './live_client.js?v=ghpoc5';
import { createViewer, PART_PALETTE } from '../view/render3d.js?v=motion1';

const LIVE = liveConfig();
const LEGACY_STORE = LIVE.live ? `concept-sketcher.live.${LIVE.seed || 'blank'}.session` : 'concept-sketcher.s1.session';
const PROJECT_INDEX = 'concept-sketcher.projects.v1';
const ACTIVE_PROJECT = 'concept-sketcher.projects.active';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const isPhone = () => matchMedia('(max-width: 760px)').matches;

let session;
let pending = null;          // { text, evaluation, card, targets, zoomIndex }
let viewer;
// Viewer state: UI only. Never saved into the session, never part of a model or its hash.
let view = defaultViewState();
let tool = null;             // which view-tool row is open: 'section' | 'explode' | 'views' | null
let cameraView = 'ISO';
let motion = {}, motionHash = null, motionAnimation = null, motionError = '';
let studioNow = null;
let stage = null;            // what is drawn now: { model, v, candidate, vC, scenes, changed }
let activeStore = null;
let storageWarning = '';

const slug = (s) => String(s || 'concept').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'concept';
const projectKey = (id) => `concept-sketcher.project.${slug(id)}.session`;
function projectIndex() {
  try { const x = JSON.parse(localStorage.getItem(PROJECT_INDEX) || '[]'); return Array.isArray(x) ? x : []; }
  catch { return []; }
}
function updateProjectIndex() {
  const m = acceptedModel(session);
  const row = { id: m.meta.id, title: m.meta.title, key: activeStore, revision: m.meta.revision, hash: conceptHash(m), updated: new Date().toISOString() };
  const rows = projectIndex().filter((x) => x.key !== activeStore && x.id !== row.id);
  rows.unshift(row);
  localStorage.setItem(PROJECT_INDEX, JSON.stringify(rows.slice(0, 30)));
  localStorage.setItem(ACTIVE_PROJECT, activeStore);
}

function save() {
  if (!session) return;
  try {
    activeStore ||= projectKey(acceptedModel(session).meta.id);
    const previous = localStorage.getItem(activeStore);
    if (previous) localStorage.setItem(`${activeStore}.backup`, previous);
    localStorage.setItem(activeStore, exportSession(session));
    updateProjectIndex();
    storageWarning = '';
  } catch (e) {
    storageWarning = `Autosave unavailable: ${e.message}`;
  }
}

// Normalize the top viewer legend in JS as well as HTML. This deliberately
// repairs an older cached iOS home-screen shell once its app.js refreshes.
function normalizeViewerLegend() {
  const legend = $('legend');
  if (!legend) return;
  legend.innerHTML = `
    <button type="button" id="legendRef" aria-pressed="true" title="Hide or show REFERENCE geometry"><i style="background:rgba(127,159,189,.22);border:1px dashed #c6d9ea"></i>REFERENCE</button>
    <span title="Proposed change"><i style="background:#1f9d55"></i>+ PROPOSED</span>
    <span title="Removed by proposal"><i style="background:none;border:2px dashed #d93025"></i>− REMOVED</span>
    <span title="Open / unresolved"><i style="background:none;border:2px dashed #e8730c"></i>? OPEN</span>`;
}

// ---------------------------------------------------------------- 3D
function render3d() {
  const model = acceptedModel(session);
  stopMotion();
  const hash = conceptHash(model);
  if (hash !== motionHash || pending) { motion = {}; motionHash = hash; }
  let v = validate(model);
  let acceptedScene = buildScene(model, v);
  motionError = '';
  if (!pending && motionControls(model).length) {
    try { const preview = motionPreview(model, motion); acceptedScene = preview.scene; v = preview.validation; }
    catch (e) { motionError = e.message; motion = {}; }
  }
  let overlay = null, candidate = null, vC = null;
  const ps = $('pstate');
  ps.style.display = 'none';
  if (pending) {
    const ev = pending.evaluation;
    if (ev.status === 'VALID') {
      candidate = ev.candidate; vC = validate(candidate);
      overlay = buildProposalOverlay(acceptedScene, buildScene(candidate, vC));
      pending.targets = zoomTargets(overlay);
      ps.textContent = '+ PROPOSAL — not accepted'; ps.style.background = '#1f9d55'; ps.style.display = 'block';
    } else {
      pending.targets = [];
      ps.textContent = `✕ PROPOSAL ${ev.status} — nothing drawn`; ps.style.background = '#d93025'; ps.style.display = 'block';
    }
  }
  // studio style inputs: one palette colour per PRODUCED part (model order), REFERENCE parts, entity lookup
  const colours = new Map();
  for (const p of [...model.parts, ...(candidate?.parts || [])]) if (p.role !== 'REFERENCE' && !colours.has(p.id)) colours.set(p.id, PART_PALETTE[colours.size % PART_PALETTE.length]);
  const studio = {
    refParts: new Set([...referenceParts(model), ...(candidate ? referenceParts(candidate) : [])]),
    partColor: (id) => colours.get(id) ?? PART_PALETTE[0],
    entityOf: (id) => entityOf(id, model) ?? (candidate ? entityOf(id, candidate) : null),
    instanceOf: instanceOfItem,
  };
  studioNow = studio;
  stage = { model, v, candidate, vC, scenes: [acceptedScene, overlay].filter(Boolean), changed: candidate ? changedEntities(model, v, candidate, vC) : [] };
  if (view.selected && !inspect(model, v, view.selected) && !(candidate && inspect(candidate, vC, view.selected))) view = updateView(view, { selected: null });
  if (view.isolatePart && ![...model.parts, ...(candidate?.parts || [])].some((p) => p.id === view.isolatePart)) view = updateView(view, { isolatePart: null });
  viewer.show(acceptedScene, overlay, studio);
  applyView();
}

// ---------------------------------------------------------------- view tools (UI state only)
function offsetsNow() {
  if (!stage) return {};
  return { ...(stage.candidate ? explodeOffsets(stage.candidate, stage.vC, view.explode / 100) : {}), ...explodeOffsets(stage.model, stage.v, view.explode / 100) };
}
// bounds of what is visible now (exploded positions; references only when shown)
function visibleBounds() {
  if (!stage) return null;
  const refs = new Set(referenceParts(stage.model));
  const off = offsetsNow();
  const items = stage.scenes.flatMap((sc) => [...sc.primitives, ...sc.arrows]).filter((p) => {
    const part = instanceOfItem(p.id).replace(/@\d+$/, '');
    if (view.isolatePart && part !== view.isolatePart) return false;
    return view.showReference || !refs.has(part) || part === view.isolatePart;
  });
  const byInst = new Map();
  for (const p of items) { const k = instanceOfItem(p.id); if (!byInst.has(k)) byInst.set(k, []); byInst.get(k).push(p); }
  const boxes = [...byInst].map(([k, list]) => { const b = boundsOf(list); const o = off[k] || [0, 0, 0]; return b && { min: b.min.map((x, i) => x + o[i]), max: b.max.map((x, i) => x + o[i]) }; }).filter(Boolean);
  if (!boxes.length) return null;
  return { min: [0, 1, 2].map((i) => Math.min(...boxes.map((b) => b.min[i]))), max: [0, 1, 2].map((i) => Math.max(...boxes.map((b) => b.max[i]))) };
}
function applyView() {
  if (!viewer) return;
  if (view.section.on) {
    const r = sectionRange(visibleBounds(), view.section.axis);
    if (r) view = updateView(view, { section: { pos: Math.min(r.hi, Math.max(r.lo, view.section.pos)) } });
  }
  viewer.setView({ showReference: view.showReference, plane: sectionPlane(view.section), offsets: offsetsNow(), selected: view.selected, isolatePart: view.isolatePart });
  const refToggle = $('legendRef');
  if (refToggle) {
    refToggle.classList.toggle('off', !view.showReference);
    refToggle.setAttribute('aria-pressed', String(view.showReference));
    refToggle.title = view.showReference ? 'Hide REFERENCE geometry' : 'Show REFERENCE geometry';
  }
  renderInspect();
  renderViewTools();
}
function setView(patch) { view = updateView(view, patch); applyView(); }
function select(key) { setView({ selected: key ? (entityOf(key, stage?.model ?? {}) ?? (stage?.candidate ? entityOf(key, stage.candidate) : null) ?? key) : null }); }

function renderViewTools() {
  const box = $('viewtools');
  const sec = view.section;
  const r = sec.on ? sectionRange(visibleBounds(), sec.axis) : null;
  box.innerHTML = `
    <div class="row">
      <button type="button" data-t="section" class="${sec.on ? 'on' : ''}" aria-pressed="${sec.on}">Section${sec.on ? ` ${sec.axis}` : ''}</button>
      <button type="button" data-t="explode" class="${view.explode ? 'on' : ''}" aria-pressed="${Boolean(view.explode)}">Explode${view.explode ? ` ${view.explode}%` : ''}</button>
      <button type="button" data-t="motion" ${pending ? 'disabled' : ''} class="${tool === 'motion' ? 'on' : ''}">Motion</button>
      <button type="button" data-t="views" class="${tool === 'views' ? 'on' : ''}" aria-pressed="${tool === 'views'}">Views · ${cameraView}</button>
      ${view.isolatePart ? `<button type="button" data-showall class="on" title="Return to full assembly">Isolated · ${esc(view.isolatePart)} ×</button>` : ''}
    </div>
    ${tool === 'motion' ? motionPanel() : ''}
    ${tool === 'section' ? `
    <div class="row"><span class="lab">SECTION</span><div class="seg" role="group" aria-label="Section axis">
      <button type="button" data-sec="off" class="${sec.on ? '' : 'on'}">Off</button>
      ${SECTION_AXES.map((a) => `<button type="button" data-sec="${a}" class="${sec.on && sec.axis === a ? 'on' : ''}" title="Plane across ${a}">${a}</button>`).join('')}</div>
      ${sec.on ? `<button type="button" data-secflip class="${sec.flip ? 'on' : ''}" title="Keep the other side of the plane">Flip</button>` : ''}
      <button type="button" data-secreset>Reset</button></div>
    ${r ? `<div class="row"><input type="range" id="secPos" aria-label="Section position (mm)" min="${r.lo}" max="${r.hi}" step="0.1" value="${sec.pos}"><span id="secVal" class="mono">${sec.axis} ${sec.pos.toFixed(1)} mm</span></div>` : ''}` : ''}
    ${tool === 'explode' ? `
    <div class="row"><span class="lab">EXPLODE</span><input type="range" id="expPos" aria-label="Exploded view (%)" min="0" max="100" step="1" value="${view.explode}"><span id="expVal" class="mono">${view.explode} %</span><button type="button" data-expreset>Reset</button></div>` : ''}
    ${tool === 'views' ? `
    <div class="row"><span class="lab">VIEW</span>
      ${['ISO','FRONT','RIGHT','TOP','LEFT','BACK','BOTTOM'].map((v) => `<button type="button" data-view="${v}" class="${cameraView === v ? 'on' : ''}">${v[0] + v.slice(1).toLowerCase()}</button>`).join('')}
    </div>` : ''}`;
  bindMotion();
  box.querySelector('[data-t="motion"]').onclick = () => { tool = tool === 'motion' ? null : 'motion'; if (tool !== 'motion') stopMotion(); renderViewTools(); };
  box.querySelector('[data-t="section"]').onclick = () => {
    if (view.section.on) {
      tool = null;
      setView({ section: { on: false } });
      return;
    }
    const axis = view.section.axis || 'Z';
    const rr = sectionRange(visibleBounds(), axis);
    tool = 'section';
    setView({ section: { on: true, axis, pos: rr ? rr.mid : 0 } });
  };
  box.querySelector('[data-t="explode"]').onclick = () => {
    if (view.explode) {
      tool = null;
      setView({ explode: 0 });
      viewer.whole();
      return;
    }
    tool = 'explode';
    setView({ explode: 35 });
    viewer.whole();
  };
  box.querySelector('[data-t="views"]').onclick = () => {
    tool = tool === 'views' ? null : 'views';
    renderViewTools();
  };
  const showAll = box.querySelector('[data-showall]');
  if (showAll) showAll.onclick = () => {
    setView({ isolatePart: null });
    viewer.whole();
  };
  box.querySelectorAll('[data-view]').forEach((b) => {
    b.onclick = () => {
      cameraView = b.dataset.view;
      viewer.view(cameraView);
      renderViewTools();
    };
  });
  box.querySelectorAll('[data-sec]').forEach((b) => {
    b.onclick = () => {
      const a = b.dataset.sec;
      if (a === 'off') return setView({ section: { on: false } });
      const rr = sectionRange(visibleBounds(), a);
      setView({ section: { on: true, axis: a, pos: rr ? rr.mid : 0 } });
    };
  });
  const flip = box.querySelector('[data-secflip]');
  if (flip) flip.onclick = () => setView({ section: { flip: !view.section.flip } });
  const sreset = box.querySelector('[data-secreset]');
  if (sreset) sreset.onclick = () => setView({ section: defaultViewState().section });
  const inp = $('secPos');
  if (inp) inp.oninput = () => { view = updateView(view, { section: { pos: Number(inp.value) } }); $('secVal').textContent = `${view.section.axis} ${view.section.pos.toFixed(1)} mm`; viewer.setView({ plane: sectionPlane(view.section) }); };
  const ex = $('expPos');
  if (ex) {
    ex.oninput = () => { view = updateView(view, { explode: Number(ex.value) }); $('expVal').textContent = `${view.explode} %`; viewer.setView({ offsets: offsetsNow() }); };
    ex.onchange = () => { applyView(); viewer.whole(); };
  }
  const ereset = box.querySelector('[data-expreset]');
  if (ereset) ereset.onclick = () => { setView({ explode: 0 }); viewer.whole(); };
}

// ---------------------------------------------------------------- generic motion (transient preview)
function stopMotion() {
  if (motionAnimation !== null) cancelAnimationFrame(motionAnimation);
  motionAnimation = null;
  document.querySelectorAll('[data-motion-animate]').forEach(b => b.textContent = '▶ Animate');
}
function motionPanel() {
  const controls = motionControls(stage.model);
  const exampleLink = (seed, label) => { const url = new URL(location.href); url.searchParams.set('live', '1'); url.searchParams.set('seed', seed); return `<a href="${esc(url.href)}">${label}</a>`; };
  return `<div class="row"><span class="lab">MOTION · GEOMETRIC DEMO</span><button type="button" data-motion-reset>Reset</button></div>
    ${controls.length ? controls.map(c => `<div class="row"><label for="motion-${esc(c.id)}">${esc(c.label)}</label>
      <input type="range" id="motion-${esc(c.id)}" data-motion="${esc(c.id)}" aria-label="${esc(c.label)} (${c.unit})" min="${c.min}" max="${c.max}" step="${c.step}" value="${motion[c.id] ?? c.value}">
      <span class="mono" data-motion-value="${esc(c.id)}">${(motion[c.id] ?? c.value).toFixed(1)} ${c.unit}</span>
      <button type="button" data-motion-animate="${esc(c.id)}">${motionAnimation !== null ? '■ Stop' : '▶ Animate'}</button>
      ${c.note ? `<small>${esc(c.note)}</small>` : ''}</div>`).join('') : '<div class="row">No motion declared. Add params/&lt;driver&gt;/motion in the concept.</div>'}
    <div class="row"><small>Geometry only; force, stress and collisions are not simulated. Accepted design stays at its default pose.</small></div>
    <div class="row"><small>Examples: ${exampleLink('organizer-motion', 'Flexure')} · ${exampleLink('motion-hinge', 'Hinge')} · ${exampleLink('motion-slider', 'Slider')} · ${exampleLink('motion-parameter', 'Extension')}</small></div>
    <div class="row" id="motionError" role="status">${esc(motionError)}</div>`;
}
function displayMotion(next) {
  try {
    const preview = motionPreview(stage.model, next);
    motion = { ...next }; motionError = '';
    stage.v = preview.validation; stage.scenes = [preview.scene];
    viewer.show(preview.scene, null, studioNow, { preserveCamera: true });
    // Preserve slider DOM during dragging and animation.
    viewer.setView({ showReference: view.showReference, plane: sectionPlane(view.section), offsets: offsetsNow(), selected: view.selected, isolatePart: view.isolatePart });
    for (const c of motionControls(stage.model)) {
      const value = preview.values[c.id];
      const slider = document.getElementById(`motion-${c.id}`);
      if (slider) slider.value = value;
      const label = document.querySelector(`[data-motion-value="${c.id}"]`);
      if (label) label.textContent = `${value.toFixed(1)} ${c.unit}`;
    }
    renderInspect();
  } catch (e) { motionError = e.message; stopMotion(); }
  if ($('motionError')) $('motionError').textContent = motionError || (stage.v.warnings.length ? `Pose checks: ${stage.v.warnings.join('; ')}` : '');
}
function bindMotion() {
  document.querySelectorAll('[data-motion]').forEach(el => el.oninput = () => {
    stopMotion(); displayMotion({ ...motion, [el.dataset.motion]: Number(el.value) });
  });
  document.querySelectorAll('[data-motion-animate]').forEach(b => b.onclick = () => {
    if (motionAnimation !== null) { stopMotion(); return; }
    const control = motionControls(stage.model).find(c => c.id === b.dataset.motionAnimate);
    const startValue = motion[control.id] ?? control.value, started = performance.now();
    let previous = -Infinity;
    b.textContent = '■ Stop';
    const tick = now => {
      if (document.hidden || pending || tool !== 'motion') { stopMotion(); return; }
      const phase = Math.min(1, (now-started)/4000);
      const value = startValue + (control.max-startValue)*(1-Math.cos(phase*2*Math.PI))/2;
      if (now-previous >= 100 || phase === 1) { previous = now; displayMotion({ ...motion, [control.id]: value }); }
      if (phase === 1 || motionError) { stopMotion(); return; }
      motionAnimation = requestAnimationFrame(tick);
    };
    motionAnimation = requestAnimationFrame(tick);
  });
  const reset = document.querySelector('[data-motion-reset]');
  if (reset) reset.onclick = () => { stopMotion(); displayMotion({}); };
}
addEventListener('visibilitychange', () => { if (document.hidden) stopMotion(); });

// ---------------------------------------------------------------- inspect (read-only dimensions)
const statusTag = (r) => (r?.status && r.status !== 'fixed' && r.status !== 'stated' ? `<span class="st ${esc(r.status)}">${esc(r.status)}</span>` : '');
function renderInspect() {
  const box = $('inspect');
  if (!stage) { box.innerHTML = ''; return; }
  const { model, v, candidate, vC, changed } = stage;
  const all = new Map([...entities(model), ...(candidate ? entities(candidate) : [])].map((e) => [e.key, e]));
  const options = (keys) => keys.map((k) => `<option value="${esc(k)}" ${k === view.selected ? 'selected' : ''}>${esc(all.get(k)?.label ?? k)}</option>`).join('');
  const picker = `<select id="insSel" aria-label="Inspect entity"><option value="">Inspect…</option>
    ${changed.length ? `<optgroup label="Changed by the proposal">${options(changed)}</optgroup>` : ''}
    <optgroup label="All">${options([...all.keys()])}</optgroup></select>`;
  const chips = changed.length ? `<div class="chips"><span class="lab">CHANGED</span>${changed.map((k) => `<button type="button" data-ins="${esc(k)}" class="${k === view.selected ? 'on' : ''}">${esc(all.get(k)?.label ?? k)}</button>`).join('')}</div>` : '';
  const partIds = new Set([...model.parts, ...(candidate?.parts || [])].map((p) => p.id));
  function partFor(key) {
    if (!key) return null;
    if (partIds.has(key)) return key;
    const head = String(key).split('.')[0];
    if (partIds.has(head)) return head;
    const joint = [...(model.joints || []), ...(candidate?.joints || [])].find((j) => j.id === key);
    return joint?.part && partIds.has(joint.part) ? joint.part : null;
  }
  const selectedPart = partFor(view.selected);
  let body = '';
  if (view.selected) {
    const r = candidate ? inspectChange(model, v, candidate, vC, view.selected) : inspect(model, v, view.selected);
    if (r) {
      const rows = candidate
        ? r.rows.map((x) => `<span class="k">${esc(x.label)}</span><span>${x.changed
          ? `${x.now ? `${esc(x.now.text)}${statusTag(x.now)}` : '—'} → <span class="ch">${x.proposed ? esc(x.proposed.text) : '—'}</span>${statusTag(x.proposed)}`
          : `${esc(x.now.text)}${statusTag(x.now)}`}</span>`).join('')
        : r.rows.map((x) => `<span class="k">${esc(x.label)}</span><span>${esc(x.text)}${statusTag(x)}</span>`).join('');
      const isolateActions = `<div class="ihead">
        ${!candidate ? '<button type="button" id="editExact">Edit exact values</button>' : ''}
        ${selectedPart && view.isolatePart !== selectedPart ? `<button type="button" id="isoPart">Isolate ${esc(selectedPart)}</button>` : ''}
        ${view.isolatePart ? `<button type="button" id="showAllParts">Show all</button><span class="mono">isolated: ${esc(view.isolatePart)}</span>` : ''}
      </div>`;
      body = `<div class="ihead"><button type="button" id="insClose" title="Clear selection" aria-label="Clear selection">✕</button><span class="ititle">${esc(r.title)}</span>${r.role ? `<span class="badge ${esc(r.role)}">${esc(r.role)}</span>` : ''}${r.state && r.state !== 'SAME' ? `<span class="badge ${esc(r.state)}">${esc(r.state)}</span>` : ''}</div>
        ${isolateActions}${motionControls(model).some(c => c.about.includes(view.selected) || c.about.includes(selectedPart)) ? '<button type="button" id="inspectMotion">Motion…</button>' : ''}<div class="dims">${rows}</div>`;
    }
  }
  box.className = `spanel ${body ? '' : 'empty'}`;
  box.innerHTML = `${body}<div class="ihead">${picker}</div>${chips}`;
  $('insSel').onchange = (e) => select(e.target.value || null);
  box.querySelectorAll('[data-ins]').forEach((b) => { b.onclick = () => select(b.dataset.ins); });
  if ($('isoPart')) $('isoPart').onclick = () => {
    const part = selectedPart;
    const role = [...model.parts, ...(candidate?.parts || [])].find((p) => p.id === part)?.role;
    // Once isolated, clear the inspection selection so the large mobile Inspect
    // card no longer sits over the part and steals drag gestures from the canvas.
    // "Show all" remains available as a compact viewer-tool button.
    setView({ isolatePart: part, selected: null, ...(role === 'REFERENCE' ? { showReference: true } : {}) });
    viewer.whole();
  };
  if ($('showAllParts')) $('showAllParts').onclick = () => { setView({ isolatePart: null }); viewer.whole(); };
  if ($('editExact')) $('editExact').onclick = () => { renderProperties(); $('properties').classList.add('open'); };
  if ($('inspectMotion')) $('inspectMotion').onclick = () => { tool = 'motion'; renderViewTools(); };
  if ($('insClose')) $('insClose').onclick = () => select(null);
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
  if (t.key !== 'ALL') select(t.key);
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
    ${storageWarning ? `<span class="tag err" title="${esc(storageWarning)}">AUTOSAVE ✕</span>` : ''}
    <span class="sp"></span>
    <button type="button" id="toggle3d">${document.body.classList.contains('show3d') ? '◂ Chat' : '3D ▸'}</button>
    <button type="button" id="projectBtn">Projects</button>
    <button type="button" id="propertyBtn" ${view.selected ? '' : 'disabled'}>Properties</button>
    <button type="button" id="histBtn">History</button>
    <button type="button" id="exportBtn">Export</button>`;
  $('toggle3d').onclick = () => show3d(!document.body.classList.contains('show3d'));
  $('projectBtn').onclick = () => { renderProjects(); $('projects').classList.add('open'); };
  $('propertyBtn').onclick = () => { renderProperties(); $('properties').classList.add('open'); };
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

function closeSheets() { document.querySelectorAll('.sheet.open').forEach((x) => x.classList.remove('open')); }
function downloadText(name, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(a.href);
}
function blankModel(id, title) {
  return {
    format: 'AI_CONCEPT', schema: 2,
    meta: { id, title, revision: 1, intent: 'Concept being described interactively', closed_world: true },
    units: 'mm', world: { up: '+Z', origin: 'concept origin' }, params: {},
    parts: [], interfaces: [], features: [], joints: [], fasteners: [], volumes: [], rules: [], questions: [],
    freeze: { state: 'DRAFT' },
  };
}
function switchSession(next, key, message) {
  supersede();
  session = next;
  activeStore = key;
  view = defaultViewState();
  save();
  closeSheets();
  sys(message);
  refresh();
}
function renderProjects() {
  const model = acceptedModel(session);
  const rows = projectIndex();
  $('projectList').innerHTML = `
    <p><b>${esc(model.meta.title)}</b><br><span class="muted">${esc(model.meta.id)} · REV ${model.meta.revision} · autosaved locally</span></p>
    <div class="sheet-actions"><button type="button" id="projectSave" class="primary">Save .aiconcept</button><button type="button" id="projectOpen">Open file…</button><button type="button" id="projectBackup" ${localStorage.getItem(`${activeStore}.backup`) ? '' : 'disabled'}>Restore autosave backup</button></div>
    <h3>New blank project</h3>
    <form id="newProject"><div class="formgrid"><label for="newTitle">Title</label><input id="newTitle" required value="New concept"><label for="newId">Project ID</label><input id="newId" required pattern="[a-z0-9][a-z0-9-]*" value="new-concept"></div><div class="sheet-actions"><button class="primary" type="submit">Create</button></div></form>
    <h3>Recent local projects</h3>
    <div>${rows.map((r) => `<div class="project-row"><div><b>${esc(r.title)}</b><div class="muted">${esc(r.id)} · REV ${r.revision} · ${esc(new Date(r.updated).toLocaleString())}</div></div><button type="button" data-project="${esc(r.key)}" ${r.key === activeStore ? 'disabled' : ''}>Open</button></div>`).join('') || '<p class="muted">No other local projects yet.</p>'}</div>`;
  $('projectSave').onclick = () => {
    const files = acceptedArtifacts(session);
    const name = Object.keys(files).find((x) => x.endsWith('.aiconcept'));
    downloadText(name, files[name]);
  };
  $('projectOpen').onclick = () => $('openFile').click();
  $('projectBackup').onclick = () => {
    try {
      const raw = localStorage.getItem(`${activeStore}.backup`);
      if (!raw) throw new Error('No backup is available.');
      switchSession(importSession(raw), activeStore, 'Restored the previous autosaved revision history.');
    } catch (e) { sys(`Backup was not restored: ${e.message}`); }
  };
  $('newProject').onsubmit = (e) => {
    e.preventDefault();
    const title = $('newTitle').value.trim();
    const id = slug($('newId').value);
    try { switchSession(createSession(JSON.stringify(blankModel(id, title)), { summary: 'New blank project', source: 'Projects' }), projectKey(id), `Created blank project “${title}”.`); }
    catch (err) { sys(`Project was not created: ${err.message}`); }
  };
  $('projectList').querySelectorAll('[data-project]').forEach((b) => { b.onclick = () => {
    try {
      const raw = localStorage.getItem(b.dataset.project);
      if (!raw) throw new Error('Local project data is missing.');
      switchSession(importSession(raw), b.dataset.project, `Opened “${acceptedModel(importSession(raw)).meta.title}”.`);
    } catch (e) { sys(`Project was not opened: ${e.message}`); }
  }; });
}

const axes = ['+X','-X','+Y','-Y','+Z','-Z'];
function exactFields(model, key) {
  const fields = [];
  const add3 = (root, values, labels) => values?.forEach((v, i) => { if (typeof v === 'number') fields.push({ path: `${root}/${i}`, label: labels[i], value: v, type: 'number' }); });
  const p = model.parts.find((x) => x.id === key);
  if (p) {
    add3(`parts/${p.id}/size`, p.size, ['Length X (mm)','Width Y (mm)','Thickness Z (mm)']);
    add3(`parts/${p.id}/place/at`, p.place?.at, ['Position X (mm)','Position Y (mm)','Position Z (mm)']);
    fields.push({ path: `parts/${p.id}/role`, label: 'Role', value: p.role, type: 'enum', options: ['PRODUCED','PURCHASED','REFERENCE'] });
    if (p.orient.euler_deg) add3(`parts/${p.id}/orient/euler_deg`, p.orient.euler_deg, ['Rotate X (deg)','Rotate Y (deg)','Rotate Z (deg)']);
    else {
      fields.push({ path: `parts/${p.id}/orient/z`, label: 'Local Z points', value: p.orient.z, type: 'enum', options: axes });
      fields.push({ path: `parts/${p.id}/orient/y`, label: 'Local Y points', value: p.orient.y, type: 'enum', options: axes });
    }
    return { title: p.id, target: `parts/${p.id}`, fields };
  }
  const featureId = String(key || '').split('.').at(-1)?.replace(/\[\d+\]$/, '');
  const f = model.features.find((x) => x.id === featureId);
  if (f) {
    if (f.size) for (const [k, v] of Object.entries(f.size)) if (typeof v === 'number') fields.push({ path: `features/${f.id}/size/${k}`, label: `${k} (mm)`, value: v, type: 'number' });
    if (Array.isArray(f.offset)) add3(`features/${f.id}/offset`, f.offset, ['Offset A (mm)','Offset B (mm)']);
    if (typeof f.depth === 'number') fields.push({ path: `features/${f.id}/depth`, label: 'Depth (mm)', value: f.depth, type: 'number' });
    if (f.array?.kind === 'CIRCULAR') for (const [k, label] of [['count','Count'],['radius','Radius (mm)'],['start_deg','Start angle (deg)']]) fields.push({ path: `features/${f.id}/array/${k}`, label, value: f.array[k], type: 'number' });
    return { title: `${f.host}.${f.id}`, target: `features/${f.id}`, fields };
  }
  const j = model.joints.find((x) => x.id === key);
  if (j) {
    if (typeof j.offset === 'number') fields.push({ path: `joints/${j.id}/offset`, label: 'Offset (mm)', value: j.offset, type: 'number' });
    if (j.limits && j.limits !== 'NONE') for (const k of ['min','max']) if (typeof j.limits[k] === 'number') fields.push({ path: `joints/${j.id}/limits/${k}`, label: `Limit ${k}`, value: j.limits[k], type: 'number' });
    return { title: j.id, target: `joints/${j.id}`, fields };
  }
  const ifaceId = String(key || '').split('.').at(-1);
  const i = model.interfaces.find((x) => `${x.part}.${x.id}` === key || x.id === ifaceId);
  if (i) { add3(`interfaces/${i.id}/at`, i.at, ['Position X (mm)','Position Y (mm)','Position Z (mm)']); return { title: `${i.part}.${i.id}`, target: `interfaces/${i.id}`, fields }; }
  return null;
}
function renderProperties() {
  const desc = exactFields(acceptedModel(session), view.selected);
  if (!desc || !desc.fields.length) {
    $('propertyList').innerHTML = '<p>Select a part, feature, interface or joint in Inspect. Common exact numeric values will appear here.</p>';
    return;
  }
  $('propertyList').innerHTML = `<p><b>${esc(desc.title)}</b></p><p class="muted">Submitting creates a proposal. The accepted concept changes only after Accept.</p><form id="propertyForm"><div class="formgrid">${desc.fields.map((f, n) => `<label for="prop${n}">${esc(f.label)}</label>${f.type === 'enum' ? `<select id="prop${n}" data-path="${esc(f.path)}" data-old="${esc(f.value)}">${f.options.map((o) => `<option ${o === f.value ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>` : `<input id="prop${n}" type="number" step="any" required data-path="${esc(f.path)}" data-old="${esc(f.value)}" value="${esc(f.value)}">`}`).join('')}</div><div class="sheet-actions"><button class="primary" type="submit">Review proposal</button></div></form>`;
  $('propertyForm').onsubmit = (e) => {
    e.preventDefault();
    const edits = [...$('propertyForm').querySelectorAll('[data-path]')].map((el) => ({ path: el.dataset.path, value: el.tagName === 'SELECT' ? el.value : Number(el.value), old: el.dataset.old })).filter((x) => String(x.value) !== x.old);
    if (!edits.length) { sys('No exact value changed.'); return; }
    supersede();
    const intent = { format: 'AI_CONCEPT_INTENT', schema: 1, action: 'PATCH', summary: `Exact values for ${desc.title}`, utterance: `Exact property edit for ${desc.title}`, targets: [desc.target], edits: edits.map(({ path, value }) => ({ path, value })), creates: [], deletes: [], answers: [], unknowns: [] };
    const text = JSON.stringify(intent);
    const ev = evaluateLive(session, text);
    const card = liveIntentCard(ev, text);
    pending = { kind: 'live', text, evaluation: ev, card, targets: [], zoomIndex: -1 };
    closeSheets(); refresh();
  };
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
    try {
      activeStore = localStorage.getItem(ACTIVE_PROJECT);
      const saved = activeStore && localStorage.getItem(activeStore);
      if (saved) return importSession(saved);
      const legacy = localStorage.getItem(LEGACY_STORE);
      if (legacy) {
        const migrated = importSession(legacy);
        activeStore = projectKey(acceptedModel(migrated).meta.id);
        return migrated;
      }
    } catch (e) { storageWarning = `Local project recovery failed: ${e.message}`; }
  }
  const motionFixtures = { 'organizer-motion': '../examples/organizer_live_seed.aiconcept', 'motion-hinge': '../examples/motion/hinge.aiconcept', 'motion-slider': '../examples/motion/slider.aiconcept', 'motion-parameter': '../examples/motion/parameter.aiconcept' };
  const liveFixture = motionFixtures[LIVE.seed] || (LIVE.seed === 'organizer' ? '../examples/organizer_live_seed.aiconcept' : '../examples/live_start.aiconcept');
  const fixture = LIVE.live ? liveFixture : '../examples/s1_start.aiconcept';
  const text = await (await fetch(fixture)).text();
  const s = createSession(text, {
    summary: LIVE.live ? (LIVE.seed === 'organizer' ? 'Live organizer seed' : 'Live Concept start') : 'S1 start: box, spring frame, divider with tabs pointing down',
    source: LIVE.live ? liveFixture.replace('../', '') : 'examples/s1_start.aiconcept',
  });
  activeStore = projectKey(acceptedModel(s).meta.id);
  session = s;
  save();
  return s;
}

function unavailableViewer(message) {
  $('view').innerHTML = `<div style="padding:24px;color:#e9eef5"><h2>3D preview unavailable</h2><p>${esc(message)}</p><p>The concept, validation, properties and exports remain available.</p></div>`;
  const noop = () => {};
  return { onPick: noop, show: noop, setView: noop, resize: noop, whole: noop, frame: noop, view: noop };
}

async function main() {
  normalizeViewerLegend();
  try { viewer = createViewer($('view')); }
  catch (e) { storageWarning = `3D unavailable: ${e.message}`; viewer = unavailableViewer(e.message); }
  viewer.onPick((key) => select(key));
  $('legendRef').onclick = () => setView({ showReference: !view.showReference });
  session = await startSession();
  if ($('modeLabel')) $('modeLabel').textContent = LIVE.live ? `LIVE · ${LIVE.transport === 'github' ? 'GitHub POC' : 'HTTP'}${LIVE.seed ? ` · ${LIVE.seed}` : ''}` : 'S1 · demo interpreter (no AI connected)';
  $('chips').innerHTML = LIVE.live ? '' : DEMO_SENTENCES.map((s) => `<button type="button">${esc(s)}</button>`).join('');
  $('chips').querySelectorAll('button').forEach((b) => { b.onclick = () => { document.body.classList.remove('showchips'); send(b.textContent); }; });
  $('examplesBtn').style.display = LIVE.live ? 'none' : '';
  $('examplesBtn').onclick = () => document.body.classList.toggle('showchips');
  $('form').onsubmit = (e) => { e.preventDefault(); const t = $('input').value; $('input').value = ''; void send(t); };
  $('closeHist').onclick = () => $('history').classList.remove('open');
  $('closeExp').onclick = () => $('exports').classList.remove('open');
  $('closeProjects').onclick = () => $('projects').classList.remove('open');
  $('closeProperties').onclick = () => $('properties').classList.remove('open');
  $('openFile').onchange = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const raw = await file.text();
      let next;
      try { next = importSession(raw); }
      catch { next = createSession(raw, { summary: `Opened ${file.name}`, source: file.name }); }
      const m = acceptedModel(next);
      switchSession(next, projectKey(m.meta.id), `Opened and validated “${m.meta.title}” from ${file.name}.`);
    } catch (err) { sys(`File was not opened: ${err.message}`); }
  };
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
    view: () => structuredClone(view),
    setView: (patch) => setView(patch),
    select: (key) => { select(key); return view.selected; },
    inspection: () => (stage && view.selected ? (stage.candidate ? inspectChange(stage.model, stage.v, stage.candidate, stage.vC, view.selected) : inspect(stage.model, stage.v, view.selected)) : null),
    changed: () => stage?.changed ?? [],
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
