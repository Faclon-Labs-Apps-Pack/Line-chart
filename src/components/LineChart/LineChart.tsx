import { useState, useRef, useEffect, CSSProperties } from 'react';
import {
  Settings,
  Database,
  Info,
  MoreVertical,
} from 'react-feather';
import Highcharts from 'highcharts';
import HighchartsReact from 'highcharts-react-official';
import {
  DataEntry,
  WidgetEvent,
  LineChartUIConfig,
  ChartInstance,
  LineChartAxis,
  LineChartPlotLine,
  LineChartPlotBand,
  LineChartSPC,
  LineChartAnomaly,
  LineChartSeries,
  SPCSigmaLevel,
  DataTableColumn,
  DataTableOperator,
  LineChartStyling,
  StylingFontWeight,
} from '../../iosense-sdk/types';
import './LineChart.css';

interface LineChartProps {
  config: LineChartUIConfig;
  data: DataEntry[];
  onEvent: (event: WidgetEvent) => void;
}

// Resolve the active chart instance, or fall back to the first chart, or null.
function pickActiveChart(config: LineChartUIConfig | undefined): ChartInstance | null {
  if (!config || !Array.isArray(config.charts) || config.charts.length === 0) return null;
  const found = config.activeChartId
    ? config.charts.find((c) => c._id === config.activeChartId)
    : undefined;
  return found ?? config.charts[0];
}

function activeChartIndex(config: LineChartUIConfig | undefined): number {
  if (!config || !Array.isArray(config.charts) || config.charts.length === 0) return -1;
  if (!config.activeChartId) return 0;
  const idx = config.charts.findIndex((c) => c._id === config.activeChartId);
  return idx >= 0 ? idx : 0;
}

// Find a series by its _id across all charts; returns the dot-path key the
// dynamic binding scanner produced (or null when not found).
function findSeriesPath(config: LineChartUIConfig | undefined, seriesId: string): string | null {
  if (!config || !Array.isArray(config.charts)) return null;
  for (let ci = 0; ci < config.charts.length; ci += 1) {
    const si = config.charts[ci].series.findIndex((s) => s._id === seriesId);
    if (si !== -1) return `charts[${ci}].series[${si}].dataSource`;
  }
  return null;
}

function findSeriesAcrossCharts(
  config: LineChartUIConfig | undefined,
  seriesId: string,
): LineChartSeries | null {
  if (!config || !Array.isArray(config.charts)) return null;
  for (const c of config.charts) {
    const s = c.series.find((x) => x._id === seriesId);
    if (s) return s;
  }
  return null;
}

// Read a bindable value: resolved data takes priority, config field is the fallback.
function getValue(key: string, config: unknown, data: DataEntry[]): unknown {
  const entry = data.find((d) => d.key === key);
  if (entry !== undefined) return entry.value;
  return getValueAtPath(config, key);
}

function getValueAtPath(obj: unknown, path: string): unknown {
  return path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .reduce((acc: unknown, k) => (acc as Record<string, unknown>)?.[k], obj);
}

// Strip {{}} wrapper for display fallback when no resolved data is present.
function unwrapBinding(value: unknown): string {
  if (typeof value !== 'string') return '';
  const match = /^\{\{(.+)\}\}$/.exec(value.trim());
  return match ? match[1] : value;
}

// Coerce a resolved value into a Highcharts time-series data array.
function toSeriesData(value: unknown): Array<[number, number | null]> {
  if (Array.isArray(value)) {
    return value.filter(
      (pt) => Array.isArray(pt) && pt.length >= 2 && typeof pt[0] === 'number',
    ) as Array<[number, number | null]>;
  }
  return [];
}

// Coerce a resolved value into a number, if possible.
function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

// --- SPC pure helpers ------------------------------------------------------
function computeMean(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) sum += values[i];
  return sum / values.length;
}

function computeMedian(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
  return sorted[mid];
}

function computeStdDev(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const mean = computeMean(values);
  if (mean === undefined) return undefined;
  let sq = 0;
  for (let i = 0; i < values.length; i += 1) {
    const d = values[i] - mean;
    sq += d * d;
  }
  return Math.sqrt(sq / values.length);
}

function sigmaLevelToNumber(level: SPCSigmaLevel): number {
  switch (level) {
    case '1Sigma':
      return 1;
    case '2Sigma':
      return 2;
    case '3Sigma':
      return 3;
    case '4Sigma':
      return 4;
    case '5Sigma':
      return 5;
    case '6Sigma':
      return 6;
    default:
      return 0;
  }
}

