import { PrismaClient } from '@prisma/client';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

function destructiveSeedIsAllowed(): boolean {
  if (process.env['ALLOW_DESTRUCTIVE_SEED'] === 'true') return true;
  return process.env['NODE_ENV'] !== 'production';
}

async function wipeMongo(uri: string): Promise<number> {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });

  try {
    const db = mongoose.connection.db;
    if (!db) throw new Error('Connected to Mongo but got no database handle.');

    const collections = await db.collections();
    let total = 0;

    for (const collection of collections) {
      const name = collection.collectionName;
      if (name.startsWith('system.')) continue;

      const { deletedCount } = await collection.deleteMany({});
      total += deletedCount;
      if (deletedCount > 0) console.log(`  ${String(deletedCount).padStart(7)}  ${name}`);
    }

    return total;
  } finally {
    await mongoose.disconnect();
  }
}

async function main() {
  console.log('Seeding FuhsoX base data...\n');

  const mongoUri = process.env['MONGODB_URI'];
  if (!mongoUri) {
    throw new Error(
      'MONGODB_URI is not set. This seed wipes both databases, so it refuses to ' +
        'run when it cannot reach Mongo — otherwise Mongo would keep documents ' +
        'pointing at users that no longer exist.',
    );
  }

  console.log('Clearing existing data...');

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

  await prisma.studyRoomParticipant.deleteMany({});
  await prisma.studyRoom.deleteMany({});

  await prisma.kCEdge.deleteMany({});
  await prisma.knowledgeComponent.deleteMany({});

  await prisma.question.deleteMany({});
  await prisma.newsArticle.deleteMany({});
  await prisma.event.deleteMany({});
  await prisma.badge.deleteMany({});

  await prisma.user.deleteMany({});
  await prisma.institution.deleteMany({});

  console.log('  Postgres: every table cleared');

  const mongoDocs = await wipeMongo(mongoUri);
  console.log(`  Mongo: ${mongoDocs} document(s) cleared`);
  console.log('  Cleared\n');

  const fuhso = await prisma.institution.create({
    data: {
      name:           'Federal University of Health Sciences, Otukpo',
      slug:           'fuhso',
      email_domains:  ['fuhso.edu.ng', 'student.fuhso.edu.ng', 'gmail.com', 'outlook.com', 'yahoo.com', 'hotmail.com'],
      primary_color:  '#1a3c6e',
      timezone:       'Africa/Lagos',
      ai_daily_limit: 50,
    },
  });

  console.log(`Institution: ${fuhso.name}`);

  await prisma.badge.createMany({
    data: [
      {
        code:        'FIRST_QUIZ',
        name:        'First Steps',
        description: 'Completed your very first quiz on FuhsoX.',
        icon_url:    'https://cdn.fuhsox.ng/badges/first_quiz.png',
        xp_award:    50,
      },
      {
        code:        'STREAK_7',
        name:        'Week Warrior',
        description: 'Maintained a 7-day study streak. Consistency is key!',
        icon_url:    'https://cdn.fuhsox.ng/badges/streak_7.png',
        xp_award:    100,
      },
      {
        code:        'STREAK_30',
        name:        'Iron Scholar',
        description: 'Maintained a 30-day study streak. Exceptional dedication!',
        icon_url:    'https://cdn.fuhsox.ng/badges/streak_30.png',
        xp_award:    500,
      },
      {
        code:        'ACCURACY_90',
        name:        'Precision Mind',
        description: 'Achieved 90% or above in a quiz session.',
        icon_url:    'https://cdn.fuhsox.ng/badges/accuracy_90.png',
        xp_award:    150,
      },
      {
        code:        'PERFECT_SCORE',
        name:        'Perfect Score',
        description: 'Scored 100% on a quiz. Flawless!',
        icon_url:    'https://cdn.fuhsox.ng/badges/perfect_score.png',
        xp_award:    200,
      },
      {
        code:        'QUIZ_MASTER_50',
        name:        'Quiz Master',
        description: 'Completed 50 quiz sessions. A true champion of practice.',
        icon_url:    'https://cdn.fuhsox.ng/badges/quiz_master_50.png',
        xp_award:    300,
      },
      {
        code:        'SOCIAL_CONNECTOR',
        name:        'Social Connector',
        description: 'Reached 500 XP through consistent effort and engagement.',
        icon_url:    'https://cdn.fuhsox.ng/badges/social_connector.png',
        xp_award:    0,
      },
    ],
  });

  console.log('7 badges seeded');

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 4 — ADMIN USER
  // ══════════════════════════════════════════════════════════════════════════

  const adminEmail    = process.env['SEED_ADMIN_EMAIL']    ?? 'admin@fuhso.edu.ng';
  const adminPassword = process.env['SEED_ADMIN_PASSWORD'] ?? 'FuhsoX_Admin@2025!';
  const passwordHash  = await bcrypt.hash(adminPassword, 10);

  const admin = await prisma.user.create({
    data: {
      institution_id: fuhso.id,
      email:          adminEmail,
      full_name:      'FuhsoX Administrator',
      role:           'admin',
      auth_provider:  'email_otp',
      email_verified: true,
      password_hash:  passwordHash,
      last_active_at: new Date(),
    },
  });

  console.log(`Admin: ${admin.email}`);

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 5 — QUESTIONS (20 published questions across 5 subjects)
  //
  // `options` is a Json column. It is written as a real array, matching what the
  // API writes and what every reader expects; a JSON.stringify'd string would
  // store a quoted blob that `q.options.map(...)` cannot iterate.
  // ══════════════════════════════════════════════════════════════════════════

  await prisma.question.createMany({
    data: [

      // ── Anatomy (4) ──────────────────────────────────────────────────────

      {
        institution_id: fuhso.id, created_by: admin.id,
        source: 'manual', status: 'published',
        course_code: 'ANA 201', course_name: 'Human Anatomy',
        faculty: 'Basic Medical Sciences', department: 'Anatomy',
        year: 2023, topic: 'Cardiovascular System', difficulty: 'easy',
        question_type: 'mcq',
        question_text: 'Which chamber of the heart pumps oxygenated blood into the systemic circulation?',
        options: [
          { key: 'A', text: 'Right atrium'    },
          { key: 'B', text: 'Right ventricle' },
          { key: 'C', text: 'Left atrium'     },
          { key: 'D', text: 'Left ventricle'  },
        ],
        correct_answer: 'D',
        explanation: 'The left ventricle pumps oxygenated blood received from the left atrium into the aorta, distributing it to the body via systemic circulation.',
      },
      {
        institution_id: fuhso.id, created_by: admin.id,
        source: 'manual', status: 'published',
        course_code: 'ANA 201', course_name: 'Human Anatomy',
        faculty: 'Basic Medical Sciences', department: 'Anatomy',
        year: 2022, topic: 'Nervous System', difficulty: 'medium',
        question_type: 'mcq',
        question_text: 'The blood-brain barrier is primarily maintained by which cellular structure?',
        options: [
          { key: 'A', text: 'Astrocyte end-feet' },
          { key: 'B', text: 'Microglia'          },
          { key: 'C', text: 'Oligodendrocytes'   },
          { key: 'D', text: 'Ependymal cells'    },
        ],
        correct_answer: 'A',
        explanation: 'Astrocyte end-feet wrap around brain capillary endothelial cells, reinforcing the tight junctions that form the blood-brain barrier.',
      },
      {
        institution_id: fuhso.id, created_by: admin.id,
        source: 'manual', status: 'published',
        course_code: 'ANA 201', course_name: 'Human Anatomy',
        faculty: 'Basic Medical Sciences', department: 'Anatomy',
        year: 2023, topic: 'Musculoskeletal System', difficulty: 'medium',
        question_type: 'mcq',
        question_text: 'Which of the following is NOT a rotator cuff muscle?',
        options: [
          { key: 'A', text: 'Supraspinatus' },
          { key: 'B', text: 'Infraspinatus' },
          { key: 'C', text: 'Deltoid'       },
          { key: 'D', text: 'Teres minor'   },
        ],
        correct_answer: 'C',
        explanation: 'The rotator cuff = SITS: Supraspinatus, Infraspinatus, Teres minor, Subscapularis. The deltoid is a large shoulder muscle but is NOT part of the rotator cuff.',
      },
      {
        institution_id: fuhso.id, created_by: admin.id,
        source: 'manual', status: 'published',
        course_code: 'ANA 301', course_name: 'Neuroanatomy',
        faculty: 'Basic Medical Sciences', department: 'Anatomy',
        year: 2022, topic: 'Cranial Nerves', difficulty: 'hard',
        question_type: 'mcq',
        question_text: 'A patient has loss of taste from the anterior two-thirds of the tongue and hyperacusis on the right. Which nerve branch is injured?',
        options: [
          { key: 'A', text: 'CN V3 — auriculotemporal branch' },
          { key: 'B', text: 'CN VII — chorda tympani branch'  },
          { key: 'C', text: 'CN IX — glossopharyngeal'        },
          { key: 'D', text: 'CN X — vagus'                    },
        ],
        correct_answer: 'B',
        explanation: 'The chorda tympani (CN VII) carries taste from the anterior 2/3 of the tongue. It also carries the nerve to stapedius — damage produces hyperacusis because the stapedius cannot dampen loud sounds.',
      },

      // ── Physiology (4) ───────────────────────────────────────────────────

      {
        institution_id: fuhso.id, created_by: admin.id,
        source: 'manual', status: 'published',
        course_code: 'PHY 201', course_name: 'Human Physiology',
        faculty: 'Basic Medical Sciences', department: 'Physiology',
        year: 2023, topic: 'Renal Physiology', difficulty: 'medium',
        question_type: 'mcq',
        question_text: 'Glucose reabsorption in the nephron occurs primarily in the:',
        options: [
          { key: 'A', text: 'Glomerulus'                 },
          { key: 'B', text: 'Proximal convoluted tubule' },
          { key: 'C', text: 'Loop of Henle'              },
          { key: 'D', text: 'Collecting duct'            },
        ],
        correct_answer: 'B',
        explanation: 'Nearly 100% of filtered glucose is reabsorbed in the PCT via SGLT2. When plasma glucose exceeds ~180 mg/dL (renal threshold), these transporters saturate and glycosuria results.',
      },
      {
        institution_id: fuhso.id, created_by: admin.id,
        source: 'manual', status: 'published',
        course_code: 'PHY 201', course_name: 'Human Physiology',
        faculty: 'Basic Medical Sciences', department: 'Physiology',
        year: 2022, topic: 'Cardiac Physiology', difficulty: 'medium',
        question_type: 'mcq',
        question_text: 'The Frank-Starling law of the heart states that:',
        options: [
          { key: 'A', text: 'Heart rate increases with increased venous return'           },
          { key: 'B', text: 'Stroke volume increases with increased end-diastolic volume' },
          { key: 'C', text: 'Cardiac output decreases with increased preload'             },
          { key: 'D', text: 'Contractility is directly proportional to heart rate'        },
        ],
        correct_answer: 'B',
        explanation: 'Frank-Starling: as end-diastolic volume (preload) increases, sarcomere length increases, producing greater contractile force and higher stroke volume — within physiological limits.',
      },
      {
        institution_id: fuhso.id, created_by: admin.id,
        source: 'manual', status: 'published',
        course_code: 'PHY 201', course_name: 'Human Physiology',
        faculty: 'Basic Medical Sciences', department: 'Physiology',
        year: 2021, topic: 'Endocrinology', difficulty: 'medium',
        question_type: 'mcq',
        question_text: 'Which hormone directly raises serum calcium by stimulating osteoclast activity and increasing renal calcium reabsorption?',
        options: [
          { key: 'A', text: 'Calcitonin'                },
          { key: 'B', text: 'Parathyroid hormone (PTH)' },
          { key: 'C', text: 'Vitamin D3 (calcitriol)'   },
          { key: 'D', text: 'Cortisol'                  },
        ],
        correct_answer: 'B',
        explanation: 'PTH raises serum calcium via bone resorption (osteoclasts), renal calcium reabsorption, and activation of vitamin D. Calcitonin opposes PTH by inhibiting osteoclasts.',
      },
      {
        institution_id: fuhso.id, created_by: admin.id,
        source: 'manual', status: 'published',
        course_code: 'PHY 201', course_name: 'Human Physiology',
        faculty: 'Basic Medical Sciences', department: 'Physiology',
        year: 2022, topic: 'Neuromuscular Physiology', difficulty: 'easy',
        question_type: 'mcq',
        question_text: 'The neurotransmitter released at the neuromuscular junction is:',
        options: [
          { key: 'A', text: 'Norepinephrine' },
          { key: 'B', text: 'Dopamine'       },
          { key: 'C', text: 'Acetylcholine'  },
          { key: 'D', text: 'GABA'           },
        ],
        correct_answer: 'C',
        explanation: 'Acetylcholine (ACh) is released from motor neuron terminals at the NMJ, binding nicotinic ACh receptors on the motor end plate to trigger muscle contraction.',
      },

      // ── Biochemistry (4) ─────────────────────────────────────────────────

      {
        institution_id: fuhso.id, created_by: admin.id,
        source: 'manual', status: 'published',
        course_code: 'BCH 201', course_name: 'Biochemistry',
        faculty: 'Basic Medical Sciences', department: 'Biochemistry',
        year: 2023, topic: 'Enzyme Kinetics', difficulty: 'medium',
        question_type: 'mcq',
        question_text: 'In Michaelis-Menten kinetics, the Km value represents:',
        options: [
          { key: 'A', text: 'The maximum velocity of the reaction'                          },
          { key: 'B', text: 'The substrate concentration at which V = ½ Vmax'              },
          { key: 'C', text: 'The equilibrium constant of product formation'                 },
          { key: 'D', text: 'The minimum substrate concentration required for the reaction' },
        ],
        correct_answer: 'B',
        explanation: 'Km is the [S] at which V = ½ Vmax. Lower Km = higher enzyme affinity. It is a fixed property of a given enzyme-substrate pair under defined conditions.',
      },
      {
        institution_id: fuhso.id, created_by: admin.id,
        source: 'manual', status: 'published',
        course_code: 'BCH 201', course_name: 'Biochemistry',
        faculty: 'Basic Medical Sciences', department: 'Biochemistry',
        year: 2022, topic: 'Carbohydrate Metabolism', difficulty: 'hard',
        question_type: 'mcq',
        question_text: 'A patient with G6PD deficiency develops haemolytic anaemia after taking primaquine. The mechanism is:',
        options: [
          { key: 'A', text: 'Impaired glycolysis reducing ATP for RBC survival'                   },
          { key: 'B', text: 'Inability to regenerate NADPH, leading to oxidative damage to RBCs'  },
          { key: 'C', text: 'Increased sickling of haemoglobin S'                                 },
          { key: 'D', text: 'Direct haemolysis by primaquine acting as a toxin'                   },
        ],
        correct_answer: 'B',
        explanation: 'G6PD generates NADPH via the pentose phosphate pathway. NADPH regenerates glutathione, protecting RBCs from oxidative stress. Without it, primaquine-induced ROS causes haemolysis.',
      },
      {
        institution_id: fuhso.id, created_by: admin.id,
        source: 'manual', status: 'published',
        course_code: 'BCH 201', course_name: 'Biochemistry',
        faculty: 'Basic Medical Sciences', department: 'Biochemistry',
        year: 2023, topic: 'Protein Metabolism', difficulty: 'medium',
        question_type: 'mcq',
        question_text: 'Which vitamin is the essential cofactor for all transaminase (aminotransferase) reactions?',
        options: [
          { key: 'A', text: 'Vitamin B1 (thiamine)'            },
          { key: 'B', text: 'Vitamin B2 (riboflavin)'          },
          { key: 'C', text: 'Vitamin B6 (pyridoxal phosphate)' },
          { key: 'D', text: 'Vitamin B12 (cobalamin)'          },
        ],
        correct_answer: 'C',
        explanation: 'Pyridoxal phosphate (PLP), the active form of B6, is the prosthetic group of all aminotransferases. It acts as an amino-group carrier, shuttling nitrogen between amino acids and keto acids.',
      },
      {
        institution_id: fuhso.id, created_by: admin.id,
        source: 'manual', status: 'published',
        course_code: 'BCH 201', course_name: 'Biochemistry',
        faculty: 'Basic Medical Sciences', department: 'Biochemistry',
        year: 2021, topic: 'Lipid Metabolism', difficulty: 'medium',
        question_type: 'mcq',
        question_text: 'During prolonged starvation, the brain adapts to use which fuel as its primary energy substrate?',
        options: [
          { key: 'A', text: 'Free fatty acids'                                     },
          { key: 'B', text: 'Ketone bodies (acetoacetate and β-hydroxybutyrate)'    },
          { key: 'C', text: 'Glycerol'                                              },
          { key: 'D', text: 'Amino acids exclusively'                               },
        ],
        correct_answer: 'B',
        explanation: 'After 3-4 days of starvation the liver produces ketones from fatty acid oxidation. The brain adapts to use ketones for up to 75% of its energy, significantly reducing muscle protein catabolism.',
      },

      // ── Microbiology (4) ─────────────────────────────────────────────────

      {
        institution_id: fuhso.id, created_by: admin.id,
        source: 'manual', status: 'published',
        course_code: 'MIC 301', course_name: 'Microbiology',
        faculty: 'Basic Medical Sciences', department: 'Microbiology',
        year: 2023, topic: 'Bacterial Pathogenesis', difficulty: 'hard',
        question_type: 'mcq',
        question_text: 'A patient develops profuse rice-water, non-bloody diarrhoea after contaminated water. The causative organism permanently activates Gs-alpha. Identify it.',
        options: [
          { key: 'A', text: 'Shigella dysenteriae'  },
          { key: 'B', text: 'Salmonella typhi'      },
          { key: 'C', text: 'Vibrio cholerae'       },
          { key: 'D', text: 'Clostridium difficile' },
        ],
        correct_answer: 'C',
        explanation: 'Vibrio cholerae produces cholera toxin — ADP-ribosylates Gs-alpha, constitutively activates adenylyl cyclase → massive cAMP → secretory diarrhoea. Non-invasive, so no blood in stool.',
      },
      {
        institution_id: fuhso.id, created_by: admin.id,
        source: 'manual', status: 'published',
        course_code: 'MIC 301', course_name: 'Microbiology',
        faculty: 'Basic Medical Sciences', department: 'Microbiology',
        year: 2022, topic: 'Antifungals', difficulty: 'medium',
        question_type: 'mcq',
        question_text: 'Amphotericin B exerts its antifungal effect by:',
        options: [
          { key: 'A', text: 'Inhibiting fungal cell wall synthesis by blocking glucan synthase'     },
          { key: 'B', text: 'Binding ergosterol in the fungal membrane, forming pores'             },
          { key: 'C', text: 'Inhibiting lanosterol 14-α-demethylase, blocking ergosterol synthesis' },
          { key: 'D', text: 'Disrupting fungal DNA replication'                                    },
        ],
        correct_answer: 'B',
        explanation: 'Amphotericin B binds directly to ergosterol in the fungal membrane, inserting itself to form transmembrane channels that increase membrane permeability, causing ion leakage and cell death.',
      },
      {
        institution_id: fuhso.id, created_by: admin.id,
        source: 'manual', status: 'published',
        course_code: 'MIC 201', course_name: 'Medical Microbiology',
        faculty: 'Basic Medical Sciences', department: 'Microbiology',
        year: 2021, topic: 'Viral Hepatitis', difficulty: 'medium',
        question_type: 'mcq',
        question_text: 'Which hepatitis virus requires co-infection with Hepatitis B, using HBsAg as its own envelope protein?',
        options: [
          { key: 'A', text: 'Hepatitis A'               },
          { key: 'B', text: 'Hepatitis C'               },
          { key: 'C', text: 'Hepatitis D (Delta agent)' },
          { key: 'D', text: 'Hepatitis E'               },
        ],
        correct_answer: 'C',
        explanation: 'HDV is a defective satellite virus — it uses HBsAg from HBV to form its envelope. It can only infect patients already infected with HBV (co-infection or super-infection).',
      },
      {
        institution_id: fuhso.id, created_by: admin.id,
        source: 'manual', status: 'published',
        course_code: 'MIC 301', course_name: 'Microbiology',
        faculty: 'Basic Medical Sciences', department: 'Microbiology',
        year: 2023, topic: 'Antimicrobials', difficulty: 'medium',
        question_type: 'mcq',
        question_text: 'Beta-lactam antibiotics kill bacteria by:',
        options: [
          { key: 'A', text: 'Inhibiting the 30S ribosomal subunit'           },
          { key: 'B', text: 'Inhibiting cell wall synthesis by binding PBPs' },
          { key: 'C', text: 'Disrupting the cell membrane'                   },
          { key: 'D', text: 'Inhibiting DNA gyrase'                          },
        ],
        correct_answer: 'B',
        explanation: 'Beta-lactams (penicillins, cephalosporins, carbapenems) bind and inactivate penicillin-binding proteins (PBPs), inhibiting transpeptidation — the final cross-linking step of peptidoglycan cell wall synthesis.',
      },

      // ── Pathology (4) ────────────────────────────────────────────────────

      {
        institution_id: fuhso.id, created_by: admin.id,
        source: 'manual', status: 'published',
        course_code: 'PAT 301', course_name: 'Pathology',
        faculty: 'Clinical Sciences', department: 'Pathology',
        year: 2023, topic: 'Inflammation', difficulty: 'medium',
        question_type: 'mcq',
        question_text: 'Which cytokines are the primary mediators of the systemic acute-phase response?',
        options: [
          { key: 'A', text: 'IL-4 and IL-13'        },
          { key: 'B', text: 'IL-1β, IL-6 and TNF-α' },
          { key: 'C', text: 'IL-10 and TGF-β'       },
          { key: 'D', text: 'IL-2 and IFN-γ'        },
        ],
        correct_answer: 'B',
        explanation: 'IL-1β, IL-6, and TNF-α drive the acute-phase response. IL-6 stimulates hepatic synthesis of CRP and fibrinogen. IL-1β and TNF-α cause fever via PGE2 in the hypothalamus and stimulate leukocytosis.',
      },
      {
        institution_id: fuhso.id, created_by: admin.id,
        source: 'manual', status: 'published',
        course_code: 'PAT 301', course_name: 'Pathology',
        faculty: 'Clinical Sciences', department: 'Pathology',
        year: 2022, topic: 'Neoplasia', difficulty: 'hard',
        question_type: 'mcq',
        question_text: 'A breast biopsy shows loss of E-cadherin expression with cells invading in a single-file pattern. Which carcinoma type is most likely?',
        options: [
          { key: 'A', text: 'Invasive ductal carcinoma (IDC)'  },
          { key: 'B', text: 'Invasive lobular carcinoma (ILC)' },
          { key: 'C', text: 'Medullary carcinoma'              },
          { key: 'D', text: 'Mucinous (colloid) carcinoma'     },
        ],
        correct_answer: 'B',
        explanation: 'Loss of E-cadherin is the hallmark of invasive lobular carcinoma. E-cadherin maintains cell cohesion; its loss results in the characteristic single-file ("Indian file") invasion pattern.',
      },
      {
        institution_id: fuhso.id, created_by: admin.id,
        source: 'manual', status: 'published',
        course_code: 'PAT 201', course_name: 'General Pathology',
        faculty: 'Clinical Sciences', department: 'Pathology',
        year: 2021, topic: 'Cell Injury', difficulty: 'easy',
        question_type: 'mcq',
        question_text: 'Why does the brain undergo liquefactive rather than coagulative necrosis after infarction?',
        options: [
          { key: 'A', text: 'The brain has a richer blood supply'                                                },
          { key: 'B', text: 'Neurons have high lipid content and microglia provide abundant hydrolytic enzymes'  },
          { key: 'C', text: 'Brain cells regenerate faster than other tissues'                                   },
          { key: 'D', text: 'The blood-brain barrier prevents inflammatory cells from entering'                  },
        ],
        correct_answer: 'B',
        explanation: 'The brain\'s high lipid content plus phospholipases and proteases from microglia promote enzymatic autolysis, producing the soft liquefied cavity characteristic of liquefactive necrosis — unique to the brain and bacterial abscesses.',
      },
      {
        institution_id: fuhso.id, created_by: admin.id,
        source: 'manual', status: 'published',
        course_code: 'PAT 301', course_name: 'Pathology',
        faculty: 'Clinical Sciences', department: 'Pathology',
        year: 2022, topic: 'Thrombosis', difficulty: 'medium',
        question_type: 'mcq',
        question_text: 'Virchow\'s triad describes the three factors predisposing to thrombosis. Which of the following correctly lists all three?',
        options: [
          { key: 'A', text: 'Endothelial injury, hypercoagulability, and haemolysis'           },
          { key: 'B', text: 'Endothelial injury, stasis of blood flow, and hypercoagulability' },
          { key: 'C', text: 'Stasis of blood flow, hypertension, and hypercoagulability'       },
          { key: 'D', text: 'Platelet activation, vasospasm, and endothelial injury'           },
        ],
        correct_answer: 'B',
        explanation: 'Virchow\'s triad: (1) Endothelial injury — exposes sub-endothelial collagen; (2) Abnormal blood flow — stasis or turbulence; (3) Hypercoagulability — e.g. factor V Leiden, pregnancy, malignancy. All three contribute to thrombus formation.',
      },

    ],
  });

  console.log('20 questions seeded (Anatomy x4, Physiology x4, Biochemistry x4, Microbiology x4, Pathology x4)');

  // ══════════════════════════════════════════════════════════════════════════
  // DONE
  // ══════════════════════════════════════════════════════════════════════════

  const W    = 56;
  const rule = (l: string, r: string) => `${l}${'═'.repeat(W + 2)}${r}`;
  const row  = (text: string) => `║ ${text.padEnd(W).slice(0, W)} ║`;

  console.log('\n' + rule('╔', '╗'));
  console.log(row('SEED COMPLETE'));
  console.log(rule('╠', '╣'));
  console.log(row(`Institution : ${fuhso.name}`));
  console.log(row('Badges      : 7'));
  console.log(row(`Admin       : ${adminEmail}`));
  console.log(row('Questions   : 20 (published)'));
  console.log(row(`Mongo       : emptied (${mongoDocs} document(s) removed)`));
  console.log(rule('╚', '╝'));

  console.log('\nAdmin credentials:');
  console.log(`   Email    : ${adminEmail}`);
  console.log(`   Password : ${adminPassword}`);
  console.log('\nTo override admin credentials, set in .env before running:');
  console.log('   SEED_ADMIN_EMAIL=your@email.com');
  console.log('   SEED_ADMIN_PASSWORD=YourPassword\n');
}

if (!destructiveSeedIsAllowed()) {
  console.log(
    'Skipping destructive seed: NODE_ENV=production.\n' +
      '   Set ALLOW_DESTRUCTIVE_SEED=true to override — this DELETES ALL DATA.',
  );
  process.exit(0);
}

main()
  .catch((err) => {
    console.error('\nSeeding failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
