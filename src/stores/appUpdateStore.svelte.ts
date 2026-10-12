import { createStore } from '#src/lib/state/store.svelte.ts';
import {
  type AppBuildInfo,
  CURRENT_APP_BUILD_INFO,
  canReachAppServer,
  canRegisterAppShellServiceWorker,
  clearAppShellCaches,
  type ForceRefreshResult,
  fetchServerBuildInfo,
  hasDifferentBundle,
  isAppShellRuntimeEnabled,
  registerAppShellServiceWorker,
  unregisterAppShellServiceWorkers,
} from '#src/services/appShellService.ts';

const UPDATE_CHECK_THROTTLE_MS = 30_000;

export const useAppUpdateStore = createStore('appUpdateStore', () => {
  let currentBuildInfo = $state<AppBuildInfo>(CURRENT_APP_BUILD_INFO);
  let serverBuildInfo = $state<AppBuildInfo | null>(null);
  let isCheckingForUpdate = $state(false);
  let isForceRefreshing = $state(false);
  let lastCheckedAt = $state<string | null>(null);
  let lastCheckFailed = $state(false);
  let runtimeStarted = $state(false);
  let lastCheckStartedAt = 0;

  let isAppShellEnabled = $derived.by(() => isAppShellRuntimeEnabled());
  let canUseServiceWorker = $derived.by(() => canRegisterAppShellServiceWorker());
  let hasUpdateAvailable = $derived.by(() =>
    hasDifferentBundle(currentBuildInfo, serverBuildInfo),
  );

  async function startRuntime(): Promise<void> {
    if (runtimeStarted) {
      return;
    }

    runtimeStarted = true;
    document.addEventListener('visibilitychange', handleVisibilityChange);

    if (canUseServiceWorker) {
      await registerAppShellServiceWorker().catch((error) => {
        console.warn('Failed to register the app shell service worker.', error);
      });
    }

    await checkForUpdate({ force: true });
  }

  function stopRuntime(): void {
    if (!runtimeStarted) {
      return;
    }

    runtimeStarted = false;
    document.removeEventListener('visibilitychange', handleVisibilityChange);
  }

  function handleVisibilityChange(): void {
    if (document.visibilityState !== 'visible') {
      return;
    }

    void checkForUpdate();
  }

  async function checkForUpdate(
    options: { force?: boolean } = {},
  ): Promise<AppBuildInfo | null> {
    if (!isAppShellEnabled) {
      return null;
    }

    const now = Date.now();
    if (!options.force && now - lastCheckStartedAt < UPDATE_CHECK_THROTTLE_MS) {
      return serverBuildInfo;
    }

    lastCheckStartedAt = now;
    isCheckingForUpdate = true;

    try {
      const nextBuildInfo = await fetchServerBuildInfo();
      if (nextBuildInfo) {
        serverBuildInfo = nextBuildInfo;
      }
      lastCheckedAt = new Date().toISOString();
      lastCheckFailed = nextBuildInfo === null;
      return nextBuildInfo;
    } finally {
      isCheckingForUpdate = false;
    }
  }

  async function forceRefresh(): Promise<ForceRefreshResult> {
    if (isForceRefreshing) {
      return { ok: false, reason: 'refresh-in-progress' };
    }

    if (typeof window === 'undefined') {
      return { ok: false, reason: 'browser-unsupported' };
    }

    isForceRefreshing = true;

    try {
      const serverReachable = await canReachAppServer();
      if (!serverReachable) {
        return { ok: false, reason: 'server-unreachable' };
      }

      await unregisterAppShellServiceWorkers();
      await clearAppShellCaches();
      window.location.reload();
      return { ok: true };
    } finally {
      isForceRefreshing = false;
    }
  }

  return {
    get currentBuildInfo() {
      return currentBuildInfo;
    },
    set currentBuildInfo(value) {
      currentBuildInfo = value;
    },
    get serverBuildInfo() {
      return serverBuildInfo;
    },
    set serverBuildInfo(value) {
      serverBuildInfo = value;
    },
    get isAppShellEnabled() {
      return isAppShellEnabled;
    },
    get canUseServiceWorker() {
      return canUseServiceWorker;
    },
    get isCheckingForUpdate() {
      return isCheckingForUpdate;
    },
    set isCheckingForUpdate(value) {
      isCheckingForUpdate = value;
    },
    get isForceRefreshing() {
      return isForceRefreshing;
    },
    set isForceRefreshing(value) {
      isForceRefreshing = value;
    },
    get lastCheckedAt() {
      return lastCheckedAt;
    },
    set lastCheckedAt(value) {
      lastCheckedAt = value;
    },
    get lastCheckFailed() {
      return lastCheckFailed;
    },
    set lastCheckFailed(value) {
      lastCheckFailed = value;
    },
    get hasUpdateAvailable() {
      return hasUpdateAvailable;
    },
    startRuntime,
    stopRuntime,
    checkForUpdate,
    forceRefresh,
  };
});
