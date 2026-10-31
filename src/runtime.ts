import { implicitTransitionId, normalizeSourceElement, qualifiedTimingId, validateResolvedTiming, verifyResolvedAudio, type ResolvedTiming, type SourceElement } from "@videoml/shared/resolved-timing";
import { executeVomXml } from "./xml.js";
import { registerFallbackComponents, registerVideoMLComponents } from "@videoml/stdlib/dom";
import { createBuiltinEffectRegistry, mountFrameEffects } from "@videoml/stdlib/effects/xml";
import type { EffectRegistry } from "@videoml/stdlib/effects";
import {shaderNames,mountSceneCompositor,SceneCaptureError,validateTransitionOptions,type SceneFrameSource,type SceneTransition,type TransitionShader} from "@videoml/stdlib/effects/transitions";
import gsapModule from "gsap";

export type VmlPlayerOptions = {
  xml: string;
  resolvedTiming?: ResolvedTiming;
  autoPlay?: boolean;
  clockMode?: "bounded" | "live";
  loop?: boolean;
  syncGroup?: string;
  onTimeUpdate?: (timeSec: number, durationSec: number) => void;
  onXmlChange?: (xml: string) => void;
  onError?: (message: string | null) => void;
  settleFrame?: (frame:number, root:HTMLElement) => Promise<void>;
  /** Explicitly isolate this scene for browser-painted transition capture. */
  captureSceneId?: string;
  effectRegistry?: EffectRegistry;
  effectAssets?: Readonly<Record<string, unknown>>;
  effectSeed?: number;
  assetBaseUrl?: string;
  /** Trusted host creates independent settled scene capture providers. */
  transitionSourceFactory?: (sceneId:string)=>SceneFrameSource;
  transitionAllowCrossfadeFallback?: boolean;
  onTransitionDiagnostic?: (diagnostic:'CROSSFADE_FALLBACK')=>void;
};

type TimelineParticipant = {
  active: boolean;
  settle: (frame:number)=>Promise<void>;
  cancelled: Promise<void>;
  cancel: ()=>void;
};
type Timeline = {
  id: string;
  fps: number;
  duration: number | null;
  clockMode: "bounded" | "live";
  frame: number;
  time: number;
  start: () => void;
  stop: () => void;
  seek: (frame: number) => void;
  seekSettled: (frame:number, initiator:TimelineParticipant) => Promise<void>;
  registerParticipant: (settle:(frame:number)=>Promise<void>) => TimelineParticipant;
  unregisterParticipant: (participant:TimelineParticipant) => void;
  subscribe: (fn: (time: number) => void) => () => void;
};

type SceneTiming = {
  id: string;
  start: number;
  end: number | null;
  element: Element;
};
type CueTiming = {
  id: string;
  start: number;
  end: number | null;
  element: Element;
};
type TimedElement = {
  element: Element;
  start: number;
  end: number;
};

type OwnedAudio = {audio: HTMLAudioElement; url: string; digest: string; refs: number; onError?: (message: string | null) => void};
const ownedAudio = new Map<string, OwnedAudio>();
const frozenGroups = new Map<string, string>();
const timelines = new Map<string, Timeline>();
const timelineReferences = new Map<string, number>();
let defaultTimeline: Timeline | null = null;

const ensureGlobalTimelines = () => {
  if (typeof window === "undefined") return;
  (window as any).timelines = timelines;
  if (defaultTimeline) {
    (window as any).timeline = defaultTimeline;
  }
};

