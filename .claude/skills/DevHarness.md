---
name: widget-dev-harness
description: >
  Use this skill whenever setting up or updating the App.tsx dev harness for a widget.
  Triggers include: "wire up the widget preview", "connect configurator to widget",
  "set up App.tsx", "preview widget locally", or any task that involves rendering a widget
  alongside its configurator in development. Always read alongside widget-datalayer-architecture
  and mini-engine skills.
---

# Widget Dev Harness Skill

## What the Dev Harness Does

The dev harness (`App.tsx`) wires:

1. **Configurator** → produces `DataPointEnvelope` with `dynamicBindingPathList`
2. **Mini-Engine** → calls `resolve(envelope, { authentication })` → real `resolveAndCompute` API call
3. **Widget** → receives `config = envelope.uiConfig` and `data = DataEntry[]`, renders as it would in production

It simulates the full DataLayer → Widget flow with real backend calls. No dummy data.

---

## Auth Flow

Visit `http://localhost:3000/?token=<SSO_TOKEN>` once to exchange an SSO token for a JWT. The JWT is stored in `localStorage.bearer_token` and reused across sessions.

```typescript
useEffect(() => {
  const params = new URLSearchParams(window.location.search);
  const ssoToken = params.get('token');
  if (ssoToken && !auth) {
    validateSSOToken(ssoToken).then((jwt) => {
      if (jwt) {
        localStorage.setItem('bearer_token', jwt);
        setAuth(jwt);
      }
    });
  }
}, []);
```

---

## UNS Injection Props (Angular Production vs Dev Harness)

The configurator supports two UNS prop injection modes. The harness switches automatically based on whether all three functional props are present:

```typescript
const hasInjectedUNS =
  props.unsTree !== undefined &&
  props.onLoadWorkspaces !== undefined &&
  props.resolveUNSValue !== undefined;

// All three present → use Angular-injected props
// Any missing → fall back to useUNSTree hook (dev harness path)
```

**Dev harness (App.tsx):** pass only `authentication`. The hook fetches workspaces and resolves topics automatically.

**Angular production:** inject all three:
```typescript
{
  unsTree: this.unsService.tree,
  isLoadingTree: this.unsService.loading,
  onLoadWorkspaces: async () => {
    await this.unsService.loadWorkspaces(token);
    // Also fetch nodes to populate this.meta before user selects:
    for (const [wsName, wsId] of Object.entries(this.unsService.workspaceMap)) {
      await this.unsService.loadWorkspaceNodes(wsName, wsId, token);
    }
    this.getApi()?.update('widget-config', this.buildProps());
  },
  resolveUNSValue: (raw: string) => this.unsService.resolve(raw),
}
```

See **UNSPathInput.md** for the full Angular injection contract and `this.meta` population rules.

---

## Full App.tsx Template

```tsx
import React, { useState, useEffect } from 'react';
import { DataPoint } from './components/DataPoint/DataPoint';
import { DataPointConfiguration } from './components/DataPointConfiguration/DataPointConfiguration';
import { DataEntry, DataPointEnvelope } from './iosense-sdk/types';
import { validateSSOToken } from './iosense-sdk/api';
import { resolve } from './iosense-sdk/mini-engine';
import './App.css';

export default function App() {
  const [envelope, setEnvelope] = useState<DataPointEnvelope | undefined>(undefined);
  const [data, setData] = useState<DataEntry[]>([]);
  const [auth, setAuth] = useState<string>(localStorage.getItem('bearer_token') ?? '');

  // Exchange SSO token from URL query param on first load
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ssoToken = params.get('token');
    if (ssoToken && !auth) {
      validateSSOToken(ssoToken).then((jwt) => {
        if (jwt) {
          localStorage.setItem('bearer_token', jwt);
          setAuth(jwt);
        }
      });
    }
  }, []);

  // Re-resolve whenever envelope or auth changes
  useEffect(() => {
    if (!envelope || !auth) return;
    console.log('[App] resolving envelope:', envelope.dynamicBindingPathList);
    resolve(envelope, { authentication: auth }).then(({ data: resolved }) => {
      console.log('[App] resolved data:', resolved);
      setData(resolved);
    });
  }, [envelope, auth]);

  return (
    <div className="app">
      <div className="app__config">
        <DataPointConfiguration envelope={envelope} onChange={setEnvelope} />
      </div>
      <div className="app__widget">
        {envelope ? (
          <DataPoint
            config={envelope.uiConfig}
            data={data}
            onEvent={(e) => console.log('[Widget Event]', e)}
          />
        ) : (
          <div className="dp-widget dp-widget--empty">
            <span>Configure the widget to preview it.</span>
          </div>
        )}
      </div>
    </div>
  );
}
```

---

## Console Logs to Expect

| Log | When | What it shows |
|---|---|---|
| `[App] resolving envelope:` | Every config change | `dynamicBindingPathList` array with `{ key, topic }` entries |
| `[App] resolved data:` | After resolveAndCompute returns | `DataEntry[]` with resolved values |
| `[DataPoint] config received` | Config prop changes | Raw `uiConfig`, topic string, sources |
| `[DataPoint] data received` | Data prop changes | Each entry + resolved variable value |
| `[DataPointConfiguration] envelope` | Any configurator change | Full envelope JSON |
| `[Widget Event]` | User interaction | `TIME_CHANGE`, `FILTER_CHANGE`, etc. |

---

## Rules

- `resolve()` is always called with the real bearer token — no dummy data
- Pass `config={envelope.uiConfig}` — never the whole envelope
- `data={[]}` when no envelope or no auth — widget shows loading skeleton
- `onEvent` logs to console in dev; real DataLayer handles it in production
- Auth token comes from `localStorage.bearer_token` — populated by SSO exchange via `?token=` query param
- `setData([])` is NOT called between config changes — widget holds last resolved value while re-fetching

---

## Checklist

- [ ] `auth` state initialised from `localStorage.getItem('bearer_token')`
- [ ] SSO token exchange runs once on mount via `?token=` query param
- [ ] `resolve()` called in `useEffect` on `[envelope, auth]` changes
- [ ] Widget receives `config={envelope.uiConfig}` — not the whole envelope
- [ ] `data={[]}` default when no envelope — widget skeleton shows correctly
- [ ] `onEvent` logs events to console
- [ ] App logs `dynamicBindingPathList` and resolved data on every config change
