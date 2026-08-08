-- Fail-closed grading: an item with no answer key is UNGRADABLE, not wrong.
--
-- Driven by the past-paper import: most institutional question papers are
-- published without their answer key, and the alternative to a nullable key was
-- forcing the importer to invent one. Once an invented answer is a plain string
-- it is indistinguishable from a verified one — on medical content, the worst
-- thing this system could ship.
--
-- All three statements are additive and backwards-compatible:
--   * dropping NOT NULL widens what the column accepts; no existing row changes.
--   * both new columns have defaults (or are nullable), so no table rewrite of
--     existing data is required beyond adding the column.
-- Safe to apply while the app is serving.

-- 1. The answer key becomes optional.
ALTER TABLE "questions" ALTER COLUMN "correct_answer" DROP NOT NULL;

-- 2. How much to trust a model-supplied key, 0..1. NULL = a human entered it,
--    which is the trusted case (bank upload, admin). Present = inferred and
--    awaiting review via the existing draft -> review -> published gate.
ALTER TABLE "questions" ADD COLUMN "answer_confidence" DOUBLE PRECISION;

-- 3. Whether the item carried a key at submission time. Stored rather than
--    re-derived because a key can be filled in later, and a historical attempt
--    must keep the meaning it had when it was taken — the same reason
--    mastery_attempts.threshold is snapshotted.
--
--    DEFAULT true is correct for every existing row: until this migration, a
--    question could not exist without an answer key.
ALTER TABLE "session_answers" ADD COLUMN "gradable" BOOLEAN NOT NULL DEFAULT true;
