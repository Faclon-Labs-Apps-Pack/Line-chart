---
name: mini-engine
description: >
  Use this skill whenever working on the mini-engine that resolves widget data and passes it
  to the widget as props. This skill covers how the mini-engine reads dynamicBindingPathList,
  calls the resolveAndCompute API with UNS topics, and produces the DataEntry[] that becomes
  the widget's data prop. Triggers include: "update mini-engine", "how does data get to widget",
  "resolve bindings", "pass data to widget", "mini-engine data flow", or any task touching
  the resolve() function or DataEntry output. Always read alongside widget-datalayer-architecture
  and widget-bindable-fields skills.
---

# Mini-Engine Skill

## What the Mini-Engine Does

The mini-engine is the bridge between the saved widget config and the widget's live props. It:

1. Reads `timeConfig` → computes `startTime` / `endTime` window
2. Reads `dynamicBindingPathList` → collects all `{ key, topic }` bindings
3. Calls `resolveAndCompute` API with the topics and time window in a **single request**
4. Maps the response `{ key, value }` items to `DataEntry[]`
5. Returns `{ config: uiConfig, data: DataEntry[] }` → passed as props to widget

The widget receives two props:
- `config` — raw `uiConfig` as saved, never mutated
- `data` — `DataEntry[]` with resolved values keyed by dot-path

---

## The DataEntry Contract

> Interface definition: see **Envelope.md §1b** — `DataEntry`.

The `key` in `DataEntry` always matches exactly the `key` in `dynamicBindingPathList`.

---

## The resolveAndCompute API

All data resolution goes through one endpoint:

```
POST https://stagingsv.iosense.io/api/account/uns/resolveAndCompute
Authorization: Bearer <token>
Content-Type: application/json

{
  "graph": "iosense_test_uns",
  "config": [
    { "key": "sources[0].unsPath", "topic": "uns:ws_abc123://iosense/plant1/voltage:last" }
  ],
  "startTime": 1777141800000,
  "endTime":   1777206690000
}
```

Response shape:
```json
{
  "success": true,
  "data": [
    { "key": "variable", "value": "436" }
  ]
}
```

Map `json.data[]` → `DataEntry[]` directly: `{ key: item.key, value: item.value }`.

Constants (defined in `api.ts`):
- `GRAPH = 'iosense_test_uns'` — hardcoded per env
- `STAGING_BASE = 'https://stagingsv.iosense.io/api'`

---

## resolve() Implementation

```typescript
import { resolveAndCompute } from './api';

export async function resolve(
  envelope: DataPointEnvelope,
  ctx: MiniEngineCtx,
): Promise<{ config: DataPointUIConfig; data: DataEntry[] }> {
  const { startTime, endTime } = computeWindow(envelope, ctx.override);
  const bindings = envelope.dynamicBindingPathList ?? [];

  if (bindings.length === 0) return { config: envelope.uiConfig, data: [] };

  try {
    const items = await resolveAndCompute(
      ctx.authentication,
      bindings.map(({ key, topic }) => ({ key, topic })),
      startTime,
      endTime,
    );
    const data: DataEntry[] = items.map((item) => ({ key: item.key, value: item.value }));
    return { config: envelope.uiConfig, data };
  } catch {
    return { config: envelope.uiConfig, data: [] };
  }
}
```

### Topic Format Guard

Before passing bindings to `resolveAndCompute`, validate topic format. Any topic not matching `uns:wsId://` is silently skipped with a console error — this prevents bad API calls and surfaces Angular injection issues clearly:

```typescript
const UNS_TOPIC_RE = /^uns:[^/]+:\/\//;

const validBindings = bindings.filter(({ topic }) => {
  if (!UNS_TOPIC_RE.test(topic)) {
    console.error(
      `[MiniEngine] Invalid topic format: "${topic}". ` +
      `Expected "uns:wsId://path". ` +
      `Check that Angular's resolveUNSValue injects {{uns:wsId://path}} format ` +
      `and that this.meta is keyed by workspace NAME.`
    );
    return false;
  }
  return true;
});
// use validBindings instead of bindings in resolveAndCompute call
```

---

### resolveAndCompute in api.ts

```typescript
const GRAPH = 'iosense_test_uns';
const STAGING_BASE = 'https://stagingsv.iosense.io/api';

