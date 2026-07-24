/**
 * Academic taxonomy — faculties → departments → relevant study interests.
 *
 * The single source of truth for onboarding's faculty/department pickers AND the
 * department-aware interest suggestions (served by `GET /config/academic`). Moved
 * here from the mobile client (`lib/onboarding/institutionData.ts` + the static
 * `INTEREST_OPTIONS`) so the list can grow without shipping an app update.
 *
 * FuhsoX is the Federal University of Health Sciences, Otukpo — hence the depth on
 * the health-science faculties. Interest resolution is DEPARTMENT-FIRST with a
 * FACULTY FALLBACK: a department with its own curated `interests` uses them; an
 * uncurated department (empty array) inherits its faculty's `interests`. Free-text
 * is still accepted by `PATCH /users/me`, so nothing here is a hard constraint.
 */

export interface DepartmentConfig {
  name: string;
  /** Department-specific interests; empty means "use the faculty fallback". */
  interests: string[];
  /**
   * How the AI should PITCH content for this department, when the faculty-level
   * emphasis is too coarse — a Maths student and a Zoology student are both in
   * "Sciences" but want very different framing. Absent = inherit the faculty's.
   */
  emphasis?: string;
}

export interface FacultyConfig {
  name: string;
  /** Fallback interests for departments that don't curate their own. */
  interests: string[];
  /**
   * The pedagogical framing the AI should adopt for this faculty (reformation —
   * discipline-aware prompts). This is what replaces the old hardcoded "health
   * science / clinical application" bias: it steers tone and example choice toward
   * the student's ACTUAL field. Departments may override via their own `emphasis`.
   */
  emphasis: string;
  departments: DepartmentConfig[];
}

const d = (name: string, interests: string[] = [], emphasis?: string): DepartmentConfig => ({
  name,
  interests,
  ...(emphasis ? { emphasis } : {}),
});

