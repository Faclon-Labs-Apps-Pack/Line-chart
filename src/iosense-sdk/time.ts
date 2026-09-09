import { Duration, CycleTime } from './types';

// Duration → [startTime, endTime] resolution. Faithful port of the canonical
// GlobalTimePicker implementation (computePresetWindow / getPeriodAsPerCycle /
// cycleBoundary), so the widget resolves time exactly like the platform picker.
//
// Three preset shapes:
//   1. calendarType (today/yesterday/current_week/…) — snapped to cycle boundaries
//   2. navigation custom presets — base = cycle boundary of the period containing
//      now, THEN offset by ±x/±y periods (Previous/Next)
//   3. plain rolling presets — now − x·period

const PERIOD_MS: Record<string, number> = {
  minute: 60_000, hour: 3_600_000, day: 86_400_000,
  week: 7 * 86_400_000, month: 30 * 86_400_000, year: 365 * 86_400_000,
};

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// Resolve the cycle month to a 0-based JS month index (0 = January). design-sdk
// ≥0.7.8 emits `month` as a 1-based number (4 = April); legacy envelopes stored
// the month NAME ("April"). Handle both, defaulting to January (0).
function monthIndex(month: string | number | null | undefined): number {
  if (month === undefined || month === null || month === '') return 0;
  const asNum = typeof month === 'number' ? month : Number(month);
  if (!Number.isNaN(asNum)) return Math.min(11, Math.max(0, asNum - 1)); // 1-based → 0-based
  return Math.max(0, MONTH_NAMES.indexOf(String(month)));                // legacy name
}

function addPeriodToDate(d: Date, n: number, period: string): Date {
  const r = new Date(d);
  switch (period) {
    case 'minute': r.setTime(r.getTime() + n * 60_000); break;
    case 'hour':   r.setTime(r.getTime() + n * 3_600_000); break;
    case 'day':    r.setDate(r.getDate() + n); break;
    case 'week':   r.setDate(r.getDate() + n * 7); break;
    case 'month':  r.setMonth(r.getMonth() + n); break;
    case 'year':   r.setFullYear(r.getFullYear() + n); break;
  }
  return r;
}

function getPeriodAsPerCycle(period: string, event: string, cycleTime: CycleTime | undefined, now: Date): Date {
  if (event === 'Now' || !cycleTime) return new Date(now);

  const ch = Number(cycleTime.hour   || 0);
  const cm = Number(cycleTime.minute || 0);
  let base: Date;

  switch (period) {
    case 'day': {
      base = new Date(now.getFullYear(), now.getMonth(), now.getDate(), ch, cm, 0, 0);
      if (now < base) base = addPeriodToDate(base, -1, 'day');
      break;
    }
    case 'week': {
      const dow     = now.getDay();
      const selDay  = cycleTime.dayOfWeek ?? 0;
      const wkStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow, 0, 0, 0, 0);
      base = new Date(wkStart.getFullYear(), wkStart.getMonth(), wkStart.getDate() + selDay, ch, cm, 0, 0);
      if (now < base) base = addPeriodToDate(base, -1, 'week');
      break;
    }
    case 'month': {
      const selDate = Number(cycleTime.date || 1);
      base = new Date(now.getFullYear(), now.getMonth(), selDate, ch, cm, 0, 0);
      if (now < base) base = addPeriodToDate(base, -1, 'month');
      break;
    }
    case 'year': {
      const selMonth = monthIndex(cycleTime.month);
      const selDate  = Number(cycleTime.date || 1);
      base = new Date(now.getFullYear(), selMonth, selDate, ch, cm, 0, 0);
      break;
    }
    default:
      base = new Date(now);
  }

  if (event === 'End') base = addPeriodToDate(base, 1, period);
  return base;
}

