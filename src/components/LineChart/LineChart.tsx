import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import Highcharts from 'highcharts';
import HC_Exporting from 'highcharts/modules/exporting';
import HC_ExportData from 'highcharts/modules/export-data';
import HC_FullScreen from 'highcharts/modules/full-screen';
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
import { ChevronDown, Settings, Menu, Download, Info } from 'react-feather';
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
import '@faclon-labs/design-sdk/base.css';
import './LineChart.css';

// Register the Highcharts modules the SDK chart's actions slot will call
// downstream (export to PNG/SVG/CSV/XLS, fullscreen toggle). Without these
// registered at module load, chart.exportChart() / fullscreen.toggle() are
// undefined and silently no-op. Order matters: `exporting` must register
// before `export-data` (the latter extends the former).
function installHcModule(mod: unknown) {
  const factory = typeof mod === 'function' ? mod : (mod as { default?: unknown }).default;
  if (typeof factory === 'function') (factory as (h: typeof Highcharts) => void)(Highcharts);
}
if (typeof window !== 'undefined') {
  installHcModule(HC_Exporting);
  installHcModule(HC_ExportData);
  installHcModule(HC_FullScreen);
}

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

export function LineChart({
  config: rawConfig,
  data = [],
  timeConfig,
  timeTabConfig,
  onEvent,
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
  const defaultDisplayMode =
    timeTabConfig?.defaultDisplayMode ??
    (timeConfig as { defaultDisplayMode?: import('../../iosense-sdk/types').TimeTabDefaultDisplayMode } | undefined)?.defaultDisplayMode;
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
  const cfgShifts = timeConfig?.shifts ?? [];
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
  const [shiftToggleOn, setShiftToggleOn] = useState(() => {
    const legacyAutoOn = cfgShifts.length > 0 && !isGTPMode;
    return defaultDisplayMode === 'shift' ? legacyAutoOn
      : defaultDisplayMode === 'normal' || defaultDisplayMode === 'comparison' ? false
      : legacyAutoOn; // undefined = legacy
  });
  const [draftShiftOn, setDraftShiftOn] = useState(() => {
    const legacyAutoOn = cfgShifts.length > 0 && !isGTPMode;
    return defaultDisplayMode === 'shift' ? legacyAutoOn
      : defaultDisplayMode === 'normal' || defaultDisplayMode === 'comparison' ? false
      : legacyAutoOn;
  });
  useEffect(() => {
    const mode = defaultDisplayModeRef.current;
    const legacyAutoOn = cfgShifts.length > 0 && !isGTPModeRef.current;
    const autoOn =
      mode === 'shift' ? legacyAutoOn
      : mode === 'normal' || mode === 'comparison' ? false
      : legacyAutoOn;
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
  const cfgComparisonMode = !!timeConfig?.comparisonMode;
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
    const legacyAutoOn = cfgShifts.length > 0 && !isGTPModeRef.current;
    const shiftOn = mode === 'shift' ? legacyAutoOn
      : (mode === 'normal' || mode === 'comparison') ? false
      : legacyAutoOn;
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

  const chartMode = useMemo<'normal' | 'comparison' | 'shift'>(() => {
    // Purely toggle-driven — toggle state is initialized from defaultDisplayMode
    // on mount and updated via the user's Apply action in the DatePicker.
    // No data-driven fallback: that would make stale shift/comparison data from
    // the previous mode bleed into the new mode while fresh data is loading, and
    // it caused shift view to show after refresh even when defaultDisplayMode='normal'.
    // Shift is supported in realtime too (v1 parity) — the host must send the
    // shifts with timeFrame:'realtime' so the backend returns shift-tagged
    // realtime data; the shiftSubDaily branch below then bridges the segments.
    if (shiftToggleOn && cfgShifts.length > 0) return 'shift';
    if (comparisonToggleOn && cfgComparisonMode) return 'comparison';
    return 'normal';
  }, [shiftToggleOn, comparisonToggleOn, cfgShifts.length, cfgComparisonMode]);

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
        const v = r.slots[idx]?.value;
        seriesData[si].push(typeof v === 'number' ? v : null);
      });
    });

    const out = resolved.map((r, i) => ({
      name: r.def.name || `Series ${i + 1}`,
      color: r.def.color,
      data: seriesData[i],
      tooltip: {
        valueDecimals: typeof r.def.dataPrecision === 'number' ? r.def.dataPrecision : 2,
        // Custom field carried through to the tooltip formatter (Highcharts
        // preserves unknown keys on series.options.tooltip).
        unit: r.unit,
      },
    }));
    return { series: out, categories: cats, catTimestamps: catTs, catShifts: catSh, hasBreakdownGaps };
  }, [activeChart, chartIndex, data, chartMode]);

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
  const firstLoadPending = !everResolved && dataEmpty && hasBoundSeries;
  const loaderActive = firstLoadPending || awaitingData;
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
  const isLoadingData = loaderActive && !loadingExpired;

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
        return currentData.map((_, ci) => {
          const v = cs[ci]?.value;
          return typeof v === 'number' ? v : null;
        });
      })();

      const deviation = currentData.map((y, k) => {
        const p = prevData[k];
        if (y === null || p === null || p === 0) return null;
        return Math.round(((y - p) / Math.abs(p)) * 1000) / 10;
      });

      const pattern: DeviationPattern =
        (timeConfig?.sourceDeviationOverrides?.[`${activeChart?._id}:${s._id}`] as DeviationPattern) ??
        widgetDeviationPattern;

      const meta = { sourceId: s._id, sourceName: name, sourceIndex: i, shiftColor: s.color };

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
  }, [chartMode, activeChart, chartIndex, series, categories, catTimestamps, data, widgetDeviationPattern, timeConfig?.sourceDeviationOverrides]);

  // Shift mode: build ChartShiftConfig directly from slot data + shift windows.
  // Each source × enabled shift becomes a ShiftSeriesInput; the SDK renders
  // colored series and shows shift chips in the legend footer.
  const shiftProp = useMemo<ChartShiftConfig | undefined>(() => {
    if (chartMode !== 'shift' || cfgShifts.length === 0 || series.length === 0) return undefined;
    const tz = timeConfig?.timezone;
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
          data: s.data.map((v, ci) => {
            // Prefer the backend's per-bucket shift tag — with multiple shifts
            // it authoritatively says which shift each bucket belongs to. Match
            // by shift name (the tag is the shift's name).
            const tag = catShifts[ci];
            if (tag !== undefined) {
              if (tag === shift.name) return v;
              // Boundary bridge — sub-daily (minute/hourly) ONLY. Here shifts
              // are contiguous time-of-day blocks, so emitting the value at the
              // FIRST bucket after this shift's run (the next shift's opening
              // bucket) makes segments join into ONE continuous line: 00–08,
              // 08–16, 16–00 share endpoints. At Daily and coarser we DON'T
              // bridge — each shift stays its own line across days (connected
              // via connectNulls, see highchartsOptions).
              if (shiftSubDaily && catShifts[ci - 1] === shift.name) return v;
              return null;
            }
            // Fall back to the time-window check only when the backend didn't
            // tag the bucket (e.g. an older backend that ignores `shifts`).
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
  }, [chartMode, cfgShiftKey, series, catTimestamps, catShifts, enabledShiftIds, activeChart, timeConfig?.timezone, shiftSubDaily]);

  // Plot lines (fixed values only — periodicity-dependent lines need the live
  // periodicity context which the host owns, so they're rendered server-side).
  const plotLines = useMemo<ChartPlotLine[]>(() => {
    const BINDING_RE = /^\{\{.+\}\}$/;
    const out: ChartPlotLine[] = [];
    (activeChart?.plotLines ?? []).forEach((p, pi) => {
      const rawValue = p.value ?? p.fixedValue ?? p.dynamicTopic ?? '';
      const isBinding = BINDING_RE.test(rawValue);

      if (isBinding) {
        const key = `charts[${chartIndex}].plotLines[${pi}].value`;
        const entry = (data ?? []).find((d) => d.key === key);
        if (!entry) return;
        const payload = entry.value as SeriesPayload | null;
        if (!payload || payload.__type !== 'series') return;
        const slots = payload.slots.filter((s) => s.value !== null);
        if (slots.length === 0) return;
        const v = slots[slots.length - 1].value!;
        out.push({ value: v, color: p.color, width: p.lineWidth, dashStyle: p.lineStyle === 'Dashed' ? 'Dash' : 'Solid', label: p.name, _axisId: p.axisId ?? '' } as any);
      } else {
        const v = Number(rawValue);
        if (!Number.isFinite(v)) return;
        out.push({ value: v, color: p.color, width: p.lineWidth, dashStyle: p.lineStyle === 'Dashed' ? 'Dash' : 'Solid', label: p.name, _axisId: p.axisId ?? '' } as any);
      }
    });
    return out;
  }, [activeChart, chartIndex, data]);

  const plotBands = useMemo<(ChartPlotBand & { _axisId?: string })[]>(
    () =>
      (activeChart?.plotBands ?? []).map((b) => ({
        from: b.startValue,
        to: b.endValue,
        color: b.color,
        label: b.name,
        _axisId: b.axisId ?? '',
      })),
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
          const v = payload.slots[pi]?.value;
          if (v === null || v === undefined || !Number.isFinite(v as number)) continue;
          threshold = v as number;
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
    const leftPlotLines = plotLines.filter((p) => !(p as any)._axisId);
    const leftPlotBands = plotBands.filter((b) => !b._axisId);
    const leftAxis = {
      title: { text: leftAxisTitle },
      ...(leftPlotLines.length
        ? { plotLines: leftPlotLines.map((p) => ({ value: p.value, color: p.color, width: p.width, dashStyle: p.dashStyle, ...(p.label ? { label: { text: p.label } } : {}) })) }
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
        ...(rpl.length ? { plotLines: rpl.map((p) => ({ value: p.value, color: p.color, width: p.width ?? 2, dashStyle: p.dashStyle ?? 'Dash', zIndex: 5, ...(p.label ? { label: { text: p.label, align: 'right', style: { color: p.color } } } : {}) })) } : {}),
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
  });

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
    // Highcharts paints `<rect class="highcharts-background">` with an
    // explicit fill — `fill: transparent` via CSS only works if NOTHING
    // else (SDK chrome, theme classes) paints white between us and the
    // card. The robust fix: tell Highcharts directly to use the card's
    // background color (or transparent when wrap-in-card is on and the
    // card has no surface of its own). Same approach mirrors the deployed
    // Column Chart widget.
    opts.chart = {
      backgroundColor:
        style?.card?.wrapInCard !== false
          ? 'transparent'
          : style?.card?.backgroundColor || '#FFFFFF',
      // The SDK hardcodes zooming: { type: 'x' } internally; override here
      // explicitly so disabling zoom via the gear menu actually takes effect.
      zooming: { type: chartDisplay.zoom ? 'x' : (null as any) },
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
          ...(p.label ? { label: { text: p.label, align: 'right', style: { color: p.color } } } : {}),
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
    // generated series, so we can inject per-shift fillColor gradients here.
    // We override opts.series entirely for shift+areaFill because effectiveSeries
    // (source-indexed, length = #sources) doesn't align with the SDK's expanded
    // series (length = #sources × #shifts). Shift tooltip/legend are SDK-owned
    // in this mode so the effectiveSeries-based per-series opts aren't needed.
    if (chartMode === 'shift' && style?.enableAreaFill && shiftProp) {
      opts.series = (shiftProp.series as any[]).map((ss: any) => ({
        // Fill down to the axis MINIMUM, not the default threshold of 0 — else
        // each shift area fills from 0 up to its value, rendering as tall solid
        // bars from the axis bottom instead of a gradient under the line.
        threshold: null,
        fillColor: {
          linearGradient: { x1: 0, y1: 0, x2: 0, y2: 1 },
          stops: [
            [0, hexToRgba(ss.shiftColor || '#7cb5ec', 0.5)],
            [1, hexToRgba(ss.shiftColor || '#7cb5ec', 0)],
          ],
        },
      }));
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
    return opts as any;
  }, [axisColors, miscColors, multiAxis, effectiveSeries, effectiveTooltipOnlyFlags, style?.card?.wrapInCard, style?.card?.backgroundColor, style?.enableAreaFill, style?.showDataPoints, chartDisplay.zoom, anomalyOverlay, chartMode, plotLines, plotBands, activeChart, shiftSubDaily, shiftProp, config?.realtimeMode, hasBreakdownGaps, realtimeTicks, catTimestamps, timeConfig?.timezone]);

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
  // Blocks onRangeChange from re-emitting TIME_CHANGE when the SDK DatePicker
  // fires it as a side-effect of a preset chip selection (preset effect already
  // handles the emit). Mirrors the reference widget's presetSelectingRef pattern.
  const presetSelectingRef = useRef(false);
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
    const nextPeriodicity = pickPeriodicity(
      nextOptions, selectedPeriodicity, periodicityTouchedRef.current,
    );
    if (nextPeriodicity !== selectedPeriodicity) setSelectedPeriodicity(nextPeriodicity);

    const evStart = new Date(eventRange.start).getTime();
    const evEnd = new Date(eventRange.end).getTime();
    const presetPayload = {
      startTime: String(evStart),
      endTime: String(evEnd),
      periodicity: nextPeriodicity.toLowerCase(),
      ...modeEventFields(evStart, evEnd),
      ...controlFlags(),
    };
    console.log('[LineChart] emitting TIME_CHANGE (preset select)', {
      selectedPreset,
      payload: presetPayload,
    });
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
    console.log('[LineChart] emitting TIME_CHANGE (control toggle)', payload);
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
    console.log('[LineChart] emitting TIME_CHANGE (realtime mount)', payload);
    ev({ type: 'TIME_CHANGE', payload });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.realtimeMode, initialRange]);

  const periodicityOptions = useMemo(() => {
    return getPresetPeriodicities(activePreset) ?? getValidPeriodicities(rangeValue);
  }, [activePreset, rangeValue]);

  // Keep the selection in step with the available options: default to the
  // highest-order (coarsest) option until the user picks one, then hold their
  // choice unless the range renders it invalid.
  useEffect(() => {
    if (!periodicityOptions.length) return;
    const next = pickPeriodicity(
      periodicityOptions, selectedPeriodicity, periodicityTouchedRef.current,
    );
    if (next !== selectedPeriodicity) setSelectedPeriodicity(next);
  }, [periodicityOptions, selectedPeriodicity]);

  // Highcharts instance handle for the export menu and fullscreen toggle.
  const chartInstanceRef = useRef<
    { reflow: () => void; fdsToggleFullscreen?: () => void } | null
  >(null);

  // Root element ref for the ResizeObserver — triggers chart.reflow() when the
  // dashboard resizes or repositions this widget so Highcharts recalculates
  // tick positions and label layout rather than stretching the mount-time SVG.
  const lcwRef = useRef<HTMLDivElement | null>(null);
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
        try { chart.reflow(); } catch { /* chart destroyed mid-resize */ }
      });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (resizeRafRef.current !== undefined) cancelAnimationFrame(resizeRafRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Date presets surfaced in the DatePicker's preset rail. Derived from the
  // host-passed allDurations so what's offered here matches what was
  // configured in the configurator's Time tab.
  const datePresets = useMemo<DatePresetOption[]>(
    () => [
      // "Custom" is always first — lets the user pick a free-form date range.
      { value: 'custom', label: 'Custom' },
      ...(timeConfig?.allDurations ?? []).map((d) => ({
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
    return { '--lcw-card-bg': bg } as React.CSSProperties;
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
      : undefined;

  const allHeaderItemsHidden =
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
      ].filter(Boolean).join(' ')}
      style={widgetStyle}
      ref={lcwRef}
    >
      {miscColors.legend && (
        <style>{`.lcw [class*="legend-label"] { color: ${miscColors.legend} !important; }`}</style>
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
        duration={durationSlot}
        title={
          style?.hideElements?.chartTitle ? undefined : charts.length > 1 ? (
            <ChartTitleSwitcher
              charts={charts}
              activeChart={activeChart}
              onSelect={setPreviewChartId}
              titleStyle={titleStyle}
            />
          ) : (
            <span style={titleStyle}>{activeChart.title || 'Line Chart'}</span>
          )
        }
        // DatePicker in the filters slot — hidden for fixed-time mode and when
        // no data source is configured yet (nothing to time-filter).
        filters={hideDatePicker ? undefined : (
          <DatePicker
            mode="range"
            isOpen={datePickerOpen}
            onOpenChange={(open) => {
              if (open) syncDraftFromCommitted();
              setDatePickerOpen(open);
            }}
            rangeValue={rangeValue}
            onRangeChange={(v) => {
              console.log('[LineChart] DatePicker onRangeChange fired', {
                value: v,
                presetSelecting: presetSelectingRef.current,
                hasOnEvent: !!onEvent,
              });
              setRangeValue(v);
              commitToggles();
              // Preset chip selection fires onRangeChange as a side-effect
              // (Apply button). The preset effect already emitted TIME_CHANGE
              // with the correct snapped periodicity — skip here to avoid a
              // second fetch with the old (un-snapped) periodicity.
              if (presetSelectingRef.current) {
                presetSelectingRef.current = false;
                console.log('[LineChart] onRangeChange skipped — presetSelecting guard');
                return;
              }
              if (!v || !onEvent) {
                console.log('[LineChart] onRangeChange bailed — no value or no onEvent', {
                  hasValue: !!v,
                  hasOnEvent: !!onEvent,
                });
                return;
              }
              // Manual range pick: snap using preset-definition periodicities
              // first (calendarType / explicit list / minute-band), then fall
              // back to bucket-count heuristic for fully custom ranges.
              const nextOptions = getPresetPeriodicities(activePreset) ?? getValidPeriodicities(v);
              const nextPeriodicity = pickPeriodicity(
                nextOptions, selectedPeriodicity, periodicityTouchedRef.current,
              );
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
              console.log('[LineChart] emitting TIME_CHANGE (manual range pick)', manualPayload);
              beginPendingFetch(); // show the loader until the host answers the new window
              onEvent({ type: 'TIME_CHANGE', payload: manualPayload });
            }}
            showPresets={datePresets.length > 0}
            showPresetChip={datePresets.length > 0}
            presets={datePresets}
            selectedPreset={selectedPreset}
            onPresetSelect={(v: string) => {
              presetSelectingRef.current = true;
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
                  isOpen={periodicityOpen}
                  onOpenChange={setPeriodicityOpen}
                  onClick={() => setPeriodicityOpen((o) => !o)}
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
          // header entirely (no empty-div gap above the canvas).
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
          })}
          bare
          // null entries are valid Highcharts gaps; the SDK's LineSeries types
          // data as number[], so cast at the boundary.
          series={effectiveSeries as any}
          comparison={chartMode === 'comparison' ? comparisonProp : undefined}
          shift={chartMode === 'shift' ? shiftProp : undefined}
          categories={categories}
          // SDK renders its own ShiftLegend inside the viewport in shift mode;
          // suppress the scrollable series legend so it doesn't show alongside.
          showLegend={shiftProp ? false : chartDisplay.legends}
          showDataLabels={chartDisplay.dataLabel}
          showMarkers={style?.showDataPoints ? true : false}
          smooth={!style?.enableAreaFill}
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
          onChartReady={(inst: { reflow: () => void; fdsToggleFullscreen?: () => void }) => {
            chartInstanceRef.current = inst;
            // Reflow on the next animation frame so Highcharts measures the
            // container AFTER the DOM settles. Without this, key-driven
            // remounts during config editing can initialize at a stale size.
            requestAnimationFrame(() => {
              try { inst.reflow(); } catch { /* chart destroyed before frame */ }
            });
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
        <IconButton
          icon={<Settings size={16} />}
          size="Medium"
          accessibilityLabel="Settings"
          onClick={(e) => { capturePos(e); setSettingsOpen((o) => !o); setMoreOpen(false); }}
        />
      )}
      {showMore && (
        <IconButton
          icon={<Menu size={16} />}
          size="Medium"
          accessibilityLabel="Export"
          onClick={(e) => { capturePos(e); setMoreOpen((o) => !o); setSettingsOpen(false); }}
        />
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
          <div style={menuStyle}>
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
  return (
    <div className="fds-chart-switcher__title">
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
        <span className="fds-chart__title-label HeadingSmallSemibold" style={titleStyle}>
          {label}
        </span>
        <ChevronDown className="fds-chart__title-icon" aria-hidden="true" />
      </button>
      {open && createPortal(
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 9999 }}
            onClick={() => setOpen(false)}
          />
          <div style={{ position: 'fixed', top: menuPos.top, left: menuPos.left, zIndex: 10000, minWidth: 200 }}>
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
              .map((slot) => slot.value)
              .filter((v): v is number => typeof v === 'number');
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
            .map((slot) => slot.value)
            .filter((v): v is number => typeof v === 'number');
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
