import { useState, useMemo, useRef } from 'react';
import { Settings, AlertCircle, Info, Menu, ChevronDown } from 'react-feather';
import type Highcharts from 'highcharts';
import { LineChart as DSLineChart } from '@faclon-labs/design-sdk/LineChart';
import { exportChart } from '@faclon-labs/design-sdk/Chart';
import type { ChartPointClickContext } from '@faclon-labs/design-sdk/Chart';
import {
  DatePicker,
  SelectInput,
  DropdownMenu,
  ActionListItem,
  IconButton,
  Checkbox,
} from '@faclon-labs/design-sdk';
import { Popover, PopoverHeader, PopoverBody } from '@faclon-labs/design-sdk/Popover';
import { EmptyState } from '@faclon-labs/design-sdk/EmptyState';
import { Spinner } from '@faclon-labs/design-sdk/Spinner';
// SDK 0.6.1 only ships NoDataOneIllustration in dist; the other illustrations
// have package.json subpath entries but no JS bundle. Fall back to feather icons.
import { NoDataOneIllustration } from '@faclon-labs/design-sdk/EmptyState/illustrations/NoDataOneIllustration';
import {
  DataEntry,
  WidgetEvent,
  LineChartUIConfig,
  ChartInstance,
  LineChartStyling,
  LineChartPlotLine,
  LineChartPlotBand,
  LineChartSPC,
  LineChartAnomaly,
  AnomalyOperator,
  SPCSigmaLevel,
  SeriesSlot,
  TimeTabUIConfig,
  GTPPreset,
} from '../../iosense-sdk/types';
import { getSeriesData } from '../../iosense-sdk/mini-engine';
import './LineChart.css';

interface LineChartProps {
  config: LineChartUIConfig;
  data: DataEntry[];
  onEvent: (event: WidgetEvent) => void;
  timeConfig?: TimeTabUIConfig;
  /** Surfaced from the mini-engine (network, auth, invalid topic). When set, renders an error state. */
  error?: string;
}

const PERIODICITY_OPTIONS = [
  { label: 'Minute',  value: 'minute'  },
  { label: 'Hourly',  value: 'hourly'  },
  { label: 'Daily',   value: 'daily'   },
  { label: 'Weekly',  value: 'weekly'  },
  { label: 'Monthly', value: 'monthly' },
];

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function endOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

function computeRangeFromPreset(dur: GTPPreset): { start: Date; end: Date } {
  const now = new Date();

  // Calendar-based presets (today, yesterday, current/previous week|month).
  // Required because GTPPreset.xPeriod is undefined for these.
  if (dur.calendarType) {
    switch (dur.calendarType) {
      case 'today':
        return { start: startOfDay(now), end: now };
      case 'yesterday': {
        const y = new Date(now);
        y.setDate(y.getDate() - 1);
        return { start: startOfDay(y), end: endOfDay(y) };
      }
      case 'current_week': {
        // Week starts Sunday (getDay() === 0).
        const start = startOfDay(now);
        start.setDate(start.getDate() - now.getDay());
        return { start, end: now };
      }
      case 'previous_week': {
        const prevStart = startOfDay(now);
        prevStart.setDate(prevStart.getDate() - now.getDay() - 7);
        const prevEnd = new Date(prevStart);
        prevEnd.setDate(prevStart.getDate() + 6);
        return { start: prevStart, end: endOfDay(prevEnd) };
      }
      case 'current_month':
        return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: now };
      case 'previous_month': {
        const firstOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const lastOfPrevMonth = new Date(firstOfThisMonth.getTime() - 1);
        const firstOfPrevMonth = new Date(
          lastOfPrevMonth.getFullYear(),
          lastOfPrevMonth.getMonth(),
          1,
        );
        return { start: firstOfPrevMonth, end: endOfDay(lastOfPrevMonth) };
      }
    }
  }

  // Relative presets ({x} {xPeriod} ago → now).
  const x = dur.x ?? 1;
  let start = new Date(now);
  switch (dur.xPeriod) {
    case 'minute': start = new Date(now.getTime() - x * 60_000); break;
    case 'hour':   start = new Date(now.getTime() - x * 3_600_000); break;
    case 'day':    start = new Date(now.getTime() - x * 86_400_000); break;
    case 'week':   start = new Date(now.getTime() - x * 604_800_000); break;
    case 'month':  { const m = new Date(now); m.setMonth(m.getMonth() - x); start = m; break; }
    case 'year':   { const y = new Date(now); y.setFullYear(y.getFullYear() - x); start = y; break; }
  }
  return { start, end: now };
}

