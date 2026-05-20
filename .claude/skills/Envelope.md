---
name: widget-datalayer-architecture
description: >
  Use this skill whenever a user asks to create, build, scaffold, update, or refactor a React widget
  in the IoSense / IIoT platform. This includes requests like "create a column chart widget",
  "build a gauge widget", "add a new widget", "refactor this widget to follow datalayer", 
  "update widget configuration", or any task that touches a widget component or its configurator.
  This skill is MANDATORY for all widget work — never create a widget without consulting it first.
  It enforces the strict DataLayer + UILayer separation architecture where widgets are pure UI 
  components that receive data and config as props, and all data fetching goes through the
  mini-engine's resolveAndCompute call against the UNS (Unified Namespace).
---

# Widget DataLayer Architecture Skill

## Core Principle — Read This First

> **Widgets are pure UI renderers. They never fetch data. Ever.**

Every widget in this platform follows a strict separation of concerns:

| Layer | Responsibility | Who owns it |
|---|---|---|
| **Widget (UI Layer)** | Render charts, cards, titles, axes. Emit user interaction events. | Widget component |
| **Widget Configurator** | Produce the config envelope (`uiConfig` + `dynamicBindingPathList`) | Configurator component |
| **Mini-Engine / DataLayer** | Call `resolveAndCompute`, inject `DataEntry[]` as `data` prop | `mini-engine.ts` / platform DataLayer |

If you find yourself writing `fetch()`, `axios`, `HttpClient`, or any API call inside a widget component — **stop**. That belongs in the mini-engine.

---

## 1. Widget Component Contract

Every widget **must** accept exactly these props:

```typescript
interface WidgetProps {
  config: WidgetUIConfig;        // UI rendering config (from uiConfig envelope)
  data: DataEntry[];             // Resolved data from mini-engine ([] while loading)
  onEvent: (event: WidgetEvent) => void;
}

interface DataEntry {
  key: string;   // dot-path matching dynamicBindingPathList entry
  value: any;    // resolved value from UNS
}
```

### 1a. `config` Prop (UIConfig)

Contains everything the widget needs to render its UI. Topic strings may appear here (stored as-is from configurator) but are treated as display fallbacks, never fetched from.

### 1b. `data` Prop

`DataEntry[]` resolved by the mini-engine via `resolveAndCompute`. Empty array `[]` while loading — widget must show a skeleton in this state.

### 1c. `onEvent` Prop — Emitting Events

```typescript
type WidgetEvent =
  | { type: "TIME_CHANGE"; payload: { startTime: string; endTime: string; periodicity: string } }
  | { type: "FILTER_CHANGE"; payload: Record<string, any> };

props.onEvent({ type: "TIME_CHANGE", payload: { startTime, endTime, periodicity } });
```

### ✅ Widget DO / ❌ Widget DON'T

| ✅ DO | ❌ DON'T |
|---|---|
| Read `props.config` to render UI | Call `fetch()` / `axios` / `HttpClient` |
| Read `props.data` via `getValue()` to populate values | Subscribe to MQTT topics |
| Call `props.onEvent()` on user interactions | Store API endpoints or credentials |
| Show loading skeleton when `data.length === 0` | Import mini-engine or api.ts directly |
| Apply styles from `config.style` | Decide what data to fetch |

### getValue() — Always Use This for Bindable Fields

> Implementation: see **Bindable.md §5** — `getValue()` + `getValueAtPath()`.

```typescript
// Usage in widget
const rawValue = getValue('variable', config, data);
if (data.length === 0) return <WidgetSkeleton config={config} />;
```

---

## 2. The Config Envelope

The Widget Configurator produces a config envelope — the contract between widget, mini-engine, and storage:

```typescript
interface WidgetConfigEnvelope {
  _id: string;
  type: string;                  // Widget type e.g. "DataPoint"
  general: { title: string };
  timeConfig?: TimeConfig;       // Optional — time window settings
  uiConfig: UIConfig;            // Render config — widget reads this
  dynamicBindingPathList: Array<{ key: string; topic: string }>; // binding index
}
```

