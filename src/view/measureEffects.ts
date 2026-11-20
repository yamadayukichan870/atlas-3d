import * as THREE from 'three';
import type { PlanRing } from '../terrain/measureGeometry';
import type { Layout } from '../terrain/layout';

/**
 * Atlas' own animated area effects, ported to three.js.
 *
 * Verified against atlas-vtt/atlas-vtt @ tag 0.16.0:
 *   measure/measureEffects.ts             -> the six looks, colours, light, darkness
 *   pixi/measure/effects/effectShader.ts  -> EFFECT_CODE, uniforms, normal blending,
 *                                            premultiplied colour that may exceed alpha
 *   pixi/measure/effects/effectMotion.ts  -> per-effect drifts, EffectClock
 *   pixi/liquids/liquidMotion.ts          -> MOTION_LOOP = 4096, PATTERN_TILE = 64
 *   pixi/liquids/glsl/noiseGlsl.ts        -> hash / gnoise / fbm / voronoi / spark
 *   pixi/measure/effects/glsl/*.ts        -> fire / frost / lightning / mist / radiance / shadow
 *   pixi/measure/AreaBody.ts              -> the effect REPLACES the wash only; the cell tint
 *                                            (0.16) and the outline (0.9) still draw over it
 *   pixi/measure/effects/MeasureEffectMesh.ts -> "a mesh of exactly the area's polygon";
 *                                            nothing draws past the outline
 *
 * So the fill here is built by TRIANGULATING THE AREA'S OUTLINE RINGS, exactly as Atlas
 * triangulates its polygon — not from the covered cells. That makes it clipped to the outline by
 * construction: it cannot bleed past the border the way a per-cell fill with a soft feather did.
 * The distance-to-outline (`aEdge`) and the way-in (`aInward`) are baked per vertex, standing in
 * for Atlas' distance-field texture.
 *
 * The caller (TacticalOverlays) draws this UNDER the cell tint and the outline, and draws no wash
 * and no volume shell while an effect is present — the same layering AreaBody uses.
 */

export type MeasureEffect = 'fire' | 'frost' | 'lightning' | 'mist' | 'radiance' | 'shadow';
export const MEASURE_EFFECTS: readonly MeasureEffect[] = ['fire', 'frost', 'lightning', 'mist', 'radiance', 'shadow'];
export const EFFECT_CODE: Readonly<Record<MeasureEffect, number>> = { fire: 0, frost: 1, lightning: 2, mist: 3, radiance: 4, shadow: 5 };
export const MEASURE_EFFECT_STARTS: Readonly<Record<MeasureEffect, { color: string; light: 'flicker' | 'steady' | null; darkness: boolean }>> = {
  fire: { color: '#ec7500', light: 'flicker', darkness: false },
  frost: { color: '#8ad1f8', light: null, darkness: false },
  lightning: { color: '#086ddd', light: 'flicker', darkness: false },
  mist: { color: '#ffffff', light: null, darkness: false },
  radiance: { color: '#e0ac00', light: 'steady', darkness: false },
  shadow: { color: '#7852ee', light: null, darkness: true },
};
export function readMeasureEffect(value: unknown): MeasureEffect | undefined {
  return MEASURE_EFFECTS.find((e) => e === value);
}

const MOTION_LOOP = 4096;
const PATTERN_TILE = 64;
const wrap = (v: number, p: number): number => v - Math.floor(v / p) * p;
export const loopTime = (seconds: number): number => wrap(seconds, MOTION_LOOP);

const DRIFTS: Readonly<Record<MeasureEffect, readonly [number, number, number, number, number, number, number, number]>> = {
  fire: [0, -0.32, 0, -0.66, 0.03, -0.13, 0.02, -0.45],
  frost: [0.022, 0.012, -0.015, 0.02, 0, 0, 0, 0],
  lightning: [0.03, -0.02, 0, 0, 0, 0, 0, 0],
  mist: [0.085, 0.028, -0.05, 0.07, 0.03, -0.06, 0, 0],
  radiance: [0.012, -0.03, 0, 0, 0, 0, 0, 0],
  shadow: [0.045, 0.06, -0.06, 0.02, 0.05, -0.09, 0, 0],
};
export function effectDrifts(effect: MeasureEffect, seconds: number): Float32Array {
  const out = new Float32Array(8);
  const d = DRIFTS[effect];
  for (let i = 0; i < 8; i++) out[i] = wrap(d[i]! * seconds, PATTERN_TILE);
  return out;
}

