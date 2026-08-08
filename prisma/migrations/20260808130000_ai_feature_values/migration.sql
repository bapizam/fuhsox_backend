-- AI cost attribution, part 1 of 2: the new `AIFeature` members.
--
-- SPLIT FROM THE COLUMN MIGRATION ON PURPOSE. Postgres will not let a value
-- added to an enum be USED in the same transaction that adds it, and Prisma
-- wraps each migration in one. Adding the members here and writing rows that
-- reference them only after this migration has committed is what keeps the
-- deploy from failing on the first request.
--
-- Enum members cannot be dropped again, so each of these is a durable, distinct
-- feature rather than a label for an experiment. Chapter ordering is
-- deliberately NOT here: it is one step of building a study plan, so it stays
-- under `study_plan`.

ALTER TYPE "AIFeature" ADD VALUE IF NOT EXISTS 'syllabus_extraction';
ALTER TYPE "AIFeature" ADD VALUE IF NOT EXISTS 'objective_generation';
ALTER TYPE "AIFeature" ADD VALUE IF NOT EXISTS 'answer_grading';
ALTER TYPE "AIFeature" ADD VALUE IF NOT EXISTS 'remediation';
ALTER TYPE "AIFeature" ADD VALUE IF NOT EXISTS 'kc_proposal';
ALTER TYPE "AIFeature" ADD VALUE IF NOT EXISTS 'question_import';
