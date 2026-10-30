/** Shared compositor for native canvas/WebGL sources or caller-supplied captures. */
export * from '@videoml/stdlib/effects/transitions';
import { createVmlPlayerController, type VmlPlayerOptions } from './runtime.js';

/** Local capture bundles use the normal player lifecycle and isolate a selected scene. */
export function mountPlayerCaptureScene(root:HTMLElement,options:VmlPlayerOptions & {captureSceneId:string}) {
  const player=createVmlPlayerController(root,{...options,autoPlay:false});
  return {seek(frame:number){return player.seek(frame);},dispose(){player.dispose();}};
}
