---
name: widget-bindable-fields
description: >
  Use this skill whenever generating or updating a Widget Configurator. This skill is MANDATORY whenever any configurator is created or modified — it
  ensures the configurator correctly identifies bindable uiConfig fields, renders a plain
  text input for them (where user types a UNS topic path directly), and writes
  dynamicBindingPathList on save. Triggers include: "create a widget configurator", "add
  variable binding to a field", "update configurator", "add dynamicBindingPathList", "make
  this field accept a variable", or any task where a configurator saves widget config. Never
  generate a configurator without reading this skill first. This pairs with the
  widget-datalayer-architecture skill — both must be followed together.
---

# Widget Bindable Fields Skill

## Core Principle — Read This First

> **`{{}}` is the bindable field marker. The configurator scans uiConfig for `{{topic}}` strings at save time and builds `dynamicBindingPathList` from them — no runtime scanning ever.**

Every IoSense widget configurator must:
1. Identify which `uiConfig` fields are **bindable** (can accept a `{{UNS-topic}}` value)
2. Render a **plain text input** for those fields — user types `{{iosense/plant1/.../lastdp}}` directly
3. On save, walk the `uiConfig`, find every field matching `{{...}}`, extract the topic inside, and write `{ key, topic }` into `dynamicBindingPathList`

This is what powers the mini-engine's `resolveAndCompute` call. Without `dynamicBindingPathList`, the engine has no topics to fetch.

---

## 1. What is a Bindable Field?

A bindable field is any `uiConfig` field whose value comes from a live device/sensor reading via the UNS (Unified Namespace).

**Always bindable — these fields must always support UNS topic input:**

| Field type | Examples |
|---|---|
| Primary data value | `variable`, `series[n].dataSource` |
| Numeric thresholds driven by data | `gaugeConfig.min`, `gaugeConfig.max`, `plotlines[n].value` |
| Display labels driven by data | `gaugeConfig.title`, `series[n].name` |

**Never bindable — these fields are structural, not data-driven:**

| Field type | Examples |
|---|---|
| Chart type selectors | `chartType: "gauge"` |
| Style tokens | `style.card.borderRadius`, `style.chart.fontSize` |
| Boolean toggles | `style.card.wrapInCard`, `hideToggle` |
| IDs and keys | `_id`, `series[n].id` |
| Static display-only strings | `unit`, `label` (unless driven by live data) |

---

## 2. How Bindable Fields Are Rendered

Bindable fields use a **plain `<input type="text">`** or the design-sdk `TextInput`. The user types the UNS topic path wrapped in `{{}}`.

> **Prefer `UNSPathInput` over `TextInput` for all bindable fields.** `UNSPathInput` (from `@faclon-labs/design-sdk/UNSPathInput`) adds a `/`-triggered tree browser that resolves workspace names to `{{uns:wsId://path}}` format automatically. Only use bare `TextInput` for fields where UNS browsing is not appropriate. See **UNSPathInput.md** for the full pattern.

The placeholder must always show an example `{{topic}}` value.

```tsx
// ✅ CORRECT — bindable field, user types {{topic}} syntax
<TextInput
  label="Variable"
  placeholder="e.g. {{uns:wsId://iosense/plant1/voltage:last}} or type / to browse"
  value={variable}
  onChange={({ value }) => setVariable(value)}
/>

// ❌ NOT bindable — structural, use select
<select value={chartType} onChange={e => setChartType(e.target.value)}>
  <option value="gauge">Gauge</option>
</select>
```

**State type for bindable fields is always `string`** — the value may be `""`, a static string, or `"{{iosense/...}}"`:

```tsx
// ✅ CORRECT — always string state for bindable fields
const [variable, setVariable] = useState<string>('');
const [minTopic, setMinTopic] = useState<string>('');
```

---

## 3. Writing `dynamicBindingPathList` on Save — THE CRITICAL RULE

When the configurator saves, it must walk the `uiConfig` it just built, find every field matching `{{...}}`, extract the topic inside (strip the braces), and write `{ key, topic }` entries into `dynamicBindingPathList`.

