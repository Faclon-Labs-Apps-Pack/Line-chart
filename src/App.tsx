import { useState, useEffect } from 'react';
import { LineChart } from './components/LineChart/LineChart';
import { LineChartConfiguration } from './components/LineChartConfiguration/LineChartConfiguration';
import { LineChartEnvelope, DataEntry, WidgetEvent } from './iosense-sdk/types';
import { validateSSOToken } from './iosense-sdk/api';
import { resolve } from './iosense-sdk/mini-engine';
import '@faclon-labs/design-sdk/styles.css';
import './App.css';

export default function App() {
  const [envelope, setEnvelope] = useState<LineChartEnvelope | undefined>(undefined);
  const [data, setData] = useState<DataEntry[]>([]);
  const [auth, setAuth] = useState<string>(localStorage.getItem('bearer_token') ?? '');
  const [timeOverride, setTimeOverride] = useState<{ startTime: number; endTime: number } | undefined>(undefined);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ssoToken = params.get('token');
    if (ssoToken && !auth) {
      validateSSOToken(ssoToken)
        .then((jwt) => {
          if (jwt) {
            localStorage.setItem('bearer_token', jwt);
            setAuth(jwt);
            const url = new URL(window.location.href);
            url.searchParams.delete('token');
            window.history.replaceState({}, '', url.toString());
          }
        })
        .catch(console.error);
    }
  }, []);

  useEffect(() => {
    if (!envelope || !auth) return;
    console.log('[App] resolving envelope:', envelope.dynamicBindingPathList, 'override:', timeOverride);
    resolve(envelope, { authentication: auth, override: timeOverride }).then(({ data: resolved }) => {
      console.log('[App] resolved data:', resolved);
      setData(resolved);
    });
  }, [envelope, auth, timeOverride]);

  function handleEvent(event: WidgetEvent) {
    console.log('[Widget Event]', event);
    if (event.type === 'TIME_CHANGE') {
      setTimeOverride({
        startTime: Number(event.payload.startTime),
        endTime: Number(event.payload.endTime),
      });
    }
  }

  // Compute the widget's preview size from styling.size (Custom uses
  // customWidth/customHeight; presets use fixed dimensions). Capped to 100%
  // so the preview never exceeds its container.
  const sizing = (() => {
    const s = envelope?.uiConfig?.style;
    if (!s || typeof s !== 'object' || !('size' in s)) return undefined;
    const size = (s as { size?: { preset?: string; customWidth?: number; customHeight?: number } }).size;
    if (!size) return undefined;
    const presetDims: Record<string, { w?: number; h?: number }> = {
      Small: { w: 580, h: 400 },
      Medium: { w: 880, h: 400 },
      Large: { w: 1780, h: 400 },
    };
    const dims =
      size.preset === 'Custom'
        ? { w: size.customWidth, h: size.customHeight }
        : presetDims[size.preset ?? 'Medium'] ?? presetDims.Medium;
    return {
      width: typeof dims.w === 'number' ? `${dims.w}px` : undefined,
      height: typeof dims.h === 'number' ? `${dims.h}px` : undefined,
      maxWidth: '100%',
      maxHeight: '100%',
    };
  })();

  return (
    <div className="app">
      <div className="app__config">
        <LineChartConfiguration config={envelope} authentication={auth} onChange={setEnvelope} />
      </div>
      <div className="app__widget">
        {envelope ? (
          <div className="app__widget-frame" style={sizing}>
            <LineChart config={envelope.uiConfig} data={data} onEvent={handleEvent} />
          </div>
        ) : (
          <div className="app__empty">
            <p className="BodyMediumRegular">Configure the widget in the left panel to preview it here.</p>
          </div>
        )}
      </div>
    </div>
  );
}
