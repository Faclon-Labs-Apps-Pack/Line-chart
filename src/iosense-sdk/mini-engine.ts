import { LineChartEnvelope, LineChartUIConfig, DataEntry, SeriesPayload, GTPPreset } from './types';
import { resolveAndCompute } from './api';

interface MiniEngineCtx {
  authentication: string;
  override?: { startTime: number; endTime: number };
  /** Periodicity override from the widget's periodicity dropdown.
   *  Sent to backend so all series aggregate at the picked granularity. */
  periodicity?: string;
}

export interface MiniEngineResult {
  config: LineChartUIConfig;
  data: DataEntry[];
  /** Populated when resolution failed (network, auth, malformed binding). UI may render an error state. */
  error?: string;
}

export async function resolve(
  envelope: LineChartEnvelope,
  ctx: MiniEngineCtx,
): Promise<MiniEngineResult> {
  const { startTime, endTime } = computeWindow(envelope, ctx.override);
  const bindings = envelope.dynamicBindingPathList ?? [];

  if (bindings.length === 0) return { config: envelope.uiConfig, data: [] };

  const UNS_TOPIC_RE = /^uns:[^/]+:\/\//;
  const invalidTopics: string[] = [];
  const validBindings = bindings.filter(({ topic }) => {
    if (!UNS_TOPIC_RE.test(topic)) {
      invalidTopics.push(topic);
      console.error(
        `[MiniEngine] Invalid topic format: "${topic}". ` +
          `Expected "uns:wsId://path". ` +
          `Check that resolveUNSValue returned a resolved topic — it logs a warning on cache miss.`,
      );
      return false;
    }
    return true;
  });

  if (validBindings.length === 0 && bindings.length > 0) {
    return {
      config: envelope.uiConfig,
      data: [],
      error: `All ${bindings.length} binding(s) had invalid topic format. ` +
        `First invalid: "${invalidTopics[0]}". See console for details.`,
    };
  }

  try {
    const periodicity =
      ctx.periodicity ?? envelope.timeConfig?.defaultPeriodicity ?? envelope.timeTabConfig?.defaultPeriodicity;
    const resolution = periodicityToResolution(periodicity);
    const items = await resolveAndCompute(
      ctx.authentication,
      validBindings.map((binding) => {
        const base =
          'type' in binding && binding.type === 'series'
            ? { key: binding.key, topic: binding.topic, type: 'series' as const }
            : { key: binding.key, topic: binding.topic };
        // Per-binding aggregation override — backend's SeriesAggregation pattern.
        // Only attached to series bindings; scalars don't aggregate.
        if (resolution && 'type' in base && base.type === 'series') {
          return {
            ...base,
            aggregation: { operator: 'mean', downscale: 1, resolution },
          };
        }
        return base;
      }),
      startTime,
      endTime,
      resolution,
    );
    const data: DataEntry[] = items.map((item) => ({ key: item.key, value: item.value }));
    // Diagnostic — summarize series payload shape per key so we can see the
    // backend's actual slot count + resolution for each binding.
    console.log(
      '[MiniEngine] response →',
      data.map((d) => {
        if (d.value && typeof d.value === 'object' && '__type' in d.value) {
          const p = d.value as { __type: string; slots?: { from: number; to: number; value: number | null }[]; meta?: { aggregation?: { resolution?: string } } };
          return {
            key: d.key,
            slotCount: p.slots?.length ?? 0,
            firstSlot: p.slots?.[0]
              ? { from: new Date(p.slots[0].from).toISOString(), value: p.slots[0].value }
              : null,
            lastSlot: p.slots?.[p.slots.length - 1]
              ? { from: new Date(p.slots[p.slots.length - 1].from).toISOString(), value: p.slots[p.slots.length - 1].value }
              : null,
            resolution: p.meta?.aggregation?.resolution ?? null,
          };
        }
        return { key: d.key, scalar: d.value };
      }),
    );
    return { config: envelope.uiConfig, data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[MiniEngine] resolveAndCompute failed:', err);
    return { config: envelope.uiConfig, data: [], error: message };
  }
}

export function getSeriesData(key: string, data: DataEntry[]): SeriesPayload | null {
  // Two host shapes converge here:
  // (a) Our dev mini-engine wraps each item as `{ key, value: { __type:'series', slots, ... } }`.
  // (b) Lens's production query-engine passes the raw API item straight through:
  //     `{ key, path, meta, range, slots }` (no `__type`, no `value` wrapper).
  // Accept both so the widget renders in both environments.
  const entry = data.find((d) => d.key === key) as
    | (DataEntry & Partial<SeriesPayload>)
    | undefined;
  if (!entry) return null;
  // (a) wrapped shape
  const v = entry.value as SeriesPayload | string | number | null | undefined;
  if (v !== null && typeof v === 'object' && (v as SeriesPayload).__type === 'series') {
    return v as SeriesPayload;
  }
  // (b) raw shape — recognise by `slots` array on the entry itself.
  if (Array.isArray(entry.slots)) {
    return {
      __type: 'series',
      path: entry.path ?? '',
      meta: entry.meta as SeriesPayload['meta'],
      range: entry.range as SeriesPayload['range'],
      slots: entry.slots as SeriesPayload['slots'],
    };
  }
  return null;
}

function computeWindow(
  envelope: LineChartEnvelope,
  override?: { startTime: number; endTime: number },
): { startTime: number; endTime: number } {
  if (override) return override;
  const { timeConfig } = envelope;
  if (!timeConfig) return { startTime: Date.now() - 86_400_000, endTime: Date.now() };
  const now = Date.now();
  const dur = timeConfig.allDurations?.find((d) => d.id === timeConfig.defaultDurationId);
  if (dur) return { startTime: computePresetStart(dur, now), endTime: now };
  return { startTime: now - 86_400_000, endTime: now };
}

// Map the widget's periodicity vocabulary to the backend's resolution vocabulary.
// `getWidgetData` examples use 'hour' / 'day' / 'month' (singular, no '-ly').
function periodicityToResolution(p?: string): string | undefined {
  if (!p) return undefined;
  switch (p.toLowerCase()) {
    case 'minute':  return 'minute';
    case 'hourly':  return 'hour';
    case 'daily':   return 'day';
    case 'weekly':  return 'week';
    case 'monthly': return 'month';
    default:        return p; // already in backend vocab
  }
}

function computePresetStart(dur: GTPPreset, now: number): number {
  const x = dur.x ?? 1;
  const periodMs: Record<string, number> = {
    minute: 60_000,
    hour: 3_600_000,
    day: 86_400_000,
    week: 7 * 86_400_000,
    month: 30 * 86_400_000,
    year: 365 * 86_400_000,
  };
  return now - x * (periodMs[dur.xPeriod ?? ''] ?? 86_400_000);
}
