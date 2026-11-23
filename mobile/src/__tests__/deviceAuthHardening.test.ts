import { Address, AuthSessionMetadata } from "@dehealth/shared";
import { SupabaseClient } from "@supabase/supabase-js";
import { Wallet } from "ethers";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthError,
  completeOAuthRedirectCallback,
  ExternalWalletConnection,
  resetDeepLinkOpenerForTesting,
  resetMetaMaskAdapterForTesting,
  resetOAuthBrowserAdapterForTesting,
  resetUniversalProviderFactoryForTesting,
  resetWalletConnectAdapterForTesting,
  restoreExternalWalletSignerOnBoot,
  setDeepLinkOpenerForTesting,
  setMetaMaskAdapterForTesting,
  setUniversalProviderFactoryForTesting,
  setWalletConnectAdapterForTesting,
  signInWithWalletConnect,
  UniversalProviderLike
} from "../services/authService";
import { setSupabaseClient } from "../services/supabaseService";

function makeSession(
  authMethod: AuthSessionMetadata["authMethod"],
  address: string
): AuthSessionMetadata {
  return {
    authMethod,
    accountId: address,
    displayLabel: "external",
    walletAddress: address as Address,
    signedInAtMs: 1_700_000_000_000
  };
}

const dummyEip1193 = {
  request: vi.fn().mockResolvedValue("0x")
};