export const ACADEMIC_FACULTIES: FacultyConfig[] = [
  {
    name: 'Basic Medical Sciences',
    emphasis: 'the mechanisms behind the facts — why the body behaves as it does — favouring physiological reasoning over rote recall',
    interests: ['Anatomy', 'Physiology', 'Biochemistry', 'Pharmacology', 'Histology', 'Embryology'],
    departments: [
      d('Anatomy', ['Gross Anatomy', 'Histology', 'Embryology', 'Neuroanatomy', 'Osteology', 'Cell Biology']),
      d('Physiology', ['Cardiovascular Physiology', 'Neurophysiology', 'Renal Physiology', 'Endocrinology', 'Respiratory Physiology', 'Blood & Immunity']),
      d('Biochemistry', ['Metabolism', 'Molecular Biology', 'Enzymology', 'Clinical Biochemistry', 'Nutrition', 'Genetics']),
      d('Pharmacology', ['General Pharmacology', 'Chemotherapy', 'Toxicology', 'Autonomic Pharmacology', 'Clinical Pharmacology']),
    ],
  },
  {
    name: 'Medicine',
    emphasis: 'clinical reasoning and application to patient scenarios, including differential diagnosis and management',
    interests: ['Internal Medicine', 'Surgery', 'Pathology', 'Pharmacology', 'Pediatrics', 'Obstetrics & Gynaecology', 'Anatomy', 'Physiology'],
    departments: [
      d('Medicine & Surgery', ['Internal Medicine', 'General Surgery', 'Pathology', 'Pediatrics', 'Obstetrics & Gynaecology', 'Community Medicine', 'Microbiology', 'Pharmacology']),
      d('Dentistry', ['Oral Anatomy', 'Oral Pathology', 'Periodontology', 'Orthodontics', 'Oral Surgery', 'Dental Materials']),
      d('Nursing Science', ['Fundamentals of Nursing', 'Medical-Surgical Nursing', 'Community Health Nursing', 'Maternal & Child Health', 'Pharmacology', 'Mental Health Nursing']),
      d('Physiotherapy', ['Musculoskeletal Physiotherapy', 'Neurological Rehabilitation', 'Cardiopulmonary Physiotherapy', 'Kinesiology', 'Electrotherapy', 'Anatomy']),
      d('Radiography', ['Radiographic Anatomy', 'Radiographic Technique', 'Radiation Physics', 'Ultrasonography', 'CT & MRI', 'Radiation Protection']),
    ],
  },
  {
    name: 'Pharmacy',
    emphasis: 'drug mechanisms, pharmacokinetics and rational, safe therapeutics',
    interests: ['Pharmacology', 'Pharmaceutics', 'Pharmacognosy', 'Medicinal Chemistry', 'Clinical Pharmacy', 'Pharmaceutical Microbiology'],
    departments: [
      d('Clinical Pharmacy', ['Clinical Pharmacy', 'Pharmacotherapy', 'Pharmacokinetics', 'Pharmacovigilance', 'Pharmacology']),
      d('Pharmaceutics', ['Dosage Form Design', 'Biopharmaceutics', 'Physical Pharmacy', 'Industrial Pharmacy', 'Pharmacokinetics']),
      d('Pharmacognosy', ['Medicinal Plants', 'Phytochemistry', 'Natural Products', 'Pharmaceutical Biology', 'Ethnopharmacology']),
    ],
  },
  {
    name: 'Sciences',
    emphasis: 'rigorous reasoning with concrete worked examples — derivations, proofs or calculations wherever the topic calls for them',
    interests: ['Mathematics', 'Physics', 'Chemistry', 'Biology', 'Computer Science', 'Statistics', 'Microbiology'],
    departments: [
      d('Biochemistry', ['Metabolism', 'Molecular Biology', 'Enzymology', 'Clinical Biochemistry', 'Genetics']),
      d('Chemistry', ['Organic Chemistry', 'Inorganic Chemistry', 'Physical Chemistry', 'Analytical Chemistry', 'Industrial Chemistry'],
        'reaction mechanisms, structure–property reasoning and balanced, quantitative work'),
      d('Computer Science', ['Programming', 'Data Structures', 'Algorithms', 'Databases', 'Operating Systems', 'Networks', 'Artificial Intelligence', 'Web Development'],
        'algorithmic thinking, correct implementation and complexity analysis; use code or pseudocode where it clarifies'),
      d('Geology', ['Mineralogy', 'Petrology', 'Structural Geology', 'Palaeontology', 'Geophysics', 'Hydrogeology']),
      d('Mathematics', ['Calculus', 'Linear Algebra', 'Differential Equations', 'Abstract Algebra', 'Real Analysis', 'Numerical Methods'],
        'formal, step-by-step reasoning with rigorous derivations and proofs — always show the working'),
      d('Microbiology', ['Medical Microbiology', 'Virology', 'Immunology', 'Bacteriology', 'Mycology', 'Parasitology']),
      d('Physics', ['Mechanics', 'Electromagnetism', 'Thermodynamics', 'Quantum Physics', 'Optics', 'Electronics'],
        'first-principles derivation and quantitative problem-solving with correct units'),
      d('Statistics', ['Probability', 'Statistical Inference', 'Regression Analysis', 'Design of Experiments', 'Biostatistics'],
        'probabilistic reasoning, correct interpretation of results, and fully worked calculations'),
      d('Zoology', ['Invertebrate Zoology', 'Vertebrate Zoology', 'Ecology', 'Genetics', 'Parasitology', 'Entomology']),
    ],
  },
  {
    name: 'Social Sciences',
    emphasis: 'theory applied to real cases, with critical analysis and evidence',
    interests: ['Economics', 'Psychology', 'Sociology', 'Political Science', 'Mass Communication', 'Geography'],
    departments: [
      d('Economics', ['Microeconomics', 'Macroeconomics', 'Econometrics', 'Development Economics', 'Public Finance'],
        'economic reasoning with models, graphs and quantitative worked examples'),
      d('Geography', ['Physical Geography', 'Human Geography', 'GIS & Remote Sensing', 'Climatology', 'Population Studies']),
      d('Mass Communication', ['Journalism', 'Broadcasting', 'Public Relations', 'Advertising', 'Media Law & Ethics', 'Film Studies']),
      d('Political Science', ['Political Theory', 'International Relations', 'Public Administration', 'Comparative Politics', 'Nigerian Government']),
      d('Psychology', ['Cognitive Psychology', 'Developmental Psychology', 'Social Psychology', 'Abnormal Psychology', 'Research Methods']),
      d('Sociology', ['Social Theory', 'Criminology', 'Industrial Sociology', 'Rural Sociology', 'Social Research Methods']),
    ],
  },
  {
    name: 'Management Sciences',
    emphasis: 'applied analysis of real business and financial scenarios, and sound decision-making',
    interests: ['Accounting', 'Business Administration', 'Marketing', 'Banking & Finance', 'Economics', 'Public Administration'],
    departments: [
      d('Accounting', ['Financial Accounting', 'Cost Accounting', 'Auditing', 'Taxation', 'Management Accounting'],
        'correct application of accounting standards with fully worked figures and statements'),
      d('Actuarial Science', ['Actuarial Mathematics', 'Risk Theory', 'Life Contingencies', 'Financial Mathematics', 'Statistics'],
        'quantitative risk and financial mathematics with fully worked calculations'),
      d('Banking & Finance', ['Corporate Finance', 'Investment Analysis', 'Financial Markets', 'Risk Management', 'Monetary Economics']),
      d('Business Administration', ['Management Principles', 'Organisational Behaviour', 'Strategic Management', 'Entrepreneurship', 'Operations Management']),
      d('Marketing', ['Consumer Behaviour', 'Digital Marketing', 'Brand Management', 'Market Research', 'Sales Management']),
      d('Public Administration', ['Public Policy', 'Local Government', 'Development Administration', 'Public Finance', 'Human Resource Management']),
    ],
  },
  {
    name: 'Engineering',
    emphasis: 'first-principles derivation, quantitative problem-solving and design trade-offs, always with correct units',
    interests: ['Mathematics', 'Physics', 'Engineering Mechanics', 'Thermodynamics', 'Circuit Analysis', 'Materials Science'],
    departments: [
      d('Chemical Engineering', ['Thermodynamics', 'Fluid Mechanics', 'Reaction Engineering', 'Process Control', 'Mass Transfer']),
      d('Civil Engineering', ['Structural Analysis', 'Geotechnics', 'Fluid Mechanics', 'Surveying', 'Reinforced Concrete', 'Highway Engineering']),
      d('Computer Engineering', ['Digital Logic', 'Microprocessors', 'Embedded Systems', 'Computer Architecture', 'Networks', 'Programming']),
      d('Electrical & Electronic Engineering', ['Circuit Analysis', 'Electromagnetics', 'Control Systems', 'Power Systems', 'Electronics', 'Signals & Systems']),
      d('Mechanical Engineering', ['Thermodynamics', 'Fluid Mechanics', 'Machine Design', 'Materials Science', 'Dynamics', 'Manufacturing']),
      d('Mechatronics Engineering', ['Robotics', 'Control Systems', 'Sensors & Actuators', 'Embedded Systems', 'Automation']),
      d('Petroleum Engineering', ['Reservoir Engineering', 'Drilling Engineering', 'Production Engineering', 'Petrophysics', 'Fluid Mechanics']),
    ],
  },
  {
    name: 'Environmental Sciences',
    emphasis: 'applied design and technical problem-solving grounded in real site and context examples',
    interests: ['Architecture', 'Building Technology', 'Estate Management', 'Surveying', 'Urban Planning', 'Quantity Surveying'],
    departments: [
      d('Architecture', ['Architectural Design', 'Building Technology', 'History of Architecture', 'Environmental Design', 'CAD']),
      d('Building', ['Building Construction', 'Structures', 'Building Services', 'Construction Management', 'Materials']),
      d('Estate Management', ['Property Valuation', 'Land Economics', 'Property Law', 'Facilities Management', 'Estate Agency']),
      d('Quantity Surveying', ['Measurement of Works', 'Estimating', 'Construction Economics', 'Contract Administration']),
      d('Surveying & Geoinformatics', ['Geodesy', 'Cartography', 'GIS & Remote Sensing', 'Photogrammetry', 'Cadastral Surveying']),
      d('Urban & Regional Planning', ['Urban Design', 'Regional Planning', 'Housing Studies', 'Transport Planning', 'Environmental Planning']),
    ],
  },
  {
    name: 'Agriculture',
    emphasis: 'applied field and production practice grounded in the underlying science',
    interests: ['Crop Science', 'Animal Science', 'Soil Science', 'Agricultural Economics', 'Food Science', 'Agricultural Extension'],
    departments: [
      d('Agricultural Economics', ['Farm Management', 'Agricultural Marketing', 'Resource Economics', 'Agribusiness', 'Rural Development']),
      d('Agricultural Extension', ['Extension Methods', 'Rural Sociology', 'Community Development', 'Communication in Agriculture']),
      d('Animal Science', ['Animal Nutrition', 'Animal Breeding', 'Livestock Production', 'Poultry Science', 'Animal Physiology']),
      d('Crop Science', ['Crop Production', 'Plant Breeding', 'Agronomy', 'Plant Pathology', 'Horticulture']),
      d('Food Science & Technology', ['Food Chemistry', 'Food Microbiology', 'Food Processing', 'Food Preservation', 'Nutrition']),
      d('Soil Science', ['Soil Fertility', 'Soil Physics', 'Soil Chemistry', 'Land Management', 'Pedology']),
    ],
  },
  {
    name: 'Arts & Humanities',
    emphasis: 'close reading, argument and interpretation supported by textual and historical evidence',
    interests: ['Literature', 'History', 'Philosophy', 'Linguistics', 'Religious Studies', 'Theatre Arts'],
    departments: [
      d('English & Literary Studies', ['Poetry', 'Prose Fiction', 'Drama', 'Literary Criticism', 'African Literature', 'Grammar']),
      d('History & International Studies', ['African History', 'World History', 'International Relations', 'Diplomatic History', 'Historiography']),
      d('Linguistics', ['Phonetics', 'Syntax', 'Semantics', 'Sociolinguistics', 'Morphology']),
      d('Philosophy', ['Logic', 'Ethics', 'Epistemology', 'Metaphysics', 'African Philosophy']),
      d('Religious Studies', ['Biblical Studies', 'Islamic Studies', 'Comparative Religion', 'Church History', 'Ethics']),
      d('Theatre Arts', ['Acting', 'Playwriting', 'Stagecraft', 'Directing', 'Dramatic Theory']),
    ],
  },
  {
    name: 'Education',
    emphasis: 'pedagogical reasoning and application to real teaching and learning contexts',
    interests: ['Educational Psychology', 'Curriculum Studies', 'Science Education', 'Guidance & Counselling', 'Educational Management'],
    departments: [
      d('Adult Education', ['Andragogy', 'Community Education', 'Literacy Studies', 'Vocational Education']),
      d('Educational Management', ['Educational Administration', 'Educational Planning', 'School Supervision', 'Policy Studies']),
      d('Guidance & Counselling', ['Counselling Theories', 'Career Counselling', 'Psychological Testing', 'Group Counselling']),
      d('Human Kinetics', ['Exercise Physiology', 'Sports Psychology', 'Kinesiology', 'Sports Management']),
      d('Science Education', ['Biology Education', 'Chemistry Education', 'Physics Education', 'Mathematics Education', 'Curriculum Studies']),
    ],
  },
  {
    name: 'Law',
    emphasis: 'IRAC-style reasoning (issue, rule, application, conclusion) grounded in statute and case authority',
    interests: ['Constitutional Law', 'Criminal Law', 'Contract Law', 'Commercial Law', 'International Law', 'Jurisprudence'],
    departments: [
      d('Common Law', ['Contract Law', 'Law of Torts', 'Criminal Law', 'Land Law', 'Equity & Trusts']),
      d('Commercial & Property Law', ['Company Law', 'Commercial Law', 'Property Law', 'Taxation Law', 'Intellectual Property']),
      d('Public & International Law', ['Constitutional Law', 'Administrative Law', 'International Law', 'Human Rights', 'Jurisprudence']),
    ],
  },
];

