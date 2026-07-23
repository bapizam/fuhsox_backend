-- FSRS scheduling + metacognitive confidence (reformation Phase 3).
--
-- 1. FSRS card state on learning_objectives (`ts-fsrs`, MIT).
--
--    Replaces a flat 3-then-14-day review rule applied identically to every
--    objective with per-item scheduling driven by that objective's own observed
--    stability and difficulty FOR THIS STUDENT. `next_review_at` keeps its meaning
--    and everything that reads it (effectiveState, revisionPriority,
--    due_for_review) is untouched — the scheduling POLICY moved, the schedule's
--    representation did not.
--
--    Every column is nullable or defaulted, so existing objectives keep working
--    with no backfill: a row with a NULL fsrs_stability is rebuilt from an empty
--    FSRS card on its next attempt.
--
-- 2. session_answers.confidence — the student's own 1-5 claim, captured BEFORE the
--    verdict is revealed.
--
--    Deliberately distinct from learning_objectives.confidence, which is a
--    variance-of-recent-scores proxy the SYSTEM infers. This is what the student
--    SAYS, and the gap between the two is the calibration signal. NULL on every
--    historical row and wherever the question isn't asked.
--
-- Purely additive: no existing column or row is altered.

-- AlterTable
ALTER TABLE "learning_objectives" ADD COLUMN     "fsrs_difficulty" DOUBLE PRECISION,
ADD COLUMN     "fsrs_lapses" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "fsrs_last_review" TIMESTAMP(3),
ADD COLUMN     "fsrs_reps" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "fsrs_stability" DOUBLE PRECISION,
ADD COLUMN     "fsrs_state" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "session_answers" ADD COLUMN     "confidence" INTEGER;