const NOISE_GLSL = `
const float LOOP = ${MOTION_LOOP.toFixed(1)};
const float TILE = ${PATTERN_TILE.toFixed(1)};
const float TAU = 6.28318530718;
float cycles(float k){ return fract(uTime * (k / LOOP)); }
vec2 hash22(vec2 p){ vec3 p3=fract(vec3(p.xyx)*vec3(0.1031,0.1030,0.0973)); p3+=dot(p3,p3.yzx+33.33); return fract((p3.xx+p3.yz)*p3.zy); }
vec4 hash42(vec2 p){ vec4 p4=fract(vec4(p.xyxy)*vec4(0.1031,0.1030,0.0973,0.1099)); p4+=dot(p4,p4.wzxy+33.33); return fract((p4.xxyz+p4.yzzw)*p4.zywx); }
float shown(float wave,float px){ return 1.0-smoothstep(0.25,0.5,px/wave); }
float gnoise(vec2 p,vec2 period){ vec2 i=floor(p); vec2 f=p-i; vec2 u=f*f*f*(f*(f*6.0-15.0)+10.0);
  vec2 i0=mod(i,period)+uSeed; vec2 i1=mod(i+1.0,period)+uSeed;
  float a=dot(hash22(i0)*2.0-1.0,f); float b=dot(hash22(vec2(i1.x,i0.y))*2.0-1.0,f-vec2(1,0));
  float c=dot(hash22(vec2(i0.x,i1.y))*2.0-1.0,f-vec2(0,1)); float d=dot(hash22(i1)*2.0-1.0,f-vec2(1,1));
  return mix(mix(a,b,u.x),mix(c,d,u.x),u.y); }
float fbm(vec2 p,vec2 period,int octaves,float px){ float sum=0.0; float amp=0.5;
  for(int o=0;o<5;o++){ float vis=shown(1.0,px); if(o>=octaves||vis<=0.0)break;
    sum+=amp*vis*gnoise(p,period); p=p*2.0+vec2(13,7); period*=2.0; px*=2.0; amp*=0.5; } return sum; }
vec2 cellPoint(vec4 h,float churn){ float turns=floor(1.0+h.z*2.0); float phase=TAU*(cycles(turns)+h.w);
  return 0.15+0.7*h.xy+churn*vec2(sin(phase),cos(phase+h.z*TAU)); }
vec3 voronoiFast(vec2 p,vec2 period,float churn){ vec2 i=floor(p); vec2 f=p-i; float f1=8.0; float f2=8.0; float id=0.0;
  for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){ vec2 cell=vec2(float(x),float(y));
    vec4 h=hash42(mod(i+cell,period)+uSeed); vec2 r=cell+cellPoint(h,churn)-f; float dist=dot(r,r);
    if(dist<f1){f2=f1;f1=dist;id=h.w;} else if(dist<f2){f2=dist;} }
  f1=sqrt(f1); return vec3(f1,(sqrt(f2)-f1)*0.5,id); }
`;
const EFFECT_GLSL = `
float hash11(float p){ p=fract(p*0.1031); p*=p+33.33; p*=p+p; return fract(p); }
float lineNoise(float x){ float i=floor(x); float f=x-i; return mix(hash11(i),hash11(i+1.0),f*f*(3.0-2.0*f))-0.5; }
float ringNoise(float x,float count,float salt){ float i=floor(x); float f=x-i;
  return mix(hash11(mod(i,count)+salt),hash11(mod(i+1.0,count)+salt),f*f*(3.0-2.0*f))-0.5; }
vec3 lifted(float share){ return mix(uTint,vec3(1.0),share); }
vec3 deepened(float power){ return pow(max(uTint,vec3(0.0)),vec3(power)); }
float inward(float d,float within){ return smoothstep(0.0,min(within,uDepth),d); }
vec4 spark(vec2 q,float gap,float pace,float span){ vec2 g=q/gap; vec2 i=floor(g);
  vec2 site=mod(i,TILE/gap)+uSeed; vec4 h=hash42(site+3.7); float k=pace+floor(h.x*span);
  float turn=uTime*(k/LOOP)+h.y; float born=mod(floor(turn),k);
  vec2 at=0.22+0.56*hash22(site+born*vec2(0.37,0.71)); return vec4((g-i-at)*gap,fract(turn),h.z); }
`;
const FIRE_GLSL = `
vec4 fireTurns(float one,float other){ float a=TAU*cycles(one); float b=-TAU*cycles(other); return vec4(cos(a),sin(a),cos(b),sin(b)); }
vec4 fireDoubled(vec4 t){ return vec4(t.x*t.x-t.y*t.y,2.0*t.x*t.y,t.z*t.z-t.w*t.w,2.0*t.z*t.w); }
float fireCorner(vec2 cell,vec2 f,vec4 turns){ vec2 g=hash22(cell)*2.0-1.0; vec2 t=g.x*g.y>0.0?turns.xy:turns.zw;
  return dot(vec2(g.x*t.x-g.y*t.y,g.x*t.y+g.y*t.x),f); }
float fireNoise(vec2 p,vec2 period,vec4 turns){ vec2 i=floor(p); vec2 f=p-i; vec2 u=f*f*f*(f*(f*6.0-15.0)+10.0);
  vec2 i0=mod(i,period)+uSeed; vec2 i1=mod(i+1.0,period)+uSeed;
  float a=fireCorner(i0,f,turns); float b=fireCorner(vec2(i1.x,i0.y),f-vec2(1,0),turns);
  float c=fireCorner(vec2(i0.x,i1.y),f-vec2(0,1),turns); float d=fireCorner(i1,f-vec2(1,1),turns);
  return mix(mix(a,b,u.x),mix(c,d,u.x),u.y); }
float fireFbm(vec2 p,vec2 period,int octaves,float px,vec4 turns){ float sum=0.0; float amp=0.5;
  for(int o=0;o<3;o++){ if(o>=octaves)break; sum+=amp*shown(1.0,px)*fireNoise(p,period,turns);
    p=p*2.0+vec2(13,7); period*=2.0; px*=2.0; turns=fireDoubled(turns); amp*=0.5; } return sum; }
float embers(vec2 p,float px){ vec4 s=spark(p-uDriftB.zw,0.4,1100.0,900.0); if(s.w>0.4)return 0.0;
  float life=smoothstep(0.0,0.08,s.z)*(1.0-smoothstep(0.3,0.75,s.z)); float size=0.022+0.02*s.w;
  return life*(1.0-smoothstep(size*0.3,size,length(s.xy)))*shown(0.08,px); }
vec4 fire(vec2 p,float d,float px){
  int octaves=uDetail>1.5?3:2;
  vec4 slow=fireTurns(260.0,180.0); vec4 steady=fireTurns(700.0,500.0); vec4 quick=fireDoubled(fireDoubled(steady));
  vec2 a=(p-uDriftB.xy)*0.75;
  vec2 bend=vec2(fireNoise(a,vec2(TILE*0.75),slow),fireNoise(a+19.7,vec2(TILE*0.75),slow));
  vec2 q=p+bend*0.7;
  float body=fireFbm((q-uDriftA.xy*0.25)*1.25,vec2(TILE*0.25*1.25),octaves,px*1.25,steady);
  vec2 l=(q-uDriftA.xy*0.5)*2.5+body*0.9;
  float lick=fireNoise(l,vec2(TILE*0.5*2.5),quick);
  if(uDetail>1.5) lick+=0.3*shown(0.2,px)*fireNoise(l*2.0+5.3,vec2(TILE*0.5*5.0),fireDoubled(quick));
  float ridge=max(1.0-abs(lick)*2.6,0.0); ridge=ridge*ridge*shown(0.4,px);
  float rim=min(0.5,uDepth*0.85);
  float edge=smoothstep(0.0,rim,d+(body*1.1+lick*0.4)*rim);
  float heart=inward(d,1.4);
  float narrow=1.0-smoothstep(0.45,1.1,uDepth);
  float level=body*1.7+ridge*(0.1+0.2*narrow)+0.36-0.22*heart+0.26*narrow;
  float flame=smoothstep(-0.1,0.7,level);
  float heat=flame*(0.2+0.8*edge)*edge*(0.74+0.26*ridge)*(1.0-0.2*narrow*(1.0-ridge));
  vec3 charred=deepened(2.4)*0.16; vec3 red=deepened(2.0)*0.8;
  vec3 bright=mix(deepened(0.45),vec3(1.0),0.22); vec3 white=mix(deepened(0.3),vec3(1.0),0.72);
  vec3 colour=mix(mix(charred,red,0.6),red,smoothstep(0.0,0.2,heat));
  colour=mix(colour,uTint,smoothstep(0.16,0.44,heat));
  colour=mix(colour,bright,smoothstep(0.44,0.76,heat));
  colour=mix(colour,white,smoothstep(0.8,1.0,heat));
  float flames=smoothstep(0.0,0.34,heat)*(0.72+0.2*smoothstep(0.4,0.85,heat));
  float within=inward(d,0.3); float close=smoothstep(-0.75,0.15,level);
  vec3 ember=mix(red,uTint,0.55); float bed=within*(0.08+0.2*close);
  float soot=within*clamp(0.4-body*1.6,0.0,1.0)*0.26;
  vec4 under=vec4(ember*bed*(1.0-soot)+charred*soot,bed+soot*(1.0-bed));
  float smoulder=smoothstep(-0.25,0.3,body+lick*0.5);
  float brink=smoothstep(0.0,0.045,d)*(1.0-smoothstep(0.05,0.1+0.1*smoulder,d))*(0.15+0.85*smoulder);
  under=under*(1.0-brink*0.6)+vec4(mix(red,uTint,smoulder)*brink*0.6,brink*0.6);
  vec4 lit=under*(1.0-flames)+vec4(colour*flames,flames);
  lit.rgb+=colour*0.3*heat*heat+ember*(bed*0.3+brink*0.35*(1.0-flames));
  float sparks=uDetail>0.5?embers(p,px)*smoothstep(0.0,0.1,d):0.0;
  lit+=vec4(bright*sparks,sparks*0.7);
  return lit; }
`;
const FROST_GLSL = `
float glint(vec2 p,float px){ vec4 s=spark(p,0.8,900.0,1100.0); if(s.w>0.5)return 0.0;
  float life=smoothstep(0.0,0.12,s.z)*(1.0-smoothstep(0.16,0.42,s.z));
  float reach=(0.05+0.05*s.w)*(0.5+0.5*life); vec2 a=abs(s.xy);
  float arms=max(0.0,1.0-a.x/reach)*max(0.0,1.0-a.y/(reach*0.12+px));
  arms+=max(0.0,1.0-a.y/reach)*max(0.0,1.0-a.x/(reach*0.12+px));
  float heart=1.0-smoothstep(0.0,reach*0.25+px,length(s.xy));
  return life*min(1.0,arms*arms+heart)*shown(0.05,px); }
vec2 frostInward(){ return vIn; }
vec4 frostOver(vec4 under,vec3 colour,float cover){ return under*(1.0-cover)+vec4(colour*cover,cover); }
vec4 frost(vec2 p,float d,float px){
  int octaves=uDetail>1.5?3:2; bool rich=uDetail>0.5; int soft=rich?2:1;
  float breath=fbm((p-uDriftA.xy)*0.75,vec2(TILE*0.75),octaves,px*0.75);
  vec2 m=p*1.1; vec2 lie=vec2(gnoise(m+7.0,vec2(8192.0)),gnoise(m+41.0,vec2(8192.0)));
  float grain=gnoise(p*30.0,vec2(8192.0))*shown(0.033,px);
  float reach=min(0.6,uDepth*0.8)*(0.6+0.65*clamp(0.5+lie.x*1.3+breath*0.9,0.0,1.0));
  float crystal=0.0; float clump=0.0;
  if(d<reach*1.7){ vec2 way=frostInward(); vec2 foot=p-way*d;
    clump=gnoise(foot*3.1+way*5.0+17.0,vec2(8192.0));
    vec2 root=foot+vec2(-way.y,way.x)*d*clump*1.6;
    crystal=gnoise(root*10.0+way*(d*1.6+3.0),vec2(8192.0))*shown(0.1,px);
    if(rich) crystal=crystal*0.8+0.45*gnoise(root*23.0+way*(d*2.4+9.0),vec2(8192.0))*shown(0.043,px); }
  float len=min(reach*clamp(0.85+clump*2.0,0.45,1.35),uDepth*0.62);
  float along=d/len;
  float crust=smoothstep(0.0,0.75,1.0-along/0.55+crystal*0.7)*(0.84+grain*0.5);
  float lean=mix(-0.08,0.34,along);
  float tips=smoothstep(lean,lean+0.3,crystal)*(1.0-smoothstep(0.3,0.92,along))*(0.5+0.5*smoothstep(-0.2,0.25,lie.y-clump));
  float white=max(crust,tips*0.85);
  float bite=min(1.0,uDepth*1.4)*(0.07*clamp(0.4-clump*1.5-lie.y,0.0,1.0)+0.02*clamp(0.5-crystal*2.0,0.0,1.0));
  float within=smoothstep(bite,bite+0.05,d);
  vec2 bent=p+lie*0.4;
  float cloud=fbm(bent*0.7+3.0,vec2(8192.0),soft,px*0.7);
  float bloom=smoothstep(-0.1,0.26,cloud)*(0.85+grain*0.22);
  float band=0.5+0.5*sin(TAU*(dot(p,vec2(0.23,0.14))+breath*0.8+lie.x*0.5-cycles(410.0)));
  float sheen=band*band*band*band;
  vec3 net=voronoiFast(bent*0.875+11.0,vec2(TILE*0.875),0.0);
  float seam=net.y/0.875; float open=smoothstep(0.0,0.22,lie.y+cloud*0.6);
  float hair=open*(1.0-smoothstep(0.003+px*0.5,0.007+px*1.3,seam));
  float plane=open*step(0.5,net.z)*(1.0-smoothstep(0.0,0.1,seam))*shown(0.1,px);
  vec3 clear=deepened(2.4)*0.74; vec3 milk=lifted(0.72);
  vec4 lit=vec4(clear,1.0)*(0.3+0.36*(1.0-smoothstep(0.3,1.3,d/reach)));
  lit=frostOver(lit,milk,bloom*(0.36+0.3*sheen)+sheen*0.06);
  lit=frostOver(lit,milk,plane*0.4);
  lit=frostOver(lit,deepened(3.0)*0.4,hair*0.7);
  lit=frostOver(lit,lifted(0.94),white*0.94);
  lit*=within;
  float veil=fbm((p-uDriftA.zw*4.0)*0.5+9.0,vec2(TILE*0.5),soft,px*0.5);
  float haze=within*smoothstep(0.0,0.45,veil+0.12)*0.16;
  lit=frostOver(lit,lifted(0.8),haze);
  float star=rich?glint(p,px)*within:0.0;
  lit+=vec4(vec3(1.0)*star*0.9,star*0.5);
  return lit; }
`;
const LIGHTNING_GLSL = `
const float STRIKE_JUMPS=4.0;
float narrowness(){ return clamp((TAU*0.5-uSpread)/(TAU*0.5-0.2),0.0,1.0); }
vec2 arcs(vec2 p,float px,float gap,float share,float pace,float forked){
  vec2 axis=uFrame.zw; vec2 rel=p-uFrame.xy;
  float narrow=narrowness(); float jumps=STRIKE_JUMPS*(1.0+narrow);
  float room=clamp(uDepth/0.9,0.4,1.0);
  vec2 g=vec2(dot(rel,vec2(-axis.y,axis.x)),dot(rel,axis))/gap;
  vec2 home=floor(g+0.5); vec2 lit=vec2(0.0);
  for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){
    vec2 id=home+vec2(float(x),float(y)); vec4 h=hash42(id+uSeed+gap*211.0);
    float cyclesALoop=pace+floor(h.x*pace); float turn=uTime*(cyclesALoop/LOOP)+h.y;
    float phase=fract(turn); float strike=mod(floor(turn),cyclesALoop);
    if(uStill>0.5){ phase=h.z<0.45?share*0.3:1.0; strike=0.0; }
    if(phase>=share)continue;
    float life=phase/share; float jump=floor(life*jumps);
    vec4 e=hash42(id*7.31+strike*vec2(0.731,0.377)+uSeed);
    float lean=(e.x-0.5)*uSpread; vec2 way=vec2(cos(lean),sin(lean));
    vec2 at=(g-id-(e.yz-0.5)*vec2(0.7*clamp(uSpread/(TAU*0.5),0.1,1.0),0.7))*gap;
    float along=dot(at,vec2(way.y,way.x)); float across=dot(at,vec2(way.x,-way.y));
    float span=gap*(0.75+0.5*e.w)*(1.0+0.5*narrow);
    float taper=1.0-smoothstep(span*0.5,span,abs(along)); if(taper<=0.0)continue;
    float salt=e.w*91.0+strike;
    float broad=lineNoise(along*2.6/gap+salt)*0.23*gap*room;
    float bend=broad+lineNoise(along*3.7+salt+jump*17.0)*0.2+lineNoise(along*9.0+salt+jump*29.0)*0.07;
    float flare=(0.6+0.4*hash11(jump*3.1+salt))*(1.0-life*life*life);
    float off=abs(across-bend); float width=0.012+px*0.8;
    lit.x+=flare*taper*(1.0-smoothstep(width*0.5,width*1.6,off));
    lit.y+=flare*taper*(exp(-off/0.07)*0.9+exp(-off/0.4)*0.14);
    if(forked<0.5)continue;
    float from=(e.y-0.5)*span*0.8; float past=along-from; float reach=span*(0.35+0.3*e.z);
    if(past>0.0&&past<reach){ float side=e.z<0.5?-0.62:0.62;
      float root=lineNoise(from*2.6/gap+salt)*0.23*gap*room+lineNoise(from*3.7+salt+jump*17.0)*0.2;
      float fork=root+past*side+lineNoise(past*4.5+salt+jump*13.0)*0.16*smoothstep(0.0,0.3,past);
      float forkOff=abs(across-fork)*0.85; float thin=flare*(1.0-past/reach);
      lit.x+=thin*0.8*(1.0-smoothstep(width*0.4,width*1.3,forkOff));
      lit.y+=thin*exp(-forkOff/0.05)*0.6; } }
  return lit; }
vec4 lightning(vec2 p,float d,float px){
  float narrow=narrowness();
  vec2 arc=arcs(p,px,2.4,mix(0.42,0.72,narrow),1500.0,uDetail);
  if(uDetail>0.5) arc+=arcs(p+7.3,px,1.2,mix(0.3,0.45,narrow),2300.0,0.0)*vec2(0.95,0.7);
  float cloud=0.5+gnoise((p-uDriftA.xy)*0.75,vec2(TILE*0.75));
  float within=inward(d,0.45);
  float charged=within*(0.04+0.11*cloud*cloud);
  float halo=min(arc.y,1.0)*(0.3+0.7*inward(d,0.3));
  float heart=min(arc.x,1.0);
  float alpha=min(charged+halo*0.62+heart*0.4,0.95);
  vec3 colour=deepened(1.3)*0.5*charged+uTint*charged*0.3+mix(uTint,lifted(0.25),halo*halo)*halo*0.85+lifted(0.9)*heart;
  return vec4(colour,alpha); }
`;
const MIST_GLSL = `
vec4 mist(vec2 p,float d,float px){
  int octaves=uDetail>1.5?3:2; vec2 roll=vec2(0.0);
  if(uDetail>0.5){ vec2 r=(p-uDriftB.xy)*0.5; roll=vec2(gnoise(r,vec2(TILE*0.5)),gnoise(r+31.7,vec2(TILE*0.5))); }
  float near=fbm((p-uDriftA.xy)*0.5+roll*0.6,vec2(TILE*0.5),octaves,px*0.5);
  float far=fbm((p-uDriftA.zw)-roll*0.5+17.0,vec2(TILE),octaves,px);
  float bank=clamp(0.5+near*1.1+far*0.5,0.0,1.0);
  float thin=smoothstep(0.0,min(0.8,uDepth),d+(bank-0.55)*0.35);
  float alpha=thin*(0.31+0.19*smoothstep(0.1,0.9,bank));
  vec3 colour=mix(uTint*vec3(0.38,0.42,0.5),lifted(0.3)*0.96,smoothstep(0.15,0.85,bank));
  return vec4(colour*alpha,alpha); }
`;
const RADIANCE_GLSL = `
vec4 radiance(vec2 p,float d,float px){
  float r=length(p); float turn=atan(p.y,p.x)/TAU;
  float arc=px/max(r*TAU,1e-4);
  float broad=ringNoise((turn+cycles(30.0))*9.0,9.0,uSeed.x)*shown(1.0/9.0,arc);
  float fine=ringNoise((turn-cycles(47.0))*22.0,22.0,uSeed.y)*shown(1.0/22.0,arc);
  float third=uDetail>0.5?ringNoise((turn+cycles(71.0))*37.0,37.0,uSeed.x+91.0)*shown(1.0/37.0,arc):0.0;
  float rays=smoothstep(0.25,0.88,0.5+broad*0.85+fine*0.8+third*0.5);
  float far=clamp(r/uReach,0.0,1.0); float fall=1.0-smoothstep(0.1,1.05,far);
  float heart=exp(-far*far*14.0);
  float light=clamp(rays*(0.2+0.8*fall)*smoothstep(0.02,0.16,far)+heart*0.5,0.0,1.0);
  float within=inward(d,0.5);
  float alpha=within*(0.05+0.29*light);
  vec3 colour=mix(uTint,lifted(0.35),light*light);
  vec4 lit=vec4(colour*alpha+lifted(0.5)*within*(0.03+0.3*light*light),alpha);
  if(uDetail>0.5){ vec4 s=spark(p-uDriftA.xy,0.64,700.0,700.0);
    float life=smoothstep(0.0,0.25,s.z)*(1.0-smoothstep(0.45,0.9,s.z));
    float size=0.022+0.02*s.w;
    float mote=s.w<0.7?within*life*(1.0-smoothstep(size*0.3,size,length(s.xy)))*shown(0.08,px):0.0;
    lit+=vec4(lifted(0.8)*mote*0.8,mote*0.4); }
  return lit; }
`;
const SHADOW_GLSL = `
vec4 shadow(vec2 p,float d,float px){
  float middle=inward(d,1.4); float within=inward(d,0.35);
  int octaves=uDetail>1.5?3:2;
  vec2 c=(p-uDriftA.xy)*0.5;
  vec2 curl=vec2(gnoise(c,vec2(TILE*0.5)),gnoise(c+23.1,vec2(TILE*0.5)));
  vec2 swirled=p+vec2(-curl.y,curl.x)*1.5;
  float dark=fbm((swirled-uDriftA.zw)*0.875,vec2(TILE*0.875),octaves,px*0.875);
  float wisp=0.0;
  if(uDetail>0.5){ float line=gnoise((swirled-uDriftB.xy)*1.5+curl*1.2,vec2(TILE*1.5));
    wisp=pow(max(1.0-abs(line)*2.6,0.0),2.0)*shown(0.3,px); }
  float thick=smoothstep(0.1,0.85,middle*0.6+dark*1.2+0.2);
  float density=within*max(thick,wisp*(0.7-0.35*middle)*smoothstep(0.2,0.75,0.55+dark+middle*0.3));
  float alpha=density*(0.62+0.16*clamp(0.5+dark*1.4,0.0,1.0));
  float rim=(1.0-middle)*(density*(1.0-density)*4.0*0.16+within*wisp*(1.0-thick)*0.1);
  vec3 colour=deepened(1.5)*0.05*alpha+uTint*rim;
  return vec4(colour,alpha); }
`;