const createTimeline = (id: string, fps: number, clockMode: "bounded" | "live", loop: boolean, duration: number | null) => {
  let raf: number | null = null;
  let lastTs: number | null = null;
  let running = false;
  let frame = 0;
  let time = 0;
  const subs = new Set<(t: number) => void>();
  const participants = new Set<TimelineParticipant>();
  let seekQueue:Promise<void> = Promise.resolve();

  const tick = (ts: number) => {
    if (!running) return;
    if (lastTs == null) lastTs = ts;
    const delta = (ts - lastTs) / 1000;
    lastTs = ts;
    let nextTime = time + delta;

    if (clockMode === "bounded" && duration != null) {
      if (nextTime >= duration) {
        if (loop) {
          nextTime = duration > 0 ? nextTime % duration : 0;
        } else {
          nextTime = duration;
          running = false;
        }
      }
    }

    time = nextTime;
    frame = Math.floor(time * fps);
    const media = ownedAudio.get(id)?.audio;
    if (media && (Math.abs(media.currentTime - time) > 0.1 || !running)) {
      media.currentTime = Number.isFinite(media.duration) ? Math.min(time, media.duration) : time;
      if (!running) media.pause();
    }
    subs.forEach((fn) => fn(time));
    if (running) {
      raf = requestAnimationFrame(tick);
    }
  };

  const timeline: Timeline = {
    id,
    fps,
    duration,
    clockMode,
    get frame() {
      return frame;
    },
    get time() {
      return time;
    },
    start() {
      if (running) return;
      running = true;
      const owner = ownedAudio.get(id);
      if (owner) {
        try {
          const playing = owner.audio.play();
          void playing?.catch(error => { owner.onError?.(`Audio playback failed: ${String(error)}`); timeline.stop(); });
        } catch (error) { owner.onError?.(`Audio playback failed: ${String(error)}`); timeline.stop(); return; }
      }
      lastTs = null;
      raf = requestAnimationFrame(tick);
    },
    stop() {
      running = false;
      ownedAudio.get(id)?.audio.pause();
      if (raf != null) cancelAnimationFrame(raf);
      raf = null;
      lastTs = null;
    },
    seek(nextFrame) {
      if (!Number.isSafeInteger(nextFrame) || nextFrame < 0) throw new Error("Frame must be a nonnegative integer");
      frame = nextFrame; time = frame / fps; lastTs = null;
      const media = ownedAudio.get(id)?.audio;
      if (media) media.currentTime = Number.isFinite(media.duration) ? Math.min(time, media.duration) : time;
      subs.forEach(fn => fn(time));
    },
    registerParticipant(settle) {
      let cancel!:()=>void;
      const cancelled=new Promise<void>(resolve=>{cancel=resolve;});
      const participant={active:true,settle,cancelled,cancel};participants.add(participant);return participant;
    },
    unregisterParticipant(participant) {
      if (!participant.active) return;
      participant.active=false; participants.delete(participant); participant.cancel();
    },
    seekSettled(nextFrame, initiator) {
      if (!Number.isSafeInteger(nextFrame) || nextFrame < 0) return Promise.reject(new Error("Frame must be a nonnegative integer"));
      if (!initiator.active) return Promise.reject(new Error("Player disposed"));
      timeline.stop();
      const work=seekQueue.then(async()=>{
        if (!initiator.active) throw new Error("Player disposed");
        timeline.stop(); timeline.seek(nextFrame);
        const current=[...participants].filter(p=>p.active);
        const results=await Promise.allSettled(current.map(participant=>Promise.race([
          Promise.resolve().then(()=>participant.settle(nextFrame)), participant.cancelled,
        ])));
        if (!initiator.active) throw new Error("Player disposed");
        for (let i=0;i<results.length;i++) {
          const result=results[i];
          if (current[i].active && result.status==='rejected') throw result.reason;
        }
      });
      seekQueue=work.catch(()=>{});return work;
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
  return timeline;
};

const serializeXml = (root: Element) => {
  const clone = root.cloneNode(true) as Element;
  const stripRuntimeAttrs = (el: Element) => {
    el.removeAttribute("data-runtime-hidden");
    el.removeAttribute("data-runtime-active");
    el.removeAttribute("data-runtime-seen");
    Array.from(el.children).forEach(stripRuntimeAttrs);
  };
  stripRuntimeAttrs(clone);
  return new XMLSerializer().serializeToString(clone);
};

const applyStyleObject = (el: HTMLElement, styles: Record<string, any>) => {
  for (const [key, value] of Object.entries(styles)) {
    if (value == null) continue;
    const stringValue = String(value);
    if (key.includes("-")) {
      el.style.setProperty(key, stringValue);
    } else {
      (el.style as any)[key] = stringValue;
    }
  }
};

const shouldIgnore = (node: Element | null): boolean => {
  let current: Element | null = node;
  while (current) {
    if (current.getAttribute("data-videoml-ignore") === "true") return true;
    current = current.parentElement;
  }
  return false;
};

const collectTimeScale = (el: Element | null): number => {
  let scale = 1;
  let current: Element | null = el;
  while (current) {
    const raw = current.getAttribute("timeScale") ?? current.getAttribute("time-scale");
    if (raw) {
      const parsed = Number.parseFloat(raw);
      if (Number.isFinite(parsed) && parsed > 0) {
        scale *= parsed;
      }
    }
    current = current.parentElement;
  }
  return scale;
};

const dispatchDomEvent = (root: HTMLElement, name: string, detail: Record<string, unknown>) => {
  const event = new CustomEvent(name, { detail });
  root.dispatchEvent(event);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  }
};

const TIMING_TAG_EXCLUDE = new Set(["cue", "voice", "pause", "bullet"]);

const computeTimedElements = (sceneEl: Element, sceneStart: number, fps: number, sceneEnd: number | null = null): TimedElement[] => {
  const timed: TimedElement[] = [];

  const walk = (container: Element, baseStart: number, flow: "sequence" | "stack", baseEnd: number) => {
    let cursor = baseStart;
    const defaultChildDuration = parseTimeSeconds(container.getAttribute("defaultChildDuration"), fps)
      ?? parseTimeSeconds(container.getAttribute("default-child-duration"), fps)
      ?? 1;
    const children = Array.from(container.children).filter((child) => child.nodeType === 1);
    for (const child of children) {
      const tag = child.tagName.toLowerCase();
      if (TIMING_TAG_EXCLUDE.has(tag)) continue;

      const childFlow = tag === "sequence" ? "sequence" : tag === "stack" ? "stack" : flow;
      const startOffset = parseTimeSeconds(child.getAttribute("start"), fps) ?? 0;
      const durationAttr = parseTimeSeconds(child.getAttribute("duration"), fps);
      const endAttr = parseTimeSeconds(child.getAttribute("end"), fps);
      const localStart = flow === "sequence" ? cursor + startOffset : baseStart + startOffset;
      let localEnd: number | null = null;

      if (durationAttr != null) {
        localEnd = localStart + durationAttr;
      } else if (endAttr != null) {
        localEnd = baseStart + endAttr;
      }

      if (localEnd == null && flow === "stack" && (tag === "frame-effect" || tag === "layer" || tag === "sequence" || tag === "stack")) localEnd = baseEnd;
      if (localEnd != null) {
        timed.push({ element: child, start: localStart, end: localEnd });
      } else if (flow === "sequence") {
        const fallbackEnd = localStart + defaultChildDuration;
        timed.push({ element: child, start: localStart, end: fallbackEnd });
        localEnd = fallbackEnd;
      }

      // Recurse into container-like nodes or layers to time nested elements
      if (tag === "sequence" || tag === "stack" || tag === "layer" || tag === "scene") {
        walk(child, localStart, childFlow, localEnd ?? baseEnd);
      }

      if (flow === "sequence") {
        cursor = localEnd ?? cursor;
      }
    }
  };

  walk(sceneEl, sceneStart, "stack", sceneEnd ?? Infinity);
  return timed;
};

const bindInlineHandlers = (root: Element, timeline: Timeline, cleanups: Array<() => void>) => {
  const elements = [root, ...Array.from(root.querySelectorAll("*"))];
  for (const el of elements) {
    if (shouldIgnore(el)) continue;
    const attrs = Array.from(el.attributes);
    for (const attr of attrs) {
      if (!attr.name.startsWith("on:")) continue;
      const eventName = attr.name.slice(3);
      const handlerCode = attr.value;
      if (!eventName || !handlerCode) continue;
      const key = `data-on-${eventName}-bound`;
      if (el.getAttribute(key) === "true") continue;
      const handler = new Function("event", "target", "timeline", "root", handlerCode);
      const listener = (event: Event) => {
        try { handler(event, event.target, timeline, root); }
        catch (err) { console.error(`VideoML handler error for on:${eventName}`, err); }
      };
      el.addEventListener(eventName, listener);
      cleanups.push(() => { el.removeEventListener(eventName, listener); el.removeAttribute(key); });
      el.setAttribute(key, "true");
    }
  }

  const scripts = Array.from(root.querySelectorAll("script"));
  for (const script of scripts) {
    if (shouldIgnore(script)) continue;
    if (script.getAttribute("data-videoml-executed") === "true") continue;
    const code = script.textContent ?? "";
    if (!code.trim()) continue;
    try {
      const runner = new Function("timeline", "root", code);
      runner(timeline, root);
      script.setAttribute("data-videoml-executed", "true");
    } catch (err) {
      console.error("VideoML script error", err);
    }
  }
};

const parseTimeSeconds = (raw: string | null, fps: number): number | null => {
  if (!raw) return null;
  const value = raw.trim();
  if (!value) return null;
  const msMatch = value.match(/^([0-9]*\.?[0-9]+)ms$/);
  if (msMatch) return Number.parseFloat(msMatch[1]) / 1000;
  const sMatch = value.match(/^([0-9]*\.?[0-9]+)s$/);
  if (sMatch) return Number.parseFloat(sMatch[1]);
  const fMatch = value.match(/^([0-9]*\.?[0-9]+)f$/);
  if (fMatch) return Number.parseFloat(fMatch[1]) / fps;
  const num = Number.parseFloat(value);
  return Number.isFinite(num) ? num : null;
};

const elementDuration = (el: Element, fps: number): number | null => {
  const durationAttr = parseTimeSeconds(el.getAttribute("duration"), fps);
  if (durationAttr != null) return durationAttr;
  const startAttr = parseTimeSeconds(el.getAttribute("start"), fps) ?? 0;
  const endAttr = parseTimeSeconds(el.getAttribute("end"), fps);
  if (endAttr != null) return Math.max(0, endAttr - startAttr);

  const tag = el.tagName.toLowerCase();
  const children = Array.from(el.children).filter((child) => child.nodeType === 1);
  if (!children.length) return null;

  if (tag === "sequence") {
    let cursor = 0;
    let maxEnd: number | null = 0;
    for (const child of children) {
      const childStart = parseTimeSeconds(child.getAttribute("start"), fps);
      const localStart = childStart != null ? childStart : cursor;
      const childDur = elementDuration(child, fps);
      if (childDur == null) return null;
      const localEnd = localStart + childDur;
      if (localEnd > (maxEnd ?? 0)) maxEnd = localEnd;
      cursor = localEnd;
    }
    return maxEnd;
  }

  if (tag === "stack" || tag === "layer" || tag === "scene") {
    let maxDur: number | null = null;
    for (const child of children) {
      const childStart = parseTimeSeconds(child.getAttribute("start"), fps) ?? 0;
      const childDur = elementDuration(child, fps);
      if (childDur == null) return null;
      const localEnd = childStart + childDur;
      if (maxDur == null || localEnd > maxDur) maxDur = localEnd;
    }
    return maxDur;
  }

  // Default container behavior: max of children
  let maxDur: number | null = null;
  for (const child of children) {
    const childStart = parseTimeSeconds(child.getAttribute("start"), fps) ?? 0;
    const childDur = elementDuration(child, fps);
    if (childDur == null) return null;
    const localEnd = childStart + childDur;
    if (maxDur == null || localEnd > maxDur) maxDur = localEnd;
  }
  return maxDur;
};

const computeSceneTimings = (xml: string, root: Element): { scenes: SceneTiming[]; cues: CueTiming[]; duration: number | null; fps: number } => {
  const videoSpec = executeVomXml(xml, undefined, false);
  const composition = videoSpec?.compositions?.[0];
  const fps = composition?.meta?.fps ?? 30;
  const sceneElements = Array.from(root.querySelectorAll("scene"));
  const timing: SceneTiming[] = [];
  const cueTiming: CueTiming[] = [];
  let cursor = 0;
  let insertedDuration = 0;
  for (const sceneEl of sceneElements) {
    const id = sceneEl.getAttribute("id") ?? "";
    const siblings = Array.from(sceneEl.parentElement?.children ?? []);
    const position = siblings.indexOf(sceneEl);
    const previous = siblings[position - 1];
    const startAttr = parseTimeSeconds(sceneEl.getAttribute("start"), fps);
    if (previous?.tagName.toLowerCase() === 'transition' && previous.getAttribute('mode') === 'insert') {
      const length = parseTimeSeconds(previous.getAttribute('duration'), fps) ?? 1;
      const authoredStart = startAttr == null ? cursor : startAttr + insertedDuration;
      const shift = Math.max(0, cursor + length - authoredStart);
      cursor += shift;
      insertedDuration += shift;
    }
    const start = startAttr != null ? startAttr + insertedDuration : cursor;
    const durationAttr = elementDuration(sceneEl, fps);
    const scale = collectTimeScale(sceneEl);
    const end = durationAttr != null ? start + durationAttr * scale : null;
    timing.push({ id, start, end, element: sceneEl });
    if (end != null) {
      cursor = end;
    }

    const cues = Array.from(sceneEl.querySelectorAll("cue"));
    for (const cue of cues) {
      const cueId = cue.getAttribute("id");
      if (!cueId) continue;
      const cueStartAttr = parseTimeSeconds(cue.getAttribute("start"), fps);
      const cueDurationAttr = parseTimeSeconds(cue.getAttribute("duration"), fps);
      const cueEndAttr = parseTimeSeconds(cue.getAttribute("end"), fps);
      let cueStart = cueStartAttr != null ? cueStartAttr : null;
      let cueEnd: number | null = null;
      if (cueStart == null) {
        if (cueEndAttr != null && end != null) {
          cueStart = Math.max(start, cueEndAttr - start);
        }
      }
      if (cueStart != null) {
        cueStart = start + cueStart * scale;
        if (cueDurationAttr != null) {
          cueEnd = cueStart + cueDurationAttr * scale;
        } else if (cueEndAttr != null) {
          cueEnd = start + cueEndAttr * scale;
        }
      }
      if (cueStart != null) {
        cueTiming.push({ id: cueId, start: cueStart, end: cueEnd, element: cue });
      }
    }
  }
  // Match the generated script: overlap transitions begin before the previous
  // scene ends and pull the next scene's visibility start forward.
  for (const transition of Array.from(root.querySelectorAll('transition'))) {
    const siblings = Array.from(transition.parentElement?.children ?? []);
    const position = siblings.indexOf(transition);
    const before = siblings.slice(0, position).reverse().find(element => element.tagName.toLowerCase() === 'scene');
    const after = siblings.slice(position + 1).find(element => element.tagName.toLowerCase() === 'scene');
    const previous = timing.find(scene => scene.element === before);
    const next = timing.find(scene => scene.element === after);
    if (!previous || !next || previous.end == null || transition.getAttribute('mode') === 'insert') continue;
    const length = parseTimeSeconds(transition.getAttribute('duration'), fps) ?? 1;
    const start = parseTimeSeconds(transition.getAttribute('start'), fps) ?? Math.max(0, previous.end - length);
    next.start = Math.min(next.start, start);
  }
  let duration: number | null = null;
  for (const scene of timing) {
    if (scene.end != null && (duration == null || scene.end > duration)) {
      duration = scene.end;
    }
  }
  return { scenes: timing, cues: cueTiming, duration, fps };
};

export type VmlPlayerController = { seek(frame:number):Promise<void>; pause():void; dispose():void };
export function mountVmlPlayer(container: HTMLElement, options: VmlPlayerOptions): () => void {
  const controller = createVmlPlayerController(container, options);
  return () => controller.dispose();
}
export function createVmlPlayerController(container: HTMLElement, options: VmlPlayerOptions): VmlPlayerController {
  if (options.resolvedTiming) throw new Error("Frozen timing requires createVerifiedVmlPlayerController");
  return createPlayerController(container, options);
}

/** Audio must be verified before a frozen player can mount or autoplay. */
export async function createVerifiedVmlPlayerController(container: HTMLElement, options: VmlPlayerOptions & {resolvedTiming: ResolvedTiming}, loadAudio: (path: string) => Promise<ArrayBuffer>, loadCompositionAudio?: () => Promise<ArrayBuffer>, signal?: AbortSignal): Promise<VmlPlayerController> {
  validateResolvedTiming(options.resolvedTiming);
  if (signal?.aborted) throw new Error("Frozen player cancelled");
  let composition: ArrayBuffer | undefined;
  const loadOnce = loadCompositionAudio ? async () => {
    composition ??= (await loadCompositionAudio()).slice(0);
    return composition;
  } : undefined;
  const canonical = await verifyResolvedAudio(options.resolvedTiming, loadAudio, loadOnce);
  if (signal?.aborted) throw new Error("Frozen player cancelled");
  const digest = composition ? Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", composition)), b => b.toString(16).padStart(2,"0")).join("") : null;
  if (signal?.aborted) throw new Error("Frozen player cancelled");
  return createPlayerController(container, options, options.resolvedTiming, canonical ? {bytes:canonical, digest:digest!} : undefined);
}

function createPlayerController(container: HTMLElement, options: VmlPlayerOptions, frozen?: ResolvedTiming, verifiedAudio?: {bytes:ArrayBuffer; digest:string}): VmlPlayerController {
  const {
    xml,
    autoPlay = true,
    clockMode = "live",
    loop = false,
    syncGroup,
    onTimeUpdate,
    onXmlChange,
    onError,
    settleFrame,
    captureSceneId,
    effectRegistry,
    effectAssets,
    effectSeed,
    assetBaseUrl,
    transitionSourceFactory,
    transitionAllowCrossfadeFallback,
    onTransitionDiagnostic,
  } = options;

  const timelineId = syncGroup ?? `timeline-${Math.random().toString(36).slice(2)}`;
  const frozenKey = frozen ? JSON.stringify(frozen) : null;
  let mediaAcquired = false;
  if (transitionAllowCrossfadeFallback && !onTransitionDiagnostic) throw new Error('TRANSITION_INVALID: fallback requires a diagnostic handler');
  let frameEffects: ReturnType<typeof mountFrameEffects> | undefined;
  const shaderTransitions: Array<{start:number;end:number;controller:SceneTransition}> = [];
  const effectAbort = new AbortController();
  const effectUrls: string[] = [];
  let effectsDisposed = false;
  try {
  registerVideoMLComponents();

  const parser = new DOMParser();
  let safeXml = xml;
  let sourceDocument: Document | undefined;
  const hasFrameEffectXml=/<frame-effect(?:\s|\/|>)/i.test(xml);
  const hasShaderXml=/<transition(?:\s|\/|>)/i.test(xml);
  if (frozen || hasFrameEffectXml || hasShaderXml) {
    const xmlDocument = parser.parseFromString(xml, "application/xml");
    sourceDocument = xmlDocument;
    if (xmlDocument.querySelector("parsererror")) throw new Error("Invalid frozen XML");
    for (const element of Array.from(xmlDocument.querySelectorAll("frame-effect"))) if (!element.getAttribute("id")) throw new Error("FRAME_EFFECT_INVALID: explicit id is required");
    if (frozen) normalizeSourceElement(xmlDocument.documentElement as unknown as SourceElement);
    const rootElement = xmlDocument.documentElement;
    const timelineElements = Array.from(rootElement.children).filter(element => ["scene","transition","narration","mark"].includes(element.tagName.toLowerCase()));
    if (frozen) timelineElements.forEach((element,index) => {
      if (element.tagName.toLowerCase() !== "scene" || !(element.getAttribute("transition-to-next") || element.getAttribute("transition"))) return;
      if (timelineElements[index+1]?.tagName.toLowerCase() === "transition") return;
      const from = element.getAttribute("id");
      if (!from) throw new Error("Implicit transition requires a source scene ID");
      const next = timelineElements.slice(index+1).find(item => item.tagName.toLowerCase() === "scene");
      const implicit = xmlDocument.createElement("transition");
      implicit.setAttribute("id", implicitTransitionId(from, next?.getAttribute("id") ?? null));
      implicit.setAttribute("effect", element.getAttribute("transition-to-next") || element.getAttribute("transition")!);
      for (const name of ["duration", "ease", "props"]) {
        const value = element.getAttribute(`transition-${name}`);
        if (value !== null) implicit.setAttribute(name, value);
      }
      rootElement.insertBefore(implicit,element.nextSibling);
    });
    if (frozen) for (const audio of Array.from(xmlDocument.querySelectorAll("audio"))) audio.remove();
    if (xmlDocument.querySelector("script, iframe, object, embed")) throw new Error("Frozen playback does not support active source content");
    for (const element of Array.from(xmlDocument.querySelectorAll("*"))) {
      if (Array.from(element.attributes).some(attribute => /^on/i.test(attribute.name))) throw new Error("Frozen playback does not support source event handlers");
    }
  }
  let root: Element | null;
  if (sourceDocument && (hasFrameEffectXml || hasShaderXml)) {
    // Construct HTML nodes from parsed XML rather than reparsing XML empty-element syntax as HTML.
    const convert = (node: Element): Element => {
      const result = document.createElement(node.tagName);
      for (const attribute of Array.from(node.attributes)) result.setAttribute(attribute.name, attribute.value);
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === 1) result.appendChild(convert(child as Element));
        else if (child.nodeType === 3 || child.nodeType === 4) result.appendChild(document.createTextNode(child.textContent ?? ""));
      }
      return result;
    };
    root = convert(sourceDocument.documentElement);
  } else {
    if(sourceDocument){const voidTags=new Set(["area","base","br","col","embed","hr","img","input","link","meta","param","source","track","wbr"]);safeXml=new XMLSerializer().serializeToString(sourceDocument.documentElement).replace(/<([\w:-]+)([^<>]*?)\/>/g,(full,tag:string,attributes:string)=>voidTags.has(tag.toLowerCase())?full:`<${tag}${attributes}></${tag}>`);}
    const doc = parser.parseFromString(safeXml, "text/html");
    root = doc.body.querySelector("vml, videoml, video-ml");
  }
  if (!root || !["vml", "videoml", "video-ml"].includes(root.tagName.toLowerCase())) {
    onError?.("XML root must be <vml>, <videoml>, or <video-ml>.");
    return { seek: async () => { throw new Error("Player has no valid XML root"); }, pause: () => {}, dispose: () => {} };
  }

  let imported = document.importNode(root, true) as Element;
  registerFallbackComponents(imported);
  if (!(imported instanceof HTMLElement)) {
    const wrapper = document.createElement("div");
    wrapper.appendChild(imported);
    imported = wrapper;
  }
  const importedEl = imported as HTMLElement;
  if (frozen) {
    for (const audio of Array.from(importedEl.querySelectorAll("audio"))) audio.remove();
    for (const video of Array.from(importedEl.querySelectorAll("video"))) video.muted = true;
  }
  const docRoot = document.documentElement;
  const themeAttr = docRoot.getAttribute("data-theme");
  if (themeAttr) {
    importedEl.setAttribute("data-theme", themeAttr);
  }
  if (docRoot.classList.contains("dark")) {
    importedEl.classList.add("dark");
  } else {
    importedEl.classList.remove("dark");
  }

  let scenes: SceneTiming[], cues: CueTiming[], duration: number | null, fps: number;
  let timedByScene: Map<string, TimedElement[]>;
  let frozenTransitions: TimedElement[] = [];
  if (frozen) {
    const resolved = resolveFrozenDom(importedEl, frozen);
    ({scenes, cues, duration, fps, timedByScene, transitions: frozenTransitions} = resolved);
  } else {
    ({scenes, cues, duration, fps} = computeSceneTimings(xml, importedEl));
    frozenTransitions=[];
    for (const transition of Array.from(importedEl.querySelectorAll('transition'))) {
      const siblings=Array.from(transition.parentElement?.children ?? []);const position=siblings.indexOf(transition);
      const previous=siblings.slice(0,position).reverse().find(element=>element.tagName.toLowerCase()==='scene');
      const previousScene=scenes.find(scene=>scene.element===previous);
      const length=parseTimeSeconds(transition.getAttribute('duration'),fps) ?? 1;
      const start=parseTimeSeconds(transition.getAttribute('start'),fps) ?? (previousScene?.end == null ? undefined : transition.getAttribute('mode') === 'insert' ? previousScene.end : Math.max(0, previousScene.end-(length ?? 0)));
      const endAttr=parseTimeSeconds(transition.getAttribute('end'),fps);
      const end=endAttr ?? (start!=null ? start+length : undefined);
      if(start==null||end==null||!Number.isFinite(start)||!Number.isFinite(end)||end<start) {
        if(transition.querySelector('frame-effect') || transition.hasAttribute('effect'))throw new Error('TRANSITION_INVALID: transition requires a bounded interval');
        continue;
      }
      frozenTransitions.push({element:transition,start,end},...computeTimedElements(transition,start,fps,end));
    }
    timedByScene = new Map<string, TimedElement[]>();
    for (const scene of scenes) {
      const list = computeTimedElements(scene.element, scene.start, fps, scene.end);
      if (list.length) timedByScene.set(scene.id, list);
    }
  }

  if (captureSceneId !== undefined && !scenes.some(scene => scene.id === captureSceneId)) throw new Error('SCENE_CAPTURE_UNAVAILABLE: selected scene does not exist');

  const existingTimeline = timelines.get(timelineId);
  if (existingTimeline && (frozenGroups.get(timelineId) ?? null) !== frozenKey) throw new Error("Frozen timing conflicts with the existing sync group");
  const existingAudio = ownedAudio.get(timelineId);
  if (existingAudio && existingAudio.digest !== verifiedAudio?.digest) throw new Error("Frozen audio conflicts with the existing sync group");
  if (existingTimeline && frozen && (existingTimeline.fps !== fps || existingTimeline.duration !== duration || existingTimeline.clockMode !== "bounded")) {
    throw new Error("Frozen timing conflicts with the existing sync group");
  }
  if (frozen) frozenGroups.set(timelineId, frozenKey!);
  if (verifiedAudio) {
    if (existingAudio) { existingAudio.refs++; mediaAcquired = true; }
    else {
      const url = URL.createObjectURL(new Blob([verifiedAudio.bytes], {type:"audio/wav"}));
      try {
        const audio = document.createElement("audio"); audio.src = url; audio.preload = "auto";
        ownedAudio.set(timelineId, {audio, url, digest:verifiedAudio.digest, refs:1, onError}); mediaAcquired = true;
      } catch (error) { URL.revokeObjectURL(url); throw error; }
    }
  }
  const effectElements=Array.from(importedEl.querySelectorAll('frame-effect')) as HTMLElement[];
  const authoredSeed=effectElements.length ? importedEl.querySelector('voiceover')?.getAttribute('seed') : null;
  if (effectElements.length && authoredSeed != null && authoredSeed !== 'random' && (!/^\d+$/.test(authoredSeed) || Number(authoredSeed)>0xffffffff)) throw new Error('FRAME_EFFECT_INVALID: seed must be uint32 or random');
  if (effectElements.length && authoredSeed === 'random' && !frozen && effectSeed === undefined) throw new Error('FRAME_EFFECT_INVALID: random seed requires frozen timing or an explicit seed');
  const resolvedEffectSeed=frozen?.generationSeed ?? effectSeed ?? (authoredSeed && authoredSeed !== 'random' ? Number(authoredSeed) : 0);
  const declarations=Array.from(importedEl.querySelectorAll('assets > asset'));
  const mountResolvedEffects=(assets:Record<string,unknown>)=>{
    const width=Number(importedEl.getAttribute('width') ?? 1280),height=Number(importedEl.getAttribute('height') ?? 720);
    frameEffects=mountFrameEffects(effectElements,effectRegistry??createBuiltinEffectRegistry(),{width,height,fps,seed:resolvedEffectSeed,assets},element=>{
      for(const scene of scenes){const entry=timedByScene.get(scene.id)?.find(item=>item.element===element);if(entry && Number.isFinite(entry.end))return {startFrame:Math.floor(entry.start*fps),endFrame:Math.ceil(entry.end*fps)};}
      const transitionEntry=frozenTransitions.find(item=>item.element===element);if(transitionEntry && Number.isFinite(transitionEntry.end))return {startFrame:Math.floor(transitionEntry.start*fps),endFrame:Math.ceil(transitionEntry.end*fps)};
      throw new Error('FRAME_EFFECT_INVALID: a bounded interval is required');
    });
  };
  const prepareEffects=async()=>{
    if (!effectElements.length) return;
    const assets:Record<string,unknown>={...(effectAssets ?? {})};const seen=new Set<string>();let total=0;
    if(declarations.length>32) throw new Error('ASSET_INVALID: too many assets');
    for(const element of declarations){
      const id=element.getAttribute('id'),src=element.getAttribute('src'),type=element.getAttribute('media-type');
      if(!id||['__proto__','constructor','prototype'].includes(id)||!/^[A-Za-z][A-Za-z0-9_-]*$/.test(id)||seen.has(id)||!src||!type||! /^(font\/woff2|image\/(png|jpeg|webp|svg\+xml))$/.test(type)||src.startsWith('/')||src.includes('\\')||/[?#:%]/.test(src)||src.split('/').some(part=>!part||part==='.'||part==='..')) throw new Error('ASSET_INVALID: invalid declaration');
      seen.add(id);
      let url: string | URL;
      if(id in assets){const value=assets[id];if(typeof value!=='string'||! /^(blob:|data:)/.test(value))throw new Error('ASSET_INVALID: override must be pre-resolved');url=value;}
      else {const base=new URL(assetBaseUrl ?? document.baseURI,document.baseURI);url=new URL(src,base);if(base.origin!==window.location.origin||url.origin!==window.location.origin)throw new Error('ASSET_INVALID: cross-origin asset');}
      const response=await fetch(url,{signal:effectAbort.signal,redirect:'error',credentials:'omit'});if(!response.ok||response.headers.get('content-type')?.split(';')[0].trim()!==type){await response.body?.cancel().catch(()=>{});throw new Error('ASSET_INVALID: unavailable or wrong media type');}
      const declared=Number(response.headers.get('content-length'));if(declared>16*1024*1024){await response.body?.cancel().catch(()=>{});throw new Error('ASSET_INVALID: file too large');}if (!response.body) throw new Error('ASSET_INVALID: missing body');
      const reader=response.body.getReader(),chunks:ArrayBuffer[]=[];let fileSize=0;
      try {for(;;){const part=await reader.read();if(part.done)break;fileSize+=part.value.byteLength;total+=part.value.byteLength;if(fileSize>16*1024*1024||total>64*1024*1024)throw new Error('ASSET_INVALID: size limit');chunks.push(Uint8Array.from(part.value).buffer);}} catch(error){await reader.cancel().catch(()=>{});throw error;} finally {reader.releaseLock();}
      const bytes=new Uint8Array(fileSize);let offset=0;for(const chunk of chunks){bytes.set(new Uint8Array(chunk),offset);offset+=chunk.byteLength;}
      const tag=(start:number,end:number)=>String.fromCharCode(...bytes.subarray(start,end));
      if(type==='font/woff2'&&tag(0,4)!=='wOF2'||type==='image/png'&&![137,80,78,71,13,10,26,10].every((x,i)=>bytes[i]===x)||type==='image/jpeg'&&![255,216,255].every((x,i)=>bytes[i]===x)||type==='image/webp'&&!(tag(0,4)==='RIFF'&&tag(8,12)==='WEBP'))throw new Error('ASSET_INVALID: media mismatch');
      if(type==='image/svg+xml'){const svg=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(!/^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(svg)||/<\s*(script|style|foreignObject)|<!DOCTYPE|<!ENTITY|\bon\w+\s*=|(?:href|src)\s*=\s*['"]\s*(?!#)|url\s*\(|@import/i.test(svg))throw new Error('ASSET_INVALID: unsupported SVG');}
      if(effectsDisposed)throw new Error('Player disposed');const objectUrl=URL.createObjectURL(new Blob(chunks,{type}));effectUrls.push(objectUrl);assets[id]=objectUrl;
    }
    if(effectsDisposed)throw new Error('Player disposed');
    mountResolvedEffects(assets);
  };
  if(captureSceneId===undefined){
    for(const interval of frozenTransitions.filter(item=>item.element.tagName.toLowerCase()==='transition')){
      const element=interval.element,shader=element.getAttribute('effect') as TransitionShader|null;
      if(!shader)continue;
      if(!shaderNames.includes(shader as any)){if(/^(?:fade|crossfade|cut|scale|zoom|(?:slide|push|wipe)(?:-(?:left|right|up|down))?)$/i.test(shader))continue;throw new Error(`TRANSITION_INVALID: unknown effect ${shader}`);}
      const siblings=Array.from(element.parentElement?.children ?? []),index=siblings.indexOf(element);
      const from=siblings.slice(0,index).reverse().find(node=>node.tagName.toLowerCase()==='scene')?.getAttribute('id');
      const to=siblings.slice(index+1).find(node=>node.tagName.toLowerCase()==='scene')?.getAttribute('id');
      if(!from||!to||!scenes.some(scene=>scene.id===from)||!scenes.some(scene=>scene.id===to))throw new SceneCaptureError('Transition references missing source scenes');
      if(!transitionSourceFactory)throw new SceneCaptureError('Shader transition requires a scene capture provider');
      const raw=element.getAttribute('props');let parameters:unknown={};try{if(raw)parameters=JSON.parse(raw);}catch{throw new Error('TRANSITION_INVALID: invalid props JSON');}
      parameters=validateTransitionOptions(parameters);const easeName=element.getAttribute('ease');const gsap=(gsapModule as any).gsap ?? gsapModule;
      if(easeName&&!/^[A-Za-z][A-Za-z0-9]*(?:\.(?:in|out|inOut))?$/.test(easeName))throw new Error(`TRANSITION_INVALID: unknown easing ${easeName}`);
      const ease=easeName?gsap.parseEase(easeName):undefined;if(easeName&&typeof ease!=='function')throw new Error(`TRANSITION_INVALID: unknown easing ${easeName}`);
      const start=Math.floor(interval.start*fps),end=Math.ceil(interval.end*fps);
      let fromSource:SceneFrameSource|undefined,toSource:SceneFrameSource|undefined;
      try {
        fromSource=transitionSourceFactory(from);toSource=transitionSourceFactory(to);
        const controller=mountSceneCompositor(element as HTMLElement,{from:fromSource,to:toSource,startFrame:start,endFrame:end,width:Number(importedEl.getAttribute('width')??1280),height:Number(importedEl.getAttribute('height')??720),shader,parameters:parameters as any,ease,allowCrossfadeFallback:transitionAllowCrossfadeFallback,onDiagnostic:onTransitionDiagnostic});
        shaderTransitions.push({start,end,controller});
      } catch(error) {for(const source of new Set([fromSource,toSource]))try{source?.dispose();}catch{}throw error;}
    }
  }
  if (effectElements.length && !declarations.length) mountResolvedEffects({...effectAssets});
  const effectsReady=declarations.length ? prepareEffects().catch(error=>{effectAbort.abort();for(const url of effectUrls.splice(0))URL.revokeObjectURL(url);throw error;}) : Promise.resolve();
  void effectsReady.catch(()=>{});


  container.innerHTML = "";
  container.appendChild(importedEl);
  onError?.(null);

  Object.assign(importedEl.style, {
    position: "relative",
    width: "100%",
    height: "100%",
    display: "block",
  });

  for (const scene of scenes) {
    const el = scene.element as HTMLElement;
    Object.assign(el.style, {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
    });
    const sceneStylesRaw = el.getAttribute("styles");
    if (sceneStylesRaw) {
      try {
        const sceneStyles = JSON.parse(sceneStylesRaw);
        applyStyleObject(el, sceneStyles);
      } catch {
        // ignore invalid styles JSON
      }
    }
    const layers = Array.from(el.querySelectorAll("layer"));
    for (const layer of layers) {
      const layerEl = layer as HTMLElement;
      Object.assign(layerEl.style, {
        position: "relative",
        width: "100%",
        height: "100%",
      });
      const layerStylesRaw = layerEl.getAttribute("styles");
      if (layerStylesRaw) {
        try {
          const layerStyles = JSON.parse(layerStylesRaw);
          applyStyleObject(layerEl, layerStyles);
        } catch {
          // ignore invalid styles JSON
        }
      }
    }
  }


  let timeline = timelines.get(timelineId);
  if (!timeline) {
    timeline = createTimeline(timelineId, fps, frozen ? "bounded" : clockMode, loop, duration);
    timelines.set(timelineId, timeline);
    if (!defaultTimeline) defaultTimeline = timeline;
    ensureGlobalTimelines();
  }

  timelineReferences.set(timelineId, (timelineReferences.get(timelineId) ?? 0) + 1);
  (importedEl as any).timeline = timeline;

  let lastActiveSceneId: string | null = null;
  const activeCues = new Set<string>();
  let effectRunning: Promise<void> | null = null;
  let effectFrame: number | null = null;
  let requestedFrame: number | null = null;
  const settleEffects = (frame: number): Promise<void> => {
    if (!effectElements.length && !shaderTransitions.length) return Promise.resolve();
    if (effectRunning && effectFrame === frame && requestedFrame === null) return effectRunning;
    requestedFrame = frame;
    if (!effectRunning) {
      effectRunning = (async () => {
        while (requestedFrame !== null) {
          effectFrame = requestedFrame; requestedFrame = null;
          await effectsReady;
          if (effectsDisposed) throw new Error("Player disposed");
          await frameEffects?.seek(effectFrame);
          await Promise.all(shaderTransitions.filter(transition=>effectFrame!>=transition.start&&effectFrame!<=transition.end).map(transition=>transition.controller.seek(effectFrame!)));
        }
      })().finally(() => { effectRunning = null; effectFrame = null; });
    }
    return effectRunning;
  };
  const handleTick = (timeSec: number) => {
    const frame = timeline.frame;
    void settleEffects(frame).catch(error=>onError?.(`Frame effect failed: ${String(error)}`));
    importedEl.style.setProperty("--video-time", `${timeSec}`);
    importedEl.style.setProperty("--video-frame", `${frame}`);
    importedEl.style.setProperty("--video-fps", `${fps}`);

    let activeSceneId: string | null = null;
    for (let i = 0; i < scenes.length; i += 1) {
      const scene = scenes[i];
      const nextScene = scenes[i + 1];
      const end = scene.end ?? (nextScene ? nextScene.start : null);
      const isActive = captureSceneId === undefined ? timeSec >= scene.start && (end == null || timeSec < end) : scene.id === captureSceneId;
      if (isActive) {
        activeSceneId = scene.id;
        scene.element.removeAttribute("data-runtime-hidden");
        scene.element.setAttribute("data-runtime-active", "true");
        (scene.element as HTMLElement).style.display = "block";
      } else {
        scene.element.setAttribute("data-runtime-hidden", "true");
        scene.element.removeAttribute("data-runtime-active");
        (scene.element as HTMLElement).style.display = "none";
      }
    }

    for (const transition of frozenTransitions) {
      (transition.element as HTMLElement).style.display = captureSceneId === undefined && timeSec >= transition.start && timeSec < transition.end ? "block" : "none";
    }
    if (activeSceneId) {
      const timed = timedByScene.get(activeSceneId) ?? [];
      for (const item of timed) {
        const isVisible = timeSec >= item.start && timeSec < item.end;
        const el = item.element as HTMLElement;
        if (isVisible) {
          const original = el.getAttribute("data-videoml-display");
          if (original != null) {
            el.style.display = original;
          } else {
            el.style.removeProperty("display");
          }
        } else {
          if (!el.hasAttribute("data-videoml-display")) {
            el.setAttribute("data-videoml-display", el.style.display || "");
          }
          el.style.display = "none";
        }
      }
    }

    dispatchDomEvent(importedEl, "timeline:tick", { frame, time: timeSec, fps });

    for (const cue of cues) {
      const cueEnd = cue.end;
      const isActive = timeSec >= cue.start && (cueEnd == null || timeSec < cueEnd);
      const wasActive = activeCues.has(cue.id);
      if (isActive && !wasActive) {
        activeCues.add(cue.id);
        dispatchDomEvent(importedEl, "cue:start", { cueId: cue.id, time: timeSec, frame });
      } else if (!isActive && wasActive) {
        activeCues.delete(cue.id);
        dispatchDomEvent(importedEl, "cue:end", { cueId: cue.id, time: timeSec, frame });
      }
    }

    if (activeSceneId !== lastActiveSceneId) {
      if (lastActiveSceneId) {
        dispatchDomEvent(importedEl, "scene:end", { sceneId: lastActiveSceneId, time: timeSec, frame });
      }
      if (activeSceneId) {
        dispatchDomEvent(importedEl, "scene:start", { sceneId: activeSceneId, time: timeSec, frame });
      }
      lastActiveSceneId = activeSceneId;
    }

    if (onTimeUpdate) onTimeUpdate(timeSec, duration ?? 0);
  };

  const unsubscribe = timeline.subscribe(handleTick);

  const handlerCleanups: Array<() => void> = [];
  let observerRaf: number | null = null;
  let pendingSerialize = false;
  let pendingRebind = false;

  const flushObserver = () => {
    observerRaf = null;
    if (pendingRebind) {
      if (!frozen) bindInlineHandlers(importedEl, timeline, handlerCleanups);
      pendingRebind = false;
    }
    if (pendingSerialize && onXmlChange) {
      const serialized = serializeXml(importedEl);
      onXmlChange(serialized);
      pendingSerialize = false;
    }
  };

  const observer = new MutationObserver((records) => {
    let shouldProcess = false;
    for (const record of records) {
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      if (target && shouldIgnore(target)) continue;
      shouldProcess = true;
      break;
    }
    if (!shouldProcess) return;
    pendingRebind = true;
    if (onXmlChange) pendingSerialize = true;
    if (observerRaf == null) {
      observerRaf = requestAnimationFrame(flushObserver);
    }
  });

  observer.observe(importedEl, { subtree: true, childList: true, attributes: true, characterData: true });

  if (!frozen) bindInlineHandlers(importedEl, timeline, handlerCleanups);

  let disposed = false;
  const participant=timeline.registerParticipant(async frame=>{
    await settleEffects(frame);
    await settleFrame?.(frame,importedEl);
    if (disposed) return;
    await document.fonts?.ready;
    await Promise.all(Array.from(importedEl.querySelectorAll("img")).map(image => image.decode()));
  });
  if (autoPlay) timeline.start();
  return {
    seek(frame) {
      if (disposed) return Promise.reject(new Error("Player disposed"));
      return timeline.seekSettled(frame,participant);
    },
    pause() { if (!disposed) timeline.stop(); },
    dispose() {
      if (disposed) return; disposed = true;
      effectsDisposed=true;effectAbort.abort();for(const url of effectUrls) URL.revokeObjectURL(url);
      let disposeError: unknown;
      try { frameEffects?.dispose(); } catch (error) { disposeError = error; }
      for(const transition of shaderTransitions)try{transition.controller.dispose();}catch(error){disposeError ??= error;}
      timeline.unregisterParticipant(participant);
      unsubscribe(); observer.disconnect();
      for (const cleanup of handlerCleanups) cleanup(); handlerCleanups.length = 0;
      if (observerRaf != null) cancelAnimationFrame(observerRaf);
      if (mediaAcquired) releaseOwnedAudio(timelineId);
      const remaining = (timelineReferences.get(timelineId) ?? 1) - 1;
      if (remaining === 0) {
        timeline.stop(); timelineReferences.delete(timelineId); timelines.delete(timelineId); frozenGroups.delete(timelineId);
        if (defaultTimeline === timeline) { defaultTimeline = timelines.values().next().value ?? null; if (typeof window !== "undefined") (window as any).timeline = defaultTimeline; }
      } else timelineReferences.set(timelineId, remaining);
      if (disposeError) throw disposeError;
    },
  };
  } catch (error) {
    effectsDisposed=true;effectAbort.abort();for(const url of effectUrls) URL.revokeObjectURL(url);
    try { frameEffects?.dispose(); } catch {}
    for(const transition of shaderTransitions)try{transition.controller.dispose();}catch{}
    if (mediaAcquired) releaseOwnedAudio(timelineId);
    if (!timelines.has(timelineId)) frozenGroups.delete(timelineId);
    throw error;
  }
}

function releaseOwnedAudio(timelineId: string): void {
  const owner = ownedAudio.get(timelineId);
  if (!owner || --owner.refs > 0) return;
  owner.audio.pause(); owner.audio.removeAttribute("src"); owner.audio.load();
  URL.revokeObjectURL(owner.url); ownedAudio.delete(timelineId);
}

/** Match explicit source IDs to frozen intervals without consulting XML timing attributes. */
export function resolveFrozenDom(root: Element, timing: ResolvedTiming): {scenes: SceneTiming[]; cues: CueTiming[]; duration: number; fps: number; timedByScene: Map<string, TimedElement[]>; transitions: TimedElement[]} {
  validateResolvedTiming(timing);
  const intervals = new Map([...timing.scenes, ...timing.cues, ...timing.layers, ...timing.components, ...timing.transitions].map(item => [item.id,item]));
  const seen = new Set<string>();
  const ordered = new Map<string, string[]>();
  const get = (kind: string, path: string[]) => {
    const id = qualifiedTimingId(kind,path), interval = intervals.get(id);
    if (!interval || seen.has(id)) throw new Error(`Missing or duplicate frozen interval: ${id}`);
    seen.add(id);
    const category = kind === "transition-layer" ? "layer" : kind === "transition-component" ? "component" : kind;
    const values = ordered.get(category) ?? []; values.push(id); ordered.set(category, values);
    return {start: interval.startFrame / timing.fps, end: interval.endFrame / timing.fps};
  };
  const requireId = (element: Element) => { const id=element.getAttribute("id"); if (!id) throw new Error(`Missing explicit ID on ${element.tagName}`); return id; };
  const scenes: SceneTiming[] = [];
  const cues: CueTiming[] = [];
  const timedByScene = new Map<string, TimedElement[]>();
  const builtin = new Set(["video","scene","cue","layer","pause","voice","bullet","voiceover","sequence","stack","transition","mark","narration","audio","sfx","music"]);
  for (const scene of Array.from(root.querySelectorAll("scene"))) {
    const id = requireId(scene), range = get("scene", [id]); scenes.push({id,...range,element:scene});
    const timed: TimedElement[] = [];
    const visit = (container: Element, layerId?: string) => {
      const children = Array.from(container.children).sort((a,b) => Number(b.tagName.toLowerCase() === "layer") - Number(a.tagName.toLowerCase() === "layer"));
      for (const child of children) {
        const tag=child.tagName.toLowerCase();
        if (tag === "layer") { const lid=requireId(child); timed.push({element:child,...get("layer",[id,lid])}); visit(child,lid); }
        else if (tag === "sequence" || tag === "stack") visit(child,layerId);
        else if (!builtin.has(tag)) { const cid=requireId(child); timed.push({element:child,...get("component",layerId ? [id,layerId,cid] : [id,cid])}); }
      }
    };
    visit(scene); timedByScene.set(id,timed);
  }
  for (const cue of Array.from(root.querySelectorAll("cue"))) { const id=requireId(cue); cues.push({id,...get("cue",[id]),element:cue}); }
  const transitions: TimedElement[] = [];
  for (const element of Array.from(root.querySelectorAll("transition"))) {
    const tid = requireId(element); transitions.push({element,...get("transition",[tid])});
    const visitTransition = (container: Element, layerId?: string) => {
      const children = Array.from(container.children).sort((a,b) => Number(b.tagName.toLowerCase() === "layer") - Number(a.tagName.toLowerCase() === "layer"));
      for (const child of children) {
        const tag = child.tagName.toLowerCase();
        if (tag === "layer") { const lid=requireId(child); transitions.push({element:child,...get("transition-layer",[tid,lid])}); visitTransition(child,lid); }
        else if (tag === "sequence" || tag === "stack") visitTransition(child,layerId);
        else if (!builtin.has(tag)) { const cid=requireId(child); transitions.push({element:child,...get("transition-component",layerId ? [tid,layerId,cid] : [tid,cid])}); }
      }
    };
    visitTransition(element);
  }
  if (seen.size !== intervals.size) throw new Error("Frozen timing does not match source IDs");
  for (const [kind, entries] of [["scene",timing.scenes],["cue",timing.cues],["layer",timing.layers],["component",timing.components],["transition",timing.transitions]] as const) {
    if (JSON.stringify(ordered.get(kind) ?? []) !== JSON.stringify(entries.map(entry=>entry.id))) throw new Error(`Frozen ${kind} order does not match source`);
  }
  return {scenes,cues,timedByScene,transitions,fps:timing.fps,duration:timing.durationFrames/timing.fps};
}
