// ============================================================================
// DeHealth Protocol MVP - E2E Testing Suite: Tier 3 & Tier 4
// File: contracts/test/e2e/DeHealthE2E_Tier3_Tier4.test.ts
// ============================================================================

import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import {
  WorkoutProof,
  TelemetryData,
  UserProfile,
  WORKOUT_PROOF_EIP712_TYPES,
  createDeHealthDomain,
  WorkoutProofSchema,
  SignedWorkoutClaimPayloadSchema,
  AnonymizedFeedInsertSchema,
  PeerCheerInsertSchema
} from "@dehealth/shared";
import {
  hashTelemetry,
  signWorkoutProof,
  verifyWorkoutProofSignature
} from "../../../mobile/src/services/cryptoService";
import {
  calculateBaselineTarget,
  scaleTargetForInactivityGap,
  evaluateDailyTarget,
  FATIGUE_SCALING_MULTIPLIER
} from "../../../mobile/src/services/profileEngine";
import { EncryptedStorageAdapter } from "../../../mobile/src/storage/encryptedStorageAdapter";

describe("DeHealth Protocol E2E Testing: Tier 3 & Tier 4", function () {
  // --------------------------------------------------------------------------
  // SHARED FIXTURE: Deploy Contracts, Authorize Gate, and Setup Wallets
  // --------------------------------------------------------------------------
  async function deployDeHealthProtocolFixture() {
    const [deployer, userAlex, userJordan, userSam, attacker, peerUser] =
      await ethers.getSigners();

    // 1. Deploy DeHealthToken ($DHT)
    const TokenFactory = await ethers.getContractFactory("DeHealthToken");
    const token = await TokenFactory.deploy(deployer.address);
    await token.waitForDeployment();
    const tokenAddress = await token.getAddress();

    // 2. Deploy DeHealthRewardGate
    const GateFactory = await ethers.getContractFactory("DeHealthRewardGate");
    const gate = await GateFactory.deploy(tokenAddress, deployer.address);
    await gate.waitForDeployment();
    const gateAddress = await gate.getAddress();

    // 3. Authorize Gate to mint $DHT
    await token.connect(deployer).setAuthorizedMinter(gateAddress, true);

    // 4. Resolve Dynamic Chain ID
    const network = await ethers.provider.getNetwork();
    const chainId = Number(network.chainId);

    const domain = createDeHealthDomain(gateAddress as `0x${string}`, chainId);
    const types = {
      WorkoutProof: WORKOUT_PROOF_EIP712_TYPES.WorkoutProof.map((f) => ({
        name: f.name,
        type: f.type
      }))
    };

    return {
      token,
      gate,
      tokenAddress,
      gateAddress,
      deployer,
      userAlex,
      userJordan,
      userSam,
      attacker,
      peerUser,
      network,
      chainId,
      domain,
      types
    };
  }

  // ==========================================================================
  // TIER 3: PAIRWISE CROSS-FEATURE COMBINATIONS
  // ==========================================================================
  describe("Tier 3: Pairwise Cross-Feature Combinations", function () {
    // ------------------------------------------------------------------------
    // T3-1: Full Cryptographic Verification Flow
    // ------------------------------------------------------------------------
    it("T3-1: executes full cryptographic pipeline (mobile Keccak-256 -> EIP-712 sign -> Solidity Gate -> ERC20 mint)", async function () {
      const { token, gate, gateAddress, chainId, userAlex } = await loadFixture(
        deployDeHealthProtocolFixture
      );

      const telemetry: TelemetryData = {
        timestampMs: 1731320000000,
        stepCount: 10450,
        activeMinutes: 52,
        avgHeartRateBpm: 142.5,
        caloriesBurnedKcal: 485.2,
        profileSnapshot: {
          age: 28,
          gender: "Female",
          bodyFatPct: 18.5,
          muscleMassKg: 52.0
        }
      };

      // 1. Mobile Keccak-256 Hashing
      const telemetryHash = hashTelemetry(telemetry);
      expect(telemetryHash).to.match(/^0x[a-fA-F0-9]{64}$/);

      // 2. Off-chain Proof Construction
      const latestBlockTime = await time.latest();
      const rawProof: WorkoutProof = {
        user: userAlex.address as `0x${string}`,
        telemetryHash: telemetryHash as `0x${string}`,
        streakCount: 1n,
        nonce: 0n,
        deadline: BigInt(latestBlockTime + 3600)
      };

      // 3. EIP-712 Typed Signing via ethers.js v6
      const signedPayload = await signWorkoutProof(
        userAlex,
        rawProof,
        gateAddress as `0x${string}`,
        chainId
      );

      // 4. Client-side signature pre-verification
      const clientVerified = verifyWorkoutProofSignature(
        signedPayload,
        gateAddress as `0x${string}`,
        chainId
      );
      expect(clientVerified).to.be.true;

      // 5. On-Chain Claim Execution
      const digest = await gate.hashWorkoutProof(signedPayload.proof);
      await expect(
        gate
          .connect(userAlex)
          .claimStreakReward(signedPayload.proof, signedPayload.signature)
      )
        .to.emit(gate, "StreakRewardClaimed")
        .withArgs(
          userAlex.address,
          telemetryHash,
          1n,
          0n,
          ethers.parseEther("10"),
          digest
        );

      // 6. Assert Token Minting and Gate State
      expect(await token.balanceOf(userAlex.address)).to.equal(
        ethers.parseEther("10")
      );
      expect(await gate.nonces(userAlex.address)).to.equal(1n);
      expect(await gate.executedHashes(digest)).to.be.true;
      expect(await gate.executedHashes(telemetryHash)).to.be.true;
    });

    // ------------------------------------------------------------------------
    // T3-2: Dual Replay Attack Resistance
    // ------------------------------------------------------------------------
    it("T3-2: enforces dual replay resistance (exact proof replay & same telemetryHash under different nonce)", async function () {
      const { gate, gateAddress, chainId, userAlex } = await loadFixture(
        deployDeHealthProtocolFixture
      );

      const latestTime = await time.latest();
      const telemetryHash = hashTelemetry({
        timestampMs: 1731320000000,
        stepCount: 8200,
        activeMinutes: 38,
        avgHeartRateBpm: 135.0,
        caloriesBurnedKcal: 390.0,
        profileSnapshot: {
          age: 30,
          gender: "Male",
          bodyFatPct: 16.0,
          muscleMassKg: 68.0
        }
      });

      // Part A: First legitimate claim
      const proof1: WorkoutProof = {
        user: userAlex.address as `0x${string}`,
        telemetryHash: telemetryHash as `0x${string}`,
        streakCount: 1n,
        nonce: 0n,
        deadline: BigInt(latestTime + 3600)
      };
      const signed1 = await signWorkoutProof(
        userAlex,
        proof1,
        gateAddress as `0x${string}`,
        chainId
      );
      await gate.connect(userAlex).claimStreakReward(signed1.proof, signed1.signature);

      // Part B: Replaying exact same proof reverts
      await expect(
        gate.connect(userAlex).claimStreakReward(signed1.proof, signed1.signature)
      ).to.be.revertedWithCustomError(gate, "SignatureReplay");

      // Part C: Replaying same telemetryHash under incremented nonce (nonce=1) reverts
      const proof2: WorkoutProof = {
        user: userAlex.address as `0x${string}`,
        telemetryHash: telemetryHash as `0x${string}`, // recycled telemetry
        streakCount: 2n,
        nonce: 1n,
        deadline: BigInt(latestTime + 7200)
      };
      const signed2 = await signWorkoutProof(
        userAlex,
        proof2,
        gateAddress as `0x${string}`,
        chainId
      );
      await expect(
        gate.connect(userAlex).claimStreakReward(signed2.proof, signed2.signature)
      ).to.be.revertedWithCustomError(gate, "SignatureReplay");
    });

    // ------------------------------------------------------------------------
    // T3-3: Signer Mismatch Rejection
    // ------------------------------------------------------------------------
    it("T3-3: rejects claim when signer does not match proof.user", async function () {
      const { gate, gateAddress, chainId, userAlex, attacker } = await loadFixture(
        deployDeHealthProtocolFixture
      );

      const latestTime = await time.latest();
      const telemetryHash = ethers.keccak256(ethers.toUtf8Bytes("telemetry-attacker"));

      const proof: WorkoutProof = {
        user: userAlex.address as `0x${string}`,
        telemetryHash: telemetryHash as `0x${string}`,
        streakCount: 1n,
        nonce: 0n,
        deadline: BigInt(latestTime + 3600)
      };

      // Attacker signs proof that specifies userAlex as recipient
      const forgedSigned = await signWorkoutProof(
        attacker,
        proof,
        gateAddress as `0x${string}`,
        chainId
      );

      await expect(
        gate.connect(attacker).claimStreakReward(forgedSigned.proof, forgedSigned.signature)
      )
        .to.be.revertedWithCustomError(gate, "InvalidSigner")
        .withArgs(userAlex.address, attacker.address);
    });

    // ------------------------------------------------------------------------
    // T3-4: Inbound Zod Schema Validation Pipeline -> Signing -> On-Chain Claim
    // ------------------------------------------------------------------------
    it("T3-4: sanitizes inbound payloads with Zod schemas and executes on-chain claim", async function () {
      const { gate, gateAddress, chainId, userAlex } = await loadFixture(
        deployDeHealthProtocolFixture
      );

      // Untrusted raw JSON input from external API or client storage
      const rawInbound = {
        user: userAlex.address,
        telemetryHash: ethers.keccak256(ethers.toUtf8Bytes("telemetry-raw-input")),
        streakCount: "3", // string input
        nonce: 0, // number input
        deadline: String((await time.latest()) + 3600)
      };

      // 1. Zod Schema Parsing & Type Coercion
      const sanitizedProof = WorkoutProofSchema.parse(rawInbound);
      expect(typeof sanitizedProof.streakCount).to.equal("bigint");
      expect(sanitizedProof.streakCount).to.equal(3n);
      expect(sanitizedProof.nonce).to.equal(0n);

      // 2. Off-chain EIP-712 Signing
      const signedPayload = await signWorkoutProof(
        userAlex,
        sanitizedProof,
        gateAddress as `0x${string}`,
        chainId
      );

      // 3. Validate Signed Payload Schema
      const validatedPayload = SignedWorkoutClaimPayloadSchema.parse(signedPayload);

      // 4. Execute on-chain
      await expect(
        gate.connect(userAlex).claimStreakReward(validatedPayload.proof, validatedPayload.signature)
      ).to.emit(gate, "StreakRewardClaimed");
    });

    // ------------------------------------------------------------------------
    // T3-5: ProfileEngine Fatigue Scaling -> Habit Trigger -> On-Chain Claim -> Feed
    // ------------------------------------------------------------------------
    it("T3-5: integrates profile fatigue scaling, habit claim, and feed record validation", async function () {
      const { gate, gateAddress, chainId, userAlex } = await loadFixture(
        deployDeHealthProtocolFixture
      );

      const profile: UserProfile = {
        age: 26,
        gender: "Female",
        bodyFatPct: 18.0,
        muscleMassKg: 55.0
      };

      const T0 = 1731320000000;
      const T1 = T0 + 52 * 3600 * 1000; // 52 hours later (>48h)

      // 1. Profile Engine Evaluation
      const targetEval = evaluateDailyTarget(profile, T0, T1);
      expect(targetEval.isFatigueScaled).to.be.true;
      expect(targetEval.scalingFactorApplied).to.equal(0.7);

      // 2. Habit Completion Meeting Adjusted Target
      const workoutTelemetry: TelemetryData = {
        timestampMs: T1,
        stepCount: targetEval.adjustedSteps + 200,
        activeMinutes: targetEval.adjustedActiveMinutes + 5,
        avgHeartRateBpm: 136.0,
        caloriesBurnedKcal: 360.0,
        profileSnapshot: profile
      };
      const telemetryHash = hashTelemetry(workoutTelemetry);

      // 3. On-chain Claim
      const proof: WorkoutProof = {
        user: userAlex.address as `0x${string}`,
        telemetryHash: telemetryHash as `0x${string}`,
        streakCount: 1n,
        nonce: 0n,
        deadline: BigInt((await time.latest()) + 3600)
      };
      const signed = await signWorkoutProof(
        userAlex,
        proof,
        gateAddress as `0x${string}`,
        chainId
      );
      await gate.connect(userAlex).claimStreakReward(signed.proof, signed.signature);

      // 4. Supabase Feed Insert Validation
      const feedPayload = {
        user_pseudonym: "alex_rebound",
        proof_hash: telemetryHash,
        streak_count: 1
      };
      const parsedFeed = AnonymizedFeedInsertSchema.parse(feedPayload);
      expect(parsedFeed.user_pseudonym).to.equal("alex_rebound");
      expect(parsedFeed.proof_hash).to.equal(telemetryHash);
    });
  });

  // ==========================================================================
  // TIER 4: REAL-WORLD APPLICATION SCENARIOS
  // ==========================================================================
  describe("Tier 4: Real-World Application Scenarios", function () {
    // ------------------------------------------------------------------------
    // Scenario T4-1: Day 1 Habit Onboarding User Journey
    // ------------------------------------------------------------------------
    it("Scenario T4-1: executes complete Day 1 Habit Onboarding user journey", async function () {
      const { token, gate, gateAddress, chainId, userAlex } = await loadFixture(
        deployDeHealthProtocolFixture
      );

      // Step 1: User Profile Registration & Target Calculation
      const alexProfile: UserProfile = {
        age: 25,
        gender: "Male",
        bodyFatPct: 15.0,
        muscleMassKg: 65.0
      };
      const baseline = calculateBaselineTarget(alexProfile);
      expect(baseline.fitnessTier).to.equal("high-output");
      expect(baseline.baselineSteps).to.equal(10500); // 10k + 500 (<30y)
      expect(baseline.baselineActiveMinutes).to.equal(45);

      // Step 1b: Local Encrypted Storage of Profile
      const inMemoryBackend = {
        map: new Map<string, string>(),
        async getItem(k: string) { return this.map.get(k) ?? null; },
        async setItem(k: string, v: string) { this.map.set(k, v); },
        async removeItem(k: string) { this.map.delete(k); }
      };
      const storage = new EncryptedStorageAdapter("PassphraseAlex123!", inMemoryBackend);
      await storage.setEncryptedItem("alex_profile", alexProfile);
      const retrievedProfile = await storage.getEncryptedItem<UserProfile>("alex_profile");
      expect(retrievedProfile).to.deep.equal(alexProfile);

      // Step 2: Day 1 Workout Completion
      const day1Telemetry: TelemetryData = {
        timestampMs: 1731320000000,
        stepCount: 11000,
        activeMinutes: 50,
        avgHeartRateBpm: 148.0,
        caloriesBurnedKcal: 530.0,
        profileSnapshot: alexProfile
      };
      const telemetryHash = hashTelemetry(day1Telemetry);

      // Step 3: Off-Chain Signing & Verification
      const proof: WorkoutProof = {
        user: userAlex.address as `0x${string}`,
        telemetryHash: telemetryHash as `0x${string}`,
        streakCount: 1n,
        nonce: 0n,
        deadline: BigInt((await time.latest()) + 3600)
      };
      const signed = await signWorkoutProof(
        userAlex,
        proof,
        gateAddress as `0x${string}`,
        chainId
      );

      // Step 4: Claim Streak Reward On-Chain
      await expect(gate.connect(userAlex).claimStreakReward(signed.proof, signed.signature))
        .to.emit(gate, "StreakRewardClaimed")
        .withArgs(
          userAlex.address,
          telemetryHash,
          1n,
          0n,
          ethers.parseEther("10"),
          await gate.hashWorkoutProof(signed.proof)
        );

      // Assert Day 1 Balance & Nonce
      expect(await token.balanceOf(userAlex.address)).to.equal(ethers.parseEther("10"));
      expect(await gate.nonces(userAlex.address)).to.equal(1n);

      // Step 5: Publish Feed Entry
      const feedEntry = AnonymizedFeedInsertSchema.parse({
        user_pseudonym: "alex_runner",
        proof_hash: telemetryHash,
        streak_count: 1
      });
      expect(feedEntry.user_pseudonym).to.equal("alex_runner");
    });

    // ------------------------------------------------------------------------
    // Scenario T4-2: Multi-Day Habit Progression (7 Consecutive Days)
    // ------------------------------------------------------------------------
    it("Scenario T4-2: executes 7-day habit progression accumulating 70 DHT across nonces 0..6", async function () {
      const { token, gate, gateAddress, chainId, userJordan } = await loadFixture(
        deployDeHealthProtocolFixture
      );

      const jordanProfile: UserProfile = {
        age: 32,
        gender: "Male",
        bodyFatPct: 17.0,
        muscleMassKg: 62.0
      };

      const startMs = 1731320000000;
      const claimedProofs: WorkoutProof[] = [];
      const claimedSignatures: string[] = [];

      // Iterate through 7 consecutive days
      for (let day = 1; day <= 7; day++) {
        // Advance time by 24h for each consecutive day
        if (day > 1) {
          await time.increase(86400);
        }

        const currentTimestampMs = startMs + (day - 1) * 86400 * 1000;
        const lastLogMs = day === 1 ? null : startMs + (day - 2) * 86400 * 1000;

        // Verify Inactivity Scaling: 24h gap is < 48h, so target is unscaled
        const fatigue = scaleTargetForInactivityGap(8000, lastLogMs, currentTimestampMs);
        expect(fatigue.isFatigueScaled).to.be.false;

        const dayTelemetry: TelemetryData = {
          timestampMs: currentTimestampMs,
          stepCount: 8500 + day * 100,
          activeMinutes: 40 + day,
          avgHeartRateBpm: 136 + (day % 4),
          caloriesBurnedKcal: 400 + day * 15,
          profileSnapshot: jordanProfile
        };

        const telemetryHash = hashTelemetry(dayTelemetry);
        const expectedNonce = BigInt(day - 1);
        const latestTime = await time.latest();

        const proof: WorkoutProof = {
          user: userJordan.address as `0x${string}`,
          telemetryHash: telemetryHash as `0x${string}`,
          streakCount: BigInt(day),
          nonce: expectedNonce,
          deadline: BigInt(latestTime + 3600)
        };

        const signed = await signWorkoutProof(
          userJordan,
          proof,
          gateAddress as `0x${string}`,
          chainId
        );

        claimedProofs.push(signed.proof);
        claimedSignatures.push(signed.signature);

        // Execute Claim
        await gate.connect(userJordan).claimStreakReward(signed.proof, signed.signature);

        // Assert Intermediate State
        expect(await gate.nonces(userJordan.address)).to.equal(BigInt(day));
        expect(await token.balanceOf(userJordan.address)).to.equal(
          ethers.parseEther(String(day * 10))
        );
      }

      // Assert Final 7-Day State: 70 DHT accumulated
      expect(await token.balanceOf(userJordan.address)).to.equal(
        ethers.parseEther("70")
      );
      expect(await gate.nonces(userJordan.address)).to.equal(7n);

      // Verify that replaying historical proofs is rejected
      for (let i = 0; i < 7; i++) {
        await expect(
          gate.connect(userJordan).claimStreakReward(claimedProofs[i]!, claimedSignatures[i]!)
        ).to.be.reverted;
      }

      // Explicitly test SignatureReplay custom error by attempting to reuse a historical telemetryHash with current deadline and current nonce
      const recycledProof: WorkoutProof = {
        user: userJordan.address as `0x${string}`,
        telemetryHash: claimedProofs[0]!.telemetryHash,
        streakCount: 8n,
        nonce: 7n,
        deadline: BigInt((await time.latest()) + 3600)
      };
      const recycledSigned = await signWorkoutProof(
        userJordan,
        recycledProof,
        gateAddress as `0x${string}`,
        chainId
      );
      await expect(
        gate.connect(userJordan).claimStreakReward(recycledSigned.proof, recycledSigned.signature)
      ).to.be.revertedWithCustomError(gate, "SignatureReplay");
    });

    // ------------------------------------------------------------------------
    // Scenario T4-3: Inactivity & Churn Recovery
    // ------------------------------------------------------------------------
    it("Scenario T4-3: recovers user after >48h inactivity with 30% threshold reduction and successful claim", async function () {
      const { token, gate, gateAddress, chainId, userSam } = await loadFixture(
        deployDeHealthProtocolFixture
      );

      const samProfile: UserProfile = {
        age: 35,
        gender: "Non-Binary",
        bodyFatPct: 24.0,
        muscleMassKg: 58.0
      };

      const T0 = 1731320000000;

      // Day 1: Normal initial claim
      const day1Telemetry: TelemetryData = {
        timestampMs: T0,
        stepCount: 8200,
        activeMinutes: 38,
        avgHeartRateBpm: 135.0,
        caloriesBurnedKcal: 390.0,
        profileSnapshot: samProfile
      };
      const day1Hash = hashTelemetry(day1Telemetry);
      const proof1: WorkoutProof = {
        user: userSam.address as `0x${string}`,
        telemetryHash: day1Hash as `0x${string}`,
        streakCount: 1n,
        nonce: 0n,
        deadline: BigInt((await time.latest()) + 3600)
      };
      const signed1 = await signWorkoutProof(
        userSam,
        proof1,
        gateAddress as `0x${string}`,
        chainId
      );
      await gate.connect(userSam).claimStreakReward(signed1.proof, signed1.signature);
      expect(await token.balanceOf(userSam.address)).to.equal(ethers.parseEther("10"));

      // 72 Hours of Inactivity (3 days lapse)
      await time.increase(72 * 3600);
      const T1 = T0 + 72 * 3600 * 1000;

      // ProfileEngine Evaluation detects gap and decrements target by 30%
      const evaluation = evaluateDailyTarget(samProfile, T0, T1);
      expect(evaluation.isFatigueScaled).to.be.true;
      expect(evaluation.hoursSinceLastLog).to.equal(72.0);
      expect(evaluation.scalingFactorApplied).to.equal(FATIGUE_SCALING_MULTIPLIER);
      expect(evaluation.adjustedSteps).to.equal(Math.round(8000 * 0.7)); // 5600 steps

      // Sam completes recovery workout exceeding the 5,600 steps scaled target
      const recoveryTelemetry: TelemetryData = {
        timestampMs: T1,
        stepCount: 5800,
        activeMinutes: 28,
        avgHeartRateBpm: 130.0,
        caloriesBurnedKcal: 290.0,
        profileSnapshot: samProfile
      };
      const recoveryHash = hashTelemetry(recoveryTelemetry);

      // Submit recovery claim with nonce=1n and streakCount=1n (streak reset)
      const recoveryProof: WorkoutProof = {
        user: userSam.address as `0x${string}`,
        telemetryHash: recoveryHash as `0x${string}`,
        streakCount: 1n,
        nonce: 1n,
        deadline: BigInt((await time.latest()) + 3600)
      };
      const recoverySigned = await signWorkoutProof(
        userSam,
        recoveryProof,
        gateAddress as `0x${string}`,
        chainId
      );

      await gate
        .connect(userSam)
        .claimStreakReward(recoverySigned.proof, recoverySigned.signature);

      // Verify balance increased to 20 DHT and nonce incremented to 2
      expect(await token.balanceOf(userSam.address)).to.equal(ethers.parseEther("20"));
      expect(await gate.nonces(userSam.address)).to.equal(2n);
    });

    // ------------------------------------------------------------------------
    // Scenario T4-4: Social Feed & Peer Cheers
    // ------------------------------------------------------------------------
    it("Scenario T4-4: simulates anonymized social feed, peer cheers, and FK cascade lifecycle", async function () {
      await loadFixture(deployDeHealthProtocolFixture);

      // Generate proof hashes for userAlex and userJordan
      const hashA = ethers.keccak256(ethers.toUtf8Bytes("proof-alex"));
      const hashB = ethers.keccak256(ethers.toUtf8Bytes("proof-jordan"));

      // 1. Validate Feed Records Insertion
      const feedA = AnonymizedFeedInsertSchema.parse({
        user_pseudonym: "athlete_alex",
        proof_hash: hashA,
        streak_count: 5
      });
      const feedB = AnonymizedFeedInsertSchema.parse({
        user_pseudonym: "athlete_jordan",
        proof_hash: hashB,
        streak_count: 12
      });

      // Simulated Database Tables with Cascade Deletion Logic
      const mockDb = {
        anonymized_feed: new Map<string, typeof feedA & { id: string }>(),
        peer_cheers: new Map<string, { id: string; feed_id: string; sender: string }>()
      };

      const feedIdA = "11111111-1111-4111-8111-111111111111";
      const feedIdB = "22222222-2222-4222-8222-222222222222";
      mockDb.anonymized_feed.set(feedIdA, { id: feedIdA, ...feedA });
      mockDb.anonymized_feed.set(feedIdB, { id: feedIdB, ...feedB });

      // 2. Validate Peer Cheers
      const cheer1 = PeerCheerInsertSchema.parse({
        feed_id: feedIdA,
        sender_pseudonym: "peer_cheerer"
      });
      const cheer2 = PeerCheerInsertSchema.parse({
        feed_id: feedIdA,
        sender_pseudonym: "athlete_jordan"
      });
      const cheer3 = PeerCheerInsertSchema.parse({
        feed_id: feedIdB,
        sender_pseudonym: "athlete_alex"
      });

      const cheerId1 = "33333333-3333-4333-8333-333333333331";
      const cheerId2 = "33333333-3333-4333-8333-333333333332";
      const cheerId3 = "33333333-3333-4333-8333-333333333333";
      mockDb.peer_cheers.set(cheerId1, { id: cheerId1, feed_id: cheer1.feed_id, sender: cheer1.sender_pseudonym });
      mockDb.peer_cheers.set(cheerId2, { id: cheerId2, feed_id: cheer2.feed_id, sender: cheer2.sender_pseudonym });
      mockDb.peer_cheers.set(cheerId3, { id: cheerId3, feed_id: cheer3.feed_id, sender: cheer3.sender_pseudonym });

      expect(mockDb.peer_cheers.size).to.equal(3);

      // 3. RLS & Schema Boundary Checks: Reject Invalid Inserts
      expect(() =>
        AnonymizedFeedInsertSchema.parse({
          user_pseudonym: "al", // too short (<3)
          proof_hash: hashA,
          streak_count: 1
        })
      ).to.throw();

      expect(() =>
        AnonymizedFeedInsertSchema.parse({
          user_pseudonym: "valid_name",
          proof_hash: "0xnotvalidhex", // invalid bytes32
          streak_count: 1
        })
      ).to.throw();

      expect(() =>
        PeerCheerInsertSchema.parse({
          feed_id: "not-a-uuid",
          sender_pseudonym: "valid_cheerer"
        })
      ).to.throw();

      // 4. Simulate Foreign Key Cascade Deletion: Delete feedIdA
      mockDb.anonymized_feed.delete(feedIdA);
      // Cascade delete in mockDb matching `ON DELETE CASCADE`
      for (const [id, cheer] of mockDb.peer_cheers.entries()) {
        if (cheer.feed_id === feedIdA) {
          mockDb.peer_cheers.delete(id);
        }
      }

      // Assert cheer1 and cheer2 deleted, cheer3 retained
      expect(mockDb.peer_cheers.has(cheerId1)).to.be.false;
      expect(mockDb.peer_cheers.has(cheerId2)).to.be.false;
      expect(mockDb.peer_cheers.has(cheerId3)).to.be.true;
      expect(mockDb.peer_cheers.size).to.equal(1);
    });
  });
});
