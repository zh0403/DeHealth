-- Migration: 002_single_cheer_per_post.sql
-- Description: Deduplicate existing peer_cheers rows and enforce a single cheer per (feed_id, sender_pseudonym)

-- Deduplicate any existing rows in peer_cheers keeping the earliest row per (feed_id, sender_pseudonym)
DELETE FROM peer_cheers a
USING peer_cheers b
WHERE a.feed_id = b.feed_id
  AND a.sender_pseudonym = b.sender_pseudonym
  AND (
    a.created_at > b.created_at
    OR (a.created_at = b.created_at AND a.id > b.id)
  );

-- Enforce unique (feed_id, sender_pseudonym) constraint idempotently
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'peer_cheers_feed_id_sender_pseudonym_key'
      AND conrelid = 'peer_cheers'::regclass
  ) THEN
    ALTER TABLE peer_cheers ADD CONSTRAINT peer_cheers_feed_id_sender_pseudonym_key UNIQUE (feed_id, sender_pseudonym);
  END IF;
END
$$;
