/**
 * Entry-point side effect: guarantee a secure getRandomValues before any key is
 * generated. The implementation and its rationale live in src/runtime/cryptoShim.ts.
 */
import { installCryptoShim } from "./src/runtime/cryptoShim";

installCryptoShim();

if (typeof navigator !== "undefined" && navigator.product === "ReactNative") {
  void import("@walletconnect/react-native-compat").catch(() => undefined);
}
