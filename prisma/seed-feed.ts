/**
 * Seed sample feed content, per institution: two blogs and one campus event.
 *
 * Deliberately separate from `prisma/seed.ts`, which wipes the database before
 * it writes. That is right for a fresh dev box and catastrophic against the
 * deployed backend — this script only ever INSERTS, and skips anything already
 * present, so it is safe to run on production and safe to run twice.
 *
 * **Cover images are left null on purpose.** `cover_image_url` is supported on
 * all three (blogs, events, news) and the client renders the photo when it is
 * set — but seeding a URL would mean pointing at somebody else's image host, and
 * a dead link renders worse than no link. The card is designed for both: without
 * a photo it draws a tinted masthead carrying the kind's icon. Set the field
 * through the admin API to see the photo variant.
 *
 *   npm run seed:feed
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/** Titles used to detect a previous run — re-running must not duplicate. */
const SAMPLE_BLOG_TITLE = 'Welcome to your campus feed';
const SAMPLE_TIPS_TITLE = 'Three ways to make revision stick';
const SAMPLE_EVENT_TITLE = 'Semester study clinic';

async function main() {
  const institutions = await prisma.institution.findMany({ select: { id: true, name: true } });
  if (institutions.length === 0) {
    console.log('No institutions found — nothing to seed.');
    return;
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

    const existingEvent = await prisma.event.findFirst({
      where: { institution_id: institution.id, title: SAMPLE_EVENT_TITLE },
    });

    if (existingEvent) {
      console.log(`· ${institution.name}: sample event already there`);
      continue;
    }

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
}

main()
  .catch((err) => {
    console.error('Feed seed failed:', err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
