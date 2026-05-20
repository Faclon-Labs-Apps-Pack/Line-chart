import { useState, useMemo } from 'react';
import { Settings, Database } from 'react-feather';
import { LineChart as DSLineChart } from '@faclon-labs/design-sdk/LineChart';
import { DatePicker, SelectInput, DropdownMenu, ActionListItem } from '@faclon-labs/design-sdk';
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
}

const PERIODICITY_OPTIONS = [
  { label: 'Minute',  value: 'minute'  },
  { label: 'Hourly',  value: 'hourly'  },
  { label: 'Daily',   value: 'daily'   },
  { label: 'Weekly',  value: 'weekly'  },
  { label: 'Monthly', value: 'monthly' },
];

function computeRangeFromPreset(dur: GTPPreset): { start: Date; end: Date } {
  const now = new Date();
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

function mapPlotLines(plotLines: LineChartPlotLine[]) {
  return plotLines
    .filter((l) => l.type === 'Independent' && l.valueType === 'Fixed' && typeof l.fixedValue === 'number')
    .map((l) => ({
      value: l.fixedValue as number,
      color: l.color || '#3b82f6',
      width: l.lineWidth ?? 2,
      dashStyle: (l.lineStyle === 'Dashed' ? 'Dash' : 'Solid') as 'Solid' | 'Dash',
      label: l.name || undefined,
    }));
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
  data: DataEntry[],
): unknown[] {
  return anomalies.flatMap((anomaly, anomalyIdx) => {
    const targetIdx = resolvedSeries.findIndex((s) => s.id === anomaly.applyToSeriesId);
    const target = targetIdx >= 0 ? resolvedSeries[targetIdx] : undefined;
    if (!target || target.slots.length === 0) return [];

    // Build dual lookup for 'Existing' threshold series:
    //  - timestamp map for exact-match alignment (primary)
    //  - index array as fallback when from-timestamps differ between series
    const thresholdByTime = new Map<number, number | null>();
    const thresholdByIndex: (number | null)[] = [];
    if (anomaly.labelMode === 'Existing' && anomaly.existingSeriesId) {
      const src = resolvedSeries.find((s) => s.id === anomaly.existingSeriesId);
      src?.slots.forEach((sl, i) => {
        thresholdByTime.set(sl.from, sl.value);
        thresholdByIndex[i] = sl.value;
      });
    }

    // Pre-resolve scalar for 'NewSource' mode
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

    const pointData = target.slots.map((sl, i): number | null => {
      if (sl.value === null) return null;

      let threshold: number | null = null;
      if (anomaly.labelMode === 'Value') {
        threshold = anomaly.thresholdValue ?? null;
      } else if (anomaly.labelMode === 'Existing') {
        // Primary: exact timestamp match; fallback: same array index
        const byTime = thresholdByTime.get(sl.from);
        threshold = byTime !== undefined ? byTime : (thresholdByIndex[i] ?? null);
      } else if (anomaly.labelMode === 'NewSource') {
        threshold = newSourceValue;
      }

      if (threshold === null) return null;

      // Optional linear transform on threshold: threshold = m * threshold + c
      if (anomaly.advanceEnabled && anomaly.advanceM !== undefined) {
        threshold = (anomaly.advanceM ?? 1) * threshold + (anomaly.advanceC ?? 0);
      }

      return evalOperator(sl.value, anomaly.operator, threshold) ? sl.value : null;
    });

    if (pointData.every((p) => p === null)) return [];

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

export function LineChart({ config, data, onEvent, timeConfig }: LineChartProps) {
  const styling: LineChartStyling = (() => {
    const s = config?.style as unknown;
    if (s && typeof s === 'object' && 'card' in (s as object)) return s as LineChartStyling;
    return FALLBACK_STYLING;
  })();

  const activeChart = pickActiveChart(config);
  const chartIdx    = activeChartIndex(config);

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

  // No charts configured
  if (!activeChart || chartIdx < 0) {
    return (
      <div className="line-chart line-chart--card line-chart__empty">
        <Settings size={28} className="line-chart__empty-icon" />
        <p className="line-chart__empty-title BodyMediumSemibold">Widget not configured</p>
        <p className="line-chart__empty-subtitle BodySmallRegular">
          Add at least one data source to render this chart.
        </p>
      </div>
    );
  }

  // Loading skeleton — bindings exist but data hasn't arrived yet
  const hasBindings = activeChart.series.some((s) =>
    /^\{\{.+\}\}$/.test((s.dataSource ?? '').trim()),
  );
  if (hasBindings && data.length === 0) {
    return (
      <div className="line-chart line-chart--card line-chart--loading">
        <div className="line-chart__skeleton" />
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

  // No data for this time range
  if (categories.length === 0 && data.length > 0) {
    return (
      <div className="line-chart line-chart--card line-chart__empty">
        <Database size={28} className="line-chart__empty-icon" />
        <p className="line-chart__empty-title BodyMediumSemibold">No data available</p>
        <p className="line-chart__empty-subtitle BodySmallRegular">
          The configured topics have not returned data for this time window.
        </p>
      </div>
    );
  }

  const configPlotLines = mapPlotLines(activeChart.plotLines ?? []);
  const configPlotBands = mapPlotBands(activeChart.plotBands ?? []);

  const spcOverlays = computeSpcOverlays(activeChart.spcs ?? [], resolvedSeries);

  const plotLines = [...configPlotLines, ...spcOverlays.plotLines];
  const plotBands = [...configPlotBands, ...spcOverlays.plotBands];

  const anomalyScatterSeries = computeAnomalyOverlays(
    activeChart.anomalies ?? [],
    chartIdx,
    resolvedSeries,
    data,
  );

  // highchartsOptions.series array is deep-merged by index:
  // pad with {} for existing line series (neutral override), then append scatter series.
  const highchartsOptions =
    anomalyScatterSeries.length > 0
      ? {
          series: [
            ...seriesForChart.map(() => ({} as Record<string, never>)),
            ...anomalyScatterSeries,
          ],
        }
      : undefined;

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
          const preset = timeConfig.allDurations?.find((d) => d.id === id);
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

  return (
    <DSLineChart
      title={activeChart.title || undefined}
      categories={categories}
      series={seriesForChart}
      bare={!styling.card.wrapInCard}
      smooth
      showLegend
      yAxisTitle={activeChart.defaultAxis?.yAxisLabel || undefined}
      xAxisTitle={activeChart.defaultAxis?.xAxisLabel || undefined}
      plotLines={plotLines.length > 0 ? plotLines : undefined}
      plotBands={plotBands.length > 0 ? plotBands : undefined}
      highchartsOptions={highchartsOptions as never}
      filters={filtersSlot}
    />
  );
}
