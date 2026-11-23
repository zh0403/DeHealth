# DeHealth Protocol — Project Architecture & Invariants

## Monorepo Layout & Key Modules
- `contracts/`: Solidity smart contracts (`DeHealthToken.sol`, `DeHealthRewardGate.sol`) & Hardhat E2E suites.
- `shared/`: Pure TypeScript types, physiological formulas, and strict Zod schemas (`@dehealth/shared` — `profile.ts`, `schemas.ts`).
- `mobile/`: Expo / React Native client (`@dehealth/mobile`):
  - `App.tsx` & `src/index.ts`: Root state machine, global `ErrorNoticeModal`, and barrel exports.
  - `src/services/`: `l2ContractService.ts` (EIP-712 signing, L2 gas pre-check), `supabaseService.ts` (zero-egress feed & peer cheers), `authService.ts` (Google/MetaMask/WalletConnect/Local sessions), `clipboardService.ts`, `sensorService.ts`.
  - `src/storage/`: `walletStorage.ts` (FIFO-queued `SecureStore` keys), `vaultKeyProvider.ts` (AES-GCM vault key), `adaptiveStorage.ts` (encrypted cycles, weight logs, daily ephemeral log buffer), `governanceStorage.ts`.
  - `src/screens/` & `src/components/`: `LoginScreen.tsx`, `OnboardingWizardScreen.tsx`, `PlanPreviewModal.tsx`, `DashboardScreen.tsx`, `MicroCheckInScreen.tsx`, `AnonymizedFeedScreen.tsx`, `AdminGovernanceModal.tsx`, `ErrorNoticeModal.tsx`.
- `supabase/`: PostgreSQL migrations (`001_initial_schema.sql`, `002_single_cheer_per_post.sql`) & RLS policies.

## Domain-Specific Invariants (CRITICAL)
1. **Zero-Egress Data Sovereignty:** Never transmit raw biometrics, weights, meals, calorie logs, or step counts over the network or persist them in plaintext. Validate outbound payloads with `assertZeroRawBiometrics` and strict Zod schemas; only salted Keccak-256 hashes, EIP-712 signatures, and pseudonymous feed rows may leave the device.
2. **Ephemeral Daily Log Purge:** Raw daily food, exercise, and step logs accumulate strictly in encrypted local storage (`DailyEphemeralLogBuffer`) and must purge immediately upon daily proof signing or next-day rollover.
3. **Mobile Runtime Compatibility:** Use `expo-clipboard` (via `clipboardService.ts`) and `expo-secure-store` abstractions rather than web-only globals without native fallbacks.

## Workspace Verification Commands
- **Targeted mobile test:** `npx vitest run <path-to-test-file>` (run from `mobile/`)
- **Full single-pass gate:** `npm run lint && npm run typecheck:tests && npm run build && npm test`