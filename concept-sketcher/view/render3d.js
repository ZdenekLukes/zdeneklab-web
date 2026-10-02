// Shared three.js renderer for scene.json-style data (S0 preview and S1 app).
// It only draws what it is given: an accepted scene and, optionally, a
// proposal overlay. No geometry decisions happen here.

import * as THREE from 'three';
import { OrbitControls } from '../vendor/three/OrbitControls.js';

export const STYLE_COLORS = { produced: 0x6f8fb8, reference: 0x9aa3b2, unresolved: 0xe8730c, proposed: 0x1f9d55, removed: 0xd93025 };
const OPACITY = { produced: 1, reference: 0.08, unresolved: 0.55, proposed: 0.6, removed: 0.18 };
const AX = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };
// Core V2 roles (schema 2): colour follows the meaning, and every item also carries a text label.
const ROLE_COLORS = { hole: 0x2b3a52, fastener: 0x8a6d3b, axis: 0x7a3db8, limits: 0x7a3db8, interface: 0x0b7285 };
const VOLUME_COLORS = { KEEP_OUT: 0xd93025, SERVICE_ACCESS: 0x1a73e8, REMOVAL_PATH: 0x1f9d55 };
const lineColor = (p) => ({ unresolved: STYLE_COLORS.unresolved, proposed: STYLE_COLORS.proposed, removed: STYLE_COLORS.removed }[p.style] ?? ROLE_COLORS[p.role] ?? 0x1d6b3a);
const DIR = { '+X': [1, 0, 0], '-X': [-1, 0, 0], '+Y': [0, 1, 0], '-Y': [0, -1, 0], '+Z': [0, 0, 1], '-Z': [0, 0, -1] };

// STUDIO style (app only; the S0 preview keeps the style above). Visual language of
// tools/mechanical_studio: dark stage, one distinct colour per PRODUCED part (its
// part palette, minus green/red/orange, which mean PROPOSED/REMOVED/OPEN here),
// REFERENCE parts as a faint desaturated ghost drawn last, OPEN as a dashed orange edge.
export const PART_PALETTE = [0x8fb5d9, 0xb5a1e0, 0x80d9e6, 0xf2c759, 0xe0a1d9, 0x6badcc, 0xd9b38c];
const STUDIO_ROLE = { axis: 0xb38cff, limits: 0xb38cff, interface: 0x3bc9db, fastener: 0xc9a46a };
const GHOST = { color: 0x7f9fbd, opacity: 0.18, edge: 0xc6d9ea, edgeOpacity: 0.80 };
const SELECT = { emissive: 0x6b4d00, line: 0xffd166 };
const lighten = (hex, f) => new THREE.Color(hex).lerp(new THREE.Color(0xffffff), f).getHex();

function material(style) {
  return new THREE.MeshLambertMaterial({ color: STYLE_COLORS[style], transparent: style !== 'produced', opacity: OPACITY[style], depthWrite: style === 'produced' });
}
// A proposed element that would be OPEN keeps the proposed fill with an OPEN (orange, dashed) outline.
function edges(mesh, style, open = false) {
  const dashed = style === 'unresolved' || style === 'removed' || open;
  const color = open ? STYLE_COLORS.unresolved : { reference: 0x9aa3b2, unresolved: STYLE_COLORS.unresolved, proposed: 0x0d6b34, removed: STYLE_COLORS.removed }[style] ?? 0x2b3a52;
  const e = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry),
    dashed ? new THREE.LineDashedMaterial({ color, dashSize: 2, gapSize: 1.5 }) : new THREE.LineBasicMaterial({ color }));
  e.computeLineDistances();
  mesh.add(e);
}
function label(text, color) {
  const c = document.createElement('canvas'); const g = c.getContext('2d');
  c.width = 256; c.height = 64; g.fillStyle = color; g.beginPath(); g.roundRect(4, 4, 248, 56, 12); g.fill();
  let px = 34;
  do { g.font = `bold ${px}px system-ui`; px -= 2; } while (g.measureText(text).width > 232 && px > 12);   // shrink to fit
  g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, 128, 34);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, sizeAttenuation: false }));
  s.scale.set(0.1, 0.025, 1); s.renderOrder = 10; return s;
}

