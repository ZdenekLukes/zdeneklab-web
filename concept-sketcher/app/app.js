// S1.1 app: conversation (left) + deterministic 3D (right) + accepted state.
// The UI never edits the model. It sends user text to the interpreter, shows
// the evaluated proposal as a structured review, and passes the user's
// ACCEPT/REJECT to the session. Zoom is inspection only.

import { motionControls } from '../src/motion.js?v=82722beda481';
import { motionPreview } from '../src/motion_preview.js?v=82722beda481';
import { conceptHash } from '../src/model.js?v=82722beda481';
import { validate } from '../src/validate.js?v=82722beda481';
import { buildScene, buildProposalOverlay, zoomTargets, boundsOf } from '../src/scene.js?v=82722beda481';
import { inspect, inspectChange, changedEntities, entities, entityOf, referenceParts } from '../src/inspect.js?v=82722beda481';
import { defaultViewState, sectionPlane, sectionRange, explodeOffsets, instanceOfItem, updateView, SECTION_AXES } from '../src/view_state.js?v=82722beda481';
import { reviewProposal } from '../src/proposal.js?v=82722beda481';
import { createSession, acceptedModel, evaluate, accept, evaluateLive, acceptLive, reject, checkout, freeze, historyView, exportSession, importSession, acceptedArtifacts } from '../src/session.js?v=82722beda481';
import { interpret, DEMO_SENTENCES } from '../src/interpret/fixture_interpreter.js?v=82722beda481';
import { liveConfig, requestLiveIntent, storedGitHubToken, storeGitHubToken, clearGitHubToken } from './live_client.js?v=82722beda481';
import { createViewer, PART_PALETTE } from '../view/render3d.js?v=82722beda481';
import { ensureCurrentShell } from './build_version.js?v=82722beda481';
import { threadWords, valueSources } from '../src/live_context.js?v=82722beda481';
import { explicitQuestionChoices } from '../src/live_intent.js?v=82722beda481';
import { solidProgram, solidChanges } from '../src/geometry/solid_program.js?v=82722beda481';
import { loadManifoldEngine } from '../src/geometry/manifold_engine.js?v=82722beda481';
import { newThread, loadThread, storeThread, threadMatches, addTurn, updateTurn, recentOf } from './conversation.js?v=82722beda481';
import { emptyMemory, appendMemory, memoryFromConcept, exportWithMemory, memoryView, memoryEvidenceWords } from '../src/design_memory.js?v=82722beda481';
import { ACTIVE_PROJECT, NAME_MAX, slug, projectKey, listProducts, readIndex, displayName, cleanName, freeSlot, storeNewProduct, recordProduct, renameProduct, deleteProduct } from './library.js?v=82722beda481';

const LIVE = liveConfig();
const LEGACY_STORE = LIVE.live ? `concept-sketcher.live.${LIVE.seed || 'blank'}.session` : 'concept-sketcher.s1.session';
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
// Solid geometry engine (src/geometry): loaded lazily; until then the existing primitives are drawn.
let geometry = { engine: null, error: null, last: null };
let stage = null;            // what is drawn now: { model, v, candidate, vC, scenes, changed }
let activeStore = null;
let designMemory = emptyMemory(); // per-product; never reset by Accept
let storageWarning = '';
// A saved project that failed validation on restore or open is never discarded:
// its raw text is first copied byte-for-byte to a quarantine key (listed in
// Projects for download). Only when that copy could not be made is the original
// slot itself kept, and autosave then refuses to write to it.
const UNREADABLE_PREFIX = 'concept-sketcher.unreadable.';
let unreadable = null;       // { key: slot autosave must not touch | null, qkey, raw, error }
function quarantine(key, raw, error) {
  const copy = unreadableSaves().find((k) => { try { return localStorage.getItem(k) === raw; } catch { return false; } });
  if (copy) { unreadable = { key: null, qkey: copy, raw, error }; return; }   // this exact text is already kept aside
  const qkey = `${UNREADABLE_PREFIX}${Date.now()}`;
  try {
    localStorage.setItem(qkey, raw);
    if (localStorage.getItem(qkey) !== raw) throw new Error('copy does not read back');
    unreadable = { key: null, qkey, raw, error };
  } catch {
    unreadable = { key, qkey: null, raw, error };
  }
}
function unreadableSaves() {
  try { return Object.keys(localStorage).filter((k) => k.startsWith(UNREADABLE_PREFIX)).sort(); } catch { return []; }
}

// The product's library name (app/library.js); the accepted meta.title until renamed.
function currentName() {
  let row = null;
  try { row = readIndex(localStorage).find((r) => r.key === activeStore); } catch { /* storage unavailable */ }
  return row?.name || acceptedModel(session).meta.title;
}

// Autosave of the open product into its own slot (app/library.js). The backup
// keeps the previous saved state and moves only when the saved state changes, so
// merely opening a product neither touches its backup nor its modified time.
// A failure is said once in the conversation, not only in the status bar.
let autosaveFailed = false;
function save() {
  if (!session) return;
  try {
    activeStore ||= freeSlot(localStorage, acceptedModel(session).meta.id).key;
    if (unreadable?.key && activeStore === unreadable.key) {
      storageWarning = `Autosave paused: the saved project in this slot could not be validated and could not be copied aside, so it is kept untouched (${unreadable.error})`;
      return;
    }
    const acceptedExport = exportSession(session);
    const previous = localStorage.getItem(activeStore);
    // Opening an older, unchanged .aiconcept must not migrate or rewrite it
    // merely because a new optional memory field exists. Add the journal only
    // once the user actually states a new requirement or changes the concept.
    const text = previous && designMemory.entries.length === 0 && previous === acceptedExport
      ? previous : exportWithMemory(acceptedExport, designMemory);
    const changed = previous !== text;
    if (changed) {
      if (previous) localStorage.setItem(`${activeStore}.backup`, previous);
      localStorage.setItem(activeStore, text);
    }
    const m = acceptedModel(session);
    recordProduct(localStorage, { key: activeStore, id: m.meta.id, title: m.meta.title, revision: m.meta.revision, hash: conceptHash(m) }, { changed });
    localStorage.setItem(ACTIVE_PROJECT, activeStore);
    storageWarning = '';
    if (autosaveFailed) { autosaveFailed = false; sys('Autosave works again: this product is saved in this browser.'); }
  } catch (e) {
    storageWarning = `Autosave unavailable: ${e.message}`;
    if (!autosaveFailed) {
      autosaveFailed = true;
      sys(`Autosave failed: ${e.message}. The latest state of this product is only in this tab. Keep a copy with Products → Save .aiconcept before closing; the previously saved state is unchanged.`);
    }
  }
}

