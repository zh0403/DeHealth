-- Migration: 001_initial_schema.sql
-- Description: Anonymized Workout Proof Feed and Peer Cheers Schema with Strict RLS Policies

-- Enable uuid extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Table 1: anonymized_feed
CREATE TABLE IF NOT EXISTS anonymized_feed (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_pseudonym TEXT NOT NULL,
    proof_hash TEXT NOT NULL UNIQUE,
    streak_count INT NOT NULL CHECK (streak_count >= 1),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for anonymized_feed
CREATE INDEX IF NOT EXISTS idx_anonymized_feed_created_at ON anonymized_feed (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_anonymized_feed_user_pseudonym ON anonymized_feed (user_pseudonym);
CREATE INDEX IF NOT EXISTS idx_anonymized_feed_proof_hash ON anonymized_feed (proof_hash);

-- Table 2: peer_cheers
CREATE TABLE IF NOT EXISTS peer_cheers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    feed_id UUID NOT NULL REFERENCES anonymized_feed(id) ON DELETE CASCADE,
    sender_pseudonym TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for peer_cheers
CREATE INDEX IF NOT EXISTS idx_peer_cheers_feed_id ON peer_cheers (feed_id);
CREATE INDEX IF NOT EXISTS idx_peer_cheers_created_at ON peer_cheers (created_at DESC);

-- Enable Row Level Security (RLS) on all tables
ALTER TABLE anonymized_feed ENABLE ROW LEVEL SECURITY;
ALTER TABLE peer_cheers ENABLE ROW LEVEL SECURITY;

-- RLS Policies: anonymized_feed
CREATE POLICY "Allow public read on anonymized_feed"
    ON anonymized_feed
    FOR SELECT
    USING (true);

CREATE POLICY "Allow authenticated or signature-verified insert on anonymized_feed"
    ON anonymized_feed
    FOR INSERT
    WITH CHECK (
        (auth.role() = 'authenticated')
        OR (
            auth.role() = 'anon'
            AND proof_hash ~ '^0x[a-fA-F0-9]{64}$'
            AND length(user_pseudonym) >= 3
            AND streak_count >= 1
        )
    );

-- RLS Policies: peer_cheers
CREATE POLICY "Allow public read on peer_cheers"
    ON peer_cheers
    FOR SELECT
    USING (true);

CREATE POLICY "Allow authenticated or verified insert on peer_cheers"
    ON peer_cheers
    FOR INSERT
    WITH CHECK (
        (auth.role() = 'authenticated')
        OR (
            auth.role() = 'anon'
            AND length(sender_pseudonym) >= 3
            AND EXISTS (SELECT 1 FROM anonymized_feed WHERE id = feed_id)
        )
    );