function buildGroup(data, S = null) {
  const group = new THREE.Group();
  const isRef = (p) => Boolean(S && S.refParts.has(p.part ?? S.instanceOf(p.id).replace(/@\d+$/, '')));
  const overlayStyle = (p) => p.style === 'proposed' || p.style === 'removed';
  // studio fill for a solid primitive (proposal layer keeps its own style)
  const fill = (p, base) => {
    if (!S || overlayStyle(p)) return base();
    if (isRef(p)) return new THREE.MeshLambertMaterial({ color: GHOST.color, transparent: true, opacity: GHOST.opacity, depthWrite: false, side: THREE.DoubleSide });
    return new THREE.MeshLambertMaterial({ color: S.partColor(p.part), side: THREE.DoubleSide });
  };
  const outline = (mesh, p, open) => {
    if (!S || overlayStyle(p)) return edges(mesh, p.style, open);
    const ref = isRef(p), unresolved = p.style === 'unresolved';
    const mat = ref ? new THREE.LineDashedMaterial({ color: GHOST.edge, transparent: true, opacity: GHOST.edgeOpacity, dashSize: 4, gapSize: 3 })
      : unresolved ? new THREE.LineDashedMaterial({ color: STYLE_COLORS.unresolved, dashSize: 2, gapSize: 1.5 })
      : new THREE.LineBasicMaterial({ color: 0x0c0f14, transparent: true, opacity: 0.6 });
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), mat);
    e.computeLineDistances();
    mesh.add(e);
  };
  const strokeColor = (p) => {
    if (!S || overlayStyle(p) || p.style === 'unresolved') return lineColor(p);
    return STUDIO_ROLE[p.role] ?? (p.part ? lighten(S.partColor(p.part), 0.35) : 0x9fb3c8);
  };
  for (const p of data.primitives || []) {
    let mesh;
    if (p.shape === 'box' && (p.outline || p.role === 'volume')) {
      // an opening outline, or a typed volume (translucent, dashed edges; a failed check is red)
      const geo = new THREE.BoxGeometry(...p.size);
      const color = p.role === 'volume' ? (p.check === 'FAIL' ? STYLE_COLORS.removed : VOLUME_COLORS[p.purpose]) : lineColor(p);
      mesh = p.role === 'volume' ? new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color, transparent: true, opacity: 0.12, depthWrite: false })) : new THREE.Object3D();
      const e = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineDashedMaterial({ color: p.style === 'unresolved' ? STYLE_COLORS.unresolved : color, dashSize: 2, gapSize: 1.5 }));
      e.computeLineDistances();
      mesh.add(e);
      mesh.position.set(...p.center);
    } else if (p.shape === 'box') {
      mesh = new THREE.Mesh(new THREE.BoxGeometry(...p.size), fill(p, () => material(p.style)));
      mesh.position.set(...p.center);
      outline(mesh, p, p.style === 'proposed' && (p.unresolved || []).length > 0);
    } else if (p.shape === 'cylinder') {
      const mat = p.role === 'fastener' && (p.style === 'produced' || (S && p.style === 'unresolved')) ? new THREE.MeshLambertMaterial({ color: S ? STUDIO_ROLE.fastener : ROLE_COLORS.fastener }) : fill(p, () => material(p.style));
      mesh = new THREE.Mesh(new THREE.CylinderGeometry(p.d / 2, p.d / 2, p.length, 32), mat);
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...AX[p.axis]));
      mesh.position.set(...p.center);
      outline(mesh, p, p.style === 'proposed' && (p.unresolved || []).length > 0);
    } else if (p.shape === 'polyline') {
      const dashed = p.role === 'axis' || p.style === 'unresolved';
      const ghost = isRef(p) ? { transparent: true, opacity: GHOST.edgeOpacity } : {};
      mesh = new THREE.Line(new THREE.BufferGeometry().setFromPoints(p.points.map((v) => new THREE.Vector3(...v))),
        dashed ? new THREE.LineDashedMaterial({ color: strokeColor(p), dashSize: 3, gapSize: 2, ...ghost }) : new THREE.LineBasicMaterial({ color: strokeColor(p), ...ghost }));
      mesh.computeLineDistances();
    } else if (p.shape === 'ring') {
      const ri = p.inner_d / 2, ro = p.outer_d / 2, h = p.length;
      const prof = [new THREE.Vector2(ri, -h / 2), new THREE.Vector2(ro, -h / 2), new THREE.Vector2(ro, h / 2), new THREE.Vector2(ri, h / 2), new THREE.Vector2(ri, -h / 2)];
      mesh = new THREE.Mesh(new THREE.LatheGeometry(prof, 20), S ? fill(p, () => material(p.style)) : p.role === 'hole' && p.style === 'produced' ? new THREE.MeshLambertMaterial({ color: ROLE_COLORS.hole }) : material(p.style));
      if (S && !overlayStyle(p) && p.style === 'unresolved' && !isRef(p)) outline(mesh, p, false);
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...AX[p.axis]));
      mesh.position.set(...p.center);
    } else if (p.shape === 'zigzag') {
      const color = { unresolved: STYLE_COLORS.unresolved, proposed: STYLE_COLORS.proposed, removed: STYLE_COLORS.removed }[p.style] ?? (S ? strokeColor(p) : 0x1d6b3a);
      mesh = new THREE.Line(new THREE.BufferGeometry().setFromPoints(p.points.map((v) => new THREE.Vector3(...v))), new THREE.LineBasicMaterial({ color }));
    }
    if (mesh) { if (S) mesh.renderOrder = isRef(p) ? 2 : overlayStyle(p) ? 1 : 0; group.add(tag(mesh, p.id, S, isRef(p))); }
  }
  for (const l of data.labels || []) {
    const t = label(l.text, '#3b4252');
    t.position.set(...l.at);
    group.add(tag(t, l.id, S, false));
  }
  for (const a of data.arrows || []) {
    const color = { unresolved: STYLE_COLORS.unresolved, proposed: STYLE_COLORS.proposed, removed: STYLE_COLORS.removed }[a.style] ?? (S ? 0x9fb3c8 : 0x1d6b3a);
    group.add(tag(new THREE.ArrowHelper(new THREE.Vector3(...DIR[a.dir]), new THREE.Vector3(...a.from), a.length, color, 4, 2.5), a.id, S, isRef(a)));
  }
  // proposal layer: one text tag per changed group, so the state is not colour-only
  const tagged = new Set();
  const groupOf = (p) => p.id.split('#')[0].replace(/\[\d+\]$/, '').replace(/@\d+/, '');
  const partTagged = new Set((data.primitives || []).filter((p) => !groupOf(p).includes('.')).map((p) => `${p.style}:${groupOf(p)}`));
  for (const p of data.primitives || []) {
    if (p.style !== 'proposed' && p.style !== 'removed') continue;
    const g = groupOf(p);
    const key = `${p.style}:${g}`;
    if (tagged.has(key) || (g.includes('.') && partTagged.has(`${p.style}:${g.split('.')[0]}`))) continue;   // one tag per changed part
    tagged.add(key);
    const at = p.center ?? p.points?.[0];
    if (!at) continue;
    const t = label(p.style === 'proposed' ? '+ PROPOSED' : '− REMOVED', p.style === 'proposed' ? '#1f9d55' : '#d93025');
    t.position.set(at[0], at[1], at[2] + (p.style === 'proposed' ? 8 : -8));   // proposed above, removed below
    group.add(tag(t, p.id, S, isRef(p)));
  }
  // Legacy standalone preview keeps the OPEN badge. The app/studio UI already
  // exposes OPEN state in its status bar and Inspect, so do not cover the model
  // with a redundant yellow sprite there.
  if (!S) {
    for (const style of ['accepted', 'proposed']) {
      const ms = (data.markers || []).filter((m) => (m.style === 'proposed') === (style === 'proposed'));
      if (!ms.length) continue;
      const s = label(`? ${ms.map((m) => (m.status === 'STATED' ? `${m.question}(stated)` : m.question)).join(' ')}${style === 'proposed' ? ' new' : ' OPEN'}`, '#e8730c');
      s.position.set(ms[0].at[0], ms[0].at[1], ms[0].at[2] + (style === 'proposed' ? 22 : 0));
      group.add(s);
    }
  }
  for (const c of group.children) c.userData.base = c.position.clone();
  return group;
}

