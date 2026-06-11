import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { UNSPathInput } from '@faclon-labs/design-sdk/UNSPathInput';
import { ColorInput } from '@faclon-labs/design-sdk/ColorPicker';
import { useUNSTree, UNSTree } from '../../iosense-sdk/useUNSTree';
import {
  ArrowLeft,
  X,
  Plus,
  Trash2,
  Edit2,
  ChevronDown,
} from 'react-feather';
import {
  Tabs,
  TabItem,
  TextInput,
  Button,
  IconButton,
  RadioGroup,
  Radio,
  SelectInput,
  DropdownMenu,
  ActionListItem,
  DatePicker,
  Modal,
  ModalHeader,
  ModalBody,
  ModalFooter,
  ModalLeadingItem,
  Switch,
  Checkbox,
  Divider,
  Badge,
  ListCard,
  ListCardLeadingItem,
  ListCardTrailingItem,
  ComparisonToggle,
  TimeTabConfiguration,
  ProductAccordionItem,
  Tooltip,
} from '@faclon-labs/design-sdk';
import {
  LineChartEnvelope,
  LineChartUIConfig,
  ChartInstance,
  LineChartSeries,
  LineChartDefaultAxis,
  LineChartAxis,
  LineChartPlotLine,
  LineChartPlotBand,
  LineChartSPC,
  LineChartAnomaly,
  PlotLineType,
  PlotLineValueType,
  PlotLineStyle,
  PlotLinePeriodicityEntry,
  SPCProcessType,
  SPCSigmaLevel,
  AnomalyOperator,
  AnomalyLabelMode,
  TimeTabUIConfig,
  GTPGlobalTimepicker,
  GTPChart,
  DataTableConfig,
  DataTableColumn,
  DataTableSourceMode,
  DataTableOperator,
  LineChartStyling,
  StylingFontWeight,
  StylingWidgetSize,
  DeviationIndicatorMode,
} from '../../iosense-sdk/types';
import './LineChartConfiguration.css';

interface LineChartConfigurationProps {
  // Optional: the host may mount the configurator before any envelope exists.
  // All init reads via `config?.` + `normalizeLineChartUIConfig` defaults, and
  // the resync effect is guarded by `if (config)`, so undefined is safe.
  config?: LineChartEnvelope;
  authentication?: string;
  onChange: (config: LineChartEnvelope) => void;
  // Angular runtime injection — all-or-none; dev harness falls back to useUNSTree hook
  unsTree?: UNSTree;
  isLoadingTree?: boolean;
  onLoadWorkspaces?: () => void;
  resolveUNSValue?: (rawValue: string) => string;
  // Angular runtime injection — list of global timepickers for the "Link Time With" dropdown.
  globalTimepickers?: GTPGlobalTimepicker[];
}

const VARIABLE_REGEX = /^\{\{(.+)\}\}$/;

// Walk uiConfig and emit BindingEntry for every {{topic}} string found.
// seriesKeys: explicit dot-paths that get type:'series' — all others are scalar.
function buildDynamicBindingPathList(
  uiConfig: unknown,
  seriesKeys: string[] = [],
): Array<{ key: string; topic: string; type?: 'series' }> {
  const seriesKeySet = new Set(seriesKeys);
  const paths: Array<{ key: string; topic: string; type?: 'series' }> = [];

  function walk(obj: unknown, currentPath: string): void {
    if (obj === null || obj === undefined) return;
    if (typeof obj === 'string') {
      const match = VARIABLE_REGEX.exec(obj.trim());
      if (match) {
        const entry: { key: string; topic: string; type?: 'series' } = {
          key: currentPath,
          topic: match[1],
        };
        if (seriesKeySet.has(currentPath)) entry.type = 'series';
        paths.push(entry);
      }
      return;
    }
    if (Array.isArray(obj)) {
      obj.forEach((item, index) => walk(item, `${currentPath}[${index}]`));
      return;
    }
    if (typeof obj === 'object') {
      Object.entries(obj as Record<string, unknown>).forEach(([key, val]) => {
        walk(val, currentPath ? `${currentPath}.${key}` : key);
      });
    }
  }

  walk(uiConfig, '');
  return paths;
}

// Sensible default for a fresh envelope's timeConfig.
const DEFAULT_TIME_CONFIG: TimeTabUIConfig = {
  timezone: 'Asia/Kolkata',
  timeType: 'local',
  defaultDurationId: 'last24h',
  allDurations: [
    {
      id: 'today',
      label: 'Today',
      calendarType: 'today',
      isBuiltIn: true,
      periodicities: ['minute', 'hourly', 'daily'],
    },
    {
      id: 'yesterday',
      label: 'Yesterday',
      calendarType: 'yesterday',
      isBuiltIn: true,
      periodicities: ['minute', 'hourly', 'daily'],
    },
    {
      id: 'last24h',
      label: 'Last 24 Hours',
      x: 24,
      xPeriod: 'hour',
      isBuiltIn: true,
      periodicities: ['minute', 'hourly'],
    },
    {
      id: 'last7d',
      label: 'Last 7 Days',
      x: 7,
      xPeriod: 'day',
      isBuiltIn: true,
      periodicities: ['hourly', 'daily'],
    },
    {
      id: 'last30d',
      label: 'Last 30 Days',
      x: 30,
      xPeriod: 'day',
      isBuiltIn: true,
      periodicities: ['daily', 'weekly'],
    },
    {
      id: 'current_week',
      label: 'Current Week',
      calendarType: 'current_week',
      isBuiltIn: true,
      periodicities: ['hourly', 'daily'],
    },
    {
      id: 'previous_week',
      label: 'Previous Week',
      calendarType: 'previous_week',
      isBuiltIn: true,
      periodicities: ['hourly', 'daily'],
    },
    {
      id: 'current_month',
      label: 'Current Month',
      calendarType: 'current_month',
      isBuiltIn: true,
      periodicities: ['daily', 'weekly'],
    },
    {
      id: 'previous_month',
      label: 'Previous Month',
      calendarType: 'previous_month',
      isBuiltIn: true,
      periodicities: ['daily', 'weekly'],
    },
  ],
  defaultPeriodicity: 'hourly',
};

const DEFAULT_DATA_TABLE: DataTableConfig = {
  enabled: false,
  columns: [],
  transposeTable: false,
  operators: ['avg'],
  showUnit: true,
};

// Read operators from a config, tolerating the legacy single `operator` field.
function resolveDataTableOperators(dt: DataTableConfig): DataTableOperator[] {
  if (dt.operators && dt.operators.length) return dt.operators;
  return dt.operator ? [dt.operator] : ['avg'];
}

// Widget size preset dimensions (px). Custom is user-supplied.
const SIZE_PRESETS: Record<StylingWidgetSize, { w?: number; h?: number; label: string }> = {
  Small: { w: 580, h: 400, label: '580px X 400px' },
  Medium: { w: 880, h: 400, label: '880px X 400px' },
  Large: { w: 1780, h: 400, label: '1780px X 400px' },
  Custom: { label: 'Manual Input' },
};

const FONT_WEIGHTS: StylingFontWeight[] = ['Regular', 'Medium', 'Semi-Bold', 'Bold'];

// Default styling — literal hex values from Figma 11 spec.
const DEFAULT_STYLING: LineChartStyling = {
  size: { preset: 'Medium', customWidth: 880, customHeight: 400, lockAspectRatio: false },
  card: {
    wrapInCard: false,
    backgroundColor: '#FFFFFF',
    borderColor: '#EEEEEE',
    borderWidth: 1,
    borderRadius: 8,
  },
  hideElements: { settingsIcon: false, exportIcon: false, chartTitle: false },
  advancedEnabled: false,
  chartTitle: { fontSize: 18, fontColor: '#050505', fontWeight: 'Semi-Bold' },
  xAxisLabel: { textColor: '#050505', lineColor: '#DEE1E3', dataPointColor: '#050505' },
  yAxisLabel: { textColor: '#050505', lineColor: '#333333', dataPointColor: '#050505' },
  dataTable: {
    headerBackgroundColor: '#EEF0F1',
    headerTextColor: '#616D75',
    headerTextSize: 14,
    headerTextWeight: 'Semi-Bold',
    dataPointTextSize: 14,
    dataPointTextWeight: 'Regular',
    dataPointTextColor: '#292F32',
  },
  misc: { gridLineColor: '#DEE1E3', legendTextColor: '#292F2E' },
};

function normalizeStyling(raw: unknown): LineChartStyling {
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if ('size' in obj && 'advancedEnabled' in obj) {
      const styling = obj as unknown as LineChartStyling;
      // Wrap Into Card defaults to off — only on when explicitly set true.
      return {
        ...styling,
        card: {
          ...styling.card,
          wrapInCard: styling.card?.wrapInCard === true,
        },
      };
    }
    const card = (obj.card as Record<string, unknown> | undefined) ?? {};
    return {
      ...DEFAULT_STYLING,
      card: {
        ...DEFAULT_STYLING.card,
        wrapInCard: typeof card.wrapInCard === 'boolean' ? card.wrapInCard : false,
        backgroundColor:
          typeof card.bg === 'string' && card.bg.trim().length > 0
            ? card.bg
            : DEFAULT_STYLING.card.backgroundColor,
      },
    };
  }
  return DEFAULT_STYLING;
}

function buildEnvelope(
  existing: LineChartEnvelope | undefined,
  uiConfig: LineChartUIConfig,
  timeTabConfig?: TimeTabUIConfig,
): LineChartEnvelope {
  // timeTabConfig = full TimeTabConfiguration UI state (for re-hydration).
  // timeConfig    = same value; mini-engine reads this to compute the time window.
  // Both must always be in sync — never emit one without the other.
  const tc = timeTabConfig ?? existing?.timeTabConfig ?? existing?.timeConfig ?? DEFAULT_TIME_CONFIG;
  const dynamicBindingPathList = buildDynamicBindingPathList(
    uiConfig,
    [
      ...uiConfig.charts.flatMap((chart, ci) =>
        chart.series.map((_s, si) => `charts[${ci}].series[${si}].dataSource`),
      ),
      ...uiConfig.charts.flatMap((chart, ci) =>
        chart.axes.map((_a, ai) => `charts[${ci}].axes[${ai}].dataSource`),
      ),
    ],
  );
  // Warn on bindings whose topic isn't a resolved UNS path. Catches the common
  // case where resolveUNSValue cache-missed and stored the workspace-name path
  // verbatim — mini-engine would reject it and the chart would never load.
  for (const b of dynamicBindingPathList) {
    if (!b.topic.startsWith('uns:')) {
      console.warn(
        `[Configurator] Binding "${b.key}" has unresolved topic "${b.topic}". ` +
          `Expected "uns:wsId://path". The mini-engine will reject this. ` +
          `Re-pick the value from the UNS dropdown after the workspace has loaded.`,
      );
    }
  }
  return {
    _id: existing?._id ?? `linechart_${Date.now()}`,
    type: 'LineChart',
    general: existing?.general ?? { title: '' },
    timeConfig: tc,
    timeTabConfig: tc,
    uiConfig,
    dynamicBindingPathList,
  };
}

const DEFAULT_DEFAULT_AXIS: LineChartDefaultAxis = {
  yAxisLabel: '',
  yAxisMin: null,
  yAxisMax: null,
  xAxisLabel: '',
};

// Migrate a previously-saved single-chart uiConfig (Dispatch 5 shape) into the
// new multi-chart shape. Detection: presence of a top-level `series` array and
// absence of `charts`. Idempotent — already-migrated input is returned as-is.
function migrateSpc(raw: unknown): LineChartSPC {
  const o = (raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}) as Record<string, unknown>;
  const ids = Array.isArray(o.dataSourceIds)
    ? (o.dataSourceIds as string[])
    : typeof o.dataSourceId === 'string' && o.dataSourceId
      ? [o.dataSourceId as string]
      : [];
  return { ...(o as unknown as LineChartSPC), dataSourceIds: ids };
}
function migrateChartSpcs(chart: ChartInstance): ChartInstance {
  if (!Array.isArray(chart.spcs)) return chart;
  return { ...chart, spcs: chart.spcs.map((s) => migrateSpc(s)) };
}

// Normalize a single DataTableConfig (fills defaults + migrates the legacy
// single `operator` to the `operators` array). Used for the per-chart data
// table and the legacy widget-level mirror.
function normalizeDataTable(raw: Partial<DataTableConfig> | undefined): DataTableConfig {
  if (!raw) return { ...DEFAULT_DATA_TABLE };
  return {
    ...DEFAULT_DATA_TABLE,
    ...raw,
    operators:
      raw.operators && raw.operators.length
        ? raw.operators
        : raw.operator
          ? [raw.operator]
          : DEFAULT_DATA_TABLE.operators,
  };
}

function normalizeLineChartUIConfig(raw: unknown): LineChartUIConfig {
  const obj = (raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}) as Record<string, unknown>;

  // Legacy widget-level data table (older configs stored one shared table).
  // It's now per-chart — kept as a fallback so existing configs keep their
  // table on charts that don't yet have their own.
  const dataTable = normalizeDataTable(obj.dataTable as Partial<DataTableConfig> | undefined);
  const style = normalizeStyling(obj.style);
  const deviationIndicator: DeviationIndicatorMode =
    obj.deviationIndicator === 'inverse' ? 'inverse' : 'standard';
  const advanceSettings: boolean =
    typeof obj.advanceSettings === 'boolean' ? obj.advanceSettings : false;

  // Already in new shape — pass through (migrate inner SPC shape + per-chart
  // data table; charts without their own table inherit the legacy widget one).
  if (Array.isArray(obj.charts)) {
    const charts = (obj.charts as ChartInstance[]).map((c) => ({
      ...migrateChartSpcs(c),
      dataTable: normalizeDataTable(
        (c as { dataTable?: Partial<DataTableConfig> }).dataTable ?? dataTable,
      ),
    }));
    const activeChartId =
      typeof obj.activeChartId === 'string'
        ? obj.activeChartId
        : charts.length > 0
          ? charts[0]._id
          : null;
    return { charts, activeChartId, dataTable, style, deviationIndicator, advanceSettings };
  }

  // Old single-chart shape — wrap into one ChartInstance.
  const hasOldData =
    Array.isArray(obj.series) ||
    typeof obj.chartTitle === 'string' ||
    Array.isArray(obj.axes) ||
    Array.isArray(obj.plotLines) ||
    Array.isArray(obj.plotBands) ||
    Array.isArray(obj.spcs) ||
    Array.isArray(obj.anomalies);

  if (hasOldData) {
    const chart: ChartInstance = {
      _id: `chart_${Date.now()}`,
      title: typeof obj.chartTitle === 'string' ? obj.chartTitle : '',
      description: typeof obj.chartDescription === 'string' ? obj.chartDescription : '',
      series: Array.isArray(obj.series) ? (obj.series as LineChartSeries[]) : [],
      defaultAxis:
        (obj.defaultAxis as LineChartDefaultAxis | undefined) ?? { ...DEFAULT_DEFAULT_AXIS },
      axes: Array.isArray(obj.axes) ? (obj.axes as LineChartAxis[]) : [],
      plotLines: Array.isArray(obj.plotLines) ? (obj.plotLines as LineChartPlotLine[]) : [],
      plotBands: Array.isArray(obj.plotBands) ? (obj.plotBands as LineChartPlotBand[]) : [],
      spcs: Array.isArray(obj.spcs) ? (obj.spcs as unknown[]).map(migrateSpc) : [],
      anomalies: Array.isArray(obj.anomalies) ? (obj.anomalies as LineChartAnomaly[]) : [],
      // Old single-chart config — adopt the legacy widget-level data table.
      dataTable,
    };
    return { charts: [chart], activeChartId: chart._id, dataTable, style, deviationIndicator, advanceSettings };
  }

  // Empty / fresh — no charts yet.
  return { charts: [], activeChartId: null, dataTable, style, deviationIndicator, advanceSettings };
}

// Factory for a fresh ChartInstance.
function newChart(
  title: string,
  description: string,
  chartType: 'Aggregated' | 'Realtime' = 'Aggregated',
): ChartInstance {
  return {
    _id: `chart_${Date.now()}`,
    title: title.trim(),
    description: description.trim() || undefined,
    chartType,
    series: [],
    defaultAxis: { ...DEFAULT_DEFAULT_AXIS },
    axes: [],
    plotLines: [],
    plotBands: [],
    spcs: [],
    anomalies: [],
    dataTable: { ...DEFAULT_DATA_TABLE },
  };
}

const DEFAULT_COLORS = [
  '#3b82f6',
  '#ef4444',
  '#10b981',
  '#f59e0b',
  '#8b5cf6',
  '#ec4899',
  '#14b8a6',
  '#f97316',
];

type TopTab = 'Data' | 'Time' | 'Style';

type SectionKey =
  | 'Chart Settings'
  | 'Data Source'
  | 'Statistical Process Control'
  | 'Anomaly Highlighting'
  | 'Axis'
  | 'Plot Line'
  | 'Plot Band'
  | 'Data Table';

const SECTION_ORDER: SectionKey[] = [
  'Chart Settings',
  'Data Source',
  // 'Statistical Process Control', // Hidden for now — may be re-enabled later.
  // All SPC code (SPCEditor, handlers, types, addPanel case) is kept intact;
  // simply re-add this entry to restore the section in the accordion.
  'Anomaly Highlighting',
  'Axis',
  'Plot Line',
  'Plot Band',
  'Data Table',
];

// Sections with CRUD items (everything except Chart Settings).
const COUNTABLE_SECTIONS: Partial<Record<SectionKey, true>> = {
  'Data Source': true,
  'Statistical Process Control': true,
  'Anomaly Highlighting': true,
  Axis: true,
  'Plot Line': true,
  'Plot Band': true,
  'Data Table': true,
};

// Section -> Column-2 header label (Add mode).
const SECTION_ADD_LABEL: Record<Exclude<SectionKey, 'Chart Settings'>, string> = {
  'Data Source': 'Data Source',
  'Statistical Process Control': 'Statistical Process Control',
  'Anomaly Highlighting': 'Anomaly',
  Axis: 'Axis',
  'Plot Line': 'Plotline',
  'Plot Band': 'Plotband',
  'Data Table': 'Data Table',
};

// Section -> expected fully-expanded editor body height. Used to clamp the
// modal's vertical anchor so it never overflows the viewport on first paint.
const SECTION_EST_HEIGHT: Record<Exclude<SectionKey, 'Chart Settings'>, number> = {
  'Data Source': 540,
  'Statistical Process Control': 720,
  'Anomaly Highlighting': 540,
  Axis: 540,
  'Plot Line': 720,
  'Plot Band': 540,
  'Data Table': 540,
};

// Column-2 control surface: the active editor reports its current submit
// callback + validity to the shell so the sticky footer can drive submission.
interface EditorBinding {
  submit: () => void;
  isValid: boolean;
}

type AddPanelState =
  | { section: Exclude<SectionKey, 'Chart Settings'>; mode: 'add' }
  | { section: Exclude<SectionKey, 'Chart Settings'>; mode: 'edit'; itemId: string };

