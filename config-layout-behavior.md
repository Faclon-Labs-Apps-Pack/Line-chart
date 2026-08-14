# Configurator Layout & Behavior Contract (portable spec)

This file is the **complete, self-contained recipe** for replicating the IOsense
configurator look-and-feel in ANY widget. The widget's *content* (fields, sections,
domain model) will differ — the *shell, layout, spacing, modals, buttons, contracts,
Time-tab (shifts/comparison) wiring, and null-handling* below must be reproduced
exactly.

**How to use:** paste this file into the new widget's context and say
"build the configurator for <Widget> following ConfigLayout.md". Replace every
`{p}` with the widget's short CSS prefix (ColumnChart uses `cc`, DataPoint uses `dp`
— pick 2–3 lowercase letters). Replace `{Widget}` with the widget name.

All UI comes from `@faclon-labs/design-sdk`. All spacing/color from SDK CSS tokens.
Never hardcode colors or px paddings except where this spec says so.

---

## 0. Component contract (props, emit, onBack)

```tsx
interface {Widget}ConfigurationProps {
  config: {Widget}Envelope | undefined;        // undefined = brand-new widget, MUST render
  authentication?: string;
  onChange: (config: {Widget}Envelope) => void; // the ONLY way state leaves the configurator
  onBack?: () => void;                          // host navigates away; configurator never routes itself

  // UNS injection trio — Angular host injects all three or none (see CLAUDE.md UNS pattern)
  unsTree?: UNSTree;
  isLoadingTree?: boolean;
  onLoadWorkspaces?: () => void;
  resolveUNSValue?: (rawValue: string) => string;

  globalTimepickers?: TimeTabConfigurationProps['globalTimepickers']; // only if Time tab exists
}
```

Contract rules:

1. **Single emit funnel.** One `emit(overrides)` function builds the full uiConfig from
   current state + overrides, wraps it via `buildEnvelope()` (which always calls
   `buildDynamicBindingPathList(uiConfig)`), and calls `onChange`. No other code path
   may call `onChange`. Envelope shape: `{ _id, type, general, uiConfig,
   dynamicBindingPathList, timeConfig?, timeTabConfig? }` — no `apiConfig`.
   `_id: existing?._id ?? `widget_${Date.now()}``.
2. **Re-init on identity change only.** One `useEffect` keyed on `[config?._id]`
   re-seeds ALL local state from the incoming envelope (with the same `??` defaults as
   the initial `useState`s) and clears every scratch buffer / open modal. Separate
   effects keyed on `[config?.timeTabConfig]` / `[config?.timeConfig]` re-sync those
   two, because the host may re-pass the same `_id` with fresh time config.
3. **Scratch buffers never emit.** Draft/pending objects (unsaved "Add" forms,
   edit copies) live in local state and only reach `onChange` on explicit Save.
   Live-committed fields (toggles, colors, text on an already-saved entity) emit
   immediately on each change.
4. **onBack is a dumb callback** wired to the header IconButton. No confirmation, no
   auto-save on back — everything already emitted is saved; scratch buffers are
   simply abandoned.

---

## 1. Panel shell

The configurator renders inside a host column that is **280px wide** (host owns width,
border, radius). The configurator root fills it:

```tsx
<div className="{p}-config" ref={configRef}>   {/* ref REQUIRED — modal anchoring reads it */}
  <div className="{p}-config__header">…</div>   {/* fixed */}
  <Tabs …>…</Tabs>                              {/* fixed */}
  <div className="{p}-config__tab-content">…</div> {/* the ONLY scrollable region */}
  {/* all Modals mount here, as siblings of tab-content */}
</div>
```

```css
.{p}-config {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}
.{p}-config__tab-content {
  flex: 1;
  overflow-y: auto;
}
```

Host panel (dev harness) for reference — replicate in the new harness's App.css:

```css
.app__config {
  width: 280px;
  flex-shrink: 0;
  background: var(--background-default-intense, #fff);
  border: var(--fds-border-default, 1px solid #e0e0e0);
  border-radius: var(--global-border-radius-large, 8px);
  overflow: hidden;
}
```

---

## 2. Header (back button + title)

```tsx
import { IconButton } from '@faclon-labs/design-sdk/IconButton';
import { ArrowLeft } from 'react-feather';

<div className="{p}-config__header">
  <IconButton icon={<ArrowLeft size={20} />} size="20" aria-label="Back" onClick={onBack} />
  <span className="BodyLargeSemibold {p}-config__header-title">{Widget display name}</span>
</div>
```

```css
.{p}-config__header {
  display: flex;
  align-items: center;
  gap: var(--spacing-03, 8px);
  padding: var(--spacing-05, 16px);
  border-bottom: 1px solid var(--border-gray-subtle, #f0f0f0);
  flex-shrink: 0;
}
.{p}-config__header-title { color: var(--text-gray-primary); }
```

Rules: icon 20px, `size="20"`, title is a `<span>` with typography class
`BodyLargeSemibold` (SDK global class, not custom CSS). Header never scrolls.

---

## 3. Tabs

Directly under the header, outside the scroll region:

```tsx
import { Tabs, TabItem } from '@faclon-labs/design-sdk/Tabs';

type ActiveTab = 'data' | 'time' | 'style';   // adjust set per widget, keep order Data → Time → Style
const [activeTab, setActiveTab] = useState<ActiveTab>('data');

<Tabs variant="Bordered" size="Medium" value={activeTab}
      onValueChange={(v) => setActiveTab(v as ActiveTab)} isFullWidthTabItem>
  <TabItem value="data"  label="Data"  />
  <TabItem value="time"  label="Time"  />
  <TabItem value="style" label="Style" />
</Tabs>
```

Rules: always `variant="Bordered"`, `size="Medium"`, `isFullWidthTabItem`. Tab content
is conditionally rendered (`{activeTab === 'data' && (…)}`) inside `__tab-content`.
Tab state is local-only — never persisted to the envelope.

---

## 4. Body layout system (blocks, dividers, spacing)

Two body idioms. Pick per tab:

**A. Flat blocks (Style-type tabs, standalone settings groups).** Vertically stacked
blocks; each block = padded flex column; blocks separated by full-bleed 1px dividers.

