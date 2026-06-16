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
import { ShiftLegend } from '@faclon-labs/design-sdk';
import { Spinner } from '@faclon-labs/design-sdk/Spinner';
import { EmptyState } from '@faclon-labs/design-sdk/EmptyState';
import { DatePicker } from '@faclon-labs/design-sdk/DatePicker';
import type { DateRange, DatePresetOption } from '@faclon-labs/design-sdk/DatePicker';
import { DropdownMenu } from '@faclon-labs/design-sdk/DropdownMenu';
import { ActionListItem } from '@faclon-labs/design-sdk/ActionListItem';
import { SelectInput } from '@faclon-labs/design-sdk/SelectInput';
import { ChevronDown, Settings, MoreHorizontal, Info } from 'react-feather';
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
import type {
  LineChartUIConfig,
  DataEntry,
  ChartInstance,
  DataTableConfig,
  DataTableColumn,
  DataTableOperator,
  LineChartSeries,
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
    defaultDurationId?: string;
    allDurations?: Array<{
      id: string;
      x?: number;
      xPeriod?: string;
      calendarType?: string;
      periodicities?: string[];
    }>;
    defaultPeriodicity?: string;
    startTime?: number | null;
    endTime?: number | null;
    fixedDuration?: { x?: number | string; xPeriod?: string } | null;
    shifts?: Array<{ id: string; name: string; color: string; startTime: string; endTime: string }>;
  };
  onEvent?: (event: WidgetEvent) => void;
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