```typescript
const VARIABLE_REGEX = /^\{\{(.+)\}\}$/;

function buildDynamicBindingPathList(uiConfig: UIConfig): Array<{ key: string; topic: string }> {
  const paths: Array<{ key: string; topic: string }> = [];

  function walk(obj: any, currentPath: string): void {
    if (obj === null || obj === undefined) return;
    if (typeof obj === 'string') {
      const match = VARIABLE_REGEX.exec(obj.trim());
      if (match) paths.push({ key: currentPath, topic: match[1] }); // match[1] = topic without {{ }}
      return;
    }
    if (Array.isArray(obj)) {
      obj.forEach((item, index) => walk(item, `${currentPath}[${index}]`));
      return;
    }
    if (typeof obj === 'object') {
      Object.entries(obj).forEach(([key, val]) => {
        walk(val, currentPath ? `${currentPath}.${key}` : key);
      });
    }
  }

  walk(uiConfig, '');
  return paths;
}

// Usage in configurator's save handler
function buildEnvelope(existing, variable, sources, style): WidgetEnvelope {
  const uiConfig = { variable, sources, style };
  return {
    _id: existing?._id ?? `widget_${Date.now()}`,
    type: 'WidgetType',
    general: existing?.general ?? { title: '' },
    uiConfig,
    dynamicBindingPathList: buildDynamicBindingPathList(uiConfig),
  };
}
```

### What the output looks like

```typescript
// User typed "{{iosense/plant1/.../voltage/lastdp}}" in the variable field
uiConfig.variable = "{{uns:ws_abc123://iosense/plant1/voltage:last}}"

// buildDynamicBindingPathList extracts the topic (strips {{ }})
dynamicBindingPathList: [
  { key: "sources[0].unsPath", topic: "uns:ws_abc123://iosense/plant1/voltage:last" },
]

// Static fields (no {{}}) are NOT in the list
// sources[0].label = "Voltage"  → not included (no {{}} wrapper)
// style.card.wrapInCard = true  → not included (boolean, never bindable)
```

---

## 3a. Series Bindings — Annotating Time-Series Fields

Some bindings return time-series slot data instead of a single scalar value. These are annotated with `type: "series"` in `dynamicBindingPathList`. The `{{topic}}` syntax in `uiConfig` is identical — only the binding entry is annotated.

Pass the dot-paths of series fields as the second argument to `buildDynamicBindingPathList`:

```typescript
function buildDynamicBindingPathList(
  uiConfig: unknown,
  seriesKeys: string[] = [],   // dot-paths that get type: "series" — all others are scalar
): Array<BindingEntry> {
  const seriesKeySet = new Set(seriesKeys);
  const paths: BindingEntry[] = [];

  function walk(obj: unknown, currentPath: string): void {
    if (obj === null || obj === undefined) return;
    if (typeof obj === 'string') {
      const match = VARIABLE_REGEX.exec(obj.trim());
      if (match) {
        const topic = match[1];
        if (seriesKeySet.has(currentPath)) {
          paths.push({ key: currentPath, topic, type: 'series' });
        } else {
          paths.push({ key: currentPath, topic });
        }
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
```

**Rules:**
- `seriesKeys` lists paths that **already have `{{topic}}`** in `uiConfig` — it only annotates type, it does not inject new entries.
- Calling with no second argument is identical to existing behavior — backward compatible.
- Each widget type knows at build time which of its bindable fields are series — hard-code the array in `buildEnvelope`.

**Example — column chart configurator with multiple series:**
```typescript
const uiConfig = {
  series: [
    { unsPath: '{{uns:ws_abc://iosense/plant1/voltage:last}}', label: 'Voltage' },
    { unsPath: '{{uns:ws_abc://iosense/plant1/current:last}}', label: 'Current' },
  ],
  style: { card: { wrapInCard: true } },
};

const dynamicBindingPathList = buildDynamicBindingPathList(
  uiConfig,
  ['series[0].unsPath', 'series[1].unsPath'],
);
// Result:
// [
//   { key: 'series[0].unsPath', topic: 'uns:ws_abc://iosense/plant1/voltage:last', type: 'series' },
//   { key: 'series[1].unsPath', topic: 'uns:ws_abc://iosense/plant1/current:last', type: 'series' },
// ]
// style.card.wrapInCard = true  → not included (boolean, never bindable)
// series[0].label = 'Voltage'   → not included (no {{}} wrapper)
```

---

## 4. Complete Configurator Save Contract

