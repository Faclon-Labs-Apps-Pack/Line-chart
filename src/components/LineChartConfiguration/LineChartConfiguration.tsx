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
  Lock,
  Unlock,
  ChevronDown,
  Info,
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
  config: LineChartEnvelope | undefined;
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
  operator: 'avg',
  showUnit: true,
};

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
    wrapInCard: true,
    backgroundColor: '#EEEEEE',
    borderColor: '#EEEEEE',
    borderWidth: 1,
    borderRadius: 8,
  },
  hideElements: { settingsIcon: false, exportIcon: false, chartTitle: false },
  advancedEnabled: false,
  chartTitle: { fontSize: 20, fontColor: '#333333', fontWeight: 'Semi-Bold' },
  xAxisLabel: { textColor: '#666666', lineColor: '#333333' },
  yAxisLabel: { textColor: '#666666', lineColor: '#333333' },
  dataTable: {
    headerBackgroundColor: '#F5F5F5',
    headerTextColor: '#999999',
    headerTextSize: 16,
    headerTextWeight: 'Semi-Bold',
    dataPointTextSize: 18,
    dataPointTextWeight: 'Medium',
    dataPointTextColor: '#2F4256',
  },
  misc: { gridLineColor: '#CCCCCC', legendTextColor: '#666666' },
};

