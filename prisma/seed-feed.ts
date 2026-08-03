/**
 * Seed sample feed content, per institution: three blogs, one campus event, and
 * a handful of student posts.
 *
 * Deliberately separate from `prisma/seed.ts`, which wipes the database before
 * it writes. That is right for a fresh dev box and catastrophic against the
 * deployed backend — this script only ever INSERTS, and skips anything already
 * present, so it is safe to run on production and safe to run twice.
 *
 * **One blog carries a cover image.** This file used to leave every
 * `cover_image_url` null, reasoning that pointing at somebody else's image host
 * risked a dead link, and a dead link renders worse than no link. The second
 * half of that is no longer true: `FeedArticleCard` handles `onError` by falling
 * back to the same tinted icon masthead it draws when the field is null, so a
 * link that dies degrades to exactly the old behaviour. Without a seeded cover
 * the photo variant had never been seen outside the admin API.
 *
 * Point `SEED_COVER_IMAGE_URL` at your own bucket to use a first-party asset.
 *
 *   npm run seed:feed
 */
import { PrismaClient } from '@prisma/client';
import mongoose from 'mongoose';

const prisma = new PrismaClient();

/** Titles used to detect a previous run — re-running must not duplicate. */
const SAMPLE_BLOG_TITLE = 'Welcome to your campus feed';
const SAMPLE_TIPS_TITLE = 'Three ways to make revision stick';
const SAMPLE_PHOTO_TITLE = 'Inside the new reading room';
const SAMPLE_EVENT_TITLE = 'Semester study clinic';

/**
 * Cover for the illustrated sample. Overridable so a deployment can serve its
 * own file rather than a third party's; the card survives either way.
 */
const COVER_IMAGE_URL =
  process.env['SEED_COVER_IMAGE_URL'] ??
  'https://images.unsplash.com/photo-1521587760476-6c12a4b040da?w=1200&q=70&auto=format&fit=crop';

/**
 * Student posts, seeded into Mongo.
 *
 * The feed had never been seen with a coursemate's post in it — neither seed
 * wrote a single `Post`, so a fresh install always opened on "Quiet in here".
 * These are plain text by design: `PostCard` carries no image path and the Mongo
 * `Post` model has no media field, both deliberately.
 */
const SAMPLE_POSTS = [
  {
    content:
      'Anyone else find the second half of the pharmacology notes rougher than the first? ' +
      'Finally clicked once I started drawing the pathways out instead of re-reading them.',
    topic_tag: 'pharmacology',
  },
  {
    content:
      'Study clinic in the library on Thursday if anyone wants to go over past questions ' +
      'together. I will be the one surrounded by highlighters.',
    topic_tag: 'study-group',
  },
  {
    content:
      'Small win: got through a whole week of my plan without skipping a day. The trick was ' +
      'making the sessions shorter so I actually start them.',
    topic_tag: 'motivation',
  },
] as const;

