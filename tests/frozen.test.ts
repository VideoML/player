import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolveFrozenDom, createVerifiedVmlPlayerController} from '@videoml/player';
import {qualifiedTimingId as id, normalizeSourceElement, type SourceElement, type ResolvedTiming} from '@videoml/shared/resolved-timing';
class ElementStub {
  children:ElementStub[]=[];
  nodeType=1;
  get childNodes(){return this.children;}
  constructor(public tagName:string,public attrs:Record<string,string>={}) {}
  getAttribute(name:string) { return this.attrs[name] ?? null; }
  setAttribute(name:string,value:string) { this.attrs[name]=value; }
  querySelectorAll(name:string): ElementStub[] { const found:ElementStub[]=[]; for(const child of this.children) {if(child.tagName===name) found.push(child);found.push(...child.querySelectorAll(name));} return found; }
}
const interval=(kind:string,path:string[],startFrame:number,endFrame:number)=>({id:id(kind,path),startFrame,endFrame});
const timing:ResolvedTiming={schemaVersion:1,fps:30,sampleRateHz:24000,durationFrames:30,generationSeed:0,leadInSamples:0,audioTotalSamples:0,scenes:[interval('scene',['scene:雪'],1,20)],cues:[interval('cue',['c'],2,5)],layers:[interval('layer',['scene:雪','layer'],3,15)],components:[interval('component',['scene:雪','layer','component:1'],4,10)],transitions:[interval('transition',['transition'],15,20)],segments:[]};
test('frozen DOM mapping ignores changed XML timing and uses exact qualified IDs',()=>{
 const root=new ElementStub('vml');const scene=new ElementStub('scene',{id:'scene:雪',start:'99'});const cue=new ElementStub('cue',{id:'c',start:'98'});const layer=new ElementStub('layer',{id:'layer',start:'97'});const component=new ElementStub('title-card',{id:'component:1',start:'96'});const transition=new ElementStub('transition',{id:'transition',start:'95'}); layer.children.push(component);scene.children.push(cue,layer);root.children.push(scene,transition);
 const mapped=resolveFrozenDom(root as unknown as Element,timing); assert.equal(mapped.scenes[0].start,1/30);assert.equal(mapped.cues[0].start,2/30);assert.equal(mapped.timedByScene.get('scene:雪')![1].start,4/30);assert.equal(mapped.transitions[0].start,15/30);assert.equal(mapped.duration,1);
 scene.attrs.start='3';component.attrs.start='5';const changed=resolveFrozenDom(root as unknown as Element,timing);assert.equal(changed.scenes[0].start,mapped.scenes[0].start);assert.equal(changed.timedByScene.get('scene:雪')![1].start,4/30);
 delete component.attrs.id;assert.throws(()=>resolveFrozenDom(root as unknown as Element,timing),/explicit ID/);
});
test('audio corruption rejects before a player can mount',async()=>{
 const segment={id:id('segment',['c',0]),cueId:id('cue',['c']),track:'main',startSample:0,endSample:1,startFrame:0,endFrame:1,audioPath:'audio.wav',audioSha256:'0'.repeat(64),pcmSha256:'0'.repeat(64),originalText:'x',expandedText:'x',trimSamples:0,pauseSamples:0,provenance:{provider:'dry-run',simulated:true,audioSha256:'0'.repeat(64),pcmSha256:'0'.repeat(64),extensions:{}}};
 const bad:ResolvedTiming={...timing,audioTotalSamples:1,segments:[segment]};
 await assert.rejects(createVerifiedVmlPlayerController({} as HTMLElement,{xml:'<vml/>',resolvedTiming:bad},async()=>new ArrayBuffer(4)),/Invalid WAV/);
});
test('frozen ID mismatch leaves the existing host unchanged', async () => {
 const root=new ElementStub('vml');root.children.push(new ElementStub('scene',{id:'other'}));
 const globals=globalThis as any;const old={DOMParser:globals.DOMParser,XMLSerializer:globals.XMLSerializer,document:globals.document,HTMLElement:globals.HTMLElement};
 class FakeHTMLElement extends ElementStub {classList={add(){},remove(){}};setAttribute(){};style={};}
 const detached=new FakeHTMLElement('vml');detached.children=root.children;
 globals.HTMLElement=FakeHTMLElement;
 globals.DOMParser=class {parseFromString(_text:string,type:string){return type === 'application/xml' ? {documentElement:detached,querySelector:()=>null,querySelectorAll:()=>[]} : {body:{querySelector:()=>detached}};}};
 globals.XMLSerializer=class {serializeToString(){return '<vml/>';}};
 globals.document={importNode:()=>detached,documentElement:{getAttribute:()=>null,classList:{contains:()=>false}}};
 let html='sentinel';let appended=false;
 const host={get innerHTML(){return html;},set innerHTML(value:string){html=value;},appendChild(){appended=true;}};
 try {await assert.rejects(createVerifiedVmlPlayerController(host as unknown as HTMLElement,{xml:'<vml/>',resolvedTiming:timing},async()=>new ArrayBuffer(0)),/Missing/);assert.equal(html,'sentinel');assert.equal(appended,false);}
 finally {globals.DOMParser=old.DOMParser;globals.XMLSerializer=old.XMLSerializer;globals.document=old.document;globals.HTMLElement=old.HTMLElement;}
});
test('transition children map explicitly and reordered scene IDs reject', () => {
 const root=new ElementStub('vml');const a=new ElementStub('scene',{id:'a'});const b=new ElementStub('scene',{id:'b'});const transition=new ElementStub('transition',{id:'t'});const layer=new ElementStub('layer',{id:'l'});layer.children.push(new ElementStub('title-card',{id:'c'}));transition.children.push(layer);root.children.push(a,b,transition);
 const frozen:ResolvedTiming={...timing,scenes:[interval('scene',['a'],0,10),interval('scene',['b'],10,20)],cues:[],layers:[interval('transition-layer',['t','l'],15,19)],components:[interval('transition-component',['t','l','c'],16,18)],transitions:[interval('transition',['t'],15,20)]};
 const result=resolveFrozenDom(root as unknown as Element,frozen);assert.equal(result.transitions[2].start,16/30);
 root.children=[b,a,transition];assert.throws(()=>resolveFrozenDom(root as unknown as Element,frozen),/order/);
});

test('shared normalization matches nested stack/sequence components in player',()=>{
 const root=new ElementStub('vml',{id:'v'}),scene=new ElementStub('scene',{id:'s:雪'}),stack=new ElementStub('stack'),sequence=new ElementStub('sequence'),a=new ElementStub('video-title'),b=new ElementStub('video-title'),cue=new ElementStub('cue',{id:'cue:雪'});
 sequence.children.push(a,b);stack.children.push(sequence);scene.children.push(stack,cue);root.children.push(scene);normalizeSourceElement(root as unknown as SourceElement);
 const t:ResolvedTiming={...timing,scenes:[interval('scene',['s:雪'],0,30)],cues:[interval('cue',['cue:雪'],0,30)],layers:[],components:[interval('component',['s:雪',a.attrs.id],0,30),interval('component',['s:雪',b.attrs.id],0,30)],transitions:[]};
 const result=resolveFrozenDom(root as unknown as Element,t);assert.equal(result.timedByScene.get('s:雪')!.length,2);assert.notEqual(a.attrs.id,b.attrs.id);
 normalizeSourceElement(root as unknown as SourceElement);assert.equal(result.timedByScene.get('s:雪')!.length,2);
});
