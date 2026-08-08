-- AI cost attribution, part 2 of 2: the cost columns.
--
-- Separate migration from the enum members (see 20260808130000), which must
-- commit before any row can reference them.
--
-- `tokens_used` is deliberately kept rather than replaced by the split: the AI
-- budget counters and existing usage reads are built on it, and changing what an
-- existing column means is how a reporting bug becomes silent.

-- Input and output are priced differently on every model this service uses
-- (5x apart on Claude, ~8x on Gemini), so a combined total cannot price a call.
ALTER TABLE "ai_usage_logs" ADD COLUMN "input_tokens"  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ai_usage_logs" ADD COLUMN "output_tokens" INTEGER NOT NULL DEFAULT 0;

-- NULL means "no known rate for this model", NOT "free" — see lib/ai-cost.
-- Historical rows keep NULL because their token split was never recorded, so
-- their cost genuinely cannot be reconstructed. That is the honest value.
ALTER TABLE "ai_usage_logs" ADD COLUMN "cost_usd" DOUBLE PRECISION;

-- Spend-by-feature is the query this whole change exists to make answerable.
CREATE INDEX "ai_usage_logs_institution_id_feature_created_at_idx"
  ON "ai_usage_logs"("institution_id", "feature", "created_at");
