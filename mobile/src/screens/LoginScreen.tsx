import { Address } from "@dehealth/shared";
import React, { useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { WalletConnectQrModal } from "../components/WalletConnectQrModal";

const ZERO_ADDRESS_REGEX = /^0x0{40}$/i;

function formatShortAddress(address: string): string {
  const trimmed = address.trim();
  if (trimmed.length >= 10) {
    return `${trimmed.slice(0, 6)}\u2026${trimmed.slice(-4)}`;
  }
  return trimmed;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return error.trim();
  }
  if (
    typeof error === "object" &&
    error !== null &&
    !Array.isArray(error) &&
    "message" in error &&
    typeof (error as { readonly message?: unknown }).message === "string"
  ) {
    const msg = (error as { readonly message: string }).message.trim();
    if (msg.length > 0) {
      return msg;
    }
  }
  return "Authentication failed. Please try again.";
}

export interface LoginScreenProps {
  readonly onSignInWithGoogle: () => Promise<void> | void;
  readonly onSignInWithMetaMask: () => Promise<void> | void;
  readonly onSignInWithWalletConnect: (
    onDisplayUri?: (uri: string) => void
  ) => Promise<void> | void;
  readonly onStartLocalSession?: () => Promise<void> | void;
  readonly isSupabaseConfigured?: boolean;
  readonly isWalletConnectConfigured?: boolean;
  readonly existingWalletAddress?: Address | null;
  readonly walletConnectUri?: string | null;
  readonly onCancelWalletConnect?: () => void;
  readonly onError?: (error: unknown) => void;
}

type PendingAuthMethod = "google" | "metamask" | "walletconnect" | "local" | null;