function pickActiveChart(config: LineChartUIConfig): ChartInstance | null {
  if (!config?.charts?.length) return null;
  const found = config.activeChartId
    ? config.charts.find((c) => c._id === config.activeChartId)
    : undefined;
  return found ?? config.charts[0];
}

function activeChartIndex(config: LineChartUIConfig): number {
  if (!config?.charts?.length) return -1;
  if (!config.activeChartId) return 0;
  const idx = config.charts.findIndex((c) => c._id === config.activeChartId);
  return idx >= 0 ? idx : 0;
}

const TOPIC_RE = /^\{\{.+\}\}$/;

function mapPlotLines(
  plotLines: LineChartPlotLine[],
  chartIdx: number,
  data: DataEntry[],
) {
  return plotLines.flatMap((l, plIdx) => {
    if (l.type !== 'Independent' || l.valueType !== 'Fixed' || !l.fixedValue) return [];

    let value: number | undefined;
    if (TOPIC_RE.test(l.fixedValue.trim())) {
      const key = `charts[${chartIdx}].plotLines[${plIdx}].fixedValue`;
      const entry = data.find((d) => d.key === key);
      const raw = entry?.value;
      value =
        typeof raw === 'number'
          ? raw
          : typeof raw === 'string' && raw !== ''
            ? Number(raw)
            : undefined;
    } else {
      const num = parseFloat(l.fixedValue);
      value = Number.isFinite(num) ? num : undefined;
    }

    if (value === undefined) return [];
    return [{
      value,
      color: l.color || '#3b82f6',
      width: l.lineWidth ?? 2,
      dashStyle: (l.lineStyle === 'Dashed' ? 'Dash' : 'Solid') as 'Solid' | 'Dash',
      label: l.name || undefined,
    }];
  });
}

function mapPlotBands(plotBands: LineChartPlotBand[]) {
  return plotBands.map((b) => ({
    from: b.startValue,
    to: b.endValue,
    color: b.color || 'rgba(245,158,11,0.15)',
    label: b.name || undefined,
  }));
}

// ---------------------------------------------------------------------------
// SPC computation
// ---------------------------------------------------------------------------

const SIGMA_N: Record<SPCSigmaLevel, number> = {
  '1Sigma': 1, '2Sigma': 2, '3Sigma': 3,
  '4Sigma': 4, '5Sigma': 5, '6Sigma': 6,
};

const SIGMA_ALPHA: Record<SPCSigmaLevel, number> = {
  '1Sigma': 0.15, '2Sigma': 0.10, '3Sigma': 0.08,
  '4Sigma': 0.06, '5Sigma': 0.04, '6Sigma': 0.03,
};

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace('#', '');
  if (clean.length !== 6) return `rgba(228,85,61,${alpha})`;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

type SdkPlotLine = { value: number; color: string; width: number; dashStyle: 'Solid' | 'Dash'; label?: string };
type SdkPlotBand = { from: number; to: number; color: string; label?: string };

