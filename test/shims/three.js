// Real three.js, except for the only part that needs a GPU: a renderer that only counts frames.
export * from '../../node_modules/three/build/three.module.js';
export class WebGLRenderer {
  constructor() { this.capabilities = { maxTextureSize: 4096 }; this.frames = 0; }
  setClearColor() {}
  setPixelRatio() {}
  setSize() {}
  render() { this.frames++; }
  dispose() {}
  forceContextLoss() {}
}
