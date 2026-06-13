export interface UNSNode {
  id: string;
  type: string;
  name?: string;
  path: string | null;
  parentId: string | null;
}

export interface SeriesSlot {
  from: number;
  to: number;
  label: string;
  value: number | null;
  quality: string;
  isPartial?: boolean;
}

export interface SeriesAggregation {
  operator: string;
  downscale: number;
  resolution: string;
}

export interface SeriesMeta {
  type: string;
  key: string;
  unit: string | null;
  dataPrecision: number | null;
  aggregation: SeriesAggregation;
  devID: string;
  sensor: string;
}

export interface SeriesPayload {
  __type: 'series';
  path: string;
  meta: SeriesMeta;
  range: { from: number; to: number };
  slots: SeriesSlot[];
}

export interface ScalarBinding { key: string; topic: string; }
export interface SeriesBinding  {
  key: string;
  topic: string;
  type: 'series';
  /** Per-binding aggregation override. When set, backend buckets the series at this resolution. */
  aggregation?: SeriesAggregation;
}
export type BindingEntry = ScalarBinding | SeriesBinding;

export interface DataEntry {
  key: string;
  value: string | number | null | SeriesPayload;
}

export interface Duration {
  id: string;
  label?: string;
  x?: number;
  xPeriod: string; // "minute" | "hour" | "day" | "week" | "month" | "year"
}

export interface TimeConfig {
  timezone: string;
  type: 'local' | 'fixed' | string;
  startTime: number | null;
  endTime: number | null;
  defaultDurationId: string;
  allDurations: Duration[];
  defaultPeriodicity: 'minute' | 'hourly' | 'daily' | 'weekly' | 'monthly';
}

export type WidgetEvent =
  | { type: 'TIME_CHANGE'; payload: { startTime: string; endTime: string; periodicity: string } }
  | { type: 'FILTER_CHANGE'; payload: Record<string, unknown> };

// ---------------------------------------------------------------------------
// WidgetTemplate — replace with your widget's config shape after init-widget.sh
// ---------------------------------------------------------------------------

export interface WidgetTemplateUIConfig {
  style: {
    card: { wrapInCard: boolean; bg: string };
  };
}

export interface WidgetTemplateEnvelope {
  _id: string;
  type: 'WidgetTemplate';
  general: { title: string };
  timeConfig?: TimeConfig;
  uiConfig: WidgetTemplateUIConfig;
  dynamicBindingPathList: Array<BindingEntry>;
}

// ---------------------------------------------------------------------------
// LineChart — widget-specific types
// ---------------------------------------------------------------------------

export interface LineChartSeries {
  _id: string;
  name: string;
  color: string;
  // Bindable: stores {{uns:wsId://path}}. Field name MUST be `unsPath` —
  // iosense's host engine reads binding keys whose path ends in `.unsPath`
  // and treats them as series sources (same convention the deployed Column
  // Chart widget uses). `dataSource` is kept as a legacy read-side field for
  // existing envelopes saved before the rename; configurator/widget never
  // emit it anymore.
  unsPath: string;
  /** @deprecated Use `unsPath`. Legacy field kept for envelope migration only. */
  dataSource?: string;
  downsampling?: string;
  downsamplingUnit?: string;
  dataPrecision?: number;
  limit?: string;
  advanceParameters?: boolean;
  m?: string;
  s?: string;
  addAsTooltip?: boolean;
  // Per-series deviation indicator override — when set, takes precedence over
  // uiConfig.deviationIndicator for this series' tooltip. Undefined = inherit.
  deviationIndicator?: DeviationIndicatorMode;
}

export interface LineChartDefaultAxis {
  yAxisLabel: string;
  yAxisMin?: number | null;
  yAxisMax?: number | null;
  xAxisLabel?: string;
}

export interface LineChartAxis {
  _id: string;
  name: string;
  position: 'Left' | 'Right';
  // See LineChartSeries.unsPath for the rename rationale.
  unsPath: string;
  /** @deprecated Use `unsPath`. Legacy field for envelope migration. */
  dataSource?: string;
  linkedSeriesIds: string[];  // legacy fallback for renderer; kept for backward compat
}

export type PlotLineType = 'Independent' | 'Dependent';
export type PlotLineValueType = 'Fixed' | 'Dynamic';
export type PlotLineStyle = 'Solid' | 'Dashed';

export interface PlotLinePeriodicityEntry {
  periodicity: string;
  value: number;
}

export interface LineChartPlotLine {
  _id: string;
  name: string;
  color: string;
  type: PlotLineType;
  valueType: PlotLineValueType;
  fixedValue?: string;
  dynamicTopic?: string;
  downsampling?: string;
  downsamplingUnit?: string;
  dataPrecision?: number;
  unit?: string;
  periodicities?: PlotLinePeriodicityEntry[];
  durationType?: string;
  startDate?: string;
  endDate?: string;
  lineWidth: number;
  lineStyle: PlotLineStyle;
}

export interface LineChartPlotBand {
  _id: string;
  name: string;
  color: string;
  startValue: number;
  endValue: number;
  axisId?: string;
}

export type SPCProcessType = 'Average' | 'Median' | 'StandardDeviation';
export type SPCSigmaLevel = '1Sigma' | '2Sigma' | '3Sigma' | '4Sigma' | '5Sigma' | '6Sigma';

interface SPCLine {
  enabled: boolean;
  plotName: string;
  lineWidth: number;
  lineColor: string;
}

export interface LineChartSPC {
  _id: string;
  dataSourceIds: string[];
  startDate?: string;
  endDate?: string;
  processTypes: SPCProcessType[];
  average?: SPCLine;
  median?: SPCLine;
  standardDeviation?: SPCLine & { sigmaLevels: SPCSigmaLevel[] };
}

export type AnomalyOperator = '>' | '<' | '>=' | '<=' | '==' | '!=';
export type AnomalyLabelMode = 'Value' | 'Existing' | 'NewSource';

export interface LineChartAnomaly {
  _id: string;
  name: string;
  color: string;
  applyToSeriesId: string;
  operator: AnomalyOperator;
  labelMode: AnomalyLabelMode;
  thresholdValue?: number;
  existingSeriesId?: string;
  newSourceTopic?: string;
  advanceEnabled?: boolean;
  advanceM?: number;
  advanceC?: number;
}

export interface ChartInstance {
  _id: string;
  title: string;
  description?: string;
  // 'Aggregated' (default) uses periodicity-based bucketing; 'Realtime' removes
  // all periodicity controls (preview picker, Time tab, periodicity plotlines).
  chartType?: 'Aggregated' | 'Realtime';
  series: LineChartSeries[];
  defaultAxis: LineChartDefaultAxis;
  axes: LineChartAxis[];
  plotLines: LineChartPlotLine[];
  plotBands: LineChartPlotBand[];
  spcs: LineChartSPC[];
  anomalies: LineChartAnomaly[];
  // Per-chart data table config (each chart has its own; the preview/widget show
  // a data table only for the chart that configured one).
  dataTable: DataTableConfig;
}

export type StylingFontWeight = 'Regular' | 'Medium' | 'Semi-Bold' | 'Bold';
export type StylingWidgetSize = 'Small' | 'Medium' | 'Large' | 'Custom';

export interface LineChartStyling {
  size: { preset: StylingWidgetSize; customWidth?: number; customHeight?: number; lockAspectRatio?: boolean };
  card: { wrapInCard: boolean; backgroundColor: string; borderColor: string; borderWidth: number; borderRadius: number };
  hideElements: { settingsIcon: boolean; exportIcon: boolean; chartTitle: boolean };
  advancedEnabled: boolean;
  chartTitle: { fontSize: number; fontColor: string; fontWeight: StylingFontWeight };
  xAxisLabel: { textColor: string; lineColor: string; dataPointColor: string };
  yAxisLabel: { textColor: string; lineColor: string; dataPointColor: string };
  dataTable: {
    headerBackgroundColor: string; headerTextColor: string; headerTextSize: number;
    headerTextWeight: StylingFontWeight; dataPointTextSize: number;
    dataPointTextWeight: StylingFontWeight; dataPointTextColor: string;
  };
  misc: { gridLineColor: string; legendTextColor: string };
}

export type DataTableSourceMode = 'Existing' | 'AddNew';
export type DataTableOperator = 'sum' | 'avg' | 'min' | 'max' | 'median' | 'first' | 'last';

export interface DataTableColumn {
  _id: string;
  sourceMode: DataTableSourceMode;
  // Existing
  seriesId?: string;
  // AddNew
  name?: string;            // user-defined column name (required in AddNew mode)
  topic?: string;           // UNS binding: stores {{uns:wsId://path}}
  downsampling?: string;
  downsamplingUnit?: string;
  dataPrecision: number;
  unit?: string;
}