```css
.{p}-config__style-block {          /* one settings group */
  display: flex;
  flex-direction: column;
  gap: var(--spacing-04, 12px);
  padding: var(--spacing-05) var(--spacing-05);   /* denser variant: var(--spacing-04, 12px) var(--spacing-05, 16px) */
}
.{p}-config__style-divider {        /* between blocks, edge-to-edge */
  height: 1px;
  margin: 0;
  background: var(--border-gray-subtle);
}
```

Inside a block:
- Group heading: `<p className="BodySmallSemibold {p}-config__style-section-heading">` — `margin: 0; color: var(--text-gray-primary);`
- Sub-heading inside an expanded body: `<p className="LabelMediumDefault …">` — same margin/color.
- Sub-divider inside a block (between sub-groups) cancels the block's horizontal padding:
  ```css
  .{p}-config__advanced-divider {
    height: 1px; width: auto;
    background: var(--border-gray-subtle, #e8e8e8);
    margin: var(--spacing-01, 4px) calc(-1 * var(--spacing-05));
  }
  ```
- Heading + Switch on one row ("Wrap in card", "Advanced Settings"):
  ```css
  .{p}-config__field-row {
    display: flex; align-items: center; justify-content: space-between;
    gap: var(--spacing-03, 8px);
  }
  ```
  Toggle ON reveals the block's fields below it (conditional render, same block).

**B. Standalone form section above accordions (e.g. "Chart Settings").** Same block
CSS plus a head row (title left, mode-driven icon actions right) and a footer row
(right-aligned buttons):

```css
.{p}-config__chart-settings {
  display: flex; flex-direction: column;
  gap: var(--spacing-04, 12px);
  padding: var(--spacing-04, 12px) var(--spacing-05, 16px);
  border-bottom: 1px solid var(--border-gray-subtle, #f0f0f0);
}
.{p}-config__chart-settings-head {
  display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-03, 8px);
}
.{p}-config__chart-settings-actions { display: inline-flex; align-items: center; gap: var(--spacing-02, 4px); }
.{p}-config__chart-settings-footer {
  display: flex; align-items: center; justify-content: flex-end;
  gap: var(--spacing-03, 8px); margin-top: var(--spacing-02, 4px);
}
```

**Universal spacing grammar:**

| Token | Use |
|---|---|
| `--spacing-05` (16px) | Section horizontal padding; header padding |
| `--spacing-04` (12px) | Gap between fields in any form column; section vertical padding |
| `--spacing-03` (8px)  | Gap in horizontal rows (icon+title, button pairs, two-col grids) |
| `--spacing-02` (4–6px)| Gap between adjacent icon buttons; tag wrap gap |
| `--border-gray-subtle`| Every divider and section border |

Two-column field pairs (Unit/Precision, Width/DashStyle, From/To):

```css
.{p}-config__two-col { display: grid; grid-template-columns: 1fr 1fr; gap: var(--spacing-03, 8px); }
```

Input + trailing button row (e.g. select + "Add"): flex, `align-items: flex-end`,
gap spacing-03, select wrapper `flex: 1; min-width: 0;`.

---

## 5. Accordion list sections (repeatable-entity CRUD)

Every repeatable-entity collection (data sources, alerts, rules, …) is ONE
`ProductAccordionItem` per collection, stacked directly in the tab content:

```tsx
import { ProductAccordionItem, PATrailingItem } from '@faclon-labs/design-sdk/ProductAccordion';

<ProductAccordionItem
  title="Data Source"
  trailingIcon={items.length > 0
    ? <PATrailingItem trailing="Counter">{items.length}</PATrailingItem>
    : undefined}                                  // counter chip ONLY when non-empty
  isActive={items.length > 0}
  isDisabled={sectionsDisabled}                   // see §9 state machine
  isExpanded={isSectionOpen('series')}            // CONTROLLED — see below
  onToggle={() => toggleSection('series')}
  headerAction={
    <IconButton isDisabled={sectionsDisabled} icon={<Plus size={14} />} size="16"
      aria-label="Add series" onClick={(e) => openAddModal(id, 'series', e)} />
  }
>
  <div className="{p}-config__section">
    {items.length === 0 && (
      <p className="{p}-config__empty-hint BodySmallRegular">No data sources. Click + to add one.</p>
    )}
    {items.map(renderRowCard)}
  </div>
</ProductAccordionItem>
```

Controlled expansion state — one record, reset on entity switch:

```tsx
const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({});
const isSectionOpen = (s: string) => expandedSections[s] ?? false;       // default CLOSED
const toggleSection = (s: string) => setExpandedSections((p) => ({ ...p, [s]: !p[s] }));
// setExpandedSections({}) whenever the parent entity (chart) changes or is saved/deleted.
```

CSS for the accordion body:

```css
.{p}-config__section {
  width: 100%; box-sizing: border-box;
  display: flex; flex-direction: column; gap: var(--spacing-04, 12px);
}
/* Kill the SDK's own body padding/gap so __section is the only spacing source */
.{p}-config .fds-pa-item__body-inner { padding: 0; gap: 0; }

.{p}-config__empty-hint { color: var(--text-gray-tertiary); margin: 0; font-style: italic; }
```

Rules:
- Header `+` IconButton: `size="16"`, icon `<Plus size={14} />`, `e.stopPropagation()`
  inside the click handler (it lives in the accordion header).
- Informational hint row with icon (like the Axis hint): same empty-hint class plus
  `display:flex; align-items:flex-start; gap:var(--spacing-02,6px); font-style:normal;`
  with `<Info size={16} />` (svg `flex-shrink:0; margin-top:1px`).
- Empty-state copy format: `"No <things>. Click + to add."` — italic, tertiary text.
- If an add affordance is conditionally impossible (e.g. right axis already exists),
  disable the `+` button — never hide it.

---

## 6. Row cards (list entries inside an accordion)

Every saved entry renders as a `ListCard`: click anywhere = edit (opens side modal),
trash appears on hover only, delete asks confirmation (§8).