function cycleBoundary(period: 'day' | 'week' | 'month' | 'year', cycleTime: CycleTime | undefined, now: Date): Date {
  const ch = Number(cycleTime?.hour   || 0);
  const cm = Number(cycleTime?.minute || 0);
  const y = now.getFullYear(), mo = now.getMonth(), d = now.getDate();

  switch (period) {
    case 'day': {
      let base = new Date(y, mo, d, ch, cm, 0, 0);
      if (now < base) base = addPeriodToDate(base, -1, 'day');
      return base;
    }
    case 'week': {
      const selDay  = cycleTime?.dayOfWeek ?? 0;
      const wkStart = new Date(y, mo, d - now.getDay(), 0, 0, 0, 0);
      let base = new Date(wkStart.getFullYear(), wkStart.getMonth(), wkStart.getDate() + selDay, ch, cm, 0, 0);
      if (now < base) base = addPeriodToDate(base, -1, 'week');
      return base;
    }
    case 'month': {
      const selDate = Number(cycleTime?.date || 1);
      let base = new Date(y, mo, selDate, ch, cm, 0, 0);
      if (now < base) base = addPeriodToDate(base, -1, 'month');
      return base;
    }
    // Year boundary snapped to the configured cycle month (financial-year
    // start). Cycle month "April" ⇒ the year window begins on 1 April at the
    // cycle hour/minute; if `now` is before that anchor (e.g. February), roll
    // back to the previous April so "current year" always contains `now`.
    case 'year': {
      const selMonth = monthIndex(cycleTime?.month);
      const selDate  = Number(cycleTime?.date || 1);
      let base = new Date(y, selMonth, selDate, ch, cm, 0, 0);
      if (now < base) base = addPeriodToDate(base, -1, 'year');
      return base;
    }
  }
}

function resolveWindowInner(
  dur: Duration,
  now: number,
  cycleTime?: CycleTime,
): { startTime: number; endTime: number } {
  const nowD = new Date(now);
  const ms = now;

  if (dur.calendarType) {
    const dayStart   = cycleBoundary('day',   cycleTime, nowD).getTime();
    const weekStart  = cycleBoundary('week',  cycleTime, nowD).getTime();
    const monthStart = cycleBoundary('month', cycleTime, nowD).getTime();
    const yearStart  = cycleBoundary('year',  cycleTime, nowD).getTime();
    const prev = (anchor: number, period: 'day' | 'week' | 'month' | 'year') =>
      addPeriodToDate(new Date(anchor), -1, period).getTime();
    switch (dur.calendarType) {
      case 'today':          return { startTime: dayStart,                  endTime: ms };
      case 'yesterday':      return { startTime: prev(dayStart, 'day'),     endTime: dayStart };
      case 'current_week':   return { startTime: weekStart,                 endTime: ms };
      case 'previous_week':  return { startTime: prev(weekStart, 'week'),   endTime: weekStart };
      case 'current_month':  return { startTime: monthStart,                endTime: ms };
      case 'previous_month': return { startTime: prev(monthStart, 'month'), endTime: monthStart };
      case 'current_year':   return { startTime: yearStart,                 endTime: ms };
      case 'previous_year':  return { startTime: prev(yearStart, 'year'),   endTime: yearStart };
    }
  }

  if (dur.navigation) {
    const xPeriod = dur.xPeriod ?? 'day';
    const yPeriod = dur.yPeriod ?? 'day';
    const xEvent  = dur.xEvent  ?? 'Start';
    const yEvent  = dur.yEvent  ?? 'End';
    const x = dur.x ?? 1;
    const y = dur.y ?? 1;
    const xBase = getPeriodAsPerCycle(xPeriod, xEvent, cycleTime, nowD);
    const yBase = getPeriodAsPerCycle(yPeriod, yEvent, cycleTime, nowD);
    const dir = dur.navigation === 'Previous' ? -1 : 1;
    return {
      startTime: addPeriodToDate(xBase, dir * x, xPeriod).getTime(),
      endTime:   addPeriodToDate(yBase, dir * y, yPeriod).getTime(),
    };
  }

  return {
    startTime: ms - (dur.x ?? 1) * (PERIOD_MS[dur.xPeriod ?? 'day'] ?? 86_400_000),
    endTime: ms,
  };
}

export function resolveDurationWindow(
  dur: Duration,
  now: number,
  cycleTime?: CycleTime,
): { startTime: number; endTime: number } {
  return resolveWindowInner(dur, now, cycleTime);
}
