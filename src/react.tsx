"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { mountVmlPlayer, createVerifiedVmlPlayerController, type VmlPlayerOptions } from "./runtime.js";

export type VideomlDomPlayerProps = Omit<VmlPlayerOptions, "onError"> & {
  width?: number;
  height?: number;
  className?: string;
  loadAudio?: (path: string) => Promise<ArrayBuffer>;
  loadCompositionAudio?: () => Promise<ArrayBuffer>;
};

export function VideomlDomPlayer({
  xml,
  width = 1280,
  height = 720,
  autoPlay = true,
  clockMode = "live",
  loop = false,
  syncGroup,
  onTimeUpdate,
  onXmlChange,
  resolvedTiming,
  loadAudio,
  loadCompositionAudio,
  className,
}: VideomlDomPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const timelineId = useMemo(() => syncGroup ?? `timeline-${Math.random().toString(36).slice(2)}`, [syncGroup]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const options = {xml, autoPlay, clockMode, loop, syncGroup: timelineId, onTimeUpdate, onXmlChange, onError: setError};
    if (!resolvedTiming) return mountVmlPlayer(container, options);
    if (!loadAudio && resolvedTiming.segments.length) { setError("Frozen timing requires a segment audio loader"); return; }
    if (!loadCompositionAudio && resolvedTiming.audioTotalSamples) { setError("Frozen timing requires a composition audio loader"); return; }
    let cancelled = false;
    const abort = new AbortController();
    let cleanup: (() => void) | undefined;
    void createVerifiedVmlPlayerController(container, {...options, resolvedTiming}, loadAudio ?? (async () => { throw new Error("No segment audio loader"); }), loadCompositionAudio, abort.signal)
      .then(controller => { if (cancelled) controller.dispose(); else cleanup = () => controller.dispose(); })
      .catch(error => { if (!cancelled) setError(error instanceof Error ? error.message : String(error)); });
    return () => { cancelled = true; abort.abort(); cleanup?.(); };
  }, [xml, autoPlay, clockMode, loop, timelineId, onTimeUpdate, onXmlChange, resolvedTiming, loadAudio, loadCompositionAudio]);

  const aspectRatio = width && height ? `${width} / ${height}` : undefined;
  return (
    <div
      ref={containerRef}
      className={className}
      style={{
        width: "100%",
        height: "auto",
        aspectRatio,
        overflow: "hidden",
        position: "relative",
      }}
    >
      {error && (
        <div className="flex h-full w-full items-center justify-center rounded-2xl bg-muted p-6 text-center text-sm text-muted-foreground">
          {error}
        </div>
      )}
    </div>
  );
}
