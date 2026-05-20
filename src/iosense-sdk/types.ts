export interface DataEntry {
  key: string;
  value: string | number | null | Array<[number, number | null]> | unknown;
}

// ---------------------------------------------------------------------------
// Time Tab — canonical TimeTabUIConfig (matches Envelope.md §2a)
// ---------------------------------------------------------------------------

export interface GTPPreset {
  id: string;
  label: string;
  x?: number;
  xPeriod?: 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year';
  calendarType?:
    | 'today'
    | 'yesterday'
    | 'current_week'
    | 'previous_week'
    | 'current_month'
    | 'previous_month';
  isBuiltIn?: boolean;
  navigation?: 'Previous' | 'Now' | 'Next';
  xEvent?: 'Start' | 'Now' | 'End';
  y?: number;
  yPeriod?: 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year';
  yEvent?: 'Start' | 'Now' | 'End';
  periodicities?: string[];
}

export interface GTPShift {
  id: string;
  name: string;
  startTime: string; // "HH:MM" 24h
  endTime: string;
  color: string;
}

export interface GTPCycleTimeConfig {
  identifier: 'start' | 'end';
  hour: string;
  minute: string;
  dayOfWeek: number | null;
  date: string;
  month: string;
  year: string;
}

export type GTPTimeType = 'fixed' | 'local' | 'global';

export interface GTPGlobalTimepicker {
  id: string;
  name: string;
}

export interface TimeTabUIConfig {
  timezone: string;
  timeType?: GTPTimeType;
  globalTimepickerId?: string;
  fixedStart?: number; // ms epoch — when timeType === 'fixed'
  fixedEnd?: number;
  defaultDurationId: string;
  allDurations: GTPPreset[];
  defaultPeriodicity: 'minute' | 'hourly' | 'daily' | 'weekly' | 'monthly';
  disablePeriodicities?: boolean;
  comparisonMode?: boolean;
  disableTimeSelection?: boolean;
  futureDaysAllowed?: string;
  shifts?: GTPShift[];
  shiftAggregator?: 'sum' | 'avg' | 'min' | 'max' | 'median';
  cycleTime?: GTPCycleTimeConfig;
}

export type WidgetEvent =
  | { type: 'TIME_CHANGE'; payload: { startTime: string; endTime: string; periodicity: string } }
  | { type: 'FILTER_CHANGE'; payload: Record<string, unknown> };

// ---------------------------------------------------------------------------
// LineChart — multi-series time-series chart config
// ---------------------------------------------------------------------------

export interface LineChartSeries {
  _id: string;
  name: string;
  color: string;
  dataSource: string;
  realTime?: boolean;
  downsampling?: string;
  downsamplingUnit?: string;
  dataPrecision?: number;
  limit?: string;
  advanceParameters?: boolean;
  m?: string;
  s?: string;
  addAsTooltip?: boolean;
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
  linkedSeriesIds: string[];
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
  fixedValue?: number;
  dynamicTopic?: string;
  periodicities?: PlotLinePeriodicityEntry[];
  startDate?: string;
  endDate?: string;
  lineWidth: number;
  lineStyle: PlotLineStyle;
}

export interface LineChartPlotBand {
  _id: string;
  name: string;
  color: string;
  axisId?: string;
  startValue: number;
  endValue: number;
}

// ---------------------------------------------------------------------------
// Statistical Process Control (SPC)
// ---------------------------------------------------------------------------

export type SPCProcessType = 'Average' | 'Median' | 'StandardDeviation';
export type SPCSigmaLevel =
  | '1Sigma'
  | '2Sigma'
  | '3Sigma'
  | '4Sigma'
  | '5Sigma'
  | '6Sigma';

export interface SPCProcessConfig {
  enabled: boolean;
  plotName: string;
  lineWidth: number;
  lineColor: string;
}

export interface SPCStandardDeviationConfig extends SPCProcessConfig {
  sigmaLevels: SPCSigmaLevel[];
}

export interface LineChartSPC {
  _id: string;
  /** Series the SPC applies to. Multi-select; produces plotLines per source × type. */
  dataSourceIds: string[];
  startDate?: string;
  endDate?: string;
  processTypes: SPCProcessType[];
  average?: SPCProcessConfig;
  median?: SPCProcessConfig;
  standardDeviation?: SPCStandardDeviationConfig;
}