// Studio bookkeeping on every drawn item: the instance it moves with (explode),
// the entity it belongs to (inspect / pick) and whether it is reference geometry.
function tag(obj, id, S, ref) {
  if (!S || id === undefined) return obj;
  obj.userData = { ...obj.userData, inst: S.instanceOf(id), entity: S.entityOf(id), ref };
  return obj;
}

export function createViewer(root) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  root.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 0.75));
  const sun = new THREE.DirectionalLight(0xffffff, 0.9); sun.position.set(200, -300, 400); scene.add(sun);
  const camera = new THREE.PerspectiveCamera(40, 1, 1, 5000);
  camera.up.set(0, 0, 1);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 20);
  let accepted = null, overlay = null, framed = null;
  // view state (UI only, never part of the model): set by setView()
  let view = { showReference: true, plane: null, offsets: {}, selected: null };
  let pickHandler = null;

  const HOME_DIR = new THREE.Vector3(260, -360, 260).normalize();
  const CAMERA_PRESETS = {
    ISO:    { dir: HOME_DIR.clone(), up: [0, 0, 1] },
    FRONT:  { dir: new THREE.Vector3(0, -1, 0), up: [0, 0, 1] },
    BACK:   { dir: new THREE.Vector3(0, 1, 0), up: [0, 0, 1] },
    RIGHT:  { dir: new THREE.Vector3(1, 0, 0), up: [0, 0, 1] },
    LEFT:   { dir: new THREE.Vector3(-1, 0, 0), up: [0, 0, 1] },
    TOP:    { dir: new THREE.Vector3(0, 0, 1), up: [0, 1, 0] },
    BOTTOM: { dir: new THREE.Vector3(0, 0, -1), up: [0, -1, 0] },
  };
  let cameraPreset = 'ISO';

  function visibleSphere() {
    const box = new THREE.Box3();
    for (const g of [accepted, overlay]) {
      if (!g) continue;
      g.traverseVisible((o) => { if ((o.isMesh || o.isLine || o.isLineSegments) && !o.isSprite) box.expandByObject(o); });
    }
    if (box.isEmpty() && accepted) box.setFromObject(accepted);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    return Number.isFinite(sphere.radius) && sphere.radius > 0 ? sphere : null;
  }

  function wholeView() {
    const sphere = visibleSphere();
    if (sphere) frameBounds({ center: sphere.center.toArray(), radius: sphere.radius * 0.9 });
    else {
      const p = CAMERA_PRESETS[cameraPreset] ?? CAMERA_PRESETS.ISO;
      camera.up.set(...p.up);
      controls.target.set(0, 0, 20);
      camera.position.copy(controls.target).add(p.dir.clone().multiplyScalar(500));
      camera.lookAt(controls.target);
      controls.update();
    }
  }

  // Inspection only: move the camera so the given bounds fill the view while
  // preserving the selected orthographic-style viewing direction.
  function frameBounds(b) {
    const p = CAMERA_PRESETS[cameraPreset] ?? CAMERA_PRESETS.ISO;
    const dir = p.dir.clone().normalize();
    camera.up.set(...p.up);
    const vfov = (camera.fov * Math.PI) / 180;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
    const dist = (b.radius * 1.15) / Math.sin(Math.min(vfov, hfov) / 2);
    controls.target.set(...b.center);
    camera.position.copy(controls.target.clone().add(dir.multiplyScalar(dist)));
    camera.lookAt(controls.target);
    controls.update();
  }

  function setCameraPreset(name) {
    const key = String(name || '').toUpperCase();
    if (!CAMERA_PRESETS[key]) return false;
    cameraPreset = key;
    framed = null;
    wholeView();
    return true;
  }
  function resize() {
    const w = root.clientWidth, h = root.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
    if (framed) frameBounds(framed); else wholeView();
  }
  addEventListener('resize', resize);
  resize();
  renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });

  // apply the view state to the drawn items: reference visibility, explode, selection, section
  function applyView() {
    renderer.clippingPlanes = view.plane ? [new THREE.Plane(new THREE.Vector3(...view.plane.normal), view.plane.constant)] : [];
    for (const g of [accepted, overlay]) {
      if (!g) continue;
      for (const c of g.children) {
        const u = c.userData;
        if (u.ref) c.visible = view.showReference;
        const off = view.offsets[u.inst];
        if (u.base) c.position.copy(u.base).add(off ? new THREE.Vector3(...off) : new THREE.Vector3());
        const hit = Boolean(view.selected && u.entity === view.selected);
        c.traverse((o) => {
          const m = o.material;
          if (!m || o.isSprite) return;
          if (o.userData.color === undefined) o.userData.color = m.color?.getHex();
          if (m.emissive) m.emissive.setHex(hit ? SELECT.emissive : 0x000000);
          else if (m.color && (o.isLine || o.isLineSegments)) m.color.setHex(hit ? SELECT.line : o.userData.color);
          if (u.ref && o.isMesh) m.opacity = hit ? GHOST.opacity * 3 : GHOST.opacity;
        });
      }
    }
  }

  // Tap (not drag) on the canvas: the entity under the pointer. Produced geometry
  // wins over reference geometry (the reference box encloses everything); parts
  // cut away by the section plane cannot be picked.
  const raycaster = new THREE.Raycaster();
  raycaster.params.Line.threshold = 1.5;
  let down = null;
  renderer.domElement.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!down || !pickHandler) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y), dt = performance.now() - down.t;
    down = null;
    if (moved > 6 || dt > 600) return;
    const r = renderer.domElement.getBoundingClientRect();
    raycaster.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
    const plane = renderer.clippingPlanes[0];
    const shown = (o) => { for (let x = o; x; x = x.parent) if (!x.visible) return false; return true; };
    const ownerOf = (o) => { for (let x = o; x; x = x.parent) if (x.userData?.entity) return x; return null; };
    const hits = raycaster.intersectObjects([accepted, overlay].filter(Boolean), true)
      .filter((h) => !h.object.isSprite && shown(h.object) && (!plane || plane.distanceToPoint(h.point) >= 0))
      .map((h) => ownerOf(h.object)).filter(Boolean);
    const best = hits.find((o) => !o.userData.ref) ?? hits[0];
    pickHandler(best?.userData.entity ?? null);
  });

  return {
    // accepted: scene from the accepted model; proposal: overlay layer or null;
    // studio: { refParts, partColor, entityOf, instanceOf } for the app's studio style
    show(acceptedScene, proposalOverlay = null, studio = null) {
      if (accepted) scene.remove(accepted);
      if (overlay) scene.remove(overlay);
      accepted = buildGroup(acceptedScene, studio);
      scene.add(accepted);
      overlay = proposalOverlay ? buildGroup(proposalOverlay, studio) : null;
      if (overlay) scene.add(overlay);
      applyView();
      if (!framed) wholeView();
    },
    // view: { showReference, plane: {normal, constant} | null, offsets: {instance: [dx,dy,dz]}, selected }
    setView(next) { view = { ...view, ...next }; applyView(); },
    onPick(fn) { pickHandler = fn; },
    resize,
    frame(bounds) { framed = bounds; wholeView(); if (bounds) frameBounds(bounds); },
    whole() { framed = null; wholeView(); },
    view(name) { return setCameraPreset(name); },
    viewName() { return cameraPreset; },
  };
}
