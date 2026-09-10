# Widget Loader — Migration Brief (all chart widgets)

Give every chart widget a loader that shows **on first load AND on every
refetch — including GTP-driven refetches the widget never emitted**. This is the
pattern ColumnChart / LineChart use; port it to the rest.

**The single most important fact:** the host injects the loading flag as a prop
named **`loader`** (boolean), NOT `loading`. A widget that reads `loading` gets
`undefined` and its loader never fires under GTP. This was the exact bug in
LineChart. Use `loader`.

---

## Why the naive version fails under GTP

Widgets flip their own "refetching" flag when THEY emit a `TIME_CHANGE` (user
picks a range / periodicity / toggles compare|shift). But under a **Global Time
Picker**, the *host* broadcasts the new window and re-resolves — the widget never
emits, so a self-emit-only flag stays false, the stale chart sits there, and no
loader shows.

The fix is to also honor the **host's `loader` prop**, which Lens sets true while
it resolves (GTP-driven or not). OR it with the widget's own states so it never
hides a loader the widget would show anyway.

---

## The model (three inputs → two visible states)

**Inputs**
1. `loader` (host prop) — true while Lens resolves, incl. GTP.
2. `awaitingData` — the widget's own flag, set the instant it emits a
   `TIME_CHANGE`, cleared when a fresh `data` reference lands.
3. `firstLoadPending` — bound series, nothing resolved yet.

**Visible states**
- **First load** (no data yet) → full spinner in the canvas area.
- **Refetch** (data already on screen) → translucent **overlay** over the chart,
  so header + controls stay visible instead of blanking.

**`loaderSettling`** (the subtle bit, from ColumnChart): the host can drop
`loader` to false a beat *before* the fresh `data` prop arrives (flag and data
travel on separate update paths). Dropping the loader on the flag alone flashes
the stale chart. So: capture the `data` reference when the host RAISES `loader`,
and keep the loader up ("settling") until that reference actually moves — with a
5s safety release for a loader pulse that never changes the data.

---

## Copy-paste implementation

### 1. Prop (widget props interface)

```tsx
/** Host-driven loading flag. Lens sets this true while it re-resolves data —
 *  INCLUDING GTP-driven refetches the widget never emitted. MUST be named
 *  `loader` (that is the exact prop the host injects). OR-ed with the widget's
 *  own loading states so it never hides a loader we'd show anyway. */
loader?: boolean;
```
Destructure with a default: `export function MyChart({ …, loader = false }: Props)`.

### 2. Loader state (place among the other hooks, before any early return)

```tsx
const dataEmpty = data.length === 0;
const hasBoundSeries = (config.charts ?? []).some((c) =>
  (c.series ?? []).some((s) => /^\{\{.+\}\}$/.test((s.unsPath ?? '').trim())),
);

// Has the host ever answered? Separates FIRST load from a REFETCH.
const [everResolved, setEverResolved] = useState(false);

// Self-emitted refetch bridge: set on emit (beginPendingFetch), cleared when a
// new `data` reference arrives.
const [awaitingData, setAwaitingData] = useState(false);
const awaitingDataRef = useRef(false);
const beginPendingFetch = () => { awaitingDataRef.current = true; setAwaitingData(true); };
useEffect(() => {
  if (awaitingDataRef.current) { awaitingDataRef.current = false; setAwaitingData(false); setEverResolved(true); }
  else if (data.length > 0) setEverResolved(true);
}, [data]);

// Host-loader settle: keep the loader up from when the host RAISED `loader`
// until the `data` reference moves, so we don't flash the stale chart.
const dataAtLoaderRaiseRef = useRef<DataEntry[] | null>(null);
const prevLoaderRef = useRef(false);
if (loader && !prevLoaderRef.current) dataAtLoaderRaiseRef.current = data;
prevLoaderRef.current = loader;
const loaderSettling =
  !loader && dataAtLoaderRaiseRef.current !== null && data === dataAtLoaderRaiseRef.current;
const [, forceLoaderSettleRerender] = useState(0);
useEffect(() => {
  if (!loaderSettling) return;
  const t = setTimeout(() => { dataAtLoaderRaiseRef.current = null; forceLoaderSettleRerender((n) => n + 1); }, 5000);
  return () => clearTimeout(t);
}, [loaderSettling]);

// Combine. `hostLoading` covers GTP-driven refetches the widget never emitted.
const hostLoading = loader || loaderSettling;
const firstLoadPending = !everResolved && dataEmpty && (hasBoundSeries || hostLoading);
const loaderActive = firstLoadPending || awaitingData || hostLoading;

// Cap so a stuck binding / never-arriving response can't spin forever.
const LOADING_TIMEOUT_MS = 15000;
const [loadingExpired, setLoadingExpired] = useState(false);
useEffect(() => {
  if (!loaderActive) { setLoadingExpired(false); return; }
  setLoadingExpired(false);
  const t = setTimeout(() => setLoadingExpired(true), LOADING_TIMEOUT_MS);
  return () => clearTimeout(t);
}, [data, awaitingData, loaderActive]);

const isLoadingData = firstLoadPending && !loadingExpired;                        // full spinner
const isRefetching  = (hostLoading || awaitingData) && !dataEmpty && !loadingExpired; // overlay
```