// Map StylingFontWeight → CSS font-weight numeric.
function fontWeightToCss(w: StylingFontWeight | undefined): number {
  switch (w) {
    case 'Regular':
      return 400;
    case 'Medium':
      return 500;
    case 'Semi-Bold':
      return 600;
    case 'Bold':
      return 700;
    default:
      return 400;
  }
}

// Extract numeric values from a resolved data-source array, optionally
// filtered by [startDate, endDate] (ISO strings).
function extractNumericValues(
  rows: Array<[number, number | null]>,
  startDate?: string,
  endDate?: string,
): number[] {
  let startMs: number | undefined;
  let endMs: number | undefined;
  if (startDate) {
    const t = Date.parse(startDate);
    if (Number.isFinite(t)) startMs = t;
  }
  if (endDate) {
    const t = Date.parse(endDate);
    if (Number.isFinite(t)) endMs = t;
  }
  const out: number[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const pt = rows[i];
    if (!Array.isArray(pt) || pt.length < 2) continue;
    const [ts, v] = pt;
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    if (startMs !== undefined && ts < startMs) continue;
    if (endMs !== undefined && ts > endMs) continue;
    out.push(v);
  }
  return out;
}

// Compute the inline style for the widget's outer card wrapper.
function cardWrapperStyle(styling: LineChartStyling): CSSProperties {
  if (!styling.card.wrapInCard) return {};
  return {
    backgroundColor: styling.card.backgroundColor,
    borderColor: styling.card.borderColor,
    borderWidth: `${styling.card.borderWidth}px`,
    borderStyle: 'solid',
    borderRadius: `${styling.card.borderRadius}px`,
  };
}

function NoConfigScreen({ styling }: { styling: LineChartStyling }) {
  const wrap = styling.card.wrapInCard;
  return (
    <div
      className={`line-chart${wrap ? ' line-chart--card' : ''} line-chart__empty`}
      style={cardWrapperStyle(styling)}
    >
      <Settings size={28} className="line-chart__empty-icon" />
      <p className="line-chart__empty-title BodyMediumSemibold">Widget not configured</p>
      <p className="line-chart__empty-subtitle BodySmallRegular">
        Add at least one data source in the settings panel to render this chart.
      </p>
    </div>
  );
}

function NoDataScreen({ styling }: { styling: LineChartStyling }) {
  const wrap = styling.card.wrapInCard;
  return (
    <div
      className={`line-chart${wrap ? ' line-chart--card' : ''} line-chart__empty`}
      style={cardWrapperStyle(styling)}
    >
      <Database size={28} className="line-chart__empty-icon" />
      <p className="line-chart__empty-title BodyMediumSemibold">No data available</p>
      <p className="line-chart__empty-subtitle BodySmallRegular">
        The configured topics have not returned any data for this time window.
      </p>
    </div>
  );
}

function ChartSkeleton({ styling }: { styling: LineChartStyling }) {
  const wrap = styling.card.wrapInCard;
  return (
    <div
      className={`line-chart${wrap ? ' line-chart--card' : ''} line-chart--loading`}
      style={cardWrapperStyle(styling)}
    >
      <div className="line-chart__skeleton" />
    </div>
  );
}

// Convert a plotline's style settings to Highcharts plotLine option.
function plotLineToHighcharts(
  line: LineChartPlotLine,
  config: LineChartUIConfig,
  data: DataEntry[],
  index: number,
  chartIdx: number,
): Highcharts.YAxisPlotLinesOptions | null {
  // Out of D1 scope — periodicity-dependent rendering.
  if (line.type === 'Dependent') return null;

  let value: number | undefined;
  if (line.valueType === 'Fixed') {
    if (typeof line.fixedValue === 'number' && Number.isFinite(line.fixedValue)) {
      value = line.fixedValue;
    }
  } else {
    // Dynamic — resolve via dynamicBindingPathList key.
    const resolved = getValue(
      `charts[${chartIdx}].plotLines[${index}].dynamicTopic`,
      config,
      data,
    );
    if (typeof resolved === 'number' && Number.isFinite(resolved)) {
      value = resolved;
    } else if (typeof resolved === 'string') {
      const num = Number(resolved);
      if (Number.isFinite(num)) value = num;
    }
  }

  if (value === undefined) return null;

  return {
    value,
    color: line.color || '#3b82f6',
    width: line.lineWidth ?? 1,
    dashStyle: line.lineStyle === 'Dashed' ? 'Dash' : 'Solid',
    zIndex: 5,
    label: { text: line.name || '' },
  };
}

function plotBandToHighcharts(band: LineChartPlotBand): Highcharts.YAxisPlotBandsOptions {
  return {
    from: band.startValue,
    to: band.endValue,
    color: band.color || 'rgba(245, 158, 11, 0.25)',
    label: { text: band.name || '' },
  };
}

