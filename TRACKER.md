# Orchestrator Tracker

## Active Task
Multi-chart architecture refactor — Chart Settings module 4-state spec — started 2026-05-14

## Decisions (current task)
- 2026-05-14 — User chose Scope B: full multi-chart architecture. `LineChartUIConfig.charts: ChartInstance[]` with `activeChartId` selector. Every CRUD section (Data Source, Axis, Plotline, Plotband, SPC, Anomaly) re-scopes to active chart. Widget renders active chart only. Data Table + Style + Time stay widget-level. Chart Settings module gets full 4-state machine (Empty / Display / Edit / Multi-chart-dropdown) + Delete confirmation modal.

## Agent 1 Log (Builder) — current task
- 2026-05-14 — Dispatch 6 DONE: multi-chart architecture refactor. Both gates pass. Builder agentId a13706902ad56b0d3. types.ts (326 LoC), LineChartConfiguration.tsx (3636 LoC), LineChartConfiguration.css (537 LoC), LineChart.tsx (1083 LoC). Envelope shape: ChartInstance with own series/axes/plotlines/plotbands/spcs/anomalies; LineChartUIConfig.charts[] + activeChartId; dataTable + style + timeConfig remain widget-level. Migration: `normalizeLineChartUIConfig` wraps Phase-0 single-chart envelopes into `charts: [chartInstance]`. dynamicBindingPathList path keys now have `charts[N].` prefix (auto-derived by recursive walker). Chart Settings 4 states wired (Empty/Display/Edit/Multi-dropdown), Delete Chart modal added, section disabling enforced (`!hasChart || inEditMode`). +Add Chart footer hidden when `!hasChart`, disabled during edit. New-chart sub-state mirrors Edit but creates instead of updates. Widget renderer routes to active chart only via `pickActiveChart` + `findSeriesAcrossCharts` helpers. IconButton negative color faked via CSS override (.lc-config__chart-settings-trash) since design-sdk@0.5.6 IconButton has no `color` prop. SelectInput required `*` appended to label string (no `necessityIndicator` prop).
- 2026-05-14 — Known UX nit from builder summary: New-chart sub-state renders a Trash2 icon in its header as a "cancel-out" button (builder's choice, dispatch didn't specify icon for that sub-state). Surface to user — should probably be X close or no icon at all, since there's nothing to delete in a draft.

---

# Previous task archive — Line Chart initial build

## Status
**COMPLETE 2026-05-11** — all 4 dispatches DONE, all 11 Figma sections built, both verification gates pass.

## Status: ready for user testing
- `cd IOLENS_WIDGET && npm start` then visit `http://localhost:3000/?token=<SSO_TOKEN>` for first auth.
- All Figma sections implemented: Chart Settings, Data Source, Statistical Process Control, Anomaly Highlighting, Axis, Plot Line, Plot Band, Data Table, Time tab, Style tab. Widget header has Info/Settings/Hamburger icons with view-mode toggle.
- Known gaps: edit flows are delete+re-add for all CRUD sections, Plotline Periodicity-Dependent type stores config but doesn't render, ColorPicker is hex-text-only (no popover modal), Export-CSV menu item is disabled placeholder, settings icon visual-only.

