-- Cold-start placement check (single-subject study plan, Phase 1).
--
-- A short, RAG-grounded diagnostic taken BEFORE a plan is generated, so the plan
-- is ordered by where the student actually stands rather than by chapter order.
--
-- `chapter_placements` is deliberately separate from `mastery_attempts`: it holds
-- ONE item per chapter, which is far too thin to be mastery evidence. Keeping it
-- out of the learner model is what stops a 1-item estimate reaching
-- `examReadiness` and the BKT graph.

-- New session mode. Placement reuses the whole quiz machinery (grading, offline
-- queue, results screen) exactly as mastery_check does.
ALTER TYPE "SessionMode" ADD VALUE 'placement';

CREATE TABLE "chapter_placements" (
    "id"          TEXT NOT NULL,
    "user_id"     TEXT NOT NULL,
    "resource_id" TEXT NOT NULL,
    "node_id"     TEXT NOT NULL,
    "session_id"  TEXT NOT NULL,
    "correct"     BOOLEAN NOT NULL,
    "confidence"  INTEGER,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chapter_placements_pkey" PRIMARY KEY ("id")
);

-- One standing placement per chapter — retaking replaces the old answer.
CREATE UNIQUE INDEX "chapter_placements_user_id_node_id_key"
    ON "chapter_placements"("user_id", "node_id");

CREATE INDEX "chapter_placements_user_id_resource_id_idx"
    ON "chapter_placements"("user_id", "resource_id");

ALTER TABLE "chapter_placements"
    ADD CONSTRAINT "chapter_placements_node_id_fkey"
    FOREIGN KEY ("node_id") REFERENCES "syllabus_nodes"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
