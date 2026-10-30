import { executeVomXml } from "./xml.js";
import { registerFallbackComponents, registerVideoMLComponents } from "@videoml/stdlib/dom";

export type VmlPlayerOptions = {
  xml: string;
  autoPlay?: boolean;
  clockMode?: "bounded" | "live";
  loop?: boolean;
  syncGroup?: string;
  onTimeUpdate?: (timeSec: number, durationSec: number) => void;
  onXmlChange?: (xml: string) => void;
  onError?: (message: string | null) => void;
  settleFrame?: (frame:number, root:HTMLElement) => Promise<void>;
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
    subs.forEach((fn) => fn(time));
    if (running) {
      raf = requestAnimationFrame(tick);
    }
  };

  const timeline: Timeline = {
    id,
    fps,
    get frame() {
      return frame;
    },
    get time() {
      return time;
    },
    start() {
      if (running) return;
      running = true;
      lastTs = null;
      raf = requestAnimationFrame(tick);
    },
    stop() {
      running = false;
      if (raf != null) cancelAnimationFrame(raf);
      raf = null;
      lastTs = null;
    },
    seek(nextFrame) {
      if (!Number.isSafeInteger(nextFrame) || nextFrame < 0) throw new Error("Frame must be a nonnegative integer");
      frame = nextFrame; time = frame / fps; lastTs = null;
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

const computeTimedElements = (sceneEl: Element, sceneStart: number, fps: number): TimedElement[] => {
  const timed: TimedElement[] = [];

  const walk = (container: Element, baseStart: number, flow: "sequence" | "stack") => {
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

      if (localEnd != null) {
        timed.push({ element: child, start: localStart, end: localEnd });
      } else if (flow === "sequence") {
        const fallbackEnd = localStart + defaultChildDuration;
        timed.push({ element: child, start: localStart, end: fallbackEnd });
        localEnd = fallbackEnd;
      }

      // Recurse into container-like nodes or layers to time nested elements
      if (tag === "sequence" || tag === "stack" || tag === "layer" || tag === "scene") {
        walk(child, localStart, childFlow);
      }

      if (flow === "sequence") {
        cursor = localEnd ?? cursor;
      }
    }
  };

  walk(sceneEl, sceneStart, "stack");
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
  const msMatch = value.match(/^([0-9]*\\.?[0-9]+)ms$/);
  if (msMatch) return Number.parseFloat(msMatch[1]) / 1000;
  const sMatch = value.match(/^([0-9]*\\.?[0-9]+)s$/);
  if (sMatch) return Number.parseFloat(sMatch[1]);
  const fMatch = value.match(/^([0-9]*\\.?[0-9]+)f$/);
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
  for (const sceneEl of sceneElements) {
    const id = sceneEl.getAttribute("id") ?? "";
    const startAttr = parseTimeSeconds(sceneEl.getAttribute("start"), fps);
    const start = startAttr != null ? startAttr : cursor;
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
  } = options;

  const timelineId = syncGroup ?? `timeline-${Math.random().toString(36).slice(2)}`;

  registerVideoMLComponents();
  container.innerHTML = "";
  onError?.(null);

  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, "text/html");
  const root = doc.body.querySelector("vml, videoml, video-ml");
  if (!root) {
    onError?.("XML root must be <vml>, <videoml>, or <video-ml>.");
    return { seek: async () => { throw new Error("Player has no valid XML root"); }, pause: () => {}, dispose: () => {} };
  }

  let imported = document.importNode(root, true) as Element;
  registerFallbackComponents(imported);
  container.appendChild(imported);
  if (!(imported instanceof HTMLElement)) {
    const wrapper = document.createElement("div");
    wrapper.appendChild(imported);
    imported = wrapper;
  }
  const importedEl = imported as HTMLElement;
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

  const { scenes, cues, duration, fps } = computeSceneTimings(xml, importedEl);
  const timedByScene = new Map<string, TimedElement[]>();
  for (const scene of scenes) {
    const list = computeTimedElements(scene.element, scene.start, fps);
    if (list.length) timedByScene.set(scene.id, list);
  }

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
    timeline = createTimeline(timelineId, fps, clockMode, loop, duration);
    timelines.set(timelineId, timeline);
    if (!defaultTimeline) defaultTimeline = timeline;
    ensureGlobalTimelines();
  }

  timelineReferences.set(timelineId, (timelineReferences.get(timelineId) ?? 0) + 1);
  (importedEl as any).timeline = timeline;

  let lastActiveSceneId: string | null = null;
  const activeCues = new Set<string>();
  const handleTick = (timeSec: number) => {
    const frame = timeline.frame;
    importedEl.style.setProperty("--video-time", `${timeSec}`);
    importedEl.style.setProperty("--video-frame", `${frame}`);
    importedEl.style.setProperty("--video-fps", `${fps}`);

    let activeSceneId: string | null = null;
    for (let i = 0; i < scenes.length; i += 1) {
      const scene = scenes[i];
      const nextScene = scenes[i + 1];
      const end = scene.end ?? (nextScene ? nextScene.start : null);
      const isActive = timeSec >= scene.start && (end == null || timeSec < end);
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
      bindInlineHandlers(importedEl, timeline, handlerCleanups);
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

  bindInlineHandlers(importedEl, timeline, handlerCleanups);

  let disposed = false;
  const participant=timeline.registerParticipant(async frame=>{
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
      timeline.unregisterParticipant(participant);
      unsubscribe(); observer.disconnect();
      for (const cleanup of handlerCleanups) cleanup(); handlerCleanups.length = 0;
      if (observerRaf != null) cancelAnimationFrame(observerRaf);
      const remaining = (timelineReferences.get(timelineId) ?? 1) - 1;
      if (remaining === 0) {
        timeline.stop(); timelineReferences.delete(timelineId); timelines.delete(timelineId);
        if (defaultTimeline === timeline) { defaultTimeline = timelines.values().next().value ?? null; if (typeof window !== "undefined") (window as any).timeline = defaultTimeline; }
      } else timelineReferences.set(timelineId, remaining);
    },
  };
}