const VERTEX = `
attribute float aEdge;
attribute vec2 aInward;
uniform vec2 uShift;
uniform float uCell;
varying vec2 vP;
varying float vD;
varying vec2 vIn;
void main(){
  vP = (position.xz + uShift) / uCell;
  vD = aEdge;
  vIn = aInward;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const FRAGMENT = `
precision highp float;
uniform float uTime, uCell, uEffect, uDepth, uSpread, uReach, uDetail, uStill;
uniform vec3 uTint;
uniform vec2 uSeed;
uniform vec4 uFrame, uDriftA, uDriftB;
varying vec2 vP;
varying float vD;
varying vec2 vIn;
${NOISE_GLSL}
${EFFECT_GLSL}
${FIRE_GLSL}
${FROST_GLSL}
${LIGHTNING_GLSL}
${MIST_GLSL}
${RADIANCE_GLSL}
${SHADOW_GLSL}
float edgeDistance(){ return vD; }
void main(){
  vec2 p = vP;
  float px = max(length(fwidth(p)) * 0.7071, 1e-5);
  float d = edgeDistance();
  float feather = smoothstep(0.0, max(0.06, px * 1.5), d);
  if (feather <= 0.0) discard;
  vec4 colour = uEffect < 0.5 ? fire(p, d, px)
    : uEffect < 1.5 ? frost(p, d, px)
    : uEffect < 2.5 ? lightning(p, d, px)
    : uEffect < 3.5 ? mist(p, d, px)
    : uEffect < 4.5 ? radiance(p, d, px)
    : shadow(p, d, px);
  gl_FragColor = colour * feather;
}`;

export interface EffectFill {
  readonly group: THREE.Group;
  setTime(seconds: number): void;
  dispose(): void;
}
export interface EffectFillOptions {
  readonly effect: MeasureEffect;
  readonly color: string;
  readonly layout: Layout;
  readonly origin: { x: number; z: number };
  readonly reach: number;
  readonly towards?: { x: number; z: number };
  readonly spread?: number;
  readonly depth?: number;
  /** The height the fill lies at (the surface it is painted on). */
  readonly baseY?: number;
}

function distToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  const t = l2 === 0 ? 0 : Math.min(1, Math.max(0, ((px - ax) * dx + (pz - az) * dz) / l2));
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

/**
 * The animated body of one area, as a mesh of EXACTLY its outline polygon (Atlas'
 * MeasureEffectMesh), triangulated with ear-clipping so a stepped or reflex ring is filled
 * correctly and nothing lies past the border. `aEdge` is the distance to the outline (0 on it),
 * `aInward` the way into the area, standing in for Atlas' distance-field texture.
 */
export function buildEffectFill(rings: readonly PlanRing[], opts: EffectFillOptions): EffectFill | null {
  const usable = rings.filter((r) => r.length > 2);
  if (usable.length === 0) return null;
  const contour = usable[0]!;
  const holes = usable.slice(1);
  const toV2 = (r: PlanRing): THREE.Vector2[] => r.map((p) => new THREE.Vector2(p.x, p.z));
  let tris: number[][];
  try {
    tris = THREE.ShapeUtils.triangulateShape(toV2(contour), holes.map(toV2));
  } catch {
    return null;
  }
  if (tris.length === 0) return null;

  // All boundary edges, for the per-vertex distance and way-in.
  const edges: { ax: number; az: number; bx: number; bz: number }[] = [];
  for (const r of usable) {
    for (let i = 0; i < r.length; i++) {
      const a = r[i]!, b = r[(i + 1) % r.length]!;
      edges.push({ ax: a.x, az: a.z, bx: b.x, bz: b.z });
    }
  }
  let cx = 0, cz = 0;
  for (const p of contour) { cx += p.x; cz += p.z; }
  cx /= contour.length; cz /= contour.length;

  const baseY = opts.baseY ?? 0;
  const pos: number[] = []; const edge: number[] = []; const inward: number[] = [];
  let depth = 0;
  const push = (p: { x: number; z: number }): void => {
    let best = Infinity; let bx = p.x; let bz = p.z;
    for (const e of edges) {
      const dx = e.bx - e.ax, dz = e.bz - e.az;
      const l2 = dx * dx + dz * dz;
      const t = l2 === 0 ? 0 : Math.min(1, Math.max(0, ((p.x - e.ax) * dx + (p.z - e.az) * dz) / l2));
      const qx = e.ax + dx * t, qz = e.az + dz * t;
      const d = Math.hypot(p.x - qx, p.z - qz);
      if (d < best) { best = d; bx = qx; bz = qz; }
    }
    depth = Math.max(depth, best);
    let ix = cx - bx, iz = cz - bz;
    const il = Math.hypot(ix, iz);
    if (il > 1e-6) { ix /= il; iz /= il; } else { ix = 0; iz = 1; }
    pos.push(p.x, baseY, p.z); edge.push(best); inward.push(ix, iz);
  };
  for (const t of tris) {
    push(contour[t[0]!]!); push(contour[t[1]!]!); push(contour[t[2]!]!);
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geom.setAttribute('aEdge', new THREE.Float32BufferAttribute(edge, 1));
  geom.setAttribute('aInward', new THREE.Float32BufferAttribute(inward, 2));

  const tint = new THREE.Color(opts.color).convertLinearToSRGB();
  const towards = opts.towards ?? { x: 1, z: 0 };
  const uniforms = {
    uTime: { value: 0 },
    uCell: { value: 1 },
    uEffect: { value: EFFECT_CODE[opts.effect] },
    uTint: { value: new THREE.Vector3(tint.r, tint.g, tint.b) },
    uShift: { value: new THREE.Vector2(-opts.origin.x, -opts.origin.z) },
    uFrame: { value: new THREE.Vector4(0, 0, towards.x, towards.z) },
    uSpread: { value: opts.spread ?? Math.PI },
    uReach: { value: Math.max(0.5, opts.reach) },
    uDriftA: { value: new THREE.Vector4() },
    uDriftB: { value: new THREE.Vector4() },
    uSeed: { value: new THREE.Vector2(Math.random() * 64, Math.random() * 64) },
    uDetail: { value: 2 },
    uStill: { value: 0 },
    uDepth: { value: Math.max(0.5, opts.depth ?? depth) },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms, vertexShader: VERTEX, fragmentShader: FRAGMENT,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.NormalBlending, premultipliedAlpha: true,
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.renderOrder = 2.4;
  const group = new THREE.Group();
  group.add(mesh);

  return {
    group,
    setTime(seconds: number): void {
      uniforms.uTime.value = loopTime(seconds);
      const d = effectDrifts(opts.effect, seconds);
      uniforms.uDriftA.value.set(d[0]!, d[1]!, d[2]!, d[3]!);
      uniforms.uDriftB.value.set(d[4]!, d[5]!, d[6]!, d[7]!);
    },
    dispose(): void {
      group.removeFromParent();
      geom.dispose();
      mat.dispose();
    },
  };
}