async function main() {
  const institutions = await prisma.institution.findMany({ select: { id: true, name: true } });
  if (institutions.length === 0) {
    console.log('No institutions found — nothing to seed.');
    return;
  }

  // Best-effort: the blogs and the event are the substance of this seed and they
  // live in Postgres. An unreachable Mongo costs the sample posts, not the run.
  const mongoUri = process.env['MONGODB_URI'];
  if (mongoUri) {
    try {
      await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 10_000 });
    } catch {
      console.log('· Mongo unreachable — skipping sample posts.');
    }
  } else {
    console.log('· MONGODB_URI not set — skipping sample posts.');
  }

  for (const institution of institutions) {
    // Blogs and events record an admin author. Fall back to any user so a fresh
    // institution with no admin yet still gets its sample content.
    const author =
      (await prisma.user.findFirst({
        where:  { institution_id: institution.id, role: { in: ['admin', 'superadmin'] } },
        select: { id: true },
      })) ??
      (await prisma.user.findFirst({
        where:  { institution_id: institution.id },
        select: { id: true },
      }));

    if (!author) {
      console.log(`· ${institution.name}: no users yet, skipping`);
      continue;
    }

    const existingBlog = await prisma.blog.findFirst({
      where: { institution_id: institution.id, title: SAMPLE_BLOG_TITLE },
    });

    if (existingBlog) {
      console.log(`· ${institution.name}: sample blog already there`);
    } else {
      await prisma.blog.create({
        data: {
          institution_id: institution.id,
          created_by:     author.id,
          title:          SAMPLE_BLOG_TITLE,
          category:       'Getting started',
          excerpt:
            'Everything worth reading now lives in one place — campus events, posts from your ' +
            'coursemates, and short reads like this one.',
          body: [
            '<p>Hey — glad you\'re here. Here\'s what this feed is for.</p>',
            '<p><strong>Campus events</strong> show up here the moment they\'re announced, so you ' +
              'don\'t have to go looking for them. Tap one to see where and when.</p>',
            '<p><strong>News from the school</strong> lands here too, right where you already are.</p>',
            '<p><strong>Posts from your coursemates</strong> sit right alongside them. Ask a ' +
              'question, share what clicked for you, or just say how the week is going.</p>',
            '<p><strong>Short reads like this one</strong> come from the team — study tips, ' +
              'things worth knowing, the occasional heads-up.</p>',
            '<p>One more thing: badges you earn are yours to keep on your profile. We used to ' +
              'announce every single one here, which got noisy fast — so now your wins stay ' +
              'yours unless you feel like posting about them.</p>',
          ].join(''),
          status:       'published',
          published_at: new Date(),
        },
      });
      console.log(`✓ ${institution.name}: sample blog created`);
    }

    const existingTips = await prisma.blog.findFirst({
      where: { institution_id: institution.id, title: SAMPLE_TIPS_TITLE },
    });

    if (existingTips) {
      console.log(`· ${institution.name}: sample tips blog already there`);
    } else {
      await prisma.blog.create({
        data: {
          institution_id: institution.id,
          created_by:     author.id,
          title:          SAMPLE_TIPS_TITLE,
          category:       'Study tips',
          excerpt:
            'Nothing complicated, and nothing that needs a whole free weekend. Three habits ' +
            'that do more for your marks than another re-read ever will.',
          body: [
            '<p>Re-reading a chapter feels productive. It mostly is not — you recognise the ' +
              'words and mistake that for knowing the material. Here is what works better.</p>',
            '<p><strong>1. Close the book and try to answer first.</strong> Getting it wrong ' +
              'and then checking teaches you far more than reading the right answer twice. ' +
              'That is exactly what a mastery check is for.</p>',
            '<p><strong>2. Come back to it in a few days.</strong> Studying one topic for three ' +
              'hours is weaker than three sessions of one hour, spread out. Your plan already ' +
              'spaces things this way.</p>',
            '<p><strong>3. Notice what you keep getting wrong.</strong> One topic usually ' +
              'accounts for most of the lost marks. Fix that one and everything moves.</p>',
            '<p>Small and repeated beats heroic and once. That is the whole thing.</p>',
          ].join(''),
          status:       'published',
          // A little older, so the feed visibly has more than one day in it.
          published_at: new Date(Date.now() - 2 * 86400000),
        },
      });
      console.log(`✓ ${institution.name}: sample tips blog created`);
    }

    const existingPhoto = await prisma.blog.findFirst({
      where: { institution_id: institution.id, title: SAMPLE_PHOTO_TITLE },
    });

    if (existingPhoto) {
      console.log(`· ${institution.name}: sample illustrated blog already there`);
    } else {
      await prisma.blog.create({
        data: {
          institution_id:  institution.id,
          created_by:      author.id,
          title:           SAMPLE_PHOTO_TITLE,
          category:        'Campus',
          cover_image_url: COVER_IMAGE_URL,
          excerpt:
            'Longer opening hours, more desks, and power at every seat. Here is what changed ' +
            'and when you can use it.',
          body: [
            '<p>The reading room on the library\'s first floor reopened this week after a term ' +
              'of work, and it is worth a look even if you already had a favourite spot.</p>',
            '<p><strong>It is open later.</strong> Doors stay open until 10pm on weekdays and ' +
              '6pm at weekends, which covers the stretch most people actually revise in.</p>',
            '<p><strong>There are more desks, and they have power.</strong> Every seat now has ' +
              'a socket, so a dying laptop is no longer what ends your session.</p>',
            '<p><strong>Two rooms are bookable for groups.</strong> Ask at the desk — they go ' +
              'quickly in the fortnight before exams.</p>',
            '<p>Quiet floor rules still apply upstairs. If you want to talk through a problem ' +
              'with someone, the ground floor is the place for it.</p>',
          ].join(''),
          status:       'published',
          published_at: new Date(Date.now() - 86400000),
        },
      });
      console.log(`✓ ${institution.name}: sample illustrated blog created`);
    }

    const existingEvent = await prisma.event.findFirst({
      where: { institution_id: institution.id, title: SAMPLE_EVENT_TITLE },
    });

    if (existingEvent) {
      console.log(`· ${institution.name}: sample event already there`);
    } else {
      // A week out, so the sample never renders as already past.
      const eventDate = new Date(Date.now() + 7 * 86400000);
      eventDate.setHours(14, 0, 0, 0);

      await prisma.event.create({
        data: {
          institution_id:  institution.id,
          created_by:      author.id,
          title:           SAMPLE_EVENT_TITLE,
          description:
            'Bring whatever you are stuck on. Past-question walkthroughs, a quiet place to ' +
            'revise, and people to ask. Drop in for ten minutes or stay the afternoon.',
          event_date:      eventDate,
          location:        'Main Library, Study Hall B',
          target_audience: 'all',
          status:          'published',
          published_at:    new Date(),
        },
      });
      console.log(`✓ ${institution.name}: sample event created`);
    }

    await seedPosts(institution);
  }
}

