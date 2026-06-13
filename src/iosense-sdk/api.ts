import { BindingEntry, SeriesPayload, SeriesMeta, SeriesSlot } from './types';

const STAGING_BASE = 'https://stagingsv.iosense.io/api';
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
  // Diagnostic log — confirms time window + resolution are actually sent on every call.
  console.log('[API] resolveAndCompute →', {
    startTime: new Date(startTime).toISOString(),
    endTime: new Date(endTime).toISOString(),
    durationMs: endTime - startTime,
    resolution,
    timeFrame: body.timeFrame,
    bindingCount: config.length,
    bindings: config.map((b) => ({
      key: b.key,
      type: 'type' in b ? b.type : 'scalar',
      hasAggregation: 'aggregation' in b,
    })),
  });
  const res = await fetch(`${STAGING_BASE}/account/uns/resolveAndCompute`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: bearer(authentication),
    },
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
