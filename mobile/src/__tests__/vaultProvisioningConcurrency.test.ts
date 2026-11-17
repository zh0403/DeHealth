import { describe, expect, it } from "vitest";
import {
  clearVaultSecret,
  isValidVaultSecret,
  provisionVaultSecret,
  SecureKeyStore,
  VAULT_SECRET_STORAGE_KEY
} from "../storage/vaultKeyProvider";

/** Store with random async latency so concurrent callers genuinely interleave. */
class SlowStore implements SecureKeyStore {
  readonly items = new Map<string, string>();
  writes = 0;
  deletes = 0;

  private async tick(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, Math.random() * 6));
  }

  async getItem(key: string): Promise<string | null> {
    await this.tick();
    return this.items.get(key) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    await this.tick();
    this.writes += 1;
    this.items.set(key, value);
  }

  async deleteItem(key: string): Promise<void> {
    await this.tick();
    this.deletes += 1;
    this.items.delete(key);
  }
}

describe("vault secret provisioning concurrency", () => {
  it("returns one secret and performs one write for many simultaneous first launches", async () => {
    for (let run = 0; run < 25; run += 1) {
      const store = new SlowStore();
      const secrets = await Promise.all(
        Array.from({ length: 20 }, () => provisionVaultSecret(store))
      );

      expect(new Set(secrets).size).toBe(1);
      expect(isValidVaultSecret(secrets[0])).toBe(true);
      expect(store.writes).toBe(1);
      expect(store.items.get(VAULT_SECRET_STORAGE_KEY)).toBe(secrets[0]);
    }
  });

  it("deduplicates per store, so two different stores get independent secrets", async () => {
    const a = new SlowStore();
    const b = new SlowStore();
    const [sa, sb] = await Promise.all([provisionVaultSecret(a), provisionVaultSecret(b)]);

    expect(sa).not.toBe(sb);
    expect(a.writes).toBe(1);
    expect(b.writes).toBe(1);
  });

  it("does not poison later calls after a failed first attempt", async () => {
    let failNext = true;
    const inner = new SlowStore();
    const flaky: SecureKeyStore = {
      getItem: async (key) => {
        if (failNext) {
          failNext = false;
          throw new Error("keystore temporarily locked");
        }
        return inner.getItem(key);
      },
      setItem: (key, value) => inner.setItem(key, value)
    };

    await expect(provisionVaultSecret(flaky)).rejects.toThrow("temporarily locked");
    const recovered = await provisionVaultSecret(flaky);

    expect(isValidVaultSecret(recovered)).toBe(true);
    expect(inner.writes).toBe(1);
  });

  it("reuses the persisted secret on later sequential calls without writing again", async () => {
    const store = new SlowStore();
    const first = await provisionVaultSecret(store);
    const second = await provisionVaultSecret(store);

    expect(second).toBe(first);
    expect(store.writes).toBe(1);
  });

  it("clearVaultSecret deletes the key so the next launch provisions a fresh secret", async () => {
    const store = new SlowStore();
    const first = await provisionVaultSecret(store);

    await clearVaultSecret(store);
    expect(store.deletes).toBe(1);
    expect(store.items.has(VAULT_SECRET_STORAGE_KEY)).toBe(false);

    const next = await provisionVaultSecret(store);
    expect(isValidVaultSecret(next)).toBe(true);
    expect(next).not.toBe(first);
  });

  it("clearVaultSecret tolerates a store without deleteItem and a failing keystore", async () => {
    const noDelete: SecureKeyStore = {
      getItem: async () => null,
      setItem: async () => undefined
    };
    await expect(clearVaultSecret(noDelete)).resolves.toBeUndefined();

    const broken: SecureKeyStore = {
      getItem: async () => null,
      setItem: async () => undefined,
      deleteItem: async () => {
        throw new Error("keystore unavailable");
      }
    };
    await expect(clearVaultSecret(broken)).resolves.toBeUndefined();
  });
});