function computeSpcOverlays(
  spcs: LineChartSPC[],
  resolvedSeries: Array<{ id: string; slots: SeriesSlot[] }>,
): { plotLines: SdkPlotLine[]; plotBands: SdkPlotBand[] } {
  const plotLines: SdkPlotLine[] = [];
  const plotBands: SdkPlotBand[] = [];

  for (const spc of spcs) {
    const values: number[] = [];
    for (const id of spc.dataSourceIds) {
      const rs = resolvedSeries.find((s) => s.id === id);
      if (!rs) continue;
      let slots = rs.slots;
      if (spc.startDate) {
        const t = new Date(spc.startDate).getTime();
        slots = slots.filter((sl) => sl.from >= t);
      }
      if (spc.endDate) {
        const t = new Date(spc.endDate).getTime();
        slots = slots.filter((sl) => sl.to <= t);
      }
      for (const sl of slots) {
        if (sl.value !== null) values.push(sl.value);
      }
    }

    if (values.length === 0) continue;

    const mean = values.reduce((a, b) => a + b, 0) / values.length;

    if (spc.processTypes.includes('Average') && spc.average?.enabled) {
      plotLines.push({
        value: mean,
        color: spc.average.lineColor || '#3b82f6',
        width: spc.average.lineWidth || 2,
        dashStyle: 'Solid',
        label: spc.average.plotName || 'Average',
      });
    }

    if (spc.processTypes.includes('Median') && spc.median?.enabled) {
      const sorted = [...values].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const median =
        sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
      plotLines.push({
        value: median,
        color: spc.median.lineColor || '#10b981',
        width: spc.median.lineWidth || 2,
        dashStyle: 'Solid',
        label: spc.median.plotName || 'Median',
      });
    }

    if (spc.processTypes.includes('StandardDeviation') && spc.standardDeviation?.enabled) {
      const sdConfig = spc.standardDeviation;
      const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
      const sd = Math.sqrt(variance);
      const baseColor = sdConfig.lineColor || '#e4553d';

      // Draw a mean reference only when Average line isn't already present
      if (!spc.processTypes.includes('Average')) {
        plotLines.push({
          value: mean,
          color: baseColor,
          width: sdConfig.lineWidth || 1,
          dashStyle: 'Dash',
          label: sdConfig.plotName || 'Mean',
        });
      }

      // Add bands largest-first so smaller ones render on top
      const sortedLevels = [...(sdConfig.sigmaLevels ?? [])].sort(
        (a, b) => SIGMA_N[b] - SIGMA_N[a],
      );

      for (const level of sortedLevels) {
        const n = SIGMA_N[level];
        const upper = mean + n * sd;
        const lower = mean - n * sd;

        plotBands.push({
          from: lower,
          to: upper,
          color: hexToRgba(baseColor, SIGMA_ALPHA[level]),
          label: `±${n}σ`,
        });
        plotLines.push({
          value: upper,
          color: baseColor,
          width: 1,
          dashStyle: 'Dash',
          label: `+${n}σ`,
        });
        plotLines.push({
          value: lower,
          color: baseColor,
          width: 1,
          dashStyle: 'Dash',
          label: `-${n}σ`,
        });
      }
    }
  }

  return { plotLines, plotBands };
}

// ---------------------------------------------------------------------------
// Anomaly highlighting computation
// ---------------------------------------------------------------------------

function evalOperator(value: number, op: AnomalyOperator, threshold: number): boolean {
  switch (op) {
    case '>':  return value > threshold;
    case '<':  return value < threshold;
    case '>=': return value >= threshold;
    case '<=': return value <= threshold;
    case '==': return value === threshold;
    case '!=': return value !== threshold;
  }
}

