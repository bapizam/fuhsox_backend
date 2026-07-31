-- Page-aware ingestion (single-subject study plan, Phase 0).
--
-- `SyllabusNode.page_start` / `page_end` already existed but were never written,
-- because PDF text extraction flattened the document and discarded page
-- boundaries. Extraction is now per-page, so chapters get real ranges — and the
-- LAST chapter's range needs the document length to close it.
--
-- Nullable with no default and no backfill: resources ingested before this
-- migration keep NULL and degrade to chapter-only reading guidance.
ALTER TABLE "learning_resources" ADD COLUMN "page_count" INTEGER;
