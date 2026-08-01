-- Page-scoped objectives, and the placement self-rating that was never stored.
--
-- ── learning_objectives.page_start / page_end ────────────────────────────────
-- The planner now splits a long chapter across several reading days, and pairs
-- each day's reading with its own checkpoint. A chapter-wide mastery check is
-- the wrong question there: on the first day it asks about pages the student
-- has not opened, and by the last day it is asking the same questions again.
--
-- An objective carrying a page window is generated from — and tested on — only
-- the chunks inside that window.
--
-- NULL means "the whole chapter", which is what every existing row is and what
-- a chapter-level check still creates. Every read path treats NULL exactly as it
-- did before, so there is no backfill.
ALTER TABLE "learning_objectives" ADD COLUMN "page_start" INTEGER;
ALTER TABLE "learning_objectives" ADD COLUMN "page_end"   INTEGER;

-- Objectives are looked up by (node, window) when a check starts, so that the
-- second sitting of a chapter finds its own objectives rather than the first's.
CREATE INDEX "learning_objectives_node_id_page_start_page_end_idx"
    ON "learning_objectives"("node_id", "page_start", "page_end");

-- ── chapter_placements.confidence ────────────────────────────────────────────
-- The column was declared in the placement migration and written by nothing —
-- the same class of dead field `page_start` on syllabus_nodes was before
-- page-aware ingestion. The student IS asked how sure they are during the
-- placement check (it runs through the mastery-check runner, which collects a
-- 1–5 rating), and it lands on session_answers.confidence, but it never reached
-- here and the planner never saw a single self-rating.
--
-- Nothing to add structurally — this comment records that the column is now
-- actually populated by completePlacementCheck, and read by the plan grounding.