export async function resolveAndCompute(
  authentication: string,
  config: Array<{ key: string; topic: string }>,
  startTime: number,
  endTime: number,
): Promise<Array<{ key: string; value: string | number | null }>> {
  const res = await fetch(`${STAGING_BASE}/account/uns/resolveAndCompute`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authentication}`,
    },
    body: JSON.stringify({ graph: GRAPH, config, startTime, endTime }),
  });
  const json = await res.json();
  // Response shape: { success, data: [{ key, value }] }
  return (json?.data ?? []) as Array<{ key: string; value: string | number | null }>;
}
```

---

## Concrete Example

```typescript
// dynamicBindingPathList saved by configurator
dynamicBindingPathList = [
  { key: "sources[0].unsPath", topic: "uns:ws_abc123://iosense/plant1/voltage:last" },
]

// resolve() sends to resolveAndCompute:
config = [{ key: "sources[0].unsPath", topic: "uns:ws_abc123://iosense/plant1/voltage:last" }]

// API response:
{ success: true, data: [{ key: "variable", value: "436" }] }

// buildDataEntries output → widget's data prop
data = [{ key: "variable", value: "436" }]
```

---

## computeWindow Helper

```typescript
function computeWindow(
  envelope: DataPointEnvelope,
  override?: { startTime: number; endTime: number },
): { startTime: number; endTime: number } {
  if (override) return { startTime: override.startTime, endTime: override.endTime };
  const { timeConfig } = envelope;
  if (!timeConfig) return { startTime: Date.now() - 86_400_000, endTime: Date.now() };
  if (timeConfig.type === 'fixed' && timeConfig.startTime && timeConfig.endTime) {
    return { startTime: timeConfig.startTime, endTime: timeConfig.endTime };
  }
  const now = Date.now();
  const dur = timeConfig.allDurations?.find(d => d.id === timeConfig.defaultDurationId);
  if (dur) return { startTime: computePresetStart(dur, now), endTime: now };
  return { startTime: now - 86_400_000, endTime: now };
}
```

---

## What the Widget Receives

```typescript
// App.tsx (dev harness) calls resolve() then passes output as props
const { config, data } = await resolve(envelope, { authentication: token });

<Widget config={config} data={data} onEvent={handleEvent} />

// config — raw uiConfig, topic strings intact (used as fallback labels)
// data   — DataEntry[] with resolved values e.g. [{ key: "variable", value: "436" }]
```

Widget reads all bindable values via `getValue()` — never directly from `config`. See **Bindable.md §5**.

---

## Rules

- `resolve()` return shape is always `{ config: UIConfig, data: DataEntry[] }`
- `config` is `envelope.uiConfig` passed through unchanged — never mutated
- `data` entries are built exclusively from `dynamicBindingPathList` — one entry per binding
- If `resolveAndCompute` throws, return `data: []` — widget shows loading skeleton
- `data` is `[]` if `dynamicBindingPathList` is empty — widget shows loading skeleton
- The `key` in every `DataEntry` must exactly match the `key` in `dynamicBindingPathList`
- There is **no** per-apiConfig fetch loop — one `resolveAndCompute` call covers all bindings
- `item.value` is the resolved field from the response — NOT `item.data`
- `timeTabConfig` in the envelope is for UI re-hydration only — mini-engine reads `timeConfig`, never `timeTabConfig`

---

## Checklist

- [ ] `resolve()` returns `{ config, data }` — not the raw envelope
- [ ] `config` is `envelope.uiConfig` untouched
- [ ] `data` is built by mapping `resolveAndCompute` response items: `{ key: item.key, value: item.value }`
- [ ] Each `DataEntry.key` matches its `dynamicBindingPathList` entry exactly
- [ ] Failed fetch → `data: []` — not a thrown error
- [ ] `dynamicBindingPathList` missing or empty → `data: []` → widget shows skeleton
- [ ] `GRAPH` and `STAGING_BASE` are constants in `api.ts` — not hardcoded in `resolve()`
