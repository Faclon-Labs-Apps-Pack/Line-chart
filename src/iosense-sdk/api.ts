import { BindingEntry, SeriesPayload, SeriesMeta, SeriesSlot } from './types';

// ---------------------------------------------------------------------------
// Token + API-base capture — reads the Bearer token AND the API base URL from
// the Angular DataLayer's own HTTP calls. Using the captured base URL (not a
// hardcoded one) ensures our comparison fetch targets the same server the
// DataLayer targets, regardless of environment (staging vs production).
// ---------------------------------------------------------------------------
let _capturedToken = '';
let _capturedApiBase = '';
export function getCapturedToken(): string { return _capturedToken; }
export function getCapturedApiBase(): string { return _capturedApiBase; }

function _extractBase(url: string) {
  if (!_capturedApiBase) {
    const m = url.match(/^(https?:\/\/[^/]+\/api)/i);
    if (m) _capturedApiBase = m[1];
  }
}

if (typeof window !== 'undefined') {
  // XHR path — intercept open() for URL, setRequestHeader for token
  const _xhrUrls = new WeakMap<XMLHttpRequest, string>();
  const _origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method: string, url: string, ...args: unknown[]) {
    _xhrUrls.set(this, url);
    return (_origOpen as Function).call(this, method, url, ...args);
  };
  const _origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function(name: string, value: string) {
    if (/^authorization$/i.test(name) && /^bearer /i.test(value)) {
      _capturedToken = value;
      _extractBase(_xhrUrls.get(this) ?? '');
    }
    return _origSetHeader.call(this, name, value);
  };

  // fetch path (Angular 16+ HttpClient default)
  const _origFetch = window.fetch.bind(window);
  window.fetch = function(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    if (init?.headers) {
      const tryExtract = (name: string, value: string) => {
        if (/^authorization$/i.test(name) && /^bearer /i.test(value)) {
          _capturedToken = value;
          _extractBase(url);
        }
      };
      if (init.headers instanceof Headers) {
        try { (init.headers as Headers).forEach((v, k) => tryExtract(k, v)); } catch { /* ignore */ }
      } else if (Array.isArray(init.headers)) {
        (init.headers as string[][]).forEach(([k, v]) => tryExtract(k, v));
      } else {
        const h = init.headers as Record<string, string>;
        Object.keys(h).forEach((k) => tryExtract(k, h[k]));
      }
    }
    return _origFetch(input, init);
  };
}

// In dev (localhost) use the staging server. In production Lens the frontend
// and API are on separate domains — the API is always appserver.iosense.io
// regardless of what domain Lens is hosted on (matches DataLayer hardcoding).
function getApiBase(): string {
  if (typeof window === 'undefined') return 'https://stagingsv.iosense.io/api';
  const h = window.location.hostname;
  if (h === 'localhost' || h === '127.0.0.1') return 'https://stagingsv.iosense.io/api';
  if (h.includes('stagingsv') || h.includes('staging')) return 'https://stagingsv.iosense.io/api';
  return 'https://appserver.iosense.io/api';
}
const STAGING_BASE = getApiBase();
const GRAPH = 'iosense_test_uns';


// Lens injects `authentication` already prefixed with "Bearer ". Dev harness
// stores the raw JWT. Normalize at every call site so the Authorization header
// is never "Bearer Bearer …".
function bearer(token: string): string {
  const t = (token || '').trim();
  return t.toLowerCase().startsWith('bearer ') ? t : `Bearer ${t}`;
}

function isRawSeriesItem(item: Record<string, unknown>): boolean {
  return Array.isArray(item.slots);
}

export async function validateSSOToken(ssoToken: string): Promise<string> {
  const res = await fetch(`${STAGING_BASE}/account/validateSSO`, {
    method: 'GET',
    headers: { token: ssoToken },
  });
  const json = await res.json();
  if (!json.success || !json.token) throw new Error('SSO validation failed');
  return json.token;
}

export async function resolveAndCompute(
  authentication: string,
  config: Array<BindingEntry>,
  startTime: number,
  endTime: number,
  /** Backend resolution value (e.g. 'hour', 'day') — mapped from widget periodicity in the mini-engine. */
  resolution?: string,
): Promise<Array<{ key: string; value: string | number | null | SeriesPayload }>> {
  const body: Record<string, unknown> = { graph: GRAPH, config, startTime, endTime };
  if (resolution) {
    // Send under multiple field names so whichever the backend accepts wins.
    // `timeFrame` matches getWidgetData; `resolution` matches SeriesAggregation.
    body.timeFrame = resolution;
    body.resolution = resolution;
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authentication) headers.Authorization = bearer(authentication);

  // Prefer the URL base captured from the DataLayer's own calls — guarantees
  // we hit the same server that issued the token, regardless of environment.
  const apiBase = _capturedApiBase || STAGING_BASE;
  const res = await fetch(`${apiBase}/account/uns/resolveAndCompute`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `resolveAndCompute HTTP ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 300)}` : ''}`,
    );
  }
  const json = await res.json();
  const rawItems: Record<string, unknown>[] = json?.data ?? [];
  return rawItems.map((item) => {
    if (isRawSeriesItem(item)) {
      return {
        key: item.key as string,
        value: {
          __type: 'series' as const,
          path: item.path as string,
          meta: item.meta as SeriesMeta,
          range: item.range as { from: number; to: number },
          slots: item.slots as SeriesSlot[],
        } satisfies SeriesPayload,
      };
    }
    return { key: item.key as string, value: item.value as string | number | null };
  });
}

export async function fetchUNSNodes(
  authentication: string,
  graph: string,
  label?: string,
  limit = 100,
  expandPostfix = false,
): Promise<Array<{ id: string; type: string; name?: string; path: string | null; parentId: string | null }>> {
  const params = new URLSearchParams({ graph, limit: String(limit) });
  if (label) params.set('label', label);
  if (expandPostfix) params.set('expandPostfix', 'true');
  const res = await fetch(`${STAGING_BASE}/account/uns/nodes?${params}`, {
    headers: { Authorization: bearer(authentication) },
  });
  // Without an explicit ok check, a 401/403 returning `{ success: false }` would
  // cache an empty workspace map and silently break the UNS dropdown forever
  // (only a page reload would clear it). Throw so the caller's catch path runs
  // and the cache stays null, letting the next onOpen retry.
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `fetchUNSNodes HTTP ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 300)}` : ''}`,
    );
  }
  const json = await res.json();
  if (json && json.success === false) {
    throw new Error(`fetchUNSNodes returned success:false — ${JSON.stringify(json).slice(0, 300)}`);
  }
  return (json?.data?.data ?? []) as Array<{
    id: string; type: string; name?: string; path: string | null; parentId: string | null;
  }>;
}
