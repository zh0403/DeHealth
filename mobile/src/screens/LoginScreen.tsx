import { Address } from "@dehealth/shared";
import React, { useRef, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
import { isValidPrivateKey } from "../storage/walletStorage";

const ZERO_ADDRESS_REGEX = /^0x0{40}$/i;
const HEX_64_NO_PREFIX_REGEX = /^[0-9a-fA-F]{64}$/;
const HEX_64_UPPER_PREFIX_REGEX = /^0X[0-9a-fA-F]{64}$/;

/**
 * Trims a user-entered private key and ensures a canonical lowercase `0x`
 * prefix when 64 raw hex characters are supplied.
 */
export function normalizeWalletPrivateKey(raw: string): string {
  const trimmed = raw.trim();
  if (HEX_64_NO_PREFIX_REGEX.test(trimmed)) {
    return `0x${trimmed}`;
  }
  if (HEX_64_UPPER_PREFIX_REGEX.test(trimmed)) {
    return `0x${trimmed.slice(2)}`;
  }
  return trimmed;
}

function formatShortAddress(address: string): string {
  const trimmed = address.trim();
  if (trimmed.length >= 10) {
    return `${trimmed.slice(0, 6)}…${trimmed.slice(-4)}`;
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
  readonly onContinueWithWallet: (privateKey?: string) => Promise<void> | void;
  readonly isSupabaseConfigured?: boolean;
  readonly existingWalletAddress?: Address | null;
  readonly onError?: (error: unknown) => void;
}

type PendingAuthMethod = "google" | "wallet" | null;

export const LoginScreen: React.FC<LoginScreenProps> = ({
  onSignInWithGoogle,
  onContinueWithWallet,
  isSupabaseConfigured = false,
  existingWalletAddress = null,
  onError
}) => {
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [pendingMethod, setPendingMethod] = useState<PendingAuthMethod>(null);
  const [isImportingWallet, setIsImportingWallet] = useState<boolean>(false);
  const isSubmittingRef = useRef<boolean>(false);

  const [isImportExpanded, setIsImportExpanded] = useState<boolean>(false);
  const [keyInput, setKeyInput] = useState<string>("");
  const [inlineError, setInlineError] = useState<string | null>(null);

  const hasExistingWallet =
    typeof existingWalletAddress === "string" &&
    existingWalletAddress.trim().length > 0 &&
    !ZERO_ADDRESS_REGEX.test(existingWalletAddress.trim());

  const runAuthSubmission = async (
    method: Exclude<PendingAuthMethod, null>,
    action: () => Promise<void> | void,
    importingKey: boolean = false
  ): Promise<void> => {
    if (isSubmittingRef.current || isSubmitting) {
      return;
    }
    isSubmittingRef.current = true;
    setIsSubmitting(true);
    setPendingMethod(method);
    setIsImportingWallet(importingKey);
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
      setIsImportingWallet(false);
    }
  };

  const handleGoogleSignIn = (): void => {
    void runAuthSubmission("google", onSignInWithGoogle);
  };

  const handleContinueWallet = (): void => {
    void runAuthSubmission("wallet", () => onContinueWithWallet());
  };

  const handleImportWallet = (): void => {
    if (isSubmittingRef.current || isSubmitting) {
      return;
    }
    const normalized = normalizeWalletPrivateKey(keyInput);
    if (!isValidPrivateKey(normalized)) {
      setInlineError(
        "Invalid private key. Enter a 64-character hex key (with or without 0x prefix)."
      );
      return;
    }
    void runAuthSubmission(
      "wallet",
      () => onContinueWithWallet(normalized),
      true
    );
  };

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

      {/* Path 1: Google Sign-In */}
      <View style={styles.authCard}>
        <Text style={styles.cardEyebrow}>PATH 1 • ACCOUNT SIGN-IN</Text>
        <Text style={styles.cardTitle}>Sign in with Google</Text>
        <Text style={styles.cardDescription}>
          {isSupabaseConfigured
            ? "Authenticate via Google OAuth with automatic non-custodial L2 wallet provisioning on-device."
            : "Automatic non-custodial L2 wallet provisioning with local offline session support while cloud auth is unconfigured."}
        </Text>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Sign in with Google"
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
            {pendingMethod === "google"
              ? "Signing in with Google..."
              : "Sign in with Google"}
          </Text>
        </Pressable>
      </View>

      {/* Path 2: Non-Custodial Wallet */}
      <View style={styles.authCard}>
        <Text style={styles.cardEyebrow}>PATH 2 • NON-CUSTODIAL L2 WALLET</Text>
        <Text style={styles.cardTitle}>Arbitrum Sepolia Wallet</Text>
        <Text style={styles.cardDescription}>
          {hasExistingWallet && existingWalletAddress
            ? `Detected local vault wallet ${formatShortAddress(existingWalletAddress)}. Continue directly without cloud sign-in.`
            : "Create or unlock your local encrypted Arbitrum Sepolia signing wallet directly on-device."}
        </Text>

        {hasExistingWallet && existingWalletAddress ? (
          <View style={styles.walletBadge}>
            <Text style={styles.walletBadgeLabel}>Local Wallet:</Text>
            <Text style={styles.walletBadgeValue}>
              {formatShortAddress(existingWalletAddress)}
            </Text>
          </View>
        ) : null}

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Continue with Wallet"
          accessibilityState={{ disabled: isSubmitting }}
          testID="login-wallet-button"
          disabled={isSubmitting}
          style={({ pressed }) => [
            styles.secondaryButton,
            isSubmitting ? styles.buttonDisabled : null,
            pressed ? styles.buttonPressed : null
          ]}
          onPress={handleContinueWallet}
        >
          <Text style={styles.secondaryButtonText}>
            {pendingMethod === "wallet" && !isImportingWallet
              ? "Unlocking Wallet..."
              : "Continue with Wallet"}
          </Text>
        </Pressable>

        {/* Collapsible Private Key Import */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Import Private Key"
          accessibilityState={{
            expanded: isImportExpanded,
            disabled: isSubmitting
          }}
          testID="toggle-import-key-button"
          disabled={isSubmitting}
          style={({ pressed }) => [
            styles.toggleImportButton,
            pressed ? styles.buttonPressed : null
          ]}
          onPress={() => {
            setIsImportExpanded((prev) => !prev);
            setInlineError(null);
          }}
        >
          <Text style={styles.toggleImportButtonText}>
            {isImportExpanded ? "Hide Private Key Import" : "Import Private Key"}
          </Text>
        </Pressable>

        {isImportExpanded ? (
          <View style={styles.importPanel}>
            <Text style={styles.importLabel}>
              Ethereum / Arbitrum Sepolia Private Key (32-byte hex)
            </Text>
            <TextInput
              accessibilityLabel="Wallet Private Key Input"
              testID="import-private-key-input"
              value={keyInput}
              onChangeText={(value) => {
                setKeyInput(value);
                if (inlineError) {
                  setInlineError(null);
                }
              }}
              placeholder="0x... or 64 hex characters"
              placeholderTextColor="#64748B"
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              editable={!isSubmitting}
              style={styles.keyInput}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Import & Continue"
              accessibilityState={{ disabled: isSubmitting }}
              testID="login-import-wallet-button"
              disabled={isSubmitting}
              style={({ pressed }) => [
                styles.importSubmitButton,
                isSubmitting ? styles.buttonDisabled : null,
                pressed ? styles.buttonPressed : null
              ]}
              onPress={handleImportWallet}
            >
              <Text style={styles.importSubmitButtonText}>
                {pendingMethod === "wallet" && isImportingWallet
                  ? "Importing Wallet..."
                  : "Import & Continue"}
              </Text>
            </Pressable>
          </View>
        ) : null}
      </View>

      <Text style={styles.footerNote}>
        Private keys never leave encrypted hardware/OS storage. Zero raw
        biometrics, meals, weights, or step counts are ever uploaded.
      </Text>
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
    backgroundColor: "#10B981",
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
    marginBottom: 10
  },
  secondaryButtonText: {
    fontSize: 14,
    fontWeight: "800",
    color: "#052E16"
  },
  toggleImportButton: {
    paddingVertical: 8,
    alignItems: "center"
  },
  toggleImportButtonText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#38BDF8"
  },
  importPanel: {
    marginTop: 10,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: "#1E293B"
  },
  importLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: "#CBD5E1",
    marginBottom: 8
  },
  keyInput: {
    backgroundColor: "#161F30",
    borderColor: "#334155",
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    color: "#F8FAFC",
    fontSize: 13,
    fontFamily: "monospace",
    marginBottom: 10
  },
  importSubmitButton: {
    backgroundColor: "#1E293B",
    borderWidth: 1,
    borderColor: "#38BDF8",
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: "center"
  },
  importSubmitButtonText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#38BDF8"
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
