import { Vector3 } from '../../node_modules/three/build/three.module.js';
// Orbit controls without the DOM: it looks at its target and reports the polar angle, as the real one does.
export class OrbitControls {
  constructor(object) { this.object = object; this.target = new Vector3(); this.mouseButtons = {}; }
  addEventListener() {}
  update() { this.object.lookAt(this.target); this.object.updateMatrixWorld(true); }
  getPolarAngle() { const v = this.object.position.clone().sub(this.target); return Math.acos(v.y / v.length()); }
  dispose() {}
}
