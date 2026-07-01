# Shift & Comparison in LineChart — Deep Dive

> How both modes work end-to-end, from data model to SDK rendering.

---

## The core principle: the backend never knows about shift or comparison

The `resolveAndCompute` API just returns raw time-bucketed slots — one value per time bucket per source. It doesn't understand shifts, and it can't return "this period vs last period" in a single call. Both modes are **100% frontend**.

---

## What `resolveAndCompute` returns

```
SeriesSlot: { from: <unix ms>, to: <unix ms>, label: "...", value: number | null }
```

The widget receives these as `data: DataEntry[]` — an array where each entry has a `key` (matching the binding path e.g. `charts[0].series[0].unsPath`) and a `value` that is a `SeriesPayload` containing a `slots[]` array.

This is the **only** data input. Nothing else arrives from outside.

---

## Mode 1: Shift

### What it is

Show all series split by time-of-day windows (e.g. Morning 06:00–14:00, Evening 14:00–22:00, Night 22:00–06:00). Each shift renders as a separate colored line on the same chart.

### How it works — pure slot masking

The configurator saves shift definitions in `timeConfig.shifts` — each shift has a name, color, `startTime`, and `endTime` (HH:MM strings).

The widget already has all the slots from `resolveAndCompute`. At render time it runs `isSlotInShift()`:

```ts
// LineChart.tsx:239
function isSlotInShift(timestampMs, startTime, endTime, timezone) {
  const slotMin = slotMinutesOfDay(timestampMs, timezone); // time-of-day in minutes
  const s = sh * 60 + sm;
  const e = eh * 60 + em;
  return s < e
    ? slotMin >= s && slotMin < e      // normal shift
    : slotMin >= s || slotMin < e;     // night shift crossing midnight
}
```

For each **series × shift** pair it builds a data array where slots **outside that shift window are set to null**. A slot in Morning shift → null in Evening shift, and vice versa. Same X-axis (time categories), different null patterns per shift.

```ts
// shiftProp useMemo — LineChart.tsx:588
data: s.data.map((v, ci) => {
  const ts = catTimestamps[ci];
  return isSlotInShift(ts.from, shift.startTime, shift.endTime, tz) ? v : null;
})
```

### Constraint: minute/hourly periodicity only

Daily/weekly/monthly slots span full days — "time of day" masking is meaningless. The shift toggle is automatically hidden for those periodicities.

### What gets passed to the SDK

```ts
shiftProp = {
  series: [
    { sourceId, sourceName, shiftId: "morning", shiftName: "Morning", shiftColor: "#...", data: [...] },
    { sourceId, sourceName, shiftId: "evening", shiftName: "Evening", shiftColor: "#...", data: [...] },
    // one entry per series × enabled shift
  ],
  shifts: [{ id, name, color, enabled }],
  onToggleShift: (id) => ...,  // toggling a shift chip in the legend footer
}
```

The `DSLineChart` SDK component receives this as the `shift` prop, calls `toLineSeries()` from `encoding.js` to convert it into Highcharts series, and renders `ShiftLegend` as a footer with colored shift chips.

**No extra API call. Zero. The backend already gave us all the data.**

---

## Mode 2: Comparison

### What it is

Overlay this period vs the previous period. Same duration window, shifted back by one period. Each series shows as a solid line (current) + dashed line (previous), with a tooltip showing % deviation.

### Why it needs a second API call

The DataLayer only calls `resolveAndCompute` for the current time window. There is no "also give me the previous period" parameter. So the widget makes its own second call for the shifted window.

### How the second call works

The widget captures the Angular host's Bearer token passively using an XHR/fetch interceptor (`getCapturedToken()` in `api.ts`). This token is captured the moment any Angular HTTP call goes out — never stored in config, never hardcoded.

When comparison mode is active and the time range changes:

```ts
// Comparison fetch effect — LineChart.tsx:495
const duration    = rangeEnd - rangeStart;
const prevStart   = rangeStart - duration;   // shift window back by one period
const prevEnd     = rangeEnd   - duration;

resolveAndCompute(token, bindings, prevStart, prevEnd, resolution)
  .then(results => setComparisonSeriesData(new Map(...)))
```

