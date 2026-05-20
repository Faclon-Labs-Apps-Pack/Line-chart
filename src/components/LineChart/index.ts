import { createRoot, Root } from 'react-dom/client';
import React from 'react';
import { LineChart } from './LineChart';
import '@faclon-labs/design-sdk/styles.css';

const roots = new Map<string, Root>();

function mount(containerId: string, props: any) {
  const container = document.getElementById(containerId);
  if (!container) return;

  container.setAttribute('data-zone-ignore', '');

  if (roots.has(containerId)) {
    roots.get(containerId)!.unmount();
    roots.delete(containerId);
  }

  const root = createRoot(container);
  roots.set(containerId, root);
  root.render(React.createElement(LineChart, props));
}

function update(containerId: string, props: any) {
  const root = roots.get(containerId);
  if (!root) return;
  root.render(React.createElement(LineChart, props));
}

function unmount(containerId: string) {
  const root = roots.get(containerId);
  if (!root) return;
  root.unmount();
  roots.delete(containerId);
}

(window as any).ReactWidgets = (window as any).ReactWidgets ?? {};
(window as any).ReactWidgets['LineChart'] = { mount, update, unmount };
