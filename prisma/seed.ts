/**
 * prisma/seed.ts
 *
 * Rich development seed with two realistic student profiles:
 *
 * 👩‍⚕️  Ada Okonkwo   — "The Serious One"
 *    Final-year Medicine student. Studies daily, high streak, top badges,
 *    strong quiz accuracy. Platform-engaged for 3 months.
 *    → Tests: streak emails, badge notifications, leaderboard top rank,
 *             study reminder emails, re-engagement NOT triggered.
 *
 * 😴  Chukwuemeka Eze — "The Unserious One"
 *    Second-year student. Joined, did a few quizzes, then went quiet for
 *    18 days. Low XP, no streak, risk-flagged.
 *    → Tests: re-engagement email, risk-flag cron, no study reminders
 *             (no schedule), at-risk admin dashboard entry.
 *
 * They are connected, have exchanged messages, liked each other's posts.
 */

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

// ─── Helpers ───────────────────────────────────────────────────────────────────

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 86_400_000);
}

function hoursAgo(n: number): Date {
  return new Date(Date.now() - n * 3_600_000);
}

function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🌱 Seeding FuhsoX development database...\n');

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 1 — WIPE (child → parent order)
  // ══════════════════════════════════════════════════════════════════════════

  console.log('🗑️  Clearing existing data...');

  await prisma.userBadge.deleteMany({});
  await prisma.sessionAnswer.deleteMany({});
  await prisma.quizSession.deleteMany({});
  await prisma.bookmark.deleteMany({});
  await prisma.notification.deleteMany({});
  await prisma.notificationPref.deleteMany({});
  await prisma.studySchedule.deleteMany({});
  await prisma.connection.deleteMany({});
  await prisma.emailDelivery.deleteMany({});
  await prisma.broadcast.deleteMany({});
  await prisma.oTPRequest.deleteMany({});
  await prisma.refreshToken.deleteMany({});
  await prisma.aIUsageLog.deleteMany({});
  await prisma.pDFParseJob.deleteMany({});
  await prisma.question.deleteMany({});
  await prisma.newsArticle.deleteMany({});
  await prisma.event.deleteMany({});
  await prisma.badge.deleteMany({});
  // Study rooms reference the creating user WITHOUT an onDelete cascade, so they
  // must be cleared before users (participants cascade off the room, but delete
  // them explicitly to keep the child→parent order honest).
  await prisma.studyRoomParticipant.deleteMany({});
  await prisma.studyRoom.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.institution.deleteMany({});

  console.log('  ✅ Cleared\n');

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 2 — INSTITUTION
  // ══════════════════════════════════════════════════════════════════════════

  const fuhso = await prisma.institution.create({
    data: {
      name:           'Federal University of Health Sciences, Otukpo',
      slug:           'fuhso',
      email_domains:  ['fuhso.edu.ng', 'student.fuhso.edu.ng', 'gmail.com'],
      primary_color:  '#1a3c6e',
      timezone:       'Africa/Lagos',
      ai_daily_limit: 20,
    },
  });

  console.log(`✅ Institution: ${fuhso.name}`);

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 3 — BADGES
  // ══════════════════════════════════════════════════════════════════════════

  const [
    badgeFirstQuiz,
    badgeStreak7,
    badgeStreak30,
    badgeAccuracy90,
    badgePerfectScore,
    badgeQuizMaster50,
    badgeSocialConnector,
  ] = await Promise.all([
    prisma.badge.create({ data: { code: 'FIRST_QUIZ',       name: 'First Steps',       description: 'Completed your very first quiz.',                icon_url: 'https://cdn.fuhsox.ng/badges/first_quiz.png',      xp_award: 50  } }),
    prisma.badge.create({ data: { code: 'STREAK_7',         name: 'Week Warrior',       description: 'Maintained a 7-day study streak.',               icon_url: 'https://cdn.fuhsox.ng/badges/streak_7.png',        xp_award: 100 } }),
    prisma.badge.create({ data: { code: 'STREAK_30',        name: 'Iron Scholar',       description: 'Maintained a 30-day study streak.',              icon_url: 'https://cdn.fuhsox.ng/badges/streak_30.png',       xp_award: 500 } }),
    prisma.badge.create({ data: { code: 'ACCURACY_90',      name: 'Precision Mind',     description: 'Achieved 90% or above in a quiz session.',       icon_url: 'https://cdn.fuhsox.ng/badges/accuracy_90.png',    xp_award: 150 } }),
    prisma.badge.create({ data: { code: 'PERFECT_SCORE',    name: 'Perfect Score',      description: 'Scored 100% on a quiz. Flawless!',               icon_url: 'https://cdn.fuhsox.ng/badges/perfect_score.png',  xp_award: 200 } }),
    prisma.badge.create({ data: { code: 'QUIZ_MASTER_50',   name: 'Quiz Master',        description: 'Completed 50 quiz sessions.',                    icon_url: 'https://cdn.fuhsox.ng/badges/quiz_master_50.png', xp_award: 300 } }),
    prisma.badge.create({ data: { code: 'SOCIAL_CONNECTOR', name: 'Social Connector',   description: 'Reached 500 XP through consistent engagement.', icon_url: 'https://cdn.fuhsox.ng/badges/social_connector.png',xp_award: 0   } }),
  ]);

  console.log('✅ Badges seeded');

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 4 — ADMIN USER
  // ══════════════════════════════════════════════════════════════════════════

  const adminPasswordHash = await bcrypt.hash('FuhsoX_Admin@2025!', 10);

  const admin = await prisma.user.create({
    data: {
      institution_id: fuhso.id,
      email:          'admin@fuhso.edu.ng',
      full_name:      'FuhsoX Administrator',
      role:           'admin',
      auth_provider:  'email_otp',
      email_verified: true,
      password_hash:  adminPasswordHash,
      last_active_at: new Date(),
    },
  });

  console.log(`✅ Admin: ${admin.email}`);

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 5 — 👩‍⚕️ ADA OKONKWO — THE SERIOUS STUDENT
  // 3 months active, 45-day streak, 8500 XP, high accuracy
  // ══════════════════════════════════════════════════════════════════════════

  const ada = await prisma.user.create({
    data: {
      institution_id:   fuhso.id,
      email:            'ada.okonkwo@student.fuhso.edu.ng',
      full_name:        'Ada Okonkwo',
      faculty:          'Clinical Sciences',
      department:       'Medicine',
      bio:              'Final year Medicine student. Passionate about neurology and internal medicine. Studying hard for finals 💪',
      avatar_url:       'https://api.dicebear.com/7.x/avataaars/svg?seed=ada',
      role:             'student',
      auth_provider:    'email_otp',
      email_verified:   true,
      study_interests:  ['Anatomy', 'Physiology', 'Pharmacology', 'Pathology', 'Medicine'],
      xp_points:        8_500,
      streak_count:     45,
      last_active_at:   hoursAgo(2),            // Active 2 hours ago
      last_streak_date: hoursAgo(2),
      risk_flag:        false,
      created_at:       daysAgo(92),            // Joined 3 months ago
    },
  });

  // Ada's notification preferences — quiet hours, daily reminders
  await prisma.notificationPref.create({
    data: {
      user_id:            ada.id,
      opt_out_reminders:  false,
      quiet_hours_start:  '22:00',
      quiet_hours_end:    '06:00',
      reminder_frequency: 'daily',
    },
  });

  // Ada's study schedule — Medicine finals coming up in 30 days
  const adaSchedule = await prisma.studySchedule.create({
    data: {
      user_id:               ada.id,
      institution_id:        fuhso.id,
      subject:               'Medicine & Surgery',
      study_days:            [1, 2, 3, 4, 5],   // Mon–Fri
      preferred_time_start:  '18:00',
      preferred_time_end:    '21:00',
      exam_date:             new Date(Date.now() + 30 * 86_400_000),
      is_active:             true,
      sessions_planned:      60,
      sessions_completed:    45,                 // High adherence
    },
  });

  // Ada's badges — she's earned most of them
  await prisma.userBadge.createMany({
    data: [
      { user_id: ada.id, badge_id: badgeFirstQuiz.id,      awarded_at: daysAgo(90) },
      { user_id: ada.id, badge_id: badgeStreak7.id,        awarded_at: daysAgo(80) },
      { user_id: ada.id, badge_id: badgeStreak30.id,       awarded_at: daysAgo(55) },
      { user_id: ada.id, badge_id: badgeAccuracy90.id,     awarded_at: daysAgo(50) },
      { user_id: ada.id, badge_id: badgePerfectScore.id,   awarded_at: daysAgo(30) },
      { user_id: ada.id, badge_id: badgeQuizMaster50.id,   awarded_at: daysAgo(20) },
      { user_id: ada.id, badge_id: badgeSocialConnector.id,awarded_at: daysAgo(60) },
    ],
  });

  console.log(`✅ Ada Okonkwo (serious student): ${ada.email}`);

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 6 — 😴 CHUKWUEMEKA EZE — THE UNSERIOUS STUDENT
  // Joined 45 days ago, inactive for 18 days, risk-flagged
  // ══════════════════════════════════════════════════════════════════════════

  const emeka = await prisma.user.create({
    data: {
      institution_id:   fuhso.id,
      email:            'chukwuemeka.eze@student.fuhso.edu.ng',
      full_name:        'Chukwuemeka Eze',
      faculty:          'Basic Medical Sciences',
      department:       'Anatomy',
      bio:              'Year 2 Anatomy student. Still figuring things out 😅',
      avatar_url:       'https://api.dicebear.com/7.x/avataaars/svg?seed=emeka',
      role:             'student',
      auth_provider:    'email_otp',
      email_verified:   true,
      study_interests:  ['Anatomy', 'Biochemistry'],
      xp_points:        320,
      streak_count:     0,                       // Streak broken
      last_active_at:   daysAgo(18),             // 18 days inactive → re-engagement email
      last_streak_date: daysAgo(18),
      risk_flag:        true,                    // Flagged by risk cron
      risk_reason:      'Inactive for 18 days',
      created_at:       daysAgo(45),
    },
  });

  // Emeka has no notification preferences (uses defaults)
  // Emeka has no study schedule

  // Emeka only has the First Quiz badge
  await prisma.userBadge.create({
    data: { user_id: emeka.id, badge_id: badgeFirstQuiz.id, awarded_at: daysAgo(44) },
  });

  console.log(`✅ Chukwuemeka Eze (unserious student): ${emeka.email}`);

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 7 — QUESTIONS (20 realistic FUHSO exam questions)
  // ══════════════════════════════════════════════════════════════════════════

  const questions = await prisma.question.createManyAndReturn({
    data: [
      // ── Anatomy (5) ──────────────────────────────────────────────────────
      {
        institution_id: fuhso.id, created_by: admin.id, source: 'manual', status: 'published',
        course_code: 'ANA 201', course_name: 'Human Anatomy', faculty: 'Basic Medical Sciences', department: 'Anatomy',
        year: 2023, topic: 'Cardiovascular System', difficulty: 'easy', question_type: 'mcq',
        question_text: 'Which chamber of the heart pumps oxygenated blood into the systemic circulation?',
        options: [{ key:'A', text:'Right atrium' },{ key:'B', text:'Right ventricle' },{ key:'C', text:'Left atrium' },{ key:'D', text:'Left ventricle' }],
        correct_answer: 'D',
        explanation: 'The left ventricle pumps oxygenated blood received from the left atrium into the aorta, which then distributes it to the body via systemic circulation.',
      },
      {
        institution_id: fuhso.id, created_by: admin.id, source: 'manual', status: 'published',
        course_code: 'ANA 201', course_name: 'Human Anatomy', faculty: 'Basic Medical Sciences', department: 'Anatomy',
        year: 2022, topic: 'Nervous System', difficulty: 'medium', question_type: 'mcq',
        question_text: 'The blood-brain barrier is primarily formed by which cellular structure?',
        options: [{ key:'A', text:'Astrocyte end-feet' },{ key:'B', text:'Microglia' },{ key:'C', text:'Oligodendrocytes' },{ key:'D', text:'Ependymal cells' }],
        correct_answer: 'A',
        explanation: 'Astrocyte end-feet wrap around the endothelial cells of brain capillaries, contributing to the tight junctions that form the blood-brain barrier.',
      },
      {
        institution_id: fuhso.id, created_by: admin.id, source: 'manual', status: 'published',
        course_code: 'ANA 201', course_name: 'Human Anatomy', faculty: 'Basic Medical Sciences', department: 'Anatomy',
        year: 2023, topic: 'Musculoskeletal System', difficulty: 'medium', question_type: 'mcq',
        question_text: 'The rotator cuff is composed of four muscles. Which of the following is NOT a rotator cuff muscle?',
        options: [{ key:'A', text:'Supraspinatus' },{ key:'B', text:'Infraspinatus' },{ key:'C', text:'Deltoid' },{ key:'D', text:'Teres minor' }],
        correct_answer: 'C',
        explanation: 'The rotator cuff consists of SITS muscles: Supraspinatus, Infraspinatus, Teres minor, and Subscapularis. The deltoid is a large shoulder muscle but is NOT part of the rotator cuff.',
      },
      {
        institution_id: fuhso.id, created_by: admin.id, source: 'manual', status: 'published',
        course_code: 'ANA 301', course_name: 'Neuroanatomy', faculty: 'Basic Medical Sciences', department: 'Anatomy',
        year: 2022, topic: 'Cranial Nerves', difficulty: 'hard', question_type: 'mcq',
        question_text: 'A patient presents with loss of taste from the anterior two-thirds of the tongue and hyperacusis on the right side. Which cranial nerve is most likely injured?',
        options: [{ key:'A', text:'CN V3 (mandibular)' },{ key:'B', text:'CN VII (facial) — chorda tympani' },{ key:'C', text:'CN IX (glossopharyngeal)' },{ key:'D', text:'CN X (vagus)' }],
        correct_answer: 'B',
        explanation: 'The chorda tympani branch of CN VII carries taste from the anterior 2/3 of the tongue and parasympathetic fibres. It also carries the nerve to stapedius — damage causes hyperacusis (sound sensitivity) because the stapedius cannot dampen loud sounds.',
      },
      {
        institution_id: fuhso.id, created_by: admin.id, source: 'manual', status: 'published',
        course_code: 'ANA 201', course_name: 'Human Anatomy', faculty: 'Basic Medical Sciences', department: 'Anatomy',
        year: 2021, topic: 'Abdomen', difficulty: 'medium', question_type: 'mcq',
        question_text: 'McBurney\'s point, the classic site of maximal tenderness in acute appendicitis, is located at:',
        options: [{ key:'A', text:'2/3 of the way from the umbilicus to the right ASIS' },{ key:'B', text:'1/3 of the way from the right ASIS to the umbilicus' },{ key:'C', text:'1/3 of the way from the umbilicus to the right ASIS' },{ key:'D', text:'The midpoint of the right inguinal ligament' }],
        correct_answer: 'B',
        explanation: 'McBurney\'s point lies one-third of the way from the right anterior superior iliac spine (ASIS) to the umbilicus. This overlies the base of the appendix.',
      },
      // ── Physiology (5) ───────────────────────────────────────────────────
      {
        institution_id: fuhso.id, created_by: admin.id, source: 'manual', status: 'published',
        course_code: 'PHY 201', course_name: 'Human Physiology', faculty: 'Basic Medical Sciences', department: 'Physiology',
        year: 2023, topic: 'Renal Physiology', difficulty: 'medium', question_type: 'mcq',
        question_text: 'Glucose reabsorption in the nephron occurs primarily in the:',
        options: [{ key:'A', text:'Glomerulus' },{ key:'B', text:'Proximal convoluted tubule' },{ key:'C', text:'Loop of Henle' },{ key:'D', text:'Collecting duct' }],
        correct_answer: 'B',
        explanation: 'Approximately 100% of filtered glucose is reabsorbed in the proximal convoluted tubule via SGLT2 transporters. When plasma glucose exceeds ~180 mg/dL (renal threshold), these transporters are saturated and glycosuria occurs.',
      },
      {
        institution_id: fuhso.id, created_by: admin.id, source: 'manual', status: 'published',
        course_code: 'PHY 201', course_name: 'Human Physiology', faculty: 'Basic Medical Sciences', department: 'Physiology',
        year: 2022, topic: 'Cardiac Physiology', difficulty: 'medium', question_type: 'mcq',
        question_text: 'The Frank-Starling law of the heart states that:',
        options: [{ key:'A', text:'Heart rate increases with increased venous return' },{ key:'B', text:'Stroke volume increases with increased end-diastolic volume' },{ key:'C', text:'Cardiac output decreases with increased preload' },{ key:'D', text:'Contractility is directly proportional to heart rate' }],
        correct_answer: 'B',
        explanation: 'The Frank-Starling law states that within physiological limits, the heart pumps all blood returned to it: as end-diastolic volume (preload) increases, sarcomere length increases, producing greater force of contraction and higher stroke volume.',
      },
      {
        institution_id: fuhso.id, created_by: admin.id, source: 'manual', status: 'published',
        course_code: 'PHY 301', course_name: 'Clinical Physiology', faculty: 'Basic Medical Sciences', department: 'Physiology',
        year: 2023, topic: 'Respiratory Physiology', difficulty: 'hard', question_type: 'mcq',
        question_text: 'A patient has PaO2 = 55 mmHg, PaCO2 = 28 mmHg, pH = 7.52. What is the primary acid-base disturbance?',
        options: [{ key:'A', text:'Metabolic alkalosis' },{ key:'B', text:'Respiratory alkalosis' },{ key:'C', text:'Metabolic acidosis with respiratory compensation' },{ key:'D', text:'Respiratory acidosis' }],
        correct_answer: 'B',
        explanation: 'Elevated pH (alkalosis) with low PaCO2 (hypocapnia) indicates respiratory alkalosis — the primary driver is hyperventilation causing CO2 blow-off. The low PaO2 suggests hypoxia is driving the compensatory hyperventilation.',
      },
      {
        institution_id: fuhso.id, created_by: admin.id, source: 'manual', status: 'published',
        course_code: 'PHY 201', course_name: 'Human Physiology', faculty: 'Basic Medical Sciences', department: 'Physiology',
        year: 2021, topic: 'Endocrinology', difficulty: 'medium', question_type: 'mcq',
        question_text: 'Which hormone directly stimulates osteoclast activity, leading to increased bone resorption and elevated serum calcium?',
        options: [{ key:'A', text:'Calcitonin' },{ key:'B', text:'Parathyroid hormone (PTH)' },{ key:'C', text:'Vitamin D3 (calcitriol)' },{ key:'D', text:'Cortisol' }],
        correct_answer: 'B',
        explanation: 'PTH raises serum calcium by stimulating osteoclast-mediated bone resorption, increasing renal calcium reabsorption, and promoting renal activation of vitamin D. Calcitonin opposes this by inhibiting osteoclasts.',
      },
      {
        institution_id: fuhso.id, created_by: admin.id, source: 'manual', status: 'published',
        course_code: 'PHY 201', course_name: 'Human Physiology', faculty: 'Basic Medical Sciences', department: 'Physiology',
        year: 2022, topic: 'Neuromuscular Physiology', difficulty: 'easy', question_type: 'mcq',
        question_text: 'The neurotransmitter released at the neuromuscular junction is:',
        options: [{ key:'A', text:'Norepinephrine' },{ key:'B', text:'Dopamine' },{ key:'C', text:'Acetylcholine' },{ key:'D', text:'GABA' }],
        correct_answer: 'C',
        explanation: 'Acetylcholine (ACh) is released from motor neuron terminals at the neuromuscular junction and binds to nicotinic ACh receptors on the motor end plate, triggering muscle contraction.',
      },
      // ── Biochemistry (4) ─────────────────────────────────────────────────
      {
        institution_id: fuhso.id, created_by: admin.id, source: 'manual', status: 'published',
        course_code: 'BCH 201', course_name: 'Biochemistry', faculty: 'Basic Medical Sciences', department: 'Biochemistry',
        year: 2023, topic: 'Enzyme Kinetics', difficulty: 'medium', question_type: 'mcq',
        question_text: 'In Michaelis-Menten kinetics, the Km value represents:',
        options: [{ key:'A', text:'The maximum velocity of the reaction' },{ key:'B', text:'The substrate concentration at which V = ½ Vmax' },{ key:'C', text:'The equilibrium constant of product formation' },{ key:'D', text:'The minimum substrate concentration for the reaction' }],
        correct_answer: 'B',
        explanation: 'Km is the substrate concentration [S] at which reaction velocity equals exactly half of Vmax. Lower Km = higher enzyme affinity for the substrate. It is a fixed property of a given enzyme-substrate pair at defined conditions.',
      },
      {
        institution_id: fuhso.id, created_by: admin.id, source: 'manual', status: 'published',
        course_code: 'BCH 201', course_name: 'Biochemistry', faculty: 'Basic Medical Sciences', department: 'Biochemistry',
        year: 2022, topic: 'Carbohydrate Metabolism', difficulty: 'hard', question_type: 'mcq',
        question_text: 'A patient with glucose-6-phosphate dehydrogenase (G6PD) deficiency develops haemolytic anaemia after taking primaquine. The mechanism is best explained by:',
        options: [{ key:'A', text:'Impaired glycolysis reducing ATP for RBC survival' },{ key:'B', text:'Inability to regenerate NADPH, leading to oxidative damage to RBCs' },{ key:'C', text:'Increased sickling of haemoglobin S' },{ key:'D', text:'Direct haemolysis by primaquine as a toxin' }],
        correct_answer: 'B',
        explanation: 'G6PD is the rate-limiting enzyme of the pentose phosphate pathway, which generates NADPH. NADPH is essential for regenerating glutathione (GSH), which protects RBCs from oxidative damage. Without G6PD, primaquine-induced oxidative stress cannot be neutralised, causing haemolysis.',
      },
      {
        institution_id: fuhso.id, created_by: admin.id, source: 'manual', status: 'published',
        course_code: 'BCH 201', course_name: 'Biochemistry', faculty: 'Basic Medical Sciences', department: 'Biochemistry',
        year: 2023, topic: 'Protein Metabolism', difficulty: 'medium', question_type: 'mcq',
        question_text: 'Which vitamin is an essential cofactor for transaminase (aminotransferase) reactions?',
        options: [{ key:'A', text:'Vitamin B1 (thiamine)' },{ key:'B', text:'Vitamin B2 (riboflavin)' },{ key:'C', text:'Vitamin B6 (pyridoxal phosphate)' },{ key:'D', text:'Vitamin B12 (cobalamin)' }],
        correct_answer: 'C',
        explanation: 'Pyridoxal phosphate (PLP), the active form of vitamin B6, is the prosthetic group for all aminotransferases (transaminases). It accepts and donates amino groups, acting as an amino-group carrier during transamination reactions.',
      },
      {
        institution_id: fuhso.id, created_by: admin.id, source: 'manual', status: 'published',
        course_code: 'BCH 201', course_name: 'Biochemistry', faculty: 'Basic Medical Sciences', department: 'Biochemistry',
        year: 2021, topic: 'Lipid Metabolism', difficulty: 'medium', question_type: 'mcq',
        question_text: 'During prolonged starvation, the brain adapts to use which fuel source as its primary energy substrate?',
        options: [{ key:'A', text:'Free fatty acids' },{ key:'B', text:'Ketone bodies (acetoacetate and β-hydroxybutyrate)' },{ key:'C', text:'Glycerol' },{ key:'D', text:'Amino acids exclusively' }],
        correct_answer: 'B',
        explanation: 'After 3-4 days of starvation, the liver produces ketone bodies from fatty acid oxidation. The brain, which normally uses only glucose, adapts to use ketones (up to 75% of energy needs), significantly reducing muscle protein breakdown for gluconeogenesis.',
      },
      // ── Microbiology (3) ─────────────────────────────────────────────────
      {
        institution_id: fuhso.id, created_by: admin.id, source: 'manual', status: 'published',
        course_code: 'MIC 301', course_name: 'Microbiology', faculty: 'Basic Medical Sciences', department: 'Microbiology',
        year: 2023, topic: 'Bacterial Pathogenesis', difficulty: 'hard', question_type: 'mcq',
        question_text: 'A patient presents with profuse, rice-water, non-bloody diarrhoea after consuming contaminated water. The causative organism produces a toxin that permanently activates Gs-alpha. Identify it.',
        options: [{ key:'A', text:'Shigella dysenteriae' },{ key:'B', text:'Salmonella typhi' },{ key:'C', text:'Vibrio cholerae' },{ key:'D', text:'Clostridium difficile' }],
        correct_answer: 'C',
        explanation: 'Vibrio cholerae produces cholera toxin, which ADP-ribosylates the Gs-alpha subunit, constitutively activating adenylyl cyclase → massive cAMP accumulation → secretory diarrhoea. The characteristic "rice-water" stool contains no blood (non-invasive).',
      },
      {
        institution_id: fuhso.id, created_by: admin.id, source: 'manual', status: 'published',
        course_code: 'MIC 301', course_name: 'Microbiology', faculty: 'Basic Medical Sciences', department: 'Microbiology',
        year: 2022, topic: 'Antifungals', difficulty: 'medium', question_type: 'mcq',
        question_text: 'Amphotericin B exerts its antifungal effect by:',
        options: [{ key:'A', text:'Inhibiting fungal cell wall synthesis by blocking glucan synthase' },{ key:'B', text:'Binding ergosterol in the fungal membrane, creating pores' },{ key:'C', text:'Inhibiting lanosterol 14-α-demethylase, blocking ergosterol synthesis' },{ key:'D', text:'Disrupting fungal DNA replication' }],
        correct_answer: 'B',
        explanation: 'Amphotericin B binds directly to ergosterol (the primary fungal membrane sterol), creating transmembrane channels that increase membrane permeability, causing leakage of intracellular contents and cell death.',
      },
      {
        institution_id: fuhso.id, created_by: admin.id, source: 'manual', status: 'published',
        course_code: 'MIC 201', course_name: 'Medical Microbiology', faculty: 'Basic Medical Sciences', department: 'Microbiology',
        year: 2021, topic: 'Viral Hepatitis', difficulty: 'medium', question_type: 'mcq',
        question_text: 'Which hepatitis virus requires co-infection with Hepatitis B virus to replicate, as it uses HBsAg as its envelope protein?',
        options: [{ key:'A', text:'Hepatitis A' },{ key:'B', text:'Hepatitis C' },{ key:'C', text:'Hepatitis D (Delta agent)' },{ key:'D', text:'Hepatitis E' }],
        correct_answer: 'C',
        explanation: 'Hepatitis D virus (HDV) is a defective RNA virus — it is a satellite virus that requires HBsAg from Hepatitis B to assemble its own envelope. HDV can only infect patients who are already infected with HBV (co-infection or super-infection).',
      },
      // ── Pathology (3) ────────────────────────────────────────────────────
      {
        institution_id: fuhso.id, created_by: admin.id, source: 'manual', status: 'published',
        course_code: 'PAT 301', course_name: 'Pathology', faculty: 'Clinical Sciences', department: 'Pathology',
        year: 2023, topic: 'Inflammation', difficulty: 'medium', question_type: 'mcq',
        question_text: 'Which cytokines are the primary mediators of the systemic acute-phase response in inflammation?',
        options: [{ key:'A', text:'IL-4 and IL-13' },{ key:'B', text:'IL-1β, IL-6 and TNF-α' },{ key:'C', text:'IL-10 and TGF-β' },{ key:'D', text:'IL-2 and IFN-γ' }],
        correct_answer: 'B',
        explanation: 'IL-1β, IL-6 and TNF-α drive the systemic acute-phase response. IL-6 primarily stimulates hepatic APR protein synthesis (CRP, fibrinogen). IL-1β and TNF-α cause fever via prostaglandin E2 in the hypothalamus and stimulate leukocytosis.',
      },
      {
        institution_id: fuhso.id, created_by: admin.id, source: 'manual', status: 'published',
        course_code: 'PAT 301', course_name: 'Pathology', faculty: 'Clinical Sciences', department: 'Pathology',
        year: 2022, topic: 'Neoplasia', difficulty: 'hard', question_type: 'mcq',
        question_text: 'A 55-year-old woman has a breast lump. Biopsy shows cells with loss of E-cadherin expression. Which carcinoma type is most likely?',
        options: [{ key:'A', text:'Invasive ductal carcinoma (IDC)' },{ key:'B', text:'Invasive lobular carcinoma (ILC)' },{ key:'C', text:'Medullary carcinoma' },{ key:'D', text:'Mucinous (colloid) carcinoma' }],
        correct_answer: 'B',
        explanation: 'Loss of E-cadherin expression is the hallmark of invasive lobular carcinoma (ILC). E-cadherin maintains cell-cell adhesion; its loss results in the characteristic "single file" or "Indian file" pattern of invasion and discohesive tumour cells.',
      },
      {
        institution_id: fuhso.id, created_by: admin.id, source: 'manual', status: 'published',
        course_code: 'PAT 201', course_name: 'General Pathology', faculty: 'Clinical Sciences', department: 'Pathology',
        year: 2021, topic: 'Cell Injury', difficulty: 'easy', question_type: 'mcq',
        question_text: 'Coagulative necrosis is the hallmark of infarction in most organs EXCEPT the brain. Why does the brain undergo liquefactive necrosis instead?',
        options: [{ key:'A', text:'The brain has a richer blood supply' },{ key:'B', text:'Neurons have higher lipid content and the brain has abundant hydrolytic enzymes from microglia' },{ key:'C', text:'Brain cells regenerate faster than other tissues' },{ key:'D', text:'The blood-brain barrier prevents inflammatory cells from entering' }],
        correct_answer: 'B',
        explanation: 'The brain\'s high lipid content and the abundance of phospholipases and proteases in microglial cells promote autolysis and enzymatic digestion of the infarcted tissue, producing the soft, liquefied cavity characteristic of liquefactive necrosis.',
      },
    ],
  });

  console.log(`✅ ${questions.length} questions seeded`);

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 8 — QUIZ SESSIONS (Ada — 60 sessions over 3 months)
  // ══════════════════════════════════════════════════════════════════════════

  const questionIds = questions.map((q) => q.id);

  // Build 60 sessions for Ada spread over 90 days
  for (let i = 0; i < 60; i++) {
    const daysBack    = Math.floor((i / 60) * 85) + randomBetween(0, 3);
    const sessionDate = daysAgo(daysBack);
    const qCount      = randomBetween(5, 15);
    const selectedQs  = [...questionIds].sort(() => Math.random() - 0.5).slice(0, qCount);

    // Ada's accuracy improves over time — early sessions ~60%, recent ~88%
    const accuracyRate = Math.min(0.95, 0.58 + (i / 60) * 0.35);
    const correctCount = Math.round(qCount * accuracyRate);
    const scorePercent = Math.round((correctCount / qCount) * 10000) / 100;

    const session = await prisma.quizSession.create({
      data: {
        user_id:         ada.id,
        institution_id:  fuhso.id,
        mode:            i % 5 === 0 ? 'exam' : 'practice',
        question_source: 'manual',
        total_questions: qCount,
        score_percent:   scorePercent,
        correct_count:   correctCount,
        time_taken_secs: randomBetween(qCount * 40, qCount * 90),
        started_at:      sessionDate,
        completed_at:    new Date(sessionDate.getTime() + randomBetween(15, 60) * 60_000),
        question_ids:    selectedQs,
      },
    });

    // Create session answers
    for (let j = 0; j < selectedQs.length; j++) {
      const isCorrect = j < correctCount;
      const qId       = selectedQs[j]!;
      const question  = questions.find((q) => q.id === qId);
      await prisma.sessionAnswer.create({
        data: {
          session_id:    session.id,
          question_id:   qId,
          chosen_answer: isCorrect
            ? (question?.correct_answer ?? 'A')
            : (question?.correct_answer === 'A' ? 'B' : 'A'),
          is_correct:    isCorrect,
          time_taken_ms: randomBetween(8_000, 45_000),
        },
      });
    }
  }

  console.log('✅ Ada\'s 60 quiz sessions seeded');

  // Build 5 sessions for Emeka (low effort, poor accuracy, stopped 18 days ago)
  for (let i = 0; i < 5; i++) {
    const daysBack    = randomBetween(18, 45);
    const sessionDate = daysAgo(daysBack);
    const qCount      = randomBetween(5, 8);
    const selectedQs  = [...questionIds].sort(() => Math.random() - 0.5).slice(0, qCount);
    const correctCount = Math.round(qCount * 0.45); // ~45% accuracy
    const scorePercent = Math.round((correctCount / qCount) * 10000) / 100;

    const session = await prisma.quizSession.create({
      data: {
        user_id:         emeka.id,
        institution_id:  fuhso.id,
        mode:            'practice',
        question_source: 'manual',
        total_questions: qCount,
        score_percent:   scorePercent,
        correct_count:   correctCount,
        time_taken_secs: randomBetween(qCount * 60, qCount * 120),
        started_at:      sessionDate,
        completed_at:    new Date(sessionDate.getTime() + randomBetween(20, 80) * 60_000),
        question_ids:    selectedQs,
      },
    });

    for (let j = 0; j < selectedQs.length; j++) {
      const isCorrect = j < correctCount;
      const qId       = selectedQs[j]!;
      const question  = questions.find((q) => q.id === qId);
      await prisma.sessionAnswer.create({
        data: {
          session_id:    session.id,
          question_id:   qId,
          chosen_answer: isCorrect
            ? (question?.correct_answer ?? 'A')
            : (question?.correct_answer === 'A' ? 'B' : 'A'),
          is_correct:    isCorrect,
          time_taken_ms: randomBetween(15_000, 90_000),
        },
      });
    }
  }

  console.log('✅ Emeka\'s 5 quiz sessions seeded');

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 9 — BOOKMARKS
  // ══════════════════════════════════════════════════════════════════════════

  // Ada bookmarks 8 hard questions she got wrong earlier
  const hardQuestions = questions.filter((q) => q.difficulty === 'hard').slice(0, 8);
  await prisma.bookmark.createMany({
    data: hardQuestions.map((q) => ({ user_id: ada.id, question_id: q.id })),
  });

  // Emeka bookmarks 2 questions
  await prisma.bookmark.createMany({
    data: questions.slice(0, 2).map((q) => ({ user_id: emeka.id, question_id: q.id })),
  });

  console.log('✅ Bookmarks seeded');

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 10 — CONNECTION BETWEEN ADA & EMEKA
  // ══════════════════════════════════════════════════════════════════════════

  const connection = await prisma.connection.create({
    data: {
      sender_id:   ada.id,
      receiver_id: emeka.id,
      status:      'accepted',
      created_at:  daysAgo(40),
    },
  });

  console.log('✅ Ada ↔ Emeka connection seeded');

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 11 — NOTIFICATIONS
  // ══════════════════════════════════════════════════════════════════════════

  await prisma.notification.createMany({
    data: [
      // Ada's notifications — rich history
      { user_id: ada.id, type: 'system',  title: 'Welcome to FuhsoX!',          body: 'Your account has been set up. Start your first quiz today.',               action_url: '/quiz',             is_read: true,  created_at: daysAgo(92) },
      { user_id: ada.id, type: 'system',  title: '🏅 Badge Unlocked: First Steps', body: 'Completed your very first quiz on FuhsoX.',                              action_url: '/profile/badges',   is_read: true,  created_at: daysAgo(91) },
      { user_id: ada.id, type: 'system',  title: '🏅 Badge Unlocked: Week Warrior',body: 'Maintained a 7-day study streak. Consistency is key!',                   action_url: '/profile/badges',   is_read: true,  created_at: daysAgo(80) },
      { user_id: ada.id, type: 'system',  title: '🏅 Badge Unlocked: Iron Scholar',body: 'Maintained a 30-day study streak. Exceptional dedication!',              action_url: '/profile/badges',   is_read: true,  created_at: daysAgo(55) },
      { user_id: ada.id, type: 'system',  title: '🏅 Badge Unlocked: Precision Mind', body: 'Achieved 90% or above in a quiz session.',                            action_url: '/profile/badges',   is_read: true,  created_at: daysAgo(50) },
      { user_id: ada.id, type: 'system',  title: '🏅 Badge Unlocked: Perfect Score', body: 'Scored 100% on a quiz. Flawless!',                                     action_url: '/profile/badges',   is_read: true,  created_at: daysAgo(30) },
      { user_id: ada.id, type: 'system',  title: '🏅 Badge Unlocked: Quiz Master',   body: 'Completed 50 quiz sessions.',                                          action_url: '/profile/badges',   is_read: true,  created_at: daysAgo(20) },
      { user_id: ada.id, type: 'social',  title: 'New connection request',           body: 'Chukwuemeka Eze wants to connect with you.',                           action_url: '/connections',      is_read: true,  created_at: daysAgo(40) },
      { user_id: ada.id, type: 'reminder',title: '📚 Study time: Medicine & Surgery',body: 'Your session is scheduled for 18:00 today.',                           action_url: '/study/schedules',  is_read: true,  created_at: daysAgo(3)  },
      { user_id: ada.id, type: 'reminder',title: '📚 Study time: Medicine & Surgery',body: 'Your session is scheduled for 18:00 today.',                           action_url: '/study/schedules',  is_read: false, created_at: daysAgo(1)  },
      { user_id: ada.id, type: 'event',   title: '📅 Final MB BS Timetable Released', body: 'The final year examination timetable has been released. Check it now.',action_url: '/events',           is_read: false, created_at: hoursAgo(3) },

      // Emeka's notifications — sparse
      { user_id: emeka.id, type: 'system',  title: 'Welcome to FuhsoX!',            body: 'Your account has been set up. Start your first quiz today.',           action_url: '/quiz',             is_read: true,  created_at: daysAgo(45) },
      { user_id: emeka.id, type: 'system',  title: '🏅 Badge Unlocked: First Steps', body: 'Completed your very first quiz on FuhsoX.',                           action_url: '/profile/badges',   is_read: true,  created_at: daysAgo(44) },
      { user_id: emeka.id, type: 'social',  title: 'Ada Okonkwo accepted your connection', body: 'You are now connected with Ada Okonkwo.',                       action_url: '/profile/' + ada.id, is_read: true, created_at: daysAgo(40) },
      { user_id: emeka.id, type: 'reminder',title: '📚 We miss you on FuhsoX!',       body: 'You have not studied in 14 days. Come back and keep your streak alive.', action_url: '/dashboard',     is_read: false, created_at: daysAgo(4)  },
    ],
  });

  console.log('✅ Notifications seeded');

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 12 — AI USAGE LOGS
  // ══════════════════════════════════════════════════════════════════════════

  // Ada used AI features regularly over 3 months
  const aiLogs = [];
  for (let i = 0; i < 45; i++) {
    aiLogs.push({
      user_id:        ada.id,
      institution_id: fuhso.id,
      feature:        i % 3 === 0 ? 'quiz_feedback' : 'question_generation' as 'quiz_feedback' | 'question_generation',
      tokens_used:    randomBetween(800, 2500),
      model:          'gemini-1.5-flash',
      created_at:     daysAgo(Math.floor((i / 45) * 85)),
    });
  }

  // Emeka used AI 3 times total
  for (let i = 0; i < 3; i++) {
    aiLogs.push({
      user_id:        emeka.id,
      institution_id: fuhso.id,
      feature:        'quiz_feedback' as 'quiz_feedback',
      tokens_used:    randomBetween(600, 1200),
      model:          'gemini-1.5-flash',
      created_at:     daysAgo(randomBetween(20, 44)),
    });
  }

  await prisma.aIUsageLog.createMany({ data: aiLogs });

  console.log('✅ AI usage logs seeded');

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 13 — EVENTS
  // ══════════════════════════════════════════════════════════════════════════

  await prisma.event.createMany({
    data: [
      {
        institution_id:  fuhso.id,
        created_by:      admin.id,
        title:           'Final MB BS Part II Examination Timetable',
        description:     'The Final MB BS Part II examination timetable for the 2024/2025 session has been released. All final year students are required to check the official notice board and prepare accordingly. Examinations commence on the dates specified. No deferments will be granted without documented medical evidence approved by the Faculty Board.',
        event_date:      new Date(Date.now() + 30 * 86_400_000),
        location:        'University Examination Complex, Block A',
        target_audience: 'faculty',
        target_value:    'Clinical Sciences',
        is_urgent:       true,
        status:          'published',
        published_at:    hoursAgo(3),
        created_at:      hoursAgo(4),
      },
      {
        institution_id:  fuhso.id,
        created_by:      admin.id,
        title:           'Clinical Skills Assessment — Year 4 & 5',
        description:     'Mandatory clinical skills assessment for all Year 4 and Year 5 students. Assessment covers history-taking, physical examination, and procedural skills. Students must bring their white coats and stethoscopes. OSCE stations will run from 8:00 AM to 5:00 PM.',
        event_date:      new Date(Date.now() + 14 * 86_400_000),
        location:        'Clinical Skills Laboratory, Teaching Hospital',
        target_audience: 'faculty',
        target_value:    'Clinical Sciences',
        is_urgent:       false,
        status:          'published',
        published_at:    daysAgo(2),
        created_at:      daysAgo(3),
      },
      {
        institution_id:  fuhso.id,
        created_by:      admin.id,
        title:           'First Year Anatomy Practical Examination',
        description:     'The Anatomy practical examination for Year 1 students will take place in the Dissection Hall. Students are expected to identify structures on prosected specimens, histology slides, and radiographs. A minimum score of 50% is required to sit the written examination.',
        event_date:      new Date(Date.now() + 7 * 86_400_000),
        location:        'Anatomy Dissection Hall',
        target_audience: 'department',
        target_value:    'Anatomy',
        is_urgent:       false,
        status:          'published',
        published_at:    daysAgo(5),
        created_at:      daysAgo(6),
      },
    ],
  });

  console.log('✅ Events seeded');

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 14 — NEWS ARTICLES
  // ══════════════════════════════════════════════════════════════════════════

  await prisma.newsArticle.createMany({
    data: [
      {
        institution_id: fuhso.id,
        created_by:     admin.id,
        title:          'FUHSO Launches FuhsoX: The Smart Study Platform for Health Science Students',
        category:       'Announcements',
        html_body:      '<p>The Federal University of Health Sciences, Otukpo is proud to announce the official launch of <strong>FuhsoX</strong>, a next-generation academic engagement platform designed specifically for health science students.</p><p>FuhsoX provides access to thousands of past examination questions, AI-powered study feedback, personalised study plans, and a collaborative social feed — all in one place.</p><h3>Key Features</h3><ul><li>Past exam questions organised by course, year, and difficulty</li><li>Instant AI feedback on incorrect answers</li><li>Personalised study plans with exam countdown reminders</li><li>Peer connections and collaborative learning</li></ul><p>Students can sign in using their university email at <a href="https://fuhsox.ng">fuhsox.ng</a>.</p>',
        is_pinned:      true,
        status:         'published',
        published_at:   daysAgo(90),
        created_at:     daysAgo(91),
      },
      {
        institution_id: fuhso.id,
        created_by:     admin.id,
        title:          'Academic Calendar Update: Second Semester Examination Dates',
        category:       'Academic',
        html_body:      '<p>The Academic Affairs office has released the updated second semester examination schedule for the 2024/2025 academic session.</p><p>Key dates to note:</p><ul><li><strong>Last day of lectures:</strong> Two weeks from today</li><li><strong>Revision week:</strong> One week from today</li><li><strong>Examinations begin:</strong> As per individual faculty schedules</li></ul><p>Students are advised to use FuhsoX to organise their revision and practice past questions for each course.</p>',
        is_pinned:      false,
        status:         'published',
        published_at:   daysAgo(10),
        created_at:     daysAgo(11),
      },
      {
        institution_id: fuhso.id,
        created_by:     admin.id,
        title:          'Library Extended Hours During Examination Period',
        category:       'Facilities',
        html_body:      '<p>The university library will operate extended hours during the examination period to support student revision.</p><p><strong>Extended hours:</strong> 7:00 AM – 11:00 PM daily (Monday to Saturday)</p><p>Students are reminded that food and drinks are not permitted in the reading rooms. Group study rooms are available on a first-come, first-served basis.</p>',
        is_pinned:      false,
        status:         'published',
        published_at:   daysAgo(5),
        created_at:     daysAgo(6),
      },
    ],
  });

  console.log('✅ News articles seeded');

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 15 — SUMMARY
  // ══════════════════════════════════════════════════════════════════════════

  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║            SEED COMPLETE — WHAT WAS CREATED              ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log('║  🏛️  1 Institution  (FUHSO)                              ║');
  console.log('║  🏅  7 Badges                                             ║');
  console.log('║  👤  3 Users  (1 admin, 2 students)                       ║');
  console.log('║                                                           ║');
  console.log('║  👩‍⚕️  Ada Okonkwo  — The Serious Student                    ║');
  console.log('║     ada.okonkwo@student.fuhso.edu.ng                     ║');
  console.log('║     8,500 XP · 45-day streak · 7 badges · 60 sessions   ║');
  console.log('║     → Tests: study reminders, streak emails, leaderboard  ║');
  console.log('║                                                           ║');
  console.log('║  😴  Chukwuemeka Eze  — The Unserious Student            ║');
  console.log('║     chukwuemeka.eze@student.fuhso.edu.ng                 ║');
  console.log('║     320 XP · 0 streak · 1 badge · 5 sessions             ║');
  console.log('║     INACTIVE 18 days → risk-flagged                       ║');
  console.log('║     → Tests: re-engagement email, at-risk dashboard       ║');
  console.log('║                                                           ║');
  console.log('║  🤝  Connected to each other (accepted)                   ║');
  console.log('║  ❓  20 questions  (Anatomy, Physiology, Biochem, etc.)   ║');
  console.log('║  📋  65 quiz sessions  (60 Ada + 5 Emeka)                 ║');
  console.log('║  📌  10 bookmarks                                          ║');
  console.log('║  🔔  15 notifications                                      ║');
  console.log('║  🤖  48 AI usage log entries                               ║');
  console.log('║  📅  3 events  (2 published, 1 urgent)                    ║');
  console.log('║  📰  3 news articles  (1 pinned)                           ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('\n🔑 To trigger emails manually:');
  console.log('   POST /api/v1/auth/register  { "email": "ada.okonkwo@student.fuhso.edu.ng" }');
  console.log('   POST /api/v1/auth/register  { "email": "chukwuemeka.eze@student.fuhso.edu.ng" }');
  console.log('   Then check MailHog at http://localhost:8025\n');
}

// ─── Production guard ──────────────────────────────────────────────────────────

/**
 * STEP 1 of main() deletes every row in 22 tables. That is the right behaviour for
 * a development fixture and catastrophic anywhere else — and this script had no
 * other safety while being wired into the Render build command, so an ordinary
 * deploy wiped production and replaced it with Ada and Emeka.
 *
 * Exits 0, not 1: the build command chains on `&&`, so a non-zero exit here would
 * turn a correctly-skipped seed into a failed deploy.
 */
function seedingIsAllowed(): boolean {
  if (process.env.ALLOW_DESTRUCTIVE_SEED === 'true') return true;
  return process.env.NODE_ENV !== 'production';
}

if (!seedingIsAllowed()) {
  console.log(
    '⏭️  Skipping destructive seed: NODE_ENV=production.\n' +
      '   Set ALLOW_DESTRUCTIVE_SEED=true to override — this DELETES ALL DATA.',
  );
  process.exit(0);
}

main()
  .catch((err) => {
    console.error('\n❌ Seeding failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });