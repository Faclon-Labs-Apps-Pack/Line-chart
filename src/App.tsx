import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'react-feather';
import { LineChart as DSLineChart } from '@faclon-labs/design-sdk/LineChart';
import type { ChartPlotLine, ChartPlotBand, ChartExportFormat } from '@faclon-labs/design-sdk/Chart';
import { Chart, ChartActions, exportChart } from '@faclon-labs/design-sdk/Chart';
import { bucketRange, bucketRangeInexact, buildShiftSeries, ShiftLegend } from '@faclon-labs/design-sdk';
import type {
  Periodicity,
  TimeBucket,
  ChartShiftConfig,
  ChartComparisonConfig,
  ComparisonSeriesInput,
  ShiftSourceData,
  DeviationPattern,
} from '@faclon-labs/design-sdk';
import { DatePicker } from '@faclon-labs/design-sdk/DatePicker';
import type { DatePresetOption, DateRange } from '@faclon-labs/design-sdk/DatePicker';
import { SelectInput } from '@faclon-labs/design-sdk/SelectInput';
import { DropdownMenu } from '@faclon-labs/design-sdk/DropdownMenu';
import { ActionListItem } from '@faclon-labs/design-sdk/ActionListItem';
import {
  Table,
  TableHeader,
  TableHeaderRow,
  TableHeaderCell,
  TableBody,
  TableRow,
  TableCell,
} from '@faclon-labs/design-sdk/Table';
import { EmptyState } from '@faclon-labs/design-sdk/EmptyState';
// SDK 0.6.5 ships only NoDataOneIllustration; the design's "Add Widget"
// illustration (chart window + magnifier + plus badge) isn't bundled, so we
// use the exact Figma-exported SVG assets in the EmptyState illustration slot.
import emptyStateWidgetGroup from './assets/empty-state-widget-group.svg';
import emptyStateWidgetMagnifier from './assets/empty-state-widget-magnifier.svg';
import emptyStateWidgetPlus from './assets/empty-state-widget-plus.svg';
import { LineChartConfiguration } from './components/LineChartConfiguration/LineChartConfiguration';
import {
  LineChartEnvelope,
  GTPPreset,
  ChartInstance,
  DataTableConfig,
  DataTableColumn,
  DataTableOperator,
  LineChartSeries,
} from './iosense-sdk/types';
import { validateSSOToken } from './iosense-sdk/api';
import '@faclon-labs/design-sdk/styles.css';
import './App.css';

// Compute a concrete {start, end} window for a GTPPreset (e.g. "Last 30 Days").
// End anchors to now; start walks back by x periods.
function rangeFromPreset(preset: GTPPreset | undefined): DateRange | null {
  if (!preset || typeof preset.x !== 'number') return null;
  const end = new Date();
  const start = new Date(end);
  const x = preset.x;
  switch (preset.xPeriod) {
    case 'minute': start.setMinutes(start.getMinutes() - x); break;
    case 'hour':   start.setHours(start.getHours() - x);     break;
    case 'day':    start.setDate(start.getDate() - x);       break;
    case 'week':   start.setDate(start.getDate() - x * 7);   break;
    case 'month':  start.setMonth(start.getMonth() - x);     break;
    case 'year':   start.setFullYear(start.getFullYear() - x); break;
    default: return null;
  }
  return { start, end };
}

// Approx. length of one period, used to derive valid periodicities for a range.
const PERIODICITY_MS: Record<string, number> = {
  Minute: 60_000,
  Hourly: 3_600_000,
  Daily: 86_400_000,
  Weekly: 7 * 86_400_000,
  Monthly: 28 * 86_400_000,
  Yearly: 365 * 86_400_000,
};
const PERIODICITY_ORDER = ['Minute', 'Hourly', 'Daily', 'Weekly', 'Monthly', 'Yearly'];

// Mirror of the SDK line chart's `getValidPeriodicities` (declared in the SDK
// types but not runtime-exported): the periodicities that make sense for a date
// range — at least one whole bucket fits, and not so fine the chart would render
// an unreadable number of buckets. Keeps the time picker's periodicity dropdown
// in lockstep with the selected range (a single day won't expose Yearly; a year
// won't expose Hourly), exactly like the SDK chart's time control.
function getValidPeriodicities(range: DateRange | null): string[] {
  if (!range?.start || !range?.end) return PERIODICITY_ORDER.slice();
  const span = new Date(range.end).getTime() - new Date(range.start).getTime();
  if (span <= 0) return PERIODICITY_ORDER.slice();
  const MAX_BUCKETS = 1000;
  const valid = PERIODICITY_ORDER.filter((p) => {
    const ms = PERIODICITY_MS[p];
    return span >= ms && span / ms <= MAX_BUCKETS;
  });
  return valid.length ? valid : ['Minute'];
}

// Walk a date range as x-axis category labels at the selected periodicity
// (Minute / Hourly / Daily / Weekly / Monthly). Both the step size and the
// label format follow the periodicity, so changing duration OR periodicity
// re-buckets the chart. Capped to avoid unbounded point counts.
function categoriesFromRange(range: DateRange | null, periodicity?: string): string[] {
  if (!range) return [];
  const p = (periodicity || 'Daily').toLowerCase();
  const start = new Date(range.start);
  const end = new Date(range.end);
  const out: string[] = [];
  const CAP = 240;

  const cur = new Date(start);
  const fmt = (d: Date): string => {
    switch (p) {
      case 'minute':
        return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      case 'hourly':
        return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      case 'monthly':
        return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
      case 'weekly':
      case 'daily':
      default:
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }
  };
  const advance = (d: Date): void => {
    switch (p) {
      case 'minute': d.setMinutes(d.getMinutes() + 1); break;
      case 'hourly': d.setHours(d.getHours() + 1); break;
      case 'weekly': d.setDate(d.getDate() + 7); break;
      case 'monthly': d.setMonth(d.getMonth() + 1); break;
      case 'daily':
      default: d.setDate(d.getDate() + 1); break;
    }
  };

  while (cur.getTime() <= end.getTime() && out.length < CAP) {
    out.push(fmt(cur));
    advance(cur);
  }
  return out.length ? out : [fmt(start)];
}

// Map our time-picker periodicity label to the SDK's bucketing `Periodicity`
// (the SDK supports Hourly..Yearly; Minute has no equivalent → null, handled by
// the local minute fallback).
function toSdkPeriodicity(p?: string): Periodicity | null {
  switch ((p || '').toLowerCase()) {
    case 'hourly': return 'Hourly';
    case 'daily': return 'Daily';
    case 'weekly': return 'Weekly';
    case 'monthly': return 'Monthly';
    case 'yearly': return 'Yearly';
    default: return null;
  }
}

// Next finer periodicity used by "Time drilldown" when a point is clicked.
function finerPeriodicity(p?: string): string | null {
  switch ((p || '').toLowerCase()) {
    case 'yearly': return 'Monthly';
    case 'monthly': return 'Daily';
    case 'weekly': return 'Daily';
    case 'daily': return 'Hourly';
    case 'hourly': return 'Minute';
    default: return null;
  }
}

// Deterministic pseudo-random demo series — same `seed` and `length` always
// yield the same line so screenshots and HMR don't show spurious diffs.
function demoSeriesData(seed: number, length: number, base = 50, amp = 30): number[] {
  const out: number[] = [];
  for (let i = 0; i < length; i++) {
    const noise = Math.sin(seed * 13.37 + i * 0.7) * amp;
    const drift = Math.cos(i * 0.18 + seed) * (amp * 0.5);
    out.push(Math.round((base + noise + drift) * 100) / 100);
  }
  return out;
}

