/**
 * Device-local values kept in `localStorage` and read through `useSyncExternalStore`
 * (the changelog "seen" version, the last-used Google Email hint). One store so both
 * features share the same failure behavior instead of each re-deriving it.
 *
 * Storage is treated as a write-through cache, not the source of truth: Safari private
 * mode throws `QuotaExceededError` on write and "block all cookies" throws on the
 * `window.localStorage` property access itself, so a failed write falls back to a
 * module-level mirror. The value then behaves correctly for the rest of the document's
 * life and is simply gone on the next visit. A write that DOES persist drops its mirror
 * entry, so another tab clearing the key is never resurrected from memory.
 *
 * Notifications cover the three ways a value can change: this document (`localStorage`
 * fires `storage` only in OTHER documents), another tab (`storage`), and a document
 * restored from the back/forward cache, which missed every event while it was frozen
 * (`pageshow`).
 */

/** Session mirror for keys whose write could not reach `localStorage`. */
const unpersisted = new Map<string, string>();
const listeners = new Set<() => void>();

function storageOrNull() {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function notify() {
  for (const listener of listeners) {
    listener();
  }
}

export function readDeviceLocal(key: string) {
  // The mirror wins: an entry only exists because storage refused this key's NEWEST
  // write, and quota failures leave the older persisted value readable. Reading storage
  // first would resurrect it — the changelog badge would never clear under quota
  // pressure, which is exactly what the mirror exists to prevent.
  const mirrored = unpersisted.get(key);
  if (mirrored !== undefined) {
    return mirrored;
  }
  try {
    return storageOrNull()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeDeviceLocal(key: string, value: string) {
  const storage = storageOrNull();
  try {
    if (!storage) {
      throw new Error("localStorage unavailable");
    }
    storage.setItem(key, value);
    unpersisted.delete(key);
  } catch {
    unpersisted.set(key, value);
  }
  notify();
}

export function removeDeviceLocal(key: string) {
  unpersisted.delete(key);
  try {
    storageOrNull()?.removeItem(key);
  } catch {
    // Nothing to remove when storage is unavailable.
  }
  notify();
}

/**
 * Forgets every value `localStorage` refused to persist. The mirror is document-scoped
 * state, so a test that clears storage has to clear this too.
 */
export function clearUnpersistedDeviceLocal() {
  unpersisted.clear();
}

/**
 * Builds the `subscribe` callback for one feature's keys. Call it once at module scope:
 * `useSyncExternalStore` re-subscribes whenever the reference changes.
 *
 * `matchesKey` is only consulted for cross-tab events. `Storage.clear()` reports a
 * `null` key, and same-document writes and bfcache restores carry no key at all, so
 * those always notify — subscribers re-read and an unchanged snapshot costs nothing.
 */
export function createDeviceLocalSubscription(matchesKey: (key: string) => boolean) {
  return (onStoreChange: () => void) => {
    if (typeof window === "undefined") {
      return () => {};
    }

    const onStorage = (event: StorageEvent) => {
      // `sessionStorage` writes dispatch the same event; older engines omit the area.
      if (event.storageArea && event.storageArea !== storageOrNull()) {
        return;
      }
      if (event.key === null || matchesKey(event.key)) {
        onStoreChange();
      }
    };

    window.addEventListener("storage", onStorage);
    window.addEventListener("pageshow", onStoreChange);
    listeners.add(onStoreChange);

    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("pageshow", onStoreChange);
      listeners.delete(onStoreChange);
    };
  };
}
