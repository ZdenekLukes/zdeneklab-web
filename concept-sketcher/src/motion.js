// Generic motion declarations live on literal parameters in .aiconcept.
// This module owns validation and deterministic rigid poses, with no renderer dependency.
import { evalParams, num } from './model.js?v=82722beda481';

export function motionControls(model) {
  const { values } = evalParams(model.params);
  return Object.entries(model.params || {}).filter(([, p]) => p.motion).map(([id, p]) => ({
    ...p.motion, id, value: p.value, min: num(p.motion.min, values), max: num(p.motion.max, values),
  }));
}
export function motionDefinitionErrors(model, resolved) {
  const errors = [], drivers = new Set();
  const known = new Set([...(model.parts || []).map(p => p.id), ...(model.joints || []).map(j => j.id)]);
  const featureHost = (id, seen = new Set()) => {
    if (seen.has(id)) return null; seen.add(id);
    const f = (model.features || []).find(f => f.id === id);
    return f?.host || (f?.mirror ? featureHost(f.mirror.of, seen) : null);
  };
  for (const f of model.features || []) known.add(`${featureHost(f.id)}.${f.id}`);
  try {
    for (const c of motionControls(model)) {
      const E = text => errors.push(`motion ${c.id}: ${text}`);
      if (model.params[c.id].expr !== undefined) E('driver must be a literal parameter');
      if (!Number.isFinite(c.min) || !Number.isFinite(c.max) || c.min >= c.max) E('finite min < max required');
      if (!Number.isFinite(c.step) || c.step <= 0) E('step must be positive');
      if (!Number.isFinite(c.value) || c.value < c.min || c.value > c.max) E('default outside range');
      if (!['mm', 'deg'].includes(c.unit)) E('unit must be mm or deg');
      if (!c.about?.length || c.about.some(x => !known.has(x))) E('about must name existing parts, features or joints');
      if (c.joint) {
        const j = resolved?.joints?.[c.joint];
        if (drivers.has(c.joint)) E('joint already has a driver'); drivers.add(c.joint);
        if (!j?.axis || !['REVOLUTE', 'PRISMATIC'].includes(j.motion)) E('joint needs a resolved REVOLUTE or PRISMATIC axis');
        if (c.value !== 0) E('joint default must be zero (modelled pose)');
        if (j?.limits?.unit !== c.unit || !(c.min >= j?.limits?.min && c.max <= j?.limits?.max)) E('range must stay inside typed joint limits');
      }
    }
  } catch (e) { errors.push(`motion: ${e.message}`); }
  return errors;
}
const eye = () => [[1,0,0],[0,1,0],[0,0,1]];
const matvec = (r, x) => r.map(row => row.reduce((s,a,k) => s+a*x[k],0));
const plus = (a,b) => a.map((x,i) => x+b[i]);
function compose(a,b) {
  return { r: a.r.map(row => [0,1,2].map(k => row.reduce((s,x,i) => s+x*b.r[i][k],0))), t: plus(matvec(a.r,b.t),a.t) };
}
export function jointPoses(model, resolved, values) {
  const controls = motionControls(model);
  const poses = {}, active = new Set();
  const jointFor = Object.fromEntries((model.joints || []).map(j => [j.part,j]));
  function visit(part) {
    if (poses[part]) return poses[part];
    if (active.has(part)) throw new Error('motion joint dependency cycle');
    active.add(part);
    const authored = jointFor[part], joint = authored && resolved.joints[authored.id];
    const inherited = joint?.parent ? visit(joint.parent) : { r: eye(), t: [0,0,0] };
    let local = { r: eye(), t: [0,0,0] };
    const control = controls.find(c => c.joint && c.joint === authored?.id);
    if (control && values[control.id] !== 0) {
      const q = values[control.id], {point,dir} = joint.axis;
      const axis = [0,0,0]; axis['XYZ'.indexOf(dir[1])] = dir[0] === '-' ? -1 : 1;
      if (joint.motion === 'PRISMATIC') local.t = axis.map(x => x*q);
      else {
        const a = q*Math.PI/180, c = Math.cos(a), s = Math.sin(a), [x,y,z] = axis;
        local.r = [[c+x*x*(1-c),x*y*(1-c)-z*s,x*z*(1-c)+y*s],
          [y*x*(1-c)+z*s,c+y*y*(1-c),y*z*(1-c)-x*s],
          [z*x*(1-c)-y*s,z*y*(1-c)+x*s,c+z*z*(1-c)]];
        local.t = point.map((x,i) => x-matvec(local.r,point)[i]);
      }
    }
    active.delete(part);
    return poses[part] = compose(inherited,local);
  }
  for (const p of model.parts || []) visit(p.id);
  return poses;
}

// Invalid/out-of-range requests are rejected, never silently clamped.
export function motionValues(model, requested = {}) {
  const controls = motionControls(model), result = {};
  for (const id of Object.keys(requested)) if (!controls.some(c => c.id === id)) throw new Error(`unknown motion ${id}`);
  for (const c of controls) {
    const value = requested[c.id] ?? c.value;
    if (!Number.isFinite(value) || value < c.min || value > c.max) throw new Error(`motion ${c.id} outside ${c.min} … ${c.max}`);
    result[c.id] = value;
  }
  return result;
}
