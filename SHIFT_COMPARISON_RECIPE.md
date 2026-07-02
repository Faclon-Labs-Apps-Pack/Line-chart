# Shift & Comparison Plotting — Recipe (port to Column / Combo Bar-Line)

How the LineChart widget implements **shift** and **comparison** modes. The data
contract and pipeline are chart-agnostic; only the final "build the SDK prop"
step differs per chart component.

## Mental model

Two independent, mutually-exclusive modes, both **driven by the DATA the backend
returns**, not by UI state:

| Mode | Requested when | Rendered when |
|---|---|---|
| comparison | Compare toggle on (config `comparisonMode`) | any slot has `comparisonSlots[]` |
| shift | Shift toggle on (config has `shifts`) | any slot has a `shift` tag |
| normal | — | neither of the above |

**Request side** = toggles/config decide what we ask for.
**Render side** = the response decides what we draw.
Keep these two separate — it's the key idea.

---

## 1. Types (`iosense-sdk/types.ts`)

```ts
// per-bucket shift tag from backend
interface SeriesSlot { …; shift?: string; }
// previous-period buckets from backend (already existed for comparison)
interface SeriesPayload { …; comparisonSlots?: SeriesSlot[]; }

// shift window definition (mirrors SDK GTPShift)
interface ShiftWindow { id: string; name: string; color: string;
                        startTime: string; endTime: string; } // "HH:mm"

// TIME_CHANGE event payload gains optional mode fields:
type WidgetEvent = { type:'TIME_CHANGE'; payload: {
  startTime:string; endTime:string; periodicity:string;
  comparisonStartTime?:string; comparisonEndTime?:string;   // comparison
  shifts?: ShiftWindow[]; shiftAggregator?: string;         // shift
}} | …;

// host time config the widget reads
interface HostTimeConfig { …; shifts?: …; shiftAggregator?: string; }
```

## 2. Configurator (`*Configuration.tsx`)

- The SDK `TimeTabConfiguration` already collects `shifts[]` and a **Shift
  Aggregator** dropdown (Sum/Average/Min/Max/First/Last) plus Comparison Mode.
- In `toHostTimeConfig()` **propagate `shiftAggregator`** (it was being dropped):
  ```ts
  shiftAggregator: pickerType==='fixed'  ? t.fixed?.shiftAggregator  ?? t.shiftAggregator
                 : pickerType==='global' ? t.global?.shiftAggregator ?? t.shiftAggregator
                 : t.shiftAggregator,
  ```
- No other configurator change; the UI is identical across modes.

## 3. Backend contract (`resolveAndCompute`)

Request body (add to the existing `{graph, config, startTime, endTime, timeFrame, resolution}`):

- **comparison:** `comparisonMode:true, comparisonStartTime, comparisonEndTime`
- **shift:** `shifts:[{id,name,color,startTime,endTime}], shiftAggregator:"sum"`
  (map the config label to backend op: **Average→`mean`**, others → lowercase.)

Response:

- **comparison:** each series item gains `comparisonSlots[]`, index-aligned to `slots`.
- **shift:** each `slot` gains `"shift":"<name>"`, and `slots` are windowed to the
  shift ranges; `meta.shifts` echoes the definitions. With 3 contiguous shifts a
  full day comes back fully tagged (e.g. 168 hourly slots split 56/56/56).

## 4. Data pipeline (host side: `App.tsx` → `mini-engine.ts` → `api.ts`)

- **App**: capture `shifts`, `shiftAggregator`, `comparisonStart/EndTime` off the
  TIME_CHANGE payload into the resolve `override`; pass into `resolve()` ctx.
- **mini-engine `resolve()`**: forward `ctx.comparison` and
  `ctx.shifts/shiftAggregator` into `resolveAndCompute(...)`.
- **api `resolveAndCompute()`**: append the body fields above when present.