/** A generic fallback for a student with no faculty/department chosen yet. */
export const GENERAL_INTERESTS: string[] = [
  'Mathematics',
  'English',
  'Biology',
  'Chemistry',
  'Physics',
  'Computer Science',
  'Study Skills',
  'Research Methods',
];

/**
 * Resolve the interest suggestions for a (faculty, department) pair.
 * Department-specific first, faculty fallback next, general default last. Matching
 * is case-insensitive and trims, so client free-text values still line up.
 */
export function resolveInterests(faculty?: string, department?: string): string[] {
  const facultyRow = faculty
    ? ACADEMIC_FACULTIES.find((f) => f.name.toLowerCase() === faculty.trim().toLowerCase())
    : undefined;

  if (facultyRow && department) {
    const deptRow = facultyRow.departments.find(
      (dep) => dep.name.toLowerCase() === department.trim().toLowerCase(),
    );
    if (deptRow && deptRow.interests.length > 0) return deptRow.interests;
  }

  if (facultyRow && facultyRow.interests.length > 0) return facultyRow.interests;

  return GENERAL_INTERESTS;
}

export interface Discipline {
  /** The matched faculty name, or the student's free-text value, or null. */
  faculty: string | null;
  /** The matched department name, or the student's free-text value, or null. */
  department: string | null;
  /** How the AI should pitch content for this student — see `FacultyConfig.emphasis`. */
  emphasis: string;
}

