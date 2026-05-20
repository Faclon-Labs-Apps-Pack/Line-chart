# IOsense Widget — Architecture Rules

Read the four skill files below **before touching any widget code**. They are the source of truth.

| Skill file | What it covers |
|---|---|
| `.claude/skills/Envelope.md` | Widget/configurator/mini-engine contract, envelope shape, DO/DON'T checklist |
| `.claude/skills/Bindable.md` | How `{{topic}}` bindings work, `buildDynamicBindingPathList` implementation |
| `.claude/skills/MiniEngine.md` | `resolve()` data pipeline, `resolveAndCompute` API, DataEntry contract |
| `.claude/skills/DevHarness.md` | `App.tsx` wiring, auth flow, console logs to expect |

---

## Non-Negotiable Rules

1. **Widget never fetches data** — all data arrives through the `data: DataEntry[]` prop from the mini-engine
2. **Envelope shape**: `{ _id, type, general, uiConfig, dynamicBindingPathList }` — **no `apiConfig`**
3. **Configurator always calls `buildDynamicBindingPathList(uiConfig)`** before emitting via `onChange()`
4. **One resolveAndCompute call** covers all bindings — no per-field fetch loops
5. **All UI uses `@faclon-labs/design-sdk`** components and CSS tokens — no custom components, no hardcoded colors or spacing

---

## Starting a New Widget

1. Run `./init-widget.sh YourWidgetName` — renames all `WidgetTemplate` placeholders
2. Add widget-specific types to `src/iosense-sdk/types.ts`
3. Implement the configurator in `src/components/YourWidgetNameConfiguration/`
4. Implement the widget renderer in `src/components/YourWidgetName/`
5. Run `npm start` — dev harness shows live preview at `http://localhost:3000`
6. Authenticate once: visit `http://localhost:3000/?token=<SSO_TOKEN>`

---

## Configurator Overlay Pattern

Use this pattern whenever a configurator needs an "add / edit" modal (e.g. Add Data Source, Add Alert, Add Rule). No need to re-explain it — follow this recipe exactly.

### 1. Ref + position state

Attach a `ref` to the root configurator `<div>` and compute the modal position when the trigger is clicked:

```tsx
const configRef = useRef<HTMLDivElement>(null);
const [modalX, setModalX] = useState(0);
const [modalY, setModalY] = useState(0);

function openModal(e: React.MouseEvent) {
  e.stopPropagation();                              // prevent parent handlers (e.g. accordion)
  if (configRef.current) {
    const rect = configRef.current.getBoundingClientRect();
    setModalX(rect.right + 30);                     // 30 px gap to the right of config panel
    setModalY(rect.top);                            // top-aligned with config panel
  }
  setIsOpen(true);
}
```

Apply the ref to the configurator root:
```tsx
<div className="dp-config" ref={configRef}>
```

### 2. Modal JSX

```tsx
<Modal
  {...({ transparent: true } as any)}              // transparent backdrop (undocumented runtime prop)
  isOpen={isOpen}
  positionX={modalX}
  positionY={modalY}
  className="dp-<name>-modal"                      // scoped class for width override
  onClose={handleClose}
  header={<ModalHeader title="Add …" onClose={handleClose} />}
  footer={
    <ModalFooter
      primaryAction={<Button variant="Primary" label="Add …" onClick={handleSubmit} />}
    />
  }
>
  <ModalBody>
    <div className="dp-<name>-modal__body">
      {/* form fields stacked flex-column */}
    </div>
  </ModalBody>
</Modal>
```

### 3. CSS (width + body layout)

`Modal.size` only accepts Small/Medium/Large — override width via the scoped class:

```css
.dp-<name>-modal .fds-modal {
  width: 280px;                                     /* or whatever width is required */
}

.dp-<name>-modal__body {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-04, 12px);
}
```

### 4. Imports

```tsx
import { Modal, ModalHeader, ModalBody, ModalFooter } from '@faclon-labs/design-sdk/Modal';
import { Button } from '@faclon-labs/design-sdk/Button';
```

### Rules

- `transparent: true` is not in the `.d.ts` — always cast via `{...({ transparent: true } as any)}`.
- `positionX` / `positionY` are viewport-absolute px values — always derive from `getBoundingClientRect()`.
- `e.stopPropagation()` on every trigger that lives inside an accordion header or other click handler.
- Reset all form state in `handleClose` **and** at the end of `handleSubmit`.

---

## UNS Injection Pattern

Use this pattern in **every configurator** that has bindable fields. No need to re-explain it — follow this recipe exactly.

Angular injects `unsTree`, `onLoadWorkspaces`, and `resolveUNSValue` at runtime. The dev harness falls back to the `useUNSTree` hook. The configurator must support both paths.

### 1. Props interface additions

```tsx
// All-or-none: Angular injects all three or none
unsTree?: UNSTree;
isLoadingTree?: boolean;
onLoadWorkspaces?: () => void;
resolveUNSValue?: (rawValue: string) => string;
```

### 2. Injection detection + hook wiring

Add inside the component, before `return`. The hook is always called (Rules of Hooks).

```tsx
const hasInjectedUNS =
  props.unsTree !== undefined &&
  props.onLoadWorkspaces !== undefined &&
  props.resolveUNSValue !== undefined;

const hookResult = useUNSTree(hasInjectedUNS ? undefined : authentication);
const unsTree         = hasInjectedUNS ? props.unsTree!              : hookResult.unsTree;
const isLoadingTree   = hasInjectedUNS ? (props.isLoadingTree ?? false) : hookResult.isLoadingTree;
const loadWorkspaces  = hasInjectedUNS ? props.onLoadWorkspaces!     : hookResult.loadWorkspaces;
const resolveUNSValue = hasInjectedUNS ? props.resolveUNSValue!      : hookResult.resolveUNSValue;
```

### 3. UNSPathInput for every bindable field

Replace any raw `<input>` on a bindable field with:

```tsx
<UNSPathInput
  label="..."
  placeholder="Type / to browse UNS or paste {{topic}} directly"
  value={myField}
  tree={unsTree}
  isLoading={isLoadingTree}
  onChange={(v: string) => {
    const r = resolveUNSValue(v);
    setMyField(r);
    emit({ myField: r });
  }}
  onOpen={() => loadWorkspaces()}
/>
```

### 4. Imports

```tsx
import { useUNSTree, UNSTree } from '../../iosense-sdk/useUNSTree';
import { UNSPathInput } from '@faclon-labs/design-sdk/UNSPathInput';
```

### Rules

- `useUNSTree` is always called unconditionally — pass `undefined` as auth when injection is active.
- Never pass `unsTree` / `onLoadWorkspaces` / `resolveUNSValue` down to the widget renderer — configurator-only.
- Every bindable field must use `UNSPathInput`, not a raw `<input>`.
