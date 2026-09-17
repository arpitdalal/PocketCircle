import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";

const DEFAULT_DEBOUNCE_MS = 250;

/**
 * A debounced live-search text box: local state holds in-flight keystrokes; after
 * `debounceMs` the NORMALIZED text commits via `onSearch` (the caller writes it to the
 * URL). `value` is the applied value (from the URL); an external change to it re-syncs the
 * box without clobbering what the user is still typing (the `applied` ref). `normalize`
 * canonicalizes the text the same way the URL codec does, so the box's own echo never
 * re-fires `onSearch`. Enter flushes immediately. Single home for both the Categories and
 * Search query boxes.
 */
export function DebouncedSearchInput({
  value,
  onSearch,
  label,
  placeholder,
  normalize = (raw) => raw,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  className,
}: {
  value: string;
  onSearch: (q: string) => void;
  label: string;
  placeholder?: string;
  normalize?: (raw: string) => string;
  debounceMs?: number;
  className?: string;
}) {
  // react-doctor-disable-next-line react-doctor/no-derived-useState -- local draft state; external URL value resyncs below without clobbering in-flight typing.
  const [text, setText] = useState(value);
  const applied = useRef(value);
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const clearPending = useCallback(() => {
    if (pending.current !== undefined) {
      clearTimeout(pending.current);
      pending.current = undefined;
    }
  }, []);

  const commitRaw = useEffectEvent((raw: string) => {
    const clean = normalize(raw);
    if (clean !== applied.current) {
      applied.current = clean;
      onSearch(clean);
    }
  });

  useEffect(() => {
    if (value !== applied.current) {
      applied.current = value;
      setText(value);
    }
  }, [value]);

  useEffect(() => {
    clearPending();
    pending.current = setTimeout(() => {
      pending.current = undefined;
      commitRaw(text);
    }, debounceMs);
    return clearPending;
  }, [text, debounceMs, clearPending]);

  function commit() {
    clearPending();
    const clean = normalize(text);
    if (clean !== applied.current) {
      applied.current = clean;
      onSearch(clean);
    }
  }

  return (
    <label className={className ?? "block"}>
      <span className="sr-only">{label}</span>
      <input
        type="search"
        value={text}
        onChange={(event) => setText(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
        }}
        placeholder={placeholder}
        className="w-full rounded-md border border-input bg-card px-3 py-2 text-base md:text-sm shadow-sm outline-none transition-[border-color,box-shadow] duration-150 focus:border-ring focus:ring-2 focus:ring-ring/30 text-foreground"
      />
    </label>
  );
}