```tsx
import { ListCard, ListCardLeadingItem, ListCardTrailingItem } from '@faclon-labs/design-sdk/ListCard';

<ListCard
  key={item._id}
  className="{p}-config__row-card"
  title={item.label || `Series ${i + 1}`}          // ALWAYS a positional fallback title
  subtitle={item.unsPath || undefined}             // secondary line; omit when empty
  leadingItem={item.color ? <ListCardLeadingItem leading="Color" color={item.color} /> : undefined}
  onClick={(e) => openEditModal(entityId, 'series', e, item)}
  trailingItems={
    <ListCardTrailingItem trailing="Icon" icon={
      <IconButton icon={<Trash2 size={13} />} size="16" aria-label="Delete"
        onClick={(e) => { e.stopPropagation(); setDeleteTarget({ kind: 'series', entityId, id: item._id }); }} />
    } />
  }
/>
```

```css
.{p}-config__row-card { cursor: pointer; }
.{p}-config__row-card .fds-list-card-trailing { opacity: 0; transition: opacity 0.15s ease; }
.{p}-config__row-card:hover .fds-list-card-trailing,
.{p}-config__row-card:focus-within .fds-list-card-trailing { opacity: 1; }
.{p}-config__row-card .fds-list-card__subtitle {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

/* Every delete icon button in the configurator tints red on hover — targeted by
   aria-label so it needs no per-instance class. */
.{p}-config .fds-icon-btn[aria-label="Delete"]:hover,
.{p}-config .fds-icon-btn[aria-label="Delete"]:focus-visible {
  color: var(--text-error-default);
  background: var(--background-error-secondary);
}
.{p}-config .fds-icon-btn[aria-label="Delete"]:hover .fds-icon-btn__icon,
.{p}-config .fds-icon-btn[aria-label="Delete"]:focus-visible .fds-icon-btn__icon {
  color: var(--text-error-default);
}
```

Subtitle conventions: raw value (`unsPath`), a range (`` `${from} – ${to}` ``), or a
summary (`` `Right • 3 Data Sources` `` — singular/plural handled).

---

## 7. Second-level side-panel modal (Add / Edit forms)

ONE shared Modal instance serves every Add/Edit form; a `modalSection` discriminator
picks which fields render. It floats to the **right of the config panel**, top-aligned
with the clicked accordion row, transparent backdrop.

### 7.1 State

```tsx
const configRef = useRef<HTMLDivElement>(null);       // on the configurator root
const [modalOpen, setModalOpen] = useState(false);
const [modalSection, setModalSection] = useState<ModalSection>('series');
const [editingId, setEditingId] = useState<string | null>(null);  // null = Add mode
const [modalX, setModalX] = useState(0);
const [modalY, setModalY] = useState(0);
// …one useState per form field, ALWAYS string-typed for numeric inputs
```

### 7.2 Anchoring math (copy verbatim)

```tsx
// x = config-panel right edge + 20px gutter.
// y = clicked accordion header's top, clamped so estHeight + 16px margin fits the viewport.
// Also publishes --{p}-anchor-y on <html> — CSS derives max-height from it.
function computeAnchorFromEvent(e: React.MouseEvent, estHeight = 500) {
  const margin = 16;
  const trigger = e.currentTarget as HTMLElement | null;
  const headerEl =
    (trigger?.closest('.fds-pa-item__header') as HTMLElement | null) ??
    (trigger?.closest('.fds-pa-item') as HTMLElement | null) ??
    trigger;
  const anchorRect = headerEl?.getBoundingClientRect();
  const panelEl =
    (configRef.current?.closest('.app__config') as HTMLElement | null) ?? configRef.current;
  const panelRect = panelEl?.getBoundingClientRect();
  const x = (panelRect?.right ?? 0) + 20;
  const vh = window.innerHeight;
  let y = anchorRect?.top ?? margin;
  if (y + estHeight + margin > vh) y = Math.max(margin, vh - estHeight - margin);
  if (y < margin) y = margin;
  setModalX(x); setModalY(y);
  document.documentElement.style.setProperty('--{p}-anchor-y', `${y}px`);
}
```

Maintain a per-section estimated fully-expanded height map (used only for the clamp):

```tsx
const SECTION_EST_HEIGHT: Record<ModalSection, number> = {
  series: 480, fixed: 420, axis: 360, stack: 320, plotLine: 620, plotBand: 380,
}; // rough body heights; tune per widget's forms
```

### 7.3 Open / close handlers

- `openAddModal(entityId, section, e)`: `e.stopPropagation()` → `computeAnchorFromEvent(e, SECTION_EST_HEIGHT[section])`
  → set section, `setEditingId(null)`, **reset every form field** — color fields seed
  from a curated palette so Color is never blank on open:
  ```tsx
  const DEFAULT_COLOR_PALETTE = ['#7B61FF','#FF6B6B','#4ECDC4','#FFD93D','#6BCB77',
    '#4D96FF','#FF8FB1','#A66CFF','#FFA94D','#22C55E','#06B6D4','#F472B6','#8B5CF6','#F59E0B','#10B981'];
  const pickRandomColor = () => DEFAULT_COLOR_PALETTE[Math.floor(Math.random() * DEFAULT_COLOR_PALETTE.length)];
  ```
- `openEditModal(…)`: same, but `setEditingId(item._id)` and pre-fill fields from the item
  (numbers → `String(x)`, missing optionals → `''`).
- `handleModalClose()`: close + null editingId + **reset ALL form fields to blank**.
- `handleModalSubmit()`: guard (`if (!modalChartId) { handleModalClose(); return; }` and
  entity lookup), build the entry with `_id: editingId ?? `series_${Date.now()}``,
  map-replace when editing / append when adding, commit via the single update helper,
  then `handleModalClose()`. Reset happens in BOTH close and submit paths.

### 7.4 Modal JSX

```tsx
<Modal
  {...({ transparent: true } as any)}     // undocumented runtime prop — always cast
  isOpen={modalOpen}
  positionX={modalX}
  positionY={modalY}
  className="{p}-series-modal"
  onClose={handleModalClose}
  header={<ModalHeader title={editingId ? 'Edit Data Source' : 'Add Data Source'} onClose={handleModalClose} />}
  footer={
    <ModalFooter>
      <Button
        variant="Primary"
        label={editingId ? 'Save changes' : 'Add Data Source'}   // Add label names the thing
        isFullWidth
        isDisabled={/* required-field validation, see §10 */}
        onClick={handleModalSubmit}
      />
    </ModalFooter>
  }
>
  <ModalBody>
    <div className="{p}-series-modal__body">
      {/* fields, top→bottom order: Identity (Label) → Data (value/UNS) → Color → Style → Options */}
    </div>
  </ModalBody>
</Modal>
```