## Decisions
- 2026-05-11 — Charting library: Highcharts (+ highcharts-react-official) — IIoT standard. Why: rich time-series, zoom, tooltips out of box.
- 2026-05-11 — Multi-series support — series[] in uiConfig; each binds via series[i].dataSource.
- 2026-05-11 — Bindable pattern: plain `{{topic}}` text input per Bindable.md (NOT Figma's device picker). Why: user explicitly chose simpler path. How to apply: TextInput per series with placeholder `e.g. {{iosense/.../historical}}`. Builder picks topic operator.
- 2026-05-11 — Layout: 2-column config panel matching Figma (Tabs at top, section nav on left, detail panel on right) — explicit override of Bindable.md §6 flat default. Why: user chose "as per Figma".
- 2026-05-11 — Sequencing: Phase 0 first (scaffold + shell + Data Source v1), user review, then Phase 1–5 per section.
- 2026-05-11 — Full scope: 11 Figma sections will be built across phases (not MVP-reduced).
- 2026-05-11 — Windows note: init-widget.sh uses BSD `sed -i ''` — won't run on Windows. Builder does rename via Bash file ops + Edit tool instead.
- 2026-05-11 — MCP/source-file conflict: get_frontend(widget,setup) references `envelope.apiConfig[]` + `envelope.data[chartId]` — STALE. Builder follows 4 source-of-truth files (envelope.uiConfig + dynamicBindingPathList + DataEntry[]). Anti-drift rule enforced.

## Agent 1 Log (Builder)
- 2026-05-11 — Phase 0 dispatched: scaffold + 2-column config shell + Data Source v1 — DONE. Both gates passed (tsc --noEmit clean, build:bundle produces both required bundle files). Builder agentId: afeb236e771c141f7 (preserve for Phase 1 continuity if useful).
- 2026-05-11 — Files written/modified (14): package.json, webpack.config.js, public/index.html, src/iosense-sdk/{types,api,mini-engine}.ts, src/components/LineChart/{LineChart.tsx,LineChart.css,index.ts}, src/components/LineChartConfiguration/{LineChartConfiguration.tsx,LineChartConfiguration.css,index.ts}, src/App.tsx, src/App.css. Total ~1310 LoC.
- 2026-05-11 — Verified deviations (all spec-compatible drift from MCP doc vs installed @faclon-labs/design-sdk@0.5.6): Highcharts pinned to ^12 (peer dep), Tabs uses controlled `value`+`onChange` (not `isSelected` per TabItem), IconButton has `emphasis`/`isHighlighted`/`accessibilityLabel` (no `variant`/`color`), Button uses 'Gray' not 'Tertiary'. Builder adapted by reading node_modules typings — anti-drift rule applied correctly.
- 2026-05-11 — Extra: added `{ test: /\.m?js$/, resolve: { fullySpecified: false } }` rule to webpack.config.js to fix design-sdk's strict-ESM deep imports into @table-library/react-table-library (without it, prod bundle failed with 4 module-resolution errors). Justified.
- 2026-05-11 — Dispatch 1 DONE: Chart Settings dedicated panel + Axis (multi-axis with Left/Right + linked series) + Plotline (Indep/Dep, Fixed/Dynamic, Duration, Style) + Plotband sections + widget rendering for plotLines/plotBands/multi-yAxis. Both gates pass. Builder agentId a34e79a93f4ca432d. Files: types.ts (89), LineChartConfiguration.tsx (~870), LineChart.tsx (~240), LineChartConfiguration.css (~290). Renamed `LineChartAxis` (Phase 0 default-only) → `LineChartDefaultAxis`; new `LineChartAxis` is a CRUD entity with `_id, name, position, linkedSeriesIds`. SelectInput pattern: controlled `isOpen` + `onClick` toggle + children = DropdownMenu w/ ActionListItem. Edit flow is delete+re-add for now.
- 2026-05-11 — Dispatch 2 DONE: Statistical Process Control + Anomaly Highlighting sections + widget overlays. Both gates pass. Builder agentId a9d7338bacc7968b3. types.ts (170 LoC), LineChart.tsx (631 LoC), LineChartConfiguration.tsx (2320 LoC), LineChartConfiguration.css (451 LoC). SPC computes Avg/Median/StdDev (1–6 sigma) as plotLines on the source series's axis. Anomaly = scatter overlay series (showInLegend:false). MultiSelect uses SelectInput+DropdownMenu+ActionListItem selectionType="Multiple" (no top-level MultiSelectInput export). Sigma checkboxes are 6 standalone Checkbox in 2-col grid (CheckboxGroup doesn't expose array onChange).
- 2026-05-11 — Dispatch 3 DONE: Time tab (mounted official `TimeTabConfiguration` from design-sdk) + Data Table section + widget table view mode. Both gates pass. Builder agentId aa9aa64db3aa2e398. types.ts (225 LoC), mini-engine.ts (115 LoC), LineChartConfiguration.tsx (~2750 LoC), LineChartConfiguration.css (~500 LoC), LineChart.tsx (~830 LoC). **Correction to my D3 dispatch prompt: `TimeTabConfiguration` IS exported from @faclon-labs/design-sdk@0.5.6** (my earlier grep was wrong — searched for `TimeConfiguration` which is the Envelope.md shorthand, not the actual export name `TimeTabConfiguration`). Builder followed Envelope.md correctly and used the official component. Mini-engine computeWindow rewritten for canonical TimeTabUIConfig shape (fixedStart/End + calendarType + x+xPeriod). Data Table aggregates time-series per column using operator (sum/avg/min/max/median/first/last). Widget routes to table view when `dataTable.enabled === true`.
- 2026-05-11 — Dispatch 4 DONE (final): Styling tab + widget header polish + final verification. Both gates pass (x2). Builder agentId a0de9a6fde3f70f05. types.ts (315 LoC), LineChartConfiguration.tsx (3317 LoC), LineChartConfiguration.css (571 LoC), LineChart.tsx (1050 LoC), LineChart.css (211 LoC), App.tsx (96 LoC), App.css (54 LoC). LineChartUIConfig.style replaced with full LineChartStyling shape (size/card/hideElements/advancedEnabled/chartTitle/xAxisLabel/yAxisLabel/dataTable/misc). `normalizeStyling()` migrates Phase-0 style.bg → card.backgroundColor. Widget header has Info popover (only when chartDescription set) + Settings icon (hideable, visual-only) + Hamburger DropdownMenu (Show Chart/Show Data Table toggle + disabled Export-CSV). View mode is local widget state initialized from dataTable.enabled. Inline-style card wrapper (bg/border/radius from user config). All Highcharts colors propagate from styling (gridLine, xAxis/yAxis labels+lines, legend). App.tsx wraps widget in sized frame (preset 580/880/1780×400 or custom W×H) for dev preview only.

