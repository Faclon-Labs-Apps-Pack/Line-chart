import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { LineChart as DSLineChart } from '@faclon-labs/design-sdk/LineChart';
import { Chart, exportChart } from '@faclon-labs/design-sdk/Chart';
import { IconButton } from '@faclon-labs/design-sdk/IconButton';
import type { ChartPlotLine, ChartPlotBand, ChartExportFormat } from '@faclon-labs/design-sdk/Chart';
import type { ChartComparisonConfig, ComparisonSeriesInput, DeviationPattern, ChartShiftConfig, ShiftSeriesInput } from '@faclon-labs/design-sdk';
import { EmptyState, NoDataOneIllustration } from '@faclon-labs/design-sdk/EmptyState';
import { Spinner } from '@faclon-labs/design-sdk/Spinner';
import { DatePicker } from '@faclon-labs/design-sdk/DatePicker';
import type { DateRange, DatePresetOption } from '@faclon-labs/design-sdk/DatePicker';
import { DropdownMenu } from '@faclon-labs/design-sdk/DropdownMenu';
import { ActionListItem } from '@faclon-labs/design-sdk/ActionListItem';
import { SelectInput } from '@faclon-labs/design-sdk/SelectInput';
import { ChevronDown, Settings, Menu, Info } from 'react-feather';
import { Tooltip } from '@faclon-labs/design-sdk/Tooltip';
import {
  Table,
  TableHeader,
  TableHeaderRow,
  TableHeaderCell,
  TableBody,
  TableRow,
  TableCell,
} from '@faclon-labs/design-sdk/Table';
import { getSeriesData } from '../../iosense-sdk/mini-engine';
import { resolveDurationWindow } from '../../iosense-sdk/time';
import type {
  LineChartUIConfig,
  DataEntry,
  ChartInstance,
  DataTableConfig,
  DataTableColumn,
  DataTableOperator,
  LineChartSeries,
  SeriesPayload,
  WidgetEvent,
} from '../../iosense-sdk/types';
import './LineChart.css';

// Highcharts (the SDK LineChart engine) and its exporting / export-data /
// full-screen modules are served ONCE by the host as `window.Highcharts`, the
// same single copy the externalised design-sdk uses — so this widget no longer
// imports or registers Highcharts itself (mirrors ColumnChart / CombinedBarLine).
// Export/CSV are registered by the SDK's own Chart setup; the host must load the
// full-screen module onto window.Highcharts for the fullscreen toggle.

// ---------------------------------------------------------------------------
// LineChart widget — pure UI renderer (DataLayer architecture).
// Receives `config` (uiConfig) + `data` (DataEntry[] from the mini-engine) and
// renders the chart. Never fetches data. Series values come from the resolved
// series payloads in `data`; the backend has already bucketed them into slots,
// so x-axis categories are the slot labels (no client-side periodicity logic).
// ---------------------------------------------------------------------------

interface LineChartWidgetProps {
  // Host may pass either the bare uiConfig OR the full envelope (with
  // uiConfig nested). Normalize at the boundary.
  config?: LineChartUIConfig | { uiConfig?: LineChartUIConfig };
  data?: DataEntry[];
  // Iosense passes envelope.timeConfig as a SEPARATE top-level prop (the
  // host-shape: { type, pickerType, defaultDurationId, allDurations,
  // defaultPeriodicity, startTime, endTime, fixedDuration, ... }). We use
  // it to derive the active window and emit `TIME_CHANGE` events back via
  // onEvent — the host's data layer subscribes to those events to drive
  // resolveAndCompute. Without this prop being read AND the corresponding
  // TIME_CHANGE event being emitted on mount, iosense never schedules
  // queries for this widget (the deployed Column Chart widget follows the
  // same contract).
  timeConfig?: {
    type?: string;
    pickerType?: string;
    /** Set by Lens at runtime when a Global Timepicker widget drives this widget's time. */
    globalTimepickerId?: string;
    cycleTime?: import('../../iosense-sdk/types').CycleTime | null;
    defaultDurationId?: string;
    allDurations?: import('../../iosense-sdk/types').Duration[];
    defaultPeriodicity?: string;
    /** When true, periodicity selection was disabled in the Time tab — the
     *  widget hides its periodicity dropdown. */
    disablePeriodicities?: boolean;
    startTime?: number | null;
    endTime?: number | null;
    fixedDuration?: import('../../iosense-sdk/types').Duration | null;
    shifts?: Array<{ id: string; name: string; color: string; startTime: string; endTime: string }>;
    shiftAggregator?: string;
    timezone?: string;
    comparisonMode?: boolean;
    deviationPattern?: string;
    sourceDeviationOverrides?: Record<string, string>;
  };
  onEvent?: (event: WidgetEvent) => void;
  // Host-driven loading flag. Lens sets this true while it re-resolves data —
  // including GTP-driven refetches the widget itself never emitted (the GTP
  // broadcasts the new window, so `beginPendingFetch` never fires). Without
  // reading it, a GTP time change leaves the stale chart on screen with no
  // loader. MUST be named `loader` (not `loading`) — that is the exact prop the
  // host injects; ColumnChart uses this name and its loader works. OR-ed with
  // the widget's own loading states so it never hides a loader we'd show anyway.
  loader?: boolean;
  // Full TimeTabConfiguration UI state — Lens passes this as a separate
  // envelope-level prop so the widget can read defaultDisplayMode on mount.
  timeTabConfig?: import('../../iosense-sdk/types').TimeTabUIConfig;
  // Bearer token for comparison data fetch. Lens injects this for widgets that
  // declare it; dev harness passes it from auth state. Falls back to
  // localStorage when not provided (covers both dev and production Lens).
  authentication?: string;
}

const FONT_WEIGHT: Record<string, number> = {
  Regular: 400,
  Medium: 500,
  'Semi-Bold': 600,
  Bold: 700,
};

/** Parse `#rgb` / `#rrggbb` / `#rrggbbaa` / `rgb()` / `rgba()` into [r,g,b].
 *  Returns null for named colors, `transparent`, or anything unparseable. */
function parseColor(c: string): [number, number, number] | null {
  const s = c.trim();
  const hex = s.match(/^#([0-9a-f]{3,8})$/i)?.[1];
  if (hex) {
    const full =
      hex.length === 3 || hex.length === 4
        ? hex.slice(0, 3).split('').map((ch) => ch + ch).join('')
        : hex.slice(0, 6);
    if (full.length !== 6) return null;
    return [
      parseInt(full.slice(0, 2), 16),
      parseInt(full.slice(2, 4), 16),
      parseInt(full.slice(4, 6), 16),
    ];
  }
  const rgb = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return null;
}

/** Readable foreground for a given background. The SDK's DatePicker trigger and
 *  periodicity SelectInput hardcode dark text tokens; once we repaint their
 *  surface with a user-picked (possibly dark) card color, that text would
 *  vanish. Flip to white on dark backgrounds. Returns null when the color can't
 *  be parsed (e.g. `transparent`) so the SDK default is left alone. */
function readableForeground(bg: string): string | null {
  const rgb = parseColor(bg);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((v) => {
    const n = v / 255;
    return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.45 ? null : '#FFFFFF';
}

const OPERATOR_LABEL: Record<DataTableOperator, string> = {
  sum: 'Sum',
  avg: 'Average',
  min: 'Min',
  max: 'Max',
  median: 'Median',
  first: 'First',
  last: 'Last',
  std: 'Std Dev',
};

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function aggregate(values: number[], op: DataTableOperator): number {
  if (!values.length) return 0;
  const sum = values.reduce((a, b) => a + b, 0);
  switch (op) {
    case 'sum': return sum;
    case 'avg': return sum / values.length;
    case 'min': return Math.min(...values);
    case 'max': return Math.max(...values);
    case 'median': {
      const s = [...values].sort((a, b) => a - b);
      const m = Math.floor(s.length / 2);
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    }
    case 'first': return values[0];
    case 'last': return values[values.length - 1];
    case 'std': {
      const mean = sum / values.length;
      const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length;
      return Math.sqrt(variance);
    }
    default: return sum / values.length;
  }
}

const PERIODICITY_MS: Record<string, number> = {
  Minute: 60_000,
  Hourly: 3_600_000,
  Daily: 86_400_000,
  Weekly: 7 * 86_400_000,
  Monthly: 28 * 86_400_000,
  Quarterly: 90 * 86_400_000,
  Yearly: 365 * 86_400_000,
};
const PERIODICITY_ORDER = ['Hourly', 'Daily', 'Weekly', 'Monthly', 'Quarterly', 'Yearly'];

// Rank from finest (0) to coarsest. Used to present periodicity options in
// decremental order (Yearly → Minute) so the dropdown always reads high-to-low
// and the default selection (options[0]) is the highest-order option available.
const PERIODICITY_RANK: Record<string, number> = {
  Minute: 0, Hourly: 1, Daily: 2, Weekly: 3, Monthly: 4, Quarterly: 5, Yearly: 6,
};
function orderDescending(list: string[]): string[] {
  return [...list].sort((a, b) => (PERIODICITY_RANK[b] ?? 0) - (PERIODICITY_RANK[a] ?? 0));
}

// Choose the effective periodicity for a set of (descending-ordered) options.
// Until the user manually picks one we default to the highest-order (coarsest)
// option; afterwards we keep their choice unless it's no longer valid.
function pickPeriodicity(options: string[], current: string, touched: boolean): string {
  if (!options.length) return current;
  if (!touched) return options[0];
  return options.includes(current) ? current : options[0];
}

function titleCase(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function getValidPeriodicities(range: DateRange | null): string[] {
  if (!range?.start || !range?.end) return orderDescending(PERIODICITY_ORDER);
  const span = new Date(range.end).getTime() - new Date(range.start).getTime();
  if (span <= 0) return orderDescending(PERIODICITY_ORDER);
  const MAX_BUCKETS = 1_000;
  const valid = PERIODICITY_ORDER.filter((p) => {
    const ms = PERIODICITY_MS[p];
    return span >= ms && span / ms <= MAX_BUCKETS;
  });
  return orderDescending(valid.length ? valid : ['Hourly']);
}

// Derive valid periodicities from a preset's definition — not from range span.
// Mirrors the reference widget's getPresetPeriodicities. Returns null when
// the preset shape is unrecognisable (fall back to getValidPeriodicities).
const PRESET_MINS: Record<string, number> = {
  minute: 1, hour: 60, day: 1440, week: 10080, month: 43200, year: 525600,
};
function getPresetPeriodicities(
  preset: { x?: number; xPeriod?: string; calendarType?: string; periodicities?: string[] } | undefined,
): string[] | null {
  if (!preset) return null;
  let raw: string[] | null = null;
  if (preset.periodicities?.length) {
    // Explicit mapping on the duration (SDK- or configurator-authored) is the
    // authority — surface every periodicity mapped to it, unabridged.
    raw = preset.periodicities.map(titleCase);
  } else if (preset.calendarType) {
    // Fallback for durations that arrive without an explicit `periodicities`
    // list (e.g. a Global Time Picker duration pushed at runtime). Mirrors the
    // SDK TimeTabConfiguration's own built-in calendar → periodicity roster so
    // the dropdown offers the full mapped set, not a single coarsest option.
    switch (preset.calendarType) {
      case 'today':
      case 'yesterday':      raw = ['Hourly']; break;
      case 'current_week':
      case 'previous_week':  raw = ['Hourly', 'Daily']; break;
      case 'current_month':
      case 'previous_month': raw = ['Hourly', 'Daily', 'Weekly']; break;
      case 'current_year':
      case 'previous_year':  raw = ['Daily', 'Weekly', 'Monthly', 'Quarterly']; break;
      default: return null;
    }
  } else if (typeof preset.x === 'number' && preset.xPeriod) {
    const mins = preset.x * (PRESET_MINS[preset.xPeriod] ?? 1440);
    if (mins <= 60)          raw = ['Hourly'];
    else if (mins <= 1440)   raw = ['Hourly'];
    else if (mins <= 10080)  raw = ['Hourly', 'Daily'];
    else if (mins <= 43200)  raw = ['Hourly', 'Daily', 'Weekly'];
    else if (mins <= 129600) raw = ['Daily', 'Weekly', 'Monthly'];
    else                     raw = ['Daily', 'Weekly', 'Monthly', 'Quarterly'];
  }
  // Minute is not a selectable periodicity — drop it if a preset lists it.
  const filtered = raw?.filter((p) => p !== 'Minute') ?? null;
  return filtered && filtered.length ? orderDescending(filtered) : null;
}


// Next finer periodicity for "Time drilldown" — clicking a point narrows the
// range to that bucket and steps one level down for a re-query.
function finerPeriodicity(p?: string): string | null {
  switch ((p || '').toLowerCase()) {
    case 'yearly':    return 'Quarterly';
    case 'quarterly': return 'Monthly';
    case 'monthly':   return 'Daily';
    case 'weekly':    return 'Daily';
    case 'daily':     return 'Hourly';
    default: return null;
  }
}

// Return the time-of-day in minutes (0–1439) for a Unix ms timestamp,
// respecting the configured timezone when provided.
function slotMinutesOfDay(timestampMs: number, timezone?: string): number {
  if (timezone) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hour: 'numeric',
        minute: 'numeric',
        hour12: false,
      }).formatToParts(new Date(timestampMs));
      const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
      const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
      return h * 60 + m;
    } catch { /* fall through to local */ }
  }
  const d = new Date(timestampMs);
  return d.getHours() * 60 + d.getMinutes();
}

// Return true if the slot's time-of-day falls inside the shift window.
// Handles night shifts that cross midnight (startTime > endTime).
function isSlotInShift(
  timestampMs: number,
  startTime: string,
  endTime: string,
  timezone?: string,
): boolean {
  const slotMin = slotMinutesOfDay(timestampMs, timezone);
  const [sh, sm = 0] = startTime.split(':').map(Number);
  const [eh, em = 0] = endTime.split(':').map(Number);
  const s = sh * 60 + sm;
  const e = eh * 60 + em;
  return s < e ? slotMin >= s && slotMin < e : slotMin >= s || slotMin < e;
}

// Width of the "no data" empty-state block, derived from the chart canvas width.
// Scales with the container (~70%) but clamped so it neither stretches edge-to-
// edge on a wide widget nor gets cramped on a narrow one. Never wider than the
// container itself.
// Max time to show the loading spinner before assuming the fetch resolved with
// no data (falls back to the empty state). Generous, to tolerate a slow backend
// (e.g. Redis warm-up) — a genuine late arrival still renders the chart.
const LOADING_TIMEOUT_MS = 15000;

// A series is "bound" when its binding value is wrapped in `{{ }}` — i.e. it
// expects data from the engine. Used to tell a true loading state (bound series,
// data not arrived yet) apart from an unconfigured/empty one. Mirrors ColumnChart.
function isBound(binding?: string): boolean {
  return !!binding && /^\{\{.+\}\}$/.test(binding.trim());
}

const NO_DATA_MIN_WIDTH = 160;
const NO_DATA_MAX_WIDTH = 360;
function computeNoDataWidth(containerWidth: number): number {
  if (!containerWidth || containerWidth <= 0) return NO_DATA_MAX_WIDTH;
  const target = containerWidth * 0.7;
  return Math.round(
    Math.max(NO_DATA_MIN_WIDTH, Math.min(target, NO_DATA_MAX_WIDTH, containerWidth)),
  );
}

// Break a timestamp into timezone-aware calendar parts used by the realtime
// x-axis tick logic (day/hour bucketing + label formatting).
function tzParts(ms: number, tz?: string): {
  dayKey: string; hour: number; dateLabel: string; hourLabel: string;
} {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', hour12: false,
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const hour = parseInt(get('hour'), 10) || 0;
  return {
    dayKey: `${get('year')}-${get('month')}-${get('day')}`,
    hour,
    dateLabel: `${get('day')} ${get('month')}`,          // "27 Jul"
    hourLabel: `${String(hour).padStart(2, '0')}:00`,     // "12:00"
  };
}

// Adaptive "nice" hour steps for the realtime axis — mirrors how a Highcharts
// datetime axis picks readable intervals so the label count stays ~TARGET
// regardless of how many days the live window spans.
// Nice hour-steps spanning intraday → multi-month so a long realtime window
// (e.g. 12 months) still thins to ~REALTIME_TARGET_TICKS labels instead of one
// per day/week (which overlap into an unreadable smear). Values:
// 1h…12h (intraday) · 24h/48h/72h (days) · 168h(1wk)/336h(2wk) · 720h(30d)
// /1440h(60d)/2160h(90d)/4320h(180d)/8760h(1yr).
const NICE_HOUR_STEPS = [1, 2, 3, 6, 12, 24, 48, 72, 168, 336, 720, 1440, 2160, 4320, 8760];
const REALTIME_TARGET_TICKS = 8;

// Breakdown break-detection: the backend returns only buckets that have data,
// so an inactive device surfaces as a large time gap between two consecutive
// buckets. When a gap exceeds the normal cadence (median inter-bucket gap) by
// this factor, the dead period is filled with null buckets at the normal cadence
// so the line BREAKS there AND the empty span is width-proportional to how long
// the device was inactive (matches v1's datetime-axis look).
const BREAK_GAP_FACTOR = 2.5;
// Cap on synthetic filler buckets per gap so an extreme gap/cadence ratio can't
// explode the category count (keeps Highcharts responsive).
const MAX_BREAK_FILLERS = 2000;

type ChartDisplay = {
  legends: boolean;
  dataLabel: boolean;
  clipping: boolean;
  // Time-control flag mirrored from ColumnChart. Rides on TIME_CHANGE so the
  // host refetches with a non-whole bucket count allowed across the window.
  // Mutually exclusive with `clipping` (Clipping is disabled while this is on).
  inexactMultiple: boolean;
  zoom: boolean;
  // Horizontal plot-area scroll (SDK `scrollable`). When on, a dense category
  // axis scrolls instead of cramming every label; legend + axis titles stay put.
  scroll: boolean;
};

function columnLabel(col: DataTableColumn, seriesById: Map<string, LineChartSeries>): string {
  if (col.sourceMode === 'Existing' && col.seriesId) {
    const s = seriesById.get(col.seriesId);
    if (s) return s.name || 'Series';
  }
  if (col.name?.trim()) return col.name.trim();
  if (col.topic) {
    const unwrapped = col.topic.replace(/^\{\{(.+)\}\}$/, '$1');
    const parts = unwrapped.split('/');
    return parts[parts.length - 1] || 'UNS Source';
  }
  return 'Source';
}

// Compute startTime/endTime from a host-shape timeConfig, using
// resolveDurationWindow so cycleTime boundaries are honoured.
function computeRange(tc?: LineChartWidgetProps['timeConfig']): {
  startTime: number;
  endTime: number;
} {
  const now = Date.now();
  // Explicit timestamps (host-resolved) take priority.
  if (tc?.startTime && tc?.endTime) {
    return { startTime: tc.startTime, endTime: tc.endTime };
  }
  // Fixed-mode: use the fixed duration directly — skip preset lookup so that
  // a stale defaultDurationId from a previous local-mode config doesn't win.
  if (tc?.pickerType === 'fixed' && tc?.fixedDuration) {
    return resolveDurationWindow(tc.fixedDuration, now, tc?.cycleTime ?? undefined);
  }
  // Active preset via resolveDurationWindow (handles cycleTime + all duration shapes).
  const preset = tc?.allDurations?.find((d) => d.id === tc?.defaultDurationId);
  if (preset) return resolveDurationWindow(preset, now, tc?.cycleTime ?? undefined);
  // Fixed-mode duration (fallback when pickerType not set on legacy envelopes).
  if (tc?.fixedDuration) return resolveDurationWindow(tc.fixedDuration, now, tc?.cycleTime ?? undefined);
  // Fallback: last 24h.
  return { startTime: now - 86_400_000, endTime: now };
}

