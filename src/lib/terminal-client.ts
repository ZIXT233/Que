import { oscTrace } from "./app-log";

export function isTerminalAbortError(error: unknown) {
  return (error instanceof DOMException && error.name === "AbortError")
    || (error instanceof Error && /abort/i.test(error.message));
}

export async function terminalRequest(path: string, options?: RequestInit): Promise<{ id?: string; cwd?: string; readOnly?: boolean }> {
  const response = await fetch(path, { ...options, signal: options?.signal ?? AbortSignal.timeout(15_000) });
  const data = await response.json().catch(() => {
    throw new Error(`Terminal request failed (HTTP ${response.status}): server returned an empty or invalid JSON response. Check the Que server log.`);
  });
  if (!data || typeof data !== "object") throw new Error(`Terminal request failed (HTTP ${response.status}): invalid JSON response. Check the Que server log.`);
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

export function createTerminalWriter(id: string, onError: (error: Error) => void) {
  let pending = Promise.resolve();
  let stopped = false;
  const replyRequests = new Set<AbortController>();
  let bufferedInput: { type: "input"; data: string } | null = null;
  const enqueue = (body: Record<string, unknown> | FormData | (() => Promise<Record<string, unknown>>)) => {
    if (stopped) return;
    pending = pending.then(async () => {
      if (body === bufferedInput) bufferedInput = null;
      const payload = typeof body === "function" ? await body() : body;
      // OSC color-query experiment: dump what is actually about to go over
      // the wire, after any keystroke coalescing, right before the POST.
      if (!(payload instanceof FormData) && payload.type === "input" && typeof payload.data === "string") {
        oscTrace("http-post", payload.data, { term: id });
      }
      const multipart = payload instanceof FormData;
      await terminalRequest(`/api/terminal/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: multipart ? undefined : { "Content-Type": "application/json" },
        body: multipart ? payload : JSON.stringify(payload),
        ...((multipart || payload.type === "images") ? { signal: AbortSignal.timeout(240_000) } : {}),
      });
    }).catch((error: Error) => {
      // Delivery is ambiguous after a network error. Never replay shell input.
      stopped = true;
      onError(error);
    });
  };
  return {
    reply(data: string) {
      if (stopped) return;
      // CLI probes have short deadlines. Do not queue responses behind resize,
      // image uploads or animation-frame keystroke batching.
      const controller = new AbortController();
      replyRequests.add(controller);
      oscTrace("http-reply", data, { term: id });
      void terminalRequest(`/api/terminal/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "input", data }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      }).catch((error: Error) => {
        if (stopped || controller.signal.aborted) return;
        stopped = true;
        onError(error);
      }).finally(() => replyRequests.delete(controller));
    },
    write(data: string) {
      if (stopped) return;
      for (const chunk of data.match(/[\s\S]{1,32768}/gu) ?? []) {
        if (bufferedInput && bufferedInput.data.length + chunk.length <= 65536) bufferedInput.data += chunk;
        else {
          bufferedInput = { type: "input", data: chunk };
          enqueue(bufferedInput);
        }
      }
    },
    writeBinary(data: string) {
      if (stopped) return;
      bufferedInput = null;
      for (let offset = 0; offset < data.length; offset += 32768) {
        const chunk = data.slice(offset, offset + 32768);
        enqueue({ type: "input_binary", data: Array.from(chunk, char => char.charCodeAt(0) & 0xff) });
      }
    },
    pasteImages(files: File[], bracketed: boolean) {
      bufferedInput = null;
      enqueue(async () => ({
        type: "images", bracketed,
        images: await Promise.all(files.map(async (file) => {
          const bytes = new Uint8Array(await file.arrayBuffer());
          let binary = "";
          for (const byte of bytes) binary += String.fromCharCode(byte);
          return { type: "image", mimeType: file.type, data: btoa(binary) };
        })),
      }));
    },
    pasteFiles(files: File[], bracketed: boolean) {
      bufferedInput = null;
      const form = new FormData();
      for (const file of files) form.append("files", file, file.name);
      form.append("bracketed", String(bracketed));
      enqueue(form);
    },
    resize(cols: number, rows: number) {
      bufferedInput = null;
      enqueue({ type: "resize", cols, rows });
    },
    stop() {
      stopped = true;
      for (const request of replyRequests) request.abort();
      replyRequests.clear();
      return pending;
    },
  };
}