export default function App() {
  const [envelope, setEnvelope] = useState<LineChartEnvelope | undefined>(undefined);
  const [auth, setAuth] = useState<string>(localStorage.getItem('bearer_token') ?? '');

  // Highcharts renders at its container's height on mount and doesn't auto-grow
  // when the flex layout changes (e.g. the bottom data table shrinks the plot
  // area). Keep a handle to the instance and reflow it on container resize so
  // the data-lines area always fills the space left above the table.
  const chartInstanceRef = useRef<
    { reflow: () => void; fdsToggleFullscreen?: () => void } | null
  >(null);
  const widgetFrameRef = useRef<HTMLDivElement | null>(null);

  // Chart display options controlled by the Settings icon menu, grouped into
  // "Time Control" / "Chart Control" per the SDK line chart. Each maps to real
  // SDK functionality: Legends→showLegend, Data Label→showDataLabels, Scroll
  // Behavior→scrollable, Clipping→bucketRange({clipping}), Inexact
  // Multiple→bucketRangeInexact, Time drilldown→onPointClick re-bucketing.
  const [chartDisplay, setChartDisplay] = useState<ChartDisplay>({
    timeDrilldown: true,
    legends: true,
    dataLabel: false,
    scrollBehavior: false,
    clipping: true,
    inexactMultiple: false,
  });
  // The Chart card root (.fds-chart). The data table is portalled into it so it
  // becomes a direct child of .fds-chart (sibling of .fds-chart__canvas) rather
  // than living inside the canvas.
  const [cardEl, setCardEl] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = widgetFrameRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const chart = chartInstanceRef.current as
        | ({ reflow: () => void; container?: HTMLElement | null } | null);
      // The chart unmounts (no data source / mode remount) but this ref may
      // still hold the destroyed instance — reflow() then throws reading
      // `container.parentNode.children`. Skip when it's been torn down.
      if (!chart || !chart.container) return;
      try {
        chart.reflow();
      } catch {
        /* chart destroyed mid-resize */
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ssoToken = params.get('token');
    if (ssoToken && !auth) {
      validateSSOToken(ssoToken)
        .then((jwt) => {
          if (jwt) {
            localStorage.setItem('bearer_token', jwt);
            setAuth(jwt);
            const url = new URL(window.location.href);
            url.searchParams.delete('token');
            window.history.replaceState({}, '', url.toString());
          }
        })
        .catch(console.error);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Compute the widget's preview size from styling.size (Custom uses
  // customWidth/customHeight; presets use fixed dimensions). Capped to 100%.
  const sizing = useMemo(() => {
    const s = envelope?.uiConfig?.style;
    if (!s || typeof s !== 'object' || !('size' in s)) return undefined;
    const size = (s as { size?: { preset?: string; customWidth?: number; customHeight?: number } }).size;
    if (!size) return undefined;
    const presetDims: Record<string, { w?: number; h?: number }> = {
      Small: { w: 580, h: 400 },
      Medium: { w: 880, h: 400 },
      Large: { w: 1780, h: 400 },
    };
    const dims =
      size.preset === 'Custom'
        ? { w: size.customWidth, h: size.customHeight }
        : presetDims[size.preset ?? 'Medium'] ?? presetDims.Medium;
    return {
      width: typeof dims.w === 'number' ? `${dims.w}px` : undefined,
      height: typeof dims.h === 'number' ? `${dims.h}px` : undefined,
      maxWidth: '100%',
      maxHeight: '100%',
    };
  }, [envelope?.uiConfig?.style]);

  // All configured charts (drives the preview title dropdown when >1).
  const charts = useMemo<ChartInstance[]>(
    () => envelope?.uiConfig?.charts ?? [],
    [envelope],
  );

  // Preview-local chart selection. null = follow the configurator's
  // activeChartId; once the user picks from the preview title dropdown this
  // overrides it so the preview can switch charts independently.
  const [previewChartId, setPreviewChartId] = useState<string | null>(null);

  // Active chart from envelope — drives series names/colors/plot lines so the
  // demo respects whatever the configurator has set up so far. The preview
  // dropdown selection wins; otherwise we follow the configurator.
  const activeChart = useMemo(() => {
    if (!charts.length) return null;
    const id = previewChartId ?? envelope?.uiConfig?.activeChartId;
    return charts.find((c) => c._id === id) ?? charts[0];
  }, [charts, previewChartId, envelope?.uiConfig?.activeChartId]);

  // Realtime charts have no periodicity — the time picker's periodicity selector
  // is hidden and bucketing falls back to the finest valid periodicity.
  const isRealtime = (activeChart?.chartType ?? 'Aggregated') === 'Realtime';

  // Until a data source is configured the preview shows only the chart title +
  // an empty state — the time picker (and chart) appear once a source exists.
  const hasDataSource = (activeChart?.series?.length ?? 0) > 0;

  // ---------------------------------------------------------------------------
  // Local Time Picker (SDK DatePicker, range mode) — presets + default come
  // from the envelope's timeConfig (the source of truth the mini-engine reads),
  // falling back to timeTabConfig for legacy envelopes.
  // ---------------------------------------------------------------------------
  // Prefer the raw SDK TimeTabUIConfig (timeTabConfig); fall back to
  // legacy `timeConfig` (which was the same SDK shape pre-refactor).
  const timeCfg = envelope?.timeTabConfig
    ?? (envelope?.timeConfig as import('./iosense-sdk/types').TimeTabUIConfig | undefined);
  const allDurations: GTPPreset[] = timeCfg?.allDurations ?? [];
  const defaultDurationId = timeCfg?.defaultDurationId;
  const defaultPeriodicity = timeCfg?.defaultPeriodicity;

  // "Link Time With" = Fixed Time Picker → the widget's time is locked, so the
  // preview shows the SDK Chart's static `duration` slot (read-only, clock icon)
  // instead of the interactive DatePicker.
  const isFixedTime = (timeCfg as { linkTimeWith?: string } | undefined)?.linkTimeWith === 'fixed';
  const fixedDurationLabel =
    (timeCfg as { fixed?: { duration?: { name?: string } } } | undefined)?.fixed?.duration?.name ||
    'Fixed Duration';

  // ---------------------------------------------------------------------------
  // Shift / Comparison render mode (SDK 0.6.8). The Time tab drives this:
  // `comparisonMode` toggle and the `shifts` list. The SDK's `comparison`/`shift`
  // props take over rendering (ignoring `series` + per-series highchartsOptions),
  // so we resolve a single `chartMode` and only ever pass one of the two props.
  // ---------------------------------------------------------------------------
  const cfgComparisonMode = !!timeCfg?.comparisonMode;
  const cfgShifts = useMemo(() => timeCfg?.shifts ?? [], [timeCfg]);
  const cfgShiftKey = cfgShifts.map((s) => s.id).join('|');

  // Local shift-chip toggle state, re-seeded to "all enabled" whenever the
  // configured shift set changes (the ShiftLegend footer drives onToggleShift).
  const [enabledShiftIds, setEnabledShiftIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    setEnabledShiftIds(new Set(cfgShifts.map((s) => s.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfgShiftKey]);
  const enabledShifts = useMemo(
    () => cfgShifts.filter((s) => enabledShiftIds.has(s.id)),
    [cfgShiftKey, enabledShiftIds],
  );

  // Master shift / comparison on/off, surfaced as the SDK DatePicker's built-in
  // "Shift" and "Comparison" toggle Switches. Both default OFF — the preview
  // shows the shift/comparison view only after the user activates the toggle in
  // the time picker. Shift is forced off when no shifts; comparison is forced
  // off when Comparison Mode is off in the Time tab. The two are MUTUALLY
  // EXCLUSIVE: activating one deactivates the other.
  // Committed state drives the chart (chartMode/preview). The time-picker
  // switches edit a DRAFT; the draft is applied to the preview only when the
  // user clicks "Apply" in the date picker (which fires onRangeChange).
  const [shiftToggleOn, setShiftToggleOn] = useState(false);
  const [comparisonToggleOn, setComparisonToggleOn] = useState(false);
  const [draftShiftOn, setDraftShiftOn] = useState(false);
  const [draftComparisonOn, setDraftComparisonOn] = useState(false);
  useEffect(() => {
    if (cfgShifts.length === 0) {
      setShiftToggleOn(false);
      setDraftShiftOn(false);
    }
  }, [cfgShifts.length]);
  useEffect(() => {
    if (!cfgComparisonMode) {
      setComparisonToggleOn(false);
      setDraftComparisonOn(false);
    }
  }, [cfgComparisonMode]);

  // Switch handlers edit the draft only — mutually exclusive (one on → other off).
  const draftActivateShift = (on: boolean) => {
    setDraftShiftOn(on);
    if (on) setDraftComparisonOn(false);
  };
  const draftActivateComparison = (on: boolean) => {
    setDraftComparisonOn(on);
    if (on) setDraftShiftOn(false);
  };
  // Apply draft → committed (called on the date picker's Apply).
  const commitToggles = () => {
    setShiftToggleOn(draftShiftOn);
    setComparisonToggleOn(draftComparisonOn);
  };
  // Re-seed the draft from committed whenever the popover opens.
  const syncDraftFromCommitted = () => {
    setDraftShiftOn(shiftToggleOn);
    setDraftComparisonOn(comparisonToggleOn);
  };

  const chartMode: 'normal' | 'comparison' | 'shift' = useMemo(() => {
    if (cfgComparisonMode && comparisonToggleOn) return 'comparison';
    if (shiftToggleOn && cfgShifts.length > 0 && enabledShifts.length > 0) return 'shift';
    return 'normal';
  }, [cfgComparisonMode, comparisonToggleOn, shiftToggleOn, cfgShifts.length, enabledShifts.length]);

  // Deviation polarity is owned by the SDK Time tab (the `fds-ttc__deviation`
  // cards → `timeTabConfig.deviationPattern`). GTPDeviationPattern is identical
  // to the chart's DeviationPattern, so it maps straight through.
  const widgetDeviationPattern: DeviationPattern =
    (timeCfg?.deviationPattern as DeviationPattern) ?? 'green-up-positive';

  const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

  const presets = useMemo<DatePresetOption[]>(
    () => allDurations.map((p) => ({ label: p.label, value: p.id })),
    [allDurations],
  );

  const [datepickerOpen, setDatepickerOpen] = useState<boolean>(false);
  const [selectedPreset, setSelectedPreset] = useState<string>('');
  // Set while a preset is being selected. Built-in presets (today/yesterday/…)
  // make the SDK fire onRangeChange as a side-effect of the selection; this flag
  // lets onRangeChange tell that apart from a manual calendar edit so it doesn't
  // wipe the just-selected preset back to "Custom".
  const presetSelectRef = useRef(false);
  const [rangeValue, setRangeValue] = useState<DateRange | null>(null);
  const [periodicityOpen, setPeriodicityOpen] = useState<boolean>(false);
  const [selectedPeriodicity, setSelectedPeriodicity] = useState<string>('');

  useEffect(() => {
    if (!defaultPeriodicity) return;
    const tc = titleCase(defaultPeriodicity);
    if (selectedPeriodicity === tc) return;
    setSelectedPeriodicity(tc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultPeriodicity]);

  const activePreset = allDurations.find((p) => p.id === selectedPreset);
  // Periodicity options come from the SDK chart's range-aware logic
  // (getValidPeriodicities) unless the preset explicitly pins its own list.
  // The configurator stores pinned periodicities lowercase ('hourly'), so
  // title-case them to match `selectedPeriodicity` — otherwise the value never
  // matches an option and the selected label fails to render in the trigger.
  const periodicityOptions =
    activePreset?.periodicities && activePreset.periodicities.length > 0
      ? activePreset.periodicities.map(titleCase)
      : getValidPeriodicities(rangeValue);

  // Keep the selected periodicity valid for the current range — if a range
  // change (or drilldown) makes it invalid, snap to the finest valid option,
  // matching the SDK time control's behavior.
  useEffect(() => {
    if (!periodicityOptions.length) return;
    if (selectedPeriodicity && periodicityOptions.includes(selectedPeriodicity)) return;
    setSelectedPeriodicity(periodicityOptions[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodicityOptions.join('|')]);

  useEffect(() => {
    if (!defaultDurationId) return;
    if (selectedPreset === defaultDurationId) return;
    if (!allDurations.find((p) => p.id === defaultDurationId)) return;
    setSelectedPreset(defaultDurationId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultDurationId, allDurations]);

  useEffect(() => {
    const preset = allDurations.find((p) => p.id === selectedPreset);
    const next = rangeFromPreset(preset);
    if (next) setRangeValue(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPreset, allDurations]);

  // The SDK DatePicker's preset chip resolves its label from a static built-in
  // map keyed by SDK preset keys (today/yesterday/…), so our configurator-defined
  // presets always render as "Custom". The menu already uses our labels and
  // selection works — only the chip label is wrong. Patch the chip text to the
  // selected preset's label, kept in sync via a MutationObserver scoped to the
  // chart's filter row (excludes the canvas, so chart hovers don't trigger it).
  useEffect(() => {
    const root = widgetFrameRef.current;
    if (!root || isFixedTime) return;
    const desired = presets.find((p) => p.value === selectedPreset)?.label || 'Custom';
    let obs: MutationObserver | null = null;
    let raf = 0;
    const apply = () => {
      const el = root.querySelector('.fds-date-trigger__preset-label');
      if (el && el.textContent !== desired) el.textContent = desired;
    };
    const attach = () => {
      const filters = root.querySelector('.fds-chart__filters');
      if (!filters) {
        raf = requestAnimationFrame(attach);
        return;
      }
      apply();
      obs = new MutationObserver(apply);
      obs.observe(filters, { childList: true, subtree: true, characterData: true });
    };
    raf = requestAnimationFrame(attach);
    return () => {
      cancelAnimationFrame(raf);
      obs?.disconnect();
    };
  }, [selectedPreset, presets, isFixedTime]);

  // "Future Days Allowed" (Time tab) — the SDK DatePicker has no `maxDate`, so
  // enforce the future limit in the popover: block clicks on (and grey) calendar
  // day cells beyond today + N days. Only applies when a value (N > 0) is
  // entered — empty/0 means no limit (any future date selectable). The
  // capture-phase click blocker is the robust guard; greying is best-effort
  // (React owns the cells, so the class is re-applied via a MutationObserver).
  useEffect(() => {
    if (isFixedTime) return;
    const rawN = Number((timeCfg as { futureDaysAllowed?: string } | undefined)?.futureDaysAllowed);
    const n = Number.isFinite(rawN) && rawN > 0 ? Math.floor(rawN) : 0;
    // No value → no future limit. Clear any leftover greying and bail.
    if (n <= 0) {
      document
        .querySelectorAll('.fds-day-cell.lc-day-future-disabled')
        .forEach((el) => el.classList.remove('lc-day-future-disabled'));
      return;
    }
    const max = new Date();
    max.setHours(23, 59, 59, 999);
    max.setDate(max.getDate() + n);
    const maxMs = max.getTime();

    const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const cellDateMs = (cell: Element): number | null => {
      const num = parseInt(cell.querySelector('.fds-day-cell__text')?.textContent ?? '', 10);
      if (!Number.isFinite(num)) return null;
      const base = cell.closest('.fds-calendar-base');
      const lbl =
        base?.querySelector('.fds-calendar-header__label-text')?.textContent?.trim().toLowerCase() ?? '';
      const [mon, yr] = lbl.split(/\s+/);
      const mi = MONTHS.indexOf((mon ?? '').slice(0, 3));
      const year = parseInt(yr ?? '', 10);
      if (mi < 0 || !Number.isFinite(year)) return null;
      return new Date(year, mi, num).getTime();
    };

    const onClick = (e: MouseEvent) => {
      const cell = (e.target as HTMLElement | null)?.closest?.('.fds-day-cell') as HTMLElement | null;
      if (!cell || cell.classList.contains('fds-day-cell--outOfMonth')) return;
      const ms = cellDateMs(cell);
      if (ms !== null && ms > maxMs) {
        e.stopPropagation();
        e.preventDefault();
      }
    };
    document.addEventListener('click', onClick, true);

    let raf = 0;
    const grey = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        document.querySelectorAll('.fds-day-cell:not(.fds-day-cell--outOfMonth)').forEach((cell) => {
          const ms = cellDateMs(cell);
          (cell as HTMLElement).classList.toggle('lc-day-future-disabled', ms !== null && ms > maxMs);
        });
      });
    };
    grey();
    const obs = new MutationObserver(grey);
    obs.observe(document.body, { childList: true, subtree: true });

    return () => {
      document.removeEventListener('click', onClick, true);
      cancelAnimationFrame(raf);
      obs.disconnect();
    };
  }, [isFixedTime, timeCfg]);

  // X-axis time buckets, built with the SDK's own bucketing so the Settings
  // "Clipping" / "Inexact Multiple" toggles drive real behavior:
  //   • Inexact Multiple ON → bucketRangeInexact (mixed largest-fit buckets)
  //   • else                → bucketRange(range, periodicity, { clipping })
  // Minute has no SDK Periodicity, so we keep the local minute fallback.
  const CATEGORY_CAP = 240;
  const timeBuckets = useMemo<Array<Pick<TimeBucket, 'label'> & Partial<TimeBucket>>>(() => {
    if (!rangeValue?.start || !rangeValue?.end) return [];
    const range = { start: new Date(rangeValue.start), end: new Date(rangeValue.end) };
    // Realtime has no user periodicity — bucket at the finest valid one so the
    // chart still renders without a periodicity selector.
    const effectivePeriodicity = isRealtime
      ? getValidPeriodicities(rangeValue)[0] ?? selectedPeriodicity
      : selectedPeriodicity;
    try {
      if (!isRealtime && chartDisplay.inexactMultiple) {
        return bucketRangeInexact(range).slice(0, CATEGORY_CAP);
      }
      const per = toSdkPeriodicity(effectivePeriodicity);
      if (per) {
        return bucketRange(range, per, { clipping: chartDisplay.clipping }).slice(0, CATEGORY_CAP);
      }
    } catch {
      /* fall through to local bucketing */
    }
    return categoriesFromRange(rangeValue, effectivePeriodicity)
      .slice(0, CATEGORY_CAP)
      .map((label) => ({ label }));
  }, [rangeValue, selectedPeriodicity, isRealtime, chartDisplay.inexactMultiple, chartDisplay.clipping]);

  const categories = useMemo(() => timeBuckets.map((b) => b.label), [timeBuckets]);

  const series = useMemo(() => {
    const configured = activeChart?.series ?? [];
    // No dummy fallback — until the user adds a data source the chart area
    // stays blank. Series (and their labels) appear only once configured.
    return configured.map((s, i) => ({
      name: s.name || `Series ${i + 1}`,
      data: demoSeriesData(i + 1, categories.length),
      color: s.color,
    }));
  }, [activeChart, categories.length]);

  // "Add Source as Tooltip" — these series stay in the chart's dataset (so a
  // shared tooltip surfaces their value when hovering other points) but render
  // no line and no legend chip. Index-aligned with `series` / `activeChart`.
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

  // ---------------------------------------------------------------------------
  // COMPARISON render contract (preview, demo data). For each configured source
  // we emit two ComparisonSeriesInput: current (solid, in legend) + the previous
  // period (dashed, hidden from legend, carrying a precomputed per-point % delta).
  // Deviation polarity comes from the per-series override, then the widget default.
  // ---------------------------------------------------------------------------
  const comparisonCategories = useMemo(() => {
    if (chartMode !== 'comparison') return undefined;
    if (!rangeValue?.start || !rangeValue?.end) return undefined;
    const startMs = +new Date(rangeValue.start);
    const endMs = +new Date(rangeValue.end);
    // Previous window of equal length, immediately preceding the current one.
    const prevRange = { start: new Date(2 * startMs - endMs), end: new Date(startMs) };
    const effPer = isRealtime
      ? getValidPeriodicities(rangeValue)[0] ?? selectedPeriodicity
      : selectedPeriodicity;
    const labels = categoriesFromRange(prevRange, effPer).slice(0, CATEGORY_CAP);
    // Match `categories.length` exactly (the SDK indexes deviation per point).
    const out = labels.slice(0, categories.length);
    while (out.length < categories.length) out.push('');
    return out;
  }, [chartMode, rangeValue, isRealtime, selectedPeriodicity, categories.length]);

  const comparisonProp = useMemo<ChartComparisonConfig | undefined>(() => {
    if (chartMode !== 'comparison') return undefined;
    const configured = activeChart?.series ?? [];
    if (!configured.length || !categories.length) return undefined;

    const out: ComparisonSeriesInput[] = [];
    configured.forEach((s, i) => {
      const name = s.name || `Series ${i + 1}`;
      const current = demoSeriesData(i + 1, categories.length);
      // Decorrelated-but-comparable previous period (offset seed, same base/amp).
      const previous = demoSeriesData(i + 1 + 1000, categories.length);
      // Per-source override (SDK Advance Settings) → else the global pattern.
      const pattern: DeviationPattern =
        (timeCfg?.sourceDeviationOverrides?.[`${activeChart?._id}:${s._id}`] as DeviationPattern) ??
        widgetDeviationPattern;
      const meta = {
        sourceId: s._id,
        sourceName: name,
        sourceIndex: i,
        shiftColor: s.color,
      };
      // Current — solid, in legend.
      out.push({
        ...meta,
        shiftId: 'current',
        shiftName: name,
        shiftIndex: 0,
        data: current,
        seriesType: 'line',
        showInLegend: true,
      });
      // Comparison — dashed, hidden from legend, carries the deviation %.
      out.push({
        ...meta,
        shiftId: 'comparison',
        shiftName: `${name} (prev)`,
        shiftIndex: 1,
        data: previous,
        dashStyle: 'Dash',
        showInLegend: false,
        deviation: current.map((y, k) => {
          const p = previous[k];
          return p && p !== 0 ? Math.round(((y - p) / p) * 1000) / 10 : null;
        }),
        deviationPattern: pattern,
      });
    });

    return {
      series: out,
      showDeviation: true,
      deviationPattern: widgetDeviationPattern,
      comparisonCategories,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartMode, activeChart, categories.length, comparisonCategories, timeCfg, widgetDeviationPattern]);

  // ---------------------------------------------------------------------------
  // SHIFT render contract (preview, demo data). Synthesize per-source/per-shift
  // values and let the SDK's buildShiftSeries shape them; the chart's categories
  // in shift mode come from the build result, not the time-picker buckets.
  // ---------------------------------------------------------------------------
  const shiftBuilt = useMemo(() => {
    if (chartMode !== 'shift') return null;
    if (!rangeValue?.start || !rangeValue?.end) return null;
    const configured = activeChart?.series ?? [];
    if (!configured.length) return null;

    const effPer = isRealtime
      ? getValidPeriodicities(rangeValue)[0] ?? selectedPeriodicity
      : selectedPeriodicity;
    const periodicity: Periodicity = toSdkPeriodicity(effPer) ?? 'Hourly';
    const bucketCount = Math.max(categories.length, 1);

    const sources: ShiftSourceData[] = configured.map((s, si) => ({
      id: s._id,
      name: s.name || `Series ${si + 1}`,
      // valuesByShift[shiftIndex][bucketIndex] — deterministic demo values.
      valuesByShift: cfgShifts.map((_sh, shIdx) =>
        demoSeriesData(shIdx * 7 + si + 1, bucketCount),
      ),
    }));

    try {
      return buildShiftSeries({
        range: { start: new Date(rangeValue.start), end: new Date(rangeValue.end) },
        periodicity,
        shifts: cfgShifts.map(({ id, name, color, startTime, endTime }) => ({
          id,
          name,
          color,
          startTime,
          endTime,
        })),
        sources,
        enabledShiftIds,
        clipping: chartDisplay.clipping,
      });
    } catch {
      return null;
    }
  }, [
    chartMode,
    rangeValue,
    activeChart,
    cfgShifts,
    enabledShiftIds,
    selectedPeriodicity,
    isRealtime,
    categories.length,
    chartDisplay.clipping,
  ]);

  const shiftProp = useMemo<ChartShiftConfig | undefined>(() => {
    if (chartMode !== 'shift' || !shiftBuilt) return undefined;
    return {
      series: shiftBuilt.series,
      sources: (activeChart?.series ?? []).map((s, i) => ({
        index: i,
        name: s.name || `Series ${i + 1}`,
      })),
      shifts: cfgShifts.map((s) => ({
        id: s.id,
        name: s.name,
        color: s.color,
        enabled: enabledShiftIds.has(s.id),
      })),
      onToggleShift: (id: string) =>
        setEnabledShiftIds((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        }),
      // Source-level hide is a follow-up; no-op keeps the legend interactive.
      onToggleSource: () => {},
    };
  }, [chartMode, shiftBuilt, activeChart, cfgShifts, enabledShiftIds]);

  // Normal mode renders our `series` + per-series highchartsOptions; comparison/
  // shift modes hand rendering to the SDK (which ignores both). Shift mode also
  // takes its x-axis categories from the build result, not the time picker.
  const showStandardSeries = chartMode === 'normal';
  const effectiveCategories =
    chartMode === 'shift' && shiftBuilt ? shiftBuilt.categories : categories;

  const plotLines = useMemo<ChartPlotLine[]>(() => {
    if (!activeChart?.plotLines) return [];
    const out: ChartPlotLine[] = [];
    for (const p of activeChart.plotLines) {
      let v = NaN;
      if (p.type === 'Dependent') {
        // Periodicity-dependent: draw the value configured for the periodicity
        // currently selected in the time picker. No entry → line is hidden for
        // that periodicity. Changing periodicity re-selects the matching value.
        const entry = (p.periodicities ?? []).find(
          (e) => e.periodicity === selectedPeriodicity,
        );
        v = entry ? Number(entry.value) : NaN;
      } else if (p.valueType === 'Fixed') {
        v = Number(p.fixedValue);
      }
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
  }, [activeChart, selectedPeriodicity]);

  const plotBands = useMemo<ChartPlotBand[]>(() => {
    if (!activeChart?.plotBands) return [];
    return activeChart.plotBands.map((b) => ({
      from: b.startValue,
      to: b.endValue,
      color: b.color,
      label: b.name,
    }));
  }, [activeChart]);

  // Left Y-axis title. Defaults to "Value"; if a Left-position axis is
  // configured with a name, that name is shown instead. Falls back to the
  // chart's default-axis label, then "Value" — so deleting all axis configs
  // reverts the left axis title to "Value".
  const leftAxisTitle = useMemo(() => {
    const leftAxis = (activeChart?.axes ?? []).find(
      (a) => a.position === 'Left' && (a.name || '').trim().length > 0,
    );
    if (leftAxis) return leftAxis.name;
    return activeChart?.defaultAxis?.yAxisLabel || 'Value';
  }, [activeChart]);

  // Multi-axis support: when the active chart has any axis with position
  // "Right", render a secondary (opposite) Y-axis per right axis, titled with
  // the axis name, and route its linked series to it. yAxis index 0 = the
  // default left axis; right axes are 1..N. Series not linked to a right axis
  // stay on the left. Returns null when no right axis is configured (single-
  // axis path handled by the yAxisTitle prop).
  const multiAxis = useMemo(() => {
    const rightAxes = (activeChart?.axes ?? []).filter((a) => a.position === 'Right');
    if (rightAxes.length === 0) return null;
    const configured = activeChart?.series ?? [];
    if (!configured.length) return null;

    const seriesAxis = configured.map((s) => {
      const idx = rightAxes.findIndex((a) => (a.linkedSeriesIds ?? []).includes(s._id));
      return idx === -1 ? 0 : idx + 1;
    });

    // Re-map plot lines/bands into Highcharts-native shape for the left axis,
    // since supplying a yAxis array replaces the SDK's computed single axis.
    const nativePlotLines = plotLines.map((p) => ({
      value: p.value,
      color: p.color,
      width: p.width,
      dashStyle: p.dashStyle,
      ...(p.label ? { label: { text: p.label } } : {}),
    }));
    const nativePlotBands = plotBands.map((b) => ({
      from: b.from,
      to: b.to,
      color: b.color,
      ...(b.label ? { label: { text: b.label } } : {}),
    }));

    const leftAxis = {
      title: { text: leftAxisTitle },
      ...(nativePlotLines.length ? { plotLines: nativePlotLines } : {}),
      ...(nativePlotBands.length ? { plotBands: nativePlotBands } : {}),
    };
    const rightYAxes = rightAxes.map((a) => ({
      title: { text: a.name || 'Axis' },
      opposite: true,
    }));

    return { yAxis: [leftAxis, ...rightYAxes], seriesAxis };
  }, [activeChart, plotLines, plotBands, leftAxisTitle]);

  // Anomaly highlighting: evaluate each configured anomaly's condition against
  // its data source. For every point where the condition holds, highlight the
  // point (halo marker) and draw a vertical red line from it, labelled with the
  // anomaly name + value. Produces per-series point overrides + xAxis plotLines.
  const anomalyOverlay = useMemo(() => {
    const configured = activeChart?.series ?? [];
    if (!configured.length) return null;
    const anomalies = activeChart?.anomalies ?? [];

    const dataByIdx = configured.map((_s, i) => demoSeriesData(i + 1, categories.length));
    const idxById = new Map(configured.map((s, i) => [s._id, i]));

    const cmp = (a: number, op: string, b: number): boolean => {
      switch (op) {
        case '>': return a > b;
        case '<': return a < b;
        case '>=': return a >= b;
        case '<=': return a <= b;
        case '==': return a === b;
        case '!=': return a !== b;
        default: return false;
      }
    };

    const xPlotLines: Array<Record<string, unknown>> = [];
    // seriesIdx -> (pointIdx -> the anomaly's configured colour for that point)
    const marked = new Map<number, Map<number, string>>();
    // Outer halo ring is ALWAYS red (low opacity); the inner dot + line use the
    // anomaly's configured colour.
    const HALO_RED = 'rgba(239,68,68,0.3)';

    for (const anom of anomalies) {
      const si = idxById.get(anom.applyToSeriesId);
      if (si === undefined) continue;
      const color = anom.color || '#ef4444';
      const data = dataByIdx[si];
      for (let pi = 0; pi < data.length; pi++) {
        let threshold: number | undefined;
        if (anom.labelMode === 'Value') threshold = anom.thresholdValue;
        else if (anom.labelMode === 'Existing' && anom.existingSeriesId) {
          const ei = idxById.get(anom.existingSeriesId);
          threshold = ei !== undefined ? dataByIdx[ei][pi] : undefined;
        } else continue; // NewSource has no data to evaluate in the preview
        if (threshold === undefined || !Number.isFinite(Number(threshold))) continue;
        if (!cmp(data[pi], anom.operator, Number(threshold))) continue;

        if (!marked.has(si)) marked.set(si, new Map());
        marked.get(si)!.set(pi, color);
        xPlotLines.push({
          value: pi,
          color, // vertical line uses the anomaly's configured colour
          width: 2,
          zIndex: 5,
          label: {
            text: `${anom.name} : ${data[pi].toFixed(1)}`,
            rotation: 0,
            y: 16,
            style: { color: '#111827', fontWeight: '600' },
          },
        });
      }
    }

    // Per-series data with an EXPLICIT marker on every point: halo on anomalous
    // points, disabled elsewhere. Setting it explicitly (rather than leaving a
    // plain number) is what lets a deleted anomaly clear its halo — Highcharts'
    // in-place update keeps a stale per-point marker when only `y` changes.
    const seriesData = configured.map((_s, i) => {
      const marks = marked.get(i);
      return dataByIdx[i].map((y, pi) =>
        marks?.has(pi)
          ? {
              y,
              marker: {
                enabled: true,
                radius: 5,
                fillColor: marks.get(pi), // inner dot: anomaly colour (100%)
                lineColor: HALO_RED, // outer ring: always red, low opacity
                lineWidth: 8,
              },
            }
          : { y, marker: { enabled: false } },
      );
    });

    return { xPlotLines, seriesData };
  }, [activeChart, categories.length]);

  // Card styling from the Style tab — background / border colour, width, radius
  // applied to the chart card so the preview reflects the configured values
  // (and their defaults). When "Wrap Into Card" is off, the card chrome is
  // removed (transparent, no border/shadow).
  const cardStyle = useMemo<React.CSSProperties | undefined>(() => {
    const card = envelope?.uiConfig?.style?.card;
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
  }, [envelope?.uiConfig?.style?.card]);

  // Chart title styling. Default (Advance Settings off): 18px semibold. When
  // Advance Settings is on, the Chart Title section (font size / color / weight)
  // maps to the preview and reflects live as the user edits it.
  const titleStyle = useMemo<React.CSSProperties>(() => {
    const weightMap: Record<string, number> = {
      Regular: 400,
      Medium: 500,
      'Semi-Bold': 600,
      Bold: 700,
    };
    const style = envelope?.uiConfig?.style;
    if (!style?.advancedEnabled || !style.chartTitle) {
      return { fontSize: 18, fontWeight: 600 };
    }
    const ct = style.chartTitle;
    return {
      fontSize: typeof ct.fontSize === 'number' ? ct.fontSize : 18,
      color: ct.fontColor || undefined,
      fontWeight: ct.fontWeight ? weightMap[ct.fontWeight] : 600,
    };
  }, [envelope?.uiConfig?.style?.advancedEnabled, envelope?.uiConfig?.style?.chartTitle]);

  // Axis colors — applied only when Advance Settings is on, so the X/Y Axis
  // sections (Axis Text Color = axis title, Axis Data Points = tick labels) map
  // to the preview live. Off → SDK default axis colors. Defaults: #050505.
  const axisColors = useMemo(() => {
    const s = envelope?.uiConfig?.style;
    if (!s?.advancedEnabled) {
      return {} as {
        xTitle?: string;
        xLabel?: string;
        xLine?: string;
        yTitle?: string;
        yLabel?: string;
      };
    }
    return {
      xTitle: s.xAxisLabel?.textColor || '#050505',
      xLabel: s.xAxisLabel?.dataPointColor || '#050505',
      xLine: s.xAxisLabel?.lineColor || '#DEE1E3',
      yTitle: s.yAxisLabel?.textColor || '#050505',
      yLabel: s.yAxisLabel?.dataPointColor || '#050505',
    };
  }, [
    envelope?.uiConfig?.style?.advancedEnabled,
    envelope?.uiConfig?.style?.xAxisLabel,
    envelope?.uiConfig?.style?.yAxisLabel,
  ]);

  // "Others" section colors — grid line + legend text. Applied only when Advance
  // Settings is on, reflecting live in the preview. Off → SDK defaults.
  const miscColors = useMemo(() => {
    const s = envelope?.uiConfig?.style;
    if (!s?.advancedEnabled) {
      return {} as { grid?: string; legend?: string };
    }
    return {
      grid: s.misc?.gridLineColor || '#DEE1E3',
      legend: s.misc?.legendTextColor || '#292F2E',
    };
  }, [envelope?.uiConfig?.style?.advancedEnabled, envelope?.uiConfig?.style?.misc]);

  // Data table cell styles — header + data point (background / color / size /
  // weight) from styling.dataTable, applied to the preview table so edits in the
  // Style → Data Table section reflect live. Defaults give the configured look.
  const dataTableStyles = useMemo(() => {
    const weightMap: Record<string, number> = {
      Regular: 400,
      Medium: 500,
      'Semi-Bold': 600,
      Bold: 700,
    };
    const dt = envelope?.uiConfig?.style?.dataTable;
    if (!dt) return undefined;
    return {
      header: {
        backgroundColor: dt.headerBackgroundColor || undefined,
        color: dt.headerTextColor || undefined,
        fontSize: typeof dt.headerTextSize === 'number' ? dt.headerTextSize : undefined,
        fontWeight: dt.headerTextWeight ? weightMap[dt.headerTextWeight] : undefined,
      } as React.CSSProperties,
      cell: {
        color: dt.dataPointTextColor || undefined,
        fontSize: typeof dt.dataPointTextSize === 'number' ? dt.dataPointTextSize : undefined,
        fontWeight: dt.dataPointTextWeight ? weightMap[dt.dataPointTextWeight] : undefined,
      } as React.CSSProperties,
    };
  }, [envelope?.uiConfig?.style?.dataTable]);

  return (
    <div className="app">
      <div className="app__config">
        <LineChartConfiguration config={envelope} authentication={auth} onChange={setEnvelope} />
      </div>
      <div className="app__widget">
        {envelope ? (
          <div className="app__widget-frame" style={sizing} ref={widgetFrameRef}>
            {/* Others → Legend Text Color. The SDK renders its own HTML legend,
                so we override its label color with a scoped rule (Advance
                Settings on; off → SDK default). */}
            {miscColors.legend && (
              <style>{`.app__widget-frame [class*="legend-label"] { color: ${miscColors.legend} !important; }`}</style>
            )}
            {/* "Add Source as Tooltip" series render in the dataset (for the
                shared tooltip) but must not show a legend chip — the SDK builds
                its HTML legend from the series prop, so suppress those items by
                their aria-label. */}
            {tooltipOnlyNames.length > 0 && (
              <style>
                {tooltipOnlyNames
                  .map(
                    (n) =>
                      `.app__widget-frame .fds-chart__scrollable-legend-item[aria-label="Toggle ${n.replace(
                        /["\\]/g,
                        '\\$&',
                      )} series"] { display: none !important; }`,
                  )
                  .join('\n')}
              </style>
            )}
            {/* Base Chart wrapper so the data table lives inside the chart card,
                below the legend (bare LineChart = canvas + legend, no card). */}
            <Chart
              ref={setCardEl}
              style={cardStyle}
              // Style tab → Hide Widget Element → Chart Title hides the title.
              title={
                envelope.uiConfig?.style?.hideElements?.chartTitle ? undefined : charts.length > 1 ? (
                  <ChartTitleSwitcher
                    charts={charts}
                    activeChart={activeChart}
                    onSelect={setPreviewChartId}
                    titleStyle={titleStyle}
                  />
                ) : (
                  <span style={titleStyle}>
                    {envelope.general?.title || activeChart?.title || 'Line Chart'}
                  </span>
                )
              }
              // Fixed Time Picker → static duration label (SDK Chart duration slot).
              duration={isFixedTime ? fixedDurationLabel : undefined}
              filters={
                !hasDataSource || isFixedTime ? undefined : (
                <DatePicker
                  mode="range"
                  isOpen={datepickerOpen}
                  onOpenChange={(open) => {
                    setDatepickerOpen(open);
                    // Re-seed the shift/comparison draft from the applied state
                    // each time the popover opens.
                    if (open) syncDraftFromCommitted();
                  }}
                  rangeValue={rangeValue}
                  onRangeChange={(v) => {
                    // Apply fires onRangeChange even when only a toggle changed
                    // (same dates) — so only clear the preset when the range
                    // actually changed, not on a toggle-only Apply.
                    const rangeChanged =
                      !v ||
                      !rangeValue ||
                      +new Date(v.start) !== +new Date(rangeValue.start) ||
                      +new Date(v.end) !== +new Date(rangeValue.end);
                    setRangeValue(v);
                    // Only a manual calendar edit clears the preset → "Custom".
                    // Skip when this is a preset selection's side-effect.
                    if (rangeChanged && !presetSelectRef.current) setSelectedPreset('');
                    // onRangeChange fires on Apply — commit the toggle draft so
                    // the preview shift/comparison view only switches on Apply.
                    commitToggles();
                  }}
                  showPresets={presets.length > 0}
                  showPresetChip={presets.length > 0}
                  // Shift / Comparison toggles (SDK DatePicker). Shift shows once
                  // shifts are configured; Comparison shows when Comparison Mode
                  // is on in the Time tab. They edit a draft (mutually exclusive)
                  // that's applied to the preview only on Apply.
                  showShift={cfgShifts.length > 0}
                  shiftEnabled={draftShiftOn}
                  onShiftToggle={draftActivateShift}
                  showComparison={cfgComparisonMode}
                  comparisonEnabled={draftComparisonOn}
                  onComparisonToggle={draftActivateComparison}
                  presets={presets}
                  selectedPreset={selectedPreset}
                  onPresetSelect={(v) => {
                    presetSelectRef.current = true;
                    setSelectedPreset(v);
                    // Reset after the synchronous preset→onRangeChange sequence.
                    setTimeout(() => {
                      presetSelectRef.current = false;
                    }, 0);
                  }}
                  placeholder="Select date range"
                  // Realtime charts have no periodicity — hide the selector.
                  showPeriodicity={!isRealtime}
                  periodicitySlot={
                    isRealtime ? undefined : (
                    <SelectInput
                      label=""
                      value={selectedPeriodicity}
                      placeholder="Periodicity"
                      isOpen={periodicityOpen}
                      onOpenChange={setPeriodicityOpen}
                      onClick={() => setPeriodicityOpen((o) => !o)}
                    >
                      <DropdownMenu className="app__periodicity-menu">
                        {periodicityOptions.map((opt) => (
                          <ActionListItem
                            key={opt}
                            title={opt}
                            selectionType="Single"
                            isSelected={opt === selectedPeriodicity}
                            onClick={() => {
                              setSelectedPeriodicity(opt);
                              setPeriodicityOpen(false);
                            }}
                          />
                        ))}
                      </DropdownMenu>
                    </SelectInput>
                    )
                  }
                />
                )
              }
              // Top-right action icons (Info / Settings / More). Info shows the
              // description on hover; Settings opens a display-options menu;
              // More opens an export menu (SDK exportChart) — all with hover
              // tooltips. Settings/Export honour the Style tab's hideElements.
              // Omit entirely when no icon would render (Info has no
              // description, Settings + Export both hidden) so the SDK Chart
              // doesn't reserve an empty header row above the canvas.
              actions={
                !!activeChart?.description?.trim() ||
                !envelope.uiConfig?.style?.hideElements?.settingsIcon ||
                !envelope.uiConfig?.style?.hideElements?.exportIcon ? (
                  <ChartActionIcons
                    description={activeChart?.description}
                    showSettings={!envelope.uiConfig?.style?.hideElements?.settingsIcon}
                    showMore={!envelope.uiConfig?.style?.hideElements?.exportIcon}
                    chartRef={chartInstanceRef}
                    display={chartDisplay}
                    onDisplayChange={setChartDisplay}
                  />
                ) : undefined
              }
              // Shift mode: the SDK renders its ShiftLegend only via its own
              // (non-bare) Chart footer; since we use `bare`, render it here in
              // our Chart's footer slot so the shift legend shows under the canvas.
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
              {hasDataSource ? (
              <DSLineChart
                // Remount on mode change so the underlying Highcharts instance is
                // rebuilt from scratch. Highcharts updates series in place, so a
                // shift→normal switch would otherwise keep the shift line colors
                // even though the SDK's React legend reverts to the configured
                // colors. A fresh instance paints the configured colors correctly.
                key={`chart-${chartMode}`}
                bare
                // Always pass `series` (the SDK ignores it when `comparison`/
                // `shift` is set, per its contract) so toggling shift/comparison
                // OFF deterministically falls back to the normal series. The mode
                // props are explicit `undefined` when inactive — never omitted —
                // so the SDK reliably clears the shift/comparison render.
                series={series}
                comparison={chartMode === 'comparison' ? comparisonProp : undefined}
                shift={chartMode === 'shift' ? shiftProp : undefined}
                categories={effectiveCategories}
                showLegend={chartDisplay.legends}
                showMarkers={false}
                showDataLabels={chartDisplay.dataLabel}
                smooth
                plotLines={showStandardSeries && !multiAxis ? plotLines : []}
                plotBands={showStandardSeries && !multiAxis ? plotBands : []}
                scrollable={chartDisplay.scrollBehavior}
                scrollableMinWidth={800}
                // xAxisTitle hidden for now (not needed): xAxisTitle="Date"
                yAxisTitle={leftAxisTitle}
                // Always assign each series' yAxis explicitly (0 = left).
                // Highcharts updates the chart instance in place, so without an
                // explicit value a series keeps a stale yAxis index when its
                // right axis is deleted — leaving it pointing at a removed axis
                // and not rendering. Setting it every render re-homes those
                // series to the left axis on deletion.
                highchartsOptions={
                  ((): any => {
                    // Let axis titles grow to the full axis length and only then
                    // ellipsize (Highcharts constrains to the axis dimension), so
                    // long names use available space instead of cutting early.
                    const titleEllipsis = { textOverflow: 'ellipsis', whiteSpace: 'nowrap' };

                    // X axis: anomaly plotLines + title ellipsis + (advanced) colors.
                    // Anomaly overlays only make sense in normal mode (their
                    // demo-series indices don't map onto comparison/shift series).
                    const xAxis: any = {
                      plotLines: showStandardSeries ? anomalyOverlay?.xPlotLines ?? [] : [],
                    };
                    xAxis.title = {
                      style: { ...titleEllipsis, ...(axisColors.xTitle ? { color: axisColors.xTitle } : {}) },
                    };
                    if (axisColors.xLabel) xAxis.labels = { style: { color: axisColors.xLabel } };
                    if (axisColors.xLine) xAxis.lineColor = axisColors.xLine;
                    if (miscColors.grid) xAxis.gridLineColor = miscColors.grid;

                    const opts: any = { xAxis };
                    // Legend Text Color is applied via scoped CSS (the SDK renders
                    // its own HTML legend, not the Highcharts SVG legend).

                    // Y axis: title ellipsis + (advanced) title/label colors.
                    // Multi-axis replaces the whole yAxis array, so merge into each
                    // axis; single axis deep-merges so a small object suffices.
                    if (multiAxis) {
                      opts.yAxis = multiAxis.yAxis.map((a: any) => ({
                        ...a,
                        title: {
                          ...(a.title || {}),
                          style: {
                            ...((a.title && a.title.style) || {}),
                            ...titleEllipsis,
                            ...(axisColors.yTitle ? { color: axisColors.yTitle } : {}),
                          },
                        },
                        ...(axisColors.yLabel
                          ? { labels: { ...(a.labels || {}), style: { ...((a.labels && a.labels.style) || {}), color: axisColors.yLabel } } }
                          : {}),
                        ...(miscColors.grid ? { gridLineColor: miscColors.grid } : {}),
                      }));
                    } else {
                      const yAxis: any = {
                        title: {
                          style: { ...titleEllipsis, ...(axisColors.yTitle ? { color: axisColors.yTitle } : {}) },
                        },
                      };
                      if (axisColors.yLabel) yAxis.labels = { style: { color: axisColors.yLabel } };
                      if (miscColors.grid) yAxis.gridLineColor = miscColors.grid;
                      opts.yAxis = yAxis;
                    }

                    // Per-series options (yAxis routing, anomaly overrides,
                    // tooltip-only hiding, shared tooltip) only apply in normal
                    // mode — the SDK ignores them when `comparison`/`shift` is set.
                    if (showStandardSeries) {
                      // Always assign each series' yAxis explicitly (0 = left) so a
                      // deleted right axis doesn't leave a stale index. Plus anomaly
                      // per-point data overrides when present.
                      opts.series = series.map((_, i) => {
                        const so: any = {
                          yAxis: multiAxis ? multiAxis.seriesAxis[i] ?? 0 : 0,
                          ...(anomalyOverlay?.seriesData?.[i]
                            ? { data: anomalyOverlay.seriesData[i] }
                            : {}),
                        };
                        // "Add Source as Tooltip": no visible line / marker /
                        // data label and no legend chip, but the series stays in
                        // the dataset (mouse-tracked) so the shared tooltip below
                        // still reports its value when hovering other points.
                        if (tooltipOnlyFlags[i]) {
                          so.lineWidth = 0;
                          so.marker = { enabled: false, states: { hover: { enabled: false } } };
                          so.dataLabels = { enabled: false };
                          so.showInLegend = false;
                          so.states = { hover: { lineWidth: 0, halo: { size: 0 } }, inactive: { opacity: 1 } };
                        }
                        return so;
                      });
                      // Shared tooltip so hovering a visible point also lists the
                      // tooltip-only series. Only switch it on when needed.
                      if (hasTooltipOnly) opts.tooltip = { shared: true };
                    }
                    return opts;
                  })()
                }
                onChartReady={(instance) => {
                  chartInstanceRef.current = instance;
                }}
                onPointClick={(ctx) => {
                  // Time drilldown (Settings → Time Control): clicking a point
                  // narrows the range to that bucket and steps the periodicity
                  // one level finer, re-bucketing via the SDK on the next render.
                  if (!chartDisplay.timeDrilldown) return;
                  const bucket = timeBuckets[ctx.pointIndex];
                  const finer = finerPeriodicity(selectedPeriodicity);
                  if (!bucket?.start || !bucket?.end || !finer) return;
                  setRangeValue({ start: new Date(bucket.start), end: new Date(bucket.end) });
                  setSelectedPreset('');
                  setSelectedPeriodicity(finer);
                }}
              />
              ) : (
                <div className="app__chart-empty">
                  <EmptyState
                    illustration={<WidgetPreviewIllustration />}
                    title="No data source added"
                    description="Add a data source in the left panel to preview the chart."
                  />
                </div>
              )}
            </Chart>
            {/* Portalled into .fds-chart so the data table is a direct child of
                the card (sibling of .fds-chart__canvas), not inside the canvas. */}
            {cardEl &&
              activeChart?.dataTable &&
              activeChart.dataTable.columns.length > 0 &&
              createPortal(
                <DataTablePreview
                  dataTable={activeChart.dataTable}
                  series={activeChart?.series ?? []}
                  categories={categories}
                  headerStyle={dataTableStyles?.header}
                  cellStyle={dataTableStyles?.cell}
                />,
                cardEl,
              )}
          </div>
        ) : (
          <div className="app__empty">
            <EmptyState
              illustration={<WidgetPreviewIllustration />}
              title="No trend data to display"
              description="Configure the widget in the left panel to preview it here."
            />
          </div>
        )}
      </div>
    </div>
  );
}

// Empty-state illustration — faithful reproduction of the Figma "Add Widget"
// graphic (node 938:36774). Three layered SVGs: the chart-window group, the
// magnifier circle, and the plus badge. Insets are taken verbatim from the
// Figma layout so the composition matches pixel-for-pixel at any scale.
const imgFill: React.CSSProperties = { display: 'block', width: '100%', height: '100%' };

function WidgetPreviewIllustration() {
  return (
    <div style={{ position: 'relative', width: 85.884, height: 90 }} aria-hidden="true">
      <div style={{ position: 'absolute', top: '5.71%', right: '2.51%', bottom: '5.34%', left: '2.99%' }}>
        <div style={{ position: 'absolute', inset: '-1.42% -1.4%' }}>
          <img src={emptyStateWidgetGroup} alt="" style={imgFill} />
        </div>
      </div>
      <div style={{ position: 'absolute', top: '67.14%', right: '16.79%', bottom: '8.38%', left: '57.64%' }}>
        <div style={{ position: 'absolute', inset: '-4.24% -4.25% -4.24% -4.26%' }}>
          <img src={emptyStateWidgetMagnifier} alt="" style={imgFill} />
        </div>
      </div>
      <div style={{ position: 'absolute', top: '74.46%', right: '24.4%', bottom: '15.69%', left: '65.29%' }}>
        <div style={{ position: 'absolute', inset: '-21.08%' }}>
          <img src={emptyStateWidgetPlus} alt="" style={imgFill} />
        </div>
      </div>
    </div>
  );
}

// Aggregate a numeric series down to a single value per the chosen operator.
function aggregate(data: number[], op: DataTableOperator): number {
  if (!data.length) return 0;
  const sum = data.reduce((a, b) => a + b, 0);
  switch (op) {
    case 'sum': return sum;
    case 'avg': return sum / data.length;
    case 'min': return Math.min(...data);
    case 'max': return Math.max(...data);
    case 'median': {
      const s = [...data].sort((a, b) => a - b);
      const m = Math.floor(s.length / 2);
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    }
    case 'first': return data[0];
    case 'last': return data[data.length - 1];
    default: return sum / data.length;
  }
}

const OPERATOR_LABEL: Record<DataTableOperator, string> = {
  sum: 'Sum', avg: 'Average', min: 'Min', max: 'Max',
  median: 'Median', first: 'First', last: 'Last',
};

// Human label for a data-table column — series name for Existing, last UNS
// path segment for AddNew.
function dataTableColumnLabel(
  col: DataTableColumn,
  seriesById: Map<string, LineChartSeries>,
): string {
  if (col.sourceMode === 'Existing' && col.seriesId) {
    const s = seriesById.get(col.seriesId);
    if (s) return s.name || `Series ${col.seriesId}`;
  }
  if (col.sourceMode === 'AddNew') {
    if (col.name?.trim()) return col.name.trim();
    if (col.topic) {
      const unwrapped = col.topic.replace(/^\{\{(.+)\}\}$/, '$1');
      const parts = unwrapped.split('/');
      return parts[parts.length - 1] || 'UNS Source';
    }
  }
  return 'Data Source';
}

// Bottom data table — shown in the preview whenever the Data Table config has
// columns. Each column's series is aggregated to a single value per the chosen
// operator; `transposeTable` swaps rows/columns and `showUnit` appends units.
function DataTablePreview({
  dataTable,
  series,
  categories,
  headerStyle,
  cellStyle,
}: {
  dataTable: DataTableConfig;
  series: LineChartSeries[];
  categories: string[];
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

  // Per-column label + raw series data (aggregation applied per operator below).
  const cols = useMemo(
    () =>
      dataTable.columns.map((col, idx) => {
        const baseLabel = dataTableColumnLabel(col, seriesById);
        // Unit source: Add New columns carry their own `unit`; Existing columns
        // inherit it from the referenced data source's configured unit (the
        // series' `limit` field, labelled "Unit" in the data-source config).
        const unit =
          col.sourceMode === 'Existing' && col.seriesId
            ? seriesById.get(col.seriesId)?.limit
            : col.unit;
        // "Show Unit" puts the configured unit on the data-source name (header),
        // not on the value cells.
        const label =
          dataTable.showUnit && unit ? `${baseLabel} (${unit})` : baseLabel;
        let data: number[];
        if (col.sourceMode === 'Existing' && col.seriesId) {
          const sIdx = series.findIndex((s) => s._id === col.seriesId);
          data = demoSeriesData(sIdx >= 0 ? sIdx + 1 : 100 + idx, categories.length);
        } else {
          data = demoSeriesData(100 + idx, categories.length);
        }
        const prec = Number.isFinite(col.dataPrecision) ? col.dataPrecision : 2;
        return { id: col._id, label, data, prec };
      }),
    [dataTable, series, categories, seriesById],
  );

  if (dataTable.transposeTable) {
    // Rows = data sources; one value column per operator.
    const nodes = cols.map((c) => {
      const row: { id: string; source: string; [op: string]: string } = {
        id: c.id,
        source: c.label,
      };
      ops.forEach((op) => {
        row[op] = aggregate(c.data, op).toFixed(c.prec);
      });
      return row;
    });
    return (
      <div className="app__data-table">
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

  // Non-transposed = leading "Data Source" header + the data-source names across
  // the header row, and one data row per operator (labelled by the operator).
  const nodes = ops.map((op) => {
    const row: { id: string; __label: string; [key: string]: string } = {
      id: op,
      __label: OPERATOR_LABEL[op],
    };
    cols.forEach((c) => {
      row[c.id] = aggregate(c.data, op).toFixed(c.prec);
    });
    return row;
  });
  return (
    <div className="app__data-table">
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

type ChartDisplay = {
  timeDrilldown: boolean;
  legends: boolean;
  dataLabel: boolean;
  scrollBehavior: boolean;
  clipping: boolean;
  inexactMultiple: boolean;
};

// Top-right chart action icons (Info / Settings / More), wired to the SDK
// chart functionality: hover tooltips, a Settings menu of display options, and
// a More menu that exports via the SDK `exportChart` (+ full screen).
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
  chartRef: React.MutableRefObject<{ reflow: () => void; fdsToggleFullscreen?: () => void } | null>;
  display: ChartDisplay;
  onDisplayChange: (next: ChartDisplay) => void;
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

  // Settings menu grouped per the SDK line chart: Time Control / Chart Control.
  // Each item drives real SDK functionality (see ChartDisplay state comment).
  const settingGroups: Array<{
    heading: string;
    items: Array<{ key: keyof ChartDisplay; label: string }>;
  }> = [
    {
      heading: 'Time Control',
      items: [{ key: 'timeDrilldown', label: 'Time drilldown' }],
    },
    {
      heading: 'Chart Control',
      items: [
        { key: 'legends', label: 'Legends' },
        { key: 'dataLabel', label: 'Data Label' },
        { key: 'scrollBehavior', label: 'Scroll Behavior' },
        { key: 'clipping', label: 'Clipping' },
        { key: 'inexactMultiple', label: 'Inexact Multiple' },
      ],
    },
  ];
  const exportFormats: ChartExportFormat[] = ['PNG', 'JPEG', 'SVG', 'CSV', 'XLSX'];

  const hasDescription = !!description?.trim();

  // Icons + hover tooltips come straight from the SDK 0.6.6 `ChartActions`
  // (Info / Settings / More, Bottom-placement tooltips). Info's tooltip carries
  // the chart description (shown only when one exists); Settings/More open our
  // menus on click — matching ChartActions' documented onSettingsClick (config
  // panel) / onMoreClick (export menu) intent.
  return (
    <div className="app__chart-actions" ref={wrapRef}>
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
        <div className="app__action-menu">
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
      )}
      {moreOpen && (
        <div className="app__action-menu">
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

// Clickable chart-title with a dropdown to switch between configured charts.
// Rendered as the Chart's `title` slot when more than one chart exists. Mirrors
// the SDK's ChartSwitcher title pattern (button + chevron + positioned menu),
// reusing the SDK's `fds-chart__title` / `fds-chart-switcher__*` classes so the
// visual matches every other switchable chart title in the platform.
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

  // Close on outside click or Escape (matches SDK ChartSwitcher behaviour).
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