### ⚠️ Stale-response race (must-fix once render is data-driven)
Async resolves can land out of order (initial no-shift resolve vs. the shift
resolve fired by the widget's mount `TIME_CHANGE`). A late untagged response
clobbers the tagged one and the chart flips to normal. Guard it:

```ts
const resolveSeqRef = useRef(0);
async function runResolve(...) {
  const seq = ++resolveSeqRef.current;
  const result = await resolve(...);
  if (seq !== resolveSeqRef.current) return; // stale — newer resolve superseded
  setResolvedData(result.data);
}
```

## 5. Widget — REQUEST side (emit the mode fields)

- Read config: `cfgShifts = timeConfig?.shifts`, `cfgShiftAggregator = timeConfig?.shiftAggregator`.
- DatePicker shift toggle visibility (contiguous shifts only make sense sub-daily):
  ```ts
  showShift={cfgShifts.length>0 && ['minute','hourly'].includes(selectedPeriodicity.toLowerCase())}
  ```
  (Note the `.toLowerCase()` — periodicity is title-case "Hourly".)
- Draft-in-picker → commit-on-Apply toggle state; shift & comparison mutually
  exclusive (`draftActivateShift` clears comparison and vice-versa).
- Latest-committed refs for emitters: `shiftActiveRef`, `comparisonActiveRef`.
- Helpers:
  ```ts
  const SHIFT_AGGREGATOR_OPERATOR = {sum:'sum',average:'mean',mean:'mean',min:'min',max:'max',first:'first',last:'last'};
  const shiftEventPayload = (shifts, agg) => shifts.length
    ? { shifts, shiftAggregator: SHIFT_AGGREGATOR_OPERATOR[(agg||'').toLowerCase()] ?? (agg||'').toLowerCase() } : {};
  const comparisonWindowPayload = (s,e) => ({comparisonStartTime:String(s-(e-s)), comparisonEndTime:String(s)});
  const modeEventFields = (s,e) =>
      shiftActiveRef.current ? shiftEventPayload(cfgShifts, cfgShiftAggregator)
    : comparisonActiveRef.current ? comparisonWindowPayload(s,e) : {};
  ```
- Spread `...modeEventFields(start,end)` into **every** `TIME_CHANGE` emit (mount,
  preset-effect, onRangeChange, periodicity change). onRangeChange reads the
  just-committed draft values instead of the refs (refs haven't re-rendered yet).

## 6. Widget — RENDER side (data-driven mode + build SDK props)

```ts
const hasComparisonData = series.some(payload =>
  payload?.comparisonSlots?.some(s => typeof s?.value==='number'));
const hasShiftData = series.some(payload =>
  payload?.slots?.some(s => typeof s?.shift==='string' && s.shift.length>0));

const chartMode = hasComparisonData ? 'comparison'
               : hasShiftData      ? 'shift' : 'normal';
```

In the series-resolution memo, also expose **per-bucket** helpers derived from the
longest series: `catTimestamps` (from/to) and `catShifts` (`slot.shift`).

### Shift prop (contiguous shifts → one colored line at sub-daily)
For each source × enabled shift, build a series whose data keeps a bucket only if
it belongs to that shift (by tag), with a boundary bridge at sub-daily:

```ts
const shiftSubDaily = ['minute','hourly'].includes(selectedPeriodicity.toLowerCase());
data = s.data.map((v, ci) => {
  const tag = catShifts[ci];
  if (tag !== undefined) {
    if (tag === shift.name) return v;                             // own bucket
    if (shiftSubDaily && catShifts[ci-1] === shift.name) return v; // bridge to next shift's start
    return null;
  }
  // fallback for untagged backend: time-window test
  return isSlotInShift(catTimestamps[ci].from, shift.startTime, shift.endTime, tz) ? v : null;
});
```

Line-continuity, gated by periodicity:
- **sub-daily (minute/hourly):** `connectNulls:false` + the boundary bridge → the
  3 contiguous shifts join into **one continuous line** that changes color per shift.
- **daily+:** `connectNulls:true`, **no** bridge → each shift is its own connected
  trend line across days.
```ts
opts.plotOptions = { series: { connectNulls: !shiftSubDaily } }; // shift mode only
```

### Comparison prop (current vs previous)
For each source emit two series: current (`slots`) and previous
(`comparisonSlots`, index-aligned, dashed), plus deviation % per bucket:
```ts
deviation[k] = (y===null||p===null||p===0) ? null : round(((y-p)/abs(p))*100, 1);
```
Feed `{series, showDeviation:true, deviationPattern, comparisonCategories:categories}`.

### Wire to the SDK chart
```tsx
<SDLChart
  series={effectiveSeries}
  comparison={chartMode==='comparison' ? comparisonProp : undefined}
  shift={chartMode==='shift' ? shiftProp : undefined}
  showLegend={shiftProp ? false : legends}   // SDK draws its own shift legend
  highchartsOptions={highchartsOptions}       // carries plotOptions.connectNulls
  key={JSON.stringify({ mode: chartMode, … })}// remount on mode change
/>
```

---

## Porting to Column / Combo (bar-line)

Everything in **§1–§6 request side + data-driven mode selection is identical**.
Only the *shape of the SDK prop* changes:

1. Check the target component supports shift/comparison:
   `get_design_metadata('ColumnChart')` / `('ComboLineChart')` — look for
   `shift`, `comparison`, `ChartShiftConfig`, `ChartComparisonConfig`, and any
   `connectNulls`/`plotOptions` equivalent. Get examples:
   `get_design_examples('ColumnChart','Shift'|'Comparison')`.
2. Build the same per-source × per-shift arrays; hand them to that component's
   shift prop. **Bars don't "connect"** — the connectNulls / boundary-bridge step
   is line-only. For a Column chart just emit each shift as its own colored bar
   series (skip §6 bridging entirely). For **Combo**, apply the bridge only to the
   series rendered as lines.
3. Keep the **data-driven `chartMode`** and the **stale-resolve guard** verbatim —
   they're not chart-specific.

## Gotchas checklist
- [ ] `toHostTimeConfig` propagates `shiftAggregator` (else it never reaches the request).
- [ ] `showShift` compares lowercase periodicity.
- [ ] Emit mode fields on **all** TIME_CHANGE sites, not just one.
- [ ] Aggregator label → backend op mapping (Average→mean).
- [ ] Stale-resolve guard in the host (races flip data-driven modes).
- [ ] connectNulls / boundary-bridge are **sub-daily line-only**; don't apply to bars or daily+.
- [ ] Remount the SDK chart on `chartMode` change (series count/layout changes).