export const LoginScreen: React.FC<LoginScreenProps> = ({
  onSignInWithGoogle,
  onSignInWithMetaMask,
  onSignInWithWalletConnect,
  onStartLocalSession,
  isSupabaseConfigured = false,
  isWalletConnectConfigured = false,
  existingWalletAddress = null,
  walletConnectUri = null,
  onCancelWalletConnect,
  onError
}) => {
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [pendingMethod, setPendingMethod] = useState<PendingAuthMethod>(null);
  const isSubmittingRef = useRef<boolean>(false);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [activePairingUri, setActivePairingUri] = useState<string | null>(null);

  const hasExistingWallet =
    typeof existingWalletAddress === "string" &&
    existingWalletAddress.trim().length > 0 &&
    !ZERO_ADDRESS_REGEX.test(existingWalletAddress.trim());

  const runAuthSubmission = async (
    method: Exclude<PendingAuthMethod, null>,
    action: () => Promise<void> | void
  ): Promise<void> => {
    if (isSubmittingRef.current || isSubmitting) {
      return;
    }
    isSubmittingRef.current = true;
    setIsSubmitting(true);
    setPendingMethod(method);
    setInlineError(null);

    try {
      await Promise.resolve(action());
    } catch (err: unknown) {
      setInlineError(toErrorMessage(err));
      onError?.(err);
    } finally {
      isSubmittingRef.current = false;
      setIsSubmitting(false);
      setPendingMethod(null);
      setActivePairingUri(null);
    }
  };

  const handleGoogleSignIn = (): void => {
    void runAuthSubmission("google", onSignInWithGoogle);
  };

  const handleLocalSignIn = (): void => {
    if (onStartLocalSession) {
      void runAuthSubmission("local", onStartLocalSession);
    }
  };

  const handleMetaMaskSignIn = (): void => {
    void runAuthSubmission("metamask", onSignInWithMetaMask);
  };

  const handleWalletConnectSignIn = (): void => {
    void runAuthSubmission("walletconnect", () =>
      onSignInWithWalletConnect((uri: string) => {
        setActivePairingUri(uri);
      })
    );
  };

  const handleCloseWalletConnectModal = (): void => {
    setActivePairingUri(null);
    onCancelWalletConnect?.();
  };

  const effectivePairingUri = walletConnectUri ?? activePairingUri;

  const googleButtonLabel = isSupabaseConfigured
    ? "Sign in with Google"
    : "Start Local Session";
  const googlePendingLabel = isSupabaseConfigured
    ? "Signing in with Google..."
    : "Starting Local Session...";

  return (
    <ScrollView
      testID="login-screen"
      style={styles.container}
      contentContainerStyle={styles.scrollContent}
      keyboardShouldPersistTaps="handled"
    >
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.sovereigntyPill}>
          <Text style={styles.sovereigntyPillText}>
            🔒 100% On-Device Biometric Vault
          </Text>
        </View>
        <Text style={styles.title}>DeHealth Protocol</Text>
        <Text style={styles.subtitle}>
          Verify daily fitness & nutrition commitments on Arbitrum Sepolia while
          keeping all personal health metrics encrypted on your device.
        </Text>
      </View>

      {/* Inline Auth Error Banner */}
      {inlineError ? (
        <View testID="login-error-banner" style={styles.errorBanner}>
          <Text style={styles.errorText}>{inlineError}</Text>
        </View>
      ) : null}

      {/* Path 1: Google OAuth / Local Embedded Wallet */}
      <View style={styles.authCard}>
        <Text style={styles.cardEyebrow}>PATH 1 • ACCOUNT OR LOCAL SESSION</Text>
        <Text style={styles.cardTitle}>
          {isSupabaseConfigured ? "Sign in with Google" : "Local Sovereign Session"}
        </Text>
        <Text style={styles.cardDescription}>
          {isSupabaseConfigured
            ? "Authenticate via Google OAuth with automatic non-custodial L2 wallet provisioning on-device."
            : "Supabase OAuth is unconfigured. Start an offline encrypted session backed by your on-device Arbitrum Sepolia wallet."}
        </Text>

        {hasExistingWallet && existingWalletAddress ? (
          <View testID="login-local-wallet-badge" style={styles.walletBadge}>
            <Text style={styles.walletBadgeLabel}>Local Wallet:</Text>
            <Text style={styles.walletBadgeValue}>
              {formatShortAddress(existingWalletAddress)}
            </Text>
          </View>
        ) : null}

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={googleButtonLabel}
          accessibilityState={{ disabled: isSubmitting }}
          testID="login-google-button"
          disabled={isSubmitting}
          style={({ pressed }) => [
            styles.primaryButton,
            isSubmitting ? styles.buttonDisabled : null,
            pressed ? styles.buttonPressed : null
          ]}
          onPress={handleGoogleSignIn}
        >
          <Text style={styles.primaryButtonText}>
            {pendingMethod === "google" ? googlePendingLabel : googleButtonLabel}
          </Text>
        </Pressable>

        {isSupabaseConfigured && onStartLocalSession ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Start Local Session"
            accessibilityState={{ disabled: isSubmitting }}
            testID="login-local-session-button"
            disabled={isSubmitting}
            style={({ pressed }) => [
              styles.secondaryButton,
              isSubmitting ? styles.buttonDisabled : null,
              pressed ? styles.buttonPressed : null
            ]}
            onPress={handleLocalSignIn}
          >
            <Text style={styles.secondaryButtonText}>
              {pendingMethod === "local"
                ? "Starting Local Session..."
                : "Start Local Session"}
            </Text>
          </Pressable>
        ) : null}
      </View>

      {/* Path 2: MetaMask */}
      <View style={styles.authCard}>
        <Text style={styles.cardEyebrow}>PATH 2 • BROWSER / MOBILE WALLET</Text>
        <Text style={styles.cardTitle}>MetaMask</Text>
        <Text style={styles.cardDescription}>
          Connect directly with MetaMask (EIP-1193) to sign daily EIP-712
          check-in proofs without generating an embedded key.
        </Text>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Sign in with MetaMask"
          accessibilityState={{ disabled: isSubmitting }}
          testID="login-metamask-button"
          disabled={isSubmitting}
          style={({ pressed }) => [
            styles.metamaskButton,
            isSubmitting ? styles.buttonDisabled : null,
            pressed ? styles.buttonPressed : null
          ]}
          onPress={handleMetaMaskSignIn}
        >
          <Text style={styles.metamaskButtonText}>
            {pendingMethod === "metamask"
              ? "Connecting MetaMask..."
              : "Sign in with MetaMask"}
          </Text>
        </Pressable>
      </View>

      {/* Path 3: WalletConnect v2 */}
      <View style={styles.authCard}>
        <Text style={styles.cardEyebrow}>PATH 3 • WALLETCONNECT V2</Text>
        <Text style={styles.cardTitle}>WalletConnect</Text>
        <Text style={styles.cardDescription}>
          Pair an external mobile or hardware wallet over WalletConnect v2 for
          non-custodial Arbitrum Sepolia EIP-712 signing.
        </Text>
        <Text
          testID="login-walletconnect-status"
          style={[
            styles.statusSubtitle,
            isWalletConnectConfigured
              ? styles.statusConfigured
              : styles.statusUnconfigured
          ]}
        >
          {isWalletConnectConfigured
            ? "WalletConnect v2 Project ID configured and ready."
            : "WalletConnect v2 Project ID not configured (set EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID)."}
        </Text>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="WalletConnect"
          accessibilityState={{ disabled: isSubmitting }}
          testID="login-walletconnect-button"
          disabled={isSubmitting}
          style={({ pressed }) => [
            styles.walletConnectButton,
            isSubmitting ? styles.buttonDisabled : null,
            pressed ? styles.buttonPressed : null
          ]}
          onPress={handleWalletConnectSignIn}
        >
          <Text style={styles.walletConnectButtonText}>
            {pendingMethod === "walletconnect"
              ? "Connecting WalletConnect..."
              : "WalletConnect"}
          </Text>
        </Pressable>
      </View>

      <Text style={styles.footerNote}>
        Private keys never leave encrypted hardware/OS storage or your external
        wallet. Zero raw biometrics, meals, weights, or step counts are ever
        uploaded.
      </Text>

      <WalletConnectQrModal
        visible={effectivePairingUri !== null}
        uri={effectivePairingUri}
        onClose={handleCloseWalletConnectModal}
      />
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0B0F17"
  },
  scrollContent: {
    padding: 20,
    paddingBottom: 40
  },
  header: {
    marginBottom: 20
  },
  sovereigntyPill: {
    alignSelf: "flex-start",
    backgroundColor: "#052E16",
    borderWidth: 1,
    borderColor: "rgba(16, 185, 129, 0.45)",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 5,
    marginBottom: 12
  },
  sovereigntyPillText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#10B981"
  },
  title: {
    fontSize: 26,
    fontWeight: "800",
    color: "#F8FAFC",
    marginBottom: 6
  },
  subtitle: {
    fontSize: 13,
    color: "#94A3B8",
    lineHeight: 19
  },
  errorBanner: {
    backgroundColor: "rgba(244, 63, 94, 0.15)",
    borderColor: "#F43F5E",
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 16
  },
  errorText: {
    color: "#F87171",
    fontSize: 13,
    fontWeight: "600"
  },
  authCard: {
    backgroundColor: "#0F172A",
    borderColor: "#1E293B",
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
    marginBottom: 16
  },
  cardEyebrow: {
    fontSize: 10,
    fontWeight: "800",
    color: "#38BDF8",
    letterSpacing: 0.7,
    marginBottom: 4
  },
  cardTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#F8FAFC",
    marginBottom: 6
  },
  cardDescription: {
    fontSize: 12,
    color: "#94A3B8",
    lineHeight: 18,
    marginBottom: 14
  },
  statusSubtitle: {
    fontSize: 11,
    fontWeight: "600",
    lineHeight: 16,
    marginBottom: 12
  },
  statusConfigured: {
    color: "#10B981"
  },
  statusUnconfigured: {
    color: "#FBBF24"
  },
  walletBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#161F30",
    borderWidth: 1,
    borderColor: "#334155",
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 7,
    marginBottom: 12,
    alignSelf: "flex-start"
  },
  walletBadgeLabel: {
    fontSize: 11,
    fontWeight: "600",
    color: "#94A3B8"
  },
  walletBadgeValue: {
    fontSize: 12,
    fontFamily: "monospace",
    fontWeight: "700",
    color: "#38BDF8"
  },
  primaryButton: {
    backgroundColor: "#38BDF8",
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center"
  },
  primaryButtonText: {
    fontSize: 14,
    fontWeight: "800",
    color: "#082F49"
  },
  secondaryButton: {
    backgroundColor: "#1E293B",
    borderWidth: 1,
    borderColor: "#334155",
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: "center",
    marginTop: 10
  },
  secondaryButtonText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#38BDF8"
  },
  metamaskButton: {
    backgroundColor: "#F59E0B",
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center"
  },
  metamaskButtonText: {
    fontSize: 14,
    fontWeight: "800",
    color: "#451A03"
  },
  walletConnectButton: {
    backgroundColor: "#10B981",
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center"
  },
  walletConnectButtonText: {
    fontSize: 14,
    fontWeight: "800",
    color: "#052E16"
  },
  footerNote: {
    fontSize: 11,
    color: "#64748B",
    textAlign: "center",
    lineHeight: 16,
    marginTop: 4
  },
  buttonDisabled: {
    opacity: 0.55
  },
  buttonPressed: {
    opacity: 0.78
  }
});