// The periodicity a freshly-loaded widget should default to: the highest-order
// (coarsest) option available for the configured preset/range — e.g. Daily when
// only Daily+Hourly are valid. Fixed-time mode honors its explicitly-configured
// periodicity instead (the periodicity dropdown is hidden there).
function computeDefaultPeriodicity(tc?: LineChartWidgetProps['timeConfig']): string {
  if (tc?.pickerType === 'fixed' && tc?.defaultPeriodicity) {
    return titleCase(tc.defaultPeriodicity);
  }
  const preset = tc?.allDurations?.find((d) => d.id === tc?.defaultDurationId);
  let options = getPresetPeriodicities(preset);
  if (!options) {
    const { startTime, endTime } = computeRange(tc);
    options = getValidPeriodicities({ start: new Date(startTime), end: new Date(endTime) });
  }
  return options[0] ?? titleCase(tc?.defaultPeriodicity || 'Hourly');
}

// Previous-period window for comparison mode: same duration as the current
// window, shifted back so it ends exactly where the current window starts.
// Returned as the TIME_CHANGE fields the data layer forwards to resolveAndCompute.
function comparisonWindowPayload(
  startMs: number,
  endMs: number,
): { comparisonStartTime: string; comparisonEndTime: string } {
  const dur = endMs - startMs;
  return { comparisonStartTime: String(startMs - dur), comparisonEndTime: String(startMs) };
}

// Map the configurator's Shift Aggregator label (Sum/Average/Min/Max/First/Last)
// to the backend operator vocabulary used by resolveAndCompute's aggregation
// (`mean` for Average; the rest pass through lowercased).
const SHIFT_AGGREGATOR_OPERATOR: Record<string, string> = {
  sum: 'sum',
  average: 'mean',
  mean: 'mean',
  min: 'min',
  max: 'max',
  first: 'first',
  last: 'last',
};
function shiftAggregatorOperator(label?: string): string | undefined {
  if (!label) return undefined;
  return SHIFT_AGGREGATOR_OPERATOR[label.toLowerCase()] ?? label.toLowerCase();
}

// Shift fields for a TIME_CHANGE payload — the configured shift windows plus the
// resolved aggregator operator. The data layer forwards these to
// resolveAndCompute so the backend buckets each series into the shift windows.
// Returns {} when there are no shifts (nothing to send).
function shiftEventPayload(
  shifts: Array<{ id: string; name: string; color: string; startTime: string; endTime: string }>,
  aggregator?: string,
): { shifts?: typeof shifts; shiftAggregator?: string } {
  if (!shifts.length) return {};
  return { shifts, shiftAggregator: shiftAggregatorOperator(aggregator) };
}

// Coerce a backend slot value into a plottable number-or-null. The engine
// (notably the GTP/Lens path) can serialize numeric values as STRINGS
// ("42.5") — the old `typeof v === 'number' ? v : null` turned every one of
// those into null, so the whole series read as empty and the widget showed the
// "no data" screen even though ColumnChart (which coerces) plotted the same
// data. Numbers pass through; non-empty numeric strings are parsed; null,
// empty, and genuine non-numeric sentinels (e.g. " N/A") become null (a gap).
function coerceSlotValue(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// Minimal HTML-escape for values interpolated into useHTML Highcharts strings.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Highcharts plot-line label. Highcharts places every plot-line label at the
// same default right-edge spot with no collision avoidance, so a second plot
// line's label landed directly on top of the first and only one showed (the
// reported "second plot line text not showing"). Anchoring the label to its
// OWN line via `verticalAlign:'middle'` fixes that: each label sits on its line
// at a fixed small offset, so lines at different values get separated labels
// with equal spacing. (Two labels only coincide if their lines have nearly the
// same value — a rare edge case the user can resolve by renaming/repositioning.)
// Horizontal (`rotation:0`) and colored to match its line so it reads at a glance.
function buildPlotLineLabel(text: string, color: string | undefined) {
  return {
    text,
    align: 'right' as const,
    verticalAlign: 'middle' as const,
    rotation: 0,
    x: -6,
    y: -6,
    ...(color ? { style: { color } } : {}),
  };
}

// True when `ref`'s element is horizontally clipped (its content is wider than
// its visible box), i.e. an ellipsis is actually showing. Re-measures on resize
// and whenever `dep` changes (title text swap). Used to gate the title tooltip
// so it appears ONLY when the title is truncated, matching the SDK's own
// string-title behaviour (0.7.32) that LineChart's node titles bypass.
function useIsTruncated(ref: React.RefObject<HTMLElement | null>, dep: unknown) {
  const [truncated, setTruncated] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setTruncated(el.scrollWidth > el.clientWidth + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, dep]);
  return truncated;
}

// Single-chart title with a full-text tooltip shown ONLY when the ellipsis is
// engaged. The SDK Tooltip merges our className onto its `.fds-tooltip-wrapper`,
// which becomes the direct child of `.fds-chart__header-row` — so the header-
// overflow flex/min-width fix lives on `.lcw__chart-title-wrap` and the inner
// span (`.lcw__chart-title`) owns the ellipsis (see LineChart.css).
function TruncatingChartTitle({ text, style }: { text: string; style?: React.CSSProperties }) {
  const ref = useRef<HTMLSpanElement>(null);
  const truncated = useIsTruncated(ref, text);
  return (
    <Tooltip bodyText={text} placement="Bottom" isDisabled={!truncated} className="lcw__chart-title-wrap">
      <span ref={ref} className="lcw__chart-title" style={style}>{text}</span>
    </Tooltip>
  );
}

