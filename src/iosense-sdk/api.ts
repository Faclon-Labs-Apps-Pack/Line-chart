import { BindingEntry, SeriesPayload, SeriesMeta, SeriesSlot } from './types';

const STAGING_BASE = 'https://stagingsv.iosense.io/api';
const GRAPH = 'iosense_test_uns';

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
  const res = await fetch(`${STAGING_BASE}/account/uns/resolveAndCompute`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authentication}`,
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
    headers: { Authorization: `Bearer ${authentication}` },
  });
  const json = await res.json();
  return (json?.data?.data ?? []) as Array<{
    id: string; type: string; name?: string; path: string | null; parentId: string | null;
  }>;
}