### 3. Call `beginPendingFetch()` at every self-emit

Anywhere the widget emits `TIME_CHANGE` from user action (range pick, periodicity
change, compare/shift toggle, drilldown), call `beginPendingFetch()` right after
`onEvent({ type: 'TIME_CHANGE', … })`. GTP refetches need nothing here — they're
covered by `loader`.

### 4. Render

First-load spinner where the chart body would be, and the refetch overlay as a
child of the (position:relative) widget root:

```tsx
{isRefetching && (
  <div className="mychart__loading-overlay" aria-busy="true">
    <Spinner size="Large" label="Loading data" labelPosition="Bottom" />
  </div>
)}
{/* … */}
{isLoadingData ? (
  <div className="mychart__loading-canvas">
    <Spinner size="Medium" label="Loading data" labelPosition="Bottom" />
  </div>
) : /* empty state / chart */ }
```

### 5. CSS (overlay)

```css
.mychart { position: relative; }          /* positioning context for the overlay */
.mychart__loading-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10;
  background: color-mix(in srgb, var(--background-surface-intense, #fff) 65%, transparent);
  border-radius: inherit;
  cursor: progress;
}
```

### 6. Import
```tsx
import { Spinner } from '@faclon-labs/design-sdk/Spinner';
```

---

## Dev harness (so it's testable on localhost)

The harness (`App.tsx`) must pass `loader` too, or you'll never see it there
regardless of prod behavior. Track a `resolving` state around the `resolve()`
call and pass it down:

```tsx
const [resolving, setResolving] = useState(false);
// in runResolve: setResolving(true) before; finally { if (seq === resolveSeqRef.current) setResolving(false); }
<MyChart … loader={resolving} />
```
The harness can't simulate a true GTP broadcast, but this makes the overlay fire
on every harness resolve so the mechanism is verifiable. In prod, Lens drives
`loader`, including the GTP case.

---

## Checklist (per chart widget)

- [ ] Prop is named **`loader`** (not `loading`), defaulted `false`.
- [ ] `everResolved` + `awaitingData` + `beginPendingFetch()` on every self-emit.
- [ ] `loaderSettling` (raise-capture + settle + 5s release).
- [ ] `firstLoadPending` / `isLoadingData` (full) and `isRefetching` (overlay),
      both capped by `LOADING_TIMEOUT_MS`.
- [ ] Overlay JSX + `position: relative` root + overlay CSS.
- [ ] Dev harness passes `loader={resolving}`.
- [ ] Verify: first load → full spinner; time/periodicity/compare/shift change →
      overlay; **GTP window change → overlay** (against a real host).

---

## Reference implementations
- **ColumnChart** — the canonical `loader` + `loaderSettling` source.
- **LineChart** — `LineChart.tsx` (states + overlay), `LineChart.css`
  (`.lcw__loading-overlay`), `App.tsx` (`loader={resolving}`).

## Non-negotiable
The prop is **`loader`**. A widget reading `loading` will look fine in the dev
harness (if you wired the harness to `loading`) yet stay broken under GTP in prod,
because the host only ever sets `loader`. This is the trap CombinedBarLine fell
into.