// Build SPC plotLines bucketed by axis id ('' = default).
// SPCs always reference series within the same chart (the active one).
function buildSPCPlotLines(
  spcs: LineChartSPC[],
  config: LineChartUIConfig,
  data: DataEntry[],
  chartIdx: number,
  activeChart: ChartInstance,
): Map<string, Highcharts.YAxisPlotLinesOptions[]> {
  const buckets = new Map<string, Highcharts.YAxisPlotLinesOptions[]>();
  const series = activeChart.series;
  const axes = activeChart.axes;

  spcs.forEach((spc) => {
    // Legacy fallback: envelopes saved before multi-source had `dataSourceId: string`.
    const sourceIds = Array.isArray(spc.dataSourceIds)
      ? spc.dataSourceIds
      : (spc as unknown as { dataSourceId?: string }).dataSourceId
        ? [(spc as unknown as { dataSourceId: string }).dataSourceId]
        : [];

    sourceIds.forEach((sourceId) => {
      const seriesIndex = series.findIndex((s) => s._id === sourceId);
      if (seriesIndex < 0) return;

      const resolved = getValue(
        `charts[${chartIdx}].series[${seriesIndex}].dataSource`,
        config,
        data,
      );
      const rows = toSeriesData(resolved);
      if (rows.length === 0) return;

      const values = extractNumericValues(rows, spc.startDate, spc.endDate);
      if (values.length === 0) return;

      // Resolve target axis: SPC plots on the axis the series is linked to,
      // or default if none.
      let axisKey = '';
      for (let j = 0; j < axes.length; j += 1) {
        if (axes[j].linkedSeriesIds.includes(sourceId)) {
          axisKey = axes[j]._id;
          break;
        }
      }
      const list = buckets.get(axisKey) ?? [];

      const types = spc.processTypes ?? [];
      const seriesName = series[seriesIndex]?.name ?? '';
      const labelSuffix = sourceIds.length > 1 && seriesName ? ` (${seriesName})` : '';

      if (types.includes('Average') && spc.average && spc.average.enabled !== false) {
        const mean = computeMean(values);
        if (mean !== undefined) {
          list.push({
            value: mean,
            color: spc.average.lineColor || '#e4553d',
            width: spc.average.lineWidth ?? 1,
            dashStyle: 'Solid',
            zIndex: 4,
            label: { text: `${spc.average.plotName || 'Average'}${labelSuffix}` },
          });
        }
      }

      if (types.includes('Median') && spc.median && spc.median.enabled !== false) {
        const median = computeMedian(values);
        if (median !== undefined) {
          list.push({
            value: median,
            color: spc.median.lineColor || '#e4553d',
            width: spc.median.lineWidth ?? 1,
            dashStyle: 'Solid',
            zIndex: 4,
            label: { text: `${spc.median.plotName || 'Median'}${labelSuffix}` },
          });
        }
      }

      if (
        types.includes('StandardDeviation') &&
        spc.standardDeviation &&
        spc.standardDeviation.enabled !== false
      ) {
        const mean = computeMean(values);
        const sd = computeStdDev(values);
        if (mean !== undefined && sd !== undefined && sd > 0) {
          const sigmaLevels = spc.standardDeviation.sigmaLevels ?? [];
          const baseName = spc.standardDeviation.plotName || '';
          sigmaLevels.forEach((lvl) => {
            const n = sigmaLevelToNumber(lvl);
            if (n <= 0) return;
            const labelPos = `${baseName ? `${baseName} ` : ''}+${n}σ${labelSuffix}`;
            const labelNeg = `${baseName ? `${baseName} ` : ''}-${n}σ${labelSuffix}`;
            list.push({
              value: mean + n * sd,
              color: spc.standardDeviation?.lineColor || '#e4553d',
              width: spc.standardDeviation?.lineWidth ?? 1,
              dashStyle: 'Dash',
              zIndex: 4,
              label: { text: labelPos },
            });
            list.push({
              value: mean - n * sd,
              color: spc.standardDeviation?.lineColor || '#e4553d',
              width: spc.standardDeviation?.lineWidth ?? 1,
              dashStyle: 'Dash',
              zIndex: 4,
              label: { text: labelNeg },
            });
          });
        }
      }

      buckets.set(axisKey, list);
    });
  });

  return buckets;
}

// Evaluate operator: v <op> threshold.
function evalOperator(v: number, op: string, threshold: number): boolean {
  switch (op) {
    case '>':
      return v > threshold;
    case '<':
      return v < threshold;
    case '>=':
      return v >= threshold;
    case '<=':
      return v <= threshold;
    case '==':
      return v === threshold;
    case '!=':
      return v !== threshold;
    default:
      return false;
  }
}