/**
 * Sample student posts for one institution.
 *
 * Written through the raw Mongo driver rather than the app's Mongoose models:
 * those live behind the backend's TS path aliases, and a standalone seed script
 * should not have to boot that. The shape below is `PostSchema` in
 * `mongo/schemas` — keep it in step if that model gains a required field.
 *
 * Silently does nothing when Mongo is unreachable: the Postgres content above is
 * the point of this script, and losing three sample posts is not worth failing
 * a production run over.
 */
async function seedPosts(institution: { id: string; name: string }): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) return;

  // Prefer ordinary students — these read as coursemates, not announcements.
  const authors = await prisma.user.findMany({
    where:  { institution_id: institution.id, role: 'student' },
    select: { id: true },
    take:   SAMPLE_POSTS.length,
  });
  const fallback = await prisma.user.findFirst({
    where:  { institution_id: institution.id },
    select: { id: true },
  });

  if (authors.length === 0 && !fallback) return;

  const posts = db.collection('posts');
  let created = 0;

  for (const [i, sample] of SAMPLE_POSTS.entries()) {
    const existing = await posts.findOne({
      institution_id: institution.id,
      content:        sample.content,
    });
    if (existing) continue;

    const authorId = authors[i % Math.max(authors.length, 1)]?.id ?? fallback?.id;
    if (!authorId) continue;

    // Staggered by hours so the feed's date sort has something to do.
    const createdAt = new Date(Date.now() - (i + 1) * 5 * 3600000);

    await posts.insertOne({
      institution_id: institution.id,
      author_id:      authorId,
      type:           'post',
      content:        sample.content,
      topic_tag:      sample.topic_tag,
      likes:          [],
      comments_count: 0,
      is_deleted:     false,
      createdAt,
      updatedAt:      createdAt,
      __v:            0,
    });
    created += 1;
  }

  if (created > 0) console.log(`✓ ${institution.name}: ${created} sample post(s) created`);
  else console.log(`· ${institution.name}: sample posts already there`);
}

main()
  .catch((err) => {
    console.error('Feed seed failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  });
