import {
  LineChartEnvelope,
  LineChartUIConfig,
  DataEntry,
  GTPPreset,
  TimeTabUIConfig,
} from './types';
import { resolveAndCompute } from './api';

interface MiniEngineCtx {
  authentication: string;
  override?: { startTime: number; endTime: number };
}

export async function resolve(
  envelope: LineChartEnvelope,
  ctx: MiniEngineCtx,
): Promise<{ config: LineChartUIConfig; data: DataEntry[] }> {
  const { startTime, endTime } = computeWindow(envelope, ctx.override);
  const bindings = envelope.dynamicBindingPathList ?? [];

  if (bindings.length === 0) return { config: envelope.uiConfig, data: [] };

  try {
    const items = await resolveAndCompute(
      ctx.authentication,
      bindings.map(({ key, topic }) => ({ key, topic })),
      startTime,
      endTime,
    );
    const data: DataEntry[] = items.map((item) => ({ key: item.key, value: item.value }));
    return { config: envelope.uiConfig, data };
  } catch {
    return { config: envelope.uiConfig, data: [] };
  }
}

function computeWindow(
  envelope: LineChartEnvelope,
  override?: { startTime: number; endTime: number },
): { startTime: number; endTime: number } {
  if (override) return override;
  const tc: TimeTabUIConfig | undefined = envelope.timeConfig;
  if (!tc) return { startTime: Date.now() - 86_400_000, endTime: Date.now() };

  if (tc.timeType === 'fixed' && tc.fixedStart && tc.fixedEnd) {
    return { startTime: tc.fixedStart, endTime: tc.fixedEnd };
  }

  const now = Date.now();
  const dur = tc.allDurations?.find((d) => d.id === tc.defaultDurationId);
  if (dur) return { startTime: computePresetStart(dur, now), endTime: now };
  return { startTime: now - 86_400_000, endTime: now };
}

// Compute a preset's start time relative to `now`.
// Supports the `x + xPeriod` rolling-window shape, plus a small subset of
// `calendarType` values. Unsupported calendar types fall back to `now - 24h`
// rather than throwing — we never silently break the widget.
function computePresetStart(dur: GTPPreset, now: number): number {
  if (dur.calendarType) {
    const d = new Date(now);
    switch (dur.calendarType) {
      case 'today': {
        d.setHours(0, 0, 0, 0);
        return d.getTime();
      }
      case 'yesterday': {
        d.setHours(0, 0, 0, 0);
        return d.getTime() - 86_400_000;
      }
      case 'current_week': {
        d.setHours(0, 0, 0, 0);
        const dow = d.getDay(); // 0=Sun
        return d.getTime() - dow * 86_400_000;
      }
      case 'previous_week': {
        d.setHours(0, 0, 0, 0);
        const dow = d.getDay();
        return d.getTime() - (dow + 7) * 86_400_000;
      }
      case 'current_month': {
        d.setDate(1);
        d.setHours(0, 0, 0, 0);
        return d.getTime();
      }
      case 'previous_month': {
        d.setDate(1);
        d.setHours(0, 0, 0, 0);
        d.setMonth(d.getMonth() - 1);
        return d.getTime();
      }
      default:
        return now - 86_400_000;
    }
  }

  if (typeof dur.x === 'number' && dur.xPeriod) {
    const periodMs: Record<string, number> = {
      minute: 60_000,
      hour: 3_600_000,
      day: 86_400_000,
      week: 7 * 86_400_000,
      month: 30 * 86_400_000,
      year: 365 * 86_400_000,
    };
    return now - dur.x * (periodMs[dur.xPeriod] ?? 86_400_000);
  }

  return now - 86_400_000;
}