### 7.5 Modal CSS (copy verbatim, swap prefix)

```css
/* Side-panel modal: 280px wide, flows from the anchored row down to a 16px
   viewport margin; body scrolls when content exceeds available height. */
.{p}-series-modal.fds-modal__backdrop--transparent { pointer-events: auto; }
.{p}-series-modal .fds-modal {
  width: 280px;
  max-height: calc(100vh - var(--{p}-anchor-y, 16px) - 16px);
  display: flex; flex-direction: column; overflow: hidden;
}
.{p}-series-modal .fds-modal__body { flex: 1 1 auto; overflow-y: auto; min-height: 0; }

/* SDK header lacks bottom padding — add it; kill the header root's extra gap. */
.{p}-series-modal .fds-modal-header__wrapper,
.{p}-delete-confirm-modal .fds-modal-header__wrapper { padding-bottom: var(--spacing-05); }
.{p}-series-modal .fds-modal-header__root,
.{p}-delete-confirm-modal .fds-modal-header__root { gap: 0; }

/* Footer: tighten padding to spacing-05; hide the empty action stack; make the
   slot (and its single Button) span the full row. */
.{p}-series-modal .fds-modal-footer__actions,
.{p}-delete-confirm-modal .fds-modal-footer__actions { padding: var(--spacing-05) var(--spacing-05); }
.{p}-series-modal .fds-modal-footer__stack:empty,
.{p}-delete-confirm-modal .fds-modal-footer__stack:empty { display: none; }
.{p}-series-modal .fds-modal-footer__slot,
.{p}-delete-confirm-modal .fds-modal-footer__slot { width: 100%; }
.{p}-series-modal .fds-modal-footer__slot > *,
.{p}-delete-confirm-modal .fds-modal-footer__slot > * { width: 100%; }

/* Form body */
.{p}-series-modal__body { display: flex; flex-direction: column; gap: var(--spacing-04, 12px); }
.{p}-series-modal__two-col { display: grid; grid-template-columns: 1fr 1fr; gap: var(--spacing-03, 8px); }

/* Portaled popovers must layer above the modal */
.fds-modal__backdrop .fds-select-input__popover,
.fds-modal__backdrop .fds-uns-path-input__popover,
.fds-modal__backdrop .fds-dropdown-menu { z-index: var(--global-z-index-modal, 500); }
.fds-uns-path-input__popover { z-index: 9999 !important; }
```

### 7.6 Popover-inside-modal workaround (design-sdk 0.7.7)

SelectInput/ColorInput popovers portal to `<body>`, outside the modal backdrop, so the
modal's outside-click listener dismisses the modal when the user clicks an option.
Attach a bubble-phase `stopPropagation` guard for `pointerdown`/`mousedown` ONLY (never
`click`) on `.fds-select-input__popover` and `.fds-color-input__popover` via a
MutationObserver mounted once in a `useEffect(…, [])`. Copy the effect from
`ColumnChartConfiguration.tsx` (search "MutationObserver"). Remove when the SDK fixes it.

---

## 8. Delete-confirm modal (destructive actions)

Every delete — row trash OR entity trash — opens a centered confirm modal first.
Nothing is ever deleted on a single click.

```tsx
// One target state drives one shared modal:
type DeleteKind = 'series' | 'fixed' | /* …one per deletable row type */;
const [deleteTarget, setDeleteTarget] = useState<{ kind: DeleteKind; entityId: string; id: string } | null>(null);

const DELETE_COPY: Record<DeleteKind, { title: string; body: string }> = {
  series: { title: 'Delete Data Source',
            body: 'Are you sure you want to delete this data source? This action is irreversible.' },
  // Copy format is FIXED: title "Delete <Thing>", body
  // "Are you sure you want to delete this <thing>? This action is irreversible."
};
```

```tsx
<Modal
  isOpen={deleteTarget !== null}                 // centered — NO positionX/Y, NO transparent
  className="{p}-delete-confirm-modal"
  onClose={() => setDeleteTarget(null)}
  header={
    <ModalHeader
      title={deleteTarget ? DELETE_COPY[deleteTarget.kind].title : ''}
      leadingItem={<span className="{p}-delete-confirm-modal__icon"><Trash2 size={16} /></span>}
      onClose={() => setDeleteTarget(null)}
    />
  }
  footer={
    <ModalFooter
      primaryAction={<Button variant="Primary" color="Negative" label="Delete" onClick={confirmDeleteTarget} />}
      secondaryAction={<Button variant="Gray" label="Cancel" onClick={() => setDeleteTarget(null)} />}
    />
  }
>
  <ModalBody>
    <p className="BodyMediumRegular {p}-delete-confirm-modal__body">
      {deleteTarget ? DELETE_COPY[deleteTarget.kind].body : ''}
    </p>
  </ModalBody>
</Modal>
```

```css
.{p}-delete-confirm-modal .fds-modal { width: 360px; }
.{p}-delete-confirm-modal__body { margin: 0; color: var(--text-gray-secondary, #555); }
/* Tinted red square around the trash icon in the header */
.{p}-delete-confirm-modal__icon {
  display: inline-flex; align-items: center; justify-content: center;
  width: var(--spacing-08); height: var(--spacing-08);
  border-radius: var(--global-border-radius-small);
  background: var(--background-error-secondary);
  color: var(--text-error-default);
}
```

For a whole-entity delete (a chart with children), the body enumerates what dies:
`` `Are you sure you want to delete "${entity.title || 'this chart'}" and all of its
data sources, axes, plot lines, and plot bands? This action is irreversible.` ``

`confirmDeleteTarget()` switches on `kind`, rebuilds the owning arrays without the id,
repairs any cross-references (memberships, dangling ids), commits through the single
update helper, then `setDeleteTarget(null)`.

---

## 9. Entity state machine (Empty / View / Edit) — for configurators with a top-level entity list

Applies when the widget owns a list of named entities (charts, pages, …) edited via a
standalone form section (§4B) above the accordions.