function computeAnomalyOverlays(
  anomalies: LineChartAnomaly[],
  chartIdx: number,
  resolvedSeries: Array<{ id: string; slots: SeriesSlot[] }>,
  /** Chart x-axis spine — these are the slot timestamps the chart actually plots
   *  against. Anomaly pointData must align 1:1 with this list, NOT the target
   *  series's own slot array (which may differ in length or ordering). */
  categorySlots: SeriesSlot[],
  data: DataEntry[],
): unknown[] {
  if (categorySlots.length === 0) return [];

  return anomalies.flatMap((anomaly, anomalyIdx) => {
    const target = resolvedSeries.find((s) => s.id === anomaly.applyToSeriesId);
    if (!target || target.slots.length === 0) return [];

    // Build a target-slot lookup keyed by `from` so we can resolve "target value
    // at this category timestamp" in O(1). Highcharts renders by index into the
    // chart's category array, so the anomaly series must be indexed the same.
    const targetByTime = new Map<number, SeriesSlot>();
    target.slots.forEach((sl) => { targetByTime.set(sl.from, sl); });

    // Build threshold lookup for 'Existing' mode — also keyed by `from`.
    const thresholdByTime = new Map<number, number | null>();
    if (anomaly.labelMode === 'Existing' && anomaly.existingSeriesId) {
      const src = resolvedSeries.find((s) => s.id === anomaly.existingSeriesId);
      src?.slots.forEach((sl) => { thresholdByTime.set(sl.from, sl.value); });
    }

    // Pre-resolve scalar for 'NewSource' mode — single scalar threshold for all points.
    let newSourceValue: number | null = null;
    if (anomaly.labelMode === 'NewSource' && anomaly.newSourceTopic) {
      const key = `charts[${chartIdx}].anomalies[${anomalyIdx}].newSourceTopic`;
      const entry = data.find((d) => d.key === key);
      const raw = entry?.value;
      newSourceValue =
        typeof raw === 'number'
          ? raw
          : typeof raw === 'string' && raw !== ''
            ? Number(raw)
            : null;
    }

    // pointData is built BY CATEGORY (i.e., the chart's x-axis spine).
    // For each category timestamp, we look up the target value at that exact
    // timestamp; if none exists or the threshold doesn't match, the slot is null
    // so no marker is rendered at that x position.
    const pointData = categorySlots.map((catSlot): number | null => {
      const targetSlot = targetByTime.get(catSlot.from);
      if (!targetSlot || targetSlot.value === null) return null;

      let threshold: number | null = null;
      if (anomaly.labelMode === 'Value') {
        threshold = anomaly.thresholdValue ?? null;
      } else if (anomaly.labelMode === 'Existing') {
        const t = thresholdByTime.get(catSlot.from);
        threshold = t !== undefined ? t : null;
      } else if (anomaly.labelMode === 'NewSource') {
        threshold = newSourceValue;
      }

      if (threshold === null) return null;

      // Optional linear transform on threshold: threshold = m * threshold + c
      if (anomaly.advanceEnabled && anomaly.advanceM !== undefined) {
        threshold = (anomaly.advanceM ?? 1) * threshold + (anomaly.advanceC ?? 0);
      }

      return evalOperator(targetSlot.value, anomaly.operator, threshold) ? targetSlot.value : null;
    });

    if (pointData.every((p) => p === null)) return [];

    // Debug — verify anomaly markers carry the EXACT slot.value at each
    // category timestamp. Open the browser console: for every non-null
    // anomaly point you should see the same y-value the main line plots.
    if (typeof window !== 'undefined') {
      const sample = categorySlots
        .map((cs, i) => ({
          catFrom: cs.from,
          catLabel: cs.label,
          lineValue: targetByTime.get(cs.from)?.value ?? null,
          anomalyValue: pointData[i],
        }))
        .filter((row) => row.anomalyValue !== null);
      console.log(
        `[LineChart] anomaly "${anomaly.name}" markers (${sample.length}):`,
        sample,
      );
    }

    // Use type:'line' with lineWidth:0 instead of type:'scatter'.
    // Scatter series in Highcharts are designed for continuous x-axes and do
    // not align reliably on a category x-axis. A zero-width line series shows
    // only the markers at non-null positions and works correctly on category axes.
    return [
      {
        type: 'line',
        lineWidth: 0,
        name: anomaly.name,
        color: anomaly.color,
        data: pointData,
        showInLegend: true,
        zIndex: 5,
        connectNulls: false,
        marker: { enabled: true, radius: 7, symbol: 'circle' },
        states: { hover: { lineWidth: 0 } },
        tooltip: {
          pointFormat: `<span style="color:{point.color}">●</span> ${anomaly.name}: <b>{point.y}</b><br/>`,
        },
      },
    ];
  });
}

const FALLBACK_STYLING: LineChartStyling = {
  size: { preset: 'Medium', customWidth: 880, customHeight: 400, lockAspectRatio: false },
  card: { wrapInCard: true, backgroundColor: '#FFFFFF', borderColor: '#FFFFFF', borderWidth: 1, borderRadius: 4 },
  hideElements: { settingsIcon: false, exportIcon: false, chartTitle: false },
  advancedEnabled: false,
  chartTitle: { fontSize: 20, fontColor: '#333333', fontWeight: 'Semi-Bold' },
  xAxisLabel: { textColor: '#666666', lineColor: '#333333' },
  yAxisLabel: { textColor: '#666666', lineColor: '#333333' },
  dataTable: {
    headerBackgroundColor: '#F9F9FC', headerTextColor: '#8996A3', headerTextSize: 16,
    headerTextWeight: 'Semi-Bold', dataPointTextSize: 18, dataPointTextWeight: 'Medium',
    dataPointTextColor: '#2F4256',
  },
  misc: { gridLineColor: '#CCCCCC', legendTextColor: '#666666' },
};

