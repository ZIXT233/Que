"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { mergeQueueSnapshot, QUEUE_SSE_REFRESH_MS, queueFallbackPollMs, queuePollIntervalMs } from "@/lib/card-queue-snapshot";
import type { CardQueue } from "@/lib/card-queue";
import { useI18n } from "@/hooks/useI18n";

async function readJsonResponse<T>(response: Response): Promise<T> {
  const body = await response.text();
  if (!body.trim()) throw new Error(response.ok ? "服务返回了空响应" : `本地服务请求失败 (${response.status})`);
  try { return JSON.parse(body) as T; }
  catch { throw new Error(response.ok ? "本地服务返回了无效数据" : `本地服务请求失败 (${response.status})`); }
}

export function useCardQueue() {
  const { t } = useI18n();
  const [queue, setQueue] = useState<CardQueue | null>(null);
  const [defaultCwd, setDefaultCwd] = useState("");
  const [error, setError] = useState("");
  const mounted = useRef(false);
  const bootstrapped = useRef(false);
  const localGeneration = useRef(0);
  const lifetime = useRef(0);
  const queueRef = useRef<CardQueue | null>(null);
  const request = useRef<{ generation: number; controller: AbortController; promise: Promise<void> } | null>(null);
  const accept = useCallback((next: CardQueue & { defaultCwd?: string }) => {
    if (!mounted.current) return;
    setQueue((previous) => {
      const merged = mergeQueueSnapshot(previous, next);
      queueRef.current = merged;
      return merged;
    });
    if (next.defaultCwd) setDefaultCwd((current) => current === next.defaultCwd ? current : next.defaultCwd!);
  }, []);
  const refresh = useCallback((): Promise<void> => {
    if (!mounted.current) return Promise.resolve();
    const generation = localGeneration.current;
    if (request.current?.generation === generation) return request.current.promise;
    request.current?.controller.abort();
    const controller = new AbortController();
    const current = { generation, controller, promise: Promise.resolve() };
    request.current = current;
    const bootstrap = !bootstrapped.current;
    current.promise = (async () => {
      try {
        const response = await fetch(bootstrap ? "/api/card-queue/bootstrap" : "/api/card-queue", { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) });
        const data = await readJsonResponse<CardQueue & { defaultCwd?: string; error?: string }>(response);
        if (controller.signal.aborted || generation !== localGeneration.current) return;
        if (!response.ok) throw new Error(data.error || t("queue.connectFailed"));
        accept(data);
        bootstrapped.current = true;
        if (mounted.current) setError("");
      } catch (error) {
        if (!controller.signal.aborted && mounted.current && generation === localGeneration.current)
          setError(error instanceof Error && error.name === "TimeoutError" ? t("queue.connectTimeout") : error instanceof Error ? error.message : String(error));
      } finally {
        if (request.current === current) request.current = null;
        if (bootstrap && bootstrapped.current && !controller.signal.aborted) void refresh();
      }
    })();
    return current.promise;
  }, [accept, t]);
  const act = useCallback(async (action: string, data: Record<string, unknown> = {}) => {
    const generation = localGeneration.current;
    const owner = lifetime.current;
    const response = await fetch("/api/card-queue", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...data }),
    });
    const result = await readJsonResponse<CardQueue & { error?: string; code?: string; prompt?: string; detail?: string }>(response);
    if (!response.ok) throw Object.assign(new Error(result.error || "操作失败"), { code: result.code, prompt: result.prompt, detail: result.detail });
    if (mounted.current && owner === lifetime.current) {
      if (generation === localGeneration.current) accept(result);
      else void refresh();
    }
    // `create` names the card it made; `butler_open` the Butler card, or null when there is none yet.
    return result as CardQueue & { createdId?: string; butlerId?: string | null };
  }, [accept, refresh]);
  useEffect(() => {
    mounted.current = true;
    lifetime.current += 1;
    let disposed = false;
    let cycle = 0;
    let live = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const events = new EventSource("/api/card-queue/events");
    let sseRefresh: ReturnType<typeof setTimeout> | undefined;
    const scheduleLiveRefresh = () => {
      if (disposed || sseRefresh) return;
      sseRefresh = setTimeout(() => {
        sseRefresh = undefined;
        if (!disposed) void refresh();
      }, QUEUE_SSE_REFRESH_MS);
    };
    events.onopen = () => { live = true; };
    events.onmessage = () => { if (!disposed) scheduleLiveRefresh(); };
    events.onerror = () => { live = events.readyState !== EventSource.CLOSED; };
    const poll = async (owner: number) => {
      if (disposed) return;
      await refresh();
      if (!disposed && owner === cycle)
        timer = setTimeout(() => void poll(owner), live
          ? queueFallbackPollMs(document.visibilityState === "visible", true)
          : queuePollIntervalMs(queueRef.current, document.visibilityState === "visible"));
    };
    const reconcile = () => {
      clearTimeout(timer);
      cycle += 1;
      void poll(cycle);
    };
    reconcile();
    window.addEventListener("online", reconcile);
    document.addEventListener("visibilitychange", reconcile);
    return () => {
      disposed = true;
      mounted.current = false;
      lifetime.current += 1;
      clearTimeout(sseRefresh);
      clearTimeout(timer);
      events.close();
      request.current?.controller.abort();
      request.current = null;
      window.removeEventListener("online", reconcile);
      document.removeEventListener("visibilitychange", reconcile);
    };
  }, [refresh]);
  return { queue, defaultCwd, error, refresh, act };
}