```tsx
const [entities, setEntities]       = useState<Entity[]>(initFromConfig);  // committed truth
const [selectedId, setSelectedId]   = useState<string>(init[0]?._id ?? '');
const [pending, setPending]         = useState<Entity>(makeEmpty());       // Empty-mode buffer
const [draft, setDraft]             = useState<Entity | null>(null);       // Edit-mode buffer
const [editMode, setEditMode]       = useState<'none' | 'edit-existing' | 'edit-new'>('none');

const isEditing = editMode !== 'none';
const isEmpty   = entities.length === 0 && !isEditing;
const isView    = entities.length > 0 && !isEditing;
const formEntity = isEmpty ? pending : (isEditing ? draft : active) ?? null;
const sectionsDisabled = isEmpty || isEditing;   // accordions visible but inert until the form resolves
```

Behavioral matrix:

| Mode | Title field | Head-row icons | Footer buttons |
|---|---|---|---|
| Empty | editable TextInput (required) | none | `Save` (Primary) — appears only once title non-blank |
| View, 1 entity | read-only TextInput, placeholder `—` | `+` (Add New, tooltipped) `✎` (Edit, tooltipped) | none |
| View, >1 entities | SelectInput switcher listing entities | `+` `✎` | none |
| Edit-existing | editable, `validationState="error"` + errorText when blank | `🗑` (opens entity delete confirm) | `Cancel` (Gray) + `Save changes` (Primary, disabled while invalid) |
| Edit-new | editable required | none (nothing committed to trash yet) | `Cancel` + `Save` |

Rules:
- Edit always operates on a **copy** (`setDraft({ ...active })`) so Cancel discards cleanly.
- Only `commitState()` (which wraps `emit`) writes upstream; buffers never emit.
- View-mode field edits on an already-committed entity commit live (each keystroke emits).
- Switching entities resets `expandedSections` to `{}` and emits the new `activeEntityId`.
- Head-row icon buttons: `size="16"`, icons `size={14}`, wrapped in
  `<Tooltip placement="Bottom" bodyText="Add New Chart">` for + and ✎.
- Deleting the last entity still emits (so the host clears), and reverts to Empty mode.
- Required-title validation: `titleError = isEditing && draft.title.trim() === ''` →
  `validationState="error"` `errorText="<Thing> title is required"`.

---

## 10. Form control catalog & validation

| Need | Component | Conventions |
|---|---|---|
| Text / number | `TextInput` | `onChange={({ value }) => …}`; numbers kept as **string state**, `type="number"`, unit via `suffix="px"`; parse on emit with fallback (`Number(v) \|\| DEFAULT`) |
| Required marker | any input | `necessityIndicator="required"` (+ `isRequired` on TextInput) |
| Single select | `SelectInput` + manual `isOpen` state + `DropdownMenu > ActionListItemGroup > ActionListItem selectionType="Single"` | children rendered only when open; clicking an item sets value AND closes |
| Multi select w/ chips | `SelectInput` with `tags={ids.map(id => ({ label, onDismiss }))}` + `ActionListItem selectionType="Multiple"` | toggle membership on click; dropdown stays open |
| Color | `ColorInput` wrapped in `HexInput` (strips/reapplies `#`, see ColumnChart) preceded by `<InputFieldHeader label="Color" necessityIndicator="required" />` in a plain `<div>` | never a bare ColorInput without the header |
| Bindable value | `UNSPathInput` | `placeholder="Type / to browse UNS or paste {{topic}}"`, wire `tree/isLoading/onChange(resolveUNSValue(v))/onOpen(loadWorkspaces)`; numeric-or-binding fields use placeholder `"Type a number or / to bind"` |
| On/off section | `Switch` in a `__field-row` | `onChange={({ isChecked }) => …}` — set state AND emit in the same handler |
| Checkbox list | `CheckboxGroup label="" orientation="Vertical"` + `Checkbox size="Medium"` | group gets `gap: var(--spacing-02, 6px); padding-left: var(--spacing-02, 6px);` |
| 2–3 exclusive options | `RadioGroup orientation="Horizontal"` + `Radio` | `onChange={({ value }: RadioGroupChangeMeta) => …}` |
| Removable chips | `Tag label onDismiss` in a flex-wrap row, gap spacing-02 | |
| Buttons | `Button` | Primary action `variant="Primary"`; cancel/secondary `variant="Gray"`; destructive `variant="Primary" color="Negative"`; inline add `variant="Secondary"`; modal footer buttons `isFullWidth` |

**Submit validation (side-panel modals):** the footer Primary button carries
`isDisabled` computed from required fields — `!label.trim() || !unsPath.trim() || …`,
multi-selects require `ids.length > 0`. No toast/alert validation; the button simply
stays disabled. Modal titles/labels switch on `editingId`:
Add → `Add <Thing>`, Edit → `Edit <Thing>` / button `Save changes`.

**Field order inside a form:** Identity (Label/Name) → Data (value/UNS path) →
Color → Style details (width, dash) → memberships/options. Paired short fields share
a `__two-col` row.

---

## 11. Null-safety & missing-key strategy

The configurator MUST render fully with `config === undefined`, `uiConfig === {}`,
or any missing nested key. Techniques (all mandatory):

1. **Every read is optional-chained with a default at the leaf:**
   `config?.uiConfig?.style?.card?.wrapInCard ?? true`. The same defaults are used in
   the initial `useState` AND in the `[config?._id]` re-init effect — keep them in
   named `DEFAULT_*` constants so both sites can't drift.
2. **DEFAULT constants** for every settings group (e.g. `DEFAULT_CARD_STYLE`,
   `DEFAULT_ADVANCED_SETTINGS`) and spread-merge stored partials over them:
   `{ ...DEFAULTS, ...sanitize(config?.…?.advancedSettings ?? {}) }`.
3. **Normalize on load.** A `normalize(entity)` function enforces structural
   invariants on every entity read from the envelope (back-fill required child
   objects, reconstruct derived arrays, drop dangling ids). Run it with `.map()` over
   the incoming list before it touches state.
4. **Sanitize legacy values.** Old envelopes may hold stale formats (e.g.
   `var(--token, #fff)` in color fields). Detect and coerce to the current format on
   load — never let a raw legacy value reach an input.
5. **Empty placeholder entity.** Sections render in ALL modes; when no entity exists,
   feed them a frozen `EMPTY_SECTION_ENTITY` (all arrays `[]`, structural minimums
   filled) and gate every action with `sectionsDisabled`. The user always sees the
   configurator's full structure, with the "No X. Click + to add." hints.
