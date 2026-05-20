import { useState, useEffect, useRef, useMemo } from 'react';
import { fetchUNSNodes } from './api';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type UNSTree = { [key: string]: UNSTree | null };

export interface UseUNSTreeResult {
  /** Pass to UNSPathInput `tree` prop. */
  unsTree: UNSTree;
  /** Pass to UNSPathInput `isLoading` prop. */
  isLoadingTree: boolean;
  /** Call from UNSPathInput `onOpen`. Fetches workspace list once; subsequent calls are no-ops. */
  loadWorkspaces: () => Promise<void>;
  /**
   * Call inside every UNSPathInput `onChange`.
   * Transforms {{WorkspaceName/nodeName}} → {{uns:wsId://nodePath}}.
   * Returns rawValue unchanged for static strings or direct {{topic}} paste.
   */
  resolveUNSValue: (rawValue: string) => string;
}

// ---------------------------------------------------------------------------
// Module-level singleton cache — shared across ALL hook instances on the page.
// Workspaces fetched once even when 10 widgets mount simultaneously.
// Node data fetched by Widget A is instantly available to Widget B.
// ---------------------------------------------------------------------------

const _cache: {
  workspaces: Record<string, string> | null;
  nodes: Record<string, UNSTree>;
  fetchedWs: Set<string>;
  meta: Map<string, { wsId: string; nodePath: string }>;
  listeners: Set<() => void>;
} = {
  workspaces: null,
  nodes: {},
  fetchedWs: new Set(),
  meta: new Map(),
  listeners: new Set(),
};

function _notifyAll() {
  _cache.listeners.forEach((fn) => fn());
}

// ---------------------------------------------------------------------------
// useUNSTree
// ---------------------------------------------------------------------------

export function useUNSTree(authentication?: string): UseUNSTreeResult {
  const [tick, setTick] = useState(0);
  const [isLoadingTree, setIsLoadingTree] = useState(false);

  const authRef = useRef(authentication);
  useEffect(() => { authRef.current = authentication; }, [authentication]);

  // Subscribe this instance to cache updates; unsubscribe on unmount.
  useEffect(() => {
    const notify = () => setTick((v) => v + 1);
    _cache.listeners.add(notify);
    return () => { _cache.listeners.delete(notify); };
  }, []);

  // Rebuild the proxy whenever cache changes (tick increments on every _notifyAll call).
  const unsTree = useMemo((): UNSTree => {
    if (!_cache.workspaces || Object.keys(_cache.workspaces).length === 0) return {};

    const workspaceMap = _cache.workspaces;

    return new Proxy({} as UNSTree, {
      get(_, wsName: string) {
        if (typeof wsName !== 'string' || !(wsName in workspaceMap)) return undefined;
        const wsId = workspaceMap[wsName];

        // Child proxy: ownKeys fires ONLY when UNSPathInput enumerates a workspace's
        // children (user navigated into it). No onFolderSelect / no node_modules patch needed.
        return new Proxy({} as UNSTree, {
          ownKeys() {
            if (!_cache.fetchedWs.has(wsName) && authRef.current) {
              _cache.fetchedWs.add(wsName);
              console.log(`[UNS] fetching nodes for workspace: ${wsName} (${wsId})`);
              fetchUNSNodes(authRef.current, `uns:${wsId}`, 'Operational', 100, true)
                .then((nodes) => {
                  // Separate operational nodes (Tag) from virtual properties
                  const tags: Array<{ name: string; path: string }> = [];
                  const virtualProps: Array<{ name: string; path: string }> = [];
                  for (const node of nodes) {
                    if (!node.name) continue;
                    const nodePath = node.path ?? node.name;
                    if (node.type === 'virtualProperty') {
                      virtualProps.push({ name: node.name, path: nodePath });
                    } else {
                      tags.push({ name: node.name, path: nodePath });
                    }
                  }

                  // Build tree: Tag → folder of virtual property leaves keyed by suffix (:last, :avg…)
                  // Virtual properties share the same name as their Tag — only path differs.
                  // Use the colon-suffix from path as the unique display key.
                  const children: UNSTree = {};
                  for (const tag of tags) {
                    const matching = virtualProps.filter(vp => vp.path.startsWith(`${tag.path}:`));
                    if (matching.length > 0) {
                      const vpChildren: UNSTree = {};
                      for (const vp of matching) {
                        const suffix = vp.path.substring(vp.path.lastIndexOf(':'));  // e.g. ":last"
                        vpChildren[suffix] = null;
                        _cache.meta.set(`${wsName}/${tag.name}/${suffix}`, { wsId, nodePath: vp.path });
                      }
                      children[tag.name] = vpChildren;
                    } else {
                      // No virtual properties — show tag as leaf
                      children[tag.name] = null;
                      _cache.meta.set(`${wsName}/${tag.name}`, { wsId, nodePath: tag.path });
                    }
                  }
                  console.log(`[UNS] ${wsName}: ${nodes.length} nodes loaded`);
                  _cache.nodes[wsName] = children;
                  _notifyAll();
                })
                .catch(() => _cache.fetchedWs.delete(wsName));
            }
            return Object.keys(_cache.nodes[wsName] ?? {});
          },
          get(__, key: string) {
            if (typeof key !== 'string') return undefined;
            return (_cache.nodes[wsName] ?? {})[key];
          },
          has(__, key: string) {
            return key in (_cache.nodes[wsName] ?? {});
          },
          getOwnPropertyDescriptor(__, key: string) {
            const ch = _cache.nodes[wsName] ?? {};
            if (key in ch) return { configurable: true, enumerable: true, value: ch[key] };
            return undefined;
          },
        });
      },
      has(_, key: string) { return key in workspaceMap; },
      ownKeys() { return Object.keys(workspaceMap); },
      getOwnPropertyDescriptor(_, key: string) {
        if (key in workspaceMap) return { configurable: true, enumerable: true, value: {} };
        return undefined;
      },
    });
  }, [tick]);

  async function loadWorkspaces() {
    // _cache.workspaces === null means not yet fetched; {} means fetched but empty — both are valid.
    if (!authentication || _cache.workspaces !== null) return;
    setIsLoadingTree(true);
    try {
      const nodes = await fetchUNSNodes(authentication, 'uns:_workspaces');
      const wsMap: Record<string, string> = {};
      for (const n of nodes) {
        if (n.type === 'Workspace' && n.name) wsMap[n.name] = n.id;
      }
      console.log('[UNS] workspaces loaded:', Object.keys(wsMap));
      _cache.workspaces = wsMap;
      _notifyAll();
    } catch (err) {
      console.error('[UNS] workspace fetch failed:', err);
    } finally {
      setIsLoadingTree(false);
    }
  }

  function resolveUNSValue(rawValue: string): string {
    if (rawValue.startsWith('{{') && rawValue.endsWith('}}')) {
      const meta = _cache.meta.get(rawValue.slice(2, -2));
      if (meta) return `{{uns:${meta.wsId}://${meta.nodePath}}}`;
    }
    return rawValue;
  }

  return { unsTree, isLoadingTree, loadWorkspaces, resolveUNSValue };
}
