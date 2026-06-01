import { useEffect, useMemo, useState } from 'react';
import { LineChart as DSLineChart } from '@faclon-labs/design-sdk/LineChart';
import type { ChartPlotLine, ChartPlotBand } from '@faclon-labs/design-sdk/Chart';
import { DatePicker } from '@faclon-labs/design-sdk/DatePicker';
import type { DatePresetOption, DateRange } from '@faclon-labs/design-sdk/DatePicker';
import { SelectInput } from '@faclon-labs/design-sdk/SelectInput';
import { DropdownMenu } from '@faclon-labs/design-sdk/DropdownMenu';
import { ActionListItem } from '@faclon-labs/design-sdk/ActionListItem';
import { LineChartConfiguration } from './components/LineChartConfiguration/LineChartConfiguration';
import { LineChartEnvelope, GTPPreset } from './iosense-sdk/types';
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

// Walk a date range as daily category labels for the chart's x-axis.
function categoriesFromRange(range: DateRange | null): string[] {
  if (!range) return [];
  const out: string[] = [];
  const start = new Date(range.start);
  start.setHours(0, 0, 0, 0);
  const end = new Date(range.end);
  end.setHours(0, 0, 0, 0);
  const dayMs = 24 * 60 * 60 * 1000;
  const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / dayMs) + 1);
  const capped = Math.min(days, 90);
  for (let i = 0; i < capped; i++) {
    const d = new Date(start.getTime() + i * dayMs);
    out.push(d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
  }
  return out;
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

  // Active chart from envelope — drives series names/colors/plot lines so the
  // demo respects whatever the configurator has set up so far.
  const activeChart = useMemo(() => {
    const charts = envelope?.uiConfig?.charts ?? [];
    if (!charts.length) return null;
    return charts.find((c) => c._id === envelope?.uiConfig?.activeChartId) ?? charts[0];
  }, [envelope]);

  // ---------------------------------------------------------------------------
  // Local Time Picker (SDK DatePicker, range mode) — presets + default come
  // from the envelope's timeConfig (the source of truth the mini-engine reads),
  // falling back to timeTabConfig for legacy envelopes.
  // ---------------------------------------------------------------------------
  const timeCfg = envelope?.timeConfig ?? envelope?.timeTabConfig;
  const allDurations: GTPPreset[] = timeCfg?.allDurations ?? [];
  const defaultDurationId = timeCfg?.defaultDurationId;
  const defaultPeriodicity = timeCfg?.defaultPeriodicity;

  const ALL_PERIODICITIES = ['Minute', 'Hourly', 'Daily', 'Weekly', 'Monthly'];
  const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

  const presets = useMemo<DatePresetOption[]>(
    () => allDurations.map((p) => ({ label: p.label, value: p.id })),
    [allDurations],
  );

  const [datepickerOpen, setDatepickerOpen] = useState<boolean>(false);
  const [selectedPreset, setSelectedPreset] = useState<string>('');
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
  const periodicityOptions =
    activePreset?.periodicities && activePreset.periodicities.length > 0
      ? activePreset.periodicities
      : ALL_PERIODICITIES;

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

  const categories = useMemo(() => categoriesFromRange(rangeValue), [rangeValue]);

  const series = useMemo(() => {
    const configured = activeChart?.series ?? [];
    if (!configured.length) {
      return [
        { name: 'Demo A', data: demoSeriesData(1, categories.length), color: '#3b82f6' },
        { name: 'Demo B', data: demoSeriesData(2, categories.length, 60, 20), color: '#ef4444' },
      ];
    }
    return configured.map((s, i) => ({
      name: s.name || `Series ${i + 1}`,
      data: demoSeriesData(i + 1, categories.length),
      color: s.color,
    }));
  }, [activeChart, categories.length]);

  const plotLines = useMemo<ChartPlotLine[]>(() => {
    if (!activeChart?.plotLines) return [];
    const out: ChartPlotLine[] = [];
    for (const p of activeChart.plotLines) {
      const v = p.valueType === 'Fixed' ? Number(p.fixedValue) : NaN;
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

  const plotBands = useMemo<ChartPlotBand[]>(() => {
    if (!activeChart?.plotBands) return [];
    return activeChart.plotBands.map((b) => ({
      from: b.startValue,
      to: b.endValue,
      color: b.color,
      label: b.name,
    }));
  }, [activeChart]);

  return (
    <div className="app">
      <div className="app__config">
        <LineChartConfiguration config={envelope} authentication={auth} onChange={setEnvelope} />
      </div>
      <div className="app__widget">
        {envelope ? (
          <div className="app__widget-frame" style={sizing}>
            <DSLineChart
              title={envelope.general?.title || activeChart?.title || 'Line Chart'}
              series={series}
              categories={categories}
              showLegend
              showMarkers={false}
              smooth
              plotLines={plotLines}
              plotBands={plotBands}
              scrollable={categories.length > 30}
              scrollableMinWidth={800}
              xAxisTitle="Date"
              yAxisTitle={activeChart?.defaultAxis?.yAxisLabel || 'Value'}
              filters={
                <DatePicker
                  mode="range"
                  isOpen={datepickerOpen}
                  onOpenChange={setDatepickerOpen}
                  rangeValue={rangeValue}
                  onRangeChange={(v) => {
                    setRangeValue(v);
                    setSelectedPreset('');
                  }}
                  showPresets={presets.length > 0}
                  showPresetChip={presets.length > 0}
                  presets={presets}
                  selectedPreset={selectedPreset}
                  onPresetSelect={setSelectedPreset}
                  placeholder="Select date range"
                  showPeriodicity
                  periodicitySlot={
                    <SelectInput
                      label="Periodicity"
                      value={selectedPeriodicity}
                      placeholder="Select periodicity"
                      isOpen={periodicityOpen}
                      onOpenChange={setPeriodicityOpen}
                      onClick={() => setPeriodicityOpen((o) => !o)}
                    >
                      <DropdownMenu>
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
                  }
                />
              }
              onPointClick={(ctx) => {
                // eslint-disable-next-line no-console
                console.log('[Chart] point click', ctx);
              }}
            />
          </div>
        ) : (
          <div className="app__empty">
            <p className="BodyMediumRegular">Configure the widget in the left panel to preview it here.</p>
          </div>
        )}
      </div>
    </div>
  );
}