6. **Fallback display names everywhere:** `item.label || `Series ${i + 1}``,
   `entity.title || `Chart ${i + 1}``, `axis.name || 'Right Axis'`. Never render a
   blank title.
7. **Numeric string states** parse with fallback on emit: `Number(v) || DEFAULT` (or
   an explicit `Number.isFinite` guard + `Math.round` for dimensions). `0`-valid
   fields must use `== null` checks, not `||`.
8. **Emit-on-empty rule:** deleting the last entity emits only if an envelope already
   existed (`if (next.length > 0 || config) emit(…)`) so a brand-new blank configurator
   doesn't spam the host, but a real deletion still clears it.
9. **Selection repair:** persisted `activeEntityId` is validated against the loaded
   list — `(persisted && list.find(match)) ? persisted : list[0]?._id ?? ''`.
10. **Modal guards:** every submit/confirm handler re-looks-up its target
    (`entities.find(…)`); if gone, close the modal and bail silently.

---

## 12. Time tab — shifts, comparison mode & deviation (SDK delegation + host contract)

Applies to every widget whose envelope carries time config. This is the
**producing** side — how the configurator lets the user set up shifts,
comparison mode, and deviation patterns. The **consuming** side (how the
widget requests shift/comparison data via TIME_CHANGE and renders it) lives in
`widget-layout-behavior.md` §§4, 6, 8–10. Reference implementation:
`src/components/LineChartConfiguration/LineChartConfiguration.tsx`.

### 12.1 Ownership: the SDK owns ALL shift/comparison UI

The Time tab is ONE component — the SDK's `TimeTabConfiguration`
(`@faclon-labs/design-sdk`). It natively renders:

- picker type (Local / Fixed / link to Global Timepicker),
- duration presets ("Add Duration" panel) + default duration + default periodicity,
- **Shifts** — the "Add Shift" panel (name, color, start/end time) and the
  **Shift Aggregator** select,
- **Comparison Mode** switch + **deviation-pattern** cards (`fds-ttc__deviation`),
- per-source deviation overrides (the Time tab's own "Advance Settings",
  rendered only when a `charts` prop is supplied — §12.2).

DON'T rebuild or duplicate any of this UI. (An earlier LineChart iteration
injected its own deviation-indicator + advance-settings portals; both were
removed once the SDK rendered the deviation cards natively. A vestigial
`uiConfig.deviationIndicator` field remains in LineChart that the widget never
reads — do not replicate it in new widgets.) The configurator's job is exactly
four things:

1. mount the component, gated + wired (§12.2),
2. persist BOTH config shapes on every emit (§12.3),
3. transform SDK output → host shape via `toHostTimeConfig` (§12.4) — this is
   the step that actually delivers shifts/comparison to the host and widget,
4. guard its `onChange` (§12.5) and patch its DOM quirks (§12.6).

### 12.2 Mounting & gating

```tsx
{activeTab === 'time' && (
  activeChart && activeChart.series.length > 0 ? (
    <div className="{p}-config__time-tab" ref={timeTabRef}>
      <TimeTabConfiguration
        value={timeTabConfig}                 // re-hydration only — NEVER echoed from onChange (§12.5)
        onChange={handleTimeConfigChange}
        globalTimepickers={globalTimepickers} // pass-through of the host prop (§0)
        charts={gtpCharts}
      />
      <PerSourceChartDropdownPortal scope={timeTabRef} charts={gtpCharts} />  {/* §12.6 #5 */}
    </div>
  ) : (
    <div className="{p}-config__time-tab-empty">
      <span>Add a data source in the <strong>Data</strong> tab first.</span>
    </div>
  )
)}
```

- **Gate on data**: no series → hint text, not the component (time config is
  meaningless with nothing to query).
- **`charts` prop** (SDK 0.6.5+) is a `GTPChart[]` view of the local entities.
  Without it the per-source deviation override section never renders:

  ```tsx
  const gtpCharts = useMemo<GTPChart[]>(
    () =>
      charts.map((c) => ({
        id: c._id,
        name: c.title,
        sources: c.series.map((s) => ({ id: s._id, name: s.name })),
      })),
    [charts],
  );
  ```

  The `id`s here MUST be the real entity/series `_id`s — the SDK writes
  per-source overrides keyed `` `${chartId}:${seriesId}` `` and the widget
  looks them up with the same key (widget-layout-behavior.md §10).

```css
.{p}-config__time-tab { padding: 0; overflow-y: auto; }
.{p}-config__time-tab-empty {
  display: flex; align-items: center; justify-content: center;
  padding: var(--spacing-08, 32px) var(--spacing-06, 20px);
  text-align: center;
  color: var(--content-tertiary, #6B7280);
  font-size: var(--font-size-02, 14px);
}
```

### 12.3 Dual persistence — the envelope carries BOTH shapes

| Envelope key | Shape | Consumer |
|---|---|---|
| `timeTabConfig` | raw SDK `TimeTabUIConfig` | the configurator itself — re-hydrates `TimeTabConfiguration` exactly as the user left it |
| `timeConfig` | `HostTimeConfig` = `toHostTimeConfig(tc)` | Lens query-engine + the widget's `timeConfig` prop |

In `buildEnvelope`:

```tsx
const tc: TimeTabUIConfig =
  timeTabConfig ??                                // override from the current emit
  existing?.timeTabConfig ??                      // previous save
  (existing?.timeConfig as TimeTabUIConfig) ??    // legacy envelope (pre-split, old shape)
  FALLBACK_TIME_CONFIG;                           // user never opened the Time tab
…
timeConfig: toHostTimeConfig(tc),
timeTabConfig: tc,
```

Rules:

- `FALLBACK_TIME_CONFIG` must ship the **full built-in preset roster** (today /
  yesterday / last24h / last7d / last30d / current_week / previous_week /
  current_month / previous_month — each with its `periodicities` list). The
  host derives the window by looking up `defaultDurationId` in `allDurations`;
  an id missing from the list means the host can't compute time → 422. Copy
  the roster from `LineChartConfiguration.tsx` (`FALLBACK_TIME_CONFIG`).
- The `[config?._id]` re-init effect (§0 rule 2) resets BOTH the
  `timeTabConfig` state and `timeTabConfigRef` from
  `config.timeTabConfig ?? (config.timeConfig as TimeTabUIConfig)`.