export function LineChartConfiguration({
  config,
  authentication,
  onChange,
  unsTree: injectedUnsTree,
  isLoadingTree: injectedIsLoadingTree,
  onLoadWorkspaces,
  resolveUNSValue: injectedResolveUNSValue,
  globalTimepickers,
}: LineChartConfigurationProps) {
  const hasInjectedUNS =
    injectedUnsTree !== undefined &&
    onLoadWorkspaces !== undefined &&
    injectedResolveUNSValue !== undefined;
  const hookResult = useUNSTree(hasInjectedUNS ? undefined : authentication);
  const unsTree         = hasInjectedUNS ? injectedUnsTree!              : hookResult.unsTree;
  const isLoadingTree   = hasInjectedUNS ? (injectedIsLoadingTree ?? false) : hookResult.isLoadingTree;
  const loadWorkspaces  = hasInjectedUNS ? onLoadWorkspaces!             : hookResult.loadWorkspaces;
  const resolveUNSValue = hasInjectedUNS ? injectedResolveUNSValue!      : hookResult.resolveUNSValue;
  // Top-level tab state
  const [topTab, setTopTab] = useState<TopTab>('Data');

  // Which sections are expanded in Column 1 (Chart Settings is always inline,
  // not part of this set).
  const [expandedSections, setExpandedSections] = useState<Set<SectionKey>>(
    () => new Set(),
  );

  // Column-2 add/edit state. null = column 2 hidden.
  const [addPanel, setAddPanel] = useState<AddPanelState | null>(null);

  // Side-modal anchor — recomputed on every open from the clicked accordion row.
  // x sits 20px right of the .app__config column; y aligns to the row header,
  // clamped so the modal fits within the viewport. The CSS var --lc-anchor-y
  // is set on <html> so the modal's max-height can react without re-renders.
  const [modalAnchor, setModalAnchor] = useState<{ x: number; y: number }>({ x: 316, y: 120 });

  // .lc-config root — used to walk up to .app__config for x-anchor calculation.
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Per-section row container refs — readable from openAddPanel/openEditPanel
  // to locate the clicked accordion header for y-anchor calculation.
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({});

  // The active editor's submit binding (kept in sync via setEditorBinding).
  const [editorBinding, setEditorBinding] = useState<EditorBinding | null>(null);

  // Multi-chart state.
  const initialUiConfig = useMemo(
    () => normalizeLineChartUIConfig(config?.uiConfig),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [config?._id],
  );
  const [charts, setCharts] = useState<ChartInstance[]>(initialUiConfig.charts);
  const [activeChartId, setActiveChartId] = useState<string | null>(initialUiConfig.activeChartId);

  // Chart Settings edit/new sub-state (local — not persisted).
  const [chartEditMode, setChartEditMode] = useState<boolean>(false);
  const [newChartDraft, setNewChartDraft] = useState<boolean>(false);
  // Pending delete-chart confirmation (separate modal flow).
  const [pendingDeleteChart, setPendingDeleteChart] = useState<boolean>(false);

  // Full styling config (widget-level).
  const [styling, setStyling] = useState<LineChartStyling>(initialUiConfig.style);


  // Deviation indicator preference — only meaningful when comparison mode is on.
  const [deviationIndicator, setDeviationIndicator] = useState<DeviationIndicatorMode>(
    initialUiConfig.deviationIndicator ?? 'standard',
  );

  // Advance Settings disclosure — auto-opens on first load if any advanced
  // field already has a non-default value (so users never wonder where their
  // configured setting went).
  const initialAdvanceOpen = useMemo(() => {
    if (typeof initialUiConfig.advanceSettings === 'boolean') return initialUiConfig.advanceSettings;
    const tc = config?.timeTabConfig ?? config?.timeConfig;
    return !!(tc?.disableTimeSelection || (tc?.futureDaysAllowed && tc.futureDaysAllowed !== ''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [advanceSettings, setAdvanceSettings] = useState<boolean>(initialAdvanceOpen);

  // Ref to the Time tab wrapper; the portal uses it to inject the deviation
  // indicator selector directly after the SDK's Comparison Mode row.
  const timeTabRef = useRef<HTMLDivElement | null>(null);

  // The Duration section's "add" button is rendered inside the SDK
  // TimeTabConfiguration (aria-label "Add preset"), so it can't be wrapped in a
  // <Tooltip> directly. Track its hover + position and render a controlled SDK
  // Tooltip ("Add Duration") over it.
  const [addDurTooltipRect, setAddDurTooltipRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    const root = timeTabRef.current;
    if (!root) return;
    let btn: Element | null = null;
    const onEnter = () => {
      if (btn) setAddDurTooltipRect(btn.getBoundingClientRect());
    };
    const onLeave = () => setAddDurTooltipRect(null);
    const attach = () => {
      const found = root.querySelector('[aria-label="Add preset"]');
      if (found && found !== btn) {
        if (btn) {
          btn.removeEventListener('mouseenter', onEnter);
          btn.removeEventListener('mouseleave', onLeave);
        }
        btn = found;
        btn.addEventListener('mouseenter', onEnter);
        btn.addEventListener('mouseleave', onLeave);
      }
    };
    attach();
    const mo = new MutationObserver(attach);
    mo.observe(root, { childList: true, subtree: true });
    return () => {
      mo.disconnect();
      if (btn) {
        btn.removeEventListener('mouseenter', onEnter);
        btn.removeEventListener('mouseleave', onLeave);
      }
    };
  }, [topTab]);

  // Full TimeTabConfiguration state — prefer timeTabConfig for re-hydration so the
  // component restores its exact UI state; fall back to timeConfig for older envelopes.
  const [timeTabConfig, setTimeTabConfig] = useState<TimeTabUIConfig>(
    config?.timeTabConfig ?? config?.timeConfig ?? DEFAULT_TIME_CONFIG,
  );

  // Pending delete (modal) — keyed by section so a single modal can serve all.
  const [pendingDelete, setPendingDelete] = useState<
    | {
        section: Exclude<SectionKey, 'Chart Settings'>;
        itemId: string;
        title: string;
        message: string;
      }
    | null
  >(null);

  // Resync state when an existing envelope is loaded.
  useEffect(() => {
    if (config) {
      const next = normalizeLineChartUIConfig(config.uiConfig);
      setCharts(next.charts);
      setActiveChartId(next.activeChartId);
      setStyling(next.style);
      setDeviationIndicator(next.deviationIndicator ?? 'standard');
      const tc = config.timeTabConfig ?? config.timeConfig;
      const shouldAutoOpen =
        typeof next.advanceSettings === 'boolean'
          ? next.advanceSettings
          : !!(tc?.disableTimeSelection || (tc?.futureDaysAllowed && tc.futureDaysAllowed !== ''));
      setAdvanceSettings(shouldAutoOpen);
      setTimeTabConfig(config.timeTabConfig ?? config.timeConfig ?? DEFAULT_TIME_CONFIG);
      setChartEditMode(false);
      setNewChartDraft(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?._id]);

  // Derived: the currently-active chart instance (or null).
  const activeChart = useMemo<ChartInstance | null>(() => {
    if (!activeChartId) return null;
    return charts.find((c) => c._id === activeChartId) ?? null;
  }, [charts, activeChartId]);

  // Data Table is now PER-CHART: read/write the active chart's `dataTable`.
  // `setDataTable` routes through updateActiveChart so the edit is scoped to the
  // active chart (and emitted). `updateActiveChart` is hoisted (declared below).
  const dataTable: DataTableConfig = activeChart?.dataTable ?? DEFAULT_DATA_TABLE;
  const setDataTable = (next: DataTableConfig) =>
    updateActiveChart((c) => ({ ...c, dataTable: next }));

  // Derived: hasChart + inEditMode — drive section disabling.
  const hasChart = charts.length > 0;
  const inEditMode = chartEditMode || newChartDraft;
  // Active chart's type drives periodicity availability (Time tab + plotlines).
  const activeChartIsRealtime = (activeChart?.chartType ?? 'Aggregated') === 'Realtime';

  // The SDK TimeTabConfiguration has no prop to hide periodicity (its
  // `disablePeriodicities` is type-only / a runtime no-op). When the active chart
  // is Realtime, DOM-patch the Time tab + its Add/Edit Duration modal to hide all
  // periodicity controls (the inputs carry stable `name`s; duration cards render a
  // "Periodicity: …" subtitle). Shifts are left intact. Scoped + cheap; re-applies
  // via MutationObserver since the modal is portal-rendered and the list re-renders.
  useEffect(() => {
    if (topTab !== 'Time' || !activeChartIsRealtime) return;
    const hide = (el: Element | null) => {
      if (el instanceof HTMLElement) el.style.display = 'none';
    };
    const patch = () => {
      // Periodicity SelectInputs (Add/Edit Duration modal + fixed-time config).
      document
        .querySelectorAll('input[name="periodicity"], input[name="fixed-duration-periodicity"]')
        .forEach((inp) => hide(inp.closest('.fds-ttc__required-select')));
      // Duration-card "Periodicity: …" subtitles in the Time tab list.
      const root = timeTabRef.current;
      if (root) {
        root.querySelectorAll('*').forEach((el) => {
          if (
            el.children.length === 0 &&
            /^Periodicity:/.test(el.textContent?.trim() ?? '')
          ) {
            hide(el);
          }
        });
      }
    };
    patch();
    const mo = new MutationObserver(patch);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [topTab, activeChartIsRealtime]);

  // Single-open accordion behaviour for the Time tab (mirrors the Data tab).
  // The SDK's TimeTabConfiguration renders uncontrolled ProductAccordionItems
  // with no single-open prop, so we enforce it from the DOM: whenever an item
  // gains the `--expanded` class, collapse every OTHER expanded accordion in
  // the tab by clicking its header (skipping ancestors of the opened item so
  // any nested accordion keeps its parent open). Closing an item removes its
  // expanded class, so the observer doesn't recurse.
  useEffect(() => {
    if (topTab !== 'Time') return;
    const root = timeTabRef.current;
    if (!root) return;
    let busy = false;
    const collapseOthers = (opened: Element) => {
      if (busy) return;
      busy = true;
      root.querySelectorAll('.fds-pa-item--expanded').forEach((el) => {
        if (el === opened || el.contains(opened)) return; // keep self + ancestors
        const header = el.querySelector(':scope > .fds-pa-item__header') as HTMLElement | null;
        header?.click();
      });
      busy = false;
    };
    const obs = new MutationObserver((mutations) => {
      for (const m of mutations) {
        const target = m.target;
        if (!(target instanceof HTMLElement)) continue;
        if (
          target.classList.contains('fds-pa-item') &&
          target.classList.contains('fds-pa-item--expanded')
        ) {
          collapseOthers(target);
          break;
        }
      }
    });
    obs.observe(root, { attributes: true, attributeFilter: ['class'], subtree: true });
    return () => obs.disconnect();
  }, [topTab]);

  // Derived: GTPChart[] view of local charts — passed to TimeTabConfiguration's
  // `charts` prop (SDK 0.6.5+) so the SDK can render the per-source deviation
  // override section natively when Comparison Mode + Advance Settings are on.
  const gtpCharts = useMemo<GTPChart[]>(
    () =>
      charts.map((c) => ({
        id: c._id,
        name: c.title,
        sources: c.series.map((s) => ({ id: s._id, name: s.name })),
      })),
    [charts],
  );

  function emit(
    overrides?: Partial<{
      charts: ChartInstance[];
      activeChartId: string | null;
      styling: LineChartStyling;
      dataTable: DataTableConfig;
      timeTabConfig: TimeTabUIConfig;
      deviationIndicator: DeviationIndicatorMode;
      advanceSettings: boolean;
    }>,
  ) {
    const resolvedCharts = overrides?.charts ?? charts;
    const resolvedActiveId =
      'activeChartId' in (overrides ?? {})
        ? (overrides!.activeChartId as string | null)
        : activeChartId;

    const uiConfig: LineChartUIConfig = {
      charts: resolvedCharts,
      activeChartId: resolvedActiveId,
      dataTable: overrides?.dataTable ?? dataTable,
      style: overrides?.styling ?? styling,
      deviationIndicator: overrides?.deviationIndicator ?? deviationIndicator,
      advanceSettings: overrides?.advanceSettings ?? advanceSettings,
    };

    onChange(buildEnvelope(config, uiConfig, overrides?.timeTabConfig ?? timeTabConfig));
  }

  // Update one field across the active chart, persisting downstream.
  function updateActiveChart(updater: (c: ChartInstance) => ChartInstance) {
    if (!activeChartId) return;
    setCharts((prev) => {
      const next = prev.map((c) => (c._id === activeChartId ? updater(c) : c));
      // Emit synchronously with the freshly-computed next list.
      onChange(
        buildEnvelope(
          config,
          {
            charts: next,
            activeChartId,
            dataTable,
            style: styling,
            deviationIndicator,
            advanceSettings,
          },
          timeTabConfig,
        ),
      );
      return next;
    });
  }

  // If no chart exists yet, create a default "Chart 1" and make it active.
  // Returns the active chart id (existing one if any, otherwise the new one).
  // Side-effect: emits the new envelope via emit() so downstream sees the chart
  // before the caller opens Column 2 in Add mode.
  function ensureChartExists(): string {
    if (activeChartId) return activeChartId;
    if (charts.length > 0) {
      // Defensive: pick first chart if activeChartId somehow drifted to null.
      const id = charts[0]._id;
      setActiveChartId(id);
      emit({ activeChartId: id });
      return id;
    }
    const c = newChart('Chart 1', '');
    const nextCharts = [c];
    setCharts(nextCharts);
    setActiveChartId(c._id);
    setChartEditMode(false);
    setNewChartDraft(false);
    emit({ charts: nextCharts, activeChartId: c._id });
    return c._id;
  }

  // ---- Section expand/collapse ---------------------------------------------
  function toggleSection(s: SectionKey) {
    setExpandedSections((prev) => {
      // Accordion behaves single-open: opening a section collapses the others.
      if (prev.has(s)) return new Set();
      return new Set([s]);
    });
  }

  // ---- Side-modal anchor + open/close ---------------------------------------
  const computeAnchorFromRef = useCallback(
    (section: Exclude<SectionKey, 'Chart Settings'>) => {
      const row = rowRefs.current[section];
      const headerEl =
        (row?.querySelector('.fds-pa-item__header') as HTMLElement | null) ?? row;
      const anchorRect = headerEl?.getBoundingClientRect();
      const panelEl =
        (rootRef.current?.closest('.app__config') as HTMLElement | null) ??
        rootRef.current;
      const panelRect = panelEl?.getBoundingClientRect();
      const estHeight = SECTION_EST_HEIGHT[section];
      const x = (panelRect?.right ?? 0) + 20;
      const margin = 16;
      const vh = window.innerHeight;
      let y = anchorRect?.top ?? margin;
      if (y + estHeight + margin > vh) {
        y = Math.max(margin, vh - estHeight - margin);
      }
      if (y < margin) y = margin;
      setModalAnchor({ x, y });
      document.documentElement.style.setProperty('--lc-anchor-y', `${y}px`);
    },
    [],
  );

  function openAddPanel(section: Exclude<SectionKey, 'Chart Settings'>) {
    computeAnchorFromRef(section);
    setAddPanel({ section, mode: 'add' });
    setEditorBinding(null);
  }

  function openEditPanel(
    section: Exclude<SectionKey, 'Chart Settings'>,
    itemId: string,
  ) {
    computeAnchorFromRef(section);
    setAddPanel({ section, mode: 'edit', itemId });
    setEditorBinding(null);
  }

  function closeAddPanel() {
    setAddPanel(null);
    setEditorBinding(null);
  }

  // ---- Series mutators (scoped to active chart) ----------------------------
  function handleAddSeries(s: LineChartSeries) {
    updateActiveChart((c) => ({ ...c, series: [...c.series, s] }));
  }

  function handleUpdateSeriesItem(s: LineChartSeries) {
    updateActiveChart((c) => ({
      ...c,
      series: c.series.map((x) => (x._id === s._id ? s : x)),
    }));
  }

  function handleRemoveSeries(id: string) {
    updateActiveChart((c) => ({
      ...c,
      series: c.series.filter((s) => s._id !== id),
      axes: c.axes.map((a) => ({
        ...a,
        linkedSeriesIds: a.linkedSeriesIds.filter((sid) => sid !== id),
      })),
      spcs: c.spcs
        .map((s) => ({ ...s, dataSourceIds: s.dataSourceIds.filter((sid) => sid !== id) }))
        .filter((s) => s.dataSourceIds.length > 0),
      anomalies: c.anomalies
        .filter((a) => a.applyToSeriesId !== id)
        .map((a) =>
          a.existingSeriesId === id ? { ...a, existingSeriesId: undefined } : a,
        ),
    }));
    if (
      addPanel &&
      addPanel.mode === 'edit' &&
      addPanel.section === 'Data Source' &&
      addPanel.itemId === id
    ) {
      console.warn('[Configurator] Closing edit panel — series was deleted.');
      closeAddPanel();
    }
  }

  // ---- Axes mutators --------------------------------------------------------
  function handleAddAxis(axis: LineChartAxis) {
    updateActiveChart((c) => ({ ...c, axes: [...c.axes, axis] }));
  }

  function handleUpdateAxis(axis: LineChartAxis) {
    updateActiveChart((c) => ({
      ...c,
      axes: c.axes.map((a) => (a._id === axis._id ? axis : a)),
    }));
  }

  function handleRemoveAxis(id: string) {
    updateActiveChart((c) => ({
      ...c,
      axes: c.axes.filter((a) => a._id !== id),
      plotBands: c.plotBands.map((pb) =>
        pb.axisId === id ? { ...pb, axisId: undefined } : pb,
      ),
    }));
    if (
      addPanel &&
      addPanel.mode === 'edit' &&
      addPanel.section === 'Axis' &&
      addPanel.itemId === id
    ) {
      console.warn('[Configurator] Closing edit panel — axis was deleted.');
      closeAddPanel();
    }
  }

  // ---- Plot Line mutators ---------------------------------------------------
  function handleAddPlotLine(line: LineChartPlotLine) {
    updateActiveChart((c) => ({ ...c, plotLines: [...c.plotLines, line] }));
  }

  function handleUpdatePlotLine(line: LineChartPlotLine) {
    updateActiveChart((c) => ({
      ...c,
      plotLines: c.plotLines.map((p) => (p._id === line._id ? line : p)),
    }));
  }

  function handleRemovePlotLine(id: string) {
    updateActiveChart((c) => ({
      ...c,
      plotLines: c.plotLines.filter((p) => p._id !== id),
    }));
    if (
      addPanel &&
      addPanel.mode === 'edit' &&
      addPanel.section === 'Plot Line' &&
      addPanel.itemId === id
    ) {
      console.warn('[Configurator] Closing edit panel — plotline was deleted.');
      closeAddPanel();
    }
  }

  // ---- Plot Band mutators ---------------------------------------------------
  function handleAddPlotBand(band: LineChartPlotBand) {
    updateActiveChart((c) => ({ ...c, plotBands: [...c.plotBands, band] }));
  }

  function handleUpdatePlotBand(band: LineChartPlotBand) {
    updateActiveChart((c) => ({
      ...c,
      plotBands: c.plotBands.map((p) => (p._id === band._id ? band : p)),
    }));
  }

  function handleRemovePlotBand(id: string) {
    updateActiveChart((c) => ({
      ...c,
      plotBands: c.plotBands.filter((p) => p._id !== id),
    }));
    if (
      addPanel &&
      addPanel.mode === 'edit' &&
      addPanel.section === 'Plot Band' &&
      addPanel.itemId === id
    ) {
      console.warn('[Configurator] Closing edit panel — plotband was deleted.');
      closeAddPanel();
    }
  }

  // ---- SPC mutators ---------------------------------------------------------
  function handleAddSpc(spc: LineChartSPC) {
    updateActiveChart((c) => ({ ...c, spcs: [...c.spcs, spc] }));
  }

  function handleUpdateSpc(spc: LineChartSPC) {
    updateActiveChart((c) => ({
      ...c,
      spcs: c.spcs.map((s) => (s._id === spc._id ? spc : s)),
    }));
  }

  function handleRemoveSpc(id: string) {
    updateActiveChart((c) => ({
      ...c,
      spcs: c.spcs.filter((s) => s._id !== id),
    }));
    if (
      addPanel &&
      addPanel.mode === 'edit' &&
      addPanel.section === 'Statistical Process Control' &&
      addPanel.itemId === id
    ) {
      console.warn('[Configurator] Closing edit panel — SPC was deleted.');
      closeAddPanel();
    }
  }

  // ---- Anomaly mutators -----------------------------------------------------
  function handleAddAnomaly(anom: LineChartAnomaly) {
    updateActiveChart((c) => ({ ...c, anomalies: [...c.anomalies, anom] }));
  }

  function handleUpdateAnomaly(anom: LineChartAnomaly) {
    updateActiveChart((c) => ({
      ...c,
      anomalies: c.anomalies.map((a) => (a._id === anom._id ? anom : a)),
    }));
  }

  function handleRemoveAnomaly(id: string) {
    updateActiveChart((c) => ({
      ...c,
      anomalies: c.anomalies.filter((a) => a._id !== id),
    }));
    if (
      addPanel &&
      addPanel.mode === 'edit' &&
      addPanel.section === 'Anomaly Highlighting' &&
      addPanel.itemId === id
    ) {
      console.warn('[Configurator] Closing edit panel — anomaly was deleted.');
      closeAddPanel();
    }
  }

  // ---- Chart Settings mutators ---------------------------------------------

  // Save the State-1 first chart from the inline form.
  function handleCreateFirstChart(
    title: string,
    description: string,
    chartType: 'Aggregated' | 'Realtime',
  ) {
    const c = newChart(title, description, chartType);
    const nextCharts = [c];
    setCharts(nextCharts);
    setActiveChartId(c._id);
    setChartEditMode(false);
    setNewChartDraft(false);
    emit({ charts: nextCharts, activeChartId: c._id });
  }

  // Save the new-chart draft (Plus button flow in State 2/4).
  function handleSaveNewChart(
    title: string,
    description: string,
    chartType: 'Aggregated' | 'Realtime',
  ) {
    const c = newChart(title, description, chartType);
    const nextCharts = [...charts, c];
    setCharts(nextCharts);
    setActiveChartId(c._id);
    setNewChartDraft(false);
    setChartEditMode(false);
    emit({ charts: nextCharts, activeChartId: c._id });
  }

  // Save edits to the active chart's title/description/type.
  function handleSaveChartEdits(
    title: string,
    description: string,
    chartType: 'Aggregated' | 'Realtime',
  ) {
    if (!activeChartId) return;
    updateActiveChart((c) => ({
      ...c,
      title: title.trim(),
      description: description.trim() || undefined,
      chartType,
    }));
    setChartEditMode(false);
  }

  // Delete the active chart (after confirm modal).
  function handleDeleteActiveChart() {
    if (!activeChartId) return;
    const remaining = charts.filter((c) => c._id !== activeChartId);
    const nextActive = remaining.length > 0 ? remaining[0]._id : null;
    setCharts(remaining);
    setActiveChartId(nextActive);
    setChartEditMode(false);
    setNewChartDraft(false);
    setPendingDeleteChart(false);
    emit({ charts: remaining, activeChartId: nextActive });
    // Close column 2 if it was open — every CRUD item belonged to that chart.
    if (addPanel) closeAddPanel();
  }

  // ---- Data Table mutators (widget-level — NOT scoped to a chart) ----------
  function handleDataTableEnable(enabled: boolean) {
    const next = { ...dataTable, enabled };
    setDataTable(next);
  }
  function handleDataTableTranspose(transposeTable: boolean) {
    const next = { ...dataTable, transposeTable };
    setDataTable(next);
  }
  function handleDataTableOperators(operators: DataTableOperator[]) {
    // Drop the legacy single-operator field once the array drives selection.
    const next = { ...dataTable, operators };
    delete (next as Partial<DataTableConfig>).operator;
    setDataTable(next);
  }
  function handleDataTableShowUnit(showUnit: boolean) {
    const next = { ...dataTable, showUnit };
    setDataTable(next);
  }
  function handleAddDataTableColumns(columns: DataTableColumn[]) {
    if (columns.length === 0) return;
    const next = { ...dataTable, columns: [...dataTable.columns, ...columns] };
    setDataTable(next);
  }
  // Edit mode: replace the edited column in place with the submitted column(s).
  // Multi-select Existing mode may yield extras, which are inserted at the same
  // position so they appear next to the original.
  function handleReplaceDataTableColumn(replaceId: string, columns: DataTableColumn[]) {
    const next = {
      ...dataTable,
      columns: dataTable.columns.flatMap((c) => (c._id === replaceId ? columns : [c])),
    };
    setDataTable(next);
  }
  function handleRemoveDataTableColumn(id: string) {
    const next = {
      ...dataTable,
      columns: dataTable.columns.filter((c) => c._id !== id),
    };
    setDataTable(next);
    if (
      addPanel &&
      addPanel.mode === 'edit' &&
      addPanel.section === 'Data Table' &&
      addPanel.itemId === id
    ) {
      console.warn('[Configurator] Closing edit panel — column was deleted.');
      closeAddPanel();
    }
  }

  // ---- Time tab mutator ----------------------------------------------------
  function handleTimeConfigChange(next: TimeTabUIConfig) {
    setTimeTabConfig(next);
    emit({ timeTabConfig: next });
  }

  function handleDeviationIndicatorChange(next: DeviationIndicatorMode) {
    setDeviationIndicator(next);
    emit({ deviationIndicator: next });
  }

  function handleAdvanceSettingsChange(next: boolean) {
    setAdvanceSettings(next);
    emit({ advanceSettings: next });
  }

  function handleSeriesDeviationChange(
    chartId: string,
    seriesId: string,
    value: DeviationIndicatorMode,
  ) {
    setCharts((prev) => {
      const next = prev.map((chart) =>
        chart._id !== chartId
          ? chart
          : {
              ...chart,
              series: chart.series.map((s) =>
                s._id === seriesId ? { ...s, deviationIndicator: value } : s,
              ),
            },
      );
      onChange(
        buildEnvelope(
          config,
          {
            charts: next,
            activeChartId,
            dataTable,
            style: styling,
            deviationIndicator,
            advanceSettings,
          },
          timeTabConfig,
        ),
      );
      return next;
    });
  }

  // ---- Styling mutator -----------------------------------------------------
  function handleStylingChange(next: LineChartStyling) {
    setStyling(next);
    emit({ styling: next });
  }

  // Convenience aliases scoped to the active chart (fall back to empty arrays).
  const series: LineChartSeries[] = activeChart?.series ?? [];
  const axes: LineChartAxis[] = activeChart?.axes ?? [];
  const plotLines: LineChartPlotLine[] = activeChart?.plotLines ?? [];
  const plotBands: LineChartPlotBand[] = activeChart?.plotBands ?? [];
  const spcs: LineChartSPC[] = activeChart?.spcs ?? [];
  const anomalies: LineChartAnomaly[] = activeChart?.anomalies ?? [];

  // Per-section counter values (active chart's items + widget-level dataTable).
  const counters = useMemo<Partial<Record<SectionKey, number>>>(
    () => ({
      'Data Source': series.length,
      'Statistical Process Control': spcs.length,
      'Anomaly Highlighting': anomalies.length,
      Axis: axes.length,
      'Plot Line': plotLines.length,
      'Plot Band': plotBands.length,
      'Data Table': dataTable.columns.length,
    }),
    [
      series.length,
      spcs.length,
      anomalies.length,
      axes.length,
      plotLines.length,
      plotBands.length,
      dataTable.columns.length,
    ],
  );

  // Lookup map for series-by-id (used by item-card subtitles).
  const seriesById = useMemo(() => {
    const m = new Map<string, LineChartSeries>();
    series.forEach((s) => m.set(s._id, s));
    return m;
  }, [series]);

  // The current edit-item (if any) — passed to editor as initial draft.
  const editingItem = useMemo(() => {
    if (!addPanel || addPanel.mode !== 'edit') return null;
    switch (addPanel.section) {
      case 'Data Source':
        return series.find((s) => s._id === addPanel.itemId) ?? null;
      case 'Axis':
        return axes.find((a) => a._id === addPanel.itemId) ?? null;
      case 'Plot Line':
        return plotLines.find((p) => p._id === addPanel.itemId) ?? null;
      case 'Plot Band':
        return plotBands.find((p) => p._id === addPanel.itemId) ?? null;
      case 'Statistical Process Control':
        return spcs.find((s) => s._id === addPanel.itemId) ?? null;
      case 'Anomaly Highlighting':
        return anomalies.find((a) => a._id === addPanel.itemId) ?? null;
      case 'Data Table':
        return dataTable.columns.find((c) => c._id === addPanel.itemId) ?? null;
      default:
        return null;
    }
  }, [addPanel, series, axes, plotLines, plotBands, spcs, anomalies, dataTable]);

  // Footer button label inside Column 2.
  const addPanelSubmitLabel = (() => {
    if (!addPanel) return '';
    if (addPanel.mode === 'edit') return 'Save Changes';
    switch (addPanel.section) {
      case 'Data Source':
        return 'Add Source';
      case 'Axis':
        return 'Add Axis';
      case 'Plot Line':
        return 'Add Plotline';
      case 'Plot Band':
        return 'Add Plotband';
      case 'Statistical Process Control':
        return 'Add Process Control';
      case 'Anomaly Highlighting':
        return 'Add Anomaly';
      case 'Data Table':
        return 'Add Data Source';
      default:
        return 'Add';
    }
  })();

  // ---- Render ---------------------------------------------------------------
  return (
    <div className="lc-config" ref={rootRef}>
      <div className="lc-config__shell">
        {/* Column 1: section accordion */}
        <div className="lc-config__col1">
          {/* Sticky header */}
          <div className="lc-config__col1-header">
            <div className="lc-config__col1-header-title">
              <IconButton
                icon={<ArrowLeft size={16} />}
                size="Small"
                accessibilityLabel="Back"
                onClick={() => {
                  /* Placeholder per spec */
                }}
              />
              <span className="lc-config__title BodyMediumSemibold">Line Chart</span>
            </div>
          </div>

          {/* Tabs row */}
          <div className="lc-config__col1-tabs">
            <Tabs
              variant="Bordered"
              size="Medium"
              value={topTab}
              onChange={(v) => setTopTab(v as TopTab)}
              isFullWidthTabItem
            >
              <TabItem value="Data" label="Data" />
              <TabItem value="Time" label="Time" />
              <TabItem value="Style" label="Style" />
            </Tabs>
          </div>

          {/* Scrollable body */}
          <div className="lc-config__col1-body">
            {topTab === 'Data' && (
              <div className="lc-config__accordion">
                {SECTION_ORDER.map((s) => {
                  if (s === 'Chart Settings') {
                    return (
                      <ChartSettingsBlock
                        key={s}
                        charts={charts}
                        activeChart={activeChart}
                        activeChartId={activeChartId}
                        chartEditMode={chartEditMode}
                        newChartDraft={newChartDraft}
                        onSelectChart={(id) => {
                          setActiveChartId(id);
                          emit({ activeChartId: id });
                        }}
                        onChangeChartType={(t) =>
                          updateActiveChart((c) => ({ ...c, chartType: t }))
                        }
                        onCreateFirstChart={handleCreateFirstChart}
                        onSaveNewChart={handleSaveNewChart}
                        onSaveEdits={handleSaveChartEdits}
                        onEnterEditMode={() => {
                          setChartEditMode(true);
                          setNewChartDraft(false);
                          if (addPanel) closeAddPanel();
                        }}
                        onCancelEdit={() => setChartEditMode(false)}
                        onStartNewChart={() => {
                          setNewChartDraft(true);
                          setChartEditMode(false);
                          if (addPanel) closeAddPanel();
                        }}
                        onCancelNewChart={() => setNewChartDraft(false)}
                        onRequestDelete={() => setPendingDeleteChart(true)}
                      />
                    );
                  }
                  const sectionKey = s as Exclude<SectionKey, 'Chart Settings'>;
                  const expanded = expandedSections.has(s);
                  const count = counters[s] ?? 0;
                  const hasCounter = !!COUNTABLE_SECTIONS[s];
                  // Empty state should render rows at full opacity with their `+`
                  // visible. Only grey-out when Chart Settings is being edited.
                  const disabled = inEditMode;
                  const hasItems = hasCounter && count > 0;
                  return (
                    <div
                      key={s}
                      ref={(el) => {
                        rowRefs.current[sectionKey] = el;
                      }}
                    >
                    <ProductAccordionItem
                      title={s}
                      // isActive controls chevron visibility — hide chevron until at least one item exists.
                      isActive={hasItems}
                      isExpanded={expanded && !disabled && hasItems}
                      isDisabled={disabled}
                      trailingIcon={
                        hasItems
                          ? <Badge label={String(count)} color="Neutral" emphasis="Subtle" size="Small" />
                          : undefined
                      }
                      headerAction={
                        !disabled
                          ? <Tooltip bodyText={`Add ${SECTION_ADD_LABEL[sectionKey]}`} placement="Top">
                              <IconButton
                                icon={<Plus size={14} />}
                                size="Small"
                                accessibilityLabel={`Add ${s}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (sectionKey !== 'Data Table') ensureChartExists();
                                  openAddPanel(sectionKey);
                                }}
                              />
                            </Tooltip>
                          : undefined
                      }
                      onToggle={() => {
                        if (disabled || !hasItems) return;
                        toggleSection(s);
                      }}
                    >
                      {/* Body = list of item cards */}
                      <SectionItemList
                        section={sectionKey}
                        series={series}
                        axes={axes}
                        plotLines={plotLines}
                        plotBands={plotBands}
                        spcs={spcs}
                        anomalies={anomalies}
                        dataTable={dataTable}
                        seriesById={seriesById}
                        activeEditItemId={
                          addPanel && addPanel.mode === 'edit' && addPanel.section === sectionKey
                            ? addPanel.itemId
                            : null
                        }
                        onEdit={(id) => openEditPanel(sectionKey, id)}
                        onRemove={(id, title, message) =>
                          setPendingDelete({ section: sectionKey, itemId: id, title, message })
                        }
                        onEnableTable={handleDataTableEnable}
                        onTransposeTable={handleDataTableTranspose}
                        onOperatorChange={handleDataTableOperators}
                        onShowUnitChange={handleDataTableShowUnit}
                      />
                    </ProductAccordionItem>
                    </div>
                  );
                })}
              </div>
            )}

            {topTab === 'Time' && (
              <div className="lc-config__time-tab" ref={timeTabRef}>
                <TimeTabConfiguration
                  value={timeTabConfig}
                  onChange={handleTimeConfigChange}
                  globalTimepickers={globalTimepickers}
                  charts={gtpCharts}
                />
                {/* Deviation indicator + per-source "Advance Settings" are owned
                    by the SDK Time tab natively (`fds-ttc__deviation` cards →
                    timeTabConfig.deviationPattern / sourceDeviationOverrides),
                    which the preview reads directly. Our duplicate
                    `lc-config__deviation-indicator` and "Advance Settings"
                    portals are removed. */}
                {/* Replace the per-source chart Tabs with a single-select
                    "Chart" dropdown (the SDK exposes no prop for this). */}
                <PerSourceChartDropdownPortal scope={timeTabRef} charts={gtpCharts} />
              </div>
            )}

            {topTab === 'Style' && (
              <StylingSection value={styling} onChange={handleStylingChange} />
            )}
          </div>
        </div>

      </div>

      {/* Side-modal Add/Edit panel — positioned 20px to the right of the
          .app__config column, anchored to the clicked accordion row. */}
      {addPanel && (
        <Modal
          {...({ transparent: true } as any)}
          isOpen={true}
          onClose={closeAddPanel}
          positionX={modalAnchor.x}
          positionY={modalAnchor.y}
          className="lc-side-modal"
          header={
            <ModalHeader
              title={`${addPanel.mode === 'edit' ? 'Edit ' : 'Add '}${SECTION_ADD_LABEL[addPanel.section]}`}
              onClose={closeAddPanel}
            />
          }
          footer={
            <ModalFooter
              stacking="Vertical"
              primaryAction={
                <Button
                  variant="Primary"
                  color="Primary"
                  size="Small"
                  isFullWidth
                  label={addPanelSubmitLabel}
                  // Disabled until the active editor reports all required
                  // fields filled (editorBinding is null until the editor mounts).
                  isDisabled={!editorBinding || !editorBinding.isValid}
                  onClick={() => {
                    if (editorBinding && editorBinding.isValid) editorBinding.submit();
                  }}
                />
              }
            />
          }
        >
          <ModalBody>
            <div className="lc-side-modal__body">
              {addPanel.section === 'Data Source' && (
                <DataSourceEditor
                  // Key forces remount on item swap so internal state rehydrates cleanly.
                  key={addPanel.mode === 'edit' ? addPanel.itemId : 'new'}
                  initial={(editingItem as LineChartSeries | null) ?? null}
                  existingCount={series.length}
                  unsTree={unsTree}
                  isLoadingTree={isLoadingTree}
                  loadWorkspaces={loadWorkspaces}
                  resolveUNSValue={resolveUNSValue}
                  onSubmit={(s) => {
                    if (addPanel.mode === 'edit') handleUpdateSeriesItem(s);
                    else handleAddSeries(s);
                    closeAddPanel();
                  }}
                  onReady={setEditorBinding}
                />
              )}
              {addPanel.section === 'Axis' && (
                <AxisEditor
                  key={addPanel.mode === 'edit' ? addPanel.itemId : 'new'}
                  initial={(editingItem as LineChartAxis | null) ?? null}
                  series={series}
                  existingCount={axes.length}
                  unsTree={unsTree}
                  isLoadingTree={isLoadingTree}
                  loadWorkspaces={loadWorkspaces}
                  resolveUNSValue={resolveUNSValue}
                  onSubmit={(a) => {
                    if (addPanel.mode === 'edit') handleUpdateAxis(a);
                    else handleAddAxis(a);
                    closeAddPanel();
                  }}
                  onReady={setEditorBinding}
                />
              )}
              {addPanel.section === 'Plot Line' && (
                <PlotLineEditor
                  key={addPanel.mode === 'edit' ? addPanel.itemId : 'new'}
                  initial={(editingItem as LineChartPlotLine | null) ?? null}
                  existingCount={plotLines.length}
                  unsTree={unsTree}
                  isLoadingTree={isLoadingTree}
                  loadWorkspaces={loadWorkspaces}
                  resolveUNSValue={resolveUNSValue}
                  isRealtime={(activeChart?.chartType ?? 'Aggregated') === 'Realtime'}
                  onSubmit={(p) => {
                    if (addPanel.mode === 'edit') handleUpdatePlotLine(p);
                    else handleAddPlotLine(p);
                    closeAddPanel();
                  }}
                  onReady={setEditorBinding}
                />
              )}
              {addPanel.section === 'Plot Band' && (
                <PlotBandEditor
                  key={addPanel.mode === 'edit' ? addPanel.itemId : 'new'}
                  initial={(editingItem as LineChartPlotBand | null) ?? null}
                  axes={axes}
                  existingCount={plotBands.length}
                  onSubmit={(b) => {
                    if (addPanel.mode === 'edit') handleUpdatePlotBand(b);
                    else handleAddPlotBand(b);
                    closeAddPanel();
                  }}
                  onReady={setEditorBinding}
                />
              )}
              {addPanel.section === 'Statistical Process Control' && (
                <SPCEditor
                  key={addPanel.mode === 'edit' ? addPanel.itemId : 'new'}
                  initial={(editingItem as LineChartSPC | null) ?? null}
                  series={series}
                  existingCount={spcs.length}
                  onSubmit={(spc) => {
                    if (addPanel.mode === 'edit') handleUpdateSpc(spc);
                    else handleAddSpc(spc);
                    closeAddPanel();
                  }}
                  onReady={setEditorBinding}
                />
              )}
              {addPanel.section === 'Anomaly Highlighting' && (
                <AnomalyEditor
                  key={addPanel.mode === 'edit' ? addPanel.itemId : 'new'}
                  initial={(editingItem as LineChartAnomaly | null) ?? null}
                  series={series}
                  existingCount={anomalies.length}
                  unsTree={unsTree}
                  isLoadingTree={isLoadingTree}
                  loadWorkspaces={loadWorkspaces}
                  resolveUNSValue={resolveUNSValue}
                  onSubmit={(a) => {
                    if (addPanel.mode === 'edit') handleUpdateAnomaly(a);
                    else handleAddAnomaly(a);
                    closeAddPanel();
                  }}
                  onReady={setEditorBinding}
                />
              )}
              {addPanel.section === 'Data Table' && (
                <DataTableColumnEditor
                  key={addPanel.mode === 'edit' ? addPanel.itemId : 'new'}
                  initial={(editingItem as DataTableColumn | null) ?? null}
                  series={series}
                  existingCount={dataTable.columns.length}
                  unsTree={unsTree}
                  isLoadingTree={isLoadingTree}
                  loadWorkspaces={loadWorkspaces}
                  resolveUNSValue={resolveUNSValue}
                  onSubmit={(cols) => {
                    if (addPanel.mode === 'edit')
                      handleReplaceDataTableColumn(addPanel.itemId, cols);
                    else handleAddDataTableColumns(cols);
                    closeAddPanel();
                  }}
                  onReady={setEditorBinding}
                />
              )}
            </div>
          </ModalBody>
        </Modal>
      )}

      {/* Confirm delete modal (shared across all CRUD sections) */}
      <ConfirmDeleteModal
        isOpen={!!pendingDelete}
        title={pendingDelete?.title ?? ''}
        message={pendingDelete?.message ?? ''}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (!pendingDelete) return;
          const { section, itemId } = pendingDelete;
          switch (section) {
            case 'Data Source':
              handleRemoveSeries(itemId);
              break;
            case 'Axis':
              handleRemoveAxis(itemId);
              break;
            case 'Plot Line':
              handleRemovePlotLine(itemId);
              break;
            case 'Plot Band':
              handleRemovePlotBand(itemId);
              break;
            case 'Statistical Process Control':
              handleRemoveSpc(itemId);
              break;
            case 'Anomaly Highlighting':
              handleRemoveAnomaly(itemId);
              break;
            case 'Data Table':
              handleRemoveDataTableColumn(itemId);
              break;
          }
          setPendingDelete(null);
        }}
      />

      {/* Confirm delete-chart modal (Chart Settings edit-mode trash icon) */}
      <DeleteChartModal
        isOpen={pendingDeleteChart}
        chartName={activeChart?.title ?? ''}
        onCancel={() => setPendingDeleteChart(false)}
        onConfirm={handleDeleteActiveChart}
      />

      {/* Controlled SDK Tooltip positioned over the Duration section's add
          button (which lives inside the SDK TimeTabConfiguration). */}
      {addDurTooltipRect && (
        <Tooltip
          open
          bodyText="Add Duration"
          placement="Top"
          style={{
            position: 'fixed',
            top: addDurTooltipRect.top,
            left: addDurTooltipRect.left,
            width: addDurTooltipRect.width,
            height: addDurTooltipRect.height,
            pointerEvents: 'none',
          }}
        >
          <span aria-hidden="true" style={{ display: 'block', width: '100%', height: '100%' }} />
        </Tooltip>
      )}
    </div>
  );
}

// ===========================================================================
// Column 1: Chart Settings 4-state block
// ===========================================================================

const CHART_TYPE_OPTIONS: Array<'Aggregated' | 'Realtime'> = ['Aggregated', 'Realtime'];

// Chart Type single-select — shown in every Chart Settings state (create / edit /
// display) so it's always available, not just after the first chart exists.
function ChartTypeSelect({
  value,
  onChange,
  disabled = false,
}: {
  value: 'Aggregated' | 'Realtime';
  onChange: (v: 'Aggregated' | 'Realtime') => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <SelectInput
      label="Chart Type"
      placeholder="Select chart type"
      value={value}
      isDisabled={disabled}
      isOpen={disabled ? false : open}
      onOpenChange={setOpen}
      onClick={() => {
        if (disabled) return;
        setOpen((o) => !o);
      }}
    >
      <DropdownMenu>
        {CHART_TYPE_OPTIONS.map((opt) => (
          <ActionListItem
            key={opt}
            title={opt}
            selectionType="Single"
            isSelected={value === opt}
            onClick={() => {
              onChange(opt);
              setOpen(false);
            }}
          />
        ))}
      </DropdownMenu>
    </SelectInput>
  );
}

interface ChartSettingsBlockProps {
  charts: ChartInstance[];
  activeChart: ChartInstance | null;
  activeChartId: string | null;
  chartEditMode: boolean;
  newChartDraft: boolean;
  onSelectChart: (id: string) => void;
  onChangeChartType: (chartType: 'Aggregated' | 'Realtime') => void;
  onCreateFirstChart: (
    title: string,
    description: string,
    chartType: 'Aggregated' | 'Realtime',
  ) => void;
  onSaveNewChart: (
    title: string,
    description: string,
    chartType: 'Aggregated' | 'Realtime',
  ) => void;
  onSaveEdits: (
    title: string,
    description: string,
    chartType: 'Aggregated' | 'Realtime',
  ) => void;
  onEnterEditMode: () => void;
  onCancelEdit: () => void;
  onStartNewChart: () => void;
  onCancelNewChart: () => void;
  onRequestDelete: () => void;
}

function ChartSettingsBlock({
  charts,
  activeChart,
  activeChartId,
  chartEditMode,
  newChartDraft,
  onSelectChart,
  onChangeChartType,
  onCreateFirstChart,
  onSaveNewChart,
  onSaveEdits,
  onEnterEditMode,
  onCancelEdit,
  onStartNewChart,
  onCancelNewChart,
  onRequestDelete,
}: ChartSettingsBlockProps) {
  // Determine which state this block is in.
  // State 1: no charts. State 2: display (multi-chart and >1 → State 4).
  // State 3: edit mode. New-chart draft uses the State-3-like form layout.
  const isEmpty = charts.length === 0;
  const isMulti = charts.length > 1;

  // Local draft for State-1 inputs (before first save).
  const [draftTitle, setDraftTitle] = useState<string>('');
  const [draftDescription, setDraftDescription] = useState<string>('');

  // Local draft for State 1 (first chart) chart type.
  const [draftChartType, setDraftChartType] = useState<'Aggregated' | 'Realtime'>('Aggregated');

  // Local draft for edit mode — rehydrate when entering edit OR when active chart switches.
  const [editTitle, setEditTitle] = useState<string>(activeChart?.title ?? '');
  const [editDescription, setEditDescription] = useState<string>(activeChart?.description ?? '');
  const [editChartType, setEditChartType] = useState<'Aggregated' | 'Realtime'>(
    activeChart?.chartType ?? 'Aggregated',
  );

  useEffect(() => {
    if (chartEditMode) {
      setEditTitle(activeChart?.title ?? '');
      setEditDescription(activeChart?.description ?? '');
      setEditChartType(activeChart?.chartType ?? 'Aggregated');
    }
  }, [chartEditMode, activeChartId, activeChart]);

  // Local draft for new-chart sub-state.
  const [newTitle, setNewTitle] = useState<string>('');
  const [newDescription, setNewDescription] = useState<string>('');
  const [newChartType, setNewChartType] = useState<'Aggregated' | 'Realtime'>('Aggregated');
  useEffect(() => {
    if (newChartDraft) {
      setNewTitle('');
      setNewDescription('');
      setNewChartType('Aggregated');
    }
  }, [newChartDraft]);

  // -------------------------------------------------------------------------
  // State 1 — empty / initial. No icons. Save button + Add Chart footer
  // appear only after Chart Title gets a value.
  // -------------------------------------------------------------------------
  if (isEmpty) {
    const canSave = draftTitle.trim().length > 0;
    return (
      <div className="lc-config__chart-settings">
        <div className="lc-config__chart-settings-header">
          <span className="BodySmallSemibold">Chart Settings</span>
        </div>
        <div className="lc-config__chart-settings-body">
          <TextInput
            label="Chart Title"
            labelPosition="top"
            placeholder="Enter chart title"
            value={draftTitle}
            necessityIndicator="required"
            onChange={({ value }: { name: string; value: string }) => setDraftTitle(value)}
          />
          <ChartTypeSelect value={draftChartType} onChange={setDraftChartType} />
          <TextInput
            label="Chart Description"
            labelPosition="top"
            placeholder="Enter description"
            value={draftDescription}
            onChange={({ value }: { name: string; value: string }) =>
              setDraftDescription(value)
            }
          />
        </div>
        {canSave && (
          <div className="lc-config__chart-settings-save-inline">
            <Button
              variant="Primary"
              color="Primary"
              size="Medium"
              isFullWidth
              label="Save"
              onClick={() =>
                onCreateFirstChart(draftTitle.trim(), draftDescription.trim(), draftChartType)
              }
            />
          </div>
        )}
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // New-chart sub-state — Plus icon flow OR + Add Chart footer flow.
  // Renders editable inputs + Cancel/Save buttons inside the block.
  // -------------------------------------------------------------------------
  if (newChartDraft) {
    const canSave = newTitle.trim().length > 0;
    return (
      <div className="lc-config__chart-settings lc-config__chart-settings--editing">
        <div className="lc-config__chart-settings-header">
          <span className="BodySmallSemibold">Chart Settings</span>
        </div>
        <div className="lc-config__chart-settings-body">
          <TextInput
            label="Chart Title"
            labelPosition="top"
            placeholder="Enter chart title"
            value={newTitle}
            necessityIndicator="required"
            onChange={({ value }: { name: string; value: string }) => setNewTitle(value)}
          />
          <ChartTypeSelect value={newChartType} onChange={setNewChartType} />
          <TextInput
            label="Chart Description"
            labelPosition="top"
            placeholder="Enter description"
            value={newDescription}
            onChange={({ value }: { name: string; value: string }) =>
              setNewDescription(value)
            }
          />
        </div>
        <div className="lc-config__chart-settings-actions">
          <Button
            variant="Gray"
            color="Primary"
            size="Small"
            label="Cancel"
            onClick={onCancelNewChart}
          />
          <Button
            variant="Primary"
            color="Primary"
            size="Small"
            label="Save"
            isDisabled={!canSave}
            onClick={() => {
              if (!canSave) return;
              onSaveNewChart(newTitle.trim(), newDescription.trim(), newChartType);
            }}
          />
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // State 3 — edit mode (existing chart). Title + Description editable.
  // Heading shows Trash2 (negative). Bottom Cancel/Save inline.
  // -------------------------------------------------------------------------
  if (chartEditMode && activeChart) {
    const canSave = editTitle.trim().length > 0;
    return (
      <div className="lc-config__chart-settings lc-config__chart-settings--editing">
        <div className="lc-config__chart-settings-header">
          <span className="BodySmallSemibold">Chart Settings</span>
          <div className="lc-config__chart-settings-header-actions">
            <span className="lc-config__chart-settings-trash">
              <IconButton
                icon={<Trash2 size={16} />}
                size="Medium"
                emphasis="Intense"
                accessibilityLabel="Delete chart"
                onClick={onRequestDelete}
              />
            </span>
          </div>
        </div>
        <div className="lc-config__chart-settings-body">
          <TextInput
            label="Chart Title"
            labelPosition="top"
            placeholder="Enter chart title"
            value={editTitle}
            necessityIndicator="required"
            onChange={({ value }: { name: string; value: string }) => setEditTitle(value)}
          />
          {/* Chart Type is locked while editing an existing chart — only the
              title/description can change. */}
          <ChartTypeSelect value={editChartType} onChange={setEditChartType} disabled />
          <TextInput
            label="Chart Description"
            labelPosition="top"
            placeholder="Enter description"
            value={editDescription}
            onChange={({ value }: { name: string; value: string }) =>
              setEditDescription(value)
            }
          />
        </div>
        <div className="lc-config__chart-settings-actions">
          <Button
            variant="Gray"
            color="Primary"
            size="Small"
            label="Cancel"
            onClick={onCancelEdit}
          />
          <Button
            variant="Primary"
            color="Primary"
            size="Small"
            label="Save"
            isDisabled={!canSave}
            onClick={() => {
              if (!canSave) return;
              onSaveEdits(editTitle.trim(), editDescription.trim(), editChartType);
            }}
          />
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // State 2 / State 4 — display mode (chart exists, not editing).
  // Heading icons: Plus + Edit2. Title/Description fields disabled.
  // When charts.length > 1 (State 4), Chart Title becomes a SelectInput.
  // -------------------------------------------------------------------------
  return (
    <ChartSettingsDisplayMode
      charts={charts}
      activeChart={activeChart}
      isMulti={isMulti}
      onSelectChart={onSelectChart}
      onChangeChartType={onChangeChartType}
      onStartNewChart={onStartNewChart}
      onEnterEditMode={onEnterEditMode}
    />
  );
}

// Read-only field that matches the Figma display-mode input visual exactly:
// white background, normal border, dark text — no disabled gray treatment.
function ReadOnlyField({
  label,
  value,
  required,
}: {
  label: string;
  value: string;
  required?: boolean;
}) {
  return (
    <div className="lc-config__ro-field">
      <div className="lc-config__ro-field-label BodySmallSemibold">
        {label}
        {required && <span className="lc-config__ro-field-required"> *</span>}
      </div>
      <div className="lc-config__ro-field-input">
        <span className="lc-config__ro-field-value BodyMediumRegular">
          {value || <span className="lc-config__ro-field-placeholder">—</span>}
        </span>
      </div>
    </div>
  );
}

// State 2 / State 4 — display mode. Split out so the dropdown's open state is
// local to the display sub-tree.
interface ChartSettingsDisplayModeProps {
  charts: ChartInstance[];
  activeChart: ChartInstance | null;
  isMulti: boolean;
  onSelectChart: (id: string) => void;
  onChangeChartType: (chartType: 'Aggregated' | 'Realtime') => void;
  onStartNewChart: () => void;
  onEnterEditMode: () => void;
}

function ChartSettingsDisplayMode({
  charts,
  activeChart,
  isMulti,
  onSelectChart,
  onChangeChartType,
  onStartNewChart,
  onEnterEditMode,
}: ChartSettingsDisplayModeProps) {
  const [chartDropdownOpen, setChartDropdownOpen] = useState(false);
  const chartType = activeChart?.chartType ?? 'Aggregated';
  return (
    <div className="lc-config__chart-settings">
      <div className="lc-config__chart-settings-header">
        <span className="BodySmallSemibold">Chart Settings</span>
        <div className="lc-config__chart-settings-header-actions">
          <Tooltip bodyText="Add New Chart" placement="Top">
            <IconButton
              icon={<Plus size={16} />}
              size="Medium"
              emphasis="Subtle"
              accessibilityLabel="Add new chart"
              onClick={onStartNewChart}
            />
          </Tooltip>
          <Tooltip bodyText="Edit Chart" placement="Top">
            <IconButton
              icon={<Edit2 size={16} />}
              size="Medium"
              emphasis="Subtle"
              accessibilityLabel="Edit chart"
              onClick={onEnterEditMode}
            />
          </Tooltip>
        </div>
      </div>
      <div className="lc-config__chart-settings-body">
        {isMulti ? (
          <SelectInput
            label="Chart Title"
            placeholder="Select chart"
            value={activeChart?.title ?? ''}
            isOpen={chartDropdownOpen}
            onOpenChange={setChartDropdownOpen}
            onClick={() => setChartDropdownOpen((o) => !o)}
          >
            <DropdownMenu>
              {charts.map((c) => (
                <ActionListItem
                  key={c._id}
                  title={c.title || 'Untitled Chart'}
                  selectionType="Single"
                  isSelected={c._id === activeChart?._id}
                  onClick={() => {
                    onSelectChart(c._id);
                    setChartDropdownOpen(false);
                  }}
                />
              ))}
            </DropdownMenu>
          </SelectInput>
        ) : (
          <ReadOnlyField
            label="Chart Title"
            value={activeChart?.title ?? ''}
            required
          />
        )}
        <ChartTypeSelect value={chartType} onChange={onChangeChartType} />
        <ReadOnlyField
          label="Chart Description"
          value={activeChart?.description ?? ''}
        />
      </div>
    </div>
  );
}

// ===========================================================================
// Column 1: Item-card list per section
// ===========================================================================

interface SectionItemListProps {
  section: Exclude<SectionKey, 'Chart Settings'>;
  series: LineChartSeries[];
  axes: LineChartAxis[];
  plotLines: LineChartPlotLine[];
  plotBands: LineChartPlotBand[];
  spcs: LineChartSPC[];
  anomalies: LineChartAnomaly[];
  dataTable: DataTableConfig;
  seriesById: Map<string, LineChartSeries>;
  activeEditItemId: string | null;
  onEdit: (id: string) => void;
  onRemove: (id: string, title: string, message: string) => void;
  onEnableTable: (enabled: boolean) => void;
  onTransposeTable: (transpose: boolean) => void;
  onOperatorChange: (ops: DataTableOperator[]) => void;
  onShowUnitChange: (show: boolean) => void;
}

function SectionItemList({
  section,
  series,
  axes,
  plotLines,
  plotBands,
  spcs,
  anomalies,
  dataTable,
  seriesById,
  activeEditItemId,
  onEdit,
  onRemove,
  onEnableTable: _onEnableTable,
  onTransposeTable,
  onOperatorChange,
  onShowUnitChange,
}: SectionItemListProps) {
  const [dtOperatorOpen, setDtOperatorOpen] = useState(false);

  const selectedOperators = resolveDataTableOperators(dataTable);
  function toggleOperator(op: DataTableOperator) {
    const next = selectedOperators.includes(op)
      ? selectedOperators.filter((o) => o !== op)
      : [...selectedOperators, op];
    // Keep at least one operator selected.
    onOperatorChange(next.length ? next : selectedOperators);
  }
  const operatorTags = selectedOperators.map((op) => ({
    label: DATA_TABLE_OPERATOR_LABELS[op],
    onDismiss: () => toggleOperator(op),
  }));

  // Data Table is special — has section-level controls inline.
  if (section === 'Data Table') {
    return (
      <>
        <SelectInput
          label="Operator"
          multiType="multiple"
          isRequired
          placeholder="Select operators"
          tags={operatorTags}
          isOpen={dtOperatorOpen}
          onOpenChange={setDtOperatorOpen}
          onBackspace={() => {
            if (selectedOperators.length > 1)
              onOperatorChange(selectedOperators.slice(0, -1));
          }}
        >
          <DropdownMenu>
            {DATA_TABLE_OPERATOR_OPTIONS.map((op) => (
              <ActionListItem
                key={op}
                title={DATA_TABLE_OPERATOR_LABELS[op]}
                selectionType="Multiple"
                isSelected={selectedOperators.includes(op)}
                onClick={() => toggleOperator(op)}
              />
            ))}
          </DropdownMenu>
        </SelectInput>

        <Checkbox
          label="Transpose Table"
          isChecked={dataTable.transposeTable}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => onTransposeTable(e.target.checked)}
        />
        <Checkbox
          label="Show Unit"
          isChecked={dataTable.showUnit ?? true}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => onShowUnitChange(e.target.checked)}
        />

        {dataTable.columns.length === 0 ? (
          <p className="lc-config__empty BodySmallRegular">
            No items yet — click + to add
          </p>
        ) : (
          dataTable.columns.map((column) => {
            const title = deriveDataTableColumnLabel(column, seriesById);
            const subtitle =
              column.sourceMode === 'Existing' ? 'Type: Existing' : 'Type: UNS';
            return (
              <ItemCard
                key={column._id}
                title={title}
                subtitle={subtitle}
                isActive={activeEditItemId === column._id}
                onClick={() => onEdit(column._id)}
                onRemove={() =>
                  onRemove(
                    column._id,
                    'Delete Data Source',
                    'Are you sure you want to delete this data source? This column will be removed.',
                  )
                }
              />
            );
          })
        )}
      </>
    );
  }

  if (section === 'Data Source') {
    if (series.length === 0) {
      return (
        <p className="lc-config__empty BodySmallRegular">No items yet — click + to add</p>
      );
    }
    return (
      <>
        {series.map((s) => {
          const subtitle = s.dataSource
            ? VARIABLE_REGEX.test(s.dataSource.trim())
              ? 'Live data'
              : s.dataSource.length > 28
                ? `${s.dataSource.slice(0, 28)}…`
                : s.dataSource
            : 'No topic set';
          return (
            <ItemCard
              key={s._id}
              title={s.name || 'Data Source'}

              swatchColor={s.color}
              isActive={activeEditItemId === s._id}
              onClick={() => onEdit(s._id)}
              onRemove={() =>
                onRemove(
                  s._id,
                  'Delete Data Source',
                  'Are you sure you want to delete this data source? This action is irreversible.',
                )
              }
            />
          );
        })}
      </>
    );
  }

  if (section === 'Axis') {
    if (axes.length === 0) {
      return (
        <p className="lc-config__empty BodySmallRegular">No items yet — click + to add</p>
      );
    }
    return (
      <>
        {axes.map((a) => (
          <ItemCard
            key={a._id}
            title={a.name}
            subtitle={`Position: ${a.position}`}
            isActive={activeEditItemId === a._id}
            onClick={() => onEdit(a._id)}
            onRemove={() =>
              onRemove(
                a._id,
                'Delete Axis',
                'Are you sure you want to delete this axis? Once deleted, this axis cannot be restored. All linked data sources will automatically switch to the default axis.',
              )
            }
          />
        ))}
      </>
    );
  }

  if (section === 'Plot Line') {
    if (plotLines.length === 0) {
      return (
        <p className="lc-config__empty BodySmallRegular">No items yet — click + to add</p>
      );
    }
    return (
      <>
        {plotLines.map((p) => (
          <ItemCard
            key={p._id}
            title={p.name}

            swatchColor={p.color}
            isActive={activeEditItemId === p._id}
            onClick={() => onEdit(p._id)}
            onRemove={() =>
              onRemove(
                p._id,
                'Delete Plotline',
                'Are you sure you want to delete this plotline? Once deleted, this plotline cannot be restored.',
              )
            }
          />
        ))}
      </>
    );
  }

  if (section === 'Plot Band') {
    if (plotBands.length === 0) {
      return (
        <p className="lc-config__empty BodySmallRegular">No items yet — click + to add</p>
      );
    }
    return (
      <>
        {plotBands.map((b) => (
          <ItemCard
            key={b._id}
            title={b.name}

            swatchColor={b.color}
            isActive={activeEditItemId === b._id}
            onClick={() => onEdit(b._id)}
            onRemove={() =>
              onRemove(
                b._id,
                'Delete Plotband',
                'Are you sure you want to delete this plotband? Once deleted, this plotband cannot be restored.',
              )
            }
          />
        ))}
      </>
    );
  }

  if (section === 'Statistical Process Control') {
    if (spcs.length === 0) {
      return (
        <p className="lc-config__empty BodySmallRegular">No items yet — click + to add</p>
      );
    }
    return (
      <>
        {spcs.map((spc) => {
          const title = deriveSpcDisplayName(spc, seriesById);
          const swatch =
            spc.average?.lineColor ||
            spc.median?.lineColor ||
            spc.standardDeviation?.lineColor ||
            '#e4553d';
          return (
            <ItemCard
              key={spc._id}
              title={title}
              swatchColor={swatch}
              isActive={activeEditItemId === spc._id}
              onClick={() => onEdit(spc._id)}
              onRemove={() =>
                onRemove(
                  spc._id,
                  'Delete Process Control',
                  'Are you sure you want to delete this process control? Once deleted, it cannot be restored.',
                )
              }
            />
          );
        })}
      </>
    );
  }

  if (section === 'Anomaly Highlighting') {
    if (anomalies.length === 0) {
      return (
        <p className="lc-config__empty BodySmallRegular">No items yet — click + to add</p>
      );
    }
    return (
      <>
        {anomalies.map((anom) => {
          const sourceName = seriesById.get(anom.applyToSeriesId)?.name ?? '—';
          return (
            <ItemCard
              key={anom._id}
              title={anom.name}

              swatchColor={anom.color}
              isActive={activeEditItemId === anom._id}
              onClick={() => onEdit(anom._id)}
              onRemove={() =>
                onRemove(
                  anom._id,
                  'Delete Anomaly',
                  'Are you sure you want to delete this anomaly? Once deleted, it cannot be restored.',
                )
              }
            />
          );
        })}
      </>
    );
  }

  return null;
}

function deriveDataTableColumnLabel(
  column: DataTableColumn,
  seriesById: Map<string, LineChartSeries>,
): string {
  if (column.sourceMode === 'Existing' && column.seriesId) {
    const s = seriesById.get(column.seriesId);
    if (s) return s.name || `Series ${column.seriesId}`;
  }
  if (column.sourceMode === 'AddNew') {
    if (column.name?.trim()) return column.name.trim();
    if (column.topic) {
      const unwrapped = column.topic.replace(/^\{\{(.+)\}\}$/, '$1');
      const parts = unwrapped.split('/');
      return parts[parts.length - 1] || 'UNS Source';
    }
  }
  return 'Data Source';
}

// ===========================================================================
// Deviation indicator — injected directly after the SDK's Comparison Mode row
// via React Portal. SDK 0.5.12 doesn't expose this control yet, so we locate
// the .fds-ttc__switch-row containing "Comparison Mode" and mount our selector
// into a placeholder div inserted as its next sibling.
// ===========================================================================

const PORTAL_PLACEHOLDER_CLASS = 'lc-config__deviation-indicator-portal';

function findComparisonModeRow(root: HTMLElement): HTMLElement | null {
  const rows = root.querySelectorAll<HTMLElement>('.fds-ttc__switch-row');
  for (const row of Array.from(rows)) {
    const label = row.querySelector('.fds-ttc__switch-label');
    if (label?.textContent?.trim().startsWith('Comparison Mode')) {
      return row;
    }
  }
  return null;
}

function DeviationIndicatorPortal({
  scope,
  enabled,
  value,
  faded,
  onChange,
}: {
  scope: React.RefObject<HTMLDivElement | null>;
  enabled: boolean;
  value: DeviationIndicatorMode;
  faded?: boolean;
  onChange: (v: DeviationIndicatorMode) => void;
}) {
  const [target, setTarget] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const root = scope.current;
    if (!root) return;

    function ensurePlaceholder(): HTMLElement | null {
      if (!root) return null;
      const cmRow = findComparisonModeRow(root);
      if (!cmRow) return null;
      const next = cmRow.nextElementSibling;
      if (next instanceof HTMLElement && next.classList.contains(PORTAL_PLACEHOLDER_CLASS)) {
        return next;
      }
      const placeholder = document.createElement('div');
      placeholder.className = PORTAL_PLACEHOLDER_CLASS;
      cmRow.parentNode!.insertBefore(placeholder, cmRow.nextSibling);
      return placeholder;
    }

    function update() {
      const next = ensurePlaceholder();
      setTarget((curr) => (curr === next ? curr : next));
    }

    // Try immediately, then again after a microtask in case the SDK isn't
    // fully committed yet.
    update();
    queueMicrotask(update);

    // Observe the whole wrapper subtree for DOM changes so we re-attach when
    // the SDK remounts its internal sections.
    const observer = new MutationObserver(update);
    observer.observe(root, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      // Intentionally do NOT remove the placeholder on cleanup; React StrictMode
      // double-invokes effects in dev, and removing here would leave the second
      // mount with a stale target ref. The placeholder is harmless to keep.
    };
  }, [scope]);

  if (!enabled || !target) return null;
  return createPortal(
    <DeviationIndicatorSelector value={value} faded={faded} onChange={onChange} />,
    target,
  );
}

// ===========================================================================
// Per-source chart selector → "Chart" dropdown. The SDK renders the per-source
// deviation section's chart switcher as a Tabs strip; we hide that strip and
// inject a single-select "Chart" dropdown that drives the (hidden) tabs by
// clicking the matching tab button. Mounts whenever the SDK's
// `.fds-ttc__per-source` section is present (Comparison Mode + Advance Settings).
// ===========================================================================

const PER_SOURCE_SELECT_CLASS = 'lc-config__per-source-chart-select';

function PerSourceChartDropdownPortal({
  scope,
  charts,
}: {
  scope: React.RefObject<HTMLDivElement | null>;
  charts: GTPChart[];
}) {
  const [target, setTarget] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const root = scope.current;
    if (!root) return;
    function ensure() {
      if (!root) return;
      const perSource = root.querySelector('.fds-ttc__per-source');
      const tabs = perSource?.querySelector(':scope > .fds-tabs') as HTMLElement | null;
      if (!perSource || !tabs) {
        setTarget((t) => (t ? null : t));
        return;
      }
      let ph = perSource.querySelector(
        `:scope > .${PER_SOURCE_SELECT_CLASS}`,
      ) as HTMLElement | null;
      if (!ph) {
        ph = document.createElement('div');
        ph.className = PER_SOURCE_SELECT_CLASS;
        tabs.parentNode!.insertBefore(ph, tabs);
      }
      setTarget((curr) => (curr === ph ? curr : ph));
    }
    ensure();
    const obs = new MutationObserver(ensure);
    obs.observe(root, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, [scope]);

  if (!target) return null;
  return createPortal(<PerSourceChartSelect charts={charts} target={target} />, target);
}

function PerSourceChartSelect({
  charts,
  target,
}: {
  charts: GTPChart[];
  target: HTMLElement;
}) {
  const tabsRoot = target.parentElement?.querySelector(
    ':scope > .fds-tabs',
  ) as HTMLElement | null;
  const readActive = () =>
    (tabsRoot?.querySelector('.fds-tab-item--selected') as HTMLElement | null)?.getAttribute(
      'data-value',
    ) ||
    charts[0]?.id ||
    '';
  const [selected, setSelected] = useState(readActive());
  const [open, setOpen] = useState(false);

  // Re-sync if the chart set changes (keep a valid selection).
  useEffect(() => {
    setSelected((s) => (charts.some((c) => c.id === s) ? s : readActive()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [charts.map((c) => c.id).join('|')]);

  const pickChart = (id: string) => {
    setSelected(id);
    setOpen(false);
    // Drive the SDK's (hidden) tabs — a programmatic click fires the tab's
    // onClick even though the strip is display:none.
    const btn = tabsRoot?.querySelector(
      `.fds-tab-item[data-value="${id}"]`,
    ) as HTMLElement | null;
    btn?.click();
  };

  return (
    <div className="lc-config__per-source-chart-field">
      <SelectInput
        label="Chart"
        value={charts.find((c) => c.id === selected)?.name ?? ''}
        isOpen={open}
        onOpenChange={setOpen}
        onClick={() => setOpen((o) => !o)}
      >
        <DropdownMenu>
          {charts.map((c) => (
            <ActionListItem
              key={c.id}
              title={c.name}
              selectionType="Single"
              isSelected={c.id === selected}
              onClick={() => pickChart(c.id)}
            />
          ))}
        </DropdownMenu>
      </SelectInput>
    </div>
  );
}

// ===========================================================================
// Advance Settings — per-series deviation indicator override panel.
// Injected directly after the deviation indicator portal placeholder when
// comparison mode is on. Toggle renders an "Advance Settings" switch; when ON,
// shows Chart tabs + per-series icon-toggle rows so users can override the
// global deviation convention on a per-series basis. The global cards above
// fade to indicate they've become defaults.
// ===========================================================================

const ADVANCE_PORTAL_CLASS = 'lc-config__advance-settings-portal';

function AdvanceSettingsPortal({
  scope,
  enabled,
  open,
  onChange,
  charts,
  onSeriesDeviationChange,
  globalDefault,
}: {
  scope: React.RefObject<HTMLDivElement | null>;
  enabled: boolean;
  open: boolean;
  onChange: (next: boolean) => void;
  charts: ChartInstance[];
  onSeriesDeviationChange: (chartId: string, seriesId: string, value: DeviationIndicatorMode) => void;
  globalDefault: DeviationIndicatorMode;
}) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [activeChartIdx, setActiveChartIdx] = useState(0);

  useEffect(() => {
    const root = scope.current;
    if (!root) return;

    function ensurePlaceholder(): HTMLElement | null {
      if (!root) return null;
      // Mount directly after the deviation indicator portal placeholder so the
      // Advance Settings toggle sits visually right below the global cards.
      // If the deviation portal isn't present yet (comparison mode off), fall
      // back to inserting after the Comparison Mode switch row.
      let anchor: HTMLElement | null = root.querySelector(
        `.${PORTAL_PLACEHOLDER_CLASS}`,
      );
      if (!anchor) {
        anchor = findComparisonModeRow(root);
        if (!anchor) return null;
      }
      const next = anchor.nextElementSibling;
      if (next instanceof HTMLElement && next.classList.contains(ADVANCE_PORTAL_CLASS)) {
        return next;
      }
      const placeholder = document.createElement('div');
      placeholder.className = ADVANCE_PORTAL_CLASS;
      anchor.parentNode!.insertBefore(placeholder, anchor.nextSibling);
      return placeholder;
    }

    function update() {
      const placeholder = ensurePlaceholder();
      setTarget((curr) => (curr === placeholder ? curr : placeholder));
    }

    update();
    queueMicrotask(update);

    const observer = new MutationObserver(update);
    observer.observe(root, { childList: true, subtree: true });

    return () => observer.disconnect();
  }, [scope]);

  // Keep activeChartIdx in range as charts mutate.
  useEffect(() => {
    if (activeChartIdx >= charts.length && charts.length > 0) {
      setActiveChartIdx(0);
    }
  }, [charts.length, activeChartIdx]);

  if (!enabled || !target) return null;
  const activeChart = charts[activeChartIdx];
  return createPortal(
    <div className="lc-config__advance-settings">
      <label className="lc-config__advance-settings__toggle-row">
        <span className="lc-config__advance-settings__label LabelMediumSemiBold">
          Advance Settings
        </span>
        <Switch
          name="advanceSettings"
          accessibilityLabel="Advance Settings"
          isChecked={open}
          onChange={({ isChecked }: { isChecked: boolean }) => onChange(isChecked)}
        />
      </label>
      {open && (
        <div className="lc-config__advance-settings__body">
          {charts.length === 0 ? (
            <p className="lc-config__advance-settings__empty BodySmallRegular">
              Add at least one chart on the Data tab to configure per-series deviation overrides.
            </p>
          ) : (
            <>
              {charts.length > 1 && (
                <div className="lc-config__advance-settings__chart-tabs">
                  {charts.map((c, i) => (
                    <button
                      key={c._id}
                      type="button"
                      className={`lc-config__advance-settings__chart-tab${i === activeChartIdx ? ' lc-config__advance-settings__chart-tab--active' : ''}`}
                      onClick={() => setActiveChartIdx(i)}
                    >
                      {c.title || `Chart ${i + 1}`}
                    </button>
                  ))}
                </div>
              )}
              {!activeChart || activeChart.series.length === 0 ? (
                <p className="lc-config__advance-settings__empty BodySmallRegular">
                  No series in this chart yet — add one on the Data tab.
                </p>
              ) : (
                activeChart.series.map((s) => {
                  const mode = s.deviationIndicator ?? globalDefault;
                  return (
                    <div key={s._id} className="lc-config__advance-settings__series-row">
                      <span
                        className="lc-config__advance-settings__series-name BodyMediumRegular"
                        title={s.name || 'Series'}
                      >
                        {s.name || 'Series'}
                      </span>
                      <ComparisonToggle
                        value={mode === 'inverse' ? 'right' : 'left'}
                        onValueChange={(v) =>
                          onSeriesDeviationChange(
                            activeChart._id,
                            s._id,
                            v === 'right' ? 'inverse' : 'standard',
                          )
                        }
                      />
                    </div>
                  );
                })
              )}
            </>
          )}
        </div>
      )}
    </div>,
    target,
  );
}

function DeviationIndicatorSelector({
  value,
  faded,
  onChange,
}: {
  value: DeviationIndicatorMode;
  faded?: boolean;
  onChange: (v: DeviationIndicatorMode) => void;
}) {
  return (
    <div className={`lc-config__deviation-indicator${faded ? ' lc-config__deviation-indicator--faded' : ''}`}>
      <p className="lc-config__deviation-indicator__caption BodySmallRegular">
        General Behaviour of Deviation Indicator, In Tooltip
      </p>
      <button
        type="button"
        className={`lc-config__deviation-indicator__card${value === 'standard' ? ' lc-config__deviation-indicator__card--active' : ''}`}
        onClick={() => onChange('standard')}
      >
        <span className="lc-config__deviation-indicator__icons">
          <span className="lc-config__deviation-indicator__arrow lc-config__deviation-indicator__arrow--up-green">▲</span>
          <span className="lc-config__deviation-indicator__arrow lc-config__deviation-indicator__arrow--down-red">▼</span>
        </span>
        <span className="lc-config__deviation-indicator__label BodySmallRegular">
          Green up = positive<br />Red down = negative
        </span>
      </button>
      <button
        type="button"
        className={`lc-config__deviation-indicator__card${value === 'inverse' ? ' lc-config__deviation-indicator__card--active' : ''}`}
        onClick={() => onChange('inverse')}
      >
        <span className="lc-config__deviation-indicator__icons">
          <span className="lc-config__deviation-indicator__arrow lc-config__deviation-indicator__arrow--up-red">▲</span>
          <span className="lc-config__deviation-indicator__arrow lc-config__deviation-indicator__arrow--down-green">▼</span>
        </span>
        <span className="lc-config__deviation-indicator__label BodySmallRegular">
          Red up = positive<br />Green down = negative
        </span>
      </button>
    </div>
  );
}

// ===========================================================================
// Generic item card — thin adapter around design-sdk's ListCard.
// All visual primitives (swatch, title row, trailing trash icon) come from
// ListCard + ListCardLeadingItem + ListCardTrailingItem.
// ===========================================================================

interface ItemCardProps {
  title: string;
  subtitle?: string;
  swatchColor?: string;
  isActive: boolean;
  onClick: () => void;
  onRemove: () => void;
}

function ItemCard({
  title,
  subtitle,
  swatchColor,
  isActive,
  onClick,
  onRemove,
}: ItemCardProps) {
  return (
    <ListCard
      title={title}
      subtitle={subtitle}
      isSelected={isActive}
      onClick={onClick}
      leadingItem={
        swatchColor
          ? <ListCardLeadingItem leading="Color" color={swatchColor} />
          : undefined
      }
      trailingItems={
        <ListCardTrailingItem
          trailing="Icon"
          icon={
            <IconButton
              icon={<Trash2 size={14} />}
              size="Medium"
              emphasis="Subtle"
              accessibilityLabel={`Remove ${title}`}
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
            />
          }
        />
      }
    />
  );
}

// ===========================================================================
// Editor binding hook — keeps parent footer in sync with editor validity.
// ===========================================================================

function useEditorBinding(
  isValid: boolean,
  submit: () => void,
  onReady: (b: EditorBinding) => void,
) {
  // Always pass latest closure so submit captures fresh state.
  useEffect(() => {
    onReady({ isValid, submit });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isValid, submit, onReady]);
}

// ===========================================================================
// Editor: Data Source (Series)
// ===========================================================================

interface DataSourceEditorProps {
  initial: LineChartSeries | null;
  existingCount: number;
  unsTree: import('@faclon-labs/design-sdk/UNSPathInput').UNSTree;
  isLoadingTree: boolean;
  loadWorkspaces: () => void;
  resolveUNSValue: (raw: string) => string;
  onSubmit: (s: LineChartSeries) => void;
  onReady: (b: EditorBinding) => void;
}

function DataSourceEditor({
  initial,
  existingCount,
  unsTree,
  isLoadingTree,
  loadWorkspaces,
  resolveUNSValue,
  onSubmit,
  onReady,
}: DataSourceEditorProps) {
  const [name, setName] = useState(initial?.name ?? '');
  const [color, setColor] = useState(
    initial?.color ?? DEFAULT_COLORS[existingCount % DEFAULT_COLORS.length],
  );
  const [dataSource, setDataSource] = useState(initial?.dataSource ?? '');
  const [dataPrecision, setDataPrecision] = useState(
    initial?.dataPrecision !== undefined ? String(initial.dataPrecision) : '2',
  );
  const [limit, setLimit] = useState(initial?.limit ?? '');
  const [addAsTooltip, setAddAsTooltip] = useState(initial?.addAsTooltip ?? false);

  // Name, Color and UNS Path are mandatory.
  const isValid =
    name.trim().length > 0 &&
    color.trim().length > 0 &&
    dataSource.trim().length > 0;

  const submit = useCallback(() => {
    if (!isValid) return;
    onSubmit({
      _id: initial?._id ?? `series_${Date.now()}_${existingCount}`,
      name: name.trim(),
      color: color || DEFAULT_COLORS[existingCount % DEFAULT_COLORS.length],
      dataSource,
      dataPrecision: dataPrecision ? Number(dataPrecision) : undefined,
      limit: limit || undefined,
      addAsTooltip: addAsTooltip || undefined,
    });
  }, [
    isValid, initial, existingCount, name, color, dataSource,
    dataPrecision, limit, addAsTooltip, onSubmit,
  ]);

  useEditorBinding(isValid, submit, onReady);

  return (
    <div className="lc-config__editor">
      {/* Name */}
      <TextInput
        label="Name"
        labelPosition="top"
        placeholder="Enter source name"
        value={name}
        necessityIndicator="required"
        onChange={({ value }: { name: string; value: string }) => setName(value)}
      />

      {/* Color */}
      <ColorInput
        label="Color *"
        placeholder="Select color"
        value={color}
        onChange={(hex) => setColor(hex)}
      />

      {/* UNS Path */}
      <UNSPathInput
        label="UNS Path"
        necessityIndicator="required"
        placeholder="Enter UNS Path"
        value={dataSource}
        tree={unsTree}
        isLoading={isLoadingTree}
        onOpen={loadWorkspaces}
        onChange={(value) => setDataSource(resolveUNSValue(value))}
      />

      {/* Data Precision + Unit */}
      <div className="lc-config__ds-row lc-config__ds-row--halves">
        <TextInput
          label="Data Precision"
          labelPosition="top"
          type="number"
          placeholder="Enter value"
          value={dataPrecision}
          onChange={({ value }: { name: string; value: string }) => setDataPrecision(value)}
        />
        <TextInput
          label="Unit"
          labelPosition="top"
          placeholder="Enter value"
          value={limit}
          onChange={({ value }: { name: string; value: string }) => setLimit(value)}
        />
      </div>

      {/* Add Source as Tooltip */}
      <Checkbox
        size="Medium"
        isChecked={addAsTooltip}
        onChange={(e) => setAddAsTooltip(e.target.checked)}
      >
        Add Source as Tooltip
      </Checkbox>
    </div>
  );
}

// ===========================================================================
// Editor: Axis
// ===========================================================================

interface AxisEditorProps {
  initial: LineChartAxis | null;
  series: LineChartSeries[];
  existingCount: number;
  unsTree: import('@faclon-labs/design-sdk/UNSPathInput').UNSTree;
  isLoadingTree: boolean;
  loadWorkspaces: () => void;
  resolveUNSValue: (raw: string) => string;
  onSubmit: (a: LineChartAxis) => void;
  onReady: (b: EditorBinding) => void;
}

function AxisEditor({
  initial,
  series,
  existingCount,
  onSubmit,
  onReady,
}: AxisEditorProps) {
  const [name, setName] = useState(initial?.name ?? '');
  const [position, setPosition] = useState<'Left' | 'Right'>(initial?.position ?? 'Left');
  // Data Source is now a multi-select of the added series (linkedSeriesIds).
  const [linkedSeriesIds, setLinkedSeriesIds] = useState<string[]>(
    initial?.linkedSeriesIds ?? [],
  );
  const [dsOpen, setDsOpen] = useState(false);
  // Search text for the autocomplete input. Wiring onInputChange is also what
  // keeps the multi-select field interactive (without it the SDK forces the
  // field into a read-only / disabled-looking state).
  const [dsSearch, setDsSearch] = useState('');

  const seriesById = useMemo(() => {
    const m = new Map<string, LineChartSeries>();
    series.forEach((s) => m.set(s._id, s));
    return m;
  }, [series]);

  const filteredSeries = useMemo(() => {
    const q = dsSearch.trim().toLowerCase();
    if (!q) return series;
    return series.filter((s) => (s.name || '').toLowerCase().includes(q));
  }, [series, dsSearch]);

  function toggleSeries(id: string) {
    setLinkedSeriesIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
    setDsSearch('');
  }

  // Name + at least one Data Source are required (per design).
  const isValid = name.trim().length > 0 && linkedSeriesIds.length > 0;

  const submit = useCallback(() => {
    if (!isValid) return;
    onSubmit({
      _id: initial?._id ?? `axis_${Date.now()}_${existingCount}`,
      name: name.trim(),
      position,
      // Bindable UNS path is preserved from the existing axis; the Data Source
      // field now drives which series feed this axis.
      dataSource: initial?.dataSource ?? '',
      linkedSeriesIds,
    });
  }, [isValid, initial, existingCount, name, position, linkedSeriesIds, onSubmit]);

  useEditorBinding(isValid, submit, onReady);

  const tags = linkedSeriesIds.map((id) => ({
    label: seriesById.get(id)?.name || 'Untitled',
    onDismiss: () => toggleSeries(id),
  }));

  return (
    <div className="lc-config__editor">
      <TextInput
        label="Name"
        labelPosition="top"
        placeholder="Enter axis name"
        value={name}
        necessityIndicator="required"
        onChange={({ value }: { name: string; value: string }) => setName(value)}
      />
      <SelectInput
        label="Data Source"
        multiType="multiple"
        isRequired
        placeholder={series.length === 0 ? 'No data sources available' : 'Select data sources'}
        tags={tags}
        isOpen={dsOpen}
        onOpenChange={setDsOpen}
        inputValue={dsSearch}
        onInputChange={setDsSearch}
        onBackspace={() => setLinkedSeriesIds((prev) => prev.slice(0, -1))}
        isDisabled={series.length === 0}
      >
        <DropdownMenu emptyTitle="No matching data sources">
          {filteredSeries.map((s) => (
            <ActionListItem
              key={s._id}
              title={s.name || `Series ${s._id}`}
              selectionType="Multiple"
              isSelected={linkedSeriesIds.includes(s._id)}
              onClick={() => toggleSeries(s._id)}
            />
          ))}
        </DropdownMenu>
      </SelectInput>
      <RadioGroup
        label="Axis Position"
        name="axis-position"
        value={position}
        onChange={({ value }) => setPosition(value as 'Left' | 'Right')}
        orientation="Horizontal"
        size="Medium"
      >
        <Radio label="Left" value="Left" size="Medium" />
        <Radio label="Right" value="Right" size="Medium" />
      </RadioGroup>
    </div>
  );
}

// ===========================================================================
// Editor: Plot Line
// ===========================================================================

const PERIODICITY_OPTIONS = ['Hourly', 'Daily', 'Weekly', 'Monthly', 'Quarterly'];
const LINE_STYLE_OPTIONS: PlotLineStyle[] = ['Solid', 'Dashed'];
const DURATION_TYPE_OPTIONS = ['Fixed', 'Custom'];

interface PlotLineEditorProps {
  initial: LineChartPlotLine | null;
  existingCount: number;
  unsTree: import('@faclon-labs/design-sdk/UNSPathInput').UNSTree;
  isLoadingTree: boolean;
  loadWorkspaces: () => void;
  resolveUNSValue: (raw: string) => string;
  onSubmit: (line: LineChartPlotLine) => void;
  onReady: (b: EditorBinding) => void;
  // When the chart is Realtime, periodicity-dependent plotlines are unavailable.
  isRealtime?: boolean;
}

function PlotLineEditor({
  initial,
  existingCount,
  unsTree,
  isLoadingTree,
  loadWorkspaces,
  resolveUNSValue,
  onSubmit,
  onReady,
  isRealtime = false,
}: PlotLineEditorProps) {
  const [name, setName] = useState(initial?.name ?? '');
  const [color, setColor] = useState(initial?.color ?? '#3b82f6');
  // In Realtime, only Independent plotlines exist — force the editor to that
  // type so a previously-Dependent line edited here doesn't expose periodicity.
  const [type, setType] = useState<PlotLineType>(
    isRealtime ? 'Independent' : initial?.type ?? 'Independent',
  );
  const [valueType, setValueType] = useState<PlotLineValueType>(
    initial?.valueType ?? 'Fixed',
  );
  const [valueTypeOpen, setValueTypeOpen] = useState(false);
  const [fixedValue, setFixedValue] = useState(initial?.fixedValue ?? '');
  const [dynamicTopic, setDynamicTopic] = useState(initial?.dynamicTopic ?? '');
  const [dataPrecision, setDataPrecision] = useState<string>(
    typeof initial?.dataPrecision === 'number' ? String(initial.dataPrecision) : '',
  );
  const [unit, setUnit] = useState(initial?.unit ?? '');
  const [periodicities, setPeriodicities] = useState<PlotLinePeriodicityEntry[]>(
    initial?.periodicities ?? [],
  );
  const [durationType, setDurationType] = useState(initial?.durationType ?? 'Custom');
  const [durationTypeOpen, setDurationTypeOpen] = useState(false);
  const [startDate, setStartDate] = useState<Date | null>(
    initial?.startDate ? new Date(initial.startDate) : null,
  );
  const [endDate, setEndDate] = useState<Date | null>(
    initial?.endDate ? new Date(initial.endDate) : null,
  );
  const [lineWidth, setLineWidth] = useState<string>(
    typeof initial?.lineWidth === 'number' ? String(initial.lineWidth) : '1',
  );
  const [lineStyle, setLineStyle] = useState<PlotLineStyle>(initial?.lineStyle ?? 'Solid');
  const [styleOpen, setStyleOpen] = useState(true);
  const [styleDropdownOpen, setStyleDropdownOpen] = useState(false);
  const [openPeriodicityRow, setOpenPeriodicityRow] = useState<number | null>(null);

  const isValid = name.trim().length > 0;

  function addPeriodicityRow() {
    setPeriodicities((rows) => {
      // Default the new row to the first periodicity not already chosen.
      const used = new Set(rows.map((r) => r.periodicity));
      const next = PERIODICITY_OPTIONS.find((p) => !used.has(p)) ?? PERIODICITY_OPTIONS[0];
      return [...rows, { periodicity: next, value: 0 }];
    });
  }
  function updatePeriodicityRow(idx: number, patch: Partial<PlotLinePeriodicityEntry>) {
    setPeriodicities((rows) => rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }
  function removePeriodicityRow(idx: number) {
    setPeriodicities((rows) => rows.filter((_, i) => i !== idx));
  }

  const submit = useCallback(() => {
    if (!isValid) return;
    const widthNum = Number(lineWidth);
    const isDynamic = valueType === 'Dynamic';
    onSubmit({
      _id: initial?._id ?? `plotline_${Date.now()}_${existingCount}`,
      name: name.trim(),
      color: color.trim() || '#3b82f6',
      type,
      valueType,
      fixedValue:
        type === 'Independent' && valueType === 'Fixed' && fixedValue !== ''
          ? fixedValue
          : undefined,
      dynamicTopic: isDynamic ? dynamicTopic : undefined,
      dataPrecision:
        isDynamic && dataPrecision !== '' && !Number.isNaN(Number(dataPrecision))
          ? Number(dataPrecision)
          : undefined,
      unit: isDynamic && unit ? unit : undefined,
      periodicities: type === 'Dependent' && valueType === 'Fixed' ? periodicities : undefined,
      durationType: type === 'Independent' && isDynamic ? durationType || undefined : undefined,
      startDate: type === 'Independent' && isDynamic && startDate ? startDate.toISOString() : undefined,
      endDate: type === 'Independent' && isDynamic && endDate ? endDate.toISOString() : undefined,
      lineWidth: Number.isFinite(widthNum) && widthNum > 0 ? widthNum : 1,
      lineStyle,
    });
  }, [
    isValid,
    initial,
    existingCount,
    name,
    color,
    type,
    valueType,
    fixedValue,
    dynamicTopic,
    dataPrecision,
    unit,
    periodicities,
    durationType,
    startDate,
    endDate,
    lineWidth,
    lineStyle,
    onSubmit,
  ]);

  useEditorBinding(isValid, submit, onReady);

  return (
    <div className="lc-config__editor">
      <TextInput
        label="Name"
        labelPosition="top"
        placeholder="Enter line name"
        value={name}
        necessityIndicator="required"
        onChange={({ value }: { name: string; value: string }) => setName(value)}
      />
      <ColorInput
        label="Color *"
        placeholder="Select color"
        value={color}
        onChange={(hex: string) => setColor(hex)}
      />

      {/* Realtime charts have no periodicity, so the "Periodicity Dependent"
          option is hidden — only Independent plotlines are available. */}
      {!isRealtime && (
        <RadioGroup
          label="Plotline Type"
          name="plotline-type"
          size="Medium"
          value={type}
          onChange={({ value }) => setType(value as PlotLineType)}
          orientation="Vertical"
        >
          <Radio
            label="Periodicity Independent"
            helpText="Plotline uses a static value, unaffected by periodic intervals."
            value="Independent"
          />
          <Radio
            label="Periodicity Dependent"
            helpText="Plotline values dynamically derived from the selected periodic dataset."
            value="Dependent"
          />
        </RadioGroup>
      )}

      <SelectInput
        label="Value Type *"
        placeholder="Select"
        value={valueType}
        isOpen={valueTypeOpen}
        onOpenChange={setValueTypeOpen}
        onClick={() => setValueTypeOpen((o) => !o)}
      >
        <DropdownMenu>
          {(['Fixed', 'Dynamic'] as PlotLineValueType[]).map((opt) => (
            <ActionListItem
              key={opt}
              title={opt}
              selectionType="Single"
              isSelected={valueType === opt}
              onClick={() => {
                setValueType(opt);
                setValueTypeOpen(false);
              }}
            />
          ))}
        </DropdownMenu>
      </SelectInput>

      {type === 'Independent' && valueType === 'Fixed' && (
        <TextInput
          label="Value"
          labelPosition="top"
          type="number"
          necessityIndicator="required"
          placeholder="Enter value"
          value={fixedValue}
          onChange={({ value }: { name: string; value: string }) => setFixedValue(value)}
        />
      )}

      {valueType === 'Dynamic' && (
        <>
          <UNSPathInput
            label="UNS Path"
            placeholder="Enter UNS Path"
            value={dynamicTopic}
            tree={unsTree}
            isLoading={isLoadingTree}
            onOpen={loadWorkspaces}
            onChange={(v: string) => setDynamicTopic(resolveUNSValue(v))}
          />
          <div className="lc-config__date-row">
            <TextInput
              label="Data Precision *"
              labelPosition="top"
              placeholder="Enter value"
              value={dataPrecision}
              onChange={({ value }: { name: string; value: string }) =>
                setDataPrecision(value)
              }
            />
            <TextInput
              label="Unit *"
              labelPosition="top"
              placeholder="Enter value"
              value={unit}
              onChange={({ value }: { name: string; value: string }) => setUnit(value)}
            />
          </div>
        </>
      )}

      {type === 'Dependent' && valueType === 'Fixed' && (
        <div className="lc-config__sub-block">
          <p className="lc-config__sub-block-title LabelSmallRegular">
            Periodicity Settings
          </p>
          {periodicities.length === 0 && (
            <p className="lc-config__hint BodySmallRegular">
              No periodicities added. Click "Add Periodicity" to add one.
            </p>
          )}
          {periodicities.map((row, idx) => (
            <div className="lc-config__periodicity-row" key={idx}>
              <SelectInput
                label="Periodicity"
                placeholder="Select"
                value={row.periodicity}
                isOpen={openPeriodicityRow === idx}
                onOpenChange={(o) => setOpenPeriodicityRow(o ? idx : null)}
                onClick={() =>
                  setOpenPeriodicityRow((cur) => (cur === idx ? null : idx))
                }
              >
                <DropdownMenu>
                  {PERIODICITY_OPTIONS.filter(
                    // Hide periodicities already chosen in other rows; keep the
                    // current row's own selection so it stays visible/selected.
                    (p) =>
                      p === row.periodicity ||
                      !periodicities.some((r, i) => i !== idx && r.periodicity === p),
                  ).map((p) => (
                    <ActionListItem
                      key={p}
                      title={p}
                      selectionType="Single"
                      isSelected={row.periodicity === p}
                      onClick={() => {
                        updatePeriodicityRow(idx, { periodicity: p });
                        setOpenPeriodicityRow(null);
                      }}
                    />
                  ))}
                </DropdownMenu>
              </SelectInput>
              <TextInput
                label="Value"
                labelPosition="top"
                placeholder="0"
                value={String(row.value ?? '')}
                onChange={({ value }: { name: string; value: string }) => {
                  const num = Number(value);
                  updatePeriodicityRow(idx, {
                    value: Number.isFinite(num) ? num : 0,
                  });
                }}
              />
              <IconButton
                icon={<Trash2 size={14} />}
                size="Small"
                emphasis="Intense"
                accessibilityLabel="Remove periodicity"
                onClick={() => removePeriodicityRow(idx)}
              />
            </div>
          ))}
          <Button
            variant="Gray"
            color="Primary"
            size="Small"
            leadingIcon={<Plus size={14} />}
            label="Add Periodicity"
            isDisabled={periodicities.length >= PERIODICITY_OPTIONS.length}
            onClick={addPeriodicityRow}
          />
        </div>
      )}

      {type === 'Independent' && valueType === 'Dynamic' && (
      <div className="lc-config__flat-section">
        <p className="lc-config__flat-section-title LabelSmallSemiBold">Duration Settings</p>
        <SelectInput
          label="Duration Type *"
          placeholder="Select"
          value={durationType}
          isOpen={durationTypeOpen}
          onOpenChange={setDurationTypeOpen}
          onClick={() => setDurationTypeOpen((o) => !o)}
        >
          <DropdownMenu>
            {DURATION_TYPE_OPTIONS.map((opt) => (
              <ActionListItem
                key={opt}
                title={opt}
                selectionType="Single"
                isSelected={durationType === opt}
                onClick={() => {
                  setDurationType(opt);
                  setDurationTypeOpen(false);
                }}
              />
            ))}
          </DropdownMenu>
        </SelectInput>
        <div className="lc-config__duration-group__fields">
          <DatePicker
            mode="single"
            label="Start Date *"
            value={startDate}
            onChange={(d) => setStartDate(d)}
          />
          <DatePicker
            mode="single"
            label="End Date *"
            value={endDate}
            onChange={(d) => setEndDate(d)}
          />
        </div>
      </div>
      )}

      <ProductAccordionItem
        title="Style"
        className="lc-config__plotline-style"
        isExpanded={styleOpen}
        isActive
        onToggle={() => setStyleOpen((o) => !o)}
      >
        <div className="lc-config__editor-accordion-body">
          <TextInput
            label="Line Width"
            labelPosition="top"
            placeholder="1"
            value={lineWidth}
            onChange={({ value }: { name: string; value: string }) => setLineWidth(value)}
          />
          <SelectInput
            label="Line Style"
            placeholder="Select"
            value={lineStyle}
            isOpen={styleDropdownOpen}
            onOpenChange={setStyleDropdownOpen}
            onClick={() => setStyleDropdownOpen((o) => !o)}
          >
            <DropdownMenu>
              {LINE_STYLE_OPTIONS.map((opt) => (
                <ActionListItem
                  key={opt}
                  title={opt}
                  selectionType="Single"
                  isSelected={lineStyle === opt}
                  onClick={() => {
                    setLineStyle(opt);
                    setStyleDropdownOpen(false);
                  }}
                />
              ))}
            </DropdownMenu>
          </SelectInput>
        </div>
      </ProductAccordionItem>
    </div>
  );
}

// ===========================================================================
// Editor: Plot Band
// ===========================================================================

interface PlotBandEditorProps {
  initial: LineChartPlotBand | null;
  axes: LineChartAxis[];
  existingCount: number;
  onSubmit: (band: LineChartPlotBand) => void;
  onReady: (b: EditorBinding) => void;
}

function PlotBandEditor({
  initial,
  axes,
  existingCount,
  onSubmit,
  onReady,
}: PlotBandEditorProps) {
  const [name, setName] = useState(initial?.name ?? '');
  const [color, setColor] = useState(initial?.color ?? '#f59e0b');
  const [axisId, setAxisId] = useState<string>(initial?.axisId ?? '');
  const [startValue, setStartValue] = useState<string>(
    typeof initial?.startValue === 'number' ? String(initial.startValue) : '',
  );
  const [endValue, setEndValue] = useState<string>(
    typeof initial?.endValue === 'number' ? String(initial.endValue) : '',
  );
  const [axisDropdownOpen, setAxisDropdownOpen] = useState(false);

  const isValid =
    name.trim().length > 0 &&
    startValue.trim() !== '' &&
    endValue.trim() !== '' &&
    Number.isFinite(Number(startValue)) &&
    Number.isFinite(Number(endValue));

  const axesById = useMemo(() => {
    const m = new Map<string, LineChartAxis>();
    axes.forEach((a) => m.set(a._id, a));
    return m;
  }, [axes]);

  const axisLabel = axisId ? axesById.get(axisId)?.name ?? 'Default' : 'Default';

  const submit = useCallback(() => {
    if (!isValid) return;
    onSubmit({
      _id: initial?._id ?? `plotband_${Date.now()}_${existingCount}`,
      name: name.trim(),
      color: color.trim() || '#f59e0b',
      axisId: axisId || undefined,
      startValue: Number(startValue),
      endValue: Number(endValue),
    });
  }, [isValid, initial, existingCount, name, color, axisId, startValue, endValue, onSubmit]);

  useEditorBinding(isValid, submit, onReady);

  return (
    <div className="lc-config__editor">
      <TextInput
        label="Name"
        labelPosition="top"
        placeholder="Enter band name"
        value={name}
        necessityIndicator="required"
        onChange={({ value }: { name: string; value: string }) => setName(value)}
      />
      <ColorInput
        label="Color *"
        placeholder="Select color"
        value={color}
        onChange={(hex: string) => setColor(hex)}
      />
      <SelectInput
        label="Axis"
        placeholder="Select axis"
        value={axisLabel}
        isOpen={axisDropdownOpen}
        onOpenChange={setAxisDropdownOpen}
        onClick={() => setAxisDropdownOpen((o) => !o)}
      >
        <DropdownMenu>
          <ActionListItem
            title="Default"
            selectionType="Single"
            isSelected={!axisId}
            onClick={() => {
              setAxisId('');
              setAxisDropdownOpen(false);
            }}
          />
          {axes.map((a) => (
            <ActionListItem
              key={a._id}
              title={a.name}
              selectionType="Single"
              isSelected={axisId === a._id}
              onClick={() => {
                setAxisId(a._id);
                setAxisDropdownOpen(false);
              }}
            />
          ))}
        </DropdownMenu>
      </SelectInput>
      <div className="lc-config__date-row">
        <TextInput
          label="Start Value"
          labelPosition="top"
          placeholder="e.g. 10"
          value={startValue}
          necessityIndicator="required"
          onChange={({ value }: { name: string; value: string }) => setStartValue(value)}
        />
        <TextInput
          label="End Value"
          labelPosition="top"
          placeholder="e.g. 20"
          value={endValue}
          necessityIndicator="required"
          onChange={({ value }: { name: string; value: string }) => setEndValue(value)}
        />
      </div>
    </div>
  );
}

// ===========================================================================
// Editor: SPC
// ===========================================================================

const PROCESS_TYPE_OPTIONS: SPCProcessType[] = ['Average', 'Median', 'StandardDeviation'];
const PROCESS_TYPE_LABELS: Record<SPCProcessType, string> = {
  Average: 'Average',
  Median: 'Median',
  StandardDeviation: 'Standard Deviation',
};
const SIGMA_LEVEL_OPTIONS: SPCSigmaLevel[] = [
  '1Sigma',
  '2Sigma',
  '3Sigma',
  '4Sigma',
  '5Sigma',
  '6Sigma',
];
const SIGMA_LEVEL_LABELS: Record<SPCSigmaLevel, string> = {
  '1Sigma': '1 Sigma (±)',
  '2Sigma': '2 Sigma (±)',
  '3Sigma': '3 Sigma (±)',
  '4Sigma': '4 Sigma (±)',
  '5Sigma': '5 Sigma (±)',
  '6Sigma': '6 Sigma (±)',
};

function deriveSpcDisplayName(
  spc: LineChartSPC,
  seriesById: Map<string, LineChartSeries>,
): string {
  const names: string[] = [];
  if (spc.processTypes?.includes('Average') && spc.average?.plotName)
    names.push(spc.average.plotName);
  if (spc.processTypes?.includes('Median') && spc.median?.plotName)
    names.push(spc.median.plotName);
  if (spc.processTypes?.includes('StandardDeviation') && spc.standardDeviation?.plotName)
    names.push(spc.standardDeviation.plotName);
  if (names.length > 0) return names.join(', ');
  // Fallback: series names joined.
  const sourceNames = (spc.dataSourceIds ?? [])
    .map((id) => seriesById.get(id)?.name)
    .filter((n): n is string => !!n);
  if (sourceNames.length > 0) return sourceNames.join(', ');
  return 'Process Control';
}

interface SPCEditorProps {
  initial: LineChartSPC | null;
  series: LineChartSeries[];
  existingCount: number;
  onSubmit: (spc: LineChartSPC) => void;
  onReady: (b: EditorBinding) => void;
}

function SPCEditor({
  initial,
  series,
  existingCount,
  onSubmit,
  onReady,
}: SPCEditorProps) {
  const [dataSourceIds, setDataSourceIds] = useState<string[]>(
    Array.isArray(initial?.dataSourceIds) ? [...(initial!.dataSourceIds as string[])] : [],
  );
  const [startDate, setStartDate] = useState<Date | null>(
    initial?.startDate ? new Date(initial.startDate) : null,
  );
  const [endDate, setEndDate] = useState<Date | null>(
    initial?.endDate ? new Date(initial.endDate) : null,
  );
  const [processTypes, setProcessTypes] = useState<SPCProcessType[]>(
    initial?.processTypes ?? [],
  );

  // Average
  const [avgPlotName, setAvgPlotName] = useState(initial?.average?.plotName ?? 'Average');
  const [avgLineWidth, setAvgLineWidth] = useState(
    typeof initial?.average?.lineWidth === 'number'
      ? String(initial.average.lineWidth)
      : '1',
  );
  const [avgLineColor, setAvgLineColor] = useState(initial?.average?.lineColor ?? '#e4553d');
  // Median
  const [medPlotName, setMedPlotName] = useState(initial?.median?.plotName ?? 'Median');
  const [medLineWidth, setMedLineWidth] = useState(
    typeof initial?.median?.lineWidth === 'number'
      ? String(initial.median.lineWidth)
      : '1',
  );
  const [medLineColor, setMedLineColor] = useState(initial?.median?.lineColor ?? '#e4553d');
  // SD
  const [sdPlotName, setSdPlotName] = useState(
    initial?.standardDeviation?.plotName ?? 'Standard Deviation',
  );
  const [sdLineWidth, setSdLineWidth] = useState(
    typeof initial?.standardDeviation?.lineWidth === 'number'
      ? String(initial.standardDeviation.lineWidth)
      : '1',
  );
  const [sdLineColor, setSdLineColor] = useState(
    initial?.standardDeviation?.lineColor ?? '#e4553d',
  );
  const [sigmaLevels, setSigmaLevels] = useState<SPCSigmaLevel[]>(
    initial?.standardDeviation?.sigmaLevels ?? [],
  );

  const [dataSourceDropdownOpen, setDataSourceDropdownOpen] = useState(false);
  const [processTypeDropdownOpen, setProcessTypeDropdownOpen] = useState(false);

  // Per-section accordion expansion (controlled — ProductAccordionItem is controlled-only).
  const [avgOpen, setAvgOpen] = useState(true);
  const [medOpen, setMedOpen] = useState(true);
  const [sdOpen, setSdOpen] = useState(true);

  const isValid = dataSourceIds.length > 0 && processTypes.length > 0;

  function toggleDataSource(id: string) {
    setDataSourceIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }
  function toggleProcessType(t: SPCProcessType) {
    setProcessTypes((prev) =>
      prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t],
    );
  }
  function toggleSigmaLevel(level: SPCSigmaLevel) {
    setSigmaLevels((prev) =>
      prev.includes(level) ? prev.filter((x) => x !== level) : [...prev, level],
    );
  }

  const seriesById = useMemo(() => {
    const m = new Map<string, LineChartSeries>();
    series.forEach((s) => m.set(s._id, s));
    return m;
  }, [series]);

  const dataSourceTags = dataSourceIds.map((id) => ({
    label: seriesById.get(id)?.name ?? id,
    onDismiss: () => toggleDataSource(id),
  }));
  const processTypeValue = processTypes
    .map((t) => (t === 'StandardDeviation' ? 'Standard' : PROCESS_TYPE_LABELS[t]))
    .join(', ');

  const submit = useCallback(() => {
    if (!isValid) return;
    const spc: LineChartSPC = {
      _id: initial?._id ?? `spc_${Date.now()}_${existingCount}`,
      dataSourceIds: [...dataSourceIds],
      startDate: startDate ? startDate.toISOString() : undefined,
      endDate: endDate ? endDate.toISOString() : undefined,
      processTypes: [...processTypes],
    };
    if (processTypes.includes('Average')) {
      const w = Number(avgLineWidth);
      spc.average = {
        enabled: true,
        plotName: avgPlotName.trim() || 'Average',
        lineWidth: Number.isFinite(w) && w > 0 ? w : 1,
        lineColor: avgLineColor.trim() || '#e4553d',
      };
    }
    if (processTypes.includes('Median')) {
      const w = Number(medLineWidth);
      spc.median = {
        enabled: true,
        plotName: medPlotName.trim() || 'Median',
        lineWidth: Number.isFinite(w) && w > 0 ? w : 1,
        lineColor: medLineColor.trim() || '#e4553d',
      };
    }
    if (processTypes.includes('StandardDeviation')) {
      const w = Number(sdLineWidth);
      spc.standardDeviation = {
        enabled: true,
        plotName: sdPlotName.trim() || 'Standard Deviation',
        lineWidth: Number.isFinite(w) && w > 0 ? w : 1,
        lineColor: sdLineColor.trim() || '#e4553d',
        sigmaLevels: [...sigmaLevels],
      };
    }
    onSubmit(spc);
  }, [
    isValid,
    initial,
    existingCount,
    dataSourceIds,
    startDate,
    endDate,
    processTypes,
    avgPlotName,
    avgLineWidth,
    avgLineColor,
    medPlotName,
    medLineWidth,
    medLineColor,
    sdPlotName,
    sdLineWidth,
    sdLineColor,
    sigmaLevels,
    onSubmit,
  ]);

  useEditorBinding(isValid, submit, onReady);

  return (
    <div className="lc-config__editor lc-config__editor--spc">
      <SelectInput
        label="Data Source"
        placeholder={series.length === 0 ? 'No series available' : 'Select series'}
        tags={dataSourceTags}
        isOpen={dataSourceDropdownOpen}
        onOpenChange={setDataSourceDropdownOpen}
        onClick={() => setDataSourceDropdownOpen((o) => !o)}
        isDisabled={series.length === 0}
      >
        <DropdownMenu>
          {series.map((s) => (
            <ActionListItem
              key={s._id}
              title={s.name || `Series ${s._id}`}
              selectionType="Multiple"
              isSelected={dataSourceIds.includes(s._id)}
              onClick={() => toggleDataSource(s._id)}
            />
          ))}
        </DropdownMenu>
      </SelectInput>

      <div className="lc-config__duration-group">
        <p className="lc-config__duration-group__title BodySmallMedium">Duration Settings</p>
        <div className="lc-config__duration-group__fields">
          <DatePicker
            mode="single"
            label="Start Date"
            placeholder="Select date"
            value={startDate}
            onChange={(d) => setStartDate(d)}
          />
          <DatePicker
            mode="single"
            label="End Date"
            placeholder="Select date"
            value={endDate}
            onChange={(d) => setEndDate(d)}
          />
        </div>
      </div>

      <SelectInput
        label="Process Type"
        placeholder="Select one or more"
        value={processTypeValue}
        isOpen={processTypeDropdownOpen}
        onOpenChange={setProcessTypeDropdownOpen}
        onClick={() => setProcessTypeDropdownOpen((o) => !o)}
      >
        <DropdownMenu>
          {PROCESS_TYPE_OPTIONS.map((t) => (
            <ActionListItem
              key={t}
              title={PROCESS_TYPE_LABELS[t]}
              selectionType="Multiple"
              isSelected={processTypes.includes(t)}
              onClick={() => toggleProcessType(t)}
            />
          ))}
        </DropdownMenu>
      </SelectInput>

      {processTypes.length > 0 && (
        <div className="lc-config__spc-accordions">
          {processTypes.includes('Average') && (
            <ProductAccordionItem
              title="Average"
              isExpanded={avgOpen}
              isActive
              onToggle={() => setAvgOpen((o) => !o)}
            >
              <div className="lc-config__spc-section">
                <TextInput
                  label="Plot Name"
                  labelPosition="top"
                  necessityIndicator="required"
                  placeholder="Average"
                  value={avgPlotName}
                  onChange={({ value }: { name: string; value: string }) =>
                    setAvgPlotName(value)
                  }
                />
                <TextInput
                  label="Line Width"
                  labelPosition="top"
                  necessityIndicator="required"
                  type="number"
                  placeholder="1"
                  value={avgLineWidth}
                  onChange={({ value }: { name: string; value: string }) =>
                    setAvgLineWidth(value)
                  }
                />
                <ColorInput
                  label="Line Color"
                  placeholder="Select color"
                  value={avgLineColor}
                  onChange={(hex: string) => setAvgLineColor(hex)}
                />
              </div>
            </ProductAccordionItem>
          )}
          {processTypes.includes('Median') && (
            <ProductAccordionItem
              title="Median"
              isExpanded={medOpen}
              isActive
              onToggle={() => setMedOpen((o) => !o)}
            >
              <div className="lc-config__spc-section">
                <TextInput
                  label="Plot Name"
                  labelPosition="top"
                  necessityIndicator="required"
                  placeholder="Median"
                  value={medPlotName}
                  onChange={({ value }: { name: string; value: string }) =>
                    setMedPlotName(value)
                  }
                />
                <TextInput
                  label="Line Width"
                  labelPosition="top"
                  necessityIndicator="required"
                  type="number"
                  placeholder="1"
                  value={medLineWidth}
                  onChange={({ value }: { name: string; value: string }) =>
                    setMedLineWidth(value)
                  }
                />
                <ColorInput
                  label="Line Color"
                  placeholder="Select color"
                  value={medLineColor}
                  onChange={(hex: string) => setMedLineColor(hex)}
                />
              </div>
            </ProductAccordionItem>
          )}
          {processTypes.includes('StandardDeviation') && (
            <ProductAccordionItem
              title="Standard Deviation"
              isExpanded={sdOpen}
              isActive
              onToggle={() => setSdOpen((o) => !o)}
            >
              <div className="lc-config__spc-section">
                <TextInput
                  label="Plot Name"
                  labelPosition="top"
                  necessityIndicator="required"
                  placeholder="Standard Deviation"
                  value={sdPlotName}
                  onChange={({ value }: { name: string; value: string }) =>
                    setSdPlotName(value)
                  }
                />
                <div className="lc-config__sigma-grid">
                  {SIGMA_LEVEL_OPTIONS.map((lvl) => (
                    <label className="lc-config__sigma-item" key={lvl}>
                      <Checkbox
                        isChecked={sigmaLevels.includes(lvl)}
                        onClick={() => toggleSigmaLevel(lvl)}
                      >
                        {SIGMA_LEVEL_LABELS[lvl]}
                      </Checkbox>
                    </label>
                  ))}
                </div>
                <TextInput
                  label="Line Width"
                  labelPosition="top"
                  necessityIndicator="required"
                  type="number"
                  placeholder="1"
                  value={sdLineWidth}
                  onChange={({ value }: { name: string; value: string }) =>
                    setSdLineWidth(value)
                  }
                />
                <ColorInput
                  label="Line Color"
                  placeholder="Select color"
                  value={sdLineColor}
                  onChange={(hex: string) => setSdLineColor(hex)}
                />
              </div>
            </ProductAccordionItem>
          )}
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// Editor: Anomaly
// ===========================================================================

const OPERATOR_OPTIONS: AnomalyOperator[] = ['>', '<', '>=', '<=', '==', '!='];

interface AnomalyEditorProps {
  initial: LineChartAnomaly | null;
  series: LineChartSeries[];
  existingCount: number;
  unsTree: import('@faclon-labs/design-sdk/UNSPathInput').UNSTree;
  isLoadingTree: boolean;
  loadWorkspaces: () => void;
  resolveUNSValue: (raw: string) => string;
  onSubmit: (a: LineChartAnomaly) => void;
  onReady: (b: EditorBinding) => void;
}

function AnomalyEditor({
  initial,
  series,
  existingCount,
  unsTree,
  isLoadingTree,
  loadWorkspaces,
  resolveUNSValue,
  onSubmit,
  onReady,
}: AnomalyEditorProps) {
  const [name, setName] = useState(initial?.name ?? '');
  const [color, setColor] = useState(initial?.color ?? '#ef4444');
  const [applyToSeriesId, setApplyToSeriesId] = useState(initial?.applyToSeriesId ?? '');
  const [operator, setOperator] = useState<AnomalyOperator>(initial?.operator ?? '>');
  const [labelMode, setLabelMode] = useState<AnomalyLabelMode>(
    initial?.labelMode ?? 'Value',
  );
  const [thresholdValue, setThresholdValue] = useState<string>(
    typeof initial?.thresholdValue === 'number' ? String(initial.thresholdValue) : '',
  );
  const [existingSeriesId, setExistingSeriesId] = useState(initial?.existingSeriesId ?? '');
  const [newSourceTopic, setNewSourceTopic] = useState(initial?.newSourceTopic ?? '');

  const [applyToDropdownOpen, setApplyToDropdownOpen] = useState(false);
  const [operatorDropdownOpen, setOperatorDropdownOpen] = useState(false);
  const [existingDropdownOpen, setExistingDropdownOpen] = useState(false);

  const seriesById = useMemo(() => {
    const m = new Map<string, LineChartSeries>();
    series.forEach((s) => m.set(s._id, s));
    return m;
  }, [series]);

  const applyToLabel = applyToSeriesId ? seriesById.get(applyToSeriesId)?.name ?? '' : '';
  const existingLabel = existingSeriesId
    ? seriesById.get(existingSeriesId)?.name ?? ''
    : '';

  const isValid = (() => {
    if (!name.trim()) return false;
    if (!applyToSeriesId) return false;
    if (labelMode === 'Value' && thresholdValue.trim() === '') return false;
    if (labelMode === 'Existing' && !existingSeriesId) return false;
    if (labelMode === 'NewSource' && !newSourceTopic.trim()) return false;
    return true;
  })();

  const submit = useCallback(() => {
    if (!isValid) return;
    const anom: LineChartAnomaly = {
      _id: initial?._id ?? `anomaly_${Date.now()}_${existingCount}`,
      name: name.trim(),
      color: color.trim() || '#ef4444',
      applyToSeriesId,
      operator,
      labelMode,
    };
    if (labelMode === 'Value') {
      const n = Number(thresholdValue);
      if (Number.isFinite(n)) anom.thresholdValue = n;
    } else if (labelMode === 'Existing') {
      if (existingSeriesId) anom.existingSeriesId = existingSeriesId;
    } else if (labelMode === 'NewSource') {
      anom.newSourceTopic = newSourceTopic;
    }
    onSubmit(anom);
  }, [
    isValid,
    initial,
    existingCount,
    name,
    color,
    applyToSeriesId,
    operator,
    labelMode,
    thresholdValue,
    existingSeriesId,
    newSourceTopic,
    onSubmit,
  ]);

  useEditorBinding(isValid, submit, onReady);

  return (
    <div className="lc-config__editor">
      <TextInput
        label="Name"
        labelPosition="top"
        placeholder="Enter anomaly name"
        value={name}
        necessityIndicator="required"
        onChange={({ value }: { name: string; value: string }) => setName(value)}
      />
      <ColorInput
        label="Color *"
        placeholder="Select color"
        value={color}
        onChange={(hex: string) => setColor(hex)}
      />

      <SelectInput
        label="Apply To"
        placeholder={series.length === 0 ? 'No series available' : 'Select series'}
        value={applyToLabel}
        isOpen={applyToDropdownOpen}
        onOpenChange={setApplyToDropdownOpen}
        onClick={() => setApplyToDropdownOpen((o) => !o)}
        isDisabled={series.length === 0}
      >
        <DropdownMenu>
          {series.map((s) => (
            <ActionListItem
              key={s._id}
              title={s.name || `Series ${s._id}`}
              selectionType="Single"
              isSelected={applyToSeriesId === s._id}
              onClick={() => {
                setApplyToSeriesId(s._id);
                setApplyToDropdownOpen(false);
              }}
            />
          ))}
        </DropdownMenu>
      </SelectInput>

      <SelectInput
        label="Operator"
        placeholder="Select"
        value={operator}
        isOpen={operatorDropdownOpen}
        onOpenChange={setOperatorDropdownOpen}
        onClick={() => setOperatorDropdownOpen((o) => !o)}
      >
        <DropdownMenu>
          {OPERATOR_OPTIONS.map((op) => (
            <ActionListItem
              key={op}
              title={op}
              selectionType="Single"
              isSelected={operator === op}
              onClick={() => {
                setOperator(op);
                setOperatorDropdownOpen(false);
              }}
            />
          ))}
        </DropdownMenu>
      </SelectInput>

      <RadioGroup
        label="Label"
        name="anomaly-label-mode"
        size="Medium"
        value={labelMode}
        onChange={({ value }) => setLabelMode(value as AnomalyLabelMode)}
        orientation="Horizontal"
      >
        <Radio label="Existing" value="Existing" />
        <Radio label="New Source" value="NewSource" />
        <Radio label="Value" value="Value" />
      </RadioGroup>

      {labelMode === 'Existing' && (
        <SelectInput
          label="Source"
          placeholder={series.length === 0 ? 'No series available' : 'Select existing series'}
          value={existingLabel}
          isOpen={existingDropdownOpen}
          onOpenChange={setExistingDropdownOpen}
          onClick={() => setExistingDropdownOpen((o) => !o)}
          isDisabled={series.length === 0}
        >
          <DropdownMenu>
            {series.map((s) => (
              <ActionListItem
                key={s._id}
                title={s.name || `Series ${s._id}`}
                selectionType="Single"
                isSelected={existingSeriesId === s._id}
                onClick={() => {
                  setExistingSeriesId(s._id);
                  setExistingDropdownOpen(false);
                }}
              />
            ))}
          </DropdownMenu>
        </SelectInput>
      )}

      {labelMode === 'NewSource' && (
        <UNSPathInput
          label="Topic"
          placeholder="Type / to browse UNS or paste {{topic}} directly"
          value={newSourceTopic}
          tree={unsTree}
          isLoading={isLoadingTree}
          onOpen={loadWorkspaces}
          onChange={(v: string) => setNewSourceTopic(resolveUNSValue(v))}
        />
      )}

      {labelMode === 'Value' && (
        <TextInput
          label="Enter Value"
          labelPosition="top"
          placeholder="e.g. 50"
          value={thresholdValue}
          necessityIndicator="required"
          onChange={({ value }: { name: string; value: string }) => setThresholdValue(value)}
        />
      )}
    </div>
  );
}

// ===========================================================================
// Editor: Data Table column
// ===========================================================================

const DATA_TABLE_OPERATOR_OPTIONS: DataTableOperator[] = [
  'sum',
  'avg',
  'min',
  'max',
  'median',
  'first',
  'last',
];
const DATA_TABLE_OPERATOR_LABELS: Record<DataTableOperator, string> = {
  sum: 'Sum',
  avg: 'Average',
  min: 'Minimum',
  max: 'Maximum',
  median: 'Median',
  first: 'First',
  last: 'Last',
};

interface DataTableColumnEditorProps {
  initial: DataTableColumn | null;
  series: LineChartSeries[];
  existingCount: number;
  unsTree?: UNSTree;
  isLoadingTree?: boolean;
  loadWorkspaces: () => void;
  resolveUNSValue: (v: string) => string;
  // Multi-select Existing mode can emit several columns at once.
  onSubmit: (cols: DataTableColumn[]) => void;
  onReady: (b: EditorBinding) => void;
}

function DataTableColumnEditor({
  initial,
  series,
  existingCount,
  unsTree,
  isLoadingTree,
  loadWorkspaces,
  resolveUNSValue,
  onSubmit,
  onReady,
}: DataTableColumnEditorProps) {
  const [sourceMode, setSourceMode] = useState<DataTableSourceMode>(
    initial?.sourceMode ?? 'Existing',
  );
  // Existing — multi-select: each chosen series becomes its own table column.
  const [seriesIds, setSeriesIds] = useState<string[]>(
    initial?.seriesId ? [initial.seriesId] : [],
  );
  const [dsSearch, setDsSearch] = useState('');
  // AddNew
  const [name, setName] = useState(initial?.name ?? '');
  const [topic, setTopic] = useState(initial?.topic ?? '');
  const [dataPrecision, setDataPrecision] = useState(
    typeof initial?.dataPrecision === 'number' ? String(initial.dataPrecision) : '2',
  );
  const [unit, setUnit] = useState(initial?.unit ?? '');

  const [seriesDropdownOpen, setSeriesDropdownOpen] = useState(false);

  const seriesById = useMemo(() => {
    const m = new Map<string, LineChartSeries>();
    series.forEach((s) => m.set(s._id, s));
    return m;
  }, [series]);

  const filteredSeries = useMemo(() => {
    const q = dsSearch.trim().toLowerCase();
    if (!q) return series;
    return series.filter((s) => (s.name || '').toLowerCase().includes(q));
  }, [series, dsSearch]);

  function toggleSeries(id: string) {
    setSeriesIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
    setDsSearch('');
  }

  const seriesTags = seriesIds.map((id) => ({
    label: seriesById.get(id)?.name || 'Untitled',
    onDismiss: () => toggleSeries(id),
  }));

  const isValid =
    sourceMode === 'Existing'
      ? seriesIds.length > 0
      : name.trim().length > 0 && topic.trim().length > 0;

  const submit = useCallback(() => {
    if (!isValid) return;
    const precNum = Number(dataPrecision);
    const precision = Number.isFinite(precNum) && precNum >= 0 ? Math.floor(precNum) : 2;
    if (sourceMode === 'Existing') {
      // One column per selected series. In edit mode the first keeps the
      // original column id; any extras are added as new columns.
      const cols: DataTableColumn[] = seriesIds.map((sid, idx) => ({
        _id:
          idx === 0 && initial?._id
            ? initial._id
            : `dtcol_${Date.now()}_${existingCount + idx}`,
        sourceMode,
        seriesId: sid,
        dataPrecision: precision,
        unit: unit.trim() || undefined,
      }));
      onSubmit(cols);
    } else {
      onSubmit([
        {
          _id: initial?._id ?? `dtcol_${Date.now()}_${existingCount}`,
          sourceMode,
          name: name.trim(),
          topic,
          dataPrecision: precision,
          unit: unit.trim() || undefined,
        },
      ]);
    }
  }, [
    isValid, initial, existingCount, sourceMode, seriesIds,
    name, topic, dataPrecision, unit, onSubmit,
  ]);

  useEditorBinding(isValid, submit, onReady);

  return (
    <div className="lc-config__editor">
      <RadioGroup
        label="Source Mode"
        name="dt-source-mode"
        size="Medium"
        value={sourceMode}
        onChange={({ value }) => setSourceMode(value as DataTableSourceMode)}
        orientation="Horizontal"
      >
        <Radio label="Existing" value="Existing" />
        <Radio label="Add New" value="AddNew" />
      </RadioGroup>

      {/* ── Existing ─────────────────────────────── */}
      {sourceMode === 'Existing' && (
        <SelectInput
          label="Data Source"
          multiType="multiple"
          isRequired
          placeholder={series.length === 0 ? 'No series available' : 'Select data sources'}
          tags={seriesTags}
          isOpen={seriesDropdownOpen}
          onOpenChange={setSeriesDropdownOpen}
          inputValue={dsSearch}
          onInputChange={setDsSearch}
          onBackspace={() => setSeriesIds((prev) => prev.slice(0, -1))}
          isDisabled={series.length === 0}
        >
          <DropdownMenu emptyTitle="No matching data sources">
            {filteredSeries.map((s) => (
              <ActionListItem
                key={s._id}
                title={s.name || `Series ${s._id}`}
                selectionType="Multiple"
                isSelected={seriesIds.includes(s._id)}
                onClick={() => toggleSeries(s._id)}
              />
            ))}
          </DropdownMenu>
        </SelectInput>
      )}

      {/* ── Add New — Name + UNS path + Precision ── */}
      {sourceMode === 'AddNew' && (
        <>
          <TextInput
            label="Name"
            labelPosition="top"
            placeholder="Enter name"
            value={name}
            necessityIndicator="required"
            onChange={({ value }: { name: string; value: string }) => setName(value)}
          />
          <UNSPathInput
            label="UNS Path *"
            placeholder="Enter UNS Path"
            value={topic}
            tree={unsTree}
            isLoading={isLoadingTree}
            onOpen={loadWorkspaces}
            onChange={(v: string) => setTopic(resolveUNSValue(v))}
          />

          <div className="lc-config__date-row">
            <TextInput
              label="Data Precision"
              labelPosition="top"
              placeholder="2"
              value={dataPrecision}
              onChange={({ value }: { name: string; value: string }) => setDataPrecision(value)}
            />
            <TextInput
              label="Unit"
              labelPosition="top"
              placeholder="Enter value"
              value={unit}
              onChange={({ value }: { name: string; value: string }) => setUnit(value)}
            />
          </div>
        </>
      )}
    </div>
  );
}

// ===========================================================================
// Confirm Delete Modal
// ===========================================================================

interface ConfirmDeleteModalProps {
  isOpen: boolean;
  title: string;
  message: string;
  onCancel: () => void;
  onConfirm: () => void;
}

function ConfirmDeleteModal({
  isOpen,
  title,
  message,
  onCancel,
  onConfirm,
}: ConfirmDeleteModalProps) {
  return (
    <Modal
      size="Small"
      isOpen={isOpen}
      onClose={onCancel}
      header={<ModalHeader title={title} onClose={onCancel} />}
      footer={
        <ModalFooter
          stacking="Horizontal"
          secondaryAction={
            <Button
              variant="Secondary"
              color="Primary"
              size="Medium"
              label="Cancel"
              onClick={onCancel}
            />
          }
          primaryAction={
            <Button
              variant="Primary"
              color="Negative"
              size="Medium"
              label="Delete"
              onClick={onConfirm}
            />
          }
        />
      }
    >
      <ModalBody bodyText={message} />
    </Modal>
  );
}

// ===========================================================================
// Delete Chart Modal (red trash leading icon)
// ===========================================================================

interface DeleteChartModalProps {
  isOpen: boolean;
  chartName: string;
  onCancel: () => void;
  onConfirm: () => void;
}

function DeleteChartModal({
  isOpen,
  chartName,
  onCancel,
  onConfirm,
}: DeleteChartModalProps) {
  const message = `Are you sure you want to delete this chart named "${chartName}"? This action is irreversible`;
  return (
    <Modal
      size="Small"
      isOpen={isOpen}
      onClose={onCancel}
      header={
        <ModalHeader
          title="Delete Chart"
          leadingItem={
            <ModalLeadingItem leading="error" icon={<Trash2 size={20} />} />
          }
          onClose={onCancel}
        />
      }
      footer={
        <ModalFooter
          stacking="Horizontal"
          secondaryAction={
            <Button
              variant="Secondary"
              color="Primary"
              size="Medium"
              label="Cancel"
              onClick={onCancel}
            />
          }
          primaryAction={
            <Button
              variant="Primary"
              color="Negative"
              size="Medium"
              label="Delete"
              onClick={onConfirm}
            />
          }
        />
      }
    >
      <ModalBody bodyText={message} />
    </Modal>
  );
}

// ===========================================================================
// Styling Section (re-used as-is from prior dispatch)
// ===========================================================================

interface StylingSectionProps {
  value: LineChartStyling;
  onChange: (next: LineChartStyling) => void;
}

interface FontWeightSelectProps {
  label: string;
  value: StylingFontWeight;
  onChange: (next: StylingFontWeight) => void;
}

function FontWeightSelect({ label, value, onChange }: FontWeightSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <SelectInput
      label={label}
      value={value}
      isOpen={isOpen}
      onOpenChange={setIsOpen}
      onClick={() => setIsOpen((o) => !o)}
    >
      <DropdownMenu>
        {FONT_WEIGHTS.map((w) => (
          <ActionListItem
            key={w}
            title={w}
            selectionType="Single"
            isSelected={value === w}
            onClick={() => {
              onChange(w);
              setIsOpen(false);
            }}
          />
        ))}
      </DropdownMenu>
    </SelectInput>
  );
}

function StylingSection({ value, onChange }: StylingSectionProps) {
  function update<K extends keyof LineChartStyling>(
    key: K,
    patch: Partial<LineChartStyling[K]> | LineChartStyling[K],
  ) {
    const prev = value[key];
    const merged =
      prev && typeof prev === 'object' && !Array.isArray(prev)
        ? { ...(prev as object), ...(patch as object) }
        : patch;
    onChange({ ...value, [key]: merged } as LineChartStyling);
  }

  return (
    <div className="lc-config__section lc-config__style-tab">
      <div className="lc-config__style-tab__switch-row">
        <span className="LabelMediumRegular lc-config__style-tab__switch-label">
          Wrap Into Card
        </span>
        <Switch
          isChecked={value.card.wrapInCard === true}
          onChange={({ isChecked }) => update('card', { wrapInCard: isChecked })}
          accessibilityLabel="Wrap into card"
        />
      </div>

      <ColorInput
        label="Background Color"
        placeholder="Select color"
        value={value.card.backgroundColor}
        onChange={(v: string) => update('card', { backgroundColor: v })}
      />
      <ColorInput
        label="Border Color"
        placeholder="Select color"
        value={value.card.borderColor}
        onChange={(v: string) => update('card', { borderColor: v })}
      />
      <TextInput
        label="Border Width"
        labelPosition="top"
        type="number"
        value={String(value.card.borderWidth)}
        onChange={({ value: v }: { name: string; value: string }) =>
          update('card', { borderWidth: v === '' ? 0 : Number(v) })
        }
        suffix="px"
      />
      <TextInput
        label="Border Radius"
        labelPosition="top"
        type="number"
        value={String(value.card.borderRadius)}
        onChange={({ value: v }: { name: string; value: string }) =>
          update('card', { borderRadius: v === '' ? 0 : Number(v) })
        }
        suffix="px"
      />

      <div className="lc-config__style-tab__block">
        <Divider />
        <p className="LabelMediumSemibold lc-config__style-tab__block-title">
          Hide Widget Element
        </p>
        <div className="lc-config__style-tab__checkbox-col">
          <Checkbox
            label="Setting Icon"
            size="Medium"
            isChecked={value.hideElements.settingsIcon}
            onClick={() =>
              update('hideElements', { settingsIcon: !value.hideElements.settingsIcon })
            }
          />
          <Checkbox
            label="Export Icon"
            size="Medium"
            isChecked={value.hideElements.exportIcon}
            onClick={() =>
              update('hideElements', { exportIcon: !value.hideElements.exportIcon })
            }
          />
          <Checkbox
            label="Chart Title"
            size="Medium"
            isChecked={value.hideElements.chartTitle}
            onClick={() =>
              update('hideElements', { chartTitle: !value.hideElements.chartTitle })
            }
          />
        </div>
      </div>

      <div className="lc-config__style-tab__switch-row">
        <span className="LabelMediumRegular lc-config__style-tab__switch-label">
          Advanced Settings
        </span>
        <Switch
          isChecked={value.advancedEnabled}
          onChange={({ isChecked }) =>
            onChange({ ...value, advancedEnabled: isChecked })
          }
          accessibilityLabel="Advanced styling"
        />
      </div>

      {value.advancedEnabled && (
        <>
          <div className="lc-config__style-tab__block">
            <Divider />
            <p className="LabelMediumSemibold lc-config__style-tab__block-title">
              Chart Title
            </p>
            <TextInput
              label="Title Font Size"
              labelPosition="top"
              type="number"
              value={String(value.chartTitle.fontSize)}
              onChange={({ value: v }: { name: string; value: string }) =>
                update('chartTitle', { fontSize: v === '' ? 0 : Number(v) })
              }
              suffix="px"
            />
            <ColorInput
              label="Title Font Color"
              value={value.chartTitle.fontColor}
              onChange={(v) => update('chartTitle', { fontColor: v })}
            />
            <FontWeightSelect
              label="Title Font Weight"
              value={value.chartTitle.fontWeight}
              onChange={(v) => update('chartTitle', { fontWeight: v })}
            />
          </div>

          <div className="lc-config__style-tab__block">
            <Divider />
            <p className="LabelMediumSemibold lc-config__style-tab__block-title">
              X Axis
            </p>
            <ColorInput
              label="Axis Text Color"
              value={value.xAxisLabel.textColor ?? '#050505'}
              onChange={(v) => update('xAxisLabel', { textColor: v })}
            />
            <ColorInput
              label="Axis Data Points"
              value={value.xAxisLabel.dataPointColor ?? '#050505'}
              onChange={(v) => update('xAxisLabel', { dataPointColor: v })}
            />
            <ColorInput
              label="X Axis Line"
              value={value.xAxisLabel.lineColor ?? '#DEE1E3'}
              onChange={(v) => update('xAxisLabel', { lineColor: v })}
            />
          </div>

          <div className="lc-config__style-tab__block">
            <Divider />
            <p className="LabelMediumSemibold lc-config__style-tab__block-title">
              Y Axis
            </p>
            <ColorInput
              label="Axis Text Color"
              value={value.yAxisLabel.textColor ?? '#050505'}
              onChange={(v) => update('yAxisLabel', { textColor: v })}
            />
            <ColorInput
              label="Axis Data Points"
              value={value.yAxisLabel.dataPointColor ?? '#050505'}
              onChange={(v) => update('yAxisLabel', { dataPointColor: v })}
            />
          </div>

          <div className="lc-config__style-tab__block">
            <Divider />
            <p className="LabelMediumSemibold lc-config__style-tab__block-title">
              Data Table
            </p>
            <ColorInput
              label="Header Background Color"
              value={value.dataTable.headerBackgroundColor}
              onChange={(v) => update('dataTable', { headerBackgroundColor: v })}
            />
            <ColorInput
              label="Header Text Color"
              value={value.dataTable.headerTextColor}
              onChange={(v) => update('dataTable', { headerTextColor: v })}
            />
            <TextInput
              label="Header Text Size"
              labelPosition="top"
              type="number"
              value={String(value.dataTable.headerTextSize)}
              onChange={({ value: v }: { name: string; value: string }) =>
                update('dataTable', { headerTextSize: v === '' ? 0 : Number(v) })
              }
              suffix="px"
            />
            <FontWeightSelect
              label="Header Text Weight"
              value={value.dataTable.headerTextWeight}
              onChange={(v) => update('dataTable', { headerTextWeight: v })}
            />
            <TextInput
              label="Data Point Text Size"
              labelPosition="top"
              type="number"
              value={String(value.dataTable.dataPointTextSize)}
              onChange={({ value: v }: { name: string; value: string }) =>
                update('dataTable', { dataPointTextSize: v === '' ? 0 : Number(v) })
              }
              suffix="px"
            />
            <FontWeightSelect
              label="Data Point Text Weight"
              value={value.dataTable.dataPointTextWeight}
              onChange={(v) => update('dataTable', { dataPointTextWeight: v })}
            />
            <ColorInput
              label="Data Point Text Color"
              value={value.dataTable.dataPointTextColor}
              onChange={(v) => update('dataTable', { dataPointTextColor: v })}
            />
          </div>

          <div className="lc-config__style-tab__block">
            <Divider />
            <p className="LabelMediumSemibold lc-config__style-tab__block-title">
              Others
            </p>
            <ColorInput
              label="Grid Line Color"
              value={value.misc.gridLineColor}
              onChange={(v) => update('misc', { gridLineColor: v })}
            />
            <ColorInput
              label="Legend Text Color"
              value={value.misc.legendTextColor}
              onChange={(v) => update('misc', { legendTextColor: v })}
            />
          </div>
        </>
      )}
    </div>
  );
}
