import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createVerifiedVmlPlayerController} from '@videoml/player';
import {qualifiedTimingId as id, type ResolvedTiming} from '@videoml/shared/resolved-timing';

class NodeStub {
 children:NodeStub[]=[]; nodeType=1; get childNodes(){return this.children;} attrs:Record<string,string>; attributes:any[]=[]; parentElement:NodeStub|null=null;
 classList={add(){},remove(){},contains(){return false;}};
 style:any={display:'',setProperty(){},removeProperty(){}};
 constructor(public tagName:string,attrs:Record<string,string>={}) {this.attrs=attrs;}
 getAttribute(key:string){return this.attrs[key]??null;} hasAttribute(key:string){return key in this.attrs;}
 setAttribute(key:string,value:string){this.attrs[key]=value;} removeAttribute(key:string){delete this.attrs[key];}
 querySelectorAll(tag:string):NodeStub[]{const out:NodeStub[]=[];for(const child of this.children){if(tag==='*'||child.tagName===tag)out.push(child);out.push(...child.querySelectorAll(tag));}return out;}
 appendChild(child:NodeStub){this.children.push(child);child.parentElement=this;return child;} dispatchEvent(){} remove(){}
}
function wavBytes(){const pcm=Buffer.from([1,0,2,0]);const wav=Buffer.alloc(44+pcm.length);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(24000,24);wav.writeUInt32LE(48000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(pcm.length,40);pcm.copy(wav,44);return {wav,pcm};}
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const {wav,pcm}=wavBytes();const cue=id('cue',['c']);
const timing:ResolvedTiming={schemaVersion:1,fps:30,sampleRateHz:24000,durationFrames:30,generationSeed:0,leadInSamples:0,audioTotalSamples:2,scenes:[{id:id('scene',['s']),startFrame:0,endFrame:30}],cues:[{id:cue,startFrame:0,endFrame:1}],layers:[],components:[],transitions:[],segments:[{id:id('segment',['c',0]),cueId:cue,track:'main',originalText:'hello',expandedText:'hello',startSample:0,endSample:2,startFrame:0,endFrame:1,trimSamples:0,pauseSamples:0,audioPath:'audio.wav',audioSha256:sha(wav),pcmSha256:sha(pcm),provenance:{provider:'dry-run',simulated:true,audioSha256:sha(wav),pcmSha256:sha(pcm),extensions:{}}}]};
test('verified blob is sole sync-group audio and follows seek, pause, end and disposal',async()=>{
 const g=globalThis as any;const names=['DOMParser','XMLSerializer','document','HTMLElement','Element','MutationObserver','CustomEvent','requestAnimationFrame','cancelAnimationFrame'];const old=Object.fromEntries(names.map(n=>[n,g[n]]));const oldCreate=URL.createObjectURL,oldRevoke=URL.revokeObjectURL;
 const media:any={src:'',preload:'',currentTime:0,duration:Infinity,playCount:0,pauseCount:0,play(){this.playCount++;return Promise.resolve();},pause(){this.pauseCount++;},removeAttribute(){},load(){}};
 let blobs:Blob[]=[],revoked:string[]=[],removed=0,rafId=0;const callbacks=new Map<number,(ts:number)=>void>();
 const nativeAudio={remove(){removed++;}};const nativeVideo={getAttribute:()=> 'https://example.com/movie.mp4',removeAttribute(){throw new Error('visual source removed');},querySelectorAll:()=>[]};
 let xmlRoot:NodeStub;
 const xmlDoc={get documentElement(){return xmlRoot;},querySelector:()=>null,querySelectorAll:(tag:string)=>tag==='audio'?[nativeAudio]:tag==='video'?[nativeVideo]:[]};
 let importedVideo:any; const makeRoot=()=>{const root=new NodeStub('vml'),scene=new NodeStub('scene',{id:'s'}),cueNode=new NodeStub('cue',{id:'c'});importedVideo=new NodeStub('video',{src:'https://example.com/movie.mp4'});scene.appendChild(cueNode);scene.appendChild(importedVideo);root.appendChild(scene);return root;};
 xmlRoot=makeRoot();
 g.HTMLElement=NodeStub;g.Element=NodeStub;g.DOMParser=class {parseFromString(_s:string,type:string){return type==='application/xml'?xmlDoc:{body:{querySelector:()=>makeRoot()}};}};g.XMLSerializer=class {serializeToString(){assert.equal(removed>=1,true);return '<vml/>';}};
 g.document={importNode:(x:any)=>x,createElement:(tag:string)=>{assert.equal(tag,'audio');return media;},documentElement:{getAttribute:()=>null,classList:{contains:()=>false}},fonts:{ready:Promise.resolve()}};
 g.MutationObserver=class {observe(){} disconnect(){}};g.CustomEvent=class {constructor(..._args:any[]){}};
 g.requestAnimationFrame=(fn:(n:number)=>void)=>{callbacks.set(++rafId,fn);return rafId;};g.cancelAnimationFrame=(id:number)=>callbacks.delete(id);
 URL.createObjectURL=((blob:Blob)=>{blobs.push(blob);return 'blob:verified';}) as any; URL.revokeObjectURL=((url:string)=>{revoked.push(url);}) as any;
 const host=()=>({innerHTML:'',appendChild(_n:any){}} as unknown as HTMLElement);const bytes=async()=>Uint8Array.from(wav).buffer;
 try {
  const corrupt=Buffer.from(wav); corrupt[44]^=1;
  await assert.rejects(createVerifiedVmlPlayerController(host(),{xml:'<vml/>',resolvedTiming:timing,autoPlay:true},bytes,async()=>Uint8Array.from(corrupt).buffer),/Composition audio differs/);
  assert.equal(blobs.length,0);
  const a=await createVerifiedVmlPlayerController(host(),{xml:'<vml><audio src="https://bad"/><video src="https://bad"/></vml>',resolvedTiming:timing,syncGroup:'group',autoPlay:true},bytes,bytes);
  const b=await createVerifiedVmlPlayerController(host(),{xml:'<vml/>',resolvedTiming:timing,syncGroup:'group',autoPlay:true},bytes,bytes);
  assert.equal(blobs.length,1);assert.deepEqual(Buffer.from(await blobs[0].arrayBuffer()),wav);assert.equal(media.src,'blob:verified');assert.equal(media.playCount,1);assert.equal(importedVideo.muted,true);assert.equal(importedVideo.attrs.src,'https://example.com/movie.mp4');
  await a.seek(15);assert.equal(media.currentTime,.5);assert(media.pauseCount>=1);a.pause();assert(media.pauseCount>=2);
  a.dispose();assert.deepEqual(revoked,[]);b.dispose();assert.deepEqual(revoked,['blob:verified']);
  const c=await createVerifiedVmlPlayerController(host(),{xml:'<vml/>',resolvedTiming:timing,syncGroup:'end',autoPlay:true},bytes,bytes);
  const first=[...callbacks.entries()].at(-1)!;callbacks.delete(first[0]);first[1](0);const next=[...callbacks.entries()].at(-1)!;callbacks.delete(next[0]);next[1](1100);assert(media.pauseCount>=3);c.dispose();assert.equal(revoked.length,2);
  await assert.rejects(createVerifiedVmlPlayerController({innerHTML:'',appendChild(){throw new Error('mount failure');}} as unknown as HTMLElement,{xml:'<vml/>',resolvedTiming:timing,syncGroup:'failure'},bytes,bytes),/mount failure/); assert.equal(revoked.length,3);
  const originalPlay=media.play; media.play=()=>Promise.reject(new Error('blocked'));let errorMessage='';
  const rejected=await createVerifiedVmlPlayerController(host(),{xml:'<vml/>',resolvedTiming:timing,syncGroup:'rejected',autoPlay:true,onError:message=>{errorMessage=message??'';}},bytes,bytes);
  await new Promise(resolve=>setTimeout(resolve,0));assert.match(errorMessage,/Audio playback failed.*blocked/);rejected.dispose();media.play=originalPlay;assert.equal(revoked.length,4);
  let resume!: (bytes:ArrayBuffer)=>void;const wait=new Promise<ArrayBuffer>(resolve=>{resume=resolve;});const abort=new AbortController();const before=blobs.length;
  const pending=createVerifiedVmlPlayerController(host(),{xml:'<vml/>',resolvedTiming:timing,autoPlay:true},()=>wait,bytes,abort.signal);abort.abort();resume(Uint8Array.from(wav).buffer);
  await assert.rejects(pending,/cancelled/);assert.equal(blobs.length,before);
 } finally {for(const name of names)g[name]=old[name];URL.createObjectURL=oldCreate;URL.revokeObjectURL=oldRevoke;}
});