export function LineChart({
  config: rawConfig,
  data = [],
  timeConfig,
  timeTabConfig,
  onEvent,
  loader = false,
}: LineChartWidgetProps) {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const timeConfigRef = useRef(timeConfig);
  timeConfigRef.current = timeConfig;
  // undefined = not configured yet (legacy: auto-enable shifts if present).
  // 'normal' | 'shift' | 'comparison' = explicit dashboard-builder choice.
  // Fall back to timeConfig.defaultDisplayMode: Lens preserves timeConfig across
  // save/restore but may strip timeTabConfig (a non-standard field). Both are
  // written by the configurator so either path gives the user's intent.
  const rawDefaultDisplayMode =
    timeTabConfig?.defaultDisplayMode ??
    (timeConfig as { defaultDisplayMode?: import('../../iosense-sdk/types').TimeTabDefaultDisplayMode } | undefined)?.defaultDisplayMode;
  // STICKY: once we've seen an explicit mode, never let a later prop update
  // revert it to undefined. Under a GTP, Lens pushes runtime timeConfig updates
  // (the live time window) that can omit the per-widget defaultDisplayMode — if
  // that reset the mode to undefined, shift/comparison would silently fall back
  // to normal on the next tick. Holding the last known mode keeps them stable.
  const stableDisplayModeRef = useRef(rawDefaultDisplayMode);
  if (rawDefaultDisplayMode !== undefined) stableDisplayModeRef.current = rawDefaultDisplayMode;
  const defaultDisplayMode = rawDefaultDisplayMode ?? stableDisplayModeRef.current;
  const defaultDisplayModeRef = useRef(defaultDisplayMode);
  defaultDisplayModeRef.current = defaultDisplayMode;
  // Mount TIME_CHANGE removed: the host (Lens canvas) now reads defaultDisplayMode
  // from the saved datasource body and fires the first resolveAndCompute query
  // with the correct shifts / comparison window before the widget mounts.
  // Emitting here was causing a redundant second query with identical params.

  // Lens may pass the full envelope as `config` instead of just uiConfig.
  // Detect by presence of `uiConfig` field on the input and unwrap.
  const config: LineChartUIConfig | undefined =
    rawConfig && typeof rawConfig === 'object' && 'uiConfig' in rawConfig && rawConfig.uiConfig
      ? rawConfig.uiConfig
      : (rawConfig as LineChartUIConfig | undefined);
  const charts = config?.charts ?? [];
  // Per-widget runtime override for which chart is shown. Lets the user
  // switch between configured charts via the title dropdown WITHOUT writing
  // back to the envelope. Reset when the envelope's set of charts changes.
  const [previewChartId, setPreviewChartId] = useState<string | null>(null);
  useEffect(() => {
    // If the previewed chart id no longer exists (envelope changed), drop it
    // so we fall back to the envelope's activeChartId / first chart.
    if (previewChartId && !charts.some((c) => c._id === previewChartId)) {
      setPreviewChartId(null);
    }
  }, [charts, previewChartId]);
  const activeChart = useMemo<ChartInstance | null>(() => {
    if (!charts.length) return null;
    const id = previewChartId ?? config?.activeChartId;
    return charts.find((c) => c._id === id) ?? charts[0];
  }, [charts, previewChartId, config?.activeChartId]);
  const chartIndex = activeChart ? charts.findIndex((c) => c._id === activeChart._id) : -1;

  // Shift state — committed (shiftToggleOn) vs draft (draftShiftOn, in-picker only).
  // Draft is synced from committed on every open; committed is set on Apply.
  // Shift definitions. Normally from timeConfig.shifts (Local/Fixed, or pushed
  // by the host under GTP). Fallback: if none are supplied but the resolved DATA
  // carries per-bucket shift TAGS (which only happens when a shift query ran —
  // e.g. a GTP in shift mode whose runtime timeConfig omitted the shift defs),
  // derive the shift list from those tags so shiftProp can still render. Colors
  // come from a default palette; bucket assignment uses the tags themselves, so
  // start/end times aren't needed here.
  const cfgShifts = useMemo<NonNullable<NonNullable<typeof timeConfig>['shifts']>>(() => {
    const fromConfig = timeConfig?.shifts ?? [];
    if (fromConfig.length > 0) return fromConfig;
    const names: string[] = [];
    (activeChart?.series ?? []).forEach((_s, si) => {
      const p =
        getSeriesData(`charts[${chartIndex}].series[${si}].unsPath`, data) ??
        getSeriesData(`charts[${chartIndex}].series[${si}].dataSource`, data);
      (p?.slots ?? []).forEach((sl: any) => {
        const tag = sl?.shift;
        if (tag !== undefined && tag !== '' && !names.includes(String(tag))) names.push(String(tag));
      });
    });
    if (names.length === 0) return fromConfig;
    const palette = ['#e4553d', '#1364f1', '#0f9d58', '#f4b400', '#9c27b0', '#00acc1'];
    return names.map((name, i) => ({
      id: name, name, color: palette[i % palette.length], startTime: '', endTime: '',
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeConfig?.shifts, activeChart, chartIndex, data]);
  const cfgShiftAggregator = timeConfig?.shiftAggregator;
  const cfgShiftKey = cfgShifts.map((s) => s.id).join('|');
  const isExternalTime =
    timeConfig?.pickerType === 'fixed' ||
    timeConfig?.pickerType === 'global' ||
    timeConfig?.type === 'global' ||
    !!timeConfig?.globalTimepickerId;
  // Whether this widget is driven by a Global Time Picker (GTP).
  // Lens always sends shift definitions in timeConfig.shifts even when the
  // GTP's own shift toggle is OFF — so cfgShifts.length > 0 cannot be used
  // as an "shifts are active" signal in GTP mode. Only auto-enable shifts for
  // local/fixed time pickers where the user explicitly added shifts themselves.
  const isGTPMode =
    timeConfig?.pickerType === 'global' ||
    timeConfig?.type === 'global' ||
    !!timeConfig?.globalTimepickerId;
  // Keep a ref so the cfgShiftKey effect always reads the latest value without
  // listing isGTPMode as a dep (which would re-run and stomp manual toggles).
  const isGTPModeRef = useRef(isGTPMode);
  isGTPModeRef.current = isGTPMode;
  // Whether Shift view should be ON for a given default display mode. An EXPLICIT
  // 'shift' mode turns shifts on whenever the timeConfig actually carries shifts
  // — INCLUDING in GTP mode, where the GTP inherits the shifts and sets the mode.
  // The previous `!isGTPMode` gate here wrongly kept shift permanently OFF under
  // a GTP; that gate belongs ONLY to the legacy (undefined-mode) fallback, since
  // Lens always ships shift definitions even when the GTP's own shift toggle is
  // off, so a legacy GTP envelope must default off.
  const resolveShiftOn = (mode: typeof defaultDisplayMode, gtp: boolean): boolean => {
    // Explicit 'shift' → ON regardless of whether shifts have loaded yet (matches
    // ColumnChart: `shiftToggleOn = defaultDisplayMode === 'shift'`). The actual
    // render is still gated on cfgShifts by chartMode, so keying the toggle on
    // cfgShifts here only made it fragile to load timing (shifts arriving after
    // mount left the toggle stuck off).
    if (mode === 'shift') return true;
    if (mode === 'normal' || mode === 'comparison') return false;
    return cfgShifts.length > 0 && !gtp; // undefined = legacy heuristic
  };
  const [shiftToggleOn, setShiftToggleOn] = useState(() => resolveShiftOn(defaultDisplayMode, isGTPMode));
  const [draftShiftOn, setDraftShiftOn] = useState(() => resolveShiftOn(defaultDisplayMode, isGTPMode));
  useEffect(() => {
    const autoOn = resolveShiftOn(defaultDisplayModeRef.current, isGTPModeRef.current);
    setShiftToggleOn(autoOn);
    setDraftShiftOn(autoOn);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfgShiftKey]);
  // Which shift chips are toggled on in the chart legend — all enabled by default.
  // Reset to all-on whenever the shift list changes.
  const [enabledShiftIds, setEnabledShiftIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    setEnabledShiftIds(new Set(cfgShifts.map((s) => s.id)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfgShiftKey]);

  // Periodicity dropdown visibility. Hidden when the Time tab disabled
  // periodicity selection. Prefer the host-mirrored flag on timeConfig (survives
  // Lens save/restore); fall back to the raw timeTabConfig (Local top-level or
  // Fixed-scoped) when the host shape isn't populated.
  const cfgDisablePeriodicities =
    !!(timeConfig as { disablePeriodicities?: boolean } | undefined)?.disablePeriodicities ||
    !!timeTabConfig?.disablePeriodicities ||
    !!timeTabConfig?.fixed?.disablePeriodicities;

  // Comparison state — mirrors shift state: draft in-picker, committed on Apply.
  // Comparison is "available" when the config enables the flag OR the default
  // display mode is comparison. The second signal matters for GTP: the GTP
  // inherits the mode, but Lens's runtime timeConfig update may not echo the
  // per-widget `comparisonMode` flag — so a `defaultDisplayMode === 'comparison'`
  // must be enough on its own to enter (and stay in) comparison view.
  const cfgComparisonMode = !!timeConfig?.comparisonMode || defaultDisplayMode === 'comparison';
  const [comparisonToggleOn, setComparisonToggleOn] = useState(
    () => defaultDisplayMode === 'comparison' && cfgComparisonMode,
  );
  const [draftComparisonOn, setDraftComparisonOn] = useState(
    () => defaultDisplayMode === 'comparison' && cfgComparisonMode,
  );
  useEffect(() => {
    if (!cfgComparisonMode) {
      setComparisonToggleOn(false);
      setDraftComparisonOn(false);
    }
  }, [cfgComparisonMode]);

  // Live-update: when the configurator changes defaultDisplayMode, immediately
  // flip the toggles and re-emit TIME_CHANGE so the chart and data both update
  // without requiring a save + refresh cycle.
  const defaultDisplayModeInitRef = useRef(false);
  useEffect(() => {
    if (!defaultDisplayModeInitRef.current) {
      defaultDisplayModeInitRef.current = true;
      return; // skip on first run — host handles the initial query
    }
    const mode = defaultDisplayMode;
    const shiftOn = resolveShiftOn(mode, isGTPModeRef.current);
    const compOn = mode === 'comparison' && cfgComparisonMode;
    setShiftToggleOn(shiftOn);
    setDraftShiftOn(shiftOn);
    setComparisonToggleOn(compOn);
    setDraftComparisonOn(compOn);
    // Re-emit TIME_CHANGE with the new mode params so the host re-fetches data.
    if (!rangeValue) return;
    const startMs = new Date(rangeValue.start).getTime();
    const endMs = new Date(rangeValue.end).getTime();
    onEventRef.current?.({
      type: 'TIME_CHANGE',
      payload: {
        startTime: String(startMs),
        endTime: String(endMs),
        periodicity: selectedPeriodicity.toLowerCase(),
        ...(shiftOn ? shiftEventPayload(cfgShifts, cfgShiftAggregator) : {}),
        ...(compOn ? comparisonWindowPayload(startMs, endMs) : {}),
        ...controlFlags(),
      },
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultDisplayMode]);

  // Live timezone change → re-emit TIME_CHANGE so the host re-resolves with the
  // NEW zone immediately (matching what a save + reload produces). Without this,
  // editing the timezone updates the saved envelope but the live re-resolve keeps
  // using the stale/default zone until reload. Skip the first run (host owns the
  // initial query) exactly like the defaultDisplayMode effect above.
  const timezoneInitRef = useRef(false);
  useEffect(() => {
    if (!timezoneInitRef.current) {
      timezoneInitRef.current = true;
      return;
    }
    if (!rangeValue) return;
    const startMs = new Date(rangeValue.start).getTime();
    const endMs = new Date(rangeValue.end).getTime();
    onEventRef.current?.({
      type: 'TIME_CHANGE',
      payload: {
        startTime: String(startMs),
        endTime: String(endMs),
        periodicity: selectedPeriodicity.toLowerCase(),
        ...modeEventFields(startMs, endMs),
        ...controlFlags(), // carries the new timezone
      },
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeConfig?.timezone]);

  // Shift and comparison are mutually exclusive — activating one deactivates the other.
  const draftActivateShift = (on: boolean) => {
    setDraftShiftOn(on);
    if (on) setDraftComparisonOn(false);
  };
  const draftActivateComparison = (on: boolean) => {
    setDraftComparisonOn(on);
    if (on) setDraftShiftOn(false);
  };
  const commitToggles = () => {
    setShiftToggleOn(draftShiftOn);
    setComparisonToggleOn(draftComparisonOn);
  };
  const syncDraftFromCommitted = () => {
    setDraftShiftOn(shiftToggleOn);
    setDraftComparisonOn(comparisonToggleOn);
  };

  // Under a GTP the shift/comparison controls live in the DatePicker, which the
  // widget HIDES in GTP mode — so the toggle state can never turn on, and
  // `defaultDisplayMode` stays 'normal'. The GTP instead drives the mode by what
  // data it makes the host resolve (confirmed via the host's emitted payload:
  // shift-mode → the query carries `shifts`, so the backend returns shift-tagged
  // buckets; compare-mode → the response carries comparisonSlots). So under GTP
  // we DERIVE the mode from the resolved DATA rather than the (unreachable)
  // toggles: any slot with a shift tag → shift; any series with comparisonSlots
  // → comparison. Outside GTP we stay strictly toggle-driven (see below).
  const gtpDataMode = useMemo<'normal' | 'comparison' | 'shift' | null>(() => {
    if (!isGTPMode) return null;
    let hasShift = false;
    let hasComparison = false;
    (activeChart?.series ?? []).forEach((_s, si) => {
      const p =
        getSeriesData(`charts[${chartIndex}].series[${si}].unsPath`, data) ??
        getSeriesData(`charts[${chartIndex}].series[${si}].dataSource`, data);
      if (!p) return;
      if (Array.isArray(p.slots) && p.slots.some((sl: any) => sl?.shift !== undefined && sl?.shift !== '')) hasShift = true;
      if (Array.isArray((p as any).comparisonSlots) && (p as any).comparisonSlots.length > 0) hasComparison = true;
    });
    return hasShift ? 'shift' : hasComparison ? 'comparison' : 'normal';
  }, [isGTPMode, activeChart, chartIndex, data]);

  const chartMode = useMemo<'normal' | 'comparison' | 'shift'>(() => {
    // GTP: data-driven (see gtpDataMode) — the toggles are inaccessible so the
    // resolved data is the only source of truth for the GTP's live mode.
    if (gtpDataMode) return gtpDataMode;
    // Local/Fixed: purely toggle-driven — toggle state is initialized from
    // defaultDisplayMode on mount and updated via the user's Apply action in the
    // DatePicker. No data-driven fallback here: that would make stale shift/
    // comparison data from the previous mode bleed into the new mode while fresh
    // data loads, and it caused shift view to show after refresh even when
    // defaultDisplayMode='normal'. Shift is supported in realtime too (v1 parity).
    if (shiftToggleOn && cfgShifts.length > 0) return 'shift';
    if (comparisonToggleOn && cfgComparisonMode) return 'comparison';
    return 'normal';
  }, [gtpDataMode, shiftToggleOn, comparisonToggleOn, cfgShifts.length, cfgComparisonMode]);

  // Latest committed comparison flag for TIME_CHANGE emitters that fire from
  // effects/callbacks whose dependency lists don't track it.
  const comparisonActiveRef = useRef(false);
  comparisonActiveRef.current = cfgComparisonMode && comparisonToggleOn;

  // Latest committed shift flag for TIME_CHANGE emitters that fire from
  // effects/callbacks whose dependency lists don't track it. Shift and
  // comparison are mutually exclusive, so a payload carries at most one.
  const shiftActiveRef = useRef(false);
  shiftActiveRef.current = shiftToggleOn && cfgShifts.length > 0;

  // Extra TIME_CHANGE fields for the currently committed mode. Shift and
  // comparison are mutually exclusive — send at most one. Used by the emit
  // sites whose closures read the latest committed flags via refs (mount,
  // preset, periodicity, drilldown). onRangeChange builds these inline from
  // the just-committed draft values instead (refs haven't re-rendered yet).
  const modeEventFields = (startMs: number, endMs: number) =>
    shiftActiveRef.current
      ? shiftEventPayload(cfgShifts, cfgShiftAggregator)
      : comparisonActiveRef.current
        ? comparisonWindowPayload(startMs, endMs)
        : {};

  // Active periodicity (declared here — ahead of the shift/highcharts memos that
  // read it — so shift rendering can branch on granularity). The DatePicker's
  // periodicity dropdown drives it; effects further below keep it in sync.
  const [selectedPeriodicity, setSelectedPeriodicity] = useState<string>(
    () => computeDefaultPeriodicity(timeConfig),
  );
  // Sub-daily granularity (minute/hourly): shifts are contiguous time-of-day
  // blocks that should join into ONE continuous line (boundary bridging +
  // connectNulls off). At Daily and coarser each shift is its own trend line
  // across days, connected across gaps (connectNulls on, no bridging).
  // Realtime is always sub-daily (live readings, never coarse buckets).
  const shiftSubDaily = config?.realtimeMode || ['minute', 'hourly'].includes(selectedPeriodicity.toLowerCase());

  // Resolve each configured series from `data` (series binding key matches the
  // configurator's: charts[ci].series[si].dataSource). Categories are the slot
  // labels of the longest series (backend returns aligned, pre-bucketed slots).
  const { series, categories, catTimestamps, catShifts, hasBreakdownGaps } = useMemo(() => {
    const configured = activeChart?.series ?? [];
    const resolved = configured.map((s, si) => {
      const payload =
        getSeriesData(`charts[${chartIndex}].series[${si}].unsPath`, data) ??
        // Legacy key from envelopes saved before the dataSource → unsPath rename.
        getSeriesData(`charts[${chartIndex}].series[${si}].dataSource`, data);
      const slots = payload?.slots ?? [];
      // Measurement unit from the resolved payload meta — appended to the value
      // in the tooltip (v1 parity). "." is the backend's "no unit" sentinel.
      const rawUnit = (payload as any)?.meta?.unit;
      const unit = typeof rawUnit === 'string' && rawUnit !== '.' ? rawUnit : '';
      return { def: s, slots, unit };
    });
    const longest = resolved.reduce(
      (best, r) => (r.slots.length > best.length ? r.slots : best),
      [] as { label: string; value: number | null; from: number; to: number; shift?: string }[],
    );
    // Label for a bucket — the backend label, else derived from its start.
    const labelFor = (slot: { label?: string; from: number; to: number }): string => {
      if (slot.label) return slot.label;
      const ms = slot.from;
      const dur = slot.to - slot.from; // bucket duration in ms
      const d = new Date(ms);
      if (dur < 2 * 3600_000) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      if (dur < 32 * 86400_000) return d.toLocaleDateString([], { day: '2-digit', month: 'short' });
      if (dur < 366 * 86400_000) return d.toLocaleDateString([], { month: 'short', year: 'numeric' });
      return d.toLocaleDateString([], { year: 'numeric' });
    };

    // Derive the "normal" cadence from the median gap between consecutive bucket
    // starts. `interval` is the filler spacing; `breakThreshold` is the gap size
    // beyond which the line is severed (device-inactive break).
    //
    // Threshold source, in priority order:
    //   1. Configured Break-Series Timeout (BT) — activeChart.breakSeriesTimeout,
    //      in SECONDS (v1 parity). When set, a gap > BT*1000 breaks the line,
    //      regardless of the data's own cadence.
    //   2. Adaptive fallback — median gap × BREAK_GAP_FACTOR — used when no BT is
    //      configured, so coarse historical views still break only on genuinely
    //      large gaps (not every bucket).
    // NOTE: BT is a raw duration; on a coarse (e.g. daily) view a BT smaller than
    // the bucket size would break every bucket. Leave BT blank for those and let
    // the adaptive fallback handle it.
    const fromGaps: number[] = [];
    for (let i = 1; i < longest.length; i++) {
      const g = (longest[i] as any).from - (longest[i - 1] as any).from;
      if (g > 0) fromGaps.push(g);
    }
    let interval = 0; // normal cadence — filler spacing (needs ≥1 gap)
    if (fromGaps.length > 0) {
      const sorted = [...fromGaps].sort((a, b) => a - b);
      // Median once we have a stable sample (≥3 gaps); else the smallest gap so
      // fillers still have a sane spacing when there are only a couple of points.
      interval = fromGaps.length >= 3 ? sorted[Math.floor(sorted.length / 2)] : sorted[0];
    }
    const btSeconds = activeChart?.breakSeriesTimeout;
    let breakThreshold = Infinity;
    if (typeof btSeconds === 'number' && btSeconds > 0) {
      breakThreshold = btSeconds * 1000; // configured BT (seconds → ms)
    } else if (interval > 0 && fromGaps.length >= 3) {
      breakThreshold = interval * BREAK_GAP_FACTOR; // adaptive fallback
    }

    // Build categories / timestamps / shift-tags / per-series data together so
    // NULL filler buckets can be inserted across any breakdown gap. Fillers are
    // spaced at the normal cadence (`interval`) with real interpolated timestamps
    // + derived labels, so the empty span is WIDTH-proportional to the elapsed
    // dead time and the x-axis still shows dates inside it (v1 look). Fillers
    // carry a null value → the line breaks; `undefined` shift → null across every
    // shift series; they're not hoverable/clickable (null points).
    const cats: string[] = [];
    const catTs: { from: number; to: number }[] = [];
    const catSh: (string | undefined)[] = [];
    const seriesData: (number | null)[][] = resolved.map(() => []);
    // Breakdown breaks are a NORMAL-view feature only. In shift mode the shifts
    // must join end-to-end into one continuous colored line (v1 parity) — the
    // null fillers would chop that line into disconnected strips — so skip them.
    const allowBreaks = chartMode !== 'shift';
    let hasBreakdownGaps = false;
    longest.forEach((slot: any, idx: number) => {
      if (idx > 0 && interval > 0 && allowBreaks) {
        const prevFrom = (longest[idx - 1] as any).from as number;
        const gap = slot.from - prevFrom;
        if (gap > breakThreshold) {
          hasBreakdownGaps = true;
          const count = Math.min(MAX_BREAK_FILLERS, Math.max(1, Math.round(gap / interval) - 1));
          for (let k = 1; k <= count; k++) {
            const t = prevFrom + interval * k;
            cats.push(labelFor({ from: t, to: t + interval }));
            catTs.push({ from: t, to: t + interval });
            catSh.push(undefined);
            resolved.forEach((_, si) => seriesData[si].push(null));
          }
        }
      }
      cats.push(labelFor(slot));
      catTs.push({ from: slot.from, to: slot.to });
      catSh.push(slot.shift);
      resolved.forEach((r, si) => {
        seriesData[si].push(coerceSlotValue(r.slots[idx]?.value));
      });
    });

    const out = resolved.map((r, i) => ({
      name: r.def.name || `Series ${i + 1}`,
      color: r.def.color,
      data: seriesData[i],
      // "Add Source as Tooltip": omit from the DOM legend. The SDK builds its
      // legend from THIS prop (filtering `showInLegend !== false`), NOT from
      // highchartsOptions — so the flag must live here, not only in the
      // per-series highchartsOptions overrides (which hide the line/marker).
      ...(r.def.addAsTooltip ? { showInLegend: false } : {}),
      tooltip: {
        valueDecimals: typeof r.def.dataPrecision === 'number' ? r.def.dataPrecision : 2,
        // Custom field carried through to the tooltip formatter (Highcharts
        // preserves unknown keys on series.options.tooltip).
        unit: r.unit,
      },
    }));
    return { series: out, categories: cats, catTimestamps: catTs, catShifts: catSh, hasBreakdownGaps };
  }, [activeChart, chartIndex, data, chartMode]);

  // Full date+time label per category for the SDK tooltip's date footer
  // (`tooltipCategories` prop). Without it the SDK tooltip falls back to the
  // short axis label ("01 Aug"); this gives the hovered point's full timestamp.
  const tooltipCategories = useMemo<string[]>(() => {
    const tz = timeConfig?.timezone || undefined;
    const fmt = (ms: number) => {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: tz,
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: false,
      }).formatToParts(new Date(ms));
      const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
      return `${g('day')} ${g('month')} ${g('year')} ${g('hour')}:${g('minute')}`;
    };
    return catTimestamps.map((t, i) => {
      if (!t || typeof t.from !== 'number') return categories[i] ?? '';
      const next = catTimestamps[i + 1]?.from;
      const end = typeof next === 'number' ? next : (t.to && t.to !== t.from ? t.to : undefined);
      return end && end !== t.from ? `${fmt(t.from)} - ${fmt(end)}` : fmt(t.from);
    });
  }, [catTimestamps, categories, timeConfig?.timezone]);

  // Realtime x-axis thinning. Live data is minute-level, so a category axis
  // labels every single slot and packs the axis solid (dense, unreadable). v1's
  // datetime axis instead shows a HANDFUL of labels at a "nice" interval that
  // scales with the window (hourly for a day, 12-hourly for a few days, etc.).
  // We reproduce that on the category axis: pick a nice hour-step from the total
  // span so ~REALTIME_TARGET_TICKS labels remain, then place a tick at the first
  // bucket of each clock hour that is a multiple of that step (in the widget's
  // timezone). Midnight ticks render the date; others render HH:00. Undefined
  // when not in realtime so normal category behaviour is untouched.
  const realtimeTicks = useMemo<{ positions: number[]; daily: boolean } | undefined>(() => {
    if (!config?.realtimeMode || catTimestamps.length === 0) return undefined;
    const tz = timeConfig?.timezone || undefined;
    const withTs = catTimestamps.filter((t) => t?.from != null && !Number.isNaN(t.from));
    if (withTs.length === 0) return undefined;
    const rangeHours = Math.max(1, (withTs[withTs.length - 1].from - withTs[0].from) / 3_600_000);
    const step =
      NICE_HOUR_STEPS.find((s) => rangeHours / s <= REALTIME_TARGET_TICKS) ??
      NICE_HOUR_STEPS[NICE_HOUR_STEPS.length - 1];
    const daily = step >= 24;

    if (daily) {
      // Day-or-larger ranges: one candidate tick per calendar DAY (first bucket of
      // that day, at ANY hour — realtime buckets are rarely at midnight), then keep
      // every (step/24)-th day so the label count stays ~target. Labelled as dates.
      const dayFirsts: number[] = [];
      let lastDay = '';
      catTimestamps.forEach((t, i) => {
        if (t?.from == null || Number.isNaN(t.from)) return; // skip synthetic break buckets
        const p = tzParts(t.from, tz);
        if (p.dayKey === lastDay) return;
        lastDay = p.dayKey;
        dayFirsts.push(i);
      });
      const everyNDays = Math.max(1, Math.round(step / 24));
      return { positions: dayFirsts.filter((_, i) => i % everyNDays === 0), daily };
    }

    // Intraday: first bucket of each clock hour that is a multiple of `step`.
    const positions: number[] = [];
    let lastKey = '';
    catTimestamps.forEach((t, i) => {
      if (t?.from == null || Number.isNaN(t.from)) return;
      const p = tzParts(t.from, tz);
      const key = `${p.dayKey} ${p.hour}`;
      if (key === lastKey) return;
      lastKey = key;
      if (p.hour % step === 0) positions.push(i);
    });
    return { positions, daily };
  }, [config?.realtimeMode, catTimestamps, timeConfig?.timezone]);

  // The SDK's `shift` and `comparison` props own rendering in those modes;
  // `series` is passed through but ignored by the chart when either prop is set.
  const effectiveSeries = series;

  // Render whenever the backend returned slots for any series — even if all
  // values are null / non-numeric (the backend can return string sentinels
  // like " N/A" for compute sources, which our slot-to-number map turns into
  // null). The X-axis with time labels still renders and the user can see
  // the range / confirm the source is wired. The empty state is only for
  // when ZERO slots came back.
  const hasSlots = effectiveSeries.some((s) => s.data.length > 0);

  // True when at least one series has a numeric point to plot. When false the
  // canvas would otherwise show Highcharts' bare "No data to display" text — we
  // render the branded EmptyState instead (v1 parity). Covers three data-related
  // cases uniformly: zero slots came back, every value is null (compute "N/A"
  // sentinels), and backend errors (e.g. Redis loading) that yield no slots.
  const hasPlottableData = effectiveSeries.some((s) =>
    s.data.some((v: any) => typeof v === 'number' && !Number.isNaN(v)),
  );

  // Loading state: no data has arrived yet AND the chart has bound series that
  // expect data. Distinguishes "still fetching" (show a spinner) from "no data
  // found" (show the empty state) on first load. Mirrors ColumnChart.
  //
  // Safeguard: `data.length === 0` alone can't tell "fetch in progress" from
  // "fetch resolved empty" (both are []). If the response for this chart is
  // empty, or the resolved data never reaches this widget (binding/routing
  // issue), the spinner would otherwise show forever. So we cap the spinner: if
  // data still hasn't arrived after LOADING_TIMEOUT_MS, fall back to the empty
  // state. When data does arrive later, the chart renders regardless.
  const dataEmpty = data.length === 0;
  const hasBoundSeries = (activeChart?.series ?? []).some(
    (s) => isBound(s.unsPath || s.dataSource),
  );

  // Has the host ever answered for this widget? Separates the FIRST-load spinner
  // (nothing fetched yet) from a REFETCH spinner (data already on screen, a new
  // query in flight). Set once real data lands, or once a pending refetch
  // resolves (even to empty/error) — after that, an empty response means the
  // dedicated "no data" screen, not another 15 s spinner.
  const [everResolved, setEverResolved] = useState(false);

  // Refetch-in-flight bridge. When the user changes the selected time window or
  // periodicity, the widget emits TIME_CHANGE and the host re-queries — but the
  // OLD `data` stays mounted until the response lands, so `dataEmpty` alone can't
  // surface a loader on a refetch. `awaitingData` fills that gap: set the moment
  // the user changes time/periodicity (via beginPendingFetch), cleared the moment
  // a NEW `data` reference arrives (success OR empty/error) so the dedicated
  // screen — chart, empty state — takes over.
  const [awaitingData, setAwaitingData] = useState(false);
  const awaitingDataRef = useRef(false);
  const beginPendingFetch = () => {
    awaitingDataRef.current = true;
    setAwaitingData(true);
  };
  // A fresh `data` reference means the host responded. Drop the pending flag and
  // mark the widget resolved so the appropriate resolved screen renders.
  useEffect(() => {
    if (awaitingDataRef.current) {
      awaitingDataRef.current = false;
      setAwaitingData(false);
      setEverResolved(true);
    } else if (data.length > 0) {
      setEverResolved(true);
    }
  }, [data]);

  // First-load spinner: bound series, no data yet, host hasn't answered. Refetch
  // spinner: a user time/periodicity change is in flight. Either way, cap the
  // spinner at LOADING_TIMEOUT_MS so a response that never reaches this widget
  // (binding/routing issue, or an in-place data mutation) falls back gracefully.
  // Host-loader settle (mirrors ColumnChart): the host can drop `loader` to
  // false a beat BEFORE the fresh `data` prop lands (flag and data travel on
  // separate update paths). Keep the loader up ("settling") from when the host
  // RAISED it until the `data` reference actually moves, so we never flash the
  // stale chart between "loader off" and the new data. Computed synchronously in
  // render so there's no painted frame in the gap.
  const dataAtLoaderRaiseRef = useRef<DataEntry[] | null>(null);
  const prevLoaderRef = useRef(false);
  if (loader && !prevLoaderRef.current) dataAtLoaderRaiseRef.current = data;
  prevLoaderRef.current = loader;
  const loaderSettling =
    !loader && dataAtLoaderRaiseRef.current !== null && data === dataAtLoaderRaiseRef.current;
  const [, forceLoaderSettleRerender] = useState(0);
  useEffect(() => {
    if (!loaderSettling) return;
    // Safety net: loader pulse that never changes the data — release after 5s.
    const timer = setTimeout(() => {
      dataAtLoaderRaiseRef.current = null;
      forceLoaderSettleRerender((n) => n + 1);
    }, 5000);
    return () => clearTimeout(timer);
  }, [loaderSettling]);

  // `hostLoading` is the host's flag (+ its settle tail) — true while Lens
  // re-resolves, INCLUDING GTP-driven refetches the widget never emitted (so
  // `awaitingData` stays false). Fold it in so those still surface a loader.
  const hostLoading = loader || loaderSettling;
  const firstLoadPending = !everResolved && dataEmpty && (hasBoundSeries || hostLoading);
  const loaderActive = firstLoadPending || awaitingData || hostLoading;
  const [loadingExpired, setLoadingExpired] = useState(false);
  useEffect(() => {
    if (!loaderActive) {
      setLoadingExpired(false);
      return;
    }
    setLoadingExpired(false); // fresh fetch (data ref changed / new request) → restart
    const t = setTimeout(() => setLoadingExpired(true), LOADING_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [data, awaitingData, loaderActive]);
  // Two-tier loader (mirrors CombinedBarLineChart):
  //  • FIRST load — no data yet — replaces the empty canvas with a spinner.
  //  • REFETCH — data already on screen (time/periodicity/compare/shift change,
  //    or a GTP-driven requery via `hostLoading`) — an overlay over the chart so
  //    the header + controls stay visible instead of blanking the widget.
  const isLoadingData = firstLoadPending && !loadingExpired;
  const isRefetching = (hostLoading || awaitingData) && !dataEmpty && !loadingExpired;

  // "Add Source as Tooltip" — these series stay in the dataset (shared tooltip)
  // but render no line and no legend chip. Index-aligned with `series`.
  const tooltipOnlyFlags = useMemo(
    () => (activeChart?.series ?? []).map((s) => !!s.addAsTooltip),
    [activeChart],
  );
  const hasTooltipOnly = useMemo(() => tooltipOnlyFlags.some(Boolean), [tooltipOnlyFlags]);
  const tooltipOnlyNames = useMemo(
    () =>
      (activeChart?.series ?? [])
        .map((s, i) => ({ name: s.name || `Series ${i + 1}`, tip: !!s.addAsTooltip }))
        .filter((x) => x.tip)
        .map((x) => x.name),
    [activeChart],
  );
  // When shifts expand the series list, repeat the tooltip-only flag per shift copy
  // and generate the expanded name list for legend-chip hiding.
  const effectiveTooltipOnlyFlags = tooltipOnlyFlags;
  const effectiveTooltipOnlyNames = tooltipOnlyNames;

  // Comparison mode — the previous-period buckets arrive as `comparisonSlots`
  // on each series in the `data` prop. When comparison is active the widget
  // emits the previous-period window in its TIME_CHANGE event; the data layer
  // forwards it to resolveAndCompute so the SAME call returns comparisonSlots
  // alongside the current slots. No separate widget-side fetch.

  // Source → y-axis index (0 = left/default, 1+ = a Right-position axis).
  // Extracted here (the full `multiAxis` memo is defined later and also pulls in
  // plotLines/bands) so the shift and comparison series — which the SDK generates
  // from shiftProp/comparisonProp — can bind to the right axis. Without a binding
  // every generated series defaults to axis 0 and the right axis is left with no
  // series, so Highcharts drops its tick labels. null when there are no right axes.
  const seriesAxisMap = useMemo<number[] | null>(() => {
    const rightAxes = (activeChart?.axes ?? []).filter((a) => a.position === 'Right');
    if (rightAxes.length === 0) return null;
    return (activeChart?.series ?? []).map((s) => {
      const idx = rightAxes.findIndex((a) => (a.linkedSeriesIds ?? []).includes(s._id));
      return idx === -1 ? 0 : idx + 1;
    });
  }, [activeChart]);

  // Comparison mode: build ChartComparisonConfig from current + previous period data.
  const widgetDeviationPattern: DeviationPattern =
    (timeConfig?.deviationPattern as DeviationPattern) ?? 'green-up-positive';

  const comparisonProp = useMemo<ChartComparisonConfig | undefined>(() => {
    if (chartMode !== 'comparison') return undefined;
    const configured = activeChart?.series ?? [];
    if (!configured.length || !categories.length) return undefined;

    const out: ComparisonSeriesInput[] = [];
    configured.forEach((s, i) => {
      const name = s.name || `Series ${i + 1}`;
      const currentData = series[i]?.data ?? [];

      // Previous period — read `comparisonSlots` off the SAME resolved series
      // payload that produced the current line (the data layer ran comparison
      // mode in one resolveAndCompute call). The backend index-aligns
      // comparisonSlots to the current window's buckets (comparisonSlots[k] is
      // the previous-period value for the SAME bucket k), so pair by index.
      // Null per slot until the comparison-enabled response arrives.
      const compPayload =
        getSeriesData(`charts[${chartIndex}].series[${i}].unsPath`, data) ??
        getSeriesData(`charts[${chartIndex}].series[${i}].dataSource`, data);
      const prevData: (number | null)[] = (() => {
        const cs = compPayload?.comparisonSlots;
        if (!cs) return currentData.map(() => null);
        return currentData.map((_, ci) => coerceSlotValue(cs[ci]?.value));
      })();

      const deviation = currentData.map((y, k) => {
        const p = prevData[k];
        if (y === null || p === null || p === 0) return null;
        return Math.round(((y - p) / Math.abs(p)) * 1000) / 10;
      });

      const pattern: DeviationPattern =
        (timeConfig?.sourceDeviationOverrides?.[`${activeChart?._id}:${s._id}`] as DeviationPattern) ??
        widgetDeviationPattern;

      // Bind both the current and the previous-period series to THIS source's
      // axis, so a right-axis source keeps the right axis populated in compare
      // mode (otherwise every comparison series defaults to axis 0 and the right
      // axis loses its tick labels).
      const meta = {
        sourceId: s._id, sourceName: name, sourceIndex: i, shiftColor: s.color,
        ...(seriesAxisMap ? { yAxis: seriesAxisMap[i] ?? 0 } : {}),
      };

      out.push({
        ...meta,
        shiftId: 'current',
        shiftName: name,
        shiftIndex: 0,
        data: currentData,
        seriesType: 'line',
        showInLegend: true,
      });
      out.push({
        ...meta,
        shiftId: 'comparison',
        shiftName: `${name} (prev)`,
        shiftIndex: 1,
        data: prevData,
        dashStyle: 'Dash',
        showInLegend: false,
        deviation,
        deviationPattern: pattern,
      });
    });

    return { series: out, showDeviation: true, deviationPattern: widgetDeviationPattern, comparisonCategories: categories };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartMode, activeChart, chartIndex, series, categories, catTimestamps, data, widgetDeviationPattern, timeConfig?.sourceDeviationOverrides, seriesAxisMap]);

  // Shift mode: build ChartShiftConfig directly from slot data + shift windows.
  // Each source × enabled shift becomes a ShiftSeriesInput; the SDK renders
  // colored series and shows shift chips in the legend footer.
  const shiftProp = useMemo<ChartShiftConfig | undefined>(() => {
    if (chartMode !== 'shift' || cfgShifts.length === 0 || series.length === 0) return undefined;
    const tz = timeConfig?.timezone;
    // Every value the backend might use to tag a bucket's shift — the shift NAME
    // or its ID. Used to tell "tag belongs to a known shift" (trust it) from
    // "tag is absent / unrecognized" (fall back to the time-of-day window). The
    // old code only compared the tag to `shift.name`; if the backend tagged with
    // the shift ID instead, every bucket hit the `return null` path (tag present
    // but != name, and the time fallback was skipped) → all-null series → shift
    // never drew. Matching name OR id, plus falling back on an unknown tag, fixes it.
    const knownShiftKeys = new Set<string>();
    cfgShifts.forEach((sh) => { if (sh.name) knownShiftKeys.add(sh.name); if (sh.id) knownShiftKeys.add(sh.id); });
    const matchesShift = (tag: unknown, sh: typeof cfgShifts[number]) =>
      tag === sh.name || tag === sh.id;
    const out: ShiftSeriesInput[] = [];
    series.forEach((s, si) => {
      cfgShifts.forEach((shift, shIdx) => {
        if (!enabledShiftIds.has(shift.id)) return;
        out.push({
          sourceId: activeChart?.series[si]?._id ?? String(si),
          sourceName: s.name,
          sourceIndex: si,
          shiftId: shift.id,
          shiftName: shift.name,
          shiftIndex: shIdx,
          shiftColor: shift.color,
          seriesType: 'line',
          // Bind to this SOURCE's axis so right-axis sources land on the right
          // axis. Without it every generated shift series defaults to axis 0 and
          // the right axis is left with no series → its tick labels disappear.
          ...(seriesAxisMap ? { yAxis: seriesAxisMap[si] ?? 0 } : {}),
          data: s.data.map((v, ci) => {
            const tag = catShifts[ci];
            // Trust the tag only if it names a KNOWN shift (by name or id).
            if (tag !== undefined && tag !== '' && knownShiftKeys.has(String(tag))) {
              if (matchesShift(tag, shift)) return v;
              // Boundary bridge — sub-daily (minute/hourly) ONLY: emit the value
              // at the first bucket after this shift's run (the next shift's
              // opening bucket) so 00–08 / 08–16 / 16–00 join into one line.
              if (shiftSubDaily && matchesShift(catShifts[ci - 1], shift)) return v;
              return null;
            }
            // Tag absent OR unrecognized → time-of-day window check.
            const ts = catTimestamps[ci];
            if (!ts?.from) return null;
            return isSlotInShift(ts.from, shift.startTime, shift.endTime, tz) ? v : null;
          }),
        });
      });
    });
    return {
      series: out,
      sources: series.map((s, i) => ({ index: i, name: s.name })),
      shifts: cfgShifts.map((s) => ({
        id: s.id, name: s.name, color: s.color, enabled: enabledShiftIds.has(s.id),
      })),
      onToggleShift: (id: string) =>
        setEnabledShiftIds((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        }),
      onToggleSource: () => {},
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartMode, cfgShiftKey, series, catTimestamps, catShifts, enabledShiftIds, activeChart, timeConfig?.timezone, shiftSubDaily, seriesAxisMap]);

  // TEMP mode diagnostic — logs how the widget resolves shift vs compare vs
  // normal, so a failed SWITCH between them can be pinpointed. Remove once
  // confirmed. Key fields for the shift↔compare switch bug:
  //   • chartMode / gtpDataMode  → what the widget decided
  //   • dataHasShiftTags / dataHasComparisonSlots → what the RESOLVED DATA carries
  //     (if BOTH are true, the source data isn't mode-exclusive — host issue)
  //   • shiftToggleOn / comparisonToggleOn → local toggle state (local mode only)
  useEffect(() => {
    let dataHasShiftTags = false;
    let dataHasComparisonSlots = false;
    (activeChart?.series ?? []).forEach((_s, i) => {
      const p =
        getSeriesData(`charts[${chartIndex}].series[${i}].unsPath`, data) ??
        getSeriesData(`charts[${chartIndex}].series[${i}].dataSource`, data);
      if (!p) return;
      if (Array.isArray(p.slots) && p.slots.some((sl: any) => sl?.shift !== undefined && sl?.shift !== '')) dataHasShiftTags = true;
      if (Array.isArray((p as any).comparisonSlots) && (p as any).comparisonSlots.length > 0) dataHasComparisonSlots = true;
    });
    // eslint-disable-next-line no-console
    console.error('[LCW mode debug]', {
      chartMode,
      gtpDataMode,
      isGTPMode,
      dataHasShiftTags,
      dataHasComparisonSlots,
      bothPresent: dataHasShiftTags && dataHasComparisonSlots,
      shiftToggleOn,
      comparisonToggleOn,
      cfgComparisonMode,
      catShiftsSample: catShifts.slice(0, 8),
      selectedPeriodicity,
      // Bucket timing + label → the true periodicity of the returned data.
      // durDays ≈ 7 → weekly buckets (so a monthly label is a BACKEND label bug);
      // durDays ≈ 28–31 → monthly buckets (so the GTP's weekly periodicity never
      // reached the query). Either way it's upstream of the chart.
      bucketsSample: catTimestamps.slice(0, 5).map((t, i) => ({
        from: typeof t?.from === 'number' ? new Date(t.from).toISOString() : null,
        durDays: t?.from && t?.to ? Math.round((t.to - t.from) / 86_400_000) : null,
        label: categories[i],
      })),
    });
  }, [chartMode, gtpDataMode, isGTPMode, shiftToggleOn, comparisonToggleOn, cfgComparisonMode, catShifts, activeChart, chartIndex, data, selectedPeriodicity, catTimestamps, categories]);

  // Plot lines (fixed values only — periodicity-dependent lines need the live
  // periodicity context which the host owns, so they're rendered server-side).
  const plotLines = useMemo<ChartPlotLine[]>(() => {
    const BINDING_RE = /^\{\{.+\}\}$/;
    const activePeriodicity = selectedPeriodicity.toLowerCase();
    const out: ChartPlotLine[] = [];
    (activeChart?.plotLines ?? []).forEach((p, pi) => {
      // BUG 1 — enforce periodicity dependence. A plot line marked
      // 'dependent' with a periodicities list should ONLY render when the
      // chart's current periodicity is in that list. This filter was missing,
      // so dependent lines rendered for every periodicity.
      if (
        p.periodicityType === 'dependent' &&
        p.periodicities?.length &&
        !p.periodicities.map((x) => String(x).toLowerCase()).includes(activePeriodicity)
      ) {
        return; // not for the active periodicity — skip
      }

      const rawValue = p.value ?? p.fixedValue ?? p.dynamicTopic ?? '';
      const isBinding = BINDING_RE.test(rawValue);

      if (isBinding) {
        let payload = getSeriesData(`charts[${chartIndex}].plotLines[${pi}].value`, data ?? []);
        // BUG 2 — dedupe-by-topic fallback. When a plot line is bound to the
        // SAME topic as a data source in this chart, the resolve API returns a
        // single entry keyed to the SERIES' binding path, not the plot line's —
        // so the plot line's own key finds nothing. Fall back to the matching
        // series' already-resolved payload.
        if (!payload) {
          const twin = (activeChart?.series ?? []).findIndex(
            (s) => (s.unsPath || (s as { dataSource?: string }).dataSource) === rawValue,
          );
          if (twin >= 0) {
            payload =
              getSeriesData(`charts[${chartIndex}].series[${twin}].unsPath`, data ?? []) ??
              getSeriesData(`charts[${chartIndex}].series[${twin}].dataSource`, data ?? []);
          }
        }
        if (!payload) return;
        // Last non-null slot value (coerced — the value may arrive as a string).
        const nums = payload.slots
          .map((s) => coerceSlotValue(s.value))
          .filter((n): n is number => n !== null);
        if (nums.length === 0) return;
        const v = nums[nums.length - 1];
        out.push({ value: v, color: p.color, width: p.lineWidth, dashStyle: p.lineStyle === 'Dashed' ? 'Dash' : (p.lineStyle || 'Solid'), label: p.name, _axisId: p.axisId ?? '' } as any);
      } else {
        const v = Number(rawValue);
        if (!Number.isFinite(v)) return;
        out.push({ value: v, color: p.color, width: p.lineWidth, dashStyle: p.lineStyle === 'Dashed' ? 'Dash' : (p.lineStyle || 'Solid'), label: p.name, _axisId: p.axisId ?? '' } as any);
      }
    });
    return out;
  }, [activeChart, chartIndex, data, selectedPeriodicity]);

  const plotBands = useMemo<(ChartPlotBand & { _axisId?: string })[]>(
    () =>
      (activeChart?.plotBands ?? [])
        .map((b) => {
          // Coerce to numbers (envelopes can carry strings) and NORMALIZE so the
          // band always spans low→high. Highcharts renders a plotBand as a rect
          // from `from` to `to`; if the user typed startValue > endValue, an
          // un-normalized band renders empty/mis-positioned.
          const a = Number(b.startValue);
          const z = Number(b.endValue);
          return {
            from: Math.min(a, z),
            to: Math.max(a, z),
            color: b.color,
            label: b.name,
            _axisId: b.axisId ?? '',
          };
        })
        // Drop bands with non-numeric or zero-height ranges — they'd render
        // nothing (or a degenerate line) and just confuse the picture.
        .filter((b) => Number.isFinite(b.from) && Number.isFinite(b.to) && b.from !== b.to),
    [activeChart],
  );

  // Anomaly highlighting: for each configured anomaly evaluate its condition
  // against resolved series data and produce per-point halo markers plus
  // vertical x-axis plotLines at the matching time buckets.
  const anomalyOverlay = useMemo(() => {
    const configured = activeChart?.series ?? [];
    const anomalies = activeChart?.anomalies ?? [];
    if (!anomalies.length || !configured.length || !series.length) return null;

    const idxById = new Map(configured.map((s, i) => [s._id, i]));

    const cmp = (a: number, op: string, b: number): boolean => {
      switch (op) {
        case '>':  return a > b;
        case '<':  return a < b;
        case '>=': return a >= b;
        case '<=': return a <= b;
        case '==': return a === b;
        case '!=': return a !== b;
        default: return false;
      }
    };

    const HALO_RED = 'rgba(239,68,68,0.3)';
    const xPlotLines: Array<Record<string, unknown>> = [];
    // seriesIdx → (pointIdx → anomaly colour)
    const marked = new Map<number, Map<number, string>>();

    anomalies.forEach((anom, ai) => {
      const si = idxById.get(anom.applyToSeriesId);
      if (si === undefined) return;
      const color = anom.color || '#ef4444';
      const seriesData = series[si]?.data ?? [];

      for (let pi = 0; pi < seriesData.length; pi++) {
        const pointVal = seriesData[pi];
        if (pointVal === null || !Number.isFinite(pointVal)) continue;

        let threshold: number | undefined;
        if (anom.labelMode === 'Value') {
          threshold = anom.thresholdValue;
        } else if (anom.labelMode === 'Existing' && anom.existingSeriesId) {
          const ei = idxById.get(anom.existingSeriesId);
          if (ei === undefined) continue;
          const v = series[ei]?.data[pi];
          if (v === null || v === undefined || !Number.isFinite(v)) continue;
          threshold = v as number;
        } else if (anom.labelMode === 'NewSource') {
          const key = `charts[${chartIndex}].anomalies[${ai}].newSourceTopic`;
          const entry = (data ?? []).find((d) => d.key === key);
          if (!entry) continue;
          const payload = entry.value as SeriesPayload | null;
          if (!payload || payload.__type !== 'series') continue;
          const v = coerceSlotValue(payload.slots[pi]?.value);
          if (v === null) continue;
          threshold = v;
        } else {
          continue;
        }

        if (threshold === undefined || !Number.isFinite(Number(threshold))) continue;
        if (!cmp(pointVal, anom.operator, Number(threshold))) continue;

        if (!marked.has(si)) marked.set(si, new Map());
        marked.get(si)!.set(pi, color);

        xPlotLines.push({
          value: pi,
          color,
          width: 2,
          zIndex: 5,
        });
      }
    });

    if (!xPlotLines.length && !marked.size) return null;

    // Rebuild per-series data with explicit per-point marker objects. Setting
    // marker:enabled=false explicitly (not just omitting it) is what allows
    // Highcharts to clear stale halos when an anomaly is removed in-place.
    const seriesData = series.map((s, i) => {
      const marks = marked.get(i);
      return s.data.map((y, pi) =>
        marks?.has(pi)
          ? {
              y: y as number,
              marker: {
                enabled: true,
                radius: 5,
                fillColor: marks.get(pi),
                lineColor: HALO_RED,
                lineWidth: 8,
              },
            }
          : { y: y as any, marker: { enabled: false } },
      );
    });

    return { xPlotLines, seriesData };
  }, [activeChart, chartIndex, series, data]);

  const leftAxisTitle = useMemo(() => {
    const leftAxis = (activeChart?.axes ?? []).find(
      (a) => a.position === 'Left' && (a.name || '').trim().length > 0,
    );
    if (leftAxis) return leftAxis.name;
    return activeChart?.defaultAxis?.yAxisLabel || 'Value';
  }, [activeChart]);

  // Multi-axis: a secondary Y-axis per Right-position axis; route linked series.
  const multiAxis = useMemo(() => {
    const rightAxes = (activeChart?.axes ?? []).filter((a) => a.position === 'Right');
    if (rightAxes.length === 0) return null;
    const configured = activeChart?.series ?? [];
    const seriesAxis = configured.map((s) => {
      const idx = rightAxes.findIndex((a) => (a.linkedSeriesIds ?? []).includes(s._id));
      return idx === -1 ? 0 : idx + 1;
    });
    // A plot line/band belongs on the LEFT (default) axis when it has no axisId
    // OR its axisId doesn't correspond to one of the current RIGHT axes (e.g. it
    // targets the default axis's own id, or an axis that was since deleted).
    // Without the second condition those items silently vanish in multi-axis
    // mode — they match neither the left axis nor any right axis.
    const rightAxisIds = new Set(rightAxes.map((a) => a._id));
    const leftPlotLines = plotLines.filter(
      (p) => !(p as any)._axisId || !rightAxisIds.has((p as any)._axisId),
    );
    const leftPlotBands = plotBands.filter(
      (b) => !b._axisId || !rightAxisIds.has(b._axisId),
    );
    const leftAxis = {
      title: { text: leftAxisTitle },
      ...(leftPlotLines.length
        ? { plotLines: leftPlotLines.map((p) => ({ value: p.value, color: p.color, width: p.width, dashStyle: p.dashStyle, ...(p.label ? { label: buildPlotLineLabel(p.label, p.color) } : {}) })) }
        : {}),
      ...(leftPlotBands.length
        ? { plotBands: leftPlotBands.map((b) => ({ from: b.from, to: b.to, color: b.color, ...(b.label ? { label: { text: b.label } } : {}) })) }
        : {}),
    };
    const rightYAxes = rightAxes.map((a) => {
      const rpl = plotLines.filter((p) => (p as any)._axisId === a._id);
      const rpb = plotBands.filter((b) => b._axisId === a._id);
      return {
        title: { text: a.name || 'Axis' },
        opposite: true,
        ...(rpl.length ? { plotLines: rpl.map((p) => ({ value: p.value, color: p.color, width: p.width ?? 2, dashStyle: p.dashStyle ?? 'Dash', zIndex: 5, ...(p.label ? { label: buildPlotLineLabel(p.label, p.color) } : {}) })) } : {}),
        ...(rpb.length ? { plotBands: rpb.map((b) => ({ from: b.from, to: b.to, color: b.color, ...(b.label ? { label: { text: b.label } } : {}) })) } : {}),
      };
    });
    return { yAxis: [leftAxis, ...rightYAxes], seriesAxis };
  }, [activeChart, plotLines, plotBands, leftAxisTitle]);

  // ----- Styling (mirrors the configurator's Style tab) ---------------------
  const style = config?.style;
  const advanced = !!style?.advancedEnabled;

  const cardStyle = useMemo<React.CSSProperties | undefined>(() => {
    const card = style?.card;
    if (!card) return undefined;
    // Background Color and Border Color / Width apply when "Wrap Into Card"
    // is ON (default). Turning it OFF drops the background/border/padding so
    // the chart sits transparently inside whatever the dashboard provides.
    // Border Radius applies in both states.
    const base: React.CSSProperties = {
      borderRadius: typeof card.borderRadius === 'number' ? card.borderRadius : undefined,
    };
    if (card.wrapInCard !== false) {
      return {
        ...base,
        backgroundColor: card.backgroundColor || '#FFFFFF',
        borderStyle: 'solid',
        borderColor: card.borderColor,
        borderWidth: typeof card.borderWidth === 'number' ? card.borderWidth : undefined,
        boxShadow: 'none',
      };
    }
    return { ...base, background: 'transparent', border: 'none', padding: 0 };
  }, [style?.card]);

  const titleStyle = useMemo<React.CSSProperties>(() => {
    if (!advanced || !style?.chartTitle) return { fontSize: 18, fontWeight: 600 };
    const ct = style.chartTitle;
    return {
      fontSize: typeof ct.fontSize === 'number' ? ct.fontSize : 18,
      color: ct.fontColor || undefined,
      fontWeight: ct.fontWeight ? FONT_WEIGHT[ct.fontWeight] : 600,
    };
  }, [advanced, style?.chartTitle]);

  const axisColors = useMemo(() => {
    if (!advanced) return {} as { xTitle?: string; xLabel?: string; xLine?: string; yTitle?: string; yLabel?: string };
    return {
      xTitle: style?.xAxisLabel?.textColor || '#050505',
      xLabel: style?.xAxisLabel?.dataPointColor || '#050505',
      xLine: style?.xAxisLabel?.lineColor || '#DEE1E3',
      yTitle: style?.yAxisLabel?.textColor || '#050505',
      yLabel: style?.yAxisLabel?.dataPointColor || '#050505',
    };
  }, [advanced, style?.xAxisLabel, style?.yAxisLabel]);

  const miscColors = useMemo(() => {
    if (!advanced) return {} as { grid?: string; legend?: string };
    return {
      grid: style?.misc?.gridLineColor || '#DEE1E3',
      legend: style?.misc?.legendTextColor || '#292F2E',
    };
  }, [advanced, style?.misc]);

  const dataTableStyles = useMemo(() => {
    const dt = style?.dataTable;
    if (!dt) return undefined;
    return {
      header: {
        backgroundColor: dt.headerBackgroundColor || undefined,
        color: dt.headerTextColor || undefined,
        fontSize: typeof dt.headerTextSize === 'number' ? dt.headerTextSize : undefined,
        fontWeight: dt.headerTextWeight ? FONT_WEIGHT[dt.headerTextWeight] : undefined,
      } as React.CSSProperties,
      cell: {
        color: dt.dataPointTextColor || undefined,
        fontSize: typeof dt.dataPointTextSize === 'number' ? dt.dataPointTextSize : undefined,
        fontWeight: dt.dataPointTextWeight ? FONT_WEIGHT[dt.dataPointTextWeight] : undefined,
      } as React.CSSProperties,
    };
  }, [style?.dataTable]);

  // Per-chart in-widget UI overrides: NOT written back to the envelope (these
  const dcd = config?.style?.defaultChartDisplay;
  const [chartDisplay, setChartDisplay] = useState<ChartDisplay>({
    legends: dcd?.legends ?? true,
    dataLabel: dcd?.dataLabel ?? false,
    clipping: dcd?.clipping ?? false,
    inexactMultiple: false,
    zoom: dcd?.zoom ?? true,
    scroll: dcd?.scroll ?? false,
  });
  // Latest control flags for the scattered TIME_CHANGE emit sites (mount,
  // preset, periodicity, drilldown) whose closures read via a ref.
  const chartDisplayRef = useRef(chartDisplay);
  chartDisplayRef.current = chartDisplay;
  // Control flags appended to every TIME_CHANGE payload so the host always
  // refetches with the current Clipping / Inexact Multiple state.
  const controlFlags = () => ({
    clipping: chartDisplayRef.current.clipping,
    inexactMultiple: chartDisplayRef.current.inexactMultiple,
    // Ride the current timezone on every TIME_CHANGE so a LIVE re-resolve uses
    // the freshly-edited zone. On mount/save the host reads timeConfig.timezone
    // (correct), but a live edit re-resolves from the widget's payload — which
    // otherwise omits timezone and the host falls back to its default
    // (Asia/Kolkata). Sending it here keeps live edits and saved reloads identical.
    ...(timeConfig?.timezone ? { timezone: timeConfig.timezone } : {}),
  });

  // In full screen the widget owns the whole viewport, so the header chrome
  // (date/time picker, periodicity, duration label, export + settings icons) is
  // noise — hide it and let the chart fill the screen; the title is drawn in the
  // Highcharts canvas instead (see opts.title). Two ways a widget goes full
  // screen, so detect both:
  //   1. Browser Fullscreen API — the widget's own "View in full screen", OR a
  //      host that calls requestFullscreen() on the tile. `document
  //      .fullscreenElement` is non-null for the presenting element OR any of
  //      its ancestors, so a single check covers all API paths.
  //   2. A dashboard "maximize/expand" that just ENLARGES the tile with CSS
  //      fires no `fullscreenchange` at all. Detect it geometrically: the widget
  //      root covering (essentially) the entire viewport IS a maximize. In a
  //      multi-tile dashboard a normal widget never fills both axes to the edge,
  //      so this won't false-positive; the dev-harness split layout never does
  //      either. Re-checked on fullscreenchange, window resize, and a
  //      ResizeObserver on the root so it flips the moment the tile grows/shrinks.
  const [isFullscreen, setIsFullscreen] = useState(false);
  const lcwRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const compute = () => {
      if (document.fullscreenElement) return true;
      const el = lcwRef.current;
      if (el) {
        const r = el.getBoundingClientRect();
        if (r.width >= window.innerWidth - 4 && r.height >= window.innerHeight - 4) return true;
      }
      return false;
    };
    const onChange = () => setIsFullscreen(compute());
    onChange();
    document.addEventListener('fullscreenchange', onChange);
    window.addEventListener('resize', onChange);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onChange) : null;
    if (ro && lcwRef.current) ro.observe(lcwRef.current);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      window.removeEventListener('resize', onChange);
      ro?.disconnect();
    };
  }, []);

  const highchartsOptions = useMemo(() => {
    const titleEllipsis = { textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
    const xAxis: any = {};
    xAxis.title = { style: { ...titleEllipsis, ...(axisColors.xTitle ? { color: axisColors.xTitle } : {}) } };
    // Always show labels; rotate when dense so they never overlap and hide.
    xAxis.labels = {
      enabled: true,
      autoRotation: [-45],
      ...(axisColors.xLabel ? { style: { color: axisColors.xLabel } } : {}),
    };
    if (axisColors.xLine) xAxis.lineColor = axisColors.xLine;
    if (miscColors.grid) xAxis.gridLineColor = miscColors.grid;
    // Realtime: thin the dense minute-level category axis down to a handful of
    // adaptive ticks (like v1's datetime axis). tickPositions are the category
    // indices chosen by realtimeTicks. Day-or-larger ranges label every tick as a
    // date; intraday ranges show the date at a midnight tick and HH:00 otherwise.
    if (config?.realtimeMode && realtimeTicks && realtimeTicks.positions.length > 0) {
      const tz = timeConfig?.timezone || undefined;
      const daily = realtimeTicks.daily;
      xAxis.tickPositions = realtimeTicks.positions;
      xAxis.labels = {
        ...xAxis.labels,
        formatter: function (this: any) {
          const t = catTimestamps[this.pos];
          if (!t?.from) return this.value;
          const p = tzParts(t.from, tz);
          return daily || p.hour === 0 ? p.dateLabel : p.hourLabel;
        },
      };
    }
    // Anomaly vertical markers — only in normal mode (shift/comparison series
    // indices don't align with the anomaly-evaluated series indices).
    xAxis.plotLines = chartMode === 'normal' ? (anomalyOverlay?.xPlotLines ?? []) : [];

    const opts: any = { xAxis };
    // Chart title INSIDE the Highcharts canvas — rendered ONLY in full screen.
    // The SDK header title lives outside the reliably-painted area on some
    // fullscreen hosts (so it can go missing), whereas the Highcharts title is
    // part of the chart SVG and is always visible wherever the chart is. In full
    // screen we therefore draw the title here and hide the SDK header title (the
    // `title` slot is set to undefined when isFullscreen) to avoid a duplicate.
    // Left-aligned and styled to match the configured chart-title style.
    // Full-screen canvas title. useHTML lets a long title TRUNCATE with an
    // ellipsis (max-width ~ viewport) and carry a native `title` attribute so
    // hovering shows the full text — same truncate+tooltip behaviour as the
    // non-fullscreen header title (TruncatingChartTitle).
    if (isFullscreen) {
      const fullTitle = activeChart?.title || 'Line Chart';
      const esc = escapeHtml(fullTitle);
      const fs = (titleStyle.fontSize as number) || 18;
      const fw = String(titleStyle.fontWeight ?? 600);
      const col = titleStyle.color ? `color:${titleStyle.color as string};` : '';
      opts.title = {
        useHTML: true,
        align: 'left',
        text: `<span title="${esc}" style="display:inline-block;max-width:90vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom;font-size:${fs}px;font-weight:${fw};${col}">${esc}</span>`,
      };
    } else {
      opts.title = { text: undefined };
    }
    // Highcharts paints `<rect class="highcharts-background">` with an
    // explicit fill — `fill: transparent` via CSS only works if NOTHING
    // else (SDK chrome, theme classes) paints white between us and the
    // card. The robust fix: tell Highcharts directly to use the card's
    // background color (or transparent when wrap-in-card is on and the
    // card has no surface of its own). Same approach mirrors the deployed
    // Column Chart widget.
    opts.chart = {
      // Paint the card's background on the Highcharts canvas so the plot area
      // actually shows it. Match `--lcw-card-bg` semantics EXACTLY: wrap-in-card
      // ON → the configured card color; OFF → transparent (blend with the
      // dashboard). Previously ON was 'transparent', but nothing behind the
      // canvas painted the card color, so the plot area rendered the SDK's
      // default white instead of the user's chosen background.
      backgroundColor:
        style?.card?.wrapInCard === false
          ? 'transparent'
          : style?.card?.backgroundColor || '#FFFFFF',
      // The SDK hardcodes zooming: { type: 'x' } internally; override here
      // explicitly so disabling zoom via the gear menu actually takes effect.
      zooming: { type: chartDisplay.zoom ? 'x' : (null as any) },
      // Horizontal scroll (settings-menu "Scroll" toggle). The SDK's
      // scrollableMinWidth defaults to 800px and only kicks in when the plot
      // would be NARROWER than that — so on any widget wider than 800px the
      // toggle did nothing (dense labels just crammed). Scale the minimum with
      // the category count (50px each) so it exceeds the container once there
      // are enough points to squeeze, which is what actually forces the scroll.
      // Set it here (highchartsOptions is deep-merged LAST) with an explicit
      // minWidth:0 when OFF — Highcharts' chart.update() only MERGES, so the
      // SDK's own `scrollable && {scrollablePlotArea}` never CLEARS a stale
      // minWidth on toggle-off; setting 0 does.
      scrollablePlotArea: {
        minWidth: chartDisplay.scroll ? Math.max(800, categories.length * 50) : 0,
        opacity: 1,
      },
    };
    // Shift mode — connectNulls depends on granularity:
    //  • Sub-daily (minute/hourly): OFF. Each shift carries its own buckets plus
    //    the next shift's opening bucket (boundary bridge in shiftProp), so the
    //    shifts join end-to-end into ONE continuous line. connectNulls:true here
    //    would instead arc a shift ACROSS the other shifts' hours (e.g. Shift 1
    //    jumping 07:00 → next day 00:00).
    //  • Daily and coarser: ON. Each shift is one point per day; connecting
    //    across the other shifts' buckets draws each shift as its own trend line.
    if (chartMode === 'shift') {
      opts.plotOptions = { series: { connectNulls: !shiftSubDaily } };
      if (style?.enableAreaFill) {
        // SDK shift series have no per-series type — they inherit chart.type.
        // smooth=false → chart.type:'line'. Override via highchartsOptions so
        // the SDK-generated shift series render as areaspline (curved + fill).
        // highchartsOptions is deep-merged last and wins over the SDK's own type.
        opts.chart = { ...opts.chart, type: 'areaspline' };
      }
    } else if (config?.realtimeMode && !hasBreakdownGaps) {
      // Realtime is a live, continuous stream — bridge missing/irregular samples
      // so it draws one smooth line (v1 parity) instead of breaking into
      // disconnected segments (which, with area fill, look like vertical bars).
      // BUT only when there are NO breakdown gaps: a genuine device-inactive
      // span (major gap → null fillers) must still sever the line even in
      // realtime, otherwise connectNulls:true would draw straight across the
      // dead period and hide it.
      opts.plotOptions = { series: { connectNulls: true } };
    } else {
      // Normal mode, OR realtime WITH breakdown gaps: explicitly DON'T bridge
      // nulls, so both the breakdown-gap fillers AND any null-valued buckets the
      // backend returns for a device-inactive span sever the line. Kept explicit
      // (not a reliance on the Highcharts default) so a future SDK/default change
      // can't silently connect across dead periods.
      opts.plotOptions = { series: { connectNulls: false } };
    }
    // Disable the initial series-draw animation. On a flex / loader-swapped
    // mount the container can still be settling its size when Highcharts runs
    // the line's grow animation, leaving the path animated to an empty state
    // that only a later redraw (e.g. the user hovering) corrects — the
    // "line only appears after hover" bug. Drawing without animation paints the
    // full line immediately at the correct geometry.
    if (opts.plotOptions?.series) {
      opts.plotOptions.series.animation = false;
      // Never clip series to the plot rect. This is the definitive guard for the
      // "line invisible until hover" bug: when the chart first draws during the
      // loader→chart swap, Highcharts captures the series clip-path at the (then
      // collapsed) plot size. The axes/box later resize correctly, but the series
      // clip-path can stay 0-sized — so the axes render yet the line stays hidden
      // until a hover forces a full redraw. With clip:false the line is never
      // hidden by a stale clip; auto-scaled axes (startOnTick/endOnTick) keep the
      // data within bounds so nothing paints outside the plot area in practice.
      opts.plotOptions.series.clip = false;
      // Data labels on the SHARED series base so they apply to EVERY series type.
      // The SDK only sets dataLabels on plotOptions.line + plotOptions.spline via
      // its `showDataLabels` prop — but with Area Fill on our series are
      // `areaspline`, which does NOT inherit spline's plotOptions, so the labels
      // never showed. Setting them here covers line/spline/areaspline uniformly.
      // (Tooltip-only series re-disable dataLabels per-series, which wins.)
      opts.plotOptions.series.dataLabels = {
        enabled: !!chartDisplay.dataLabel,
        allowOverlap: true,
      };
    }
    // startOnTick/endOnTick ensure Highcharts always pads above and below
    // the data range, preventing a single-tick collapsed axis when all
    // data points share the same value (flat/constant data).
    const yAxisBase: any = { startOnTick: true, endOnTick: true };
    if (multiAxis) {
      opts.yAxis = multiAxis.yAxis.map((a: any) => ({
        ...yAxisBase,
        ...a,
        title: {
          ...(a.title || {}),
          style: { ...((a.title && a.title.style) || {}), ...titleEllipsis, ...(axisColors.yTitle ? { color: axisColors.yTitle } : {}) },
        },
        ...(axisColors.yLabel ? { labels: { ...(a.labels || {}), style: { ...((a.labels && a.labels.style) || {}), color: axisColors.yLabel } } } : {}),
        ...(miscColors.grid ? { gridLineColor: miscColors.grid } : {}),
      }));
    } else {
      const yAxis: any = { ...yAxisBase, title: { style: { ...titleEllipsis, ...(axisColors.yTitle ? { color: axisColors.yTitle } : {}) } } };
      if (axisColors.yLabel) yAxis.labels = { style: { color: axisColors.yLabel } };
      if (miscColors.grid) yAxis.gridLineColor = miscColors.grid;
      const yMin = activeChart?.defaultAxis?.yAxisMin;
      const yMax = activeChart?.defaultAxis?.yAxisMax;
      if (yMin !== null && yMin !== undefined) yAxis.min = yMin;
      if (yMax !== null && yMax !== undefined) yAxis.max = yMax;
      // Declare plot lines/bands directly in the Highcharts options so they
      // survive every chart.update() call. The imperative addPlotLine approach
      // was clearing these on every highchartsOptions change (anomaly overlay,
      // periodicity, data arrival) because the imperative effect deps didn't
      // cover all the triggers that cause chart.update() to rebuild yAxis.
      if (plotLines.length) {
        yAxis.plotLines = plotLines.map((p: any) => ({
          value: p.value, color: p.color, width: p.width ?? 2, dashStyle: p.dashStyle ?? 'Dash', zIndex: 5,
          ...(p.label ? { label: buildPlotLineLabel(p.label, p.color) } : {}),
        }));
      }
      if (plotBands.length) {
        yAxis.plotBands = plotBands.map((b: any) => ({
          from: b.from, to: b.to, color: b.color,
          ...(b.label ? { label: { text: b.label } } : {}),
        }));
      }
      opts.yAxis = yAxis;
    }
    // "Add Source as Tooltip": no visible line / marker / data label and no
    // legend chip, but keep the series in the dataset (mouse-tracked) so the
    // shared tooltip reports its value when hovering other points.
    opts.series = effectiveSeries.map((s: any, i) => {
      const origIdx = i;
      const so: any = {};
      if (multiAxis) so.yAxis = multiAxis.seriesAxis[origIdx] ?? 0;
      // Anomaly per-point marker overrides — normal mode only.
      if (chartMode === 'normal' && anomalyOverlay?.seriesData?.[i]) {
        so.data = anomalyOverlay.seriesData[i];
      }
      if (effectiveTooltipOnlyFlags[i]) {
        so.lineWidth = 0;
        so.marker = { enabled: false, states: { hover: { enabled: false } } };
        so.dataLabels = { enabled: false };
        so.showInLegend = false;
        so.states = { hover: { lineWidth: 0, halo: { size: 0 } }, inactive: { opacity: 1 } };
      }
      // Per-series tooltip precision — passed here so the SDK's P.merge() includes
      // it in each Highcharts series option. The SDK ignores unknown fields on the
      // `series` prop; highchartsOptions.series is the correct path.
      if (s.tooltip) so.tooltip = s.tooltip;
      if (!effectiveTooltipOnlyFlags[i]) {
        if (style?.enableAreaFill) {
          so.type = 'areaspline';
          // Fill down to the axis MINIMUM, not the default threshold of 0.
          // Without this, an area series pins the y-axis to include 0, so a
          // series around ~115 renders a huge 0–125 axis with the data squashed
          // into a thin band (and, when the line breaks, tall bars from 0).
          so.threshold = null;
          const color = s.color || '#7cb5ec';
          so.fillColor = {
            linearGradient: { x1: 0, y1: 0, x2: 0, y2: 1 },
            stops: [
              [0, hexToRgba(color, 0.5)],
              [1, hexToRgba(color, 0)],
            ],
          };
        }
        if (style?.showDataPoints) {
          so.marker = { ...(so.marker ?? {}), enabled: true, symbol: 'square', radius: 4 };
        }
      }
      return so;
    });
    // In shift mode the SDK generates its own Highcharts series internally from
    // the `shift` prop. highchartsOptions.series[i] IS deep-merged onto those
    // generated series (index-aligned with shiftProp.series, length = #sources ×
    // #shifts), so we override opts.series ENTIRELY here — the source-indexed
    // effectiveSeries opts above (length = #sources) don't align with the
    // expanded shift series, so their per-series yAxis binding never reaches
    // them. Rebuild aligned to shiftProp.series and:
    //   • bind each shift series to its SOURCE's axis (multiAxis.seriesAxis keyed
    //     by sourceIndex) — WITHOUT this every shift series falls to yAxis 0, so
    //     a right-axis source (e.g. AM) plotted against the LEFT axis scale.
    //   • add the area-fill gradient when Area Fill is on.
    // Shift tooltip/legend are SDK-owned in this mode.
    if (chartMode === 'shift' && shiftProp) {
      opts.series = (shiftProp.series as any[]).map((ss: any) => {
        const so: any = {};
        if (multiAxis) so.yAxis = multiAxis.seriesAxis[ss.sourceIndex] ?? 0;
        if (style?.enableAreaFill) {
          // Fill down to the axis MINIMUM, not the default threshold of 0 — else
          // each shift area fills from 0 up to its value, rendering as tall solid
          // bars from the axis bottom instead of a gradient under the line.
          so.threshold = null;
          so.fillColor = {
            linearGradient: { x1: 0, y1: 0, x2: 0, y2: 1 },
            stops: [
              [0, hexToRgba(ss.shiftColor || '#7cb5ec', 0.5)],
              [1, hexToRgba(ss.shiftColor || '#7cb5ec', 0)],
            ],
          };
        }
        return so;
      });
    }
    // Override the SDK's defaultTooltip so per-series dataPrecision (valueDecimals)
    // is actually applied. The SDK renders c.y as a raw number via a custom HTML
    // formatter that ignores Highcharts' valueDecimals. We replicate its exact
    // HTML/SVG structure but call c.y.toFixed(precision) per series.
    //
    // In shift/comparison modes the SDK provides its own shift/comparison tooltip
    // formatters (deviation %, "vs …" footer, etc.). Passing opts.tooltip here
    // would P.merge-override those formatters — so we skip it in those modes and
    // let the SDK handle everything.
    if (chartMode === 'normal') {
      const TOOLTIP_FONT = "'Noto Sans Variable', 'Noto Sans', sans-serif";
      // Read CSS tokens once per memo recompute — not on every tooltip hover.
      // getComputedStyle forces a style recalc; calling it inside the formatter
      // would run it on every mouse-move over a data point (layout thrashing).
      const root = typeof document !== 'undefined' ? document.documentElement : null;
      const cs = root ? getComputedStyle(root) : null;
      const primary = cs?.getPropertyValue('--text-gray-primary').trim() || '#192839';
      const secondary = cs?.getPropertyValue('--text-gray-secondary').trim() || '#40566d';
      opts.tooltip = {
        shared: true,
        useHTML: true,
        formatter(this: any) {
          const points: any[] = (this as any).points ?? [this];
          const rows = points.map((c: any) => {
            const rawColor = c.color ?? c.series?.color ?? primary;
            const color = typeof rawColor === 'string' ? rawColor : primary;
            const name: string = c.series?.name ?? '';
            const precision = Math.max(0, Math.min(20, c.series?.options?.tooltip?.valueDecimals ?? 2));
            const yVal = typeof c.y === 'number' ? c.y.toFixed(precision) : '—';
            // Unit appended after the value (v1 parity). Only when we have a real
            // value and a meaningful unit.
            const unit: string = c.series?.options?.tooltip?.unit ?? '';
            const valueWithUnit = typeof c.y === 'number' && unit ? `${yVal} ${unit}` : yVal;
            const dashStyle: string = c.series?.options?.dashStyle ?? 'Solid';
            let lineRect = `<rect x="0" y="5" width="16" height="2" rx="1" fill="${color}"/>`;
            if (dashStyle !== 'Solid') {
              lineRect = [0, 7, 13].map((x) => `<rect x="${x}" y="5" width="4" height="2" fill="${color}"/>`).join('');
            }
            const svg = `<svg width="16" height="12" viewBox="0 0 16 12" style="flex:0 0 auto;vertical-align:-2px">${lineRect}<circle cx="8" cy="6" r="3" fill="${color}"/></svg>`;
            // Row typography mirrors v1: name in regular weight, value+unit bold, 14px.
            return `<div style="display:flex;align-items:center;gap:6px;padding:1px 0;white-space:nowrap;font-family:${TOOLTIP_FONT}"><span style="display:inline-flex">${svg}</span><span style="font:400 14px/1.3 ${TOOLTIP_FONT};color:${primary}">${name} : </span><span style="font:600 14px/1.3 ${TOOLTIP_FONT};color:${primary}">${valueWithUnit}</span></div>`;
          });
          // Footer shows the hovered bucket's START – END range (v1 parity),
          // read from catTimestamps by the point's category index. The interval
          // END is the NEXT bucket's start (v1 uses current→next), which is what
          // gives a real span even for zero-duration realtime points where
          // from === to; falls back to this bucket's own `to`, then to a single
          // stamp / the category label. Format: "DD MMM YYYY HH:mm" (no comma).
          const idx = (points[0] as any)?.point?.index;
          const bucket = typeof idx === 'number' ? catTimestamps[idx] : undefined;
          const tzFooter = timeConfig?.timezone || undefined;
          const fmtTs = (ms: number) => {
            const parts = new Intl.DateTimeFormat('en-GB', {
              timeZone: tzFooter,
              day: '2-digit', month: 'short', year: 'numeric',
              hour: '2-digit', minute: '2-digit', hour12: false,
            }).formatToParts(new Date(ms));
            const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
            return `${g('day')} ${g('month')} ${g('year')} ${g('hour')}:${g('minute')}`;
          };
          const start = bucket?.from;
          const rawNext = typeof idx === 'number' ? catTimestamps[idx + 1]?.from : undefined;
          const nextFrom =
            typeof rawNext === 'number' && !Number.isNaN(rawNext) ? rawNext : undefined;
          const end =
            nextFrom ?? (bucket?.to && bucket.to !== bucket.from ? bucket.to : undefined);
          const footer = start
            ? end && end !== start
              ? `${fmtTs(start)} - ${fmtTs(end)}`
              : fmtTs(start)
            : ((points[0] as any)?.point?.category ?? (this as any).x ?? '');
          return rows.join('') + `<div style="margin-top:4px;font:400 12px/1.2 ${TOOLTIP_FONT};color:${secondary};white-space:nowrap">${footer}</div>`;
        },
      };
    }
    // Shift mode: the SDK's own shift tooltip formats each value with
    // formatChartValue() (plain toLocaleString) and has NO way to append the
    // measurement unit — it never reads our per-series `tooltip.unit`. So we
    // override it with a formatter that mirrors the SDK's shift rows
    // (source glyph + "Source (Shift)" + value) AND appends the unit, exactly
    // like normal mode. Our `highchartsOptions.tooltip` deep-merges over the
    // SDK's, so our formatter wins while the native box chrome is preserved.
    // The unit is per-SOURCE (same `meta.unit` source as normal mode) — shift
    // series carry their `sourceIndex` in `userOptions.custom`, so we look the
    // unit up on the matching effectiveSeries entry.
    if (chartMode === 'shift') {
      const TOOLTIP_FONT = "'Noto Sans Variable', 'Noto Sans', sans-serif";
      const root = typeof document !== 'undefined' ? document.documentElement : null;
      const cs = root ? getComputedStyle(root) : null;
      const primary = cs?.getPropertyValue('--text-gray-primary').trim() || '#192839';
      const secondary = cs?.getPropertyValue('--text-gray-secondary').trim() || '#40566d';
      opts.tooltip = {
        shared: true,
        useHTML: true,
        formatter(this: any) {
          const points: any[] = (this as any).points ?? [this];
          const rows = points.map((c: any) => {
            // Shift metadata the SDK stashed on the series (sourceIndex,
            // sourceName, shiftName, shiftColor).
            const custom = c.series?.userOptions?.custom ?? c.series?.options?.custom ?? {};
            const srcIdx: number = typeof custom.sourceIndex === 'number' ? custom.sourceIndex : 0;
            const srcSeries: any = effectiveSeries[srcIdx];
            const precision = Math.max(0, Math.min(20, srcSeries?.tooltip?.valueDecimals ?? 2));
            const unit: string = srcSeries?.tooltip?.unit ?? '';
            const yVal = typeof c.y === 'number' ? c.y.toFixed(precision) : '—';
            const valueWithUnit = typeof c.y === 'number' && unit ? `${yVal} ${unit}` : yVal;
            const rawColor = custom.shiftColor ?? c.color ?? c.series?.color ?? primary;
            const color = typeof rawColor === 'string' ? rawColor : primary;
            const sourceName: string = custom.sourceName ?? c.series?.name ?? '';
            const name = sourceName + (custom.shiftName ? ` (${custom.shiftName})` : '');
            const svg = `<svg width="16" height="12" viewBox="0 0 16 12" style="flex:0 0 auto;vertical-align:-2px"><rect x="0" y="5" width="16" height="2" rx="1" fill="${color}"/><circle cx="8" cy="6" r="3" fill="${color}"/></svg>`;
            return `<div style="display:flex;align-items:center;gap:6px;padding:1px 0;white-space:nowrap;font-family:${TOOLTIP_FONT}"><span style="display:inline-flex">${svg}</span><span style="font:400 14px/1.3 ${TOOLTIP_FONT};color:${primary}">${name} : </span><span style="font:600 14px/1.3 ${TOOLTIP_FONT};color:${primary}">${valueWithUnit}</span></div>`;
          });
          // Footer — hovered bucket START – END range, identical to normal mode.
          const idx = (points[0] as any)?.point?.index;
          const bucket = typeof idx === 'number' ? catTimestamps[idx] : undefined;
          const tzFooter = timeConfig?.timezone || undefined;
          const fmtTs = (ms: number) => {
            const parts = new Intl.DateTimeFormat('en-GB', {
              timeZone: tzFooter,
              day: '2-digit', month: 'short', year: 'numeric',
              hour: '2-digit', minute: '2-digit', hour12: false,
            }).formatToParts(new Date(ms));
            const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
            return `${g('day')} ${g('month')} ${g('year')} ${g('hour')}:${g('minute')}`;
          };
          const start = bucket?.from;
          const rawNext = typeof idx === 'number' ? catTimestamps[idx + 1]?.from : undefined;
          const nextFrom = typeof rawNext === 'number' && !Number.isNaN(rawNext) ? rawNext : undefined;
          const end = nextFrom ?? (bucket?.to && bucket.to !== bucket.from ? bucket.to : undefined);
          const footer = start
            ? end && end !== start ? `${fmtTs(start)} - ${fmtTs(end)}` : fmtTs(start)
            : ((points[0] as any)?.point?.category ?? (this as any).x ?? '');
          return rows.join('') + `<div style="margin-top:4px;font:400 12px/1.2 ${TOOLTIP_FONT};color:${secondary};white-space:nowrap">${footer}</div>`;
        },
      };
    }
    // Tooltip render target. Highcharts renders the useHTML tooltip into <body>
    // when `outside` is true — and it DEFAULTS to true whenever a
    // scrollablePlotArea is set (which we always set for the Scroll feature). A
    // body-rendered tooltip sits BEHIND the fullscreen top-layer element, so it
    // is invisible in full screen. Force it INSIDE the chart while full screen
    // (so it paints within the fullscreened .fds-chart); keep it outside
    // otherwise so a small dashboard tile's overflow:hidden never clips it.
    // The SDK's own tooltip merge (`{ ...ours, ...sdkFormatter }`) never sets
    // `outside`, so setting it here on `opts.tooltip` wins for every mode —
    // including shift/comparison where we otherwise leave the tooltip to the SDK.
    opts.tooltip = { ...(opts.tooltip ?? {}), outside: !isFullscreen };
    return opts as any;
  }, [axisColors, miscColors, multiAxis, effectiveSeries, effectiveTooltipOnlyFlags, style?.card?.wrapInCard, style?.card?.backgroundColor, style?.enableAreaFill, style?.showDataPoints, chartDisplay.zoom, chartDisplay.dataLabel, chartDisplay.scroll, categories.length, anomalyOverlay, chartMode, plotLines, plotBands, activeChart, shiftSubDaily, shiftProp, config?.realtimeMode, hasBreakdownGaps, realtimeTicks, catTimestamps, timeConfig?.timezone, isFullscreen, titleStyle]);

  // The data table is portalled into the chart card (sibling of the canvas).
  const [cardEl, setCardEl] = useState<HTMLDivElement | null>(null);

  // No-data empty state: measure the canvas width and constrain the empty-state
  // block to computeNoDataWidth(width), kept vertically centered. Callback ref +
  // ResizeObserver so it tracks widget resizes and mounts/unmounts cleanly.
  const [noDataWidth, setNoDataWidth] = useState<number>();
  const noDataRoRef = useRef<ResizeObserver | null>(null);
  const emptyCanvasRefCb = useCallback((node: HTMLDivElement | null) => {
    noDataRoRef.current?.disconnect();
    if (!node) {
      noDataRoRef.current = null;
      return;
    }
    const measure = () => setNoDataWidth(computeNoDataWidth(node.clientWidth));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    noDataRoRef.current = ro;
  }, []);

  // Local DatePicker state — initialized from the host-passed timeConfig.
  // On user pick, we emit TIME_CHANGE through onEvent so the host's data
  // layer re-queries with the new range.
  const initialRange = useMemo<DateRange | null>(() => {
    const { startTime, endTime } = computeRange(timeConfig);
    return { start: new Date(startTime), end: new Date(endTime) };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    timeConfig?.defaultDurationId,
    timeConfig?.type,
    timeConfig?.pickerType,
    timeConfig?.startTime,
    timeConfig?.endTime,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    JSON.stringify(timeConfig?.fixedDuration ?? null),
    JSON.stringify(timeConfig?.cycleTime ?? null),
  ]);
  const [rangeValue, setRangeValue] = useState<DateRange | null>(initialRange);
  // Keep `rangeValue` in sync if the host pushes a new preset down.
  useEffect(() => {
    setRangeValue(initialRange);
  }, [initialRange]);
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const [selectedPreset, setSelectedPreset] = useState<string>(
    timeConfig?.defaultDurationId ?? '',
  );
  // Sync selectedPreset when the configurator changes the default duration.
  // The existing preset effect then fires, updates rangeValue, and emits TIME_CHANGE.
  const defaultDurationId = timeConfig?.defaultDurationId;
  useEffect(() => {
    if (!defaultDurationId) return;
    setSelectedPreset(defaultDurationId);
  }, [defaultDurationId]);

  const [periodicityOpen, setPeriodicityOpen] = useState(false);
  // Once the user manually picks a periodicity (dropdown or drilldown) we stop
  // auto-defaulting to the coarsest option so their choice sticks.
  const periodicityTouchedRef = useRef(false);
  // Host pushed a new configured periodicity (initial load or config reset):
  // clear the manual-pick flag and re-derive the highest-order default.
  const defaultPeriodicity = timeConfig?.defaultPeriodicity;
  useEffect(() => {
    if (!defaultPeriodicity) return;
    periodicityTouchedRef.current = false;
    const next = computeDefaultPeriodicity(timeConfig);
    setSelectedPeriodicity((prev) => (prev === next ? prev : next));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultPeriodicity]);

  const activePreset = timeConfig?.allDurations?.find((d) => d.id === selectedPreset);

  // When a preset is selected from the sidebar, the SDK's DatePicker only fires
  // onPresetSelect (not onRangeChange) until the user clicks "Apply". Derive the
  // range immediately, snap periodicity, and emit TIME_CHANGE right away so the
  // host fetches data without requiring the user to press Apply.
  // Skip the first run — the mount effect already emits the initial TIME_CHANGE.
  const allDurations = timeConfig?.allDurations;
  const presetInitialized = useRef(false);
  // Tracks the last preset so we can detect a genuine duration change (vs an
  // allDurations/cycleTime refresh) and reset periodicity to the new duration's
  // coarsest option on that change.
  const prevPresetRef = useRef<string | null>(null);
  // Blocks onRangeChange from re-emitting TIME_CHANGE when the SDK DatePicker
  // fires it as a side-effect of a preset chip selection (preset effect already
  // handles the emit). Mirrors the reference widget's presetSelectingRef pattern.
  const presetSelectingRef = useRef(false);
  // The SDK DatePicker fires onRangeChange once on MOUNT with the initial
  // (unchanged) range. The host already ran the first resolveAndCompute from the
  // saved envelope, so re-emitting here duplicates that call. Skip that first
  // mount echo — but ONLY when the range is unchanged, so a genuine first user
  // pick (a different range) still emits. Emit-on-interaction only.
  const rangeInitRef = useRef(false);
  useEffect(() => {
    if (!selectedPreset || !allDurations) return;
    const preset = allDurations.find((d) => d.id === selectedPreset);
    let derived: DateRange | null = null;
    if (preset) {
      const { startTime, endTime } = resolveDurationWindow(
        preset,
        Date.now(),
        timeConfig?.cycleTime ?? undefined,
      );
      derived = { start: new Date(startTime), end: new Date(endTime) };
      setRangeValue(derived);
    }

    // Detect a genuine duration change (preset id differs from last run) — used
    // to force the new duration's coarsest periodicity below.
    const presetChanged = prevPresetRef.current !== null && prevPresetRef.current !== selectedPreset;
    prevPresetRef.current = selectedPreset;

    if (!presetInitialized.current) {
      presetInitialized.current = true;
      return; // initial mount — mount effect handles the first TIME_CHANGE
    }

    const eventRange = derived ?? rangeValue;
    if (!eventRange) return;

    // Use preset-definition periodicities (calendarType hardcodes / explicit
    // list / minute-band), NOT bucket-count heuristic. Bucket count allows
    // Hourly for a partial-month range — the preset definition is the authority.
    const nextOptions = getPresetPeriodicities(preset) ?? getValidPeriodicities(eventRange);
    // On a genuine duration change, ALWAYS reset to the highest (coarsest)
    // periodicity mapped to the new duration — e.g. Today (Hourly) → Current
    // Year sends Monthly/Quarterly, not the stale Hourly. `nextOptions` is
    // descending (coarsest first), so [0] is the highest-order option. A prior
    // manual pick is cleared. When the preset didn't change (an allDurations /
    // cycleTime refresh), preserve the user's current choice as before.
    const nextPeriodicity =
      presetChanged && nextOptions.length
        ? nextOptions[0]
        : pickPeriodicity(nextOptions, selectedPeriodicity, periodicityTouchedRef.current);
    if (presetChanged) periodicityTouchedRef.current = false;
    if (nextPeriodicity !== selectedPeriodicity) setSelectedPeriodicity(nextPeriodicity);

    // Emit ONLY on a genuine duration change (the user picked a preset, or the
    // configurator changed the default duration). When this effect re-runs
    // merely because the host handed us a new `allDurations`/`cycleTime` object
    // reference (a config re-push on init or refresh) with the SAME preset, do
    // NOT emit — that was firing a spurious TIME_CHANGE on initialization. The
    // window state (rangeValue/periodicity) is still kept in sync above.
    if (!presetChanged) return;

    const evStart = new Date(eventRange.start).getTime();
    const evEnd = new Date(eventRange.end).getTime();
    const presetPayload = {
      startTime: String(evStart),
      endTime: String(evEnd),
      periodicity: nextPeriodicity.toLowerCase(),
      ...modeEventFields(evStart, evEnd),
      ...controlFlags(),
    };
    beginPendingFetch(); // show the loader until the host answers the new window
    onEventRef.current?.({ type: 'TIME_CHANGE', payload: presetPayload });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPreset, allDurations, JSON.stringify(timeConfig?.cycleTime ?? null)]);

  // Clipping / Inexact Multiple toggles (settings menu) re-emit TIME_CHANGE for
  // the CURRENT on-screen window so the host refetches with the new flags. No
  // window move — mirrors ColumnChart's control-toggle emit. Skips the initial
  // mount (the mount effect already sent the first TIME_CHANGE).
  const controlsInitRef = useRef(false);
  useEffect(() => {
    if (!controlsInitRef.current) { controlsInitRef.current = true; return; }
    const ev = onEventRef.current;
    if (!ev || !rangeValue) return;
    const startTime = new Date(rangeValue.start).getTime();
    const endTime = new Date(rangeValue.end).getTime();
    const payload = {
      startTime: String(startTime),
      endTime: String(endTime),
      periodicity: selectedPeriodicity.toLowerCase(),
      ...modeEventFields(startTime, endTime),
      ...controlFlags(),
    };
    ev({ type: 'TIME_CHANGE', payload });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartDisplay.clipping, chartDisplay.inexactMultiple]);

  // Realtime mount emit (parity with ColumnChart's picker, which emits a
  // TIME_CHANGE with a concrete window on mount).
  //
  // The mount TIME_CHANGE was removed for the normal path because the host fires
  // the first resolveAndCompute itself by resolving the envelope's duration. In
  // REALTIME that host-side resolution throws ("Cannot read properties of
  // undefined (reading 'hour')") and retries in a loop until the user manually
  // picks a duration (which emits a TIME_CHANGE with explicit start/end). We
  // reproduce that fix automatically: on mount, if realtime is on, emit a
  // TIME_CHANGE carrying the concrete window so the host uses explicit times and
  // never runs the failing duration resolution. Gated to realtime so the normal
  // path keeps its single host-driven query (no redundant duplicate).
  const realtimeMountEmitRef = useRef(false);
  useEffect(() => {
    if (realtimeMountEmitRef.current) return;
    if (!config?.realtimeMode) return;
    const ev = onEventRef.current;
    if (!ev || !initialRange) return;
    realtimeMountEmitRef.current = true;
    const startMs = new Date(initialRange.start).getTime();
    const endMs = new Date(initialRange.end).getTime();
    const payload = {
      startTime: String(startMs),
      endTime: String(endMs),
      periodicity: selectedPeriodicity.toLowerCase(),
      ...modeEventFields(startMs, endMs),
      ...controlFlags(),
    };
    ev({ type: 'TIME_CHANGE', payload });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.realtimeMode, initialRange]);

  const periodicityOptions = useMemo(() => {
    return getPresetPeriodicities(activePreset) ?? getValidPeriodicities(rangeValue);
  }, [activePreset, rangeValue]);

  // Keep the selection in step with the available options. The dropdown lists
  // options highest-order first (index 0 = coarsest), and for the LOCAL picker
  // index 0 is the default — selected on load AND on EVERY duration/range change,
  // even when the previous pick is still valid in the new set (e.g. Current Month
  // [Daily] → Previous 3 Months [Monthly, Weekly, Daily] snaps to Monthly, not
  // Daily). A manual pick only holds while the SAME option set stays on screen.
  // External time (fixed/global/GTP) stays config-driven, so it's not forced.
  const prevOptionsKeyRef = useRef<string>('');
  useEffect(() => {
    if (!periodicityOptions.length) return;
    const key = periodicityOptions.join('|');
    const optionsChanged = key !== prevOptionsKeyRef.current;
    prevOptionsKeyRef.current = key;
    if (!isExternalTime && optionsChanged) {
      periodicityTouchedRef.current = false;
      if (selectedPeriodicity !== periodicityOptions[0]) setSelectedPeriodicity(periodicityOptions[0]);
    } else if (!periodicityOptions.includes(selectedPeriodicity)) {
      setSelectedPeriodicity(periodicityOptions[0]);
    }
  }, [periodicityOptions, selectedPeriodicity, isExternalTime]);

  // Highcharts instance handle for the export menu and fullscreen toggle.
  const chartInstanceRef = useRef<
    { reflow: () => void; redraw?: () => void; fdsToggleFullscreen?: () => void } | null
  >(null);


  // Force the Highcharts line to (re)paint. reflow()/redraw() alone refresh the
  // box + axes but do NOT recompute the series graph path — so a line drawn to a
  // stale/empty geometry during the loader→chart swap stays invisible until a
  // hover forces the SDK to update. Marking every series isDirty + isDirtyData
  // makes redraw() rebuild the actual <path> (what hover effectively triggers).
  const repaintChart = useCallback(() => {
    const c = chartInstanceRef.current as unknown as {
      reflow?: () => void;
      redraw?: (a?: boolean) => void;
      isDirtyBox?: boolean;
      series?: Array<{ isDirty: boolean; isDirtyData: boolean }>;
    } | null;
    if (!c) return;
    try {
      c.reflow?.();
      (c.series ?? []).forEach((s) => { s.isDirty = true; s.isDirtyData = true; });
      c.isDirtyBox = true;
      c.redraw?.(false);
    } catch { /* chart destroyed */ }
  }, []);

  // Root element ref (declared above for the fullscreen detector) also drives
  // the ResizeObserver below — triggers chart.reflow() when the dashboard
  // resizes or repositions this widget so Highcharts recalculates tick
  // positions and label layout rather than stretching the mount-time SVG.
  const resizeRafRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    const el = lcwRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const chart = chartInstanceRef.current;
      if (!chart) return;
      // Batch reflow to one per animation frame — prevents layout thrashing when
      // the dashboard fires many resize events in a single frame.
      if (resizeRafRef.current !== undefined) cancelAnimationFrame(resizeRafRef.current);
      resizeRafRef.current = requestAnimationFrame(() => {
        resizeRafRef.current = undefined;
        repaintChart();
      });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (resizeRafRef.current !== undefined) cancelAnimationFrame(resizeRafRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Loader→chart swap paint. When the spinner is replaced by the chart (data
  // arrived), the series can be drawn to a clip-rect captured while the spinner
  // still owned the box — the "line only appears after hover" bug. onChartReady
  // covers the mount, but its timing is racy relative to the swap, so force an
  // explicit reflow+redraw here too once the chart exists and data is present.
  useEffect(() => {
    if (isLoadingData || !hasPlottableData) return;
    const raf = requestAnimationFrame(repaintChart);
    const t = setTimeout(repaintChart, 120);
    return () => { cancelAnimationFrame(raf); clearTimeout(t); };
  }, [isLoadingData, hasPlottableData]);

  // Date presets surfaced in the DatePicker's preset rail. Derived from the
  // host-passed allDurations so what's offered here matches what was
  // configured in the configurator's Time tab.
  const datePresets = useMemo<DatePresetOption[]>(
    () => [
      // "Custom" is always first — lets the user pick a free-form date range.
      { value: 'custom', label: 'Custom' },
      // Skip durations the user hid: the SDK keeps them in `allDurations` with
      // hidden:true instead of removing them, so without this filter a hidden
      // custom duration reappears in the picker (Bug 2).
      ...(timeConfig?.allDurations ?? [])
        .filter((d) => !d.hidden)
        .map((d) => ({
          value: d.id,
          label: (d as { label?: string }).label || d.id,
        })),
    ],
    [timeConfig?.allDurations],
  );

  // Data table is per-chart — show only the active chart's table (if any).
  const dataTable = activeChart?.dataTable;
  const showDataTable = !!dataTable && dataTable.columns.length > 0;

  const configuredSeriesCount = activeChart?.series?.length ?? 0;

  // Publish the user-picked card background color as a CSS variable so the
  // SDK chart's legend strip (which sits inside .fds-chart but doesn't
  // inherit a background) can paint the SAME color via a static CSS rule.
  // `--lcw-card-bg` defaults to transparent when wrap-into-card is ON.
  // Must live here (before any early return) to satisfy the Rules of Hooks.
  const widgetStyle = useMemo<React.CSSProperties>(() => {
    const bg =
      style?.card?.wrapInCard === false
        ? 'transparent'
        : style?.card?.backgroundColor || '#FFFFFF';
    // Chrome we repaint but the user can't recolor (DatePicker trigger,
    // periodicity dropdown) needs a foreground that survives a dark card.
    // Only published when a flip is actually needed — the CSS falls back to
    // the SDK's own text token when the variable is absent.
    const fg = readableForeground(bg);
    return {
      '--lcw-card-bg': bg,
      ...(fg ? { '--lcw-card-fg': fg } : {}),
    } as React.CSSProperties;
  }, [style?.card?.wrapInCard, style?.card?.backgroundColor]);

  // ----- Render states ------------------------------------------------------
  // No charts added yet — show a clean, header-less empty state.
  if (!activeChart) {
    return (
      <div className="lcw lcw--empty">
        <EmptyState
          illustration={<NoDataOneIllustration />}
          title="No chart configured"
          description="Add a chart from the configurator's Chart Settings section to get started."
        />
      </div>
    );
  }

  // Chart exists but no data source configured yet — show header chrome with
  // DatePicker normally, but replace the canvas with "No data found" via status.
  const hasAnySeries = activeChart.series.length > 0;

  // Fixed-time mode: the window is set externally — hide the DatePicker and
  // show a duration label in the header instead (mirrors the Column Chart pattern).
  // GTP (Global Timepicker) mode: time is controlled by an external timepicker
  // widget — the internal DatePicker is redundant and should not be shown.
  // Hide the internal DatePicker when time is controlled externally:
  //   'fixed'  — window set in configurator, no runtime picker needed
  //   'global' — a Global Timepicker widget drives this widget (pickerType signal)
  // Lens also sets `globalTimepickerId` at runtime when a GTP is connected
  // (it may not preserve `pickerType` across updates), so we check both.
  const hideDatePicker =
    !hasAnySeries ||
    timeConfig?.pickerType === 'fixed' ||
    timeConfig?.pickerType === 'global' ||
    timeConfig?.type === 'global' ||
    !!timeConfig?.globalTimepickerId;
  const durationSlot =
    timeConfig?.pickerType === 'fixed'
      ? `${timeConfig?.fixedDuration?.label || 'Fixed'}: ${selectedPeriodicity}`
      : isGTPMode
        // Mirrors the fixed-time "Fixed: …" caption — tells the user the widget's
        // time is driven by the Global Time Picker (its own date picker is hidden).
        ? 'Linked to Global Time Picker'
        : undefined;

  const allHeaderItemsHidden =
    // Multiple charts always show the title (switcher), so the title can't be
    // hidden then — the header chrome is never fully empty.
    charts.length <= 1 &&
    style?.hideElements?.chartTitle === true &&
    style?.hideElements?.settingsIcon === true &&
    style?.hideElements?.exportIcon === true;

  return (
    <div
      className={[
        'lcw',
        hideDatePicker ? 'lcw--gtp' : '',
        showDataTable ? 'lcw--with-table' : '',
        allHeaderItemsHidden ? 'lcw--no-header-chrome' : '',
        // Wrap-into-card OFF → strip the SDK Chart's hardcoded card surface. A
        // class with !important is authoritative regardless of SDK CSS
        // specificity or inline-style ordering (the inline cardStyle alone
        // wasn't reliably winning).
        style?.card?.wrapInCard === false ? 'lcw--no-card' : '',
        // Scroll ON — the widget's `.highcharts-container { width:100% }` reflow
        // override must NOT apply, or it clamps the wide scrollable plot back to
        // the viewport width and there's nothing to scroll (see LineChart.css).
        chartDisplay.scroll ? 'lcw--scroll' : '',
      ].filter(Boolean).join(' ')}
      style={widgetStyle}
      ref={lcwRef}
    >
      {/* Refetch overlay — a time / periodicity change, compare/shift toggle, or
          a GTP-driven requery re-resolves data while the previous chart stays on
          screen. Overlay a spinner so the header + controls remain visible,
          instead of blanking the widget. Mirrors CombinedBarLineChart. */}
      {isRefetching && (
        <div className="lcw__loading-overlay" aria-busy="true">
          <Spinner size="Large" label="Loading data" labelPosition="Bottom" />
        </div>
      )}
      {miscColors.legend && (
        // The SDK renders two legend variants with DIFFERENT label classes:
        //   • regular   → .fds-chart-legend__label        (double underscore)
        //   • scrollable → .fds-chart__scrollable-legend-label
        // The old `[class*="legend-label"]` matched only the scrollable one
        // (its class contains "legend-label"); the regular legend's
        // "legend__label" never matched, so the color silently no-op'd for the
        // common (few-series) case. Target both explicitly.
        <style>{`.lcw .fds-chart-legend__label, .lcw .fds-chart__scrollable-legend-label { color: ${miscColors.legend} !important; }`}</style>
      )}
      {/* Suppress legend chips for "Add Source as Tooltip" series (SDK builds
          its HTML legend from the series prop). When shifts are on, names
          include the "(Shift Name)" suffix to match Highcharts' legend labels. */}
      {effectiveTooltipOnlyNames.length > 0 && (
        <style>
          {effectiveTooltipOnlyNames
            .map(
              (n) =>
                `.lcw .fds-chart__scrollable-legend-item[aria-label="Toggle ${n.replace(
                  /["\\]/g,
                  '\\$&',
                )} series"] { display: none !important; }`,
            )
            .join('\n')}
        </style>
      )}
      <Chart
        ref={setCardEl}
        style={cardStyle}
        status={hasAnySeries ? undefined : 'not-configured'}
        duration={isFullscreen ? undefined : durationSlot}
        title={
          // With multiple charts the title IS the chart switcher — always show
          // it (the "Hide → Chart Title" option is disabled in that case), so a
          // stale hidden flag can't strip the only way to switch charts.
          // In full screen the title is drawn inside the Highcharts canvas
          // (opts.title) so it's always visible; suppress the SDK header title
          // here to avoid rendering it twice.
          isFullscreen ? undefined :
          charts.length > 1 ? (
            <ChartTitleSwitcher
              charts={charts}
              activeChart={activeChart}
              onSelect={setPreviewChartId}
              titleStyle={titleStyle}
            />
          ) : style?.hideElements?.chartTitle ? undefined : (
            // A React node (not a string) as the Chart `title` slot is rendered
            // RAW by the SDK — it only wraps/tooltips a STRING title in
            // `.fds-chart__title` (`C = typeof title === 'string'`). So we render
            // our own truncating title: the Tooltip wrapper becomes the direct
            // child of `.fds-chart__header-row` (carrying the header-overflow
            // flex fix) and the inner span truncates + surfaces the full title
            // on hover only when clipped.
            <TruncatingChartTitle text={activeChart.title || 'Line Chart'} style={titleStyle} />
          )
        }
        // DatePicker in the filters slot — hidden for fixed-time mode and when
        // no data source is configured yet (nothing to time-filter).
        filters={hideDatePicker || isFullscreen ? undefined : (
          <DatePicker
            mode="range"
            isOpen={datePickerOpen}
            onOpenChange={(open) => {
              if (open) syncDraftFromCommitted();
              setDatePickerOpen(open);
            }}
            rangeValue={rangeValue}
            onRangeChange={(v) => {
              setRangeValue(v);
              commitToggles();
              // Preset chip selection fires onRangeChange as a side-effect
              // (Apply button). The preset effect already emitted TIME_CHANGE
              // with the correct snapped periodicity — skip here to avoid a
              // second fetch with the old (un-snapped) periodicity.
              if (presetSelectingRef.current) {
                presetSelectingRef.current = false;
                return;
              }
              if (!v || !onEvent) {
                return;
              }
              // Mount-echo guard: the picker fires this once on mount with the
              // initial range. `rangeValue` here is still the pre-update value
              // (setRangeValue above only schedules a re-render), so if the
              // incoming range equals it, this is the mount echo — skip it. The
              // host already queried this window; emitting would duplicate it.
              // A real first pick has a different range and passes through.
              if (!rangeInitRef.current) {
                rangeInitRef.current = true;
                const unchanged =
                  !!rangeValue &&
                  new Date(v.start).getTime() === new Date(rangeValue.start).getTime() &&
                  new Date(v.end).getTime() === new Date(rangeValue.end).getTime();
                if (unchanged) {
                  return;
                }
              }
              // Manual range pick: snap using preset-definition periodicities
              // first (calendarType / explicit list / minute-band), then fall
              // back to bucket-count heuristic for fully custom ranges.
              const nextOptions = getPresetPeriodicities(activePreset) ?? getValidPeriodicities(v);
              // A genuine window change defaults periodicity to the highest-order
              // option (index 0), clearing any prior manual pick; a toggle-only
              // apply (same window) keeps the current selection.
              const rangeChanged =
                !rangeValue ||
                new Date(v.start).getTime() !== new Date(rangeValue.start).getTime() ||
                new Date(v.end).getTime() !== new Date(rangeValue.end).getTime();
              const nextPeriodicity = rangeChanged && nextOptions.length
                ? nextOptions[0]
                : pickPeriodicity(nextOptions, selectedPeriodicity, periodicityTouchedRef.current);
              if (rangeChanged) periodicityTouchedRef.current = false;
              if (nextPeriodicity !== selectedPeriodicity) {
                setSelectedPeriodicity(nextPeriodicity);
              }
              // Comparison is committed synchronously above (commitToggles) —
              // use the draft value being committed since the ref hasn't
              // re-rendered yet at this point.
              const vStart = new Date(v.start).getTime();
              const vEnd = new Date(v.end).getTime();
              // Draft values were just committed by commitToggles() above; the
              // committed refs haven't re-rendered yet, so read the drafts here.
              const shiftActive = draftShiftOn && cfgShifts.length > 0;
              const compActive = cfgComparisonMode && draftComparisonOn;
              const manualPayload = {
                startTime: String(vStart),
                endTime: String(vEnd),
                periodicity: nextPeriodicity.toLowerCase(),
                ...(shiftActive
                  ? shiftEventPayload(cfgShifts, cfgShiftAggregator)
                  : compActive
                    ? comparisonWindowPayload(vStart, vEnd)
                    : {}),
                ...controlFlags(),
              };
              beginPendingFetch(); // show the loader until the host answers the new window
              onEvent({ type: 'TIME_CHANGE', payload: manualPayload });
            }}
            showPresets={datePresets.length > 0}
            showPresetChip={datePresets.length > 0}
            presets={datePresets}
            selectedPreset={selectedPreset}
            onPresetSelect={(v: string) => {
              presetSelectingRef.current = true;
              // A duration pick always resets periodicity to that duration's
              // highest (coarsest) option — clear the manual-pick flag so every
              // resolver (preset effect, sync effect, manual-range path) defaults
              // to options[0] instead of preserving a value that happens to be
              // valid in both durations (e.g. Current Month Daily → Previous 3
              // Months should jump to Monthly, not stay on Daily).
              periodicityTouchedRef.current = false;
              setSelectedPreset(v);
            }}
            placeholder="Select date range"
            showShift={cfgShifts.length > 0}
            shiftEnabled={draftShiftOn}
            onShiftToggle={draftActivateShift}
            showComparison={cfgComparisonMode && !config?.realtimeMode}
            comparisonEnabled={draftComparisonOn}
            onComparisonToggle={draftActivateComparison}
            showPeriodicity={!config?.realtimeMode && !cfgDisablePeriodicities}
            periodicitySlot={
              !config?.realtimeMode && !cfgDisablePeriodicities ? (
                <SelectInput
                  label=""
                  value={selectedPeriodicity}
                  placeholder="Periodicity"
                  // Only one periodicity maps to this duration — nothing else to
                  // pick, so disable the dropdown.
                  isDisabled={periodicityOptions.length <= 1}
                  isOpen={periodicityOpen}
                  // `onOpenChange` is the SDK's controlled-mode open/close
                  // channel — it fires on trigger click AND on outside-click /
                  // Escape. A separate `onClick` toggle made the SDK think WE
                  // drive the open state, so it stopped reporting outside-clicks
                  // and the dropdown never closed. Drive it solely from
                  // onOpenChange (guarded so a single-option list can't open).
                  onOpenChange={(open) =>
                    setPeriodicityOpen(open && periodicityOptions.length > 1)
                  }
                >
                  <DropdownMenu className="lcw__periodicity-menu">
                    {periodicityOptions.map((opt) => (
                      <ActionListItem
                        key={opt}
                        title={opt}
                        selectionType="Single"
                        isSelected={opt === selectedPeriodicity}
                        onClick={() => {
                          periodicityTouchedRef.current = true;
                          setSelectedPeriodicity(opt);
                          setPeriodicityOpen(false);
                          if (!onEvent || !rangeValue) return;
                          const startTime = new Date(rangeValue.start).getTime();
                          const endTime = new Date(rangeValue.end).getTime();
                          beginPendingFetch(); // loader until the host returns the new periodicity
                          onEvent({
                            type: 'TIME_CHANGE',
                            payload: {
                              startTime: String(startTime),
                              endTime: String(endTime),
                              periodicity: opt.toLowerCase(),
                              ...modeEventFields(startTime, endTime),
                              ...controlFlags(),
                            },
                          });
                        }}
                      />
                    ))}
                  </DropdownMenu>
                </SelectInput>
              ) : undefined
            }
          />
        )}
        // Info / Settings / Export icons — matches the deployed Column
        // Chart's chrome. Settings exposes legend + data-label toggles;
        // Export downloads PNG/JPEG/SVG/CSV/XLSX or toggles fullscreen.
        // Honors style.hideElements.{settingsIcon,exportIcon}; icons are shown
        // by default when hideElements is absent or false (not explicitly true).
        actions={
          // Pass undefined when nothing is visible — SDK Chart skips the
          // header entirely (no empty-div gap above the canvas). Also hidden
          // entirely in full screen (export + settings chrome is noise there).
          isFullscreen ? undefined :
          (style?.hideElements?.settingsIcon === true &&
           style?.hideElements?.exportIcon === true &&
           !activeChart.description?.trim()) ? undefined : (
            <ChartActionIcons
              description={activeChart.description}
              showSettings={style?.hideElements?.settingsIcon !== true}
              showMore={style?.hideElements?.exportIcon !== true}
              chartRef={chartInstanceRef}
              display={chartDisplay}
              onDisplayChange={setChartDisplay}
            />
          )
        }
      >
        {isLoadingData ? (
          // Still fetching (bound series, no data yet) — show a spinner, NOT the
          // "no data" state which is only for a resolved-but-empty response.
          <div className="lcw__loading-canvas">
            <Spinner size="Medium" label="Loading data" labelPosition="Bottom" />
          </div>
        ) : hasAnySeries && !hasPlottableData ? (
          // No plottable data (zero slots / all-null / backend error) — show the
          // branded empty state in the canvas area, keeping the header + table.
          // Matches v1's "Data not available" state.
          <div className="lcw__empty-canvas" ref={emptyCanvasRefCb}>
            <div
              className="lcw__empty-inner"
              style={noDataWidth ? { width: `${noDataWidth}px` } : undefined}
            >
              <EmptyState
                illustration={<NoDataOneIllustration />}
                title="Data not available"
                description="We couldn't find any data matching your request"
              />
            </div>
          </div>
        ) : (
        <DSLineChart
          // Highcharts updates options in-place via React props for most
          // fields, but doesn't reliably pick up changes to deep style
          // objects (axis title color, label color, line color, grid color,
          // chart background). Force a fresh Highcharts instance by keying
          // on a stable serialization of all style-sensitive inputs so a
          // configurator change immediately reflects on next render.
          key={JSON.stringify({
            ax: axisColors,
            mc: miscColors,
            bg: highchartsOptions?.chart?.backgroundColor,
            chart: activeChart._id,
            // chartMode changes series count/layout; force fresh Highcharts instance.
            mode: chartMode,
            // Force remount when anomaly rules are added/removed so Highcharts
            // clears stale per-point marker objects from the old config.
            anomalyCount: activeChart.anomalies?.length ?? 0,
            // Area fill and data points change the Highcharts series type/marker
            // at options-build time; force a fresh instance so the SDK doesn't
            // apply its own type/marker settings after our overrides.
            areaFill: style?.enableAreaFill,
            dataPoints: style?.showDataPoints,
            // "Add Source as Tooltip" per-series signature. A tooltip-only
            // series is built with lineWidth:0 / showInLegend:false / marker
            // off; when the flag is UNCHECKED the rebuilt options simply OMIT
            // those fields, but chart.update() MERGES — it keeps the stale
            // lineWidth:0 / showInLegend:false, so the line never reappears.
            // Keying on the flags forces a fresh instance so the series redraws
            // as a normal visible line the moment the toggle changes.
            tooltipOnly: effectiveTooltipOnlyFlags.map((f) => (f ? '1' : '0')).join(''),
            // Data SHAPE signature — category count + total null-gap count.
            // Highcharts updates category-axis series in place via chart.update()
            // and does NOT reliably reopen a gap when breakdown null-fillers are
            // added/removed on a re-fetch (e.g. duration change). Keying on the
            // shape forces a fresh instance whenever the gap structure changes so
            // the breakdown breaks always render. Value-only changes (same shape)
            // still update in place — no needless remounts.
            shape: `${categories.length}:${effectiveSeries.reduce(
              (n, s) => n + (s.data?.reduce((m: number, v: any) => m + (v == null ? 1 : 0), 0) ?? 0),
              0,
            )}`,
            // Highcharts only applies `scrollablePlotArea` when the chart is
            // FIRST constructed — a later chart.update() with a changed (or
            // cleared) minWidth never re-applies it (confirmed in ColumnChart:
            // toggling Scroll off left the same scrollWidth in place). Keying on
            // `scroll` forces a fresh Highcharts instance on toggle so the option
            // is honored both when turned on AND off.
            scroll: chartDisplay.scroll,
          })}
          bare
          // null entries are valid Highcharts gaps; the SDK's LineSeries types
          // data as number[], so cast at the boundary.
          series={effectiveSeries as any}
          comparison={chartMode === 'comparison' ? comparisonProp : undefined}
          shift={chartMode === 'shift' ? shiftProp : undefined}
          categories={categories}
          // Full timestamp per bucket for the SDK tooltip's date footer.
          tooltipCategories={tooltipCategories}
          // SDK renders its own ShiftLegend inside the viewport in shift mode;
          // suppress the scrollable series legend so it doesn't show alongside.
          showLegend={shiftProp ? false : chartDisplay.legends}
          showDataLabels={chartDisplay.dataLabel}
          showMarkers={style?.showDataPoints ? true : false}
          smooth={!style?.enableAreaFill}
          // Horizontal plot-area scroll for dense category axes. The authoritative
          // scroll config (computed minWidth, explicit 0-when-off) is set in
          // highchartsOptions.chart.scrollablePlotArea (deep-merged last); these
          // props keep the SDK's own path in sync.
          scrollable={chartDisplay.scroll}
          scrollableMinWidth={Math.max(800, categories.length * 50)}
          plotLines={[]}
          plotBands={[]}
          xAxisTitle={activeChart?.defaultAxis?.xAxisLabel || undefined}
          yAxisTitle={leftAxisTitle}
          highchartsOptions={highchartsOptions}
          onPointClick={(ctx) => {
            if (!onEvent) return;
            const bucket = catTimestamps[ctx.pointIndex];
            const finer = finerPeriodicity(selectedPeriodicity);
            if (!bucket?.from || !bucket?.to || !finer) return;
            const newRange = { start: new Date(bucket.from), end: new Date(bucket.to) };
            setRangeValue(newRange);
            setSelectedPreset('');
            periodicityTouchedRef.current = true;
            setSelectedPeriodicity(finer);
            beginPendingFetch(); // loader until the host returns the drill-down window
            onEvent({
              type: 'TIME_CHANGE',
              payload: {
                startTime: String(bucket.from),
                endTime: String(bucket.to),
                periodicity: finer.toLowerCase(),
                ...controlFlags(),
              },
            });
          }}
          onChartReady={(inst: { reflow: () => void; redraw?: () => void; fdsToggleFullscreen?: () => void }) => {
            chartInstanceRef.current = inst;
            // The series can be drawn to a stale/empty geometry at first paint
            // (loader→chart swap): the axes render but the line stays invisible
            // until a hover forces the SDK to redraw the path. repaintChart marks
            // every series dirty and redraws — reproducing that hover. Several
            // passes cover layout still settling across the first frames.
            requestAnimationFrame(repaintChart);
            setTimeout(repaintChart, 80);
            setTimeout(repaintChart, 300);
          }}
        />
        )}
      </Chart>
      {cardEl &&
        showDataTable &&
        createPortal(
          <DataTablePreview
            dataTable={dataTable!}
            series={activeChart.series}
            chartIndex={chartIndex}
            data={data}
            headerStyle={dataTableStyles?.header}
            cellStyle={dataTableStyles?.cell}
          />,
          cardEl,
        )}
    </div>
  );
}

LineChart.displayName = 'LineChart';

// ---------------------------------------------------------------------------
// ChartActionIcons — Info / Settings / Export icons in the SDK Chart's
// `actions` slot. Menus are portalled into document.body so they are never
// clipped by overflow:hidden or buried under Highcharts' z-index:0 stacking
// context. Position is derived from getBoundingClientRect() → position:fixed.
// ---------------------------------------------------------------------------
function ChartActionIcons({
  description,
  showSettings,
  showMore,
  chartRef,
  display,
  onDisplayChange,
}: {
  description?: string;
  showSettings: boolean;
  showMore: boolean;
  chartRef: React.MutableRefObject<{
    reflow: () => void;
    fdsToggleFullscreen?: () => void;
  } | null>;
  display: ChartDisplay;
  onDisplayChange: (next: ChartDisplay) => void;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ top: 0, right: 0 });

  function capturePos(e: React.MouseEvent<HTMLButtonElement>) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenuPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
  }

  useEffect(() => {
    if (!settingsOpen && !moreOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { setSettingsOpen(false); setMoreOpen(false); }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [settingsOpen, moreOpen]);

  const toggle = (key: keyof ChartDisplay) =>
    onDisplayChange({ ...display, [key]: !display[key] });

  const doExport = (format: ChartExportFormat) => {
    const instance = chartRef.current;
    if (instance) exportChart({ instance, engine: 'highcharts', format, fileName: 'line-chart' });
    setMoreOpen(false);
  };
  const toggleFullscreen = () => {
    chartRef.current?.fdsToggleFullscreen?.();
    setMoreOpen(false);
  };

  const settingGroups: Array<{
    heading: string;
    items: Array<{ key: keyof ChartDisplay; label: string; disabledWhen?: keyof ChartDisplay }>;
  }> = [
    {
      heading: 'Chart Control',
      items: [
        { key: 'legends',         label: 'Legends' },
        { key: 'dataLabel',       label: 'Data Labels' },
        { key: 'clipping',        label: 'Clipping' },
        { key: 'zoom',            label: 'Zoom' },
        { key: 'scroll',          label: 'Scroll' },
      ],
    },
  ];
  const exportFormats: ChartExportFormat[] = ['SVG', 'PNG', 'JPEG', 'CSV', 'XLSX'];
  const hasDescription = !!description?.trim();

  const backdropStyle: React.CSSProperties = { position: 'fixed', inset: 0, zIndex: 9999 };
  const menuStyle: React.CSSProperties = {
    position: 'fixed',
    top: menuPos.top,
    right: menuPos.right,
    zIndex: 10000,
    minWidth: 200,
  };

  return (
    <div className="lcw__chart-actions">
      {hasDescription && (
        <Tooltip bodyText={description!.trim()} placement="Bottom" isDisabled={settingsOpen || moreOpen}>
          <IconButton
            icon={<Info size={16} />}
            size="Medium"
            accessibilityLabel="Info"
          />
        </Tooltip>
      )}
      {showSettings && (
        <Tooltip bodyText="Chart Settings" placement="Bottom" isDisabled={settingsOpen || moreOpen}>
          <IconButton
            icon={<Settings size={16} />}
            size="Medium"
            accessibilityLabel="Chart Settings"
            onClick={(e) => { capturePos(e); setSettingsOpen((o) => !o); setMoreOpen(false); }}
          />
        </Tooltip>
      )}
      {showMore && (
        <Tooltip bodyText="More" placement="Bottom" isDisabled={settingsOpen || moreOpen}>
          <IconButton
            icon={<Menu size={16} />}
            size="Medium"
            accessibilityLabel="Export"
            onClick={(e) => { capturePos(e); setMoreOpen((o) => !o); setSettingsOpen(false); }}
          />
        </Tooltip>
      )}
      {settingsOpen && createPortal(
        <>
          <div style={backdropStyle} onClick={() => setSettingsOpen(false)} />
          <div style={menuStyle}>
            <DropdownMenu>
              {settingGroups.map((group, gi) => (
                <Fragment key={group.heading}>
                  {gi > 0 && <ActionListItem contentType="Separator" />}
                  <ActionListItem contentType="SectionHeading" title={group.heading} />
                  {group.items.map((it) => (
                    <ActionListItem
                      key={it.key}
                      title={it.label}
                      selectionType="Multiple"
                      isSelected={display[it.key]}
                      isDisabled={it.disabledWhen ? display[it.disabledWhen] : undefined}
                      onClick={() => toggle(it.key)}
                    />
                  ))}
                </Fragment>
              ))}
            </DropdownMenu>
          </div>
        </>,
        document.body
      )}
      {moreOpen && createPortal(
        <>
          <div style={backdropStyle} onClick={() => setMoreOpen(false)} />
          {/* Fixed 150px width for the More menu (overrides the shared menuStyle
              minWidth, which the settings menu keeps). */}
          <div style={{ ...menuStyle, minWidth: 150, width: 150 }}>
            <DropdownMenu>
              <ActionListItem title="View in full screen" selectionType="None" onClick={toggleFullscreen} />
              <ActionListItem contentType="Separator" />
              <ActionListItem contentType="SectionHeading" title="Download Type" />
              {exportFormats.map((f) => (
                <ActionListItem key={f} title={f} selectionType="None" onClick={() => doExport(f)} />
              ))}
            </DropdownMenu>
          </div>
        </>,
        document.body
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ChartTitleSwitcher — clickable title with a dropdown to switch between
// configured charts in the same widget. Rendered as the Chart's `title` slot
// when more than one chart exists. Uses the SDK's `fds-chart__title` /
// `fds-chart-switcher__*` classes so it visually matches every other
// switchable chart title in the platform.
// ---------------------------------------------------------------------------
function ChartTitleSwitcher({
  charts,
  activeChart,
  onSelect,
  titleStyle,
}: {
  charts: ChartInstance[];
  activeChart: ChartInstance | null;
  onSelect: (id: string) => void;
  titleStyle?: React.CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const label = activeChart?.title || 'Untitled Chart';
  const labelRef = useRef<HTMLSpanElement>(null);
  const truncated = useIsTruncated(labelRef, label);
  return (
    <div className="fds-chart-switcher__title">
      {/* Full-title tooltip only when the switcher label is clipped. isDisabled
          suppresses it otherwise; the wrapper className keeps min-width:0 so the
          label can still shrink/truncate inside the header (see LineChart.css). */}
      <Tooltip bodyText={label} placement="Bottom" isDisabled={!truncated} className="lcw__switcher-title-wrap">
        <button
          type="button"
          className="fds-chart__title"
          onClick={(e) => {
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setMenuPos({ top: rect.bottom + 4, left: rect.left });
            setOpen((o) => !o);
          }}
          aria-haspopup="menu"
          aria-expanded={open}
        >
          <span ref={labelRef} className="fds-chart__title-label HeadingSmallSemibold" style={titleStyle}>
            {label}
          </span>
          <ChevronDown className="fds-chart__title-icon" aria-hidden="true" />
        </button>
      </Tooltip>
      {open && createPortal(
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 9999 }}
            onClick={() => setOpen(false)}
          />
          {/* Cap the chart list height so many charts scroll instead of running
              off-screen; ~7 rows then a scrollbar. */}
          <div className="lcw__chart-switcher-menu" style={{ position: 'fixed', top: menuPos.top, left: menuPos.left, zIndex: 10000, minWidth: 200, maxWidth: 300, maxHeight: 'min(320px, 60vh)', overflowY: 'auto', overflowX: 'hidden' }}>
            <DropdownMenu>
              {charts.map((c) => (
                <ActionListItem
                  key={c._id}
                  title={c.title || 'Untitled Chart'}
                  selectionType="Single"
                  isSelected={c._id === activeChart?._id}
                  onClick={() => {
                    onSelect(c._id);
                    setOpen(false);
                  }}
                />
              ))}
            </DropdownMenu>
          </div>
        </>,
        document.body
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Data table — aggregates each configured column from the resolved series data.
// ---------------------------------------------------------------------------
function DataTablePreview({
  dataTable,
  series,
  chartIndex,
  data,
  headerStyle,
  cellStyle,
}: {
  dataTable: DataTableConfig;
  series: LineChartSeries[];
  chartIndex: number;
  data: DataEntry[];
  headerStyle?: React.CSSProperties;
  cellStyle?: React.CSSProperties;
}) {
  const seriesById = useMemo(() => {
    const m = new Map<string, LineChartSeries>();
    series.forEach((s) => m.set(s._id, s));
    return m;
  }, [series]);

  // Operators selected for the table — one aggregated row/column per operator.
  const ops = useMemo<DataTableOperator[]>(() => {
    if (dataTable.operators && dataTable.operators.length) return dataTable.operators;
    return dataTable.operator ? [dataTable.operator] : ['avg'];
  }, [dataTable.operators, dataTable.operator]);

  // Per-column label + resolved values (aggregation applied per operator below).
  const cols = useMemo(
    () =>
      dataTable.columns.map((col, colIdx) => {
        const baseLabel = columnLabel(col, seriesById);
        const unit =
          col.sourceMode === 'Existing' && col.seriesId
            ? seriesById.get(col.seriesId)?.limit
            : col.unit;
        const label = dataTable.showUnit && unit ? `${baseLabel} (${unit})` : baseLabel;

        let values: number[] = [];
        if (col.sourceMode === 'Existing' && col.seriesId) {
          const si = series.findIndex((s) => s._id === col.seriesId);
          if (si >= 0) {
            const payload =
              getSeriesData(`charts[${chartIndex}].series[${si}].unsPath`, data) ??
              getSeriesData(`charts[${chartIndex}].series[${si}].dataSource`, data);
            values = (payload?.slots ?? [])
              .map((slot) => coerceSlotValue(slot.value))
              .filter((v): v is number => v !== null);
          }
        } else if (col.sourceMode === 'AddNew') {
          // AddNew columns are fetched via their own binding key (not tied to
          // any chart series). The configurator registers the binding as
          // `charts[ci].dataTable.columns[colIdx].topic` in dynamicBindingPathList.
          const payload = getSeriesData(
            `charts[${chartIndex}].dataTable.columns[${colIdx}].topic`,
            data,
          );
          values = (payload?.slots ?? [])
            .map((slot) => coerceSlotValue(slot.value))
            .filter((v): v is number => v !== null);
        }
        const prec = Number.isFinite(col.dataPrecision) ? col.dataPrecision : 2;
        return { id: col._id, label, values, prec };
      }),
    [dataTable, series, seriesById, chartIndex, data],
  );

  const cellText = (values: number[], op: DataTableOperator, prec: number) =>
    values.length ? aggregate(values, op).toFixed(prec) : 'N/A';

  if (dataTable.transposeTable) {
    // Rows = data sources; one value column per operator.
    const nodes = cols.map((c) => {
      const row: { id: string; source: string; [op: string]: string } = {
        id: c.id,
        source: c.label,
      };
      ops.forEach((op) => {
        row[op] = cellText(c.values, op, c.prec);
      });
      return row;
    });
    return (
      <div className="lcw__data-table">
        <Table data={{ nodes }}>
          {(rows) => (
            <>
              <TableHeader>
                <TableHeaderRow>
                  <TableHeaderCell style={headerStyle}>Data Source</TableHeaderCell>
                  {ops.map((op) => (
                    <TableHeaderCell key={op} style={headerStyle}>
                      {OPERATOR_LABEL[op]}
                    </TableHeaderCell>
                  ))}
                </TableHeaderRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={String(row.id)} item={row}>
                    <TableCell style={cellStyle}>{String(row.source)}</TableCell>
                    {ops.map((op) => (
                      <TableCell key={op} style={cellStyle}>
                        {String(row[op])}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </>
          )}
        </Table>
      </div>
    );
  }

  // Non-transposed: data-source names across the header, one data row per operator.
  const nodes = ops.map((op) => {
    const row: { id: string; __label: string; [key: string]: string } = {
      id: op,
      __label: OPERATOR_LABEL[op],
    };
    cols.forEach((c) => {
      row[c.id] = cellText(c.values, op, c.prec);
    });
    return row;
  });
  return (
    <div className="lcw__data-table">
      <Table data={{ nodes }}>
        {(rows) => (
          <>
            <TableHeader>
              <TableHeaderRow>
                <TableHeaderCell style={headerStyle}>Data Source</TableHeaderCell>
                {cols.map((c) => (
                  <TableHeaderCell key={c.id} style={headerStyle}>
                    {c.label}
                  </TableHeaderCell>
                ))}
              </TableHeaderRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={String(row.id)} item={row}>
                  <TableCell style={cellStyle}>{String(row.__label)}</TableCell>
                  {cols.map((c) => (
                    <TableCell key={c.id} style={cellStyle}>
                      {String(row[c.id])}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </>
        )}
      </Table>
    </div>
  );
}
