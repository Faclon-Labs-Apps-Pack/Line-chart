import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
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
import { ShiftLegend } from '@faclon-labs/design-sdk';
import { EmptyState, NoDataOneIllustration } from '@faclon-labs/design-sdk/EmptyState';
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
import { resolveAndCompute, getCapturedToken } from '../../iosense-sdk/api';
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
import '@faclon-labs/design-sdk/styles.css';
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
    startTime?: number | null;
    endTime?: number | null;
    fixedDuration?: import('../../iosense-sdk/types').Duration | null;
    shifts?: Array<{ id: string; name: string; color: string; startTime: string; endTime: string }>;
    timezone?: string;
    comparisonMode?: boolean;
    deviationPattern?: string;
    sourceDeviationOverrides?: Record<string, string>;
  };
  onEvent?: (event: WidgetEvent) => void;
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
};

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
    default: return sum / values.length;
  }
}

const PERIODICITY_MS: Record<string, number> = {
  Minute: 60_000,
  Hourly: 3_600_000,
  Daily: 86_400_000,
  Weekly: 7 * 86_400_000,
  Monthly: 28 * 86_400_000,
};
const PERIODICITY_ORDER = ['Minute', 'Hourly', 'Daily', 'Weekly', 'Monthly'];

function titleCase(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function getValidPeriodicities(range: DateRange | null): string[] {
  if (!range?.start || !range?.end) return PERIODICITY_ORDER.slice();
  const span = new Date(range.end).getTime() - new Date(range.start).getTime();
  if (span <= 0) return PERIODICITY_ORDER.slice();
  const MAX_BUCKETS = 1_000;
  const valid = PERIODICITY_ORDER.filter((p) => {
    const ms = PERIODICITY_MS[p];
    return span >= ms && span / ms <= MAX_BUCKETS;
  });
  return valid.length ? valid : ['Minute'];
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
  if (preset.periodicities?.length) return preset.periodicities.map(titleCase);
  if (preset.calendarType) {
    switch (preset.calendarType) {
      case 'today':
      case 'yesterday':      return ['Hourly'];
      case 'current_week':
      case 'previous_week':  return ['Hourly', 'Daily'];
      case 'current_month':
      case 'previous_month': return ['Daily'];
      default: return null;
    }
  }
  if (typeof preset.x === 'number' && preset.xPeriod) {
    const mins = preset.x * (PRESET_MINS[preset.xPeriod] ?? 1440);
    if (mins <= 60)    return ['Minute', 'Hourly'];
    if (mins <= 1440)  return ['Hourly'];
    if (mins <= 10080) return ['Hourly', 'Daily'];
    if (mins <= 43200) return ['Daily'];
    return ['Daily', 'Monthly'];
  }
  return null;
}


// Next finer periodicity for "Time drilldown" — clicking a point narrows the
// range to that bucket and steps one level down for a re-query.
function finerPeriodicity(p?: string): string | null {
  switch ((p || '').toLowerCase()) {
    case 'yearly':  return 'Monthly';
    case 'monthly': return 'Daily';
    case 'weekly':  return 'Daily';
    case 'daily':   return 'Hourly';
    case 'hourly':  return 'Minute';
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

type ChartDisplay = {
  legends: boolean;
  dataLabel: boolean;
  clipping: boolean;
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

export function LineChart({
  config: rawConfig,
  data = [],
  timeConfig,
  onEvent,
  authentication,
}: LineChartWidgetProps) {
  // Auth for comparison fetch. Priority:
  // 1. authentication prop (dev harness passes it explicitly)
  // 2. Token intercepted from Angular DataLayer's XHR calls (production Lens)
  // 3. localStorage fallback (dev sessions without active harness)
  const effectiveAuth = authentication
    || getCapturedToken()
    || (typeof localStorage !== 'undefined'
      ? (localStorage.getItem('iosense_bearer_token') ?? localStorage.getItem('bearer_token') ?? '')
      : '');
  // Emit TIME_CHANGE once on mount so the host's data layer registers this
  // widget for query dispatch. Refs hold the latest values so the mount-only
  // effect can read them without listing them as deps — if we re-emitted on
  // every host-pushed timeConfig change, changing one widget's DatePicker would
  // propagate its time range to every other widget on the dashboard (the host
  // broadcasts the updated timeConfig to all widgets after any TIME_CHANGE).
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const timeConfigRef = useRef(timeConfig);
  timeConfigRef.current = timeConfig;
  useEffect(() => {
    const ev = onEventRef.current;
    if (!ev) return;
    const tc = timeConfigRef.current;
    if (!tc?.defaultDurationId && !tc?.fixedDuration) return;
    const { startTime, endTime } = computeRange(tc);
    const periodicity = (tc.defaultPeriodicity || 'hourly').toLowerCase();
    ev({
      type: 'TIME_CHANGE',
      payload: {
        startTime: String(startTime),
        endTime: String(endTime),
        periodicity,
      },
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Run once on mount — do NOT add timeConfig/onEvent as deps

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
  const cfgShiftKey = cfgShifts.map((s) => s.id).join('|');
  const [shiftToggleOn, setShiftToggleOn] = useState(false);
  const [draftShiftOn, setDraftShiftOn] = useState(false);
  useEffect(() => {
    setShiftToggleOn(false);
    setDraftShiftOn(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfgShiftKey]);
  // Which shift chips are toggled on in the chart legend — all enabled by default.
  // Reset to all-on whenever the shift list changes.
  const [enabledShiftIds, setEnabledShiftIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    setEnabledShiftIds(new Set(cfgShifts.map((s) => s.id)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfgShiftKey]);

  // Comparison state — mirrors shift state: draft in-picker, committed on Apply.
  const cfgComparisonMode = !!timeConfig?.comparisonMode;
  const [comparisonToggleOn, setComparisonToggleOn] = useState(false);
  const [draftComparisonOn, setDraftComparisonOn] = useState(false);
  useEffect(() => {
    if (!cfgComparisonMode) {
      setComparisonToggleOn(false);
      setDraftComparisonOn(false);
    }
  }, [cfgComparisonMode]);

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
    if (cfgComparisonMode && comparisonToggleOn) return 'comparison';
    if (shiftToggleOn && cfgShifts.length > 0) return 'shift';
    return 'normal';
  }, [cfgComparisonMode, comparisonToggleOn, shiftToggleOn, cfgShifts.length]);

  // Resolve each configured series from `data` (series binding key matches the
  // configurator's: charts[ci].series[si].dataSource). Categories are the slot
  // labels of the longest series (backend returns aligned, pre-bucketed slots).
  const { series, categories, catTimestamps } = useMemo(() => {
    const configured = activeChart?.series ?? [];
    const resolved = configured.map((s, si) => {
      const payload =
        getSeriesData(`charts[${chartIndex}].series[${si}].unsPath`, data) ??
        // Legacy key from envelopes saved before the dataSource → unsPath rename.
        getSeriesData(`charts[${chartIndex}].series[${si}].dataSource`, data);
      const slots = payload?.slots ?? [];
      return { def: s, slots };
    });
    const longest = resolved.reduce(
      (best, r) => (r.slots.length > best.length ? r.slots : best),
      [] as { label: string; value: number | null; from: number; to: number }[],
    );
    const cats = longest.map((slot) => slot.label);
    // Store from/to timestamps per bucket — used by the "Time drilldown"
    // onPointClick handler to narrow the time range on click.
    const catTs = longest.map((slot) => ({ from: (slot as any).from as number, to: (slot as any).to as number }));
    const out = resolved.map((r, i) => ({
      name: r.def.name || `Series ${i + 1}`,
      color: r.def.color,
      data: cats.map((_, idx) => {
        const v = r.slots[idx]?.value;
        return typeof v === 'number' ? v : null;
      }),
      tooltip: {
        valueDecimals: typeof r.def.dataPrecision === 'number' ? r.def.dataPrecision : 2,
      },
    }));
    return { series: out, categories: cats, catTimestamps: catTs };
  }, [activeChart, chartIndex, data]);

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

  // Comparison mode — fetch previous-period data directly from the API.
  // Lens's DataLayer only resolves the current period; it doesn't inject
  // _comparison entries automatically. The widget fetches the shifted window
  // itself using the resolved UNS paths from the current data entries.
  // rangeStart/rangeEnd and the fetch effect are declared AFTER rangeValue and
  // selectedPeriodicity state are initialised (below the DatePicker state block).
  const [comparisonSeriesData, setComparisonSeriesData] = useState<Map<string, SeriesPayload>>(new Map());

  // Derive the resolved UNS topic path for each series from the uiConfig.
  // Reading from config (not from data entry.path) guarantees uns:wsId://path
  // format in both dev and production Lens — entry.path format varies by host.
  const SERIES_UNS_RE = /^\{\{(.+)\}\}$/;
  const seriesUNSPaths = useMemo<string[]>(() => {
    if (!activeChart) return [];
    return activeChart.series.map((s) => {
      const raw = (s.unsPath || '').trim();
      const match = SERIES_UNS_RE.exec(raw);
      return match ? match[1] : '';
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChart?._id, activeChart?.series]);

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

      // Previous period — use data fetched by the comparison effect above.
      // Falls back to null per slot while the fetch is in-flight.
      const compPayload = comparisonSeriesData.get(`charts[${chartIndex}].series[${i}].unsPath`);
      const prevData: (number | null)[] = (() => {
        if (!compPayload) return currentData.map(() => null);
        // Build a from→value map and align by timestamp offset rather than by
        // array index. Index alignment breaks when periods have different slot
        // counts (e.g. comparing a 31-day month against a 28-day month at daily
        // resolution). The offset is derived from the actual slot origins so no
        // dependency on rangeStart/rangeEnd is needed here.
        const prevSlotMap = new Map(compPayload.slots.map(sl => [sl.from, sl.value]));
        const prevOrigin = compPayload.slots[0]?.from;
        const currOrigin = catTimestamps[0]?.from;
        const offset = prevOrigin != null && currOrigin != null ? currOrigin - prevOrigin : null;
        return categories.map((_, ci) => {
          const ts = catTimestamps[ci];
          if (!ts?.from || offset === null) return null;
          const v = prevSlotMap.get(ts.from - offset);
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
  }, [chartMode, activeChart, chartIndex, series, categories, catTimestamps, data, widgetDeviationPattern, timeConfig?.sourceDeviationOverrides, comparisonSeriesData]);

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
  }, [chartMode, cfgShiftKey, series, catTimestamps, enabledShiftIds, activeChart, timeConfig?.timezone]);

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
    const rightYAxes = rightAxes.map((a) => ({ title: { text: a.name || 'Axis' }, opposite: true }));
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
  const [chartDisplay, setChartDisplay] = useState<ChartDisplay>({
    legends: true,
    dataLabel: false,
    clipping: false,
    zoom: true,
  });

  const highchartsOptions = useMemo(() => {
    const titleEllipsis = { textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
    const xAxis: any = {};
    xAxis.title = { style: { ...titleEllipsis, ...(axisColors.xTitle ? { color: axisColors.xTitle } : {}) } };
    if (axisColors.xLabel) xAxis.labels = { style: { color: axisColors.xLabel } };
    if (axisColors.xLine) xAxis.lineColor = axisColors.xLine;
    if (miscColors.grid) xAxis.gridLineColor = miscColors.grid;
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
      clip: chartDisplay.clipping,
    };
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
      return so;
    });
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
            const dashStyle: string = c.series?.options?.dashStyle ?? 'Solid';
            let lineRect = `<rect x="0" y="5" width="16" height="2" rx="1" fill="${color}"/>`;
            if (dashStyle !== 'Solid') {
              lineRect = [0, 7, 13].map((x) => `<rect x="${x}" y="5" width="4" height="2" fill="${color}"/>`).join('');
            }
            const svg = `<svg width="16" height="12" viewBox="0 0 16 12" style="flex:0 0 auto;vertical-align:-2px">${lineRect}<circle cx="8" cy="6" r="3" fill="${color}"/></svg>`;
            return `<div style="display:flex;align-items:center;gap:6px;padding:1px 0;white-space:nowrap;font-family:${TOOLTIP_FONT}"><span style="display:inline-flex">${svg}</span><span style="font:400 13px/1.2 ${TOOLTIP_FONT};color:${primary}">${name} : </span><span style="font:700 13px/1.2 ${TOOLTIP_FONT};color:${primary}">${yVal}</span></div>`;
          });
          const cat = (points[0] as any)?.point?.category ?? (this as any).x ?? '';
          return rows.join('') + `<div style="margin-top:4px;font:400 12px/1.2 ${TOOLTIP_FONT};color:${secondary};white-space:nowrap">${cat}</div>`;
        },
      };
    }
    return opts as any;
  }, [axisColors, miscColors, multiAxis, effectiveSeries, effectiveTooltipOnlyFlags, style?.card?.wrapInCard, style?.card?.backgroundColor, chartDisplay.zoom, chartDisplay.clipping, anomalyOverlay, chartMode, plotLines, plotBands, activeChart]);

  // The data table is portalled into the chart card (sibling of the canvas).
  const [cardEl, setCardEl] = useState<HTMLDivElement | null>(null);

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
  const [selectedPeriodicity, setSelectedPeriodicity] = useState<string>(
    () => titleCase(timeConfig?.defaultPeriodicity || 'Hourly'),
  );
  // Sync with host-pushed defaultPeriodicity (on initial load or reset)
  const defaultPeriodicity = timeConfig?.defaultPeriodicity;
  useEffect(() => {
    if (!defaultPeriodicity) return;
    const tc = titleCase(defaultPeriodicity);
    setSelectedPeriodicity((prev) => (prev === tc ? prev : tc));
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
    const nextPeriodicity = nextOptions.includes(selectedPeriodicity)
      ? selectedPeriodicity
      : (nextOptions[0] ?? selectedPeriodicity);
    if (nextPeriodicity !== selectedPeriodicity) setSelectedPeriodicity(nextPeriodicity);

    onEventRef.current?.({
      type: 'TIME_CHANGE',
      payload: {
        startTime: String(new Date(eventRange.start).getTime()),
        endTime: String(new Date(eventRange.end).getTime()),
        periodicity: nextPeriodicity.toLowerCase(),
      },
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPreset, allDurations, JSON.stringify(timeConfig?.cycleTime ?? null)]);

  const periodicityOptions = useMemo(() => {
    return getPresetPeriodicities(activePreset) ?? getValidPeriodicities(rangeValue);
  }, [activePreset, rangeValue]);

  // If the active selection isn't valid for the current range/preset, snap to first valid
  useEffect(() => {
    if (!periodicityOptions.length) return;
    if (periodicityOptions.includes(selectedPeriodicity)) return;
    setSelectedPeriodicity(periodicityOptions[0]);
  }, [periodicityOptions, selectedPeriodicity]);

  // Comparison data fetch — runs after rangeValue and selectedPeriodicity are initialised.
  // Fetches the previous period (same duration, shifted back) for each series.
  const rangeStart = rangeValue?.start instanceof Date ? rangeValue.start.getTime() : 0;
  const rangeEnd   = rangeValue?.end   instanceof Date ? rangeValue.end.getTime()   : 0;

  useEffect(() => {
    if (chartMode !== 'comparison') {
      setComparisonSeriesData(new Map());
      return;
    }
    if (!rangeStart || !rangeEnd) return;

    const validBindings = (activeChart?.series ?? [])
      .map((_, si) => ({
        key: `charts[${chartIndex}].series[${si}].unsPath`,
        topic: seriesUNSPaths[si] ?? '',
        type: 'series' as const,
        aggregation: { operator: 'mean', downscale: 1,
          resolution: (() => {
            switch (selectedPeriodicity.toLowerCase()) {
              case 'minute':  return 'minute';
              case 'hourly':  return 'hour';
              case 'daily':   return 'day';
              case 'weekly':  return 'week';
              case 'monthly': return 'month';
              default:        return 'hour';
            }
          })(),
        },
      }))
      .filter((b) => b.topic);

    if (!validBindings.length) return;

    // Previous period = same duration window, shifted back in time.
    const resolution = validBindings[0].aggregation.resolution;
    const duration = rangeEnd - rangeStart;
    const prevEnd   = rangeStart;
    const prevStart = prevEnd - duration;

    let cancelled = false;
    resolveAndCompute(effectiveAuth, validBindings, prevStart, prevEnd, resolution)
      .then((items) => {
        if (cancelled) return;
        const map = new Map<string, SeriesPayload>();
        items.forEach((item) => {
          const v = item.value;
          if (v && typeof v === 'object' && (v as SeriesPayload).__type === 'series') {
            map.set(item.key, v as SeriesPayload);
          }
        });
        setComparisonSeriesData(map);
      })
      .catch((err) => {
        if (!cancelled) console.error('[LC comparison fetch]', err);
      });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartMode, effectiveAuth, rangeStart, rangeEnd, chartIndex, selectedPeriodicity, activeChart?._id, seriesUNSPaths.join(',')]);

  // Highcharts instance handle for the export menu and fullscreen toggle.
  // chartInitKey increments each time onChartReady fires so the plotLine effect
  // re-runs against the freshly created chart instance.
  const chartInstanceRef = useRef<
    { reflow: () => void; fdsToggleFullscreen?: () => void } | null
  >(null);
  const [chartInitKey, setChartInitKey] = useState(0);

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

  // Apply plotLines/plotBands imperatively via the Highcharts axis API.
  // Re-runs on periodicity change and data arrival (categories.length) because
  // Highcharts rebuilds axis objects during chart.update(), which clears any
  // previously imperative-added lines/bands. The RAF call re-applies after the
  // update settles.
  useEffect(() => {
    const chart = chartInstanceRef.current as any;
    if (!chart) return;

    // Build axisId → Highcharts yAxis index map for plot-line axis routing.
    // Left axis (default) is always index 0; each right axis follows in order.
    const rightAxesList = (activeChart?.axes ?? []).filter((a) => a.position === 'Right');
    const axisIdToHcIdx = new Map<string, number>([['', 0]]);
    rightAxesList.forEach((a, i) => axisIdToHcIdx.set(a._id, i + 1));

    // Same for plot bands — LineChartPlotBand already has axisId.
    const bandAxisIds = (activeChart?.plotBands ?? []).map((b) => b.axisId ?? '');

    const applyPlotLines = () => {
      const hcAxes: any[] = chart.yAxis ?? [];
      hcAxes.forEach((ax: any, axIdx: number) => {
        for (let i = 0; i < 50; i++) {
          ax.removePlotLine?.(`__lc_pl_${axIdx}_${i}`);
          ax.removePlotBand?.(`__lc_pb_${axIdx}_${i}`);
        }
        plotLines.forEach((p, i) => {
          const targetIdx = axisIdToHcIdx.get((p as any)._axisId ?? '') ?? 0;
          if (targetIdx !== axIdx) return;
          ax.addPlotLine({
            id: `__lc_pl_${axIdx}_${i}`,
            value: p.value,
            color: p.color,
            width: p.width ?? 2,
            dashStyle: p.dashStyle ?? 'Dash',
            zIndex: 5,
            ...(p.label ? { label: { text: p.label, align: 'right', style: { color: p.color } } } : {}),
          });
        });
        plotBands.forEach((b, i) => {
          const targetIdx = axisIdToHcIdx.get(bandAxisIds[i] ?? '') ?? 0;
          if (targetIdx !== axIdx) return;
          ax.addPlotBand({ id: `__lc_pb_${axIdx}_${i}`, from: b.from, to: b.to, color: b.color, ...(b.label ? { label: { text: b.label } } : {}) });
        });
      });
    };

    applyPlotLines();
    const raf = requestAnimationFrame(applyPlotLines);
    return () => cancelAnimationFrame(raf);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plotLines, plotBands, chartInitKey, selectedPeriodicity, categories.length]);

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
              if (!v || !onEvent) return;
              // Manual range pick: snap using preset-definition periodicities
              // first (calendarType / explicit list / minute-band), then fall
              // back to bucket-count heuristic for fully custom ranges.
              const nextOptions = getPresetPeriodicities(activePreset) ?? getValidPeriodicities(v);
              const nextPeriodicity = nextOptions.includes(selectedPeriodicity)
                ? selectedPeriodicity
                : (nextOptions[0] ?? selectedPeriodicity);
              if (nextPeriodicity !== selectedPeriodicity) {
                setSelectedPeriodicity(nextPeriodicity);
              }
              onEvent({
                type: 'TIME_CHANGE',
                payload: {
                  startTime: String(new Date(v.start).getTime()),
                  endTime: String(new Date(v.end).getTime()),
                  periodicity: nextPeriodicity.toLowerCase(),
                },
              });
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
            showShift={cfgShifts.length > 0 && ['minute', 'hourly'].includes(selectedPeriodicity)}
            shiftEnabled={draftShiftOn}
            onShiftToggle={draftActivateShift}
            showComparison={cfgComparisonMode}
            comparisonEnabled={draftComparisonOn}
            onComparisonToggle={draftActivateComparison}
            showPeriodicity={activeChart?.chartType !== 'Realtime'}
            periodicitySlot={
              activeChart?.chartType !== 'Realtime' ? (
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
                          setSelectedPeriodicity(opt);
                          setPeriodicityOpen(false);
                          if (!onEvent || !rangeValue) return;
                          const startTime = new Date(rangeValue.start).getTime();
                          const endTime = new Date(rangeValue.end).getTime();
                          onEvent({
                            type: 'TIME_CHANGE',
                            payload: {
                              startTime: String(startTime),
                              endTime: String(endTime),
                              periodicity: opt.toLowerCase(),
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
        // With bare={true} on DSLineChart the SDK's ShiftLegend doesn't
        // auto-render — inject it here in the Chart's footer slot instead.
        footer={
          shiftProp ? (
            <ShiftLegend
              channel="shape"
              sources={shiftProp.sources ?? []}
              shifts={shiftProp.shifts ?? []}
              onToggleShift={shiftProp.onToggleShift ?? (() => {})}
              onToggleSource={shiftProp.onToggleSource}
            />
          ) : undefined
        }
      >
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
          })}
          bare
          // null entries are valid Highcharts gaps; the SDK's LineSeries types
          // data as number[], so cast at the boundary.
          series={effectiveSeries as any}
          comparison={chartMode === 'comparison' ? comparisonProp : undefined}
          shift={chartMode === 'shift' ? shiftProp : undefined}
          categories={categories}
          // ShiftLegend (footer) already renders source names + shift toggles
          // when active — suppress the internal scrollable legend to avoid
          // showing the series list twice.
          showLegend={shiftProp ? false : chartDisplay.legends}
          showDataLabels={chartDisplay.dataLabel}
          showMarkers={false}
          smooth
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
            setSelectedPeriodicity(finer);
            onEvent({
              type: 'TIME_CHANGE',
              payload: {
                startTime: String(bucket.from),
                endTime: String(bucket.to),
                periodicity: finer.toLowerCase(),
              },
            });
          }}
          onChartReady={(inst: { reflow: () => void; fdsToggleFullscreen?: () => void }) => {
            chartInstanceRef.current = inst;
            setChartInitKey((k) => k + 1);
            // Reflow on the next animation frame so Highcharts measures the
            // container AFTER the DOM settles. Without this, key-driven
            // remounts during config editing can initialize at a stale size.
            requestAnimationFrame(() => {
              try { inst.reflow(); } catch { /* chart destroyed before frame */ }
            });
          }}
        />
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

  const settingGroups: Array<{ heading: string; items: Array<{ key: keyof ChartDisplay; label: string }> }> = [
    {
      heading: 'Chart Control',
      items: [
        { key: 'legends',   label: 'Legends' },
        { key: 'dataLabel', label: 'Data Labels' },
        { key: 'clipping',  label: 'Clipping' },
        { key: 'zoom',      label: 'Zoom' },
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
    values.length ? aggregate(values, op).toFixed(prec) : '—';

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