- Persisting `timeConfig: <raw SDK value>` does NOT work — the host needs
  `type`, `pickerType`, `startTime: null`, `endTime: null`, etc. (§12.4).

### 12.4 `toHostTimeConfig` — where shifts/comparison actually reach the host

The SDK stores shift/comparison settings in DIFFERENT sub-objects depending on
picker type: under `t.fixed.…` in fixed mode, under `t.global.…` in GTP mode,
and at the top level in local mode. The transform must select per-pickerType
or the configured shifts/comparison **silently vanish** for that mode. Copy
verbatim:

```tsx
function toHostTimeConfig(t: TimeTabUIConfig): HostTimeConfig {
  const pickerType = (t.linkTimeWith ?? t.timeType ?? 'local') as 'local' | 'fixed' | 'global';
  const fd = t.fixed?.duration;
  const fixedDuration =
    pickerType === 'fixed' && fd
      ? {
          id: 'fixed' as const,
          label: fd.name || 'Fixed',
          navigation: fd.navigation,
          x: Number(fd.x) || 0,
          xPeriod: fd.xPeriod,
          xEvent: fd.xEvent,
          y: Number(fd.y) || 0,
          yPeriod: fd.yPeriod,
          yEvent: fd.yEvent,
        }
      : undefined;
  const cycleTime = pickerType === 'fixed' ? t.fixed?.cycleTime ?? null : t.cycleTime ?? null;
  return {
    timezone: t.timezone,
    type: pickerType === 'global' ? 'local' : pickerType,
    pickerType,
    // Preserve the GTP id so the widget detects GTP mode even when Lens pushes
    // a runtime timeConfig update that drops pickerType (widget spec §8).
    ...(pickerType === 'global' && (t.global as any)?.id
      ? { globalTimepickerId: (t.global as any).id }
      : {}),
    cycleTime,
    startTime: null,          // the HOST resolves the actual window at query time
    endTime: null,
    fixedDuration,
    defaultDurationId: t.defaultDurationId,
    allDurations: t.allDurations ?? [],
    defaultPeriodicity:
      pickerType === 'fixed' && fd?.periodicity ? fd.periodicity.toLowerCase() : t.defaultPeriodicity,
    shifts:
      pickerType === 'fixed' ? (t.fixed?.shifts ?? t.shifts ?? []) :
      pickerType === 'global' ? ((t.global as any)?.shifts ?? t.shifts ?? []) :
      (t.shifts ?? []),
    shiftAggregator:
      pickerType === 'fixed' ? ((t.fixed as any)?.shiftAggregator ?? (t as any).shiftAggregator) :
      pickerType === 'global' ? ((t.global as any)?.shiftAggregator ?? (t as any).shiftAggregator) :
      (t as any).shiftAggregator,
    comparisonMode:
      pickerType === 'fixed' ? t.fixed?.comparisonMode :
      pickerType === 'global' ? t.global?.comparisonMode :
      t.comparisonMode,
    deviationPattern:
      pickerType === 'fixed' ? t.fixed?.deviationPattern :
      pickerType === 'global' ? t.global?.deviationPattern :
      t.deviationPattern,
    sourceDeviationOverrides:
      pickerType === 'fixed' ? t.fixed?.sourceDeviationOverrides :
      pickerType === 'global' ? t.global?.sourceDeviationOverrides :
      t.sourceDeviationOverrides,
  };
}
```

The five mode-scoped fields and what the widget does with each:

| HostTimeConfig field | Set by (SDK Time tab) | Consumed by (widget spec §) |
|---|---|---|
| `shifts` | "Add Shift" panel (name, color, start/end) | Shift toggle + TIME_CHANGE `shifts` + shift-series rendering (§9) |
| `shiftAggregator` | Shift Aggregator select (Sum/Average/…) | mapped to backend vocab (`average → mean`) on TIME_CHANGE (§6) |
| `comparisonMode` | Comparison Mode switch | OFFERS the Compare toggle; off force-clears it (§10) |
| `deviationPattern` | deviation-pattern cards | global deviation coloring convention (§10) |
| `sourceDeviationOverrides` | per-source Advance Settings | per-source override, key `` `${chartId}:${seriesId}` `` (§10) |

### 12.5 onChange guards (copy verbatim)

The SDK fires `onChange` on mount AND whenever its `charts` prop changes —
both must be filtered or the configurator stomps the widget's runtime state:

```tsx
// Ref tracks the latest committed value; NOT fed back into `value` (see below).
const timeTabConfigRef = useRef<TimeTabUIConfig | undefined>(initialTc);
// The SDK fires onChange immediately on mount (initialization callback). If its
// normalized value differs from the envelope's, emitting it would reset the
// widget's runtime time selection (e.g. "Previous 3 months" → back to default).
const timeConfigSettledRef = useRef(false);
useEffect(() => {
  const t = setTimeout(() => { timeConfigSettledRef.current = true; }, 0);
  return () => clearTimeout(t);
}, []);

function handleTimeConfigChange(next: TimeTabUIConfig) {
  if (!timeConfigSettledRef.current) return;                                       // guard 0: mount echo
  if (JSON.stringify(next) === JSON.stringify(timeTabConfigRef.current)) return;   // guard 1: no-op
  // guard 2: adding/removing a data source makes the SDK revert defaultPeriodicity
  // to its default — keep the user's explicit choice.
  const merged: TimeTabUIConfig =
    timeTabConfigRef.current?.defaultPeriodicity &&
    next.defaultPeriodicity !== timeTabConfigRef.current.defaultPeriodicity
      ? { ...next, defaultPeriodicity: timeTabConfigRef.current.defaultPeriodicity }
      : next;
  if (JSON.stringify(merged) === JSON.stringify(timeTabConfigRef.current)) return;
  timeTabConfigRef.current = merged;    // ref, NOT state — see rule below
  emit({ timeTabConfig: merged });
}
```

Rules:

- **Ref, not state.** Feeding the SDK's own `onChange` output back into its
  `value` prop resets its internal panel state — closing the "Add Shift" /
  "Add Duration" form mid-edit. `value` only changes on entity re-init (§12.3).