// Derive an approximate DateRange from a preset so periodicityOptions stays
// accurate as soon as a preset is selected (before the user clicks "Apply").
// Handles both x/xPeriod offsets and calendarType fixed-boundary presets.
function rangeFromPreset(preset: { x?: number; xPeriod?: string; calendarType?: string } | undefined): DateRange | null {
  if (!preset) return null;

  // Calendar-boundary presets (today, yesterday, current/previous week/month)
  if (preset.calendarType) {
    const now = new Date();
    const start = new Date(now);
    const end = new Date(now);
    switch (preset.calendarType) {
      case 'today':
        start.setHours(0, 0, 0, 0);
        break;
      case 'yesterday':
        start.setDate(start.getDate() - 1); start.setHours(0, 0, 0, 0);
        end.setDate(end.getDate() - 1);     end.setHours(23, 59, 59, 999);
        break;
      case 'current_week':
        start.setDate(start.getDate() - start.getDay()); start.setHours(0, 0, 0, 0);
        break;
      case 'previous_week': {
        const dow = now.getDay();
        start.setDate(now.getDate() - dow - 7); start.setHours(0, 0, 0, 0);
        end.setDate(now.getDate() - dow - 1);   end.setHours(23, 59, 59, 999);
        break;
      }
      case 'current_month':
        start.setDate(1); start.setHours(0, 0, 0, 0);
        break;
      case 'previous_month':
        start.setMonth(start.getMonth() - 1); start.setDate(1); start.setHours(0, 0, 0, 0);
        end.setDate(0); end.setHours(23, 59, 59, 999); // day 0 = last day of prev month
        break;
      default:
        return null;
    }
    return { start, end };
  }

  // Relative offset presets (x units of xPeriod before now)
  if (typeof preset.x !== 'number' || !preset.xPeriod) return null;
  const end = new Date();
  const start = new Date(end);
  const x = preset.x;
  switch (preset.xPeriod) {
    case 'minute': start.setMinutes(start.getMinutes() - x); break;
    case 'hour':   start.setHours(start.getHours() - x);     break;
    case 'day':    start.setDate(start.getDate() - x);        break;
    case 'week':   start.setDate(start.getDate() - x * 7);    break;
    case 'month':  start.setMonth(start.getMonth() - x);      break;
    case 'year':   start.setFullYear(start.getFullYear() - x); break;
    default: return null;
  }
  return { start, end };
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

type ChartDisplay = {
  timeDrilldown: boolean;
  legends: boolean;
  dataLabel: boolean;
  clipping: boolean;
  zoom: boolean;
  scrollBehavior: boolean;
  inexactMultiple: boolean;
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

// Compute startTime/endTime from a host-shape timeConfig. Mirrors the
// deployed Column Chart widget's `rn()` helper.
function computeRange(tc?: LineChartWidgetProps['timeConfig']): {
  startTime: number;
  endTime: number;
} {
  const now = Date.now();
  // If host pre-computed explicit timestamps, use them.
  if (tc?.startTime && tc?.endTime) {
    return { startTime: tc.startTime, endTime: tc.endTime };
  }
  // Otherwise, derive from the active preset (defaultDurationId → allDurations).
  const presetId = tc?.defaultDurationId;
  const preset = tc?.allDurations?.find((d) => d.id === presetId);
  const PERIOD_MS: Record<string, number> = {
    minute: 60_000,
    hour: 3_600_000,
    day: 86_400_000,
    week: 7 * 86_400_000,
    month: 30 * 86_400_000,
    year: 365 * 86_400_000,
  };
  if (preset?.x && preset.xPeriod && PERIOD_MS[preset.xPeriod]) {
    return { startTime: now - preset.x * PERIOD_MS[preset.xPeriod], endTime: now };
  }
  if (preset?.calendarType === 'today') {
    const s = new Date();
    s.setHours(0, 0, 0, 0);
    return { startTime: s.getTime(), endTime: now };
  }
  if (preset?.calendarType === 'yesterday') {
    const s = new Date();
    s.setDate(s.getDate() - 1);
    s.setHours(0, 0, 0, 0);
    const e = new Date(s);
    e.setHours(23, 59, 59, 999);
    return { startTime: s.getTime(), endTime: e.getTime() };
  }
  // Fixed-mode duration as last resort.
  const fd = tc?.fixedDuration;
  if (fd?.x && fd.xPeriod && PERIOD_MS[fd.xPeriod]) {
    return { startTime: now - Number(fd.x) * PERIOD_MS[fd.xPeriod], endTime: now };
  }
  // Final fallback: last 24h.
  return { startTime: now - 86_400_000, endTime: now };
}

export function LineChart({
  config: rawConfig,
  data = [],
  timeConfig,
  onEvent,
}: LineChartWidgetProps) {
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
    console.log('[LineChart] emit TIME_CHANGE (mount) →', { startTime, endTime, periodicity });
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
  // One-time diagnostic per render — tells us what shape the host actually
  // passes for `config` (envelope vs uiConfig) and `data` (wrapped vs raw),
  // plus per-series resolution status. Strip in a future pass if too chatty.
  console.log('[LineChart] props →', {
    configShape: rawConfig && typeof rawConfig === 'object' && 'uiConfig' in rawConfig ? 'envelope' : 'uiConfig',
    chartCount: config?.charts?.length ?? 0,
    activeChartId: config?.activeChartId ?? null,
    dataEntryCount: data.length,
    firstDataEntry: data[0]
      ? {
          key: (data[0] as { key?: string }).key,
          hasValue: (data[0] as { value?: unknown }).value !== undefined,
          hasSlots: Array.isArray((data[0] as unknown as { slots?: unknown }).slots),
          slotCount: Array.isArray((data[0] as unknown as { slots?: unknown[] }).slots)
            ? (data[0] as unknown as { slots: unknown[] }).slots.length
            : null,
        }
      : null,
  });
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

  // Render whenever the backend returned slots for any series — even if all
  // values are null / non-numeric (the backend can return string sentinels
  // like " N/A" for compute sources, which our slot-to-number map turns into
  // null). The X-axis with time labels still renders and the user can see
  // the range / confirm the source is wired. The empty state is only for
  // when ZERO slots came back.
  const hasSlots = series.some((s) => s.data.length > 0);

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

  // Plot lines (fixed values only — periodicity-dependent lines need the live
  // periodicity context which the host owns, so they're rendered server-side).
  const plotLines = useMemo<ChartPlotLine[]>(() => {
    const out: ChartPlotLine[] = [];
    for (const p of activeChart?.plotLines ?? []) {
      if (p.valueType !== 'Fixed') continue;
      const v = Number(p.fixedValue);
      if (!Number.isFinite(v)) continue;
      out.push({
        value: v,
        color: p.color,
        width: p.lineWidth,
        dashStyle: p.lineStyle === 'Dashed' ? 'Dash' : 'Solid',
        label: p.name,
      });
    }
    return out;
  }, [activeChart]);

  const plotBands = useMemo<ChartPlotBand[]>(
    () =>
      (activeChart?.plotBands ?? []).map((b) => ({
        from: b.startValue,
        to: b.endValue,
        color: b.color,
        label: b.name,
      })),
    [activeChart],
  );

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
    const leftAxis = {
      title: { text: leftAxisTitle },
      ...(plotLines.length
        ? { plotLines: plotLines.map((p) => ({ value: p.value, color: p.color, width: p.width, dashStyle: p.dashStyle, ...(p.label ? { label: { text: p.label } } : {}) })) }
        : {}),
      ...(plotBands.length
        ? { plotBands: plotBands.map((b) => ({ from: b.from, to: b.to, color: b.color, ...(b.label ? { label: { text: b.label } } : {}) })) }
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
    // Background Color and Border Color / Width apply only when "Wrap Into Card"
    // is OFF; turning the card ON drops the background and border (and zeros the
    // outer padding). Border Radius applies in both states.
    const base: React.CSSProperties = {
      borderRadius: typeof card.borderRadius === 'number' ? card.borderRadius : undefined,
    };
    if (card.wrapInCard === false) {
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
  // are end-user view affordances). Mirrors the combine line chart's Settings
  // menu: Time Control (timeDrilldown) + Chart Control (legends, dataLabel,
  // clipping, zoom, scrollBehavior, inexactMultiple).
  const [chartDisplay, setChartDisplay] = useState<ChartDisplay>({
    timeDrilldown: true,
    legends: true,
    dataLabel: false,
    clipping: false,
    zoom: true,
    scrollBehavior: false,
    inexactMultiple: false,
  });

  const highchartsOptions = useMemo(() => {
    const titleEllipsis = { textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
    const xAxis: any = {};
    xAxis.title = { style: { ...titleEllipsis, ...(axisColors.xTitle ? { color: axisColors.xTitle } : {}) } };
    if (axisColors.xLabel) xAxis.labels = { style: { color: axisColors.xLabel } };
    if (axisColors.xLine) xAxis.lineColor = axisColors.xLine;
    if (miscColors.grid) xAxis.gridLineColor = miscColors.grid;

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
        style?.card?.wrapInCard === false
          ? style?.card?.backgroundColor || '#FFFFFF'
          : 'transparent',
      ...(chartDisplay.zoom ? { zoomType: 'x' } : {}),
    };
    if (multiAxis) {
      opts.yAxis = multiAxis.yAxis.map((a: any) => ({
        ...a,
        title: {
          ...(a.title || {}),
          style: { ...((a.title && a.title.style) || {}), ...titleEllipsis, ...(axisColors.yTitle ? { color: axisColors.yTitle } : {}) },
        },
        ...(axisColors.yLabel ? { labels: { ...(a.labels || {}), style: { ...((a.labels && a.labels.style) || {}), color: axisColors.yLabel } } } : {}),
        ...(miscColors.grid ? { gridLineColor: miscColors.grid } : {}),
      }));
    } else {
      const yAxis: any = { title: { style: { ...titleEllipsis, ...(axisColors.yTitle ? { color: axisColors.yTitle } : {}) } } };
      if (axisColors.yLabel) yAxis.labels = { style: { color: axisColors.yLabel } };
      if (miscColors.grid) yAxis.gridLineColor = miscColors.grid;
      opts.yAxis = yAxis;
    }
    // "Add Source as Tooltip": no visible line / marker / data label and no
    // legend chip, but keep the series in the dataset (mouse-tracked) so the
    // shared tooltip reports its value when hovering other points.
    opts.series = series.map((s: any, i) => {
      const so: any = {};
      if (multiAxis) so.yAxis = multiAxis.seriesAxis[i] ?? 0;
      if (tooltipOnlyFlags[i]) {
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
    const TOOLTIP_FONT = "'Noto Sans Variable', 'Noto Sans', sans-serif";
    opts.tooltip = {
      shared: true,
      useHTML: true,
      formatter(this: any) {
        const root = typeof document !== 'undefined' ? document.documentElement : null;
        const cs = root ? getComputedStyle(root) : null;
        const primary = cs?.getPropertyValue('--text-gray-primary').trim() || '#192839';
        const secondary = cs?.getPropertyValue('--text-gray-secondary').trim() || '#40566d';
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
    return opts as any;
  }, [axisColors, miscColors, multiAxis, series, tooltipOnlyFlags, style?.card?.wrapInCard, style?.card?.backgroundColor, chartDisplay.zoom]);

  // The data table is portalled into the chart card (sibling of the canvas).
  const [cardEl, setCardEl] = useState<HTMLDivElement | null>(null);

  // Local DatePicker state — initialized from the host-passed timeConfig.
  // On user pick, we emit TIME_CHANGE through onEvent so the host's data
  // layer re-queries with the new range.
  const initialRange = useMemo<DateRange | null>(() => {
    const { startTime, endTime } = computeRange(timeConfig);
    return { start: new Date(startTime), end: new Date(endTime) };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeConfig?.defaultDurationId, timeConfig?.pickerType]);
  const [rangeValue, setRangeValue] = useState<DateRange | null>(initialRange);
  // Keep `rangeValue` in sync if the host pushes a new preset down.
  useEffect(() => {
    setRangeValue(initialRange);
  }, [initialRange]);
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const [selectedPreset, setSelectedPreset] = useState<string>(
    timeConfig?.defaultDurationId ?? '',
  );

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

  // Shift state — committed (shiftToggleOn) vs draft (draftShiftOn, in-picker only).
  // Draft is synced from committed on every open; committed is set on Apply.
  const cfgShifts = timeConfig?.shifts ?? [];
  const cfgShiftKey = cfgShifts.map((s) => s.id).join('|');
  const [shiftToggleOn, setShiftToggleOn] = useState(false);
  const [draftShiftOn, setDraftShiftOn] = useState(false);
  const [enabledShiftIds, setEnabledShiftIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    setShiftToggleOn(false);
    setDraftShiftOn(false);
    setEnabledShiftIds(new Set());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfgShiftKey]);

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
    const derived = rangeFromPreset(preset);
    if (derived) setRangeValue(derived);

    if (!presetInitialized.current) {
      presetInitialized.current = true;
      return; // initial mount — mount effect handles the first TIME_CHANGE
    }

    // Use derived range when possible; fall back to existing rangeValue so
    // onEvent always fires even for preset formats rangeFromPreset can't parse.
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
  }, [selectedPreset, allDurations]);

  const periodicityOptions = useMemo(() => {
    return getPresetPeriodicities(activePreset) ?? getValidPeriodicities(rangeValue);
  }, [activePreset, rangeValue]);

  // If the active selection isn't valid for the current range/preset, snap to first valid
  useEffect(() => {
    if (!periodicityOptions.length) return;
    if (periodicityOptions.includes(selectedPeriodicity)) return;
    setSelectedPeriodicity(periodicityOptions[0]);
  }, [periodicityOptions, selectedPeriodicity]);

  // Highcharts instance handle for the export menu and fullscreen toggle.
  const chartInstanceRef = useRef<
    { reflow: () => void; fdsToggleFullscreen?: () => void } | null
  >(null);

  // Root element ref for the ResizeObserver — triggers chart.reflow() when the
  // dashboard resizes or repositions this widget so Highcharts recalculates
  // tick positions and label layout rather than stretching the mount-time SVG.
  const lcwRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = lcwRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const chart = chartInstanceRef.current;
      if (!chart) return;
      try { chart.reflow(); } catch { /* chart destroyed mid-resize */ }
    });
    ro.observe(el);
    return () => ro.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Date presets surfaced in the DatePicker's preset rail. Derived from the
  // host-passed allDurations so what's offered here matches what was
  // configured in the configurator's Time tab.
  const datePresets = useMemo<DatePresetOption[]>(
    () =>
      (timeConfig?.allDurations ?? []).map((d) => ({
        value: d.id,
        label: (d as { label?: string }).label || d.id,
      })),
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
      style?.card?.wrapInCard === true
        ? 'transparent'
        : style?.card?.backgroundColor || '#FFFFFF';
    return { ['--lcw-card-bg' as string]: bg } as React.CSSProperties;
  }, [style?.card?.wrapInCard, style?.card?.backgroundColor]);

  // ----- Render states ------------------------------------------------------
  // No envelope / no charts configured at all — host hasn't pushed a config.
  if (!activeChart) {
    return (
      <div className="lcw lcw--empty">
        <EmptyState title="No widget to display" description="This chart has no configuration." />
      </div>
    );
  }

  // Chart exists but no data sources added — distinct from a loading state, so
  // we never show an indefinite spinner just because the user hasn't picked a
  // UNS topic yet.
  if (configuredSeriesCount === 0) {
    return (
      <div className="lcw lcw--empty">
        <EmptyState
          title="No data source configured"
          description="Add a data source to display the chart."
        />
      </div>
    );
  }

  // Data sources configured, host hasn't delivered resolved data yet — true
  // loading state (the host's engine call is in flight).
  if (data.length === 0) {
    return (
      <div className="lcw lcw--loading">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="lcw" style={widgetStyle} ref={lcwRef}>
      {miscColors.legend && (
        <style>{`.lcw [class*="legend-label"] { color: ${miscColors.legend} !important; }`}</style>
      )}
      {/* Suppress legend chips for "Add Source as Tooltip" series (SDK builds
          its HTML legend from the series prop). */}
      {tooltipOnlyNames.length > 0 && (
        <style>
          {tooltipOnlyNames
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
        // DatePicker in the filters slot — per-widget local time picker.
        // Hidden if the widget has no data sources (nothing to time-filter).
        filters={
          <DatePicker
            mode="range"
            isOpen={datePickerOpen}
            onOpenChange={(open) => {
              if (open) setDraftShiftOn(shiftToggleOn);
              setDatePickerOpen(open);
            }}
            rangeValue={rangeValue}
            onRangeChange={(v) => {
              setRangeValue(v);
              setShiftToggleOn(draftShiftOn);
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
            showShift={cfgShifts.length > 0}
            shiftEnabled={draftShiftOn}
            onShiftToggle={(on) => setDraftShiftOn(on)}
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
        }
        // Info / Settings / Export icons — matches the deployed Column
        // Chart's chrome. Settings exposes legend + data-label toggles;
        // Export downloads PNG/JPEG/SVG/CSV/XLSX or toggles fullscreen.
        // Honors style.hideElements.{settingsIcon,exportIcon}; icons are shown
        // by default when hideElements is absent or false (not explicitly true).
        actions={
          <ChartActionIcons
            description={activeChart.description}
            showSettings={style?.hideElements?.settingsIcon !== true}
            showMore={style?.hideElements?.exportIcon !== true}
            chartRef={chartInstanceRef}
            display={chartDisplay}
            onDisplayChange={setChartDisplay}
          />
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
          })}
          bare
          // null entries are valid Highcharts gaps; the SDK's LineSeries types
          // data as number[], so cast at the boundary.
          series={series as any}
          categories={categories}
          showLegend={chartDisplay.legends}
          showDataLabels={chartDisplay.dataLabel}
          showMarkers={false}
          smooth
          scrollable={chartDisplay.scrollBehavior}
          scrollableMinWidth={800}
          plotLines={multiAxis ? [] : plotLines}
          plotBands={multiAxis ? [] : plotBands}
          yAxisTitle={leftAxisTitle}
          highchartsOptions={highchartsOptions}
          onPointClick={(ctx) => {
            if (!chartDisplay.timeDrilldown || !onEvent) return;
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
          }}
        />
      </Chart>
      {shiftToggleOn && cfgShifts.length > 0 && (
        <ShiftLegend
          channel="shape"
          sources={(activeChart?.series ?? []).map((s, i) => ({
            index: i,
            name: s.name || `Series ${i + 1}`,
          }))}
          shifts={cfgShifts.map((s) => ({
            id: s.id,
            name: s.name,
            color: s.color,
            enabled: enabledShiftIds.has(s.id),
          }))}
          onToggleShift={(id) =>
            setEnabledShiftIds((prev) => {
              const next = new Set(prev);
              if (next.has(id)) next.delete(id); else next.add(id);
              return next;
            })
          }
        />
      )}
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
      heading: 'Time Control',
      items: [{ key: 'timeDrilldown', label: 'Time drilldown' }],
    },
    {
      heading: 'Chart Control',
      items: [
        { key: 'legends',         label: 'Legends' },
        { key: 'dataLabel',       label: 'Data Labels' },
        { key: 'clipping',        label: 'Clipping' },
        { key: 'zoom',            label: 'Zoom' },
        { key: 'scrollBehavior',  label: 'Scroll' },
        { key: 'inexactMultiple', label: 'Inexact Multiple' },
      ],
    },
  ];
  const exportFormats: ChartExportFormat[] = ['PNG', 'JPEG', 'SVG', 'CSV', 'XLSX'];
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
        <IconButton
          icon={<Info size={16} />}
          size="Medium"
          accessibilityLabel={description!.trim()}
        />
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
          icon={<MoreHorizontal size={16} />}
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
              {exportFormats.map((f) => (
                <ActionListItem key={f} title={`Download ${f}`} selectionType="None" onClick={() => doExport(f)} />
              ))}
              <ActionListItem title="Full Screen" selectionType="None" onClick={toggleFullscreen} />
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
      dataTable.columns.map((col) => {
        const baseLabel = columnLabel(col, seriesById);
        const unit =
          col.sourceMode === 'Existing' && col.seriesId
            ? seriesById.get(col.seriesId)?.limit
            : col.unit;
        const label = dataTable.showUnit && unit ? `${baseLabel} (${unit})` : baseLabel;

        // Only Existing columns map to a resolved series; AddNew columns have no
        // binding in dynamicBindingPathList, so they have no resolved values.
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