## Final Totals
- 9 files in source tree, ~5,800 LoC total (TypeScript + CSS, excludes config files)
- All 4 webpack bundle artifacts present in `dist-bundle/` (LineChart.bundle.{js,css}, LineChartConfiguration.bundle.{js,css})
- 17 documented deviations from MCP docs (all justified by node_modules/@faclon-labs/design-sdk@0.5.6 typings — anti-drift rule consistently applied)
- Known limitations: Plotline Periodicity-Dependent rendering skipped, ColorPicker is hex-text-only, Export-CSV is placeholder, Settings icon visual-only, ExportIcon hideElements flag has no rendered icon to hide, App.tsx sizing is dev-preview-only

- 2026-05-14 — Dispatch 5 DONE (post-launch refactor): Two-column sliding sidebar to match Figma. Both gates pass. Builder agentId a649bda080f6b9049. LineChartConfiguration.tsx (3483 LoC, +166), LineChartConfiguration.css (456 LoC, -115 obsolete styles), App.css (61 LoC). **Column 1** (240px, sticky header/Tabs/footer): accordion section list — Chart Settings always inline-expanded; other Data-tab sections collapsible with `+` and chevron; expanded sections show item cards w/ click-to-edit + X-delete. **Column 2** (300px, slide-in 200ms): sticky header `Add/Edit X` + scrollable form body + sticky footer Primary CTA (`Add X` / `Save Changes`). **Real Edit flow** replaces delete+re-add for every CRUD section — each form is now a reusable `*Editor` keyed by `itemId|'new'` with `useEditorBinding(isValid, submit)` hook wiring the sticky footer. Cascade deletes preserved; Col 2 auto-closes (with console.warn) if actively-edited item is removed by cascade. No envelope/types/mini-engine changes — pure UI refactor.

## Agent 2 Log (Figma Fetch)
- 2026-05-11 — orchestrator fetched figma metadata for node 4:3 — 11 config sections discovered (see below)

## Figma Section Node IDs (fileKey SnjwBzO1HAaSyMWCH6KhWa)
- Widget Preview         — 301:15399
- Data Source            — 181:21515
- Statistical Process Control — 181:24877
- Anomaly Highlighting   — 181:27367
- Axis                   — 181:29421
- Plotline               — 181:31896
- Plotband               — 181:35669
- Data Table             — 181:38610
- Time                   — 321:22879
- Styling                — 181:46550
- (Chart Settings + SIDEBAR POSITION row — top-level shell, node TBD)

## Open Questions
- 2026-05-11 — Figma spec contains 11 config sections; MVP scope needs user decision — waiting on: user
