import { describe, expect, it, vi } from "vitest";
import {
  installCryptoShim,
  SecureRandomUnavailableError
} from "../runtime/cryptoShim";

type Host = Parameters<typeof installCryptoShim>[0];

/** A host that looks like React Native / Hermes: no Web Crypto at all. */
function bareHost(): Host {
  return {} as Host;
}

/** Deterministic stand-in for expo-crypto so tests never touch real randomness. */
const expoStub = <T extends ArrayBufferView>(array: T): T => {
  new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(0xab);
  return array;
};

describe("PRIV-01/SOV-01 support: secure randomness shim", () => {
  it("keeps native Web Crypto untouched when present", () => {
    const native = { getRandomValues: vi.fn(<T extends ArrayBufferView>(a: T): T => a) };
    const host = { crypto: native } as unknown as Host;
    const loadExpo = vi.fn(() => expoStub);

    expect(installCryptoShim(host, loadExpo)).toBe("native");
    expect(host.crypto).toBe(native);
    expect(host.crypto?.getRandomValues).toBe(native.getRandomValues);
    expect(loadExpo).not.toHaveBeenCalled();
  });

  it("promotes msCrypto to crypto when only msCrypto exists", () => {
    const legacy = { getRandomValues: <T extends ArrayBufferView>(a: T): T => a };
    const host = { msCrypto: legacy } as unknown as Host;

    expect(installCryptoShim(host, () => null)).toBe("native");
    expect(host.crypto).toBe(legacy);
  });

  it("uses expo-crypto on a runtime with no Web Crypto", () => {
    const host = bareHost();
    expect(installCryptoShim(host, () => expoStub)).toBe("expo-crypto");

    const bytes = new Uint8Array(32);
    host.crypto!.getRandomValues!(bytes);
    expect(Array.from(bytes).every((b) => b === 0xab)).toBe(true);
  });

  it("replaces an existing crypto object that lacks getRandomValues", () => {
    const host = { crypto: {} } as unknown as Host;
    expect(installCryptoShim(host, () => expoStub)).toBe("expo-crypto");
    expect(typeof host.crypto?.getRandomValues).toBe("function");
  });

  it("FAILS CLOSED when no secure source exists, never falling back to Math.random", () => {
    const host = bareHost();
    const mathRandom = vi.spyOn(Math, "random");

    expect(installCryptoShim(host, () => null)).toBe("fail-closed");
    expect(() => host.crypto!.getRandomValues!(new Uint8Array(32))).toThrow(
      SecureRandomUnavailableError
    );
    expect(mathRandom).not.toHaveBeenCalled();
    mathRandom.mockRestore();
  });

  it("fails closed on an existing crypto object too", () => {
    const host = { crypto: {} } as unknown as Host;
    installCryptoShim(host, () => null);
    expect(() => host.crypto!.getRandomValues!(new Uint8Array(8))).toThrow(
      /refusing to generate keys/
    );
  });

  it("resolves the real expo-crypto module path without throwing at install time", () => {
    const host = bareHost();
    const outcome = installCryptoShim(host);
    expect(["expo-crypto", "fail-closed"]).toContain(outcome);
    expect(typeof host.crypto?.getRandomValues).toBe("function");
  });
});