describe("device OAuth, external wallet pairing and boot restore hardening", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setSupabaseClient(undefined);
    resetMetaMaskAdapterForTesting();
    resetWalletConnectAdapterForTesting();
    resetOAuthBrowserAdapterForTesting();
    resetUniversalProviderFactoryForTesting();
    resetDeepLinkOpenerForTesting();
    delete process.env.EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID;
  });

  afterEach(() => {
    setSupabaseClient(undefined);
    resetMetaMaskAdapterForTesting();
    resetWalletConnectAdapterForTesting();
    resetOAuthBrowserAdapterForTesting();
    resetUniversalProviderFactoryForTesting();
    resetDeepLinkOpenerForTesting();
  });

  describe("app configuration", () => {
    it("registers the dehealth deep link scheme", () => {
      const cfg = JSON.parse(
        readFileSync(resolve(__dirname, "../../app.json"), "utf8")
      ) as { expo?: { scheme?: string }; scheme?: string };
      expect((cfg.expo ?? cfg).scheme).toBe("dehealth");
    });
  });

  describe("completeOAuthRedirectCallback", () => {
    it("exchanges one code once when the same URL arrives concurrently", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolveGate) => {
        release = resolveGate;
      });
      const exchange = vi.fn().mockImplementation(async () => {
        await gate;
        return { data: {}, error: null };
      });
      setSupabaseClient({
        auth: { exchangeCodeForSession: exchange }
      } as unknown as SupabaseClient);

      const url = "dehealth://auth-callback?code=concurrent-code";
      const first = completeOAuthRedirectCallback(url);
      const second = completeOAuthRedirectCallback(url);
      release();
      expect(await Promise.all([first, second])).toEqual([true, true]);
      expect(exchange).toHaveBeenCalledTimes(1);
    });

    it("rejects with AuthError when the code exchange or session hydration fails", async () => {
      setSupabaseClient({
        auth: {
          exchangeCodeForSession: vi.fn().mockResolvedValue({
            data: null,
            error: { message: "exchange denied" }
          }),
          setSession: vi.fn().mockResolvedValue({
            data: null,
            error: { message: "session denied" }
          })
        }
      } as unknown as SupabaseClient);

      await expect(
        completeOAuthRedirectCallback("dehealth://auth-callback?code=bad-code")
      ).rejects.toThrow(/exchange denied/);
      await expect(
        completeOAuthRedirectCallback(
          "dehealth://auth-callback#access_token=bad&refresh_token=r"
        )
      ).rejects.toThrow(/session denied/);
      await expect(
        completeOAuthRedirectCallback("dehealth://auth-callback?code=bad-code")
      ).rejects.toBeInstanceOf(AuthError);
    });

    it("ignores URLs that carry no OAuth credentials", async () => {
      const exchange = vi.fn();
      setSupabaseClient({
        auth: { exchangeCodeForSession: exchange }
      } as unknown as SupabaseClient);
      expect(
        await completeOAuthRedirectCallback("dehealth://auth-callback?foo=bar")
      ).toBe(false);
      expect(exchange).not.toHaveBeenCalled();
    });
  });

  describe("native WalletConnect pairing", () => {
    function makeProvider(
      onConnect: (
        emitUri: (uri: string) => void,
        provider: UniversalProviderLike
      ) => Promise<unknown>
    ): UniversalProviderLike & {
      readonly connectMock: ReturnType<typeof vi.fn>;
      readonly abortMock: ReturnType<typeof vi.fn>;
    } {
      const listeners = new Map<string, (payload: string) => void>();
      const abortMock = vi.fn();
      const holder: { provider?: UniversalProviderLike } = {};
      const connectMock = vi.fn().mockImplementation(async () =>
        onConnect((uri) => listeners.get("display_uri")?.(uri), holder.provider!)
      );
      const provider = {
        session: undefined,
        on: (event: string, listener: (payload: string) => void) => {
          listeners.set(event, listener);
        },
        off: (event: string) => {
          listeners.delete(event);
        },
        connect: connectMock,
        request: vi.fn().mockResolvedValue([]),
        abortPairingAttempt: abortMock,
        connectMock,
        abortMock
      };
      holder.provider = provider as unknown as UniversalProviderLike;
      return provider as unknown as UniversalProviderLike & {
        readonly connectMock: ReturnType<typeof vi.fn>;
        readonly abortMock: ReturnType<typeof vi.fn>;
      };
    }

    it("requests Arbitrum Sepolia with personal_sign and EIP-712 typed data", async () => {
      const remote = Wallet.createRandom();
      const provider = makeProvider(async (emit, self) => {
        emit("wc:topic@2?relay-protocol=irn&symKey=k");
        (self as { session: UniversalProviderLike["session"] }).session = {
          namespaces: {
            eip155: { accounts: [`eip155:421614:${remote.address}`] }
          }
        };
        return self.session;
      });
      setDeepLinkOpenerForTesting(async () => undefined);
      setUniversalProviderFactoryForTesting(async () => provider);
      process.env.EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID = "proj-1";

      const memory = new Map<string, string>();
      const { AuthSessionStorage } = await import("../services/authService");
      const storage = new AuthSessionStorage("0x" + "dd".repeat(32), {
        getItem: async (k: string) => memory.get(k) ?? null,
        setItem: async (k: string, v: string) => {
          memory.set(k, v);
        },
        removeItem: async (k: string) => {
          memory.delete(k);
        }
      });
      await signInWithWalletConnect({ storage, nowMs: 5_000 });

      const params = provider.connectMock.mock.calls[0]![0] as {
        optionalNamespaces: {
          eip155: { methods: string[]; chains: string[] };
        };
      };
      expect(params.optionalNamespaces.eip155.chains).toEqual([
        "eip155:421614"
      ]);
      expect(params.optionalNamespaces.eip155.methods).toEqual(
        expect.arrayContaining(["personal_sign", "eth_signTypedData_v4"])
      );
    });

    it("aborts pairing and reports an AuthError when the wallet deep link cannot open", async () => {
      const provider = makeProvider(async (emit) => {
        emit("wc:topic@2?relay-protocol=irn&symKey=k");
        return new Promise<never>(() => undefined);
      });
      setDeepLinkOpenerForTesting(async () => {
        throw new Error("no wallet app installed");
      });
      setUniversalProviderFactoryForTesting(async () => provider);
      process.env.EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID = "proj-1";

      await expect(signInWithWalletConnect()).rejects.toThrow(
        /no wallet app installed/
      );
      expect(provider.abortMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("restoreExternalWalletSignerOnBoot address matching", () => {
    const expected = Wallet.createRandom();
    const other = Wallet.createRandom();

    it("restores a MetaMask adapter session only for the stored address", async () => {
      const connection = (address: string): ExternalWalletConnection => ({
        address,
        provider: dummyEip1193
      });
      setMetaMaskAdapterForTesting({
        connect: vi.fn(),
        restoreSession: vi.fn().mockResolvedValue(connection(other.address))
      });
      expect(
        await restoreExternalWalletSignerOnBoot(
          makeSession("metamask", expected.address)
        )
      ).toBeNull();

      setMetaMaskAdapterForTesting({
        connect: vi.fn(),
        restoreSession: vi
          .fn()
          .mockResolvedValue(connection(expected.address.toLowerCase()))
      });
      const signer = await restoreExternalWalletSignerOnBoot(
        makeSession("metamask", expected.address)
      );
      expect(await signer?.getAddress()).toBe(expected.address);
    });

    it("restores a WalletConnect adapter session only for the stored address", async () => {
      process.env.EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID = "proj-1";
      setWalletConnectAdapterForTesting({
        connect: vi.fn(),
        restoreSession: vi
          .fn()
          .mockResolvedValue({ address: other.address, provider: dummyEip1193 })
      });
      expect(
        await restoreExternalWalletSignerOnBoot(
          makeSession("walletconnect", expected.address)
        )
      ).toBeNull();
    });

    it("rejects a live WalletConnect provider session that belongs to a different account", async () => {
      process.env.EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID = "proj-1";
      const live = (address: string): UniversalProviderLike => ({
        session: {
          namespaces: { eip155: { accounts: [`eip155:421614:${address}`] } }
        },
        on: vi.fn(),
        connect: vi.fn(),
        request: vi.fn()
      });

      setUniversalProviderFactoryForTesting(async () => live(other.address));
      expect(
        await restoreExternalWalletSignerOnBoot(
          makeSession("walletconnect", expected.address)
        )
      ).toBeNull();

      resetUniversalProviderFactoryForTesting();
      setUniversalProviderFactoryForTesting(async () => live(expected.address));
      const signer = await restoreExternalWalletSignerOnBoot(
        makeSession("walletconnect", expected.address)
      );
      expect(await signer?.getAddress()).toBe(expected.address);
    });
  });
});
