let apiBase = "";
let apiToken = "";

export function getApiBase() {
  return apiBase;
}

/** Where Que's API is, and the token every request to it must carry (see require_token). */
export function setApiAccess(base: string, token: string) {
  apiBase = base.replace(/\/$/, "");
  apiToken = token;
}

export function apiUrl(path: string) {
  if (/^https?:\/\//.test(path)) return path;
  return `${apiBase}${path}`;
}

/** An API URL for requests that cannot carry a header: EventSource, sendBeacon. */
export function apiUrlWithToken(path: string) {
  const url = apiUrl(path);
  return `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(apiToken)}`;
}

const isApi = (url: string) => !!apiBase && url.startsWith(`${apiBase}/api/`);

export function installApiInterceptor() {
  const originalFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === "string" && input.startsWith("/")) input = apiUrl(input);
    else if (input instanceof URL && input.origin === window.location.origin && input.pathname.startsWith("/api/")) {
      input = new URL(apiUrl(`${input.pathname}${input.search}`));
    } else if (input instanceof Request && input.url.startsWith(window.location.origin) && new URL(input.url).pathname.startsWith("/api/")) {
      const url = new URL(input.url);
      input = new Request(apiUrl(`${url.pathname}${url.search}`), input);
    }
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (isApi(url)) {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      headers.set("x-que-token", apiToken);
      init = { ...init, headers };
    }
    return originalFetch(input, init);
  }) as typeof window.fetch;

  const OriginalEventSource = window.EventSource;
  window.EventSource = class extends OriginalEventSource {
    constructor(url: string | URL, eventSourceInitDict?: EventSourceInit) {
      const href = typeof url === "string" ? url : url.toString();
      super(href.startsWith("/") ? apiUrlWithToken(href) : href, eventSourceInitDict);
    }
  } as typeof EventSource;
}