// Build scatter overlay series for anomaly highlighting.
// Anomalies reference series within the same (active) chart.
function buildAnomalyOverlaySeries(
  anomalies: LineChartAnomaly[],
  config: LineChartUIConfig,
  data: DataEntry[],
  chartIdx: number,
  activeChart: ChartInstance,
): Highcharts.SeriesOptionsType[] {
  const series = activeChart.series;
  const out: Highcharts.SeriesOptionsType[] = [];

  anomalies.forEach((anom, anomIdx) => {
    const targetIdx = series.findIndex((s) => s._id === anom.applyToSeriesId);
    if (targetIdx < 0) return;

    const targetResolved = getValue(
      `charts[${chartIdx}].series[${targetIdx}].dataSource`,
      config,
      data,
    );
    const targetRows = toSeriesData(targetResolved);
    if (targetRows.length === 0) return;

    // Build a timestamp → threshold lookup based on labelMode.
    let constantThreshold: number | undefined;
    let perTsThreshold: Map<number, number> | undefined;

    if (anom.labelMode === 'Value') {
      if (typeof anom.thresholdValue === 'number' && Number.isFinite(anom.thresholdValue)) {
        constantThreshold = anom.thresholdValue;
      }
    } else if (anom.labelMode === 'Existing' && anom.existingSeriesId) {
      const exIdx = series.findIndex((s) => s._id === anom.existingSeriesId);
      if (exIdx >= 0) {
        const exResolved = getValue(
          `charts[${chartIdx}].series[${exIdx}].dataSource`,
          config,
          data,
        );
        if (Array.isArray(exResolved)) {
          const exRows = toSeriesData(exResolved);
          if (exRows.length > 0) {
            perTsThreshold = new Map<number, number>();
            for (let i = 0; i < exRows.length; i += 1) {
              const [ts, v] = exRows[i];
              if (typeof v === 'number' && Number.isFinite(v)) perTsThreshold.set(ts, v);
            }
          }
        } else {
          const num = toNumber(exResolved);
          if (num !== undefined) constantThreshold = num;
        }
      }
    } else if (anom.labelMode === 'NewSource') {
      const resolved = getValue(
        `charts[${chartIdx}].anomalies[${anomIdx}].newSourceTopic`,
        config,
        data,
      );
      if (Array.isArray(resolved)) {
        const rows = toSeriesData(resolved);
        if (rows.length > 0) {
          perTsThreshold = new Map<number, number>();
          for (let i = 0; i < rows.length; i += 1) {
            const [ts, v] = rows[i];
            if (typeof v === 'number' && Number.isFinite(v)) perTsThreshold.set(ts, v);
          }
        }
      } else {
        const num = toNumber(resolved);
        if (num !== undefined) constantThreshold = num;
      }
    }

    // No usable threshold — skip.
    if (constantThreshold === undefined && (!perTsThreshold || perTsThreshold.size === 0)) {
      return;
    }

    const anomalyPoints: Array<[number, number]> = [];
    for (let i = 0; i < targetRows.length; i += 1) {
      const [ts, rawV] = targetRows[i];
      if (typeof rawV !== 'number' || !Number.isFinite(rawV)) continue;

      // Resolve threshold for this timestamp.
      let threshold: number | undefined;
      if (constantThreshold !== undefined) {
        threshold = constantThreshold;
      } else if (perTsThreshold) {
        threshold = perTsThreshold.get(ts);
        if (threshold === undefined) continue; // no matching timestamp → skip
      }
      if (threshold === undefined) continue;

      // Apply optional linear transform to the data value before comparison.
      let v = rawV;
      if (anom.advanceEnabled) {
        const m =
          typeof anom.advanceM === 'number' && Number.isFinite(anom.advanceM) ? anom.advanceM : 1;
        const c =
          typeof anom.advanceC === 'number' && Number.isFinite(anom.advanceC) ? anom.advanceC : 0;
        v = m * rawV + c;
      }

      if (evalOperator(v, anom.operator, threshold)) {
        anomalyPoints.push([ts, rawV]);
      }
    }

    if (anomalyPoints.length === 0) return;

    out.push({
      type: 'scatter',
      name: anom.name || `Anomaly ${anomIdx + 1}`,
      color: anom.color || '#ef4444',
      data: anomalyPoints,
      marker: {
        enabled: true,
        radius: 5,
        fillColor: anom.color || '#ef4444',
        lineColor: anom.color || '#ef4444',
        lineWidth: 1,
        symbol: 'circle',
      },
      showInLegend: false,
      enableMouseTracking: true,
      zIndex: 6,
    } as Highcharts.SeriesOptionsType);
  });

  return out;
}

