// Parameter deformation uses the ordinary resolver and scene generator.
// Joint motion is a declared rigid pose applied to the same generated scene.
import { validate } from './validate.js?v=d776a80047f5';
import { buildScene } from './scene.js?v=d776a80047f5';
import { motionControls, motionValues, jointPoses } from './motion.js?v=d776a80047f5';

export function motionPreview(model, requested = {}) {
  const values = motionValues(model, requested);
  const params = Object.fromEntries(motionControls(model).filter(c => !c.joint).map(c => [c.id,values[c.id]]));
  const validation = validate(model, { params });
  if (!validation.resolved || validation.errors.length) throw new Error(validation.errors.join('; ') || 'motion did not resolve');
  const scene = buildScene(model, validation);
  const poses = jointPoses(model, validation.resolved, values);
  for (const item of [...scene.primitives, ...scene.arrows, ...(scene.labels || []), ...scene.markers]) {
    const part = item.part || item.instance?.replace(/@\d+$/, '') || item.id?.split(/[.#@]/)[0];
    const key = item.id?.split('#')[0];
    const joint = (model.joints || []).find(j => j.id === key);
    const fastener = (model.fasteners || []).find(f => f.id === key);
    const volume = (model.volumes || []).find(x => x.id === key);
    // Joint limits stay in the parent's frame; hardware and service volumes
    // follow their declared owner. No renderer-side relationship inference.
    const owner = joint ? validation.resolved.joints[joint.id]?.parent : fastener ? (model.joints || []).find(j => j.id === fastener.joint)?.part : volume ? volume.for.split('.')[0] : part;
    const pose = poses[owner];
    if (pose && (!pose.r.every((row,i) => row.every((x,k) => Math.abs(x-(i===k?1:0))<1e-12)) || pose.t.some(x => Math.abs(x)>1e-12))) item.pose = pose;
  }
  scene.motion = { values, demonstration: 'GEOMETRIC_ONLY' };
  return { scene, validation, values };
}