> Full envelope interface: see **Envelope.md §2** — `WidgetConfigEnvelope`.

**Rules:**
- `dynamicBindingPathList` is **always present** — even if empty array `[]` when no `{{}}` bindings
- Each entry is a `BindingEntry`: scalar shape `{ key, topic }` or series shape `{ key, topic, type: 'series' }`
- It is built by scanning `uiConfig` for `{{...}}` patterns at save time — `buildDynamicBindingPathList(uiConfig, seriesKeys?)`
- It contains **only fields with `{{}}` wrapper** — static string values are excluded
- Paths use **bracket notation for arrays**: `series[0].dataSource` not `series.0.dataSource`
- `apiConfig` does **not** exist in this envelope — all data resolution goes through `resolveAndCompute`

---

## 5. How Widget Consumes the `data` Prop

The mini-engine reads `dynamicBindingPathList`, calls `resolveAndCompute`, and passes results as `DataEntry[]` to the widget. `DataEntry.value` is `string | number | null` for scalar bindings and `SeriesPayload` for series bindings.

### Scalar bindings — use `getValue()`

```typescript
// uiConfig stored value — {{}} wrapper intact
config.variable = "{{uns:ws_abc123://iosense/plant1/voltage:last}}"

// mini-engine resolves → DataEntry
data = [{ key: "variable", value: "436" }]

// Widget reads:
const rawValue = getValue('variable', config, data);   // → "436"
```

```typescript
function getValue(key: string, config: any, data: DataEntry[]): string | number | null {
  const entry = data.find(d => d.key === key);
  if (entry !== undefined) {
    const v = entry.value;
    if (v !== null && typeof v === 'object') return null; // series — use getSeriesData() instead
    return v as string | number | null;
  }
  return getValueAtPath(config, key) as string | number | null;
}
```

### Series bindings — use `getSeriesData()`

```typescript
import { getSeriesData } from '../iosense-sdk/mini-engine';

// mini-engine resolves → DataEntry with SeriesPayload as value
data = [{ key: "series[0].unsPath", value: { __type: "series", slots: [...], meta: {...}, range: {...} } }]

// Widget reads:
const series = getSeriesData('series[0].unsPath', data);
if (!series) return <WidgetSkeleton config={config} />;

const categories = series.slots.map(s => s.label);        // X-axis labels e.g. ["17:00","18:00",...]
const values     = series.slots.map(s => s.value ?? 0);   // Y-axis values
const unit       = series.meta.unit;                       // "V", "kWh", etc.
// series.slots[n].from / .to  — epoch ms bounds per slot
// series.slots[n].isPartial   — true when slot covers an incomplete period
// series.range                — { from, to } overall resolved window
```

### Loading state

```typescript
// Scalar widgets: data is [] until mini-engine resolves
if (data.length === 0) return <WidgetSkeleton config={config} />;

// Series widgets: data may be non-empty but slots may be empty (valid API response)
const series = getSeriesData('series[0].unsPath', data);
if (!series || series.slots.length === 0) return <WidgetSkeleton config={config} />;
```

---

## 6. Concrete Example — DataPoint Widget Configurator

```tsx
const VARIABLE_REGEX = /^\{\{(.+)\}\}$/;

function buildDynamicBindingPathList(uiConfig) {
  const paths = [];
  function walk(obj, path) {
    if (typeof obj === 'string') {
      const match = VARIABLE_REGEX.exec(obj.trim());
      if (match) paths.push({ key: path, topic: match[1] });
    } else if (Array.isArray(obj)) {
      obj.forEach((item, i) => walk(item, `${path}[${i}]`));
    } else if (obj && typeof obj === 'object') {
      Object.entries(obj).forEach(([k, v]) => walk(v, path ? `${path}.${k}` : k));
    }
  }
  walk(uiConfig, '');
  return paths;
}

const DataPointConfiguration = () => {
  const [variable, setVariable] = useState<string>('');  // user types {{topic}} here

  function buildEnvelope(): WidgetConfigEnvelope {
    const uiConfig = { variable, sources, style };
    return {
      _id: existing?._id ?? `dp_${Date.now()}`,
      type: 'DataPoint',
      general: { title: '' },
      uiConfig,
      dynamicBindingPathList: buildDynamicBindingPathList(uiConfig),
    };
  }

  return (
    <TextInput
      label="Variable"
      placeholder="e.g. {{uns:wsId://iosense/plant1/voltage:last}} or type / to browse"
      value={variable}
      onChange={({ value }) => { setVariable(value); emit(value, sources, style); }}
    />
  );
};
```

