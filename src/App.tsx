// Dev harness — mirrors the prod Lens layout with a thin local replacement.
// No SSO gate: the configurator + widget render immediately. A Bearer token is
// read directly (no SSO exchange) and passed through so real data can flow when
// one is present:
//   1. ?token=xxx in the URL → used verbatim as the Bearer JWT, persisted, and
//      stripped from the address bar
//   2. otherwise a previously stored token in localStorage
//   3. otherwise empty — the widget still renders; data fetches simply 401
// On configurator onChange → resolve(envelope) → pass { config, data } to widget.
// On TIME_CHANGE → set time window override, re-resolve.

import { useCallback, useEffect, useRef, useState } from 'react';
import { LineChart } from './components/LineChart/LineChart';
import { LineChartConfiguration } from './components/LineChartConfiguration/LineChartConfiguration';
import { resolve } from './iosense-sdk/mini-engine';
import type {
  LineChartEnvelope,
  DataEntry,
  HostTimeConfig,
  ShiftWindow,
  WidgetEvent,
} from './iosense-sdk/types';
import './App.css';

const TOKEN_STORAGE_KEY = 'iosense_bearer_token';
const ENVELOPE_STORAGE_KEY = 'iosense_lc_envelope';

function readInitialToken(): string {
  try {
    const url = new URL(window.location.href);
    const urlToken = url.searchParams.get('token');
    if (urlToken) {
      localStorage.setItem(TOKEN_STORAGE_KEY, urlToken);
      url.searchParams.delete('token');
      window.history.replaceState({}, '', url.toString());
      return urlToken;
    }
    return localStorage.getItem(TOKEN_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

export default function App() {
  const [token, setToken] = useState<string>(readInitialToken);
  const [envelope, setEnvelope] = useState<LineChartEnvelope | undefined>(() => {
    try {
      const stored = localStorage.getItem(ENVELOPE_STORAGE_KEY);
      return stored ? (JSON.parse(stored) as LineChartEnvelope) : undefined;
    } catch {
      return undefined;
    }
  });
  const [resolvedData, setResolvedData] = useState<DataEntry[]>([]);
  const [override, setOverride] = useState<{
    startTime: number;
    endTime: number;
    periodicity?: string;
    comparisonStartTime?: number;
    comparisonEndTime?: number;
    shifts?: ShiftWindow[];
    shiftAggregator?: string;
  }>();

  // Monotonic id per resolve dispatch. resolveAndCompute calls are async and can
  // land out of order — e.g. the initial no-shift resolve (override=undefined)
  // racing the shift resolve fired by the widget's mount TIME_CHANGE. Only the
  // latest dispatched resolve may write state, so a slow earlier response can't
  // clobber a newer one (which would flip the now data-driven chart mode).
  const resolveSeqRef = useRef(0);

  // Re-resolve whenever envelope, override, or token changes.
  const runResolve = useCallback(
    async (env: LineChartEnvelope, ovr: typeof override, tok: string) => {
      const seq = ++resolveSeqRef.current;
      try {
        const result = await resolve(env, {
          authentication: tok,
          override: ovr,
          periodicity: ovr?.periodicity,
          comparison:
            ovr?.comparisonStartTime != null && ovr?.comparisonEndTime != null
              ? { startTime: ovr.comparisonStartTime, endTime: ovr.comparisonEndTime }
              : undefined,
          shifts: ovr?.shifts,
          shiftAggregator: ovr?.shiftAggregator,
        });
        // When the resolve errored out and returned no data, keep the previous
        // resolvedData so widgets that have already rendered (e.g. with anomaly
        // highlighting) don't lose their visual state. A common trigger: a newly
        // added data-table column whose topic binding hasn't resolved yet causes
        // resolveAndCompute to fail for ALL bindings, wiping the series data and
        // making anomaly overlays disappear.
        // Drop stale responses: a newer resolve was dispatched after this one.
        if (seq !== resolveSeqRef.current) return;
        if (result.error && result.data.length === 0) {
          console.warn('[dev-harness] resolve returned error — keeping previous data:', result.error);
          return;
        }
        setResolvedData(result.data);
      } catch (err) {
        // Without a valid token the API 401s — keep the widget rendered with no
        // data rather than crashing the harness.
        console.warn('[dev-harness] resolve failed:', err);
      }
    },
    [],
  );

  useEffect(() => {
    if (!envelope) return;
    void runResolve(envelope, override, token);
  }, [envelope, override, token, runResolve]);

  const handleEnvelopeChange = useCallback((next: LineChartEnvelope) => {
    setEnvelope(next);
    try {
      localStorage.setItem(ENVELOPE_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Ignore quota errors in storage-constrained environments.
    }
  }, []);

  const handleWidgetEvent = useCallback((event: WidgetEvent) => {
    if (event.type === 'TIME_CHANGE') {
      // Surface the exact payload the widget emits through the onEvent prop on
      // every TIME_CHANGE — mount, DatePicker change, comparison/shift toggle.
      console.log('[DevHarness] widget event via onEvent → TIME_CHANGE', {
        startTime: event.payload.startTime,
        endTime: event.payload.endTime,
        periodicity: event.payload.periodicity,
        comparisonStartTime: event.payload.comparisonStartTime,
        comparisonEndTime: event.payload.comparisonEndTime,
        shifts: event.payload.shifts,
        shiftAggregator: event.payload.shiftAggregator,
      });
      const { comparisonStartTime, comparisonEndTime, shifts, shiftAggregator } = event.payload;
      setOverride({
        startTime: Number(event.payload.startTime),
        endTime: Number(event.payload.endTime),
        periodicity: event.payload.periodicity,
        comparisonStartTime: comparisonStartTime != null ? Number(comparisonStartTime) : undefined,
        comparisonEndTime: comparisonEndTime != null ? Number(comparisonEndTime) : undefined,
        shifts,
        shiftAggregator,
      });
    }
  }, []);

  const tokenSummary = token ? token.slice(0, 18) + '…' : 'none';

  return (
    <div className="app">
      <header className="dev-harness__topbar">
        <h1 className="dev-harness__brand HeadingSmallSemibold">LineChart — dev harness</h1>
        <div className="dev-harness__topbar-meta BodyXSmallRegular">
          <span>Token: {tokenSummary}</span>
          {token && (
            <button
              type="button"
              onClick={() => {
                localStorage.removeItem(TOKEN_STORAGE_KEY);
                setToken('');
              }}
              style={{ background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer' }}
            >
              Clear token
            </button>
          )}
        </div>
      </header>

      <div className="app__body">
        <section className="app__config">
          <LineChartConfiguration
            config={envelope}
            authentication={token}
            onChange={handleEnvelopeChange}
          />
        </section>
        <section className="app__widget">
          <div className="app__widget-frame">
            <LineChart
              config={envelope?.uiConfig}
              data={resolvedData}
              timeConfig={envelope?.timeConfig as HostTimeConfig | undefined}
              timeTabConfig={envelope?.timeTabConfig}
              onEvent={handleWidgetEvent}
              authentication={token}
            />
          </div>
        </section>
      </div>
    </div>
  );
}
