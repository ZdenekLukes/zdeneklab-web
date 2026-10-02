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

function buildGroup(data) {
  const group = new THREE.Group();
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
      mesh = new THREE.Mesh(new THREE.BoxGeometry(...p.size), material(p.style));
      mesh.position.set(...p.center);
      edges(mesh, p.style, p.style === 'proposed' && (p.unresolved || []).length > 0);
    } else if (p.shape === 'cylinder') {
      const mat = p.role === 'fastener' && p.style === 'produced' ? new THREE.MeshLambertMaterial({ color: ROLE_COLORS.fastener }) : material(p.style);
      mesh = new THREE.Mesh(new THREE.CylinderGeometry(p.d / 2, p.d / 2, p.length, 32), mat);
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...AX[p.axis]));
      mesh.position.set(...p.center);
      edges(mesh, p.style, p.style === 'proposed' && (p.unresolved || []).length > 0);
    } else if (p.shape === 'polyline') {
      const dashed = p.role === 'axis' || p.style === 'unresolved';
      mesh = new THREE.Line(new THREE.BufferGeometry().setFromPoints(p.points.map((v) => new THREE.Vector3(...v))),
        dashed ? new THREE.LineDashedMaterial({ color: lineColor(p), dashSize: 3, gapSize: 2 }) : new THREE.LineBasicMaterial({ color: lineColor(p) }));
      mesh.computeLineDistances();
    } else if (p.shape === 'ring') {
      const ri = p.inner_d / 2, ro = p.outer_d / 2, h = p.length;
      const prof = [new THREE.Vector2(ri, -h / 2), new THREE.Vector2(ro, -h / 2), new THREE.Vector2(ro, h / 2), new THREE.Vector2(ri, h / 2), new THREE.Vector2(ri, -h / 2)];
      mesh = new THREE.Mesh(new THREE.LatheGeometry(prof, 20), p.role === 'hole' && p.style === 'produced' ? new THREE.MeshLambertMaterial({ color: ROLE_COLORS.hole }) : material(p.style));
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...AX[p.axis]));
      mesh.position.set(...p.center);
    } else if (p.shape === 'zigzag') {
      const color = { unresolved: STYLE_COLORS.unresolved, proposed: STYLE_COLORS.proposed, removed: STYLE_COLORS.removed }[p.style] ?? 0x1d6b3a;
      mesh = new THREE.Line(new THREE.BufferGeometry().setFromPoints(p.points.map((v) => new THREE.Vector3(...v))), new THREE.LineBasicMaterial({ color }));
    }
    if (mesh) group.add(mesh);
  }
  for (const l of data.labels || []) {
    const t = label(l.text, '#3b4252');
    t.position.set(...l.at);
    group.add(t);
  }
  for (const a of data.arrows || []) {
    const color = { unresolved: STYLE_COLORS.unresolved, proposed: STYLE_COLORS.proposed, removed: STYLE_COLORS.removed }[a.style] ?? 0x1d6b3a;
    group.add(new THREE.ArrowHelper(new THREE.Vector3(...DIR[a.dir]), new THREE.Vector3(...a.from), a.length, color, 4, 2.5));
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
    group.add(t);
  }
  // one OPEN badge per state (accepted / proposed), listing its questions
  for (const style of ['accepted', 'proposed']) {
    const ms = (data.markers || []).filter((m) => (m.style === 'proposed') === (style === 'proposed'));
    if (!ms.length) continue;
    const s = label(`? ${ms.map((m) => (m.status === 'STATED' ? `${m.question}(stated)` : m.question)).join(' ')}${style === 'proposed' ? ' new' : ' OPEN'}`, '#e8730c');
    s.position.set(ms[0].at[0], ms[0].at[1], ms[0].at[2] + (style === 'proposed' ? 22 : 0));
    group.add(s);
  }
  return group;
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

  const HOME_DIR = new THREE.Vector3(260, -360, 260).normalize();
  function wholeView() {
    controls.target.set(0, 0, 20);
    camera.position.copy(HOME_DIR).multiplyScalar(500);
    if (accepted) {                              // frame the accepted geometry from the home direction
      const sphere = new THREE.Box3().setFromObject(accepted).getBoundingSphere(new THREE.Sphere());
      if (Number.isFinite(sphere.radius) && sphere.radius > 0) frameBounds({ center: sphere.center.toArray(), radius: sphere.radius * 0.9 });
    }
  }
  // Inspection only: move the camera so the given bounds fill the view.
  function frameBounds(b) {
    const dir = HOME_DIR.clone();
    const vfov = (camera.fov * Math.PI) / 180;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
    const dist = (b.radius * 1.15) / Math.sin(Math.min(vfov, hfov) / 2);
    controls.target.set(...b.center);
    camera.position.copy(controls.target.clone().add(dir.multiplyScalar(dist)));
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

  return {
    // accepted: scene from the accepted model; proposal: overlay layer or null
    show(acceptedScene, proposalOverlay = null) {
      if (accepted) scene.remove(accepted);
      if (overlay) scene.remove(overlay);
      accepted = buildGroup(acceptedScene);
      scene.add(accepted);
      overlay = proposalOverlay ? buildGroup(proposalOverlay) : null;
      if (overlay) scene.add(overlay);
      if (!framed) wholeView();
    },
    resize,
    frame(bounds) { framed = bounds; wholeView(); if (bounds) frameBounds(bounds); },
    whole() { framed = null; wholeView(); },
  };
}
