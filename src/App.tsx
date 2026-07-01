// Dev harness — mirrors the prod Lens layout with a thin local replacement:
//   1. Read ?token=xxx from URL → validateSSOToken → store Bearer JWT in localStorage
//   2. On configurator onChange → resolve(envelope) → pass { config, data } to widget
//   3. On TIME_CHANGE → set time window override, re-resolve

import { useCallback, useEffect, useState } from 'react';
import { LineChart } from './components/LineChart/LineChart';
import { LineChartConfiguration } from './components/LineChartConfiguration/LineChartConfiguration';
import { resolve } from './iosense-sdk/mini-engine';
import { validateSSOToken } from './iosense-sdk/api';
import type {
  LineChartEnvelope,
  DataEntry,
  HostTimeConfig,
  WidgetEvent,
} from './iosense-sdk/types';
import '@faclon-labs/design-sdk/styles.css';
import './App.css';

const TOKEN_STORAGE_KEY = 'iosense_bearer_token';
const ENVELOPE_STORAGE_KEY = 'iosense_lc_envelope';

interface AuthState {
  status: 'pending' | 'authenticated' | 'unauthenticated' | 'error';
  token?: string;
  error?: string;
}

export default function App() {
  const [auth, setAuth] = useState<AuthState>({ status: 'pending' });
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
  }>();

  // Auth bootstrap — runs once.
  useEffect(() => {
    const url = new URL(window.location.href);
    const ssoToken = url.searchParams.get('token');
    const stored = localStorage.getItem(TOKEN_STORAGE_KEY);

    if (stored) {
      setAuth({ status: 'authenticated', token: stored });
      return;
    }
    if (!ssoToken) {
      setAuth({ status: 'unauthenticated' });
      return;
    }

    void (async () => {
      try {
        const token = await validateSSOToken(ssoToken);
        localStorage.setItem(TOKEN_STORAGE_KEY, token);
        url.searchParams.delete('token');
        window.history.replaceState({}, '', url.toString());
        setAuth({ status: 'authenticated', token });
      } catch (err) {
        setAuth({
          status: 'error',
          error: err instanceof Error ? err.message : 'SSO validation failed',
        });
      }
    })();
  }, []);

  // Re-resolve whenever envelope, override, or auth changes.
  const runResolve = useCallback(
    async (env: LineChartEnvelope, ovr: typeof override, token: string | undefined) => {
      if (!token) {
        setResolvedData([]);
        return;
      }
      const result = await resolve(env, {
        authentication: token,
        override: ovr,
        periodicity: ovr?.periodicity,
      });
      setResolvedData(result.data);
    },
    [],
  );

  useEffect(() => {
    if (auth.status !== 'authenticated' || !envelope) return;
    void runResolve(envelope, override, auth.token);
  }, [auth.status, auth.token, envelope, override, runResolve]);

  const handleEnvelopeChange = useCallback((next: LineChartEnvelope) => {
    setEnvelope(next);
    try {
      localStorage.setItem(ENVELOPE_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Ignore quota errors in storage-constrained environments.
    }
  }, []);

  const handleWidgetEvent = useCallback(
    (event: WidgetEvent) => {
      if (event.type === 'TIME_CHANGE') {
        setOverride({
          startTime: Number(event.payload.startTime),
          endTime: Number(event.payload.endTime),
          periodicity: event.payload.periodicity,
        });
      }
    },
    [],
  );

  const tokenSummary = auth.token ? auth.token.slice(0, 18) + '…' : '—';

  return (
    <div className="app">
      <header className="dev-harness__topbar">
        <h1 className="dev-harness__brand HeadingSmallSemibold">LineChart — dev harness</h1>
        <div className="dev-harness__topbar-meta BodyXSmallRegular">
          <span>Auth: {auth.status}</span>
          <span>Token: {tokenSummary}</span>
          {auth.status === 'authenticated' && (
            <button
              type="button"
              onClick={() => {
                localStorage.removeItem(TOKEN_STORAGE_KEY);
                setAuth({ status: 'unauthenticated' });
              }}
              style={{ background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer' }}
            >
              Sign out
            </button>
          )}
        </div>
      </header>

      {auth.status === 'pending' && (
        <div className="dev-harness__auth">
          <p className="BodyMediumRegular">Validating SSO token…</p>
        </div>
      )}

      {auth.status === 'unauthenticated' && (
        <div className="dev-harness__auth">
          <div className="dev-harness__auth-card">
            <h2 className="HeadingMediumSemibold">Authenticate to load real IOsense data</h2>
            <p className="BodyMediumRegular">
              Generate an SSO token from your IOsense profile, then open this preview as
              <code> ?token=YOUR_TOKEN</code>. The token is exchanged for a Bearer JWT and stored
              in <code>localStorage</code>; a refresh keeps you signed in.
            </p>
            <p className="BodyXSmallRegular dev-harness__error">
              SSO tokens are one-shot and expire after 60s — generate a fresh one if validation fails.
            </p>
          </div>
        </div>
      )}

      {auth.status === 'error' && (
        <div className="dev-harness__auth">
          <div className="dev-harness__auth-card">
            <h2 className="HeadingMediumSemibold dev-harness__error">Auth failed</h2>
            <p className="BodyMediumRegular">{auth.error}</p>
            <p className="BodyXSmallRegular">
              Mint a fresh SSO token from your IOsense profile and reload the page with
              <code> ?token=NEW_TOKEN</code>.
            </p>
          </div>
        </div>
      )}

      {auth.status === 'authenticated' && (
        <div className="app__body">
          <section className="app__config">
            <LineChartConfiguration
              config={envelope}
              authentication={auth.token}
              onChange={handleEnvelopeChange}
            />
          </section>
          <section className="app__widget">
            <div className="app__widget-frame">
              <LineChart
                config={envelope?.uiConfig}
                data={resolvedData}
                timeConfig={envelope?.timeConfig as HostTimeConfig | undefined}
                onEvent={handleWidgetEvent}
                authentication={auth.token}
              />
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
