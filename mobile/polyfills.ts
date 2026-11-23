/**
 * Entry-point side effect: guarantee a secure getRandomValues before any key is
 * generated, and synchronously register WalletConnect React Native compat shims
 * (URL, crypto.getRandomValues, TextEncoder, NetInfo, Linking) before any
 * downstream module initializes.
 */
import "@walletconnect/react-native-compat";
import { installCryptoShim } from "./src/runtime/cryptoShim";

installCryptoShim();
