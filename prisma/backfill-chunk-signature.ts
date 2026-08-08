/**
 * Stamp pre-tracking `ResourceChunk` rows with the embedding that produced them.
 *
 * Chunks written before embedding-provenance tracking carry no
 * `embedding_model` / `embedding_dim`. `matchesSignature` already treats those as
 * `LEGACY_SIGNATURE`, so retrieval is CORRECT without this script — it exists to
 * make the fact explicit in the data rather than inferred at read time, which is
 * what lets the legacy branch eventually be deleted.
 *
 * Idempotent: only touches rows missing the fields, so re-running is a no-op.
 * Safe to run while the app is serving.
 *
 *   npm run db:backfill:chunk-signature
 *   npm run db:backfill:chunk-signature -- --dry-run
 */

import mongoose from 'mongoose';
import { env } from '@config/env';
import { ResourceChunk } from '../mongo/schemas';
import { LEGACY_SIGNATURE } from '@lib/retrieval';
import { EMBEDDING_MODEL, EMBEDDING_DIM } from '@lib/embeddings';

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');

  if (EMBEDDING_MODEL !== LEGACY_SIGNATURE.model || EMBEDDING_DIM !== LEGACY_SIGNATURE.dim) {
    // The current model has already moved on. Stamping unstamped chunks with the
    // LEGACY signature is still the truthful thing to do — they really were
    // produced by it — but they will read as unusable afterwards, which is the
    // point. Say so plainly rather than letting it look like a failed backfill.
    console.warn(
      `⚠ Current embedding (${EMBEDDING_MODEL}/${EMBEDDING_DIM}) differs from the legacy ` +
        `signature (${LEGACY_SIGNATURE.model}/${LEGACY_SIGNATURE.dim}).\n` +
        '  Backfilled chunks will be correctly marked unusable and those resources need re-ingesting.',
    );
  }

  await mongoose.connect(env.MONGODB_URI);

  const missing = { $or: [{ embedding_model: { $exists: false } }, { embedding_model: null }] };
  const total = await ResourceChunk.countDocuments(missing);

  if (total === 0) {
    console.log('✓ No unstamped chunks — nothing to backfill.');
    return;
  }

  console.log(`Found ${total} unstamped chunk(s).`);

  if (dryRun) {
    const sample = await ResourceChunk.find(missing, { resource_id: 1 }).limit(5).lean();
    console.log('Dry run — would stamp:', LEGACY_SIGNATURE);
    console.log('Sample resources:', [...new Set(sample.map((c) => c.resource_id))]);
    return;
  }

  const result = await ResourceChunk.updateMany(missing, {
    $set: {
      embedding_model: LEGACY_SIGNATURE.model,
      embedding_dim:   LEGACY_SIGNATURE.dim,
    },
  });

  console.log(`✓ Stamped ${result.modifiedCount} chunk(s) with`, LEGACY_SIGNATURE);

  const remaining = await ResourceChunk.countDocuments(missing);
  if (remaining > 0) {
    throw new Error(`${remaining} chunk(s) still unstamped after backfill`);
  }
}

main()
  .catch((err) => {
    console.error('Backfill failed:', err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
