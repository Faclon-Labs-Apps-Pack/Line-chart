import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Highcharts from 'highcharts';
import HC_Exporting from 'highcharts/modules/exporting';
import HC_ExportData from 'highcharts/modules/export-data';
import HC_FullScreen from 'highcharts/modules/full-screen';
import { LineChart as DSLineChart } from '@faclon-labs/design-sdk/LineChart';
import { Chart, ChartActions, exportChart } from '@faclon-labs/design-sdk/Chart';
import type { ChartPlotLine, ChartPlotBand, ChartExportFormat } from '@faclon-labs/design-sdk/Chart';
import { Spinner } from '@faclon-labs/design-sdk/Spinner';
import { EmptyState } from '@faclon-labs/design-sdk/EmptyState';
import { DatePicker } from '@faclon-labs/design-sdk/DatePicker';
import type { DateRange, DatePresetOption } from '@faclon-labs/design-sdk/DatePicker';
import { DropdownMenu } from '@faclon-labs/design-sdk/DropdownMenu';
import { ActionListItem } from '@faclon-labs/design-sdk/ActionListItem';
import { ChevronDown } from 'react-feather';
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
    }>;
    defaultPeriodicity?: string;
    startTime?: number | null;
    endTime?: number | null;
    fixedDuration?: { x?: number | string; xPeriod?: string } | null;
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
  // Mirror the Column Chart widget contract: emit a TIME_CHANGE event back
  // via `onEvent` so the host's data layer registers this widget for query
  // dispatch. Without at least one TIME_CHANGE the host never schedules a
  // `resolveAndCompute` for us.
  // The challenge: iosense passes a fresh `onEvent` function reference and
  // a fresh `timeConfig` object on every render (echoing computed
  // `startTime`/`endTime` back through the prop). Naive useEffect deps
  // either (a) loop infinitely or (b) skip the first emit if onEvent was
  // initially undefined. Solution: depend on all relevant inputs but DEDUPE
  // by a stable "user intent" key — only emit when the user's choice
  // (preset / periodicity / picker type) actually changed, not when iosense
  // echoes a new startTime back at us.
  const lastEmittedKeyRef = useRef<string>('');
  useEffect(() => {
    if (!onEvent) return;
    // Wait for the host to pass a real timeConfig before emitting.
    if (!timeConfig?.defaultDurationId && !timeConfig?.fixedDuration) return;
    const key = [
      timeConfig.defaultDurationId ?? '',
      timeConfig.defaultPeriodicity ?? '',
      timeConfig.pickerType ?? '',
    ].join('|');
    if (lastEmittedKeyRef.current === key) return;
    lastEmittedKeyRef.current = key;
    const { startTime, endTime } = computeRange(timeConfig);
    const periodicity = (timeConfig.defaultPeriodicity || 'hourly').toLowerCase();
    console.log('[LineChart] emit TIME_CHANGE →', { key, startTime, endTime, periodicity });
    onEvent({
      type: 'TIME_CHANGE',
      payload: {
        startTime: String(startTime),
        endTime: String(endTime),
        periodicity,
      },
    });
  }, [
    onEvent,
    timeConfig?.defaultDurationId,
    timeConfig?.defaultPeriodicity,
    timeConfig?.pickerType,
    timeConfig?.fixedDuration,
  ]);

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
  const { series, categories } = useMemo(() => {
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
      [] as { label: string; value: number | null }[],
    );
    const cats = longest.map((slot) => slot.label);
    const out = resolved.map((r, i) => ({
      name: r.def.name || `Series ${i + 1}`,
      color: r.def.color,
      data: cats.map((_, idx) => {
        const v = r.slots[idx]?.value;
        return typeof v === 'number' ? v : null;
      }),
    }));
    return { series: out, categories: cats };
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
    opts.series = series.map((_, i) => {
      const so: any = {};
      if (multiAxis) so.yAxis = multiAxis.seriesAxis[i] ?? 0;
      if (tooltipOnlyFlags[i]) {
        so.lineWidth = 0;
        so.marker = { enabled: false, states: { hover: { enabled: false } } };
        so.dataLabels = { enabled: false };
        so.showInLegend = false;
        so.states = { hover: { lineWidth: 0, halo: { size: 0 } }, inactive: { opacity: 1 } };
      }
      return so;
    });
    if (hasTooltipOnly) opts.tooltip = { shared: true };
    return opts as any;
  }, [axisColors, miscColors, multiAxis, series, tooltipOnlyFlags, hasTooltipOnly, style?.card?.wrapInCard, style?.card?.backgroundColor]);

  // The data table is portalled into the chart card (sibling of the canvas).
  const [cardEl, setCardEl] = useState<HTMLDivElement | null>(null);

  // Per-chart in-widget UI overrides: NOT written back to the envelope (these
  // are end-user view affordances, like flipping legend off temporarily).
  // Defaults: legend on, dataLabel off — matches Column Chart widget defaults.
  const [chartDisplay, setChartDisplay] = useState<{
    legends: boolean;
    dataLabel: boolean;
  }>({ legends: true, dataLabel: false });

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

  // Highcharts instance handle for the export menu and fullscreen toggle.
  const chartInstanceRef = useRef<
    { reflow: () => void; fdsToggleFullscreen?: () => void } | null
  >(null);

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

  // ZERO slots came back for every configured series — there's truly nothing
  // the chart can render (no time axis, no points). Show the empty state.
  // Note: we INTENTIONALLY do NOT hit this branch when slots exist but all
  // values are null (e.g. backend " N/A" sentinels for compute sources) —
  // those cases still render a time-axis with null gaps, which is more
  // useful than an empty state.
  if (!hasSlots) {
    return (
      <div className="lcw lcw--empty">
        <EmptyState
          title="No data in selected range"
          description="Try a different time window or check that the UNS source has values."
        />
      </div>
    );
  }

  // Publish the user-picked card background color as a CSS variable so the
  // SDK chart's legend strip (which sits inside .fds-chart but doesn't
  // inherit a background) can paint the SAME color via a static CSS rule.
  // `--lcw-card-bg` defaults to transparent when wrap-into-card is ON
  // (some external wrapper owns the surface).
  const widgetStyle = useMemo<React.CSSProperties>(() => {
    const bg =
      style?.card?.wrapInCard === true
        ? 'transparent'
        : style?.card?.backgroundColor || '#FFFFFF';
    // CSS custom property assignment requires `as` cast in React types.
    return { ['--lcw-card-bg' as string]: bg } as React.CSSProperties;
  }, [style?.card?.wrapInCard, style?.card?.backgroundColor]);

  return (
    <div className="lcw" style={widgetStyle}>
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
            onOpenChange={setDatePickerOpen}
            rangeValue={rangeValue}
            onRangeChange={(v) => {
              setRangeValue(v);
              if (!v || !onEvent) return;
              const startTime = new Date(v.start).getTime();
              const endTime = new Date(v.end).getTime();
              const periodicity = (timeConfig?.defaultPeriodicity || 'hourly').toLowerCase();
              // User-picked custom range — bypass the dedupe key so the host
              // refetches even if defaultDurationId hasn't changed.
              onEvent({
                type: 'TIME_CHANGE',
                payload: {
                  startTime: String(startTime),
                  endTime: String(endTime),
                  periodicity,
                },
              });
            }}
            showPresets={datePresets.length > 0}
            showPresetChip={datePresets.length > 0}
            presets={datePresets}
            selectedPreset={selectedPreset}
            onPresetSelect={(v: string) => {
              setSelectedPreset(v);
              // The preset picker fires onRangeChange synchronously with the
              // resolved range — no need to emit TIME_CHANGE here as well.
            }}
            placeholder="Select date range"
          />
        }
        // Info / Settings / Export icons — matches the deployed Column
        // Chart's chrome. Settings exposes legend + data-label toggles;
        // Export downloads PNG/JPEG/SVG/CSV/XLSX or toggles fullscreen.
        // Honors style.hideElements.{settingsIcon,exportIcon}.
        actions={
          activeChart.description?.trim() ||
          !style?.hideElements?.settingsIcon ||
          !style?.hideElements?.exportIcon ? (
            <ChartActionIcons
              description={activeChart.description}
              showSettings={!style?.hideElements?.settingsIcon}
              showMore={!style?.hideElements?.exportIcon}
              chartRef={chartInstanceRef}
              display={chartDisplay}
              onDisplayChange={setChartDisplay}
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
          plotLines={multiAxis ? [] : plotLines}
          plotBands={multiAxis ? [] : plotBands}
          // xAxisTitle hidden for now (not needed): xAxisTitle="Date"
          yAxisTitle={leftAxisTitle}
          highchartsOptions={highchartsOptions}
          // Capture the Highcharts instance handle so the export menu and
          // fullscreen toggle can target it.
          onChartReady={(inst: { reflow: () => void; fdsToggleFullscreen?: () => void }) => {
            chartInstanceRef.current = inst;
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
// `actions` slot. Mirrors the deployed Column Chart's chrome:
//   • Info icon (only when chart has a description) → hover tooltip
//   • Settings icon → DropdownMenu with legend / data-label toggles
//   • Export icon  → DropdownMenu with PNG/JPEG/SVG/CSV/XLSX + Full Screen
// Open state is controlled per-icon and dismisses on outside click / Esc.
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
  display: { legends: boolean; dataLabel: boolean };
  onDisplayChange: (next: { legends: boolean; dataLabel: boolean }) => void;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!settingsOpen && !moreOpen) return;
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setSettingsOpen(false);
        setMoreOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setSettingsOpen(false);
        setMoreOpen(false);
      }
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [settingsOpen, moreOpen]);

  const toggle = (key: 'legends' | 'dataLabel') =>
    onDisplayChange({ ...display, [key]: !display[key] });

  const doExport = (format: ChartExportFormat) => {
    const instance = chartRef.current;
    if (instance) {
      exportChart({ instance, engine: 'highcharts', format, fileName: 'line-chart' });
    }
    setMoreOpen(false);
  };
  const toggleFullscreen = () => {
    chartRef.current?.fdsToggleFullscreen?.();
    setMoreOpen(false);
  };

  const exportFormats: ChartExportFormat[] = ['PNG', 'JPEG', 'SVG', 'CSV', 'XLSX'];
  const hasDescription = !!description?.trim();

  return (
    <div className="lcw__chart-actions" ref={wrapRef}>
      <ChartActions
        showInfo={hasDescription}
        infoLabel={hasDescription ? description!.trim() : 'Info'}
        showSettings={showSettings}
        settingsLabel="Settings"
        onSettingsClick={() => {
          setSettingsOpen((o) => !o);
          setMoreOpen(false);
        }}
        showMore={showMore}
        moreLabel="Export"
        onMoreClick={() => {
          setMoreOpen((o) => !o);
          setSettingsOpen(false);
        }}
      />
      {settingsOpen && (
        <div className="lcw__action-menu">
          <DropdownMenu>
            <ActionListItem contentType="SectionHeading" title="Chart Control" />
            <ActionListItem
              title="Legends"
              selectionType="Multiple"
              isSelected={display.legends}
              onClick={() => toggle('legends')}
            />
            <ActionListItem
              title="Data Label"
              selectionType="Multiple"
              isSelected={display.dataLabel}
              onClick={() => toggle('dataLabel')}
            />
          </DropdownMenu>
        </div>
      )}
      {moreOpen && (
        <div className="lcw__action-menu">
          <DropdownMenu>
            {exportFormats.map((f) => (
              <ActionListItem
                key={f}
                title={`Download ${f}`}
                selectionType="None"
                onClick={() => doExport(f)}
              />
            ))}
            <ActionListItem title="Full Screen" selectionType="None" onClick={toggleFullscreen} />
          </DropdownMenu>
        </div>
      )}
    </div>
  );
}

// Silence unused-import warning when Fragment isn't used elsewhere in the file.
void Fragment;

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
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const label = activeChart?.title || 'Untitled Chart';
  return (
    <div className="fds-chart-switcher__title" ref={ref}>
      <button
        type="button"
        className="fds-chart__title"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="fds-chart__title-label HeadingSmallSemibold" style={titleStyle}>
          {label}
        </span>
        <ChevronDown className="fds-chart__title-icon" aria-hidden="true" />
      </button>
      {open && (
        <div className="fds-chart-switcher__menu">
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