- **Every emit carries time config.** The single `emit()` funnel (§0 rule 1)
  passes `overrides?.timeTabConfig ?? timeTabConfigRef.current` into
  `buildEnvelope`, so chart/style edits never drop the latest Time tab state.

### 12.6 Required DOM patches around the SDK Time tab

The SDK component has runtime quirks that MUST be patched or shifts/comparison
cannot be configured from a narrow host column. All patches are
MutationObserver-based (the SDK re-renders internally); copy each from
`LineChartConfiguration.tsx`.

1. **Float the Add Shift / Add Duration panel.** The SDK renders these panels
   as an SDK Modal (backdrop class `.fds-ttc__panel-modal`) whose inline
   `left` anchors INSIDE the narrow configurator column, so it overflows into
   the canvas under other widgets. Publish the panel's real right edge as a
   CSS variable (`--{p}-config-right-edge`, kept fresh via ResizeObserver +
   window resize listener) and dock the modal beside the column:

   ```css
   /* Backdrop pointer-events OFF: SelectInput/ColorInput portal their menus to
      <body> (outside the modal DOM); clicks on them must not hit the backdrop
      and fire the SDK's outside-click close. Form still closes via Cancel/X. */
   .fds-ttc__panel-modal.fds-modal__backdrop { pointer-events: none !important; }
   .fds-ttc__panel-modal .fds-modal--positioned {
     pointer-events: auto;
     left: calc(var(--{p}-config-right-edge, 320px) + 20px) !important;
   }
   ```

2. **Dropdown-inside-panel guard.** The SDK adds a `document` mousedown
   listener that closes every open panel unless the click lands inside
   `.fds-ttc__panel-modal` — but SelectInput portals its dropdown to `<body>`,
   so picking a Shift Aggregator option would close the form. Intercept
   `mousedown` on `document.body` (fires before `document` in the bubble
   chain) and `stopPropagation()` when the target is inside
   `.fds-select-input__popover` while a `.fds-ttc__panel-modal` exists.

3. **Single-open accordions.** The SDK's Time-tab accordions are uncontrolled
   with no single-open prop. Observe class changes; when an item gains
   `fds-pa-item--expanded`, click closed every OTHER expanded item's header
   (skipping ancestors of the opened item).

4. **Realtime entities: hide periodicity.** No SDK prop hides periodicity
   (`disablePeriodicities` is a runtime no-op). When the active entity is
   realtime-type, DOM-hide the periodicity selects (inputs named
   `periodicity` / `fixed-duration-periodicity` → hide their closest
   `.fds-ttc__required-select`) and the duration cards' "Periodicity: …"
   subtitles. Leave shifts intact.

5. **Per-source chart switcher → dropdown.** The SDK renders the per-source
   deviation section's chart switcher as a Tabs strip that doesn't fit 280px.
   Hide it and inject a single-select "Chart" `SelectInput` that drives the
   hidden tabs by programmatic click on `.fds-tab-item[data-value="<id>"]`
   (copy `PerSourceChartDropdownPortal` + `PerSourceChartSelect`):

   ```css
   .fds-ttc__per-source > .fds-tabs { display: none !important; }
   .{p}-config__per-source-chart-field { margin-bottom: var(--spacing-04, 12px); }
   ```

---

## 13. Behavioral rules checklist (DO / DON'T)

DO:
- `e.stopPropagation()` in EVERY click handler living inside an accordion header,
  ListCard, or any parent with its own onClick.
- Reset the whole form-field state in `handleModalClose` AND at the end of submit.
- Seed the Color field with a palette pick on every Add-modal open.
- Keep exactly one scrollable region (`__tab-content`); modals scroll their own body.
- Use SDK typography classes (`BodyLargeSemibold`, `BodySmallSemibold`,
  `BodySmallRegular`, `BodyMediumRegular`, `LabelMediumDefault`) instead of custom
  font CSS.
- Name every CSS class `{p}-config__*` / `{p}-series-modal*` / `{p}-delete-confirm-modal*`.
- Call `buildDynamicBindingPathList(uiConfig)` in `buildEnvelope` on every emit.
- Follow the UNS injection pattern from CLAUDE.md (all-or-none injected trio, hook
  always called unconditionally).
- Persist BOTH `timeConfig` (host shape via `toHostTimeConfig`) and `timeTabConfig`
  (raw SDK shape) on EVERY emit — reading the latest from `timeTabConfigRef` so
  chart/style edits never drop the Time tab state (§12.3, §12.5).
- Read `shifts` / `shiftAggregator` / `comparisonMode` / `deviationPattern` /
  `sourceDeviationOverrides` per-pickerType in `toHostTimeConfig` (fixed →
  `t.fixed.…`, global → `t.global.…`, local → top level) (§12.4).
- Pass a `GTPChart[]` view of the local entities (real `_id`s) as
  `TimeTabConfiguration`'s `charts` prop, or per-source deviation overrides never
  render (§12.2).
- Guard `TimeTabConfiguration.onChange` with all three guards (mount echo,
  deep-equal no-op, defaultPeriodicity revert) (§12.5).

DON'T:
- Don't fetch data in the configurator or the widget (mini-engine owns data).
- Don't use `Modal size` for width — always override via the scoped class.
- Don't put `unsTree`/`onLoadWorkspaces`/`resolveUNSValue` on the widget renderer.
- Don't hard-delete on a single click — always the confirm modal.
- Don't emit from scratch buffers (pending/draft) before Save.
- Don't hide conditionally-unavailable `+` buttons — disable them.
- Don't add horizontal padding inside accordion bodies beyond `__section` (SDK padding
  is zeroed on purpose).
- Don't persist UI-only state (active tab, open sections, open modals) to the envelope
  — except `activeEntityId`, which IS persisted.
- Don't rebuild or duplicate shift / comparison / deviation UI — the SDK's
  `TimeTabConfiguration` owns all of it (§12.1).
- Don't feed `TimeTabConfiguration`'s own `onChange` output back into its `value`
  prop — it resets the SDK's internal panel state and closes the "Add Shift" /
  "Add Duration" form mid-edit. Ref only; `value` changes on entity re-init (§12.5).
- Don't persist the raw SDK Time tab value as `timeConfig` — the host needs the
  `HostTimeConfig` shape (`type`, `pickerType`, `startTime: null`, …) or it can't
  compute the query window (§12.3).