// Build Highcharts options from the config + resolved data.
function buildHighchartsOptions(
  config: LineChartUIConfig,
  data: DataEntry[],
  styling: LineChartStyling,
  activeChart: ChartInstance,
  chartIdx: number,
): Highcharts.Options {
  const series = activeChart.series;
  const axes: LineChartAxis[] = activeChart.axes;
  const plotLines: LineChartPlotLine[] = activeChart.plotLines;
  const plotBands: LineChartPlotBand[] = activeChart.plotBands;
  const spcs: LineChartSPC[] = activeChart.spcs;
  const anomalies: LineChartAnomaly[] = activeChart.anomalies;

  // Manual plotLines (D1) — all on default axis for now.
  const defaultPlotLines = plotLines
    .map((line, i) => plotLineToHighcharts(line, config, data, i, chartIdx))
    .filter((p): p is Highcharts.YAxisPlotLinesOptions => p !== null);

  // SPC plotLines bucketed by axis id ('' = default).
  const spcPlotLinesByAxis = buildSPCPlotLines(spcs, config, data, chartIdx, activeChart);

  // Bucket plot bands by target axis id ('' / undefined → default).
  const plotBandsByAxis = new Map<string, Highcharts.YAxisPlotBandsOptions[]>();
  plotBands.forEach((band) => {
    const key = band.axisId ?? '';
    const list = plotBandsByAxis.get(key) ?? [];
    list.push(plotBandToHighcharts(band));
    plotBandsByAxis.set(key, list);
  });

  // yAxis: default first, then each explicit axis in user order.
  const defaultSPCLines = spcPlotLinesByAxis.get('') ?? [];
  const yAxisLabelStyle = { color: styling.yAxisLabel.textColor };
  const defaultAxisOption: Highcharts.YAxisOptions = {
    id: 'default',
    title: { text: activeChart.defaultAxis?.yAxisLabel ?? '', style: yAxisLabelStyle },
    min: activeChart.defaultAxis?.yAxisMin ?? undefined,
    max: activeChart.defaultAxis?.yAxisMax ?? undefined,
    opposite: false,
    plotLines: [...defaultPlotLines, ...defaultSPCLines],
    plotBands: plotBandsByAxis.get('') ?? [],
    gridLineColor: styling.misc.gridLineColor,
    lineColor: styling.yAxisLabel.lineColor,
    labels: { style: yAxisLabelStyle },
  };

  const explicitAxisOptions: Highcharts.YAxisOptions[] = axes.map((axis) => ({
    id: axis._id,
    title: { text: axis.name, style: yAxisLabelStyle },
    opposite: axis.position === 'Right',
    plotLines: spcPlotLinesByAxis.get(axis._id) ?? [],
    plotBands: plotBandsByAxis.get(axis._id) ?? [],
    gridLineColor: styling.misc.gridLineColor,
    lineColor: styling.yAxisLabel.lineColor,
    labels: { style: yAxisLabelStyle },
  }));

  const yAxis = [defaultAxisOption, ...explicitAxisOptions];

  // Series → resolve data array and choose yAxis index.
  const resolvedSeries: Highcharts.SeriesOptionsType[] = series.map((s, i) => {
    const resolved = getValue(`charts[${chartIdx}].series[${i}].dataSource`, config, data);
    // Find first axis that links this series; fallback to default (index 0).
    let yAxisIndex = 0;
    for (let j = 0; j < axes.length; j += 1) {
      if (axes[j].linkedSeriesIds.includes(s._id)) {
        yAxisIndex = j + 1; // +1 because default axis occupies index 0
        break;
      }
    }
    return {
      type: 'spline' as const,
      name:
        typeof s.name === 'string'
          ? unwrapBinding(s.name) || `Series ${i + 1}`
          : `Series ${i + 1}`,
      color: s.color || '#3b82f6',
      data: toSeriesData(resolved),
      yAxis: yAxisIndex,
    } as Highcharts.SeriesOptionsType;
  });

  const anomalyOverlay = buildAnomalyOverlaySeries(
    anomalies,
    config,
    data,
    chartIdx,
    activeChart,
  );

  return {
    chart: {
      backgroundColor: 'transparent',
      type: 'spline',
      style: { fontFamily: 'inherit' },
    },
    title: { text: '' },
    xAxis: {
      type: 'datetime',
      title: {
        text: activeChart.defaultAxis?.xAxisLabel ?? '',
        style: { color: styling.xAxisLabel.textColor },
      },
      lineColor: styling.xAxisLabel.lineColor,
      labels: { style: { color: styling.xAxisLabel.textColor } },
    },
    yAxis,
    legend: {
      enabled: true,
      align: 'center',
      verticalAlign: 'bottom',
      itemStyle: { color: styling.misc.legendTextColor },
    },
    credits: { enabled: false },
    tooltip: { shared: true, xDateFormat: '%Y-%m-%d %H:%M' },
    plotOptions: {
      spline: {
        marker: { enabled: true, radius: 3 },
        lineWidth: 2,
      },
    },
    series: [...resolvedSeries, ...anomalyOverlay],
  };
}