export function LineChart({ config, data, onEvent, timeConfig, error }: LineChartProps) {
  // Highcharts instance — captured via onChartReady so the export action can
  // serialize the chart to PNG/JPEG/SVG/CSV/XLSX via SDK's exportChart helper.
  const chartInstanceRef = useRef<Highcharts.Chart | null>(null);
  // Chart-level runtime view settings — exposed via the Settings popover, modeled
  // after the SDK reference (Time Control + Chart Control groups). Local state:
  // resets on remount, doesn't pollute the envelope. Each maps to a real
  // <LineChart> prop from the design-sdk.
  const [chartSettings, setChartSettings] = useState({
    timeDrilldown: false,     // → onPointClick handler
    showLegend: true,         // → showLegend
    showMarkers: false,       // → showMarkers
    showDataLabels: false,    // → showDataLabels
    scrollable: false,        // → scrollable
    zoomable: true,           // → zoomable
  });
  function updateSetting<K extends keyof typeof chartSettings>(
    key: K,
    value: (typeof chartSettings)[K],
  ) {
    setChartSettings((s) => ({ ...s, [key]: value }));
  }
  // Local active-chart override — lets the user switch between charts at runtime
  // via the title dropdown without round-tripping through the configurator.
  const [activeChartOverride, setActiveChartOverride] = useState<string | null>(null);
  const [titleDropdownOpen, setTitleDropdownOpen] = useState(false);
  const styling: LineChartStyling = (() => {
    const s = config?.style as unknown;
    if (s && typeof s === 'object' && 'card' in (s as object)) return s as LineChartStyling;
    return FALLBACK_STYLING;
  })();

  // Apply the local override (set via the title dropdown when multi-chart) to
  // both lookups, falling back to envelope-driven activeChartId.
  const effectiveConfig =
    activeChartOverride && config?.charts?.some((c) => c._id === activeChartOverride)
      ? { ...config, activeChartId: activeChartOverride }
      : config;
  const activeChart = pickActiveChart(effectiveConfig);
  const chartIdx    = activeChartIndex(effectiveConfig);

  // Time picker state
  const presetOptions = useMemo(
    () => (timeConfig?.allDurations ?? []).map((d) => ({ label: d.label ?? d.id, value: d.id })),
    [timeConfig],
  );
  const [rangeValue, setRangeValue] = useState<{ start: Date; end: Date } | null>(() => {
    const def = timeConfig?.allDurations?.find((d) => d.id === timeConfig?.defaultDurationId);
    return def ? computeRangeFromPreset(def) : null;
  });
  const [selectedPreset,  setSelectedPreset]  = useState(timeConfig?.defaultDurationId ?? '');
  const [periodicity,     setPeriodicity]     = useState(timeConfig?.defaultPeriodicity ?? 'hourly');
  const [periodicityOpen, setPeriodicityOpen] = useState(false);

  function emitTimeChange(range: { start: Date; end: Date }, p: string) {
    onEvent({
      type: 'TIME_CHANGE',
      payload: {
        startTime:   String(range.start.getTime()),
        endTime:     String(range.end.getTime()),
        periodicity: p,
      },
    });
  }

  // Filters row — defined here (before any early return) so empty/error/loading
  // states can render the time + periodicity controls and the user can recover
  // by adjusting them without leaving the widget.
  const filtersSlot = timeConfig ? (
    <div className="line-chart__datetime-row">
      <DatePicker
        mode="range"
        rangeValue={rangeValue}
        onRangeChange={(range) => {
          if (!range) return;
          setRangeValue(range);
          setSelectedPreset('');
          emitTimeChange(range, periodicity);
        }}
        presets={presetOptions}
        selectedPreset={selectedPreset}
        onPresetSelect={(id) => {
          setSelectedPreset(id);
          const preset = timeConfig?.allDurations?.find((d) => d.id === id);
          if (preset) {
            const range = computeRangeFromPreset(preset);
            setRangeValue(range);
            emitTimeChange(range, periodicity);
          }
        }}
        showPeriodicity
        periodicitySlot={
          <SelectInput
            label=""
            value={PERIODICITY_OPTIONS.find((o) => o.value === periodicity)?.label ?? periodicity}
            isOpen={periodicityOpen}
            onOpenChange={setPeriodicityOpen}
            onClick={() => setPeriodicityOpen((o) => !o)}
          >
            <DropdownMenu>
              {PERIODICITY_OPTIONS.map((o) => (
                <ActionListItem
                  key={o.value}
                  title={o.label}
                  selectionType="Single"
                  isSelected={o.value === periodicity}
                  onClick={() => {
                    setPeriodicity(o.value as typeof periodicity);
                    setPeriodicityOpen(false);
                    if (rangeValue) emitTimeChange(rangeValue, o.value);
                  }}
                />
              ))}
            </DropdownMenu>
          </SelectInput>
        }
      />
    </div>
  ) : undefined;

  function renderStateCard(
    illustration: React.ReactNode,
    title: string,
    description: string,
  ) {
    return (
      <div className="line-chart line-chart--card">
        {filtersSlot}
        <div className="line-chart__state-body">
          <EmptyState
            illustration={illustration}
            title={title}
            description={description}
            size="Medium"
          />
        </div>
      </div>
    );
  }

  // No charts configured — no filters needed (no chart yet to filter).
  if (!activeChart || chartIdx < 0) {
    return (
      <div className="line-chart line-chart--card line-chart__empty">
        <EmptyState
          illustration={<Settings size={48} />}
          title="Widget not configured"
          description="Add at least one data source to render this chart."
          size="Medium"
        />
      </div>
    );
  }

  const hasBindings = activeChart.series.some((s) =>
    /^\{\{.+\}\}$/.test((s.dataSource ?? '').trim()),
  );

  // Error state — surfaced from mini-engine (network, auth, invalid topic).
  // Shows BEFORE the loading skeleton so failures don't appear as infinite loading.
  if (error) {
    return renderStateCard(<AlertCircle size={48} />, "Couldn't load data", error);
  }

  // Loading state — bindings exist but data hasn't arrived yet.
  if (hasBindings && data.length === 0) {
    return (
      <div className="line-chart line-chart--card">
        {filtersSlot}
        <div className="line-chart__state-body">
          <Spinner size="Large" color="Brand" label="Loading data…" labelPosition="Bottom" />
        </div>
      </div>
    );
  }

  // Build series + categories from resolved slot data
  const resolvedSeries = activeChart.series.map((s, i) => {
    const payload = getSeriesData(`charts[${chartIdx}].series[${i}].dataSource`, data);
    return {
      id:    s._id,
      name:  s.name || `Series ${i + 1}`,
      color: s.color || undefined,
      slots: payload?.slots ?? [],
    };
  });

  const firstWithSlots = resolvedSeries.find((s) => s.slots.length > 0);
  const categories = firstWithSlots ? firstWithSlots.slots.map((sl) => sl.label) : [];
  const seriesForChart = resolvedSeries.map((s) => ({
    name:  s.name,
    color: s.color,
    data:  s.slots.length > 0
      ? s.slots.map((sl) => sl.value ?? 0)
      : categories.map(() => 0),
  }));

  // No data for this time range — filters stay visible so user can adjust.
  if (categories.length === 0 && data.length > 0) {
    return renderStateCard(
      <NoDataOneIllustration />,
      'No data available',
      'The configured topics have not returned data for this time window.',
    );
  }

  const configPlotLines = mapPlotLines(activeChart.plotLines ?? [], chartIdx, data);
  const configPlotBands = mapPlotBands(activeChart.plotBands ?? []);

  const spcOverlays = computeSpcOverlays(activeChart.spcs ?? [], resolvedSeries);

  const plotLines = [...configPlotLines, ...spcOverlays.plotLines];
  const plotBands = [...configPlotBands, ...spcOverlays.plotBands];

  // categorySlots = the chart's x-axis spine (same slots as `categories` was
  // derived from). Anomaly markers must index against this array, not the
  // anomaly target series's own slots, to align with the rendered x-axis.
  const categorySlots = firstWithSlots ? firstWithSlots.slots : [];
  const anomalyScatterSeries = computeAnomalyOverlays(
    activeChart.anomalies ?? [],
    chartIdx,
    resolvedSeries,
    categorySlots,
    data,
  );

  // Multi-axis: build Highcharts yAxis array from axis config.
  // Each axis maps to an index; series reference their axis by that index.
  const axisList = activeChart.axes ?? [];
  const hasCustomAxes = axisList.length > 0;

  const yAxisHighcharts = hasCustomAxes
    ? axisList.map((axis) => ({
        title: { text: axis.name || undefined },
        opposite: axis.position === 'Right',
      }))
    : undefined;

  // Map each resolved series to its configured axis index (default 0 if unlinked).
  // Primary: match by axis.dataSource === series.dataSource topic.
  // Fallback: legacy linkedSeriesIds match.
  const seriesYAxisIndices = hasCustomAxes
    ? resolvedSeries.map((s, i) => {
        const seriesConfig = activeChart.series[i];
        let axisIdx = axisList.findIndex(
          (a) => a.dataSource && seriesConfig?.dataSource && a.dataSource === seriesConfig.dataSource,
        );
        if (axisIdx < 0) {
          axisIdx = axisList.findIndex((a) => a.linkedSeriesIds?.includes(s.id));
        }
        return axisIdx >= 0 ? axisIdx : 0;
      })
    : null;

  // highchartsOptions.series is deep-merged by index:
  // pad with axis assignment (or {}) for existing series, then append anomaly series.
  const highchartsOptions =
    anomalyScatterSeries.length > 0 || hasCustomAxes
      ? {
          ...(yAxisHighcharts ? { yAxis: yAxisHighcharts } : {}),
          series: [
            ...seriesForChart.map((_, i) =>
              seriesYAxisIndices !== null
                ? { yAxis: seriesYAxisIndices[i] }
                : ({} as Record<string, never>),
            ),
            ...anomalyScatterSeries,
          ],
        }
      : undefined;

  // Duration label — rendered below the title via SDK's `duration` slot (with
  // clock icon). Format: "Duration: <preset|date range> · <periodicity>".
  const periodicityLabel =
    PERIODICITY_OPTIONS.find((o) => o.value === periodicity)?.label ?? periodicity;
  const durationLabel: string | undefined = (() => {
    const presetName = selectedPreset
      ? timeConfig?.allDurations?.find((d) => d.id === selectedPreset)?.label
      : null;
    if (presetName) return `Duration: ${presetName} · ${periodicityLabel}`;
    if (rangeValue) {
      const fmt = (d: Date) => d.toLocaleDateString();
      return `Duration: ${fmt(rangeValue.start)} – ${fmt(rangeValue.end)} · ${periodicityLabel}`;
    }
    return undefined;
  })();

  // Y-axis unit — first source: default axis's yAxisLabel suffix; fallback: nothing.
  const yAxisUnit = activeChart.defaultAxis?.yAxisLabel?.match(/\(([^)]+)\)\s*$/)?.[1];

  // Time drilldown — when enabled, clicking a point bumps periodicity one
  // level finer and re-centers the time window on the clicked slot.
  function drillDown(p: string): string | null {
    switch (p.toLowerCase()) {
      case 'monthly': return 'weekly';
      case 'weekly':  return 'daily';
      case 'daily':   return 'hourly';
      case 'hourly':  return 'minute';
      default:        return null;
    }
  }
  function handlePointClick(ctx: ChartPointClickContext) {
    if (!chartSettings.timeDrilldown) return;
    const slot = resolvedSeries[ctx.seriesIndex]?.slots[ctx.pointIndex];
    if (!slot) return;
    const next = drillDown(periodicity);
    if (!next) return;
    const start = new Date(slot.from);
    const end = new Date(slot.to);
    setRangeValue({ start, end });
    setSelectedPreset('');
    setPeriodicity(next as typeof periodicity);
    emitTimeChange({ start, end }, next);
  }

  // Header actions — respect uiConfig.style.hideElements toggles.
  const showInfo = !styling.hideElements.chartTitle && !!activeChart.description;
  const showSettings = !styling.hideElements.settingsIcon;
  const showExport = !styling.hideElements.exportIcon;

  function doExport(format: 'PNG' | 'JPEG' | 'SVG' | 'CSV' | 'XLSX') {
    if (!chartInstanceRef.current) return;
    exportChart({
      instance: chartInstanceRef.current,
      engine: 'highcharts',
      format,
      fileName: activeChart?.title || 'chart',
    });
  }

  // Actions slot — three IconButtons matching SDK ChartActions's exact composition
  // (Info / Settings / Menu icons, size 16px). Each wrapped in a Popover so panels
  // anchor to the icons — ChartActions itself doesn't expose refs.
  const actionsSlot = (showInfo || showSettings || showExport) ? (
    <div className="line-chart__actions">
      {showInfo && (
        <Popover
          placement="Bottom End"
          trigger={
            <IconButton
              icon={<Info size={16} />}
              size="Medium"
              accessibilityLabel="Info"
            />
          }
        >
          <PopoverHeader title={activeChart.title || 'Chart info'} showClose />
          <PopoverBody description={activeChart.description || 'No description provided.'} />
        </Popover>
      )}
      {showSettings && (
        <Popover
          placement="Bottom End"
          trigger={
            <IconButton
              icon={<Settings size={16} />}
              size="Medium"
              accessibilityLabel="Settings"
            />
          }
        >
          <PopoverBody>
            <div className="line-chart__settings-panel">
              <div className="line-chart__settings-group">
                <p className="line-chart__settings-group-title LabelSmallSemibold">Time Control</p>
                <Checkbox
                  label="Time drilldown"
                  isChecked={chartSettings.timeDrilldown}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    updateSetting('timeDrilldown', e.target.checked)
                  }
                />
              </div>
              <div className="line-chart__settings-group">
                <p className="line-chart__settings-group-title LabelSmallSemibold">Chart Control</p>
                <Checkbox
                  label="Legends"
                  isChecked={chartSettings.showLegend}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    updateSetting('showLegend', e.target.checked)
                  }
                />
                <Checkbox
                  label="Markers"
                  isChecked={chartSettings.showMarkers}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    updateSetting('showMarkers', e.target.checked)
                  }
                />
                <Checkbox
                  label="Data Label"
                  isChecked={chartSettings.showDataLabels}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    updateSetting('showDataLabels', e.target.checked)
                  }
                />
                <Checkbox
                  label="Scroll Behavior"
                  isChecked={chartSettings.scrollable}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    updateSetting('scrollable', e.target.checked)
                  }
                />
                <Checkbox
                  label="Zoom"
                  isChecked={chartSettings.zoomable}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    updateSetting('zoomable', e.target.checked)
                  }
                />
              </div>
            </div>
          </PopoverBody>
        </Popover>
      )}
      {showExport && (
        <Popover
          placement="Bottom End"
          trigger={
            <IconButton
              icon={<Menu size={16} />}
              size="Medium"
              accessibilityLabel="More"
            />
          }
        >
          <PopoverBody>
            <DropdownMenu>
              {(['PNG', 'JPEG', 'SVG', 'CSV', 'XLSX'] as const).map((fmt) => (
                <ActionListItem
                  key={fmt}
                  title={`Export as ${fmt}`}
                  onClick={() => doExport(fmt)}
                />
              ))}
            </DropdownMenu>
          </PopoverBody>
        </Popover>
      )}
    </div>
  ) : undefined;

  // Title — when multiple charts exist, render as a clickable dropdown trigger
  // (SDK pattern: titleHasDropdown + onTitleClick). The chart switch is a local
  // override so the user can preview different charts without leaving the renderer.
  const hasMultipleCharts = (config?.charts?.length ?? 0) > 1;
  const titleNode: React.ReactNode = styling.hideElements.chartTitle
    ? undefined
    : hasMultipleCharts ? (
        <Popover
          placement="Bottom Start"
          isOpen={titleDropdownOpen}
          onOpenChange={setTitleDropdownOpen}
          trigger={
            <button type="button" className="line-chart__title-trigger">
              <span className="HeadingSmallSemibold">{activeChart.title || 'Untitled chart'}</span>
              <ChevronDown size={16} />
            </button>
          }
        >
          <PopoverBody>
            <DropdownMenu>
              {config?.charts?.map((c) => (
                <ActionListItem
                  key={c._id}
                  title={c.title || 'Untitled chart'}
                  selectionType="Single"
                  isSelected={c._id === activeChart._id}
                  onClick={() => {
                    setActiveChartOverride(c._id);
                    setTitleDropdownOpen(false);
                  }}
                />
              ))}
            </DropdownMenu>
          </PopoverBody>
        </Popover>
      ) : (activeChart.title || undefined);

  return (
    <DSLineChart
      title={titleNode}
      duration={durationLabel}
      categories={categories}
      series={seriesForChart}
      bare={!styling.card.wrapInCard}
      smooth
      showLegend={chartSettings.showLegend}
      showMarkers={chartSettings.showMarkers}
      showDataLabels={chartSettings.showDataLabels}
      scrollable={chartSettings.scrollable}
      zoomable={chartSettings.zoomable}
      yAxisTitle={hasCustomAxes ? undefined : (activeChart.defaultAxis?.yAxisLabel || undefined)}
      xAxisTitle={activeChart.defaultAxis?.xAxisLabel || undefined}
      yAxisUnit={yAxisUnit}
      plotLines={plotLines.length > 0 ? plotLines : undefined}
      plotBands={plotBands.length > 0 ? plotBands : undefined}
      highchartsOptions={highchartsOptions as never}
      filters={filtersSlot}
      actions={actionsSlot}
      onPointClick={chartSettings.timeDrilldown ? handlePointClick : undefined}
      onChartReady={(instance) => { chartInstanceRef.current = instance; }}
    />
  );
}
