/**
 * Device-local values kept in `localStorage` and read through `useSyncExternalStore`
 * (the changelog "seen" version, the last-used Google Email hint). One store so both
 * features share the same failure behavior instead of each re-deriving it.
 *
 * Storage is treated as a write-through cache, not the source of truth: Safari private
 * mode throws `QuotaExceededError` on write and "block all cookies" throws on the
 * `window.localStorage` property access itself, so a failed write falls back to a
 * module-level mirror. The value then behaves correctly for the rest of the document's
 * life and is simply gone on the next visit.
 *
 * A mirrored value never outranks a later external one: it is dropped as soon as a write
 * succeeds here, and as soon as storage reads back something other than what it held when
 * the write failed — a write from another tab, or a `clear()`.
 *
 * Notifications cover the three ways a value can change: this document (`localStorage`
 * fires `storage` only in OTHER documents), another tab (`storage`), and a document
 * restored from the back/forward cache, which missed every event while it was frozen
 * (`pageshow`).
 */

/**
 * Session mirror for keys whose write could not reach `localStorage`, each remembering
 * what was persisted at the moment the write failed. That pair is the whole validity
 * rule: the mirror is this document's pending write, and it holds only while storage
 * still reads back what it did then.
 */
const unpersisted = new Map<string, { value: string; storedAtFailure: string | null }>();
const listeners = new Set<() => void>();

function storageOrNull() {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function storedValue(key: string) {
  try {
    return storageOrNull()?.getItem(key) ?? null;
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
  const stored = storedValue(key);
  const mirrored = unpersisted.get(key);
  if (mirrored === undefined) {
    return stored;
  }
  // Storage has not moved on, so the mirror is still this key's newest value: a quota
  // failure leaves the OLDER persisted value readable, and preferring it would resurrect
  // it — the changelog badge would never clear under quota pressure, which is exactly
  // what the mirror exists to prevent.
  //
  // The value is the whole test, deliberately, not "did any write happen": another
  // document re-writing exactly what the failure read leaves storage byte-identical, so
  // it carries nothing this document does not already know, and adopting it would undo a
  // change the User made HERE. Any write that is distinguishable — including the moment a
  // `clear()` is observed, before whatever lands next — takes the branch below.
  if (stored === mirrored.storedAtFailure) {
    return mirrored.value;
  }
  // Another document wrote this key since the failure. That value is newer than the
  // pending one, so the mirror is obsolete — dropped here rather than in a `storage`
  // listener, because the mirror must not outlive its premise even when nothing is
  // subscribed. The returned value is the same either way, so snapshots stay stable.
  unpersisted.delete(key);
  return stored;
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
    unpersisted.set(key, { value, storedAtFailure: storedValue(key) });
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
