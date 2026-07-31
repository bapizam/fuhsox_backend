/**
 * Seed ONE sample blog and ONE sample campus event, per institution.
 *
 * Deliberately separate from `prisma/seed.ts`, which wipes the database before
 * it writes. That is right for a fresh dev box and catastrophic against the
 * deployed backend — this script only ever INSERTS, and skips anything already
 * present, so it is safe to run on production and safe to run twice.
 *
 *   npm run seed:feed
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/** Title used to detect a previous run — re-running must not duplicate. */
const SAMPLE_BLOG_TITLE = 'Welcome to your campus feed';
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
              'don\'t have to go looking for them.</p>',
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