The bindings are the exact same UNS paths as the current period — only the time window changes.

### Building the comparison prop

Once both current data (from the `data` prop) and previous data (from `comparisonSeriesData` state) are available:

```ts
// comparisonProp useMemo — LineChart.tsx:515
// For each series:
// - currentData: slot values aligned to categories[]
// - prevData: previous period slots, timestamp-aligned (not index-aligned)
out.push({ ...meta, shiftId: 'current',    data: currentData });
out.push({ ...meta, shiftId: 'comparison', data: prevData, dashStyle: 'Dash',
           deviation, deviationPattern });
```

### Timestamp alignment (not index alignment)

Previous period may have a different slot count (e.g. Feb has fewer days than March). We compute the time offset between period origins and look each category up in a Map keyed by `slot.from`:

```ts
const offset = currOrigin - prevOrigin;
return catTimestamps.map(ts => prevSlotMap.get(ts.from - offset) ?? null);
```

This guarantees correct pairing even when slot counts differ between periods.

### What gets passed to the SDK

```ts
comparisonProp = {
  series: [ currentEntry, previousEntry, ... ],  // pairs per source
  showDeviation: true,
  deviationPattern: 'green-up-positive',         // from timeConfig (configurable)
  comparisonCategories: categories,              // previous-period labels for tooltip
}
```

The SDK renders solid + dashed lines, and the tooltip shows both values plus a green/red arrow with % change.

---

## The three modes are mutually exclusive

```ts
// LineChart.tsx:416
const chartMode = useMemo(() => {
  if (cfgComparisonMode && comparisonToggleOn) return 'comparison';
  if (shiftToggleOn && cfgShifts.length > 0)  return 'shift';
  return 'normal';
}, [...]);
```

`DSLineChart` receives either `shift={shiftProp}` **or** `comparison={comparisonProp}` — never both. If both were set the SDK ignores comparison (and warns in dev).

---

## Full state flow

```
User opens DatePicker
  │
  ├── toggles Shift ON      → draftShiftOn = true,      draftComparisonOn = false
  └── toggles Compare ON    → draftComparisonOn = true,  draftShiftOn = false
                │
                ▼ clicks Apply
          commitToggles()
                │
                ▼
         chartMode recomputes
                │
    ┌───────────┼─────────────────────────┐
    │           │                         │
  'shift'  'comparison'               'normal'
    │           │                         │
    ▼           ▼                         ▼
 shiftProp   comparisonProp        plain series[]
 useMemo:    useMemo:              no extra API call
 mask slots  merge current data
 by time-of  + second resolveAndCompute
 day window  for previous window
    │           │
    ▼           ▼
 SDK shift   SDK comparison
 prop        prop
 (toLineSeries + ShiftLegend)
 (toLineSeries + comparisonTooltip + deviation %)
```

---

## Why we did NOT add shift/comparison to `resolveAndCompute`

We checked with the backend team (Dishant). Adding shift support to `resolveAndCompute` would require DB graph schema changes — more work than the frontend approach and no real benefit since:

- **Shift** needs zero extra data — it's pure masking of existing slots.
- **Comparison** only needs a second call with a different time window — same API, same paths.

The frontend approach is correct and complete as-is.

---

## Key files

| File | What it contains |
|---|---|
| `src/components/LineChart/LineChart.tsx:239` | `isSlotInShift()` — the core shift filter |
| `src/components/LineChart/LineChart.tsx:416` | `chartMode` derivation (normal / shift / comparison) |
| `src/components/LineChart/LineChart.tsx:495` | Comparison fetch effect + `comparisonSeriesData` state |
| `src/components/LineChart/LineChart.tsx:515` | `comparisonProp` useMemo — builds SDK comparison config |
| `src/components/LineChart/LineChart.tsx:588` | `shiftProp` useMemo — builds SDK shift config |
| `src/iosense-sdk/api.ts:10` | `getCapturedToken()` — passive Bearer token interceptor |
| `node_modules/@faclon-labs/design-sdk/.../encoding.js` | `toLineSeries()` — converts shift/comparison input to Highcharts series |
| `node_modules/@faclon-labs/design-sdk/.../tooltipFormatters.js` | `comparisonTooltip` — % deviation with green/red arrows |
