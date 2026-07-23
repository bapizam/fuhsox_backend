-- Knowledge-component graph (reformation Phase 4, Workstream A).
--
-- The learner model has until now been a bag of independent per-objective EWMAs:
-- it could record that a student failed "Cardiac Output" and had no representation
-- in which that failure could point anywhere else. These two tables are the
-- missing relation. A KnowledgeComponent is the shared node several objectives can
-- point at; a KCEdge is "this must be understood first". Together they let a failed
-- check produce a direction ("Membrane Potentials isn't solid — start there")
-- instead of a dead end.
--
-- Design notes carried from the Phase 4 handoff:
--
-- 1. learning_objectives.kc_id is NULLABLE and stays that way. An objective with no
--    KC behaves EXACTLY as it did before this migration — no diagnosis, no
--    degradation. That is the same compatibility story the FSRS columns told in
--    20260723140000, and it is why there is no backfill here either.
--
-- 2. The mapping is objective→KC, deliberately NOT item→KC. Items live in Mongo and
--    objectives in Postgres, so an item-level map would be a cross-store relation
--    bought for a grain nothing can consume yet. Item→KC is a later refinement,
--    descoped on purpose.
--
-- 3. KCs are institution-scoped, not per-user: the prerequisite structure of a
--    subject is a property of the subject. Only p_known is personal, and it is
--    derived per user at read time from mastery_attempts — so BKT adds no write
--    path and nothing that can fall out of sync.
--
-- 4. knowledge_components has a UNIQUE (institution_id, subject, name). Without it
--    every generation pass would mint another "Membrane potentials" and the graph
--    would never actually connect to itself.
--
-- 5. kc_edges must stay ACYCLIC. That is enforced in application code
--    (utils/kc-graph.ts `wouldCreateCycle` on insert, plus a depth-bounded read),
--    not by a constraint — Postgres cannot express reachability in a CHECK. The
--    read-time depth bound is the second guard, because one guard against a hang is
--    not a guard.
--
-- Purely additive: no existing column, constraint or row is altered or dropped.

-- AlterTable
ALTER TABLE "learning_objectives" ADD COLUMN     "kc_id" TEXT;

-- CreateTable
CREATE TABLE "knowledge_components" (
    "id" TEXT NOT NULL,
    "institution_id" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "curated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kc_edges" (
    "id" TEXT NOT NULL,
    "from_kc_id" TEXT NOT NULL,
    "to_kc_id" TEXT NOT NULL,
    "strength" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "curated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kc_edges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "learning_objectives_kc_id_idx" ON "learning_objectives"("kc_id");

-- CreateIndex
CREATE INDEX "knowledge_components_institution_id_subject_idx" ON "knowledge_components"("institution_id", "subject");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_components_institution_id_subject_name_key" ON "knowledge_components"("institution_id", "subject", "name");

-- CreateIndex
CREATE INDEX "kc_edges_to_kc_id_idx" ON "kc_edges"("to_kc_id");

-- CreateIndex
CREATE UNIQUE INDEX "kc_edges_from_kc_id_to_kc_id_key" ON "kc_edges"("from_kc_id", "to_kc_id");

-- AddForeignKey
ALTER TABLE "learning_objectives" ADD CONSTRAINT "learning_objectives_kc_id_fkey" FOREIGN KEY ("kc_id") REFERENCES "knowledge_components"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kc_edges" ADD CONSTRAINT "kc_edges_from_kc_id_fkey" FOREIGN KEY ("from_kc_id") REFERENCES "knowledge_components"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kc_edges" ADD CONSTRAINT "kc_edges_to_kc_id_fkey" FOREIGN KEY ("to_kc_id") REFERENCES "knowledge_components"("id") ON DELETE CASCADE ON UPDATE CASCADE;