// --- Data Table helpers ---------------------------------------------------
function aggregateValues(values: number[], op: DataTableOperator): number | undefined {
  if (values.length === 0) return undefined;
  switch (op) {
    case 'sum': {
      let s = 0;
      for (let i = 0; i < values.length; i += 1) s += values[i];
      return s;
    }
    case 'avg':
      return computeMean(values);
    case 'min': {
      let m = values[0];
      for (let i = 1; i < values.length; i += 1) if (values[i] < m) m = values[i];
      return m;
    }
    case 'max': {
      let m = values[0];
      for (let i = 1; i < values.length; i += 1) if (values[i] > m) m = values[i];
      return m;
    }
    case 'median':
      return computeMedian(values);
    case 'first':
      return values[0];
    case 'last':
      return values[values.length - 1];
    default:
      return undefined;
  }
}

// Compute a column's display label. seriesId may reference a series in any
// chart (data table is widget-level, charts are scoped).
function dataTableColumnLabel(
  column: DataTableColumn,
  config: LineChartUIConfig,
): string {
  if (column.label && column.label.trim().length > 0) return column.label;
  if (column.sourceMode === 'Existing' && column.seriesId) {
    const s = findSeriesAcrossCharts(config, column.seriesId);
    if (s) return unwrapBinding(s.name) || s._id;
  }
  if (column.sourceMode === 'AddNew' && column.topic) {
    const stripped = unwrapBinding(column.topic);
    const parts = stripped.split('/');
    return parts[parts.length - 1] || 'Data';
  }
  return 'Data';
}

// Resolve a column's numeric input array from props. seriesId references walk
// across all charts.
function resolveColumnValues(
  column: DataTableColumn,
  config: LineChartUIConfig,
  data: DataEntry[],
): number[] {
  if (column.sourceMode === 'Existing' && column.seriesId) {
    const path = findSeriesPath(config, column.seriesId);
    if (!path) return [];
    const resolved = getValue(path, config, data);
    const rows = toSeriesData(resolved);
    return extractNumericValues(rows);
  }
  if (column.sourceMode === 'AddNew') {
    // Column topic is keyed by dataTable.columns[i].topic in dynamicBindingPathList.
    const colIdx = (config?.dataTable?.columns ?? []).findIndex(
      (c) => c._id === column._id,
    );
    if (colIdx < 0) return [];
    const resolved = getValue(`dataTable.columns[${colIdx}].topic`, config, data);
    if (Array.isArray(resolved)) {
      const rows = toSeriesData(resolved);
      return extractNumericValues(rows);
    }
    const num = toNumber(resolved);
    return num !== undefined ? [num] : [];
  }
  return [];
}

function formatTableValue(n: number | undefined, precision: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '—';
  const p = typeof precision === 'number' && precision >= 0 ? Math.floor(precision) : 2;
  return n.toFixed(p);
}

// --- Header (info / settings / hamburger) ---------------------------------
interface ChartHeaderProps {
  title: string;
  description: string;
  styling: LineChartStyling;
  viewMode: 'chart' | 'table';
  onViewModeChange: (next: 'chart' | 'table') => void;
}