/**
 * How to frame AI content for a student with no recognised faculty/department yet
 * — discipline-neutral, and deliberately NOT health-flavoured. This is what a maths
 * student saw "clinical application" instead of, before the reformation.
 */
const GENERAL_EMPHASIS =
  'clear reasoning and genuine understanding over rote memorisation, with concrete worked examples appropriate to the subject';

/**
 * Resolve the pedagogical framing for a (faculty, department) pair — the single
 * fact that lets every AI prompt speak the student's discipline instead of assuming
 * health science (reformation — discipline-aware prompts).
 *
 * DEPARTMENT-FIRST with a FACULTY FALLBACK, exactly like `resolveInterests`: a
 * department that curates its own `emphasis` uses it (Maths wants proofs, not the
 * Sciences faculty's generic "derivations or calculations"); otherwise the faculty's
 * emphasis applies. Unmatched free-text names pass THROUGH (they are still shown to
 * the model as the student's field) but fall back to a neutral, non-clinical
 * emphasis. Matching is case-insensitive and trimmed, so client free-text lines up.
 */
export function resolveDiscipline(faculty?: string, department?: string): Discipline {
  const facultyRow = faculty
    ? ACADEMIC_FACULTIES.find((f) => f.name.toLowerCase() === faculty.trim().toLowerCase())
    : undefined;

  // Empty/whitespace free-text collapses to null; a real value passes through.
  // (`??` is wrong here — an empty string is not nullish but must still become null.)
  const nonEmpty = (value?: string): string | null => {
    const trimmed = value?.trim() ?? '';
    return trimmed.length > 0 ? trimmed : null;
  };

  let emphasis = facultyRow?.emphasis ?? GENERAL_EMPHASIS;
  let departmentName = nonEmpty(department);

  if (facultyRow && department) {
    const deptRow = facultyRow.departments.find(
      (dep) => dep.name.toLowerCase() === department.trim().toLowerCase(),
    );
    if (deptRow) {
      departmentName = deptRow.name;
      if (deptRow.emphasis) emphasis = deptRow.emphasis;
    }
  }

  return {
    faculty: facultyRow?.name ?? nonEmpty(faculty),
    department: departmentName,
    emphasis,
  };
}
