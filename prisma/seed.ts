/**
 * prisma/seed.ts — destructive purge. Empties every store; inserts nothing.
 *
 * This file used to be a development fixture: it wiped a hand-written list of
 * tables and recreated an institution, an admin and two demo students (Ada
 * Okonkwo, Chukwuemeka Eze) with three months of invented history. Because it is
 * wired into the Render build command, that fixture replaced production on every
 * deploy — see the 2026-07-22 build log.
 *
 * The fixture is gone. What is left is the wipe, made total and made honest about
 * what it is. Two things about the old wipe were wrong quite apart from where it
 * ran:
 *
 * 1. It named 22 tables by hand against a schema that had grown to 30, so
 *    device_push_tokens, learning_resources, syllabus_nodes, learning_objectives,
 *    knowledge_components, kc_edges, mastery_attempts and exam_outcomes quietly
 *    survived a "clear existing data". A hand-maintained list drifts from the
 *    schema the moment anyone adds a model, and nothing fails when it does. The
 *    table list is now derived from Prisma's DMMF — exactly the models the
 *    generated client knows about — so it cannot go stale again.
 *
 * 2. It never touched MongoDB, where posts, comments, direct messages, AI
 *    feedback, generated questions, resource chunks, micro-lessons and study plans
 *    live. Roughly half of a user's data survived every "wipe".
 *
 * `_prisma_migrations` is deliberately NOT truncated: it is not part of the
 * datamodel, so DMMF never returns it. Dropping it would strand the database —
 * Prisma would try to re-apply every migration against a schema that already has
 * them.
 *
 * Collections are emptied rather than dropped so their indexes survive; a dropped
 * collection loses its index definitions until the app next re-declares them.
 */

import { PrismaClient, Prisma } from '@prisma/client';
import mongoose from 'mongoose';

const prisma = new PrismaClient();

// ─── Guard ─────────────────────────────────────────────────────────────────────

/**
 * This script destroys data and nothing else, and it sits in the Render build
 * command — so the guard is the only thing standing between an ordinary deploy and
 * an empty production database.
 *
 * Exits 0, not 1: the build command chains on `&&`, so a non-zero exit would turn a
 * correctly-skipped purge into a failed deploy.
 */
function purgeIsAllowed(): boolean {
  if (process.env.ALLOW_DESTRUCTIVE_SEED === 'true') return true;
  return process.env.NODE_ENV !== 'production';
}

// ─── Postgres ──────────────────────────────────────────────────────────────────

/** Physical table names, straight from the generated client's datamodel. */
function tableNames(): string[] {
  return Prisma.dmmf.datamodel.models.map((m) => m.dbName ?? m.name);
}

/**
 * Exact row counts before the truncate, so the log records what was actually
 * destroyed. One round trip rather than one query per table, and worth the effort
 * precisely because the operation cannot be undone.
 */
async function countRows(tables: string[]): Promise<Array<{ table: string; count: number }>> {
  const union = tables
    .map((t) => `SELECT '${t}' AS table_name, COUNT(*)::bigint AS n FROM "${t}"`)
    .join(' UNION ALL ');

  const rows = await prisma.$queryRawUnsafe<Array<{ table_name: string; n: bigint }>>(union);

  return rows
    .map((r) => ({ table: r.table_name, count: Number(r.n) }))
    .sort((a, b) => b.count - a.count || a.table.localeCompare(b.table));
}

async function purgePostgres(): Promise<number> {
  const tables = tableNames();
  const before = await countRows(tables);
  const total = before.reduce((sum, r) => sum + r.count, 0);

  for (const { table, count } of before) {
    if (count > 0) console.log(`   ${String(count).padStart(7)}  ${table}`);
  }
  if (total === 0) console.log('   (already empty)');

  // One statement with CASCADE: Postgres resolves the foreign-key ordering itself,
  // which a hand-ordered sequence of deletes has to get right by hand and silently
  // fails to when a new relation appears.
  const quoted = tables.map((t) => `"${t}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE;`);

  return total;
}

// ─── Mongo ─────────────────────────────────────────────────────────────────────

async function purgeMongo(): Promise<number> {
  const uri = process.env.MONGODB_URI;

  if (!uri) {
    console.log('   ⚠️  MONGODB_URI is not set — skipping Mongo, it was NOT emptied.');
    return 0;
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });

  try {
    const db = mongoose.connection.db;
    if (!db) {
      console.log('   ⚠️  No Mongo database handle — skipping, it was NOT emptied.');
      return 0;
    }

    // Enumerated from the live database rather than from the schema module, so
    // collections written by earlier versions of the app are cleared too.
    const collections = await db.collections();
    let total = 0;

    for (const collection of collections) {
      const name = collection.collectionName;
      if (name.startsWith('system.')) continue;

      const { deletedCount } = await collection.deleteMany({});
      total += deletedCount;
      if (deletedCount > 0) console.log(`   ${String(deletedCount).padStart(7)}  ${name}`);
    }

    if (total === 0) console.log('   (already empty)');
    return total;
  } finally {
    await mongoose.disconnect();
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n🗑️  Purging every store. Nothing will be re-inserted.\n');

  console.log('PostgreSQL:');
  const pgRows = await purgePostgres();

  console.log('\nMongoDB:');
  const mongoDocs = await purgeMongo();

  console.log(
    `\n✅ Done — ${pgRows} Postgres row(s) and ${mongoDocs} Mongo document(s) destroyed.`,
  );
  console.log(
    '   The database is empty. Registration needs an institution row, so the API\n' +
      '   will reject sign-ups until one exists.\n',
  );
}

if (!purgeIsAllowed()) {
  console.log(
    '⏭️  Skipping destructive purge: NODE_ENV=production.\n' +
      '   Set ALLOW_DESTRUCTIVE_SEED=true to override — this DELETES ALL DATA.',
  );
  process.exit(0);
}

main()
  .catch((err) => {
    console.error('\n❌ Purge failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
