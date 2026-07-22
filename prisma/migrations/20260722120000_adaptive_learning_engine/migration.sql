-- Adaptive learning engine (M7 item 4, phase 7D-a).
--
-- Adds the learner model behind evidence-based progress: a student's own
-- materials (learning_resources) are parsed into a structure (syllabus_nodes)
-- that yields granular learning_objectives, each advanced only by a recorded
-- mastery_attempts row. Assessments reuse quiz_sessions via the new
-- SessionMode value, so no parallel assessment tables are introduced.
--
-- Purely additive: no existing column or row is altered except the new
-- institutions.mastery_threshold default.

-- CreateEnum
CREATE TYPE "ResourceKind" AS ENUM ('textbook', 'notes', 'pdf', 'outline', 'past_questions', 'video_playlist');

-- CreateEnum
CREATE TYPE "ObjectiveState" AS ENUM ('not_started', 'learning', 'practicing', 'verified', 'mastered');

-- CreateEnum
CREATE TYPE "BloomLevel" AS ENUM ('remember', 'understand', 'apply', 'analyze', 'evaluate', 'create');

-- AlterEnum
-- Postgres 12+ permits ADD VALUE inside a transaction as long as the new value
-- is not USED in the same transaction. Nothing below references it.
ALTER TYPE "SessionMode" ADD VALUE 'mastery_check';

-- AlterTable
ALTER TABLE "institutions" ADD COLUMN "mastery_threshold" DOUBLE PRECISION NOT NULL DEFAULT 0.9;

-- CreateTable
CREATE TABLE "learning_resources" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "institution_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" "ResourceKind" NOT NULL,
    "file_url" TEXT,
    "source_url" TEXT,
    "course_code" TEXT,
    "parse_status" "ParseStatus" NOT NULL DEFAULT 'processing',
    "parse_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "learning_resources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "syllabus_nodes" (
    "id" TEXT NOT NULL,
    "resource_id" TEXT NOT NULL,
    "parent_id" TEXT,
    "title" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "page_start" INTEGER,
    "page_end" INTEGER,

    CONSTRAINT "syllabus_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "learning_objectives" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "resource_id" TEXT,
    "node_id" TEXT,
    "subject" TEXT NOT NULL,
    "statement" TEXT NOT NULL,
    "bloom_level" "BloomLevel" NOT NULL DEFAULT 'understand',
    "state" "ObjectiveState" NOT NULL DEFAULT 'not_started',
    "mastery_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "weak_concepts" TEXT[],
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "last_attempt_at" TIMESTAMP(3),
    "last_verified_at" TIMESTAMP(3),
    "next_review_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "learning_objectives_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mastery_attempts" (
    "id" TEXT NOT NULL,
    "objective_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "session_id" TEXT,
    "score_percent" DOUBLE PRECISION NOT NULL,
    "threshold" DOUBLE PRECISION NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "weak_concepts" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mastery_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "learning_resources_user_id_created_at_idx" ON "learning_resources"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "syllabus_nodes_resource_id_ordinal_idx" ON "syllabus_nodes"("resource_id", "ordinal");

-- CreateIndex
CREATE INDEX "syllabus_nodes_parent_id_idx" ON "syllabus_nodes"("parent_id");

-- CreateIndex
CREATE INDEX "learning_objectives_user_id_state_idx" ON "learning_objectives"("user_id", "state");

-- CreateIndex
CREATE INDEX "learning_objectives_user_id_next_review_at_idx" ON "learning_objectives"("user_id", "next_review_at");

-- CreateIndex
CREATE INDEX "learning_objectives_node_id_idx" ON "learning_objectives"("node_id");

-- CreateIndex
CREATE INDEX "mastery_attempts_objective_id_created_at_idx" ON "mastery_attempts"("objective_id", "created_at");

-- CreateIndex
CREATE INDEX "mastery_attempts_user_id_created_at_idx" ON "mastery_attempts"("user_id", "created_at");

-- AddForeignKey
ALTER TABLE "learning_resources" ADD CONSTRAINT "learning_resources_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "syllabus_nodes" ADD CONSTRAINT "syllabus_nodes_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "learning_resources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "syllabus_nodes" ADD CONSTRAINT "syllabus_nodes_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "syllabus_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_objectives" ADD CONSTRAINT "learning_objectives_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_objectives" ADD CONSTRAINT "learning_objectives_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "learning_resources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_objectives" ADD CONSTRAINT "learning_objectives_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "syllabus_nodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mastery_attempts" ADD CONSTRAINT "mastery_attempts_objective_id_fkey" FOREIGN KEY ("objective_id") REFERENCES "learning_objectives"("id") ON DELETE CASCADE ON UPDATE CASCADE;