---

## 7. Checklist Before Submitting Any Configurator

- [ ] Every bindable field is a plain text input — user types `{{iosense/...}}` syntax
- [ ] Bindable field state is typed as `string`
- [ ] Bindable field placeholder shows an example `{{topic}}` value
- [ ] Non-bindable fields use appropriate input: `<select>` for chartType, color picker for colors, toggle for booleans
- [ ] `onSave()` calls `buildDynamicBindingPathList(uiConfig, seriesKeys?)` — scanner finds `{{}}` and extracts topics
- [ ] Series fields are listed in the `seriesKeys` array argument — e.g. `['series[0].unsPath']`
- [ ] Each entry in `dynamicBindingPathList` uses `{ key, topic }` for scalar or `{ key, topic, type: 'series' }` for series
- [ ] `topic` in `dynamicBindingPathList` has NO `{{}}` braces — they are stripped by the scanner
- [ ] Static values (no `{{}}`) are excluded from `dynamicBindingPathList`
- [ ] `dynamicBindingPathList` is always present — even `[]` when no bindings
- [ ] `apiConfig` is NOT in the envelope — never add it
- [ ] Configurator emits envelope with: `_id`, `type`, `general`, `uiConfig`, `dynamicBindingPathList`
- [ ] Widget reads series keys via `getSeriesData(key, data)` imported from `iosense-sdk/mini-engine`
- [ ] Widget reads scalar keys via `getValue(key, config, data)` — never `getSeriesData()` for scalar keys

---

## 8. What NOT to Do

```tsx
// ❌ WRONG — using getValue() on a series key (returns null, not the series payload)
const rawValue = getValue('series[0].unsPath', config, data);  // ← returns null for series
const series   = getSeriesData('series[0].unsPath', data);     // ← correct

// ❌ WRONG — omitting seriesKeys for a series field (binding sent as scalar, no slots returned)
buildDynamicBindingPathList(uiConfig)                             // ← series field treated as scalar
buildDynamicBindingPathList(uiConfig, ['series[0].unsPath'])      // ← correct

// ❌ WRONG — storing value instead of topic in dynamicBindingPathList (old architecture)
paths.push({ key: currentPath, value: obj.trim() });  // ← wrong
paths.push({ key: currentPath, topic: match[1] });    // ← correct

// ❌ WRONG — using {{API1.data}} style references (old architecture — API name, not a topic)
const [variable, setVariable] = useState('{{API1.data}}');

// ❌ WRONG — topic still has {{ }} braces
{ key: "sources[0].unsPath", topic: "{{uns:ws_abc://iosense/plant1/voltage:last}}" }   // ← braces not stripped
{ key: "sources[0].unsPath", topic: "uns:ws_abc://iosense/plant1/voltage:last" }       // ← correct

// ❌ WRONG — workspace name format (resolveUNSValue was not called or returned unchanged)
{ key: "sources[0].unsPath", topic: "Akash - Test/Voltage/:last" }  // ← display name leaked through

// ✅ CORRECT — workspace ID format
{ key: "sources[0].unsPath", topic: "uns:ws_abc123://iosense/plant1/voltage:last" }

// ❌ WRONG — apiConfig in envelope
return { timeConfig, apiConfig, uiConfig, dynamicBindingPathList };  // ← apiConfig must not exist

// ❌ WRONG — dot notation for array paths
{ key: "series.0.dataSource" }   // ← wrong
{ key: "series[0].dataSource" }  // ← correct

// ✅ CORRECT
const [variable, setVariable] = useState<string>('');

<TextInput
  placeholder="e.g. {{iosense/plant1/.../lastdp}}"
  value={variable}
  onChange={({ value }) => setVariable(value)}
/>

// buildDynamicBindingPathList scans uiConfig:
// finds: variable = "{{iosense/plant1/.../lastdp}}"
// extracts: match[1] = "iosense/plant1/.../lastdp"  (no braces)
// pushes: { key: "variable", topic: "iosense/plant1/.../lastdp" }
```