// ---------------------------------------------------------------------------
// Anomaly Highlighting
// ---------------------------------------------------------------------------

export type AnomalyOperator = '>' | '<' | '>=' | '<=' | '==' | '!=';
export type AnomalyLabelMode = 'Existing' | 'NewSource' | 'Value';

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

// ---------------------------------------------------------------------------
// Data Table
// ---------------------------------------------------------------------------

export type DataTableSourceMode = 'Existing' | 'AddNew';
export type DataTableOperator =
  | 'sum'
  | 'avg'
  | 'min'
  | 'max'
  | 'median'
  | 'first'
  | 'last';

export interface DataTableColumn {
  _id: string;
  sourceMode: DataTableSourceMode;
  // Existing mode:
  seriesId?: string;
  // AddNew mode:
  topic?: string; // bindable {{topic}}
  // Per-column display options:
  label?: string;
  unit?: string;
  showUnit?: boolean;
  operator?: DataTableOperator;
  dataPrecision?: number;
}

export interface DataTableConfig {
  enabled: boolean;
  columns: DataTableColumn[];
  transposeTable: boolean;
}

// ---------------------------------------------------------------------------
// Styling — full Styling-tab config (matches Figma 11 spec)
// ---------------------------------------------------------------------------

export type StylingFontWeight = 'Regular' | 'Medium' | 'Semi-Bold' | 'Bold';
export type StylingWidgetSize = 'Small' | 'Medium' | 'Large' | 'Custom';

export interface StylingCardConfig {
  wrapInCard: boolean;
  backgroundColor: string;
  borderColor: string;
  borderWidth: number;
  borderRadius: number;
}

export interface StylingChartTitleConfig {
  fontSize: number;
  fontColor: string;
  fontWeight: StylingFontWeight;
}

export interface StylingAxisConfig {
  textColor: string;
  lineColor: string;
}

export interface StylingDataTableConfig {
  headerBackgroundColor: string;
  headerTextColor: string;
  headerTextSize: number;
  headerTextWeight: StylingFontWeight;
  dataPointTextSize: number;
  dataPointTextWeight: StylingFontWeight;
  dataPointTextColor: string;
}

export interface StylingMiscConfig {
  gridLineColor: string;
  legendTextColor: string;
}

export interface StylingHideElementsConfig {
  settingsIcon: boolean;
  exportIcon: boolean;
  chartTitle: boolean;
}

export interface StylingWidgetSizeConfig {
  preset: StylingWidgetSize;
  customWidth?: number;
  customHeight?: number;
  lockAspectRatio?: boolean;
}

export interface LineChartStyling {
  size: StylingWidgetSizeConfig;
  card: StylingCardConfig;
  hideElements: StylingHideElementsConfig;
  advancedEnabled: boolean;
  chartTitle: StylingChartTitleConfig;
  xAxisLabel: StylingAxisConfig;
  yAxisLabel: StylingAxisConfig;
  dataTable: StylingDataTableConfig;
  misc: StylingMiscConfig;
}

// ---------------------------------------------------------------------------
// Multi-chart: each LineChartUIConfig holds an array of ChartInstance.
// Series / axes / plotlines / plotbands / SPC / anomalies all scope to a chart.
// dataTable + style + (timeConfig at the envelope level) remain widget-level.
// ---------------------------------------------------------------------------

export interface ChartInstance {
  _id: string;
  title: string;
  description?: string;
  series: LineChartSeries[];
  defaultAxis: LineChartDefaultAxis;
  axes: LineChartAxis[];
  plotLines: LineChartPlotLine[];
  plotBands: LineChartPlotBand[];
  spcs: LineChartSPC[];
  anomalies: LineChartAnomaly[];
}

export interface LineChartUIConfig {
  charts: ChartInstance[];
  // The currently rendered chart's _id. null when charts.length === 0.
  activeChartId: string | null;
  // Widget-level (NOT scoped to a chart):
  dataTable: DataTableConfig;
  style: LineChartStyling;
}

export interface LineChartEnvelope {
  _id: string;
  type: 'LineChart';
  general: { title: string };
  timeConfig?: TimeTabUIConfig;
  uiConfig: LineChartUIConfig;
  dynamicBindingPathList: Array<{ key: string; topic: string }>;
}
