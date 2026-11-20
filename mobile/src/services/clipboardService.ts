export interface ClipboardAdapter {
  readonly setStringAsync: (text: string) => Promise<boolean | void>;
}

let customClipboardAdapter: ClipboardAdapter | null | undefined = undefined;

/**
 * Injects a custom ClipboardAdapter for deterministic unit testing (pass null
 * to skip expo-clipboard and exercise web fallback, or undefined to restore
 * default dynamic loading).
 */
export function setClipboardAdapterForTesting(
  adapter: ClipboardAdapter | null | undefined
): void {
  customClipboardAdapter = adapter;
}

/**
 * Restores default dynamic `expo-clipboard` loading behavior.
 */
export function resetClipboardAdapterForTesting(): void {
  customClipboardAdapter = undefined;
}

function isClipboardAdapterLike(
  candidate: unknown
): candidate is ClipboardAdapter {
  if (typeof candidate !== "object" || candidate === null) {
    return false;
  }
  const record = candidate as Record<string, unknown>;
  return typeof record.setStringAsync === "function";
}

async function resolveClipboardAdapter(): Promise<ClipboardAdapter | null> {
  if (customClipboardAdapter !== undefined) {
    return customClipboardAdapter;
  }

  try {
    const mod: unknown = await import("expo-clipboard");
    if (isClipboardAdapterLike(mod)) {
      return mod;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Copies non-empty trimmed text to the device clipboard using native
 * `expo-clipboard` when available, falling back cleanly to browser
 * `navigator.clipboard.writeText` if the native adapter is absent, returns
 * `false`, or throws.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return false;
  }

  const adapter = await resolveClipboardAdapter();
  if (adapter) {
    try {
      const result = await adapter.setStringAsync(trimmed);
      if (result !== false) {
        return true;
      }
    } catch {
      // Fall through cleanly to the web navigator.clipboard fallback.
    }
  }

  try {
    if (
      typeof navigator !== "undefined" &&
      typeof navigator.clipboard?.writeText === "function"
    ) {
      await navigator.clipboard.writeText(trimmed);
      return true;
    }
  } catch {
    return false;
  }

  return false;
}