**There is no `apiConfig`.** All data resolution goes through `resolveAndCompute` using the UNS topics in `dynamicBindingPathList`.

### 2a. `timeConfig` (optional)

Used by the mini-engine to compute `startTime`/`endTime` for the `resolveAndCompute` call.

```typescript
interface TimeConfig {
  timezone: string;                    // IANA e.g. "Asia/Kolkata"
  type: "local" | "fixed" | string;
  startTime: number | null;            // ms epoch, used when type = "fixed"
  endTime: number | null;
  defaultDurationId: string;          // ID reference → allDurations[n].id
  allDurations: Duration[];
  defaultPeriodicity: "minute" | "hourly" | "daily" | "weekly" | "monthly";
}

interface Duration {
  id: string;
  label?: string;
  x?: number;
  xPeriod: string;   // "minute" | "hour" | "day" | "week" | "month" | "year"
}
```

### 2a.1. `timeTabConfig` (optional, UI re-hydration only)

Stored alongside `timeConfig` for the design-sdk `TimeTabConfiguration` component to restore its UI state on re-load. **The mini-engine never reads this.** Only the configurator reads it on mount.

```typescript
// In the configurator's useEffect sync:
if (config.timeTabConfig) setTimeTabConfig(config.timeTabConfig);

// In the onChange payload — BOTH fields must be emitted:
onChange({
  ...envelope,
  timeConfig: buildTimeConfig(timeTabConfig),   // mini-engine reads this
  timeTabConfig: timeTabConfig,                 // TimeTabConfiguration re-hydration
});
```

`buildTimeConfig(ttc: Partial<TimeTabUIConfig>): TimeConfig | undefined` maps the design-sdk's `TimeTabUIConfig` → the engine-facing `TimeConfig`. Returns `undefined` if `ttc` is empty.

> **Rule:** never emit `timeTabConfig` WITHOUT also emitting `timeConfig`. The deploy-review C1.6 check enforces this.

---

### 2b. `dynamicBindingPathList`

The binding index. Each entry maps a uiConfig dot-path to a UNS topic. The mini-engine uses this to call `resolveAndCompute`.

```typescript
// Example
dynamicBindingPathList = [
  { key: "sources[0].unsPath", topic: "uns:ws_abc123://iosense/plant1/voltage:last" },
  { key: "rangeMin",           topic: "uns:ws_abc123://iosense/plant1/voltage:min" },
]
```

- `key` — dot-path into `uiConfig`, bracket notation for arrays: `series[0].dataSource`
- `topic` — full UNS topic path; the operator is encoded in the topic suffix (e.g. `/lastdp`, `/min`, `/max`)
- Always present — even `[]` when no topics configured

### 2c. `uiConfig`

Widget-only. The mini-engine never reads this. Passed directly as `config` prop.

```typescript
// DataPoint example
interface DataPointUIConfig {
  variable: string;          // stores the topic string (used as display fallback)
  sources: DataSource[];     // display settings per tile (label, unit)
  style: {
    card: { wrapInCard: boolean; bg?: string; color?: string; borderColor?: string; ... };
    dataPoint?: TextStyle;
    unit?: TextStyle;
  };
}
```

---

## 3. Complete Envelope Example

```json
{
  "_id": "dp_1777216384057",
  "type": "DataPoint",
  "general": { "title": "" },
  "uiConfig": {
    "variable": "{{uns:ws_abc123://iosense/plant1/voltage:last}}",
    "sources": [{ "_id": "src_abc", "label": "Voltage", "unit": "V" }],
    "style": { "card": { "wrapInCard": true } }
  },
  "dynamicBindingPathList": [
    { "key": "sources[0].unsPath", "topic": "uns:ws_abc123://iosense/plant1/voltage:last" }
  ]
}
```