function normalizeStyling(raw: unknown): LineChartStyling {
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if ('size' in obj && 'advancedEnabled' in obj) {
      return obj as unknown as LineChartStyling;
    }
    const card = (obj.card as Record<string, unknown> | undefined) ?? {};
    return {
      ...DEFAULT_STYLING,
      card: {
        ...DEFAULT_STYLING.card,
        wrapInCard: typeof card.wrapInCard === 'boolean' ? card.wrapInCard : true,
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

function normalizeLineChartUIConfig(raw: unknown): LineChartUIConfig {
  const obj = (raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}) as Record<string, unknown>;

  const rawDataTable = obj.dataTable as Partial<DataTableConfig> | undefined;
  const dataTable: DataTableConfig = rawDataTable
    ? { ...DEFAULT_DATA_TABLE, ...rawDataTable }
    : DEFAULT_DATA_TABLE;
  const style = normalizeStyling(obj.style);
  const deviationIndicator: DeviationIndicatorMode =
    obj.deviationIndicator === 'inverse' ? 'inverse' : 'standard';
  const advanceSettings: boolean =
    typeof obj.advanceSettings === 'boolean' ? obj.advanceSettings : false;

  // Already in new shape — pass through (still migrate inner SPC shape).
  if (Array.isArray(obj.charts)) {
    const charts = (obj.charts as ChartInstance[]).map(migrateChartSpcs);
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
    };
    return { charts: [chart], activeChartId: chart._id, dataTable, style, deviationIndicator, advanceSettings };
  }

  // Empty / fresh — no charts yet.
  return { charts: [], activeChartId: null, dataTable, style, deviationIndicator, advanceSettings };
}

// Factory for a fresh ChartInstance.
function newChart(title: string, description: string): ChartInstance {
  return {
    _id: `chart_${Date.now()}`,
    title: title.trim(),
    description: description.trim() || undefined,
    series: [],
    defaultAxis: { ...DEFAULT_DEFAULT_AXIS },
    axes: [],
    plotLines: [],
    plotBands: [],
    spcs: [],
    anomalies: [],
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
  'Statistical Process Control',
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
  'Data Table': 'Data Source',
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

  // Data Table config (widget-level).
  const [dataTable, setDataTable] = useState<DataTableConfig>(initialUiConfig.dataTable);

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
      setDataTable(next.dataTable);
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

  // Derived: hasChart + inEditMode — drive section disabling.
  const hasChart = charts.length > 0;
  const inEditMode = chartEditMode || newChartDraft;

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
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
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
  function handleCreateFirstChart(title: string, description: string) {
    const c = newChart(title, description);
    const nextCharts = [c];
    setCharts(nextCharts);
    setActiveChartId(c._id);
    setChartEditMode(false);
    setNewChartDraft(false);
    emit({ charts: nextCharts, activeChartId: c._id });
  }

  // Save the new-chart draft (Plus button flow in State 2/4).
  function handleSaveNewChart(title: string, description: string) {
    const c = newChart(title, description);
    const nextCharts = [...charts, c];
    setCharts(nextCharts);
    setActiveChartId(c._id);
    setNewChartDraft(false);
    setChartEditMode(false);
    emit({ charts: nextCharts, activeChartId: c._id });
  }

  // Save edits to the active chart's title/description.
  function handleSaveChartEdits(title: string, description: string) {
    if (!activeChartId) return;
    updateActiveChart((c) => ({
      ...c,
      title: title.trim(),
      description: description.trim() || undefined,
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
    emit({ dataTable: next });
  }
  function handleDataTableTranspose(transposeTable: boolean) {
    const next = { ...dataTable, transposeTable };
    setDataTable(next);
    emit({ dataTable: next });
  }
  function handleDataTableOperator(operator: DataTableOperator) {
    const next = { ...dataTable, operator };
    setDataTable(next);
    emit({ dataTable: next });
  }
  function handleDataTableShowUnit(showUnit: boolean) {
    const next = { ...dataTable, showUnit };
    setDataTable(next);
    emit({ dataTable: next });
  }
  function handleAddDataTableColumn(column: DataTableColumn) {
    const next = { ...dataTable, columns: [...dataTable.columns, column] };
    setDataTable(next);
    emit({ dataTable: next });
  }
  function handleUpdateDataTableColumn(column: DataTableColumn) {
    const next = {
      ...dataTable,
      columns: dataTable.columns.map((c) => (c._id === column._id ? column : c)),
    };
    setDataTable(next);
    emit({ dataTable: next });
  }
  function handleRemoveDataTableColumn(id: string) {
    const next = {
      ...dataTable,
      columns: dataTable.columns.filter((c) => c._id !== id),
    };
    setDataTable(next);
    emit({ dataTable: next });
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
                          ? <IconButton
                              icon={<Plus size={14} />}
                              size="Small"
                              accessibilityLabel={`Add ${s}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (sectionKey !== 'Data Table') ensureChartExists();
                                openAddPanel(sectionKey);
                              }}
                            />
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
                        onOperatorChange={handleDataTableOperator}
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
                <DeviationIndicatorPortal
                  scope={timeTabRef}
                  enabled={!!timeTabConfig.comparisonMode}
                  value={deviationIndicator}
                  faded={!!timeTabConfig.comparisonMode && advanceSettings}
                  onChange={handleDeviationIndicatorChange}
                />
                <AdvanceSettingsPortal
                  scope={timeTabRef}
                  enabled={!!timeTabConfig.comparisonMode}
                  open={advanceSettings}
                  onChange={handleAdvanceSettingsChange}
                  charts={charts}
                  onSeriesDeviationChange={handleSeriesDeviationChange}
                  globalDefault={deviationIndicator}
                />
              </div>
            )}

            {topTab === 'Style' && (
              <StylingSection value={styling} onChange={handleStylingChange} />
            )}
          </div>

          {/* Sticky footer (+ Add Chart). Visible in Empty state too — clicking
             creates the first chart via the new-chart-draft sub-state. Visually
             disabled (still mounted) while Chart Settings is in edit mode. */}
          {topTab === 'Data' && (
            <div
              className={`lc-config__col1-footer${
                inEditMode ? ' lc-config__col1-footer--disabled' : ''
              }`}
            >
              <Button
                variant="Secondary"
                color="Primary"
                size="Medium"
                isFullWidth
                leadingIcon={<Plus size={16} />}
                label="Add Chart"
                isDisabled={inEditMode}
                onClick={() => {
                  if (inEditMode) return;
                  setNewChartDraft(true);
                  setChartEditMode(false);
                  if (addPanel) closeAddPanel();
                }}
              />
            </div>
          )}
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
                  variant="Secondary"
                  color="Primary"
                  size="Small"
                  isFullWidth
                  label={addPanelSubmitLabel}
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
                  onSubmit={(c) => {
                    if (addPanel.mode === 'edit') handleUpdateDataTableColumn(c);
                    else handleAddDataTableColumn(c);
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
    </div>
  );
}

// ===========================================================================
// Column 1: Chart Settings 4-state block
// ===========================================================================

interface ChartSettingsBlockProps {
  charts: ChartInstance[];
  activeChart: ChartInstance | null;
  activeChartId: string | null;
  chartEditMode: boolean;
  newChartDraft: boolean;
  onSelectChart: (id: string) => void;
  onCreateFirstChart: (title: string, description: string) => void;
  onSaveNewChart: (title: string, description: string) => void;
  onSaveEdits: (title: string, description: string) => void;
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

  // Local draft for edit mode — rehydrate when entering edit OR when active chart switches.
  const [editTitle, setEditTitle] = useState<string>(activeChart?.title ?? '');
  const [editDescription, setEditDescription] = useState<string>(activeChart?.description ?? '');

  useEffect(() => {
    if (chartEditMode) {
      setEditTitle(activeChart?.title ?? '');
      setEditDescription(activeChart?.description ?? '');
    }
  }, [chartEditMode, activeChartId, activeChart]);

  // Local draft for new-chart sub-state.
  const [newTitle, setNewTitle] = useState<string>('');
  const [newDescription, setNewDescription] = useState<string>('');
  useEffect(() => {
    if (newChartDraft) {
      setNewTitle('');
      setNewDescription('');
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
                onCreateFirstChart(draftTitle.trim(), draftDescription.trim())
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
              onSaveNewChart(newTitle.trim(), newDescription.trim());
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
              onSaveEdits(editTitle.trim(), editDescription.trim());
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
  onStartNewChart: () => void;
  onEnterEditMode: () => void;
}

function ChartSettingsDisplayMode({
  charts,
  activeChart,
  isMulti,
  onSelectChart,
  onStartNewChart,
  onEnterEditMode,
}: ChartSettingsDisplayModeProps) {
  const [chartDropdownOpen, setChartDropdownOpen] = useState(false);
  return (
    <div className="lc-config__chart-settings">
      <div className="lc-config__chart-settings-header">
        <span className="BodySmallSemibold">Chart Settings</span>
        <div className="lc-config__chart-settings-header-actions">
          <IconButton
            icon={<Plus size={16} />}
            size="Medium"
            emphasis="Subtle"
            accessibilityLabel="Add new chart"
            onClick={onStartNewChart}
          />
          <IconButton
            icon={<Edit2 size={16} />}
            size="Medium"
            emphasis="Subtle"
            accessibilityLabel="Edit chart"
            onClick={onEnterEditMode}
          />
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
  onOperatorChange: (op: DataTableOperator) => void;
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

  // Data Table is special — has section-level controls inline.
  if (section === 'Data Table') {
    return (
      <>
        <SelectInput
          label="Operator *"
          placeholder="Select operator"
          value={DATA_TABLE_OPERATOR_LABELS[dataTable.operator || 'avg']}
          isOpen={dtOperatorOpen}
          onOpenChange={setDtOperatorOpen}
          onClick={() => setDtOperatorOpen((o) => !o)}
        >
          <DropdownMenu>
            {DATA_TABLE_OPERATOR_OPTIONS.map((op) => (
              <ActionListItem
                key={op}
                title={DATA_TABLE_OPERATOR_LABELS[op]}
                selectionType="Single"
                isSelected={(dataTable.operator || 'avg') === op}
                onClick={() => {
                  onOperatorChange(op);
                  setDtOperatorOpen(false);
                }}
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
  if (column.sourceMode === 'AddNew' && column.topic) {
    const unwrapped = column.topic.replace(/^\{\{(.+)\}\}$/, '$1');
    const parts = unwrapped.split('/');
    return parts[parts.length - 1] || 'UNS Source';
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

const DOWNSAMPLING_UNITS = ['Sec', 'Min', 'Hour', 'Day'];

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
  const [realTime, setRealTime] = useState(initial?.realTime ?? false);
  const [downsampling, setDownsampling] = useState(initial?.downsampling ?? '');
  const [downsamplingUnit, setDownsamplingUnit] = useState(initial?.downsamplingUnit ?? 'Min');
  const [downsamplingUnitOpen, setDownsamplingUnitOpen] = useState(false);
  const [dataPrecision, setDataPrecision] = useState(
    initial?.dataPrecision !== undefined ? String(initial.dataPrecision) : '2',
  );
  const [limit, setLimit] = useState(initial?.limit ?? '');
  const [advanceParameters, setAdvanceParameters] = useState(initial?.advanceParameters ?? false);
  const [m, setM] = useState(initial?.m ?? '');
  const [s, setS] = useState(initial?.s ?? '');
  const [addAsTooltip, setAddAsTooltip] = useState(initial?.addAsTooltip ?? false);

  const isValid = name.trim().length > 0 && dataSource.trim().length > 0;

  const submit = useCallback(() => {
    if (!isValid) return;
    onSubmit({
      _id: initial?._id ?? `series_${Date.now()}_${existingCount}`,
      name: name.trim(),
      color: color || DEFAULT_COLORS[existingCount % DEFAULT_COLORS.length],
      dataSource,
      realTime,
      downsampling: downsampling || undefined,
      downsamplingUnit: downsampling ? downsamplingUnit : undefined,
      dataPrecision: dataPrecision ? Number(dataPrecision) : undefined,
      limit: limit || undefined,
      advanceParameters: advanceParameters || undefined,
      m: advanceParameters && m ? m : undefined,
      s: advanceParameters && s ? s : undefined,
      addAsTooltip: addAsTooltip || undefined,
    });
  }, [
    isValid, initial, existingCount, name, color, dataSource, realTime,
    downsampling, downsamplingUnit, dataPrecision, limit,
    advanceParameters, m, s, addAsTooltip, onSubmit,
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

      {/* Real Time toggle */}
      <div className="lc-config__ds-row lc-config__ds-row--toggle">
        <div className="lc-config__ds-toggle-label">
          <span className="BodySmallSemibold">Real Time</span>
          <Info size={14} color="var(--text-default-tertiary, #768ea7)" />
        </div>
        <Switch
          accessibilityLabel="Toggle real time"
          isChecked={realTime}
          onChange={({ isChecked }) => setRealTime(isChecked)}
        />
      </div>

      {/* UNS Path */}
      <UNSPathInput
        label="UNS Path"
        placeholder="Enter UNS Path"
        value={dataSource}
        tree={unsTree}
        isLoading={isLoadingTree}
        onOpen={loadWorkspaces}
        onChange={(value) => setDataSource(resolveUNSValue(value))}
      />

      {/* Downsampling + Unit */}
      <div className="lc-config__ds-row lc-config__ds-row--halves">
        <TextInput
          label="Downsampling *"
          labelPosition="top"
          placeholder="Enter value"
          value={downsampling}
          onChange={({ value }: { name: string; value: string }) => setDownsampling(value)}
        />
        <SelectInput
          label="Unit"
          placeholder="Min"
          value={downsamplingUnit}
          isOpen={downsamplingUnitOpen}
          onOpenChange={setDownsamplingUnitOpen}
          onClick={() => setDownsamplingUnitOpen((o) => !o)}
        >
          <DropdownMenu>
            {DOWNSAMPLING_UNITS.map((u) => (
              <ActionListItem
                key={u}
                title={u}
                selectionType="Single"
                isSelected={u === downsamplingUnit}
                onClick={() => { setDownsamplingUnit(u); setDownsamplingUnitOpen(false); }}
              />
            ))}
          </DropdownMenu>
        </SelectInput>
      </div>

      {/* Data Precision + Limit */}
      <div className="lc-config__ds-row lc-config__ds-row--halves">
        <TextInput
          label="Data Precision"
          labelPosition="top"
          placeholder="Enter value"
          value={dataPrecision}
          onChange={({ value }: { name: string; value: string }) => setDataPrecision(value)}
        />
        <TextInput
          label="Limit"
          labelPosition="top"
          placeholder="Enter value"
          value={limit}
          onChange={({ value }: { name: string; value: string }) => setLimit(value)}
        />
      </div>

      {/* Advance Parameters toggle */}
      <div className="lc-config__ds-row lc-config__ds-row--toggle">
        <span className="BodySmallSemibold">Advance Parameters</span>
        <Switch
          accessibilityLabel="Toggle advance parameters"
          isChecked={advanceParameters}
          onChange={({ isChecked }) => setAdvanceParameters(isChecked)}
        />
      </div>

      {/* m + s (only when Advance Parameters ON) */}
      {advanceParameters && (
        <div className="lc-config__ds-row lc-config__ds-row--halves">
          <TextInput
            label="m"
            labelPosition="top"
            placeholder="Enter value"
            value={m}
            onChange={({ value }: { name: string; value: string }) => setM(value)}
          />
          <TextInput
            label="s"
            labelPosition="top"
            placeholder="Enter value"
            value={s}
            onChange={({ value }: { name: string; value: string }) => setS(value)}
          />
        </div>
      )}

      {/* Add Source as Tooltip */}
      <Checkbox
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
  unsTree,
  isLoadingTree,
  loadWorkspaces,
  resolveUNSValue,
  onSubmit,
  onReady,
}: AxisEditorProps) {
  const [name, setName] = useState(initial?.name ?? '');
  const [position, setPosition] = useState<'Left' | 'Right'>(initial?.position ?? 'Left');
  const [dataSource, setDataSource] = useState(initial?.dataSource ?? '');

  const isValid = name.trim().length > 0;

  const submit = useCallback(() => {
    if (!isValid) return;
    onSubmit({
      _id: initial?._id ?? `axis_${Date.now()}_${existingCount}`,
      name: name.trim(),
      position,
      dataSource,
      linkedSeriesIds: [],
    });
  }, [isValid, initial, existingCount, name, position, dataSource, onSubmit]);

  useEditorBinding(isValid, submit, onReady);

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
      <UNSPathInput
        label="Data Source"
        placeholder="Type / to browse UNS or paste {{topic}} directly"
        value={dataSource}
        tree={unsTree}
        isLoading={isLoadingTree}
        onOpen={loadWorkspaces}
        onChange={(v: string) => setDataSource(resolveUNSValue(v))}
      />
      <RadioGroup
        label="Axis Position"
        name="axis-position"
        value={position}
        onChange={({ value }) => setPosition(value as 'Left' | 'Right')}
        orientation="Horizontal"
      >
        <Radio label="Left" value="Left" />
        <Radio label="Right" value="Right" />
      </RadioGroup>
    </div>
  );
}

// ===========================================================================
// Editor: Plot Line
// ===========================================================================

const PERIODICITY_OPTIONS = ['Hourly', 'Daily', 'Weekly', 'Monthly'];
const LINE_STYLE_OPTIONS: PlotLineStyle[] = ['Solid', 'Dashed'];
const DURATION_TYPE_OPTIONS = ['Fixed', 'Custom'];
const DOWNSAMPLING_UNIT_OPTIONS = ['second', 'minute', 'hour', 'day', 'week', 'month', 'year'];

interface PlotLineEditorProps {
  initial: LineChartPlotLine | null;
  existingCount: number;
  unsTree: import('@faclon-labs/design-sdk/UNSPathInput').UNSTree;
  isLoadingTree: boolean;
  loadWorkspaces: () => void;
  resolveUNSValue: (raw: string) => string;
  onSubmit: (line: LineChartPlotLine) => void;
  onReady: (b: EditorBinding) => void;
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
}: PlotLineEditorProps) {
  const [name, setName] = useState(initial?.name ?? '');
  const [color, setColor] = useState(initial?.color ?? '#3b82f6');
  const [type, setType] = useState<PlotLineType>(initial?.type ?? 'Independent');
  const [valueType, setValueType] = useState<PlotLineValueType>(
    initial?.valueType ?? 'Fixed',
  );
  const [valueTypeOpen, setValueTypeOpen] = useState(false);
  const [fixedValue, setFixedValue] = useState(initial?.fixedValue ?? '');
  const [dynamicTopic, setDynamicTopic] = useState(initial?.dynamicTopic ?? '');
  const [downsampling, setDownsampling] = useState(initial?.downsampling ?? '');
  const [downsamplingUnit, setDownsamplingUnit] = useState(initial?.downsamplingUnit ?? '');
  const [downsamplingUnitOpen, setDownsamplingUnitOpen] = useState(false);
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
    setPeriodicities((rows) => [...rows, { periodicity: 'Hourly', value: 0 }]);
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
      downsampling: isDynamic && downsampling ? downsampling : undefined,
      downsamplingUnit: isDynamic && downsamplingUnit ? downsamplingUnit : undefined,
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
    downsampling,
    downsamplingUnit,
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

      <RadioGroup
        label="Plotline Type"
        name="plotline-type"
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
        <UNSPathInput
          label="Value *"
          placeholder="Type / to browse UNS or paste {{topic}} directly"
          value={fixedValue}
          tree={unsTree}
          isLoading={isLoadingTree}
          onOpen={loadWorkspaces}
          onChange={(v: string) => setFixedValue(resolveUNSValue(v))}
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
              label="Downsampling *"
              labelPosition="top"
              placeholder="Enter value"
              value={downsampling}
              onChange={({ value }: { name: string; value: string }) =>
                setDownsampling(value)
              }
            />
            <SelectInput
              label="Downsampling Unit *"
              placeholder="Select unit"
              value={downsamplingUnit}
              isOpen={downsamplingUnitOpen}
              onOpenChange={setDownsamplingUnitOpen}
              onClick={() => setDownsamplingUnitOpen((o) => !o)}
            >
              <DropdownMenu>
                {DOWNSAMPLING_UNIT_OPTIONS.map((opt) => (
                  <ActionListItem
                    key={opt}
                    title={opt}
                    selectionType="Single"
                    isSelected={downsamplingUnit === opt}
                    onClick={() => {
                      setDownsamplingUnit(opt);
                      setDownsamplingUnitOpen(false);
                    }}
                  />
                ))}
              </DropdownMenu>
            </SelectInput>
          </div>
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
                  {PERIODICITY_OPTIONS.map((p) => (
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
        <div className="lc-config__date-row">
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
  const [advanceEnabled, setAdvanceEnabled] = useState(initial?.advanceEnabled ?? false);
  const [advanceM, setAdvanceM] = useState(
    typeof initial?.advanceM === 'number' ? String(initial.advanceM) : '',
  );
  const [advanceC, setAdvanceC] = useState(
    typeof initial?.advanceC === 'number' ? String(initial.advanceC) : '',
  );

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
    if (advanceEnabled) {
      anom.advanceEnabled = true;
      const m = Number(advanceM);
      const c = Number(advanceC);
      if (Number.isFinite(m)) anom.advanceM = m;
      if (Number.isFinite(c)) anom.advanceC = c;
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
    advanceEnabled,
    advanceM,
    advanceC,
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

      <div className="lc-config__switch-row">
        <span className="lc-config__switch-label LabelMediumRegular">
          Advance Parameters
        </span>
        <Switch
          accessibilityLabel="Toggle advance parameters"
          isChecked={advanceEnabled}
          onChange={({ isChecked }) => setAdvanceEnabled(isChecked)}
        />
      </div>

      {advanceEnabled && (
        <div className="lc-config__date-row">
          <TextInput
            label="m"
            labelPosition="top"
            placeholder="e.g. 1"
            value={advanceM}
            onChange={({ value }: { name: string; value: string }) => setAdvanceM(value)}
          />
          <TextInput
            label="c"
            labelPosition="top"
            placeholder="e.g. 0"
            value={advanceC}
            onChange={({ value }: { name: string; value: string }) => setAdvanceC(value)}
          />
        </div>
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
  onSubmit: (c: DataTableColumn) => void;
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
  // Existing
  const [seriesId, setSeriesId] = useState(initial?.seriesId ?? '');
  // AddNew
  const [topic, setTopic] = useState(initial?.topic ?? '');
  const [downsampling, setDownsampling] = useState(initial?.downsampling ?? '');
  const [downsamplingUnit, setDownsamplingUnit] = useState(initial?.downsamplingUnit ?? '');
  const [dataPrecision, setDataPrecision] = useState(
    typeof initial?.dataPrecision === 'number' ? String(initial.dataPrecision) : '2',
  );
  const [unit, setUnit] = useState(initial?.unit ?? '');

  const [seriesDropdownOpen, setSeriesDropdownOpen] = useState(false);
  const [downsamplingUnitOpen, setDownsamplingUnitOpen] = useState(false);

  const seriesById = useMemo(() => {
    const m = new Map<string, LineChartSeries>();
    series.forEach((s) => m.set(s._id, s));
    return m;
  }, [series]);

  const seriesLabel = seriesId ? (seriesById.get(seriesId)?.name ?? '') : '';

  const isValid = sourceMode === 'Existing' ? !!seriesId : topic.trim().length > 0;

  const submit = useCallback(() => {
    if (!isValid) return;
    const precNum = Number(dataPrecision);
    const precision = Number.isFinite(precNum) && precNum >= 0 ? Math.floor(precNum) : 2;
    if (sourceMode === 'Existing') {
      onSubmit({
        _id: initial?._id ?? `dtcol_${Date.now()}_${existingCount}`,
        sourceMode,
        seriesId,
        dataPrecision: precision,
        unit: unit.trim() || undefined,
      });
    } else {
      onSubmit({
        _id: initial?._id ?? `dtcol_${Date.now()}_${existingCount}`,
        sourceMode,
        topic,
        downsampling: downsampling.trim() || undefined,
        downsamplingUnit: downsamplingUnit || undefined,
        dataPrecision: precision,
        unit: unit.trim() || undefined,
      });
    }
  }, [
    isValid, initial, existingCount, sourceMode, seriesId,
    topic, downsampling, downsamplingUnit, dataPrecision, unit, onSubmit,
  ]);

  useEditorBinding(isValid, submit, onReady);

  return (
    <div className="lc-config__editor">
      <RadioGroup
        label="Source Mode"
        name="dt-source-mode"
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
          label="Data Source *"
          placeholder={series.length === 0 ? 'No series available' : 'Select data source'}
          value={seriesLabel}
          isOpen={seriesDropdownOpen}
          onOpenChange={setSeriesDropdownOpen}
          onClick={() => setSeriesDropdownOpen((o) => !o)}
          isDisabled={series.length === 0}
        >
          <DropdownMenu>
            {series.map((s) => (
              <ActionListItem
                key={s._id}
                title={s.name || `Series ${s._id}`}
                selectionType="Single"
                isSelected={seriesId === s._id}
                onClick={() => {
                  setSeriesId(s._id);
                  setSeriesDropdownOpen(false);
                }}
              />
            ))}
          </DropdownMenu>
        </SelectInput>
      )}

      {/* ── Add New — UNS path + Downsampling + Precision ── */}
      {sourceMode === 'AddNew' && (
        <>
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
              label="Downsampling *"
              labelPosition="top"
              placeholder="Enter value"
              value={downsampling}
              onChange={({ value }: { name: string; value: string }) => setDownsampling(value)}
            />
            <SelectInput
              label="Downsampling Unit *"
              placeholder="Seconds"
              value={downsamplingUnit}
              isOpen={downsamplingUnitOpen}
              onOpenChange={setDownsamplingUnitOpen}
              onClick={() => setDownsamplingUnitOpen((o) => !o)}
            >
              <DropdownMenu>
                {DOWNSAMPLING_UNIT_OPTIONS.map((u) => (
                  <ActionListItem
                    key={u}
                    title={u.charAt(0).toUpperCase() + u.slice(1)}
                    selectionType="Single"
                    isSelected={downsamplingUnit === u}
                    onClick={() => {
                      setDownsamplingUnit(u);
                      setDownsamplingUnitOpen(false);
                    }}
                  />
                ))}
              </DropdownMenu>
            </SelectInput>
          </div>

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

interface ColorSwatchInputProps {
  label: string;
  value: string;
  onChange: (next: string) => void;
}

function ColorSwatchInput({ label, value, onChange }: ColorSwatchInputProps) {
  return (
    <div className="lc-config__style-tab__color-row">
      <TextInput
        label={label}
        labelPosition="top"
        placeholder="#000000"
        value={value}
        onChange={({ value: v }: { name: string; value: string }) => onChange(v)}
        trailingIcon={
          <span
            className="lc-config__style-tab__swatch"
            style={{ background: value || 'transparent' }}
            aria-hidden="true"
          />
        }
      />
    </div>
  );
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
  const [sizeOpen, setSizeOpen] = useState(false);

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

  const sizePresetLabels: StylingWidgetSize[] = ['Small', 'Medium', 'Large', 'Custom'];

  return (
    <div className="lc-config__section lc-config__style-tab">
      <div className="lc-config__style-tab__row">
        <SelectInput
          label="Widget Size"
          value={value.size.preset}
          isOpen={sizeOpen}
          onOpenChange={setSizeOpen}
          onClick={() => setSizeOpen((o) => !o)}
        >
          <DropdownMenu>
            {sizePresetLabels.map((p) => (
              <ActionListItem
                key={p}
                title={p}
                description={SIZE_PRESETS[p].label}
                selectionType="Single"
                isSelected={value.size.preset === p}
                onClick={() => {
                  const preset = SIZE_PRESETS[p];
                  update('size', {
                    preset: p,
                    customWidth:
                      p === 'Custom'
                        ? value.size.customWidth ?? preset.w ?? 880
                        : preset.w,
                    customHeight:
                      p === 'Custom'
                        ? value.size.customHeight ?? preset.h ?? 400
                        : preset.h,
                  });
                  setSizeOpen(false);
                }}
              />
            ))}
          </DropdownMenu>
        </SelectInput>
      </div>

      {value.size.preset === 'Custom' && (
        <div className="lc-config__style-tab__size-row">
          <TextInput
            label="W"
            labelPosition="top"
            type="number"
            value={String(value.size.customWidth ?? '')}
            onChange={({ value: v }: { name: string; value: string }) =>
              update('size', { customWidth: v === '' ? undefined : Number(v) })
            }
          />
          <div className="lc-config__style-tab__lock">
            <IconButton
              icon={
                value.size.lockAspectRatio ? (
                  <Lock size={16} />
                ) : (
                  <Unlock size={16} />
                )
              }
              size="Small"
              accessibilityLabel={
                value.size.lockAspectRatio ? 'Aspect ratio locked' : 'Aspect ratio unlocked'
              }
              isHighlighted={value.size.lockAspectRatio}
              onClick={() =>
                update('size', { lockAspectRatio: !value.size.lockAspectRatio })
              }
            />
          </div>
          <TextInput
            label="H"
            labelPosition="top"
            type="number"
            value={String(value.size.customHeight ?? '')}
            onChange={({ value: v }: { name: string; value: string }) =>
              update('size', { customHeight: v === '' ? undefined : Number(v) })
            }
          />
        </div>
      )}

      <div className="lc-config__style-tab__switch-row">
        <span className="LabelMediumRegular lc-config__style-tab__switch-label">
          Wrap Into Card
        </span>
        <Switch
          isChecked={value.card.wrapInCard}
          onChange={({ isChecked }) => update('card', { wrapInCard: isChecked })}
          accessibilityLabel="Wrap into card"
        />
      </div>

      <ColorSwatchInput
        label="Background Color"
        value={value.card.backgroundColor}
        onChange={(v) => update('card', { backgroundColor: v })}
      />
      <ColorSwatchInput
        label="Border Color"
        value={value.card.borderColor}
        onChange={(v) => update('card', { borderColor: v })}
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
            isChecked={value.hideElements.settingsIcon}
            onClick={() =>
              update('hideElements', { settingsIcon: !value.hideElements.settingsIcon })
            }
          />
          <Checkbox
            label="Export Icon"
            isChecked={value.hideElements.exportIcon}
            onClick={() =>
              update('hideElements', { exportIcon: !value.hideElements.exportIcon })
            }
          />
          <Checkbox
            label="Chart Title"
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
            <ColorSwatchInput
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
            <ColorSwatchInput
              label="Axis Text Color"
              value={value.xAxisLabel.textColor}
              onChange={(v) => update('xAxisLabel', { textColor: v })}
            />
            <ColorSwatchInput
              label="Axis Line Color"
              value={value.xAxisLabel.lineColor}
              onChange={(v) => update('xAxisLabel', { lineColor: v })}
            />
          </div>

          <div className="lc-config__style-tab__block">
            <Divider />
            <p className="LabelMediumSemibold lc-config__style-tab__block-title">
              Y Axis
            </p>
            <ColorSwatchInput
              label="Axis Text Color"
              value={value.yAxisLabel.textColor}
              onChange={(v) => update('yAxisLabel', { textColor: v })}
            />
            <ColorSwatchInput
              label="Axis Line Color"
              value={value.yAxisLabel.lineColor}
              onChange={(v) => update('yAxisLabel', { lineColor: v })}
            />
          </div>

          <div className="lc-config__style-tab__block">
            <Divider />
            <p className="LabelMediumSemibold lc-config__style-tab__block-title">
              Data Table
            </p>
            <ColorSwatchInput
              label="Header Background Color"
              value={value.dataTable.headerBackgroundColor}
              onChange={(v) => update('dataTable', { headerBackgroundColor: v })}
            />
            <ColorSwatchInput
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
            <ColorSwatchInput
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
            <ColorSwatchInput
              label="Grid Line Color"
              value={value.misc.gridLineColor}
              onChange={(v) => update('misc', { gridLineColor: v })}
            />
            <ColorSwatchInput
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