export interface DataTableConfig {
  enabled: boolean;
  columns: DataTableColumn[];
  transposeTable: boolean;
  /** Aggregation operators — one aggregated row/column is shown per operator. */
  operators: DataTableOperator[];
  /** @deprecated legacy single-operator field; read via `operators`. */
  operator?: DataTableOperator;
  showUnit: boolean;
}

export type DeviationIndicatorMode = 'standard' | 'inverse';

export interface LineChartUIConfig {
  charts: ChartInstance[];
  activeChartId: string | null;
  dataTable: DataTableConfig;
  style: LineChartStyling;
  // Tooltip deviation indicator behavior — only used when timeConfig.comparisonMode is true.
  // 'standard': green up = positive, red down = negative
  // 'inverse':  red up = positive, green down = negative (for "lower is better" metrics)
  deviationIndicator?: DeviationIndicatorMode;
  // UI disclosure: when true, advanced time fields (Disable Time Selection,
  // Future Days Allowed) are revealed. Default false. Auto-resolves to true on
  // load if any underlying advanced field already has a non-default value.
  advanceSettings?: boolean;
}

// GTP/TimeTab types — re-exported from the design-sdk's public TimeTabConfiguration
// subpath so local copies don't drift from the source of truth.
import type {
  TimeTabUIConfig,
  GTPPreset,
  GTPShift,
  GTPCycleTimeConfig,
} from '@faclon-labs/design-sdk/TimeTabConfiguration';
export type {
  TimeTabUIConfig,
  GTPPreset,
  GTPShift,
  GTPCycleTimeConfig,
};

// Not publicly re-exported by the SDK index — mirrored from the SDK's internal
// types (see node_modules/@faclon-labs/design-sdk/.../TimeTabConfiguration/types.d.ts).
export type GTPTimeType = 'fixed' | 'local' | 'global';

export interface GTPGlobalTimepicker {
  id: string;
  name: string;
  timezone?: string;
  cycleTime?: GTPCycleTimeConfig;
  allDurations?: GTPPreset[];
  defaultDurationId?: string;
  shifts?: GTPShift[];
  shiftAggregator?: string;
  comparisonMode?: boolean;
  futureDaysAllowed?: string;
}

// Mirrors the SDK's GTPChartSource / GTPChart — passed to TimeTabConfiguration
// via its `charts` prop so the SDK can render the per-source deviation override
// section natively when Comparison Mode + Advance Settings are both on.
export interface GTPChartSource {
  id: string;
  name: string;
}

export interface GTPChart {
  id: string;
  name: string;
  sources: GTPChartSource[];
}

// Host (iosense Lens) time config shape — distinct from the SDK's
// TimeTabUIConfig. Iosense's query-engine reads this to derive `startTime`,
// `endTime`, `timezone`, `shifts` for resolveAndCompute. Mirrors the shape
// the deployed Column Chart widget emits (`timezone, type, pickerType,
// cycleTime, startTime, endTime, fixedDuration, defaultDurationId,
// allDurations, defaultPeriodicity`). Reverse-engineered from the
// column chart bundle's onChange transform.
export interface HostTimeConfig {
  timezone: string;
  type: 'local' | 'fixed' | 'global';
  pickerType: 'local' | 'fixed' | 'global';
  cycleTime: import('@faclon-labs/design-sdk/TimeTabConfiguration').GTPCycleTimeConfig | null;
  startTime: number | null;
  endTime: number | null;
  fixedDuration?: {
    id: 'fixed';
    label: string;
    navigation: string;
    x: number;
    xPeriod: string;
    xEvent: string;
    y: number;
    yPeriod: string;
    yEvent: string;
  };
  defaultDurationId: string;
  allDurations: TimeTabUIConfig['allDurations'];
  defaultPeriodicity: string;
}

export interface LineChartEnvelope {
  _id: string;
  type: 'LineChart';
  general: { title: string };
  // Host (Lens) reads timeConfig in HostTimeConfig shape to derive
  // startTime/endTime/timezone/shifts for resolveAndCompute. The legacy
  // TimeTabUIConfig is accepted as input but always normalized via
  // toHostTimeConfig() before persisting.
  timeConfig?: HostTimeConfig | TimeTabUIConfig;
  // Full TimeTabConfiguration UI state — configurator re-hydrates from this.
  timeTabConfig?: TimeTabUIConfig;
  uiConfig: LineChartUIConfig;
  dynamicBindingPathList: Array<BindingEntry>;
}