Note: `uiConfig` bindable fields store `{{uns:wsId://nodePath}}` with braces intact — this is the binding marker. `dynamicBindingPathList.topic` stores the topic **without** braces: `uns:wsId://nodePath`. The UNS topic format is always `uns:workspaceId://absoluteNodePath` — never a raw path or workspace name. Topics arriving in any other format will be rejected by the mini-engine topic guard.
```

---

## 4. File Structure for a Widget

```
src/
├── components/
│   ├── <WidgetName>/
│   │   ├── <WidgetName>.tsx              # Widget UI component (pure renderer)
│   │   └── index.ts                      # Self-registers to window.ReactWidgets
│   └── <WidgetName>Configuration/
│       ├── <WidgetName>Configuration.tsx # Configurator (produces envelope)
│       └── index.ts                      # Self-registers to window.ReactWidgets
├── iosense-sdk/
│   ├── types.ts                          # DataEntry, DataPointEnvelope, etc.
│   ├── api.ts                            # resolveAndCompute, validateSSOToken, etc.
│   └── mini-engine.ts                    # resolve() — calls resolveAndCompute
└── App.tsx                               # Dev harness
```

---

## 5. Configurator Output Contract

The configurator produces the envelope. It must have:
1. **Bindable field inputs** → user types `{{topic}}` — scanner fills `dynamicBindingPathList`
2. **Time Settings** → fills `timeConfig` (optional)
3. **Appearance** → fills `uiConfig` (labels, styling)

```typescript
function buildEnvelope(existing, variable, sources, style): WidgetConfigEnvelope {
  const uiConfig = { variable, sources, style };
  return {
    _id: existing?._id ?? `dp_${Date.now()}`,
    type: 'DataPoint',
    general: existing?.general ?? { title: '' },
    uiConfig,
    dynamicBindingPathList: buildDynamicBindingPathList(uiConfig), // scans for {{}} → extracts topics
  };
}
```

`buildDynamicBindingPathList` walks `uiConfig`, finds every field matching `{{...}}`, and produces `{ key: dotPath, topic: contentInsideBraces }`. See Bindable.md for the full implementation.
```

---

## 6. What the Mini-Engine Does (for context)

```
resolve(envelope, { authentication: token })
  → computeWindow(envelope)            // startTime, endTime
  → resolveAndCompute(token, topics, startTime, endTime)  // single POST to UNS API
  → map response.data[] → DataEntry[]
  → return { config: uiConfig, data: DataEntry[] }
```

---

## 7. Common Mistakes to Avoid

### ❌ API call inside widget
```tsx
useEffect(() => {
  fetch(config.endpoint).then(...); // ← mini-engine's job
}, []);
```

### ❌ apiConfig in envelope
```typescript
return { timeConfig, apiConfig, uiConfig }; // ← apiConfig does not exist
```

### ❌ {{}} variable syntax in configurator
```typescript
const [variable, setVariable] = useState('{{API1.data}}'); // ← old architecture, do not use
```

### ✅ Correct: topic string in configurator
```typescript
const [variable, setVariable] = useState(''); // user types UNS topic path
```

### ✅ Correct: wait for data prop in widget
```tsx
if (data.length === 0) return <Skeleton />;
const rawValue = getValue('variable', config, data);
```

---

## 8. Checklist Before Submitting Any Widget Code

- [ ] Widget has no `fetch`, `axios`, `http.get`, `HttpClient` calls
- [ ] Widget accepts `config`, `data: DataEntry[]`, `onEvent` props
- [ ] Widget renders a loading skeleton when `data.length === 0`
- [ ] All bindable values read via `getValue(key, config, data)` — never `config.field` directly
- [ ] All user interactions that affect data emit via `onEvent`
- [ ] No `apiConfig` anywhere in the envelope or types
- [ ] `dynamicBindingPathList` uses `{ key, topic }` — never `{ key, value }`
- [ ] Configurator builds `dynamicBindingPathList` explicitly — no `{{}}` scanning
- [ ] Configurator emits envelope: `_id`, `type`, `general`, `uiConfig`, `dynamicBindingPathList`
