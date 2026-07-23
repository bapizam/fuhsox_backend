-- Exam outcomes (adaptive-engine reformation, Phase 2 — measurement honesty).
--
-- The adaptive engine's loop is closed: AI writes the questions, AI supplies the
-- answer key, the student is scored against it, and a heuristic emits
-- `exam_readiness = coverage × depth`. Nothing in that loop has ever been checked
-- against a real exam result, so the readiness figure could be systematically
-- over- or under-confident and no one would know.
--
-- This table is the first outside signal: a grade the student reports themselves.
-- Self-reported grades are noisy; they are still the only ground truth available,
-- and a noisy real signal beats a loop that never touches reality.
--
-- `predicted_readiness` snapshots what the model said AT REPORTING TIME, because
-- readiness decays — recomputing it later would answer a different question than
-- "what did we actually tell this student?".
--
-- Collection only. The calibration model that compares predictions against these
-- grades is a later phase. Purely additive: no existing table, column or row is
-- touched.

-- CreateTable
CREATE TABLE "exam_outcomes" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "institution_id" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "course_code" TEXT,
    "score_percent" DOUBLE PRECISION NOT NULL,
    "grade_label" TEXT,
    "exam_date" TIMESTAMP(3) NOT NULL,
    "predicted_readiness" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exam_outcomes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "exam_outcomes_user_id_exam_date_idx" ON "exam_outcomes"("user_id", "exam_date");

-- CreateIndex
CREATE INDEX "exam_outcomes_institution_id_exam_date_idx" ON "exam_outcomes"("institution_id", "exam_date");

-- AddForeignKey
ALTER TABLE "exam_outcomes" ADD CONSTRAINT "exam_outcomes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