function ChartHeader({
  title,
  description,
  styling,
  viewMode,
  onViewModeChange,
}: ChartHeaderProps) {
  const [infoOpen, setInfoOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Close menu on outside click.
  useEffect(() => {
    if (!menuOpen) return;
    function onDocClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [menuOpen]);

  const titleStyle: CSSProperties = {
    color: styling.chartTitle.fontColor,
    fontSize: `${styling.chartTitle.fontSize}px`,
    fontWeight: fontWeightToCss(styling.chartTitle.fontWeight),
  };

  const showTitle = !styling.hideElements.chartTitle && (title || description);
  const showInfo = !!description;
  const showSettings = !styling.hideElements.settingsIcon;

  // If everything is hidden — render nothing
  if (!showTitle && !showInfo && !showSettings) return null;

  return (
    <div className="line-chart__header">
      <div className="line-chart__header-titlewrap">
        {!styling.hideElements.chartTitle && title && (
          <h3 className="line-chart__title" style={titleStyle}>
            {title}
          </h3>
        )}
      </div>
      <div className="line-chart__header-icons">
        {showInfo && (
          <div className="line-chart__header-info-wrap">
            <button
              type="button"
              className="line-chart__icon-btn"
              onClick={() => setInfoOpen((o) => !o)}
              aria-label="Show chart description"
            >
              <Info size={18} />
            </button>
            {infoOpen && (
              <div className="line-chart__info-popover BodySmallRegular" role="tooltip">
                {description}
              </div>
            )}
          </div>
        )}
        {showSettings && (
          <button
            type="button"
            className="line-chart__icon-btn"
            aria-label="Settings"
          >
            <Settings size={18} />
          </button>
        )}
        <div className="line-chart__header-menu-wrap" ref={menuRef}>
          <button
            type="button"
            className="line-chart__icon-btn"
            onClick={() => setMenuOpen((o) => !o)}
            aria-label="Open menu"
          >
            <MoreVertical size={18} />
          </button>
          {menuOpen && (
            <div className="line-chart__menu" role="menu">
              <button
                type="button"
                role="menuitem"
                className="line-chart__menu-item BodyMediumRegular"
                onClick={() => {
                  onViewModeChange(viewMode === 'chart' ? 'table' : 'chart');
                  setMenuOpen(false);
                }}
              >
                {viewMode === 'chart' ? 'Show Data Table' : 'Show Chart'}
              </button>
              <button
                type="button"
                role="menuitem"
                className="line-chart__menu-item BodyMediumRegular line-chart__menu-item--disabled"
                disabled
                aria-disabled="true"
              >
                Export as CSV
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface DataTableRendererProps {
  config: LineChartUIConfig;
  data: DataEntry[];
  styling: LineChartStyling;
}

function DataTableRenderer({ config, data, styling }: DataTableRendererProps) {
  const dt = config.dataTable;
  const columns = dt?.columns ?? [];

  // Compute one aggregated value per column.
  const cells = columns.map((column) => {
    const values = resolveColumnValues(column, config, data);
    const agg = aggregateValues(values, column.operator ?? 'avg');
    const headerLabel = dataTableColumnLabel(column, config);
    const headerText =
      column.showUnit && column.unit && column.unit.trim().length > 0
        ? `${headerLabel} (${column.unit})`
        : headerLabel;
    const valueText = formatTableValue(agg, column.dataPrecision);
    return { headerText, valueText };
  });

  if (columns.length === 0) {
    return (
      <div
        className={`line-chart${styling.card.wrapInCard ? ' line-chart--card' : ''} line-chart__empty`}
        style={cardWrapperStyle(styling)}
      >
        <Database size={28} className="line-chart__empty-icon" />
        <p className="line-chart__empty-title BodyMediumSemibold">No data table columns</p>
        <p className="line-chart__empty-subtitle BodySmallRegular">
          Add at least one data source in the Data Table section to render the table.
        </p>
      </div>
    );
  }

  const thStyle: CSSProperties = {
    background: styling.dataTable.headerBackgroundColor,
    color: styling.dataTable.headerTextColor,
    fontSize: `${styling.dataTable.headerTextSize}px`,
    fontWeight: fontWeightToCss(styling.dataTable.headerTextWeight),
  };
  const tdStyle: CSSProperties = {
    color: styling.dataTable.dataPointTextColor,
    fontSize: `${styling.dataTable.dataPointTextSize}px`,
    fontWeight: fontWeightToCss(styling.dataTable.dataPointTextWeight),
  };

  return (
    <div className="line-chart__table-wrap">
      {dt.transposeTable ? (
        <table className="line-chart__table">
          <tbody>
            {cells.map((cell, i) => (
              <tr key={i}>
                <th className="line-chart__table-head" style={thStyle}>
                  {cell.headerText}
                </th>
                <td className="line-chart__table-cell" style={tdStyle}>
                  {cell.valueText}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <table className="line-chart__table">
          <thead>
            <tr>
              {cells.map((cell, i) => (
                <th key={i} className="line-chart__table-head" style={thStyle}>
                  {cell.headerText}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              {cells.map((cell, i) => (
                <td key={i} className="line-chart__table-cell" style={tdStyle}>
                  {cell.valueText}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      )}
    </div>
  );
}

// Default styling fallback — when config has no styling (defensive).
const FALLBACK_STYLING: LineChartStyling = {
  size: { preset: 'Medium', customWidth: 880, customHeight: 400, lockAspectRatio: false },
  card: {
    wrapInCard: true,
    backgroundColor: '#FFFFFF',
    borderColor: '#FFFFFF',
    borderWidth: 1,
    borderRadius: 4,
  },
  hideElements: { settingsIcon: false, exportIcon: false, chartTitle: false },
  advancedEnabled: false,
  chartTitle: { fontSize: 20, fontColor: '#333333', fontWeight: 'Semi-Bold' },
  xAxisLabel: { textColor: '#666666', lineColor: '#333333' },
  yAxisLabel: { textColor: '#666666', lineColor: '#333333' },
  dataTable: {
    headerBackgroundColor: '#F9F9FC',
    headerTextColor: '#8996A3',
    headerTextSize: 16,
    headerTextWeight: 'Semi-Bold',
    dataPointTextSize: 18,
    dataPointTextWeight: 'Medium',
    dataPointTextColor: '#2F4256',
  },
  misc: { gridLineColor: '#CCCCCC', legendTextColor: '#666666' },
};

export function LineChart({ config, data, onEvent: _onEvent }: LineChartProps) {
  // Defensive — config.style may be undefined or Phase 0 shape on cold load.
  const styling: LineChartStyling = (() => {
    const s = config?.style as unknown;
    if (s && typeof s === 'object' && 'size' in (s as object) && 'advancedEnabled' in (s as object)) {
      return s as LineChartStyling;
    }
    return FALLBACK_STYLING;
  })();

  // Resolve the active chart instance (or null if none configured).
  const activeChart = pickActiveChart(config);
  const chartIdx = activeChartIndex(config);

  // View-mode toggle (chart vs table). dataTable.enabled is the initial value;
  // user can flip via the hamburger menu.
  const [viewMode, setViewMode] = useState<'chart' | 'table'>(
    config?.dataTable?.enabled ? 'table' : 'chart',
  );

  // Reset view mode when the configurator's dataTable.enabled flag changes.
  useEffect(() => {
    setViewMode(config?.dataTable?.enabled ? 'table' : 'chart');
  }, [config?.dataTable?.enabled]);

  const wrapInCard = styling.card.wrapInCard;

  // No charts configured → empty config screen (regardless of view-mode).
  if (!activeChart || chartIdx < 0) {
    return <NoConfigScreen styling={styling} />;
  }

  const series = activeChart.series;

  // Resolve display title — pulls bindable {{topic}} from data, else fallback.
  const rawTitle = getValue(`charts[${chartIdx}].title`, config, data);
  const titleText =
    typeof rawTitle === 'string' && rawTitle.length > 0
      ? unwrapBinding(rawTitle)
      : activeChart.title
      ? unwrapBinding(activeChart.title)
      : '';

  const description = activeChart.description ?? '';

  // No series in the active chart → empty config screen (chart view only).
  if (series.length === 0 && viewMode === 'chart') {
    return <NoConfigScreen styling={styling} />;
  }

  // Bindings exist but data hasn't arrived yet → loading skeleton (chart view).
  const hasSeriesBindings = series.some((s) =>
    /^\{\{.+\}\}$/.test((s.dataSource ?? '').trim()),
  );
  if (viewMode === 'chart' && hasSeriesBindings && data.length === 0) {
    return <ChartSkeleton styling={styling} />;
  }

  const options =
    viewMode === 'chart'
      ? buildHighchartsOptions(config, data, styling, activeChart, chartIdx)
      : null;

  // If every primary series resolved to empty data, show no-data state.
  if (options && viewMode === 'chart') {
    const seriesOpts = options.series ?? [];
    const primaryOpts = seriesOpts.filter(
      (s) => (s as { type?: string })?.type === 'spline',
    );
    const allEmpty =
      primaryOpts.length > 0 &&
      primaryOpts.every((s) => {
        const arr = (s as { data?: unknown[] }).data;
        return !Array.isArray(arr) || arr.length === 0;
      });
    if (allEmpty && data.length > 0) {
      return <NoDataScreen styling={styling} />;
    }
  }

  return (
    <div
      className={`line-chart${wrapInCard ? ' line-chart--card' : ''}`}
      style={cardWrapperStyle(styling)}
    >
      <ChartHeader
        title={titleText}
        description={description}
        styling={styling}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
      />
      {viewMode === 'chart' && options ? (
        <div className="line-chart__chart">
          <HighchartsReact
            highcharts={Highcharts}
            options={options}
            containerProps={{ style: { width: '100%', height: '100%' } }}
          />
        </div>
      ) : (
        <DataTableRenderer config={config} data={data} styling={styling} />
      )}
    </div>
  );
}