// ---------------------------------------------------------------- conversation (Live)
// The thread of turns since the accepted model last changed, per project
// (app/conversation.js). Context for the AI and the user's words for evidence;
// never design data.
let conv = null;             // { key, thread }
const convKey = () => `${activeStore}.conversation`;
const convBase = () => ({ head: session.head, hash: conceptHash(acceptedModel(session)) });
function thread() {
  const key = convKey(), base = convBase();
  if (!conv || conv.key !== key) conv = { key, thread: loadThread(localStorage, key, base) };
  else if (!threadMatches(conv.thread, base)) conv.thread = newThread(base);
  return conv.thread;
}
function remember(turn) {
  const { thread: next, id } = addTurn(thread(), turn);
  conv.thread = next;
  storeThread(localStorage, conv.key, next);
  return id;
}
function amendTurn(id, patch) {
  if (!id || !conv || !conv.thread.turns.some((t) => t.id === id)) return;
  conv.thread = updateTurn(conv.thread, id, patch);
  storeThread(localStorage, conv.key, conv.thread);
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
  let overlay = null, candidate = null, candidateScene = null, vC = null;
  const ps = $('pstate');
  ps.style.display = 'none';
  if (pending) {
    const ev = pending.evaluation;
    if (ev.status === 'VALID') {
      candidate = ev.candidate; vC = validate(candidate);
      candidateScene = buildScene(candidate, vC);
      overlay = buildProposalOverlay(acceptedScene, candidateScene);
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
  const solids = buildSolids(model, v, candidate, vC, acceptedScene, candidateScene, overlay);
  if (candidate && overlay) pending.targets = zoomTargets(overlay);
  stage = { model, v, candidate, vC, scenes: [acceptedScene, overlay].filter(Boolean), changed: candidate ? changedEntities(model, v, candidate, vC) : [] };
  if (view.selected && !inspect(model, v, view.selected) && !(candidate && inspect(candidate, vC, view.selected))) view = updateView(view, { selected: null });
  if (view.isolatePart && ![...model.parts, ...(candidate?.parts || [])].some((p) => p.id === view.isolatePart)) view = updateView(view, { isolatePart: null });
  viewer.show(acceptedScene, overlay, studio, { solids });
  applyView();
  if ($('geomTag')) $('geomTag').outerHTML = geometryTag();
}

// The physical solids of the accepted model and of a valid proposal, from the
// engine. Unchanged solids are drawn as accepted; a proposal's changed or new
// solids are drawn proposed and the accepted ones they replace as removed, so an
// accepted body never hides a proposed opening.
function buildSolids(model, v, candidate, vC, acceptedScene, candidateScene, overlay) {
  if (!geometry.engine) { geometry.last = null; return null; }
  const t0 = performance.now();
  const progA = solidProgram(model, v), builtA = geometry.engine.build(progA);
  const progC = candidate ? solidProgram(candidate, vC) : null, builtC = progC ? geometry.engine.build(progC) : null;
  const changes = progC ? solidChanges(progA, progC) : { changed: [], added: [], removed: [] };
  const replaced = new Set([...changes.changed, ...changes.removed]);
  const poseOf = (id) => acceptedScene.primitives.find((p) => p.instance === id && p.pose)?.pose;
  const item = (prog, built, style) => (s) => (built.solids.has(s.id) ? [{ id: s.id, part: s.part, style, mesh: built.solids.get(s.id), ...(poseOf(s.id) ? { pose: poseOf(s.id) } : {}) }] : []);
  const accepted = progA.solids.filter((s) => !replaced.has(s.id)).flatMap(item(progA, builtA, 'produced'));
  const proposal = [
    ...(progC ? progC.solids.filter((s) => changes.changed.includes(s.id) || changes.added.includes(s.id)).flatMap(item(progC, builtC, 'proposed')) : []),
    ...progA.solids.filter((s) => replaced.has(s.id)).flatMap(item(progA, builtA, 'removed')),
  ];
  const oldSolids = new Set(builtA.solids.keys());
  const newSolids = new Set(builtC?.solids.keys() || []);
  const oldInstances = new Set(v.resolved.instances.map((x) => x.id));
  const newInstances = new Set(vC?.resolved?.instances.map((x) => x.id) || []);
  const toSymbolic = new Set([...oldSolids].filter((id) => newInstances.has(id) && !newSolids.has(id)));
  // The primitive scene diff excludes unchanged walls. If a solid becomes
  // symbolic, supply its complete candidate fallback as PROPOSED; otherwise
  // the former solid disappears and only its removed ghost remains.
  if (toSymbolic.size && candidateScene && overlay) {
    const existing = new Set(overlay.primitives.filter((p) => p.style === 'proposed').map((p) => p.id));
    for (const p of candidateScene.primitives) {
      if (!toSymbolic.has(p.instance) || (p.role && p.role !== 'hole') || existing.has(p.id)) continue;
      overlay.primitives.push({ ...p, layer: 'proposal', style: 'proposed' });
      existing.add(p.id);
    }
  }
  // The reverse transition needs the old opaque symbolic body hidden, so
  // the newly proposed solid isn't concealed. Removed symbols remain visible
  // through the separate proposal primitive diff.
  const acceptedSkip = new Set([...oldSolids, ...[...newSolids].filter((id) => oldInstances.has(id) && !oldSolids.has(id))]);
  // Skip old and new primitive representations separately by proposal style.
  const overlaySkip = { proposed: newSolids, removed: oldSolids };
  const notes = [...progA.skipped, ...(progC?.skipped || [])].filter((x, i, a) => a.findIndex((y) => y.instance === x.instance) === i)
    .filter((x) => !/^(reference part|envelope)/.test(x.reason)).map((x) => `${x.instance}: ${x.reason}`);
  for (const e of [...builtA.errors, ...(builtC?.errors || [])]) notes.push(`${e.id}: solid not built (${e.error}); drawn with the existing primitives`);
  geometry.last = { ms: performance.now() - t0, notes, changes,
    solids: [...accepted, ...proposal].map((x) => ({ id: x.id, style: x.style, genus: x.mesh.genus, volume: Math.round(x.mesh.volume * 1000) / 1000, triangles: x.mesh.triangles })) };
  return { accepted, proposal, acceptedSkip, overlaySkip };
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
  const is3d = document.body.classList.contains('show3d');
  const phone = isPhone();
  const product = currentName();
  $('activeProductName').textContent = product;
  $('activeProductName').title = product;
  const openProducts = () => { closeSheets(); renderProjects(); $('projects').classList.add('open'); };
  $('activeProductLink').onclick = openProducts;
  const facts = `
    <span>REV <b>${model.meta.revision}</b></span>
    <span title="${esc(conceptHash(model))}">#${conceptHash(model).slice(7, 15)}</span>
    <span>${esc(v.state.replace('_', ' '))}</span>
    <span class="tag ${v.errors.length ? 'err' : 'ok'}">${v.errors.length ? '✕' : '✓'} ERR ${v.errors.length}</span>
    <span class="tag ${v.open.length ? 'open' : 'ok'}">${v.open.length ? '?' : '✓'} OPEN ${v.open.length}${v.open.length ? ` (${v.open.join(', ')})` : ''}</span>
    <span class="tag prop">PROPOSAL ${p ? p.status : '—'}</span>
    ${storageWarning ? `<span class="tag err" title="${esc(storageWarning)}">AUTOSAVE ✕</span>` : ''}
    ${geometryTag()}`;
  const tools = `
    <button type="button" id="propertyBtn" ${view.selected ? '' : 'disabled'}>Properties</button>
    <button type="button" id="histBtn">History</button>
    <button type="button" id="exportBtn">Export</button>`;
  const switchButton = `<button type="button" id="toggle3d" aria-label="${is3d ? 'Switch to Chat' : 'Switch to 3D preview'}" aria-controls="${is3d ? 'chat' : 'stage'}">${is3d ? '◂ Chat' : '3D ▸'}</button>`;
  if (phone) {
    // The primary mobile bar is navigation, never a diagnostics dashboard.
    // Keep warnings visible; all other technical state moves to More.
    $('status').classList.add('compactStatus');
    $('status').innerHTML = `
      <button type="button" id="projectBtn" aria-label="Open products, current: ${esc(product)}" title="${esc(product)}"><span class="productBtnIcon" aria-hidden="true">▣</span><span class="productBtnName">Produkty</span><span aria-hidden="true">⌄</span></button>
      <button type="button" id="moreBtn" aria-label="More controls and diagnostics">···</button>
      ${switchButton}
      ${storageWarning ? '<span class="mobileWarning" role="status">AUTOSAVE ✕</span>' : ''}
      ${v.errors.length ? `<span class="mobileWarning" role="status">${v.errors.length} model errors</span>` : ''}`;
    $('moreContent').innerHTML = `<h3>Model details</h3><div class="statusFacts">${facts}</div>
      <h3>Tools</h3><div class="statusTools">${tools}</div>`;
    $('moreBtn').onclick = () => { closeSheets(); $('moreSheet').classList.add('open'); };
  } else {
    $('status').classList.remove('compactStatus');
    $('status').innerHTML = `
      <div class="statusFacts">${facts}</div>
      <div class="statusTools"><button type="button" id="projectBtn">Products</button>${tools}</div>
      ${switchButton}`;
    $('moreContent').innerHTML = '';
  }
  $('toggle3d').onclick = () => show3d(!document.body.classList.contains('show3d'));
  $('projectBtn').onclick = openProducts;
  $('propertyBtn').onclick = () => { closeSheets(); renderProperties(); $('properties').classList.add('open'); };
  $('histBtn').onclick = () => { closeSheets(); renderHistory(); $('history').classList.add('open'); };
  $('exportBtn').onclick = () => { closeSheets(); renderExports(); $('exports').classList.add('open'); };
}

// What the 3D view shows: engine solids (exact material), partly symbolic, or still loading.
function geometryTag() {
  if (geometry.error) return `<span class="tag err" id="geomTag" title="${esc(`Solid geometry unavailable: ${geometry.error}. Openings are shown as symbols.`)}">3D SYMBOLIC</span>`;
  if (!geometry.engine) return '<span class="tag" id="geomTag" title="Loading the solid geometry engine…">3D …</span>';
  const notes = geometry.last?.notes || [];
  return notes.length ? `<span class="tag open" id="geomTag" title="${esc(`Partly symbolic:\n${notes.join('\n')}`)}">3D ≈ ${notes.length}</span>`
    : `<span class="tag ok" id="geomTag" title="${esc(`Solid geometry (${geometry.engine.name}): openings and protrusions are real material and empty space.`)}">3D SOLID</span>`;
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
    <div class="dtext">${valid ? `Návrh čeká na potvrzení${t ? ` · 🔍 ${esc(t.label)} (${pending.zoomIndex + 1}/${n})` : ''}` : `Návrh není platný (${esc(ev.status)})`}</div>
    <div class="dbtns">
      ${valid ? `<button type="button" id="zoomBtn" title="Zoom to change">🔍 ${t ? 'Next' : 'Zoom'}<span class="long"> ${t ? '▸' : 'to change'}</span></button>
      <button type="button" id="wholeBtn" title="Whole model">⤢ <span class="long">Whole model</span><span class="short">All</span></button>` : ''}
      <button type="button" class="primary" id="acceptBtn" ${valid ? '' : 'disabled'}>✓ Přijmout</button>
      <button type="button" class="danger" id="rejectBtn">✕ ${valid ? 'Zamítnout' : 'Zavřít'}</button>
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
        <div class="muted">${r.utterance ? `you said: “${esc(r.utterance)}”` : esc(r.kind)} · #${esc(r.hash.slice(7, 15))}${r.legacy ? ' · accepted under the rules before 2026-10-03' : ''}</div></div>
      ${r.current ? '<span class="muted">current</span>' : `<button type="button" data-rev="${r.revision}">Restore</button>`}
    </div>`).join('') + `<p class="muted">Restore moves the current concept to that exact revision. Accepting a proposal afterwards starts a branch from it; nothing is deleted.</p>
    <div class="dbtns" style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" id="freezeBtn">Freeze concept</button><button type="button" id="resetBtn" class="danger">Start over</button></div>`;
  $('revs').querySelectorAll('button[data-rev]').forEach((b) => {
    b.onclick = () => { supersede(); session = checkout(session, Number(b.dataset.rev)); save(); sys(`Restored REV ${b.dataset.rev} exactly (no reconstruction). New proposals will branch from it.`); refresh(); renderHistory(); };
  });
  $('freezeBtn').onclick = () => {
    try { supersede(); session = freeze(session, new Date().toISOString()); save(); sys(`CONCEPT FROZEN as REV ${session.head}.`); refresh(); renderHistory(); } catch (e) { sys(e.message); }
  };
  $('resetBtn').onclick = async () => { supersede(); session = await startSession(true); designMemory = emptyMemory(); sys('Started over from the S1 start revision.'); refresh(); renderHistory(); };
}

function renderDesignBrief() {
  const model = acceptedModel(session);
  const memo = memoryView(designMemory, '', model);
  const prior = new Map();
  for (const entry of designMemory.entries) for (const claim of entry.claims) {
    prior.set(claim.key, (prior.get(claim.key) || 0) + 1);
  }
  const human = { 'box.outer_dimensions_mm': 'Box outer dimensions', 'box.wall_mm': 'Wall thickness',
    'lid.height_mm': 'Lid height', 'hinge.pin_removable': 'Removable hinge pin',
    'hinge.integrated': 'Integrated hinge', 'hinge.edge': 'Hinge edge' };
  const finalTurn = thread().turns.at(-1);
  const currentQuestion = finalTurn?.role === 'assistant' && finalTurn?.kind === 'question' ? finalTurn.text : '';
  $('briefList').innerHTML =
    `<p class="muted">User requirements are saved with this product, independent of Accept, and included in .aiconcept exports. They do not change the accepted 3D geometry by themselves. ${memo.entries} user statements recorded.</p>
    <h3>Known</h3>` +
    (memo.facts.length ? memo.facts.map((f) => {
      const numeric = typeof f.value === 'number' || Array.isArray(f.value);
      const value = Array.isArray(f.value) ? f.value.join(' × ') :
        typeof f.value === 'boolean' ? (f.value ? 'Yes' : 'No') : String(f.value);
      return `<div class="rev"><div><b>${esc(human[f.key] || f.key)}:</b> ${esc(value)}${numeric ? ' mm' : ''}
        <div class="muted">${f.status === 'accepted_in_model' ? 'Verified in accepted model' : 'User-stated · compare with accepted model'} · source #${f.seq}</div>
        <div class="muted">“${esc(f.text)}”</div></div></div>`;
    }).join('') : '<p class="muted">No typed requirements yet. Other decisions remain in the original user statements below.</p>') +
    `<h3>Open</h3><p>${esc(currentQuestion || 'No current clarification question. See the OPEN count above for model-level unresolved questions.')}</p>
    <h3>Changed</h3>` +
    ([...prior].filter(([, n]) => n > 1).map(([k, n]) => `<p>${esc(human[k] || k)}: ${n} user statements; latest stated value displayed above.</p>`).join('')
      || '<p class="muted">No revised numerical requirements recorded yet.</p>') +
    `<details><summary>Full source journal (${memo.entries} user statements)</summary>
    <p class="muted">Each entry is the exact user wording; assistant questions are context only. Correct mistakes by describing the correction in Chat.</p>` +
    designMemory.entries.map((e) => `<p><b>#${e.seq}</b> · ${esc(e.text)}${e.question ? `<span class="muted"> (answered: ${esc(e.question)})</span>` : ''}</p>`).join('') +
    '</details>';
}

function portableArtifacts() {
  const files = acceptedArtifacts(session);
  for (const [name, text] of Object.entries(files)) {
    if (name.endsWith('.aiconcept')) files[name] = exportWithMemory(text, designMemory);
  }
  return files;
}
const DESCRIBE = {
  '.aiconcept': 'Accepted concept and revision history, plus separately labeled user-stated requirements (not accepted geometry)',
  '.concept_contract.md': 'Concept Contract — human-readable description',
  '.coder_prompt.md': 'Coder Prompt — for a coding agent',
  '.skeleton_spec.json': 'Skeleton Spec — resolved frames, features and parameters',
};
function renderExports() {
  const files = portableArtifacts();
  const model = acceptedModel(session);
  $('expList').innerHTML = `<p class="muted">Geometry and derived outputs come from <b>accepted REV ${model.meta.revision}</b> only. The .aiconcept file additionally preserves the separate user requirements journal; its unaccepted statements do not alter geometry.${pending ? ' The pending geometry proposal is <b>not</b> included.' : ''}</p>`
    + Object.keys(files).map((name) => {
      const kind = Object.keys(DESCRIBE).find((k) => name.endsWith(k));
      return `<div class="exp"><div><div>${esc(DESCRIBE[kind])}</div><div class="muted">${esc(name)}</div></div><button type="button" data-f="${esc(name)}">Download</button></div>`;
    }).join('');
  $('expList').querySelectorAll('button[data-f]').forEach((b) => {
    b.onclick = () => {
      const current = portableArtifacts();          // regenerate at click time: always the accepted model
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
// Revisions migrated from a pre-2026-10-03 history are kept as accepted then; say so once.
function legacyNote(s) {
  const n = historyView(s).filter((r) => r.legacy).length;
  if (n) sys(`${n} earlier revision${n > 1 ? 's were' : ' was'} accepted under the rules before 2026-10-03 and ${n > 1 ? 'are' : 'is'} kept as accepted then (marked in History). New changes use the current rules.`);
}
function switchSession(next, key, message, nextMemory = emptyMemory()) {
  retireChoices();                          // a question of the previous project must not answer into this one
  if (liveRequest) {                        // its reply belongs to the previous project: drop it when it comes
    liveRequest.progress.remove();
    sys(`The AI reply to “${liveRequest.text}” was for the previous project; it will be ignored.`);
    liveRequest = null;
  }
  supersede();
  session = next;
  activeStore = key;
  designMemory = nextMemory;
  view = defaultViewState();
  save();
  closeSheets();
  sys(message);
  legacyNote(next);
  replayThread();
  refresh();
}
// ---------------------------------------------------------------- Product Library
// The products saved in this browser (app/library.js). Open, Rename and Delete
// act on one product's own slot; Rename and Delete open a small form in that
// row first, so no single tap renames or deletes anything.
let libraryUi = null;        // { key, mode: 'rename' | 'delete' }: the one row showing a form
const when = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'not recorded'; };
function productRow(r, model) {
  const cur = r.key === activeStore;
  const name = displayName(r);
  const rev = cur ? model.meta.revision : r.revision;
  const ui = libraryUi?.key === r.key ? libraryUi.mode : null;
  return `<div class="product${cur ? ' current' : ''}" data-key="${esc(r.key)}">
    <div class="pmain"><div class="pname">${esc(name)}${cur ? ' <span class="pill ACCEPTED">Open now</span>' : ''}</div>
      <div class="muted">REV ${rev ?? '?'} · modified ${esc(when(r.updated))}</div></div>
    <div class="pactions">${cur ? '' : `<button type="button" data-project="${esc(r.key)}">Open</button>`}<button type="button" data-rename="${esc(r.key)}">Rename</button><button type="button" data-delete="${esc(r.key)}">Delete</button></div>
    ${ui === 'rename' ? `<form class="pform" id="renameForm"><label for="renameInput">New name</label><input id="renameInput" maxlength="${NAME_MAX}" required value="${esc(name)}" autocomplete="off"><div class="sheet-actions"><button type="submit" class="primary">Save name</button><button type="button" id="renameCancel">Cancel</button></div></form>` : ''}
    ${ui === 'delete' ? `<div class="pform confirm" role="alertdialog" aria-labelledby="deleteTitle"><b id="deleteTitle">Delete “${esc(name)}”?</b><p>This removes its accepted model (REV ${rev ?? '?'}), its whole revision history, its autosave backup and its AI conversation from this browser. It cannot be undone. Other products are not affected.</p><div class="sheet-actions"><button type="button" id="deleteDownload">Download .aiconcept first</button><button type="button" id="deleteCancel">Cancel</button><button type="button" class="danger" id="deleteConfirm">Delete “${esc(name)}”</button></div></div>` : ''}
  </div>`;
}
function renderProjects() {
  const model = acceptedModel(session);
  let rows = [], listError = '';
  try { rows = listProducts(localStorage); } catch (e) { listError = e.message; }
  if (!rows.some((r) => r.key === activeStore)) rows.unshift({ key: activeStore, id: model.meta.id, title: model.meta.title, revision: model.meta.revision, updated: null });
  if (libraryUi && !rows.some((r) => r.key === libraryUi.key)) libraryUi = null;
  $('projectList').innerHTML = `
    <form id="newProject" class="newproduct"><label for="newTitle">New product</label><div class="np"><input id="newTitle" required maxlength="${NAME_MAX}" placeholder="Name, e.g. Desk cable tray" autocomplete="off"><button class="primary" type="submit">Create</button></div></form>
    ${unreadable || unreadableSaves().length ? `<div class="box err"><b>Unreadable saved projects</b>${unreadable ? `<br>${esc(unreadable.error)}` : ''}<br><span class="muted">They failed validation. Their exact text is kept in this browser; nothing was replaced.</span><div class="sheet-actions">${unreadableSaves().map((k) => `<button type="button" data-unreadable="${esc(k)}">Download ${esc(new Date(Number(k.slice(UNREADABLE_PREFIX.length))).toLocaleString())}</button>`).join('')}${unreadable && !unreadable.qkey ? '<button type="button" id="projectUnreadable">Download unreadable save</button>' : ''}</div></div>` : ''}
    <h3>Your products (${rows.length})</h3>
    ${listError ? `<p class="err">The product list could not be read: ${esc(listError)}</p>` : ''}
    <div id="productRows">${rows.map((r) => productRow(r, model)).join('')}</div>
    <h3>This product: ${esc(currentName())}</h3>
    <div class="sheet-actions"><button type="button" id="projectSave" class="primary">Save .aiconcept</button><button type="button" id="projectOpen">Open file…</button><button type="button" id="projectBrief">Requirements / Brief</button><button type="button" id="projectBackup" ${localStorage.getItem(`${activeStore}.backup`) ? '' : 'disabled'}>Restore autosave backup</button></div>
    <p class="muted">Products are saved in this browser only. Opening a file always adds it as a new product; it never replaces one.</p>`;
  $('projectSave').onclick = () => {
    const files = portableArtifacts();
    const name = Object.keys(files).find((x) => x.endsWith('.aiconcept'));
    downloadText(name, files[name]);
  };
  $('projectOpen').onclick = () => $('openFile').click();
  $('projectBrief').onclick = () => { renderDesignBrief(); $('projects').classList.remove('open'); $('designBrief').classList.add('open'); };
  if ($('projectUnreadable')) $('projectUnreadable').onclick = () => downloadText('unreadable-concept-sketcher-save.json', unreadable.raw);
  $('projectList').querySelectorAll('[data-unreadable]').forEach((b) => { b.onclick = () => downloadText(`unreadable-concept-sketcher-save-${b.dataset.unreadable.slice(UNREADABLE_PREFIX.length)}.json`, localStorage.getItem(b.dataset.unreadable) || ''); });
  $('projectBackup').onclick = () => {
    try {
      const raw = localStorage.getItem(`${activeStore}.backup`);
      if (!raw) throw new Error('No backup is available.');
      switchSession(importSession(raw), activeStore, 'Restored the previous autosaved revision history.', memoryFromConcept(raw));
    } catch (e) { sys(`Backup was not restored: ${e.message}`); }
  };
  $('newProject').onsubmit = (e) => {
    e.preventDefault();
    try {
      const name = cleanName($('newTitle').value);
      const { id, key } = freeSlot(localStorage, name);           // a slot no product uses: never overwrites
      const next = createSession(JSON.stringify(blankModel(id, name)), { summary: 'New blank project', source: 'Products' });
      storeNewProduct(localStorage, key, exportWithMemory(exportSession(next), emptyMemory()));    // stored completely, or not at all
      libraryUi = null;
      switchSession(next, key, `Created product “${name}”.`);
    } catch (err) { sys(`Product was not created: ${err.message}. Nothing was changed.`); }
  };
  $('projectList').querySelectorAll('[data-project]').forEach((b) => { b.onclick = () => {
    const key = b.dataset.project;
    let raw = null;
    try {
      raw = localStorage.getItem(key);
      if (!raw) throw new Error('Local project data is missing.');
      const next = importSession(raw);
      const row = rows.find((r) => r.key === key);
      libraryUi = null;
      switchSession(next, key, `Opened “${displayName(row || acceptedModel(next).meta)}”.`, memoryFromConcept(raw));
    } catch (e) {
      // keep its exact text (quarantine copy, or protect its slot) and offer it for download
      if (raw) { quarantine(key, raw, e.message); renderProjects(); }
      sys(`Project was not opened: ${e.message}`);
    }
  }; });
  $('projectList').querySelectorAll('[data-rename]').forEach((b) => { b.onclick = () => { libraryUi = { key: b.dataset.rename, mode: 'rename' }; renderProjects(); $('renameInput')?.focus(); }; });
  $('projectList').querySelectorAll('[data-delete]').forEach((b) => { b.onclick = () => { libraryUi = { key: b.dataset.delete, mode: 'delete' }; renderProjects(); $('deleteCancel')?.focus(); }; });
  if ($('renameForm')) {
    const key = libraryUi.key;
    $('renameCancel').onclick = () => { libraryUi = null; renderProjects(); };
    $('renameForm').onsubmit = (e) => {
      e.preventDefault();
      try {
        const name = renameProduct(localStorage, key, $('renameInput').value);
        libraryUi = null;
        sys(`Renamed to “${name}”. Only the library name changed; the accepted model and its history are unchanged.`);
        renderStatus();
        renderProjects();
      } catch (err) { sys(`Not renamed: ${err.message}. Nothing was changed.`); }
    };
  }
  if ($('deleteConfirm')) {
    const key = libraryUi.key, row = rows.find((r) => r.key === key);
    $('deleteCancel').onclick = () => { libraryUi = null; renderProjects(); };
    // The open product: its accepted state in this tab, with the full history (newer than the
    // saved copy if autosave failed). Any other product: its saved slot, which holds its history.
    $('deleteDownload').onclick = () => {
      if (key === activeStore) {
        const m = acceptedModel(session);
        downloadText(`${slug(m.meta.id)}-rev${m.meta.revision}.aiconcept`, exportWithMemory(exportSession(session), designMemory));
        return;
      }
      const raw = localStorage.getItem(key);
      if (raw) downloadText(`${slug(row?.id || displayName(row))}-rev${row?.revision ?? 'x'}.aiconcept`, raw);
      else sys(`“${displayName(row)}” has no saved data to download.`);
    };
    $('deleteConfirm').onclick = () => deleteFromLibrary(key, displayName(row));
  }
}

// Delete one product after its confirmation. The open product is first replaced
// by another one (or a new blank product), so nothing autosaves into the deleted
// slot afterwards; only then are its own keys removed.
function deleteFromLibrary(key, name) {
  libraryUi = null;
  if (unreadable?.key === key) {
    sys(`“${name}” was not deleted: its saved text could not be validated or copied aside, so this slot is its only copy. Download it first (Unreadable saved projects).`);
    renderProjects();
    return;
  }
  try {
    if (key === activeStore) {
      const fallback = productAfterDelete(key);
      switchSession(fallback.session, fallback.key, fallback.message);
    }
    deleteProduct(localStorage, key);
    sys(`Deleted “${name}” from this browser.`);
  } catch (e) {
    sys(`“${name}” was not deleted completely: ${e.message}`);
  }
  if ($('projects').classList.contains('open')) renderProjects();
}
function productAfterDelete(deleted) {
  for (const r of listProducts(localStorage)) {
    if (r.key === deleted) continue;
    try { return { session: importSession(localStorage.getItem(r.key)), key: r.key, message: `Opened “${displayName(r)}”.` }; }
    catch { /* not readable now: it stays listed and untouched; try the next one */ }
  }
  const { id, key } = freeSlot(localStorage, 'New product');
  return { session: createSession(JSON.stringify(blankModel(id, 'New product')), { summary: 'New blank project', source: 'Products' }), key, message: 'Created a new blank product “New product”.' };
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
    // What the user typed is their statement; it is the evidence the common boundary checks.
    const utterance = `Exact property edit for ${desc.title}: ${edits.map(({ path, value }) => `${path} = ${value}`).join('; ')}`;
    const intent = { format: 'AI_CONCEPT_INTENT', schema: 1, action: 'PATCH', summary: `Exact values for ${desc.title}`, utterance, targets: [desc.target], edits: edits.map(({ path, value }) => ({ path, value })), creates: [], deletes: [], answers: [], unknowns: [] };
    const text = JSON.stringify(intent);
    const said = { utterance, base: baseOf(acceptedModel(session)), source: 'property-editor' };
    const ev = evaluateLive(session, text, said);
    const card = liveIntentCard(ev, text);
    pending = { kind: 'live', text, said, evaluation: ev, card, targets: [], zoomIndex: -1 };
    closeSheets(); refresh();
  };
}

// ---------------------------------------------------------------- chat
function addEl(html, cls) {
  const d = document.createElement('div');
  d.className = cls; d.innerHTML = html;
  $('log').appendChild(d);
  reveal(d);
  return d;
}
// Scroll only the conversation, never the page: scrollIntoView also scrolls the
// viewport, which on a phone shifts the whole app up and leaves a gap under it.
// A card taller than the log shows its top (the question), otherwise its bottom.
function reveal(el) {
  const log = $('log');
  const r = el.getBoundingClientRect(), l = log.getBoundingClientRect();
  let delta = 0;
  if (r.bottom > l.bottom) delta = r.height > l.height ? r.top - l.top : r.bottom - l.bottom;
  else if (r.top < l.top) delta = r.top - l.top;
  if (delta) log.scrollBy({ top: delta, behavior: 'smooth' });
  if (document.scrollingElement?.scrollTop) document.scrollingElement.scrollTop = 0;
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
  amendTurn(pending.turn, { outcome: 'superseded', intent: undefined, said: undefined });
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

// A question from the AI. Its suggested answers are UI only: a tap sends the
// visible label as the user's next message through send(), exactly like typed text.
// `active` is false for a question that is no longer the latest turn.
function liveIntentCard(ev, intentText, { active = true } = {}) {
  const i = ev.intent;
  const errs = ev.errors.length ? `<ul class="err">${ev.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : '';
  if (ev.status === 'CLARIFY') {
    const choices = Array.isArray(ev.choices) && ev.choices.length ? ev.choices : explicitQuestionChoices(ev.question);
    const card = addEl(`
      <div class="top"><span class="pill CLARIFY">QUESTION</span></div>
      <div class="question"><span class="vh">Question: </span>${esc(ev.question)}</div>
      ${choices.length ? `<div class="choices${active ? '' : ' obsolete'}" role="group" aria-label="Suggested answers">${choices.map((c, k) => `<button type="button" data-choice="${k}" ${active ? '' : 'disabled'}>${esc(c.label)}</button>`).join('')}<button type="button" class="other" data-other ${active ? '' : 'disabled'}>Jiná odpověď…</button></div>` : ''}
      ${intentText ? `<details><summary>Advanced: raw intent JSON</summary><pre>${esc(JSON.stringify(JSON.parse(intentText), null, 2))}</pre></details>` : ''}`, 'card ask');
    card.querySelectorAll('[data-choice]').forEach((b) => { b.onclick = () => choose(card, b, choices[Number(b.dataset.choice)].label); });   // exactly the words shown
    card.querySelector('[data-other]')?.addEventListener('click', () => { $('input').placeholder = 'Napiš vlastní odpověď…'; $('input').focus(); });
    return card;
  }
  const scope = ev.scope?.allow || [];
  const affects = ev.scope?.affects || [];
  const changed = ev.scope?.changed || [];
  const answers = i?.answers || [];
  const unknowns = i?.unknowns || [];
  // which of the user's messages each checked number comes from (a later message may have replaced it)
  const sources = ev.proposal ? valueSources(acceptedModel(session), ev.proposal.ops, ev.proposal.utterance) : [];
  const shown = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
  const html = `
    <div class="top"><span class="pill ${ev.status}">${ev.status === 'VALID' ? '+ PROPOSED' : ev.status}</span><span class="muted">Live Intent</span></div>
    ${i ? `<div><b>AI proposes:</b> ${esc(i.summary)}</div>` : ''}
    ${scope.length || changed.length ? `<details class="technicalDiff"><summary>Change details (${changed.length} model paths)</summary>
      ${scope.length ? `<div class="box"><b>May change (derived from the edits):</b> ${scope.map(esc).join(' · ')}<br><span class="muted">Every other model path is checked to stay byte-identical.</span>${affects.length ? `<br><b>Refers to / depends on (not changed):</b> ${affects.map(esc).join(' · ')}` : ''}</div>` : ''}
      ${changed.length ? `<div class="box"><b>Actual diff:</b> ${changed.map(esc).join(' · ')}</div>` : ''}
    </details>` : ''}
    ${sources.some((x) => !x.latest) ? `<div class="warn" role="alert">Pozor: návrh obsahuje starší hodnotu. Zkontroluj ji před přijetím.</div>` : ''}
    ${sources.length ? `<details class="sourceDetails"><summary>Odkud jsou hodnoty?</summary><div class="box"><b>Values from your messages:</b>${sources.map((x) => `<div class="src">${esc(x.what)} = <span class="new">${esc(shown(x.value))}</span> — from “${esc(x.from)}”${x.latest ? '' : `<div class="warn">⚠ This comes from an earlier message. Your latest message was “${esc(x.last)}”. Check it is still what you want before accepting.</div>`}</div>`).join('')}</div></details>` : ''}
    ${answers.length ? `<div class="box"><b>Resolved:</b> ${answers.map((a) => `${esc(a.id)} = ${esc(a.answer)}`).join(' · ')}</div>` : ''}
    ${unknowns.length ? `<div class="box"><span class="pill OPEN">? OPEN</span> ${unknowns.map((u) => esc(u.question)).join(' · ')}</div>` : ''}
    ${errs}
    ${i ? `<details><summary>Advanced: raw intent JSON</summary><pre>${esc(JSON.stringify(JSON.parse(intentText), null, 2))}</pre></details>` : ''}`;
  return addEl(html, 'card');
}

// One tap per question: the chosen answer is marked, the others are disabled,
// and its label goes through send() like typed text. If it was held back (a
// reply is still awaited) the question stays open.
async function choose(card, button, answer) {
  const box = card.querySelector('.choices');
  if (!box || box.classList.contains('obsolete') || box.dataset.busy) return;
  box.dataset.busy = '1';
  box.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  button.classList.add('chosen'); button.setAttribute('aria-pressed', 'true');
  const sent = await send(answer, { via: 'choice' });
  if (sent === false && !box.classList.contains('obsolete')) {
    delete box.dataset.busy;
    button.classList.remove('chosen'); button.removeAttribute('aria-pressed');
    box.querySelectorAll('button').forEach((b) => { b.disabled = false; });
  }
}
// Any new message answers or replaces every earlier question: their choices go out of date.
function retireChoices() {
  document.querySelectorAll('#log .choices:not(.obsolete)').forEach((box) => {
    box.classList.add('obsolete');
    box.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  });
  $('input').placeholder = 'Popiš změnu…';
}

// A reply that cannot be used, or a transport failure: say that nothing changed
// and offer to send the same words again.
function retryButton(el, text) {
  const retry = document.createElement('button');
  retry.type = 'button'; retry.className = 'primary retry'; retry.dataset.retry = ''; retry.textContent = '↻ Try again';
  retry.onclick = () => { retry.disabled = true; send(text).then((sent) => { if (sent === false) retry.disabled = false; }); };
  el.appendChild(retry);
}

function aiReplyRejectedCard(text, e) {
  const card = addEl(`
    <div class="top"><span class="pill INVALID">NOT USED</span><span class="muted">Live Intent</span></div>
    <div>${esc(e.message)}</div>
    <div class="muted">Try again, or say it more specifically: what it is, its size and how it is made.</div>
    <div class="retrybox"></div>
    ${e.details.length ? `<details><summary>Advanced: why it was refused</summary><ul class="err">${e.details.map((d) => `<li>${esc(d)}</li>`).join('')}</ul></details>` : ''}`, 'card');
  retryButton(card.querySelector('.retrybox'), text);
}

function onAccept() {
  if (!pending) return;
  try {
    session = pending.kind === 'live'
      ? acceptLive(session, pending.text, pending.said)
      : accept(session, pending.text);      // re-evaluated inside; never trusts the card
    setCardState(pending.card, 'ACCEPTED', `✓ ACCEPTED → REV ${session.head}`);   // the accepted state changed: the next message starts a new thread
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
  amendTurn(pending.turn, { outcome: 'rejected', intent: undefined, said: undefined });
  setCardState(pending.card, 'REJECTED', '✕ REJECTED — nothing changed');
  pending = null;
  viewer.whole();
  refresh();
}

// One Live request at a time. A second one would race the first for `pending`
// (two cards shown as proposed, Accept applying whichever reply came last),
// and the GitHub transport cancels a queued run once a third is dispatched.
// The request belongs to the project it was sent from: switching project
// abandons it (switchSession), and its reply, when it comes, is dropped
// without touching the conversation, the pending proposal or the model.
let liveRequest = null;      // { text, progress } of the Live request in flight

// Returns false when the message was not sent because a Live reply is still awaited.
async function send(text, { via = 'typed' } = {}) {
  if (!text.trim()) return;
  if (LIVE.live && liveRequest) {
    if (via === 'typed' && !$('input').value) $('input').value = text;
    sys('The AI is still answering the previous message. Send this one when that reply has arrived.');
    return false;
  }
  retireChoices();
  supersede();
  user(text);
  const model = acceptedModel(session);

  if (LIVE.live) {
    // Persistent per-product evidence: only literal user statements count.
    // The short conversation window is used for immediate question context.
    const currentThread = thread();
    const finalTurn = currentThread.turns.at(-1);
    const lastQuestion = finalTurn?.role === 'assistant' && finalTurn?.kind === 'question' ? finalTurn.text : '';
    designMemory = appendMemory(designMemory, text, { question: lastQuestion, revision: model.meta.revision });
    save();
    const memory = memoryView(designMemory, text, model, lastQuestion);
    const recent = recentOf(currentThread);
    const recentUserWords = new Set([...recent.filter((r) => r.role === 'user').map((r) => r.text), text]);
    const olderEvidence = memoryEvidenceWords({ evidence: memory.evidence.filter((e) => !recentUserWords.has(e.text)) });
    const said = { utterance: [olderEvidence, threadWords(recent, text)].filter(Boolean).join('\n'),
      base: baseOf(model), source: 'live-intent' };
    const progress = addEl('Přemýšlím…', 'msg sys thinking');
    const mine = { text, progress };
    liveRequest = mine;
    const abandoned = () => liveRequest !== mine;
    try {
      let intentText;
      const onProgress = (message) => { if (progress) progress.textContent = message; };

      const askGitHubToken = () => {
        const token = prompt('GitHub-only POC needs a fine-grained token for ZdenekLukes/concept-sketcher. It is stored only in this browser and sent only to api.github.com. Paste token:');
        if (!token) return false;
        storeGitHubToken(token);
        return true;
      };

      try {
        if (LIVE.transport === 'github' && !storedGitHubToken() && !askGitHubToken()) {
          progress.classList.remove('thinking');
          progress.textContent = 'GitHub POC cancelled — no token stored.';
          return;
        }
        try {
          intentText = await requestLiveIntent(LIVE, { utterance: text, model, recent, memory }, { onProgress });
        } catch (e) {
          if (LIVE.transport !== 'github' || !['GITHUB_TOKEN_REQUIRED', 'GITHUB_AUTH_FAILED'].includes(e.code)) throw e;
          clearGitHubToken();
          if (!askGitHubToken()) throw e;
          intentText = await requestLiveIntent(LIVE, { utterance: text, model, recent, memory }, { onProgress });
        }
      } catch (e) {
        if (abandoned()) return;
        progress.remove();
        if (e.code === 'AI_INTENT_INVALID') {
          remember({ role: 'user', text, via });
          remember({ role: 'assistant', kind: 'refused' });
          aiReplyRejectedCard(text, e);
          return;
        }
        const failed = sys(`${LIVE.transport === 'github' ? 'GitHub POC failed' : 'Live AI unavailable'}: ${e.message} — nothing was changed.`);
        retryButton(failed, text);
        return;
      }
      if (abandoned()) return;                                 // the user switched project meanwhile
      progress.remove();
      supersede();                                             // e.g. a Property Editor proposal made while waiting
      const ev = evaluateLive(session, intentText, said);      // STALE if the accepted model moved meanwhile
      remember({ role: 'user', text, via });                   // the turn is kept once a reply arrived (a lost request leaves no trace)
      const turn = rememberReply(ev, intentText, said);
      const card = liveIntentCard(ev, intentText);
      pending = ev.status === 'CLARIFY' ? null : { kind: 'live', text: intentText, said, evaluation: ev, card, targets: [], zoomIndex: -1, turn };
      refresh();
      return;
    } finally {
      if (!abandoned()) liveRequest = null;
    }
  }

  const proposalText = interpret(text, model);        // untrusted text
  const ev = evaluate(session, proposalText);         // dry-run on a copy
  const card = proposalCard(ev, model, proposalText);
  pending = ev.status === 'CLARIFY' ? null : { kind: 'proposal', text: proposalText, evaluation: ev, card, targets: [], zoomIndex: -1 };
  refresh();
}

// Record the AI reply in the thread. A VALID proposal keeps its intent and the
// words it was evaluated with, so a reload can re-evaluate it (never apply it).
function rememberReply(ev, intentText, said) {
  if (ev.status === 'CLARIFY') return remember({ role: 'assistant', kind: 'question', text: ev.question, ...(ev.choices?.length ? { choices: ev.choices } : {}) });
  const summary = ev.intent?.summary || 'a change';
  if (ev.status === 'VALID') return remember({ role: 'assistant', kind: 'proposal', text: summary, outcome: 'pending', intent: intentText, said });
  return remember({ role: 'assistant', kind: 'proposal', text: summary, outcome: ev.status === 'STALE' ? 'stale' : 'refused' });
}

// Show this project's thread again after a reload, a project switch or a
// recovery. A proposal still waiting for a decision is evaluated again against
// the accepted model (the same boundary as always) and only offered, never applied.
function replayThread() {
  if (!LIVE.live || !session) return;
  const turns = thread().turns;
  if (!turns.length) return;
  sys('Continuing this conversation. Nothing in it is part of the concept until you accept a proposal.');
  turns.forEach((t, i) => {
    const last = i === turns.length - 1;
    if (t.role === 'user') user(t.text);
    else if (t.kind === 'question') liveIntentCard({ status: 'CLARIFY', question: t.text, choices: t.choices, errors: [] }, null, { active: last });
    else if (t.kind === 'proposal' && t.outcome === 'pending' && last && t.intent && t.said) {
      const ev = evaluateLive(session, t.intent, t.said);
      const card = liveIntentCard(ev, t.intent);
      if (ev.status === 'VALID') pending = { kind: 'live', text: t.intent, said: t.said, evaluation: ev, card, targets: [], zoomIndex: -1, turn: t.id };
      else amendTurn(t.id, { outcome: ev.status === 'STALE' ? 'stale' : 'refused', intent: undefined, said: undefined });
    } else if (t.kind === 'proposal') {
      sys(`Earlier proposal: ${t.text} — ${t.outcome === 'rejected' ? 'rejected' : 'not applied'}.`);
    } else if (t.kind === 'refused') sys('An earlier AI reply could not be used; nothing was changed.');
  });
}

function refresh() { renderStatus(); render3d(); renderDecision(); }
const baseOf = (model) => ({ revision: model.meta.revision, hash: conceptHash(model) });

async function startSession(fresh = false) {
  if (!fresh) {
    let key = null, raw = null;
    try {
      key = localStorage.getItem(ACTIVE_PROJECT);
      raw = key && localStorage.getItem(key);
      if (!raw) {                           // no open product recorded: the most recently modified one, else a pre-library save
        const recent = listProducts(localStorage)[0];
        if (recent) { key = recent.key; raw = localStorage.getItem(key); }
        else { key = LEGACY_STORE; raw = localStorage.getItem(LEGACY_STORE); }
      }
    } catch (e) { storageWarning = `Browser storage unavailable: ${e.message}`; }
    if (raw) {
      try {
        const restored = importSession(raw);
        designMemory = memoryFromConcept(raw);
        activeStore = key === LEGACY_STORE ? freeSlot(localStorage, acceptedModel(restored).meta.id).key : key;
        return restored;
      } catch (e) {
        // Fail explicitly. The saved text is kept byte-for-byte (quarantine copy, or its slot is protected).
        quarantine(key, raw, e.message);
        storageWarning = `Saved project could not be restored: ${e.message}`;
        try { localStorage.removeItem(ACTIVE_PROJECT); } catch { /* storage unavailable */ }
      }
    }
  }
  const motionFixtures = { 'organizer-motion': '../examples/organizer_live_seed.aiconcept', 'motion-hinge': '../examples/motion/hinge.aiconcept', 'motion-slider': '../examples/motion/slider.aiconcept', 'motion-parameter': '../examples/motion/parameter.aiconcept' };
  const liveFixture = motionFixtures[LIVE.seed] || (LIVE.seed === 'organizer' ? '../examples/organizer_live_seed.aiconcept' : '../examples/live_start.aiconcept');
  const fixture = LIVE.live ? liveFixture : '../examples/s1_start.aiconcept';
  const text = await (await fetch(fixture)).text();
  const s = createSession(text, {
    summary: LIVE.live ? (LIVE.seed === 'organizer' ? 'Live organizer seed' : 'Live Concept start') : 'S1 start: box, spring frame, divider with tabs pointing down',
    source: LIVE.live ? liveFixture.replace('../', '') : 'examples/s1_start.aiconcept',
  });
  try { activeStore = freeSlot(localStorage, acceptedModel(s).meta.id).key; }   // a new slot: never another product's
  catch { activeStore = projectKey(acceptedModel(s).meta.id); }                  // storage unavailable: save() reports it
  session = s;
  save();                                   // refuses the slot of an unreadable project (see save)
  return s;
}

function unavailableViewer(message) {
  $('view').innerHTML = `<div style="padding:24px;color:#e9eef5"><h2>3D preview unavailable</h2><p>${esc(message)}</p><p>The concept, validation, properties and exports remain available.</p></div>`;
  const noop = () => {};
  return { onPick: noop, show: noop, setView: noop, resize: noop, whole: noop, frame: noop, view: noop };
}

async function main() {
  if (!ensureCurrentShell()) return;     // a stale cached shell must not start the current app half-way
  try { viewer = createViewer($('view')); }
  catch (e) { storageWarning = `3D unavailable: ${e.message}`; viewer = unavailableViewer(e.message); }
  viewer.onPick((key) => select(key));
  loadManifoldEngine().then((engine) => { geometry.engine = engine; if (session) refresh(); })
    .catch((e) => { geometry.error = e.message; if (session) renderStatus(); });
  $('legendRef').onclick = () => setView({ showReference: !view.showReference });
  session = await startSession();
  if ($('modeLabel')) $('modeLabel').dataset.boot = 'ready';   // release smoke test: the module graph loaded and the app initialised
  if ($('modeLabel')) $('modeLabel').textContent = LIVE.live ? `LIVE · ${LIVE.transport === 'github' ? 'GitHub POC' : 'HTTP'}${LIVE.seed ? ` · ${LIVE.seed}` : ''}` : 'S1 · demo interpreter (no AI connected)';
  $('chips').innerHTML = LIVE.live ? '' : DEMO_SENTENCES.map((s) => `<button type="button">${esc(s)}</button>`).join('');
  $('chips').querySelectorAll('button').forEach((b) => { b.onclick = () => { document.body.classList.remove('showchips'); send(b.textContent); }; });
  $('examplesBtn').style.display = LIVE.live ? 'none' : '';
  $('examplesBtn').onclick = () => document.body.classList.toggle('showchips');
  $('form').onsubmit = (e) => { e.preventDefault(); const t = $('input').value; $('input').value = ''; void send(t); };
  $('closeMore').onclick = () => $('moreSheet').classList.remove('open');
  $('closeHist').onclick = () => $('history').classList.remove('open');
  $('closeBrief').onclick = () => $('designBrief').classList.remove('open');
  $('closeExp').onclick = () => $('exports').classList.remove('open');
  $('closeProjects').onclick = () => $('projects').classList.remove('open');
  $('closeProperties').onclick = () => $('properties').classList.remove('open');
  $('openFile').onchange = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const raw = await file.text();
      // A file with history must replay through the transaction boundary; a plain
      // model must validate. Either failure is reported, never papered over.
      const next = importSession(raw, { summary: `Opened ${file.name}`, source: file.name });
      const m = acceptedModel(next);
      // Always a new product in a free slot: a file never replaces a product, even with the same ID.
      const same = listProducts(localStorage).some((r) => r.id === m.meta.id);
      const { key } = freeSlot(localStorage, m.meta.id);
      storeNewProduct(localStorage, key, exportWithMemory(exportSession(next), memoryFromConcept(raw)));
      switchSession(next, key, `Opened and validated “${m.meta.title}” from ${file.name}${same ? ' as a new product (a product with the same ID is already here and was not changed)' : ''}.`, memoryFromConcept(raw));
    } catch (err) { sys(`File was not opened: ${err.message}`); }
  };
  legacyNote(session);
  if (unreadable) sys(`Saved project was NOT restored: ${unreadable.error}. Its exact text is kept in this browser (Products → Unreadable saved projects → Download). A new start concept is shown instead.`);
  sys(LIVE.live
    ? `Live Concept: REV ${acceptedModel(session).meta.revision} · transport ${LIVE.transport}. Describe the concept or a local change. AI only proposes; scoped validation and Accept control every mutation.`
    : `Accepted concept: REV ${acceptedModel(session).meta.revision} — ${acceptedModel(session).meta.title}. Tell me what to change. I only propose; nothing changes until you accept.`);
  replayThread();
  refresh();

  // Hooks for automated checks and temporary integration testing.
  window.__cs = {
    acceptedCanonical: () => JSON.stringify(acceptedModel(session)),
    head: () => session.head,
    pending: () => pending?.evaluation.status ?? null,
    artifacts: () => portableArtifacts(),
    zoom: () => (pending?.targets?.[pending.zoomIndex] ?? null),
    view: () => structuredClone(view),
    setView: (patch) => setView(patch),
    select: (key) => { select(key); return view.selected; },
    inspection: () => (stage && view.selected ? (stage.candidate ? inspectChange(stage.model, stage.v, stage.candidate, stage.vC, view.selected) : inspect(stage.model, stage.v, view.selected)) : null),
    changed: () => stage?.changed ?? [],
    conversation: () => structuredClone(thread()),
    designMemory: () => structuredClone(designMemory),
    geometry: () => ({ engine: geometry.engine?.name ?? null, loadMs: geometry.engine?.loadMs ?? null, error: geometry.error, ...structuredClone(geometry.last ?? {}) }),
    probe: (origin, dir) => viewer.probe?.(origin, dir) ?? [],
    camera: (name) => viewer.view(name),
    injectIntent: (intent) => {
      const text = typeof intent === 'string' ? intent : JSON.stringify(intent);
      const said = { utterance: JSON.parse(text).utterance, base: baseOf(acceptedModel(session)), source: 'test-hook' };
      const ev = evaluateLive(session, text, said);
      const card = liveIntentCard(ev, text);
      pending = ev.status === 'CLARIFY' ? null : { kind: 'live', text, said, evaluation: ev, card, targets: [], zoomIndex: -1 };
      refresh();
      return ev.status;
    },
  };
}
main().catch((e) => sys(`Failed to start: ${e.message}`));
