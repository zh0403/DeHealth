import { Bytes32 } from "./eip712";

export interface UserProfile {
  readonly age: number;
  readonly gender: string;
  readonly bodyFatPct: number;
  readonly muscleMassKg: number;
}

export interface TelemetryData {
  readonly timestampMs: number;
  readonly stepCount: number;
  readonly activeMinutes: number;
  readonly avgHeartRateBpm: number;
  readonly caloriesBurnedKcal: number;
  readonly profileSnapshot: UserProfile;
}

export interface AnonymizedFeedRecord {
  readonly id: string;
  readonly user_pseudonym: string;
  readonly proof_hash: Bytes32;
  readonly streak_count: number;
  readonly created_at: string;
}

export interface PeerCheerRecord {
  readonly id: string;
  readonly feed_id: string;
  readonly sender_pseudonym: string;
  readonly created_at: string;
}
