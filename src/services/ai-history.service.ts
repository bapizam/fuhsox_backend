/**
 * One timeline over everything the AI has produced for a student.
 *
 * Until now this data was write-only from the student's point of view: questions
 * were forged, tutor feedback was streamed, mastery checks were scored and plans
 * were generated, and none of it was readable afterwards except the single live
 * study plan and a per-session review. `GET /ai/feedback/me` existed but no client
 * ever called it.
 *
 * Four sources, three stores:
 *   - forged questions  → Mongo  `AIQuestion`
 *   - tutor feedback    → Mongo  `AIFeedback`
 *   - mastery attempts  → Postgres `MasteryAttempt` (+ objective for its statement)
 *   - plan generations  → Mongo  `StudyPlanVersion`
 *
 * **Ordering across stores.** There is no cross-store cursor, so each source is
 * queried for the first `page * limit` rows by recency, the results are merged,
 * sorted once, and the requested window is sliced out. Correct for every page at
 * the cost of over-fetching on deep ones — acceptable because a single student's
 * history is small and bounded by their AI budget (20 calls/day). If that ever
 * stops being true, the fix is a materialised timeline collection written at
 * generation time, not a smarter merge.
 *
 * ZERO AI calls: this is entirely reads.
 */
import prisma from '@config/database';
import { AIQuestion, AIFeedback, StudyPlanVersion } from '../../mongo/schemas';
import { parseOptions, type McqOption } from '@utils/mcq';

export type HistoryKind = 'question' | 'feedback' | 'mastery' | 'plan';

interface BaseItem {
  id: string;
  kind: HistoryKind;
  /** ISO 8601. The single field the timeline sorts on. */
  created_at: string;
}

export interface QuestionHistoryItem extends BaseItem {
  kind: 'question';
  topic: string;
  difficulty: string;
  question_type: string;
  question_text: string;
  options?: McqOption[];
  correct_answer: string;
  explanation?: string;
  quality_flag: string;
  /**
   * Present when the item belongs to a mastery-check pool rather than a
   * free-form forge — the UI labels those differently.
   */
  objective_id?: string;
  /** Empirical difficulty so far (`correct_count / seen_count`), null if unseen. */
  observed_p?: number | null;
  seen_count: number;
}

export interface FeedbackHistoryItem extends BaseItem {
  kind: 'feedback';
  session_id?: string;
  question_id?: string;
  course_code?: string;
  topic?: string;
  question_text?: string;
  chosen_answer?: string;
  chosen_answer_text?: string;
  correct_answer?: string;
  correct_answer_text?: string;
  misconception?: string;
  options?: McqOption[];
  ai_explanation?: string;
}

export interface MasteryHistoryItem extends BaseItem {
  kind: 'mastery';
  objective_id: string;
  /** The objective's statement, or null when the objective row was deleted. */
  statement: string | null;
  subject: string | null;
  session_id?: string;
  score_percent: number;
  threshold: number;
  passed: boolean;
  weak_concepts: string[];
}

export interface PlanHistoryItem extends BaseItem {
  kind: 'plan';
  subjects: string[];
  exam_date?: string;
  daily_hours?: number;
  total_weeks: number;
  total_tasks: number;
  milestones: string[];
}

export type HistoryItem =
  | QuestionHistoryItem
  | FeedbackHistoryItem
  | MasteryHistoryItem
  | PlanHistoryItem;

export interface HistoryPage {
  items: HistoryItem[];
  pagination: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
    hasMore: boolean;
  };
  /** Per-kind totals, so the UI can show counts on its filter chips. */
  counts: Record<HistoryKind, number>;
}

const ALL_KINDS: HistoryKind[] = ['question', 'feedback', 'mastery', 'plan'];

/** `correct_count / seen_count`, or null while there is no evidence. */
function observedP(seen: number, correct: number): number | null {
  if (seen <= 0) return null;
  return Math.min(Math.max(correct, 0), seen) / seen;
}

export async function getAIHistory(params: {
  userId: string;
  institutionId: string;
  page: number;
  limit: number;
  /** Restrict to one kind; omit or 'all' for the merged timeline. */
  kind?: HistoryKind | 'all';
  /** Case-insensitive match over the text fields of each source. */
  search?: string;
}): Promise<HistoryPage> {
  const page = Math.max(1, params.page);
  const limit = Math.min(Math.max(1, params.limit), 50);
  const wanted: HistoryKind[] =
    !params.kind || params.kind === 'all' ? ALL_KINDS : [params.kind];

  // Over-fetch depth: enough rows from each source that the merged slice for this
  // page is exact regardless of how the timestamps interleave.
  const depth = page * limit;
  const search = params.search?.trim();
  const regex = search ? new RegExp(escapeRegex(search), 'i') : null;

  const [questions, feedback, mastery, plans] = await Promise.all([
    wanted.includes('question')
      ? loadQuestions(params.userId, params.institutionId, depth, regex)
      : emptySource(),
    wanted.includes('feedback')
      ? loadFeedback(params.userId, params.institutionId, depth, regex)
      : emptySource(),
    wanted.includes('mastery') ? loadMastery(params.userId, depth, regex) : emptySource(),
    wanted.includes('plan') ? loadPlans(params.userId, depth, regex) : emptySource(),
  ]);

  const merged = [...questions.items, ...feedback.items, ...mastery.items, ...plans.items].sort(
    (a, b) => b.created_at.localeCompare(a.created_at),
  );

  const total = questions.total + feedback.total + mastery.total + plans.total;
  const start = (page - 1) * limit;

  return {
    items: merged.slice(start, start + limit),
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      hasMore: start + limit < total,
    },
    counts: {
      question: questions.total,
      feedback: feedback.total,
      mastery: mastery.total,
      plan: plans.total,
    },
  };
}

interface Source {
  items: HistoryItem[];
  total: number;
}

function emptySource(): Promise<Source> {
  return Promise.resolve({ items: [], total: 0 });
}

/** Escape user input before it becomes a Mongo/JS regex. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function loadQuestions(
  userId: string,
  institutionId: string,
  depth: number,
  regex: RegExp | null,
): Promise<Source> {
  const query: Record<string, unknown> = { user_id: userId, institution_id: institutionId };
  if (regex) {
    query['$or'] = [{ question_text: regex }, { topic: regex }, { explanation: regex }];
  }

  const [rows, total] = await Promise.all([
    AIQuestion.find(query).sort({ createdAt: -1 }).limit(depth).lean(),
    AIQuestion.countDocuments(query),
  ]);

  return {
    total,
    items: rows.map((q) => ({
      kind: 'question' as const,
      id: q._id.toString(),
      created_at: q.createdAt.toISOString(),
      topic: q.topic,
      difficulty: q.difficulty,
      question_type: q.question_type,
      question_text: q.question_text,
      options: parseOptions(q.options),
      correct_answer: q.correct_answer,
      ...(q.explanation ? { explanation: q.explanation } : {}),
      quality_flag: q.quality_flag,
      ...(q.objective_id ? { objective_id: q.objective_id } : {}),
      observed_p: observedP(q.seen_count ?? 0, q.correct_count ?? 0),
      seen_count: q.seen_count ?? 0,
    })),
  };
}

async function loadFeedback(
  userId: string,
  institutionId: string,
  depth: number,
  regex: RegExp | null,
): Promise<Source> {
  const query: Record<string, unknown> = { user_id: userId, institution_id: institutionId };
  if (regex) {
    query['$or'] = [{ question_text: regex }, { ai_explanation: regex }, { topic: regex }];
  }

  const [rows, total] = await Promise.all([
    AIFeedback.find(query).sort({ createdAt: -1 }).limit(depth).lean(),
    AIFeedback.countDocuments(query),
  ]);

  return {
    total,
    items: rows.map((f) => ({
      kind: 'feedback' as const,
      id: f._id.toString(),
      created_at: f.createdAt.toISOString(),
      ...(f.session_id ? { session_id: f.session_id } : {}),
      ...(f.question_id ? { question_id: f.question_id } : {}),
      ...(f.course_code ? { course_code: f.course_code } : {}),
      ...(f.topic ? { topic: f.topic } : {}),
      ...(f.question_text ? { question_text: f.question_text } : {}),
      ...(f.chosen_answer ? { chosen_answer: f.chosen_answer } : {}),
      ...(f.chosen_answer_text ? { chosen_answer_text: f.chosen_answer_text } : {}),
      ...(f.correct_answer ? { correct_answer: f.correct_answer } : {}),
      ...(f.correct_answer_text ? { correct_answer_text: f.correct_answer_text } : {}),
      ...(f.misconception ? { misconception: f.misconception } : {}),
      options: parseOptions(f.options),
      ...(f.ai_explanation ? { ai_explanation: f.ai_explanation } : {}),
    })),
  };
}

async function loadMastery(userId: string, depth: number, regex: RegExp | null): Promise<Source> {
  const [rows, total] = await Promise.all([
    prisma.masteryAttempt.findMany({
      where: { user_id: userId },
      orderBy: { created_at: 'desc' },
      take: depth,
      include: { objective: { select: { statement: true, subject: true } } },
    }),
    prisma.masteryAttempt.count({ where: { user_id: userId } }),
  ]);

  // Filtered in memory, not in SQL: the searchable text lives on the joined
  // objective, and the row count above must stay the unfiltered total so the
  // filter chips keep showing how much history exists.
  const matched = regex
    ? rows.filter(
        (a) =>
          regex.test(a.objective?.statement ?? '') ||
          regex.test(a.objective?.subject ?? '') ||
          a.weak_concepts.some((c) => regex.test(c)),
      )
    : rows;

  return {
    total: regex ? matched.length : total,
    items: matched.map((a) => ({
      kind: 'mastery' as const,
      id: a.id,
      created_at: a.created_at.toISOString(),
      objective_id: a.objective_id,
      statement: a.objective?.statement ?? null,
      subject: a.objective?.subject ?? null,
      ...(a.session_id ? { session_id: a.session_id } : {}),
      score_percent: a.score_percent,
      threshold: a.threshold,
      passed: a.passed,
      weak_concepts: a.weak_concepts,
    })),
  };
}

async function loadPlans(userId: string, depth: number, regex: RegExp | null): Promise<Source> {
  const query: Record<string, unknown> = { user_id: userId };
  if (regex) {
    query['$or'] = [{ subjects: regex }, { milestones: regex }];
  }

  const [rows, total] = await Promise.all([
    StudyPlanVersion.find(query).sort({ createdAt: -1 }).limit(depth).lean(),
    StudyPlanVersion.countDocuments(query),
  ]);

  return {
    total,
    items: rows.map((p) => ({
      kind: 'plan' as const,
      id: p._id.toString(),
      created_at: p.createdAt.toISOString(),
      subjects: p.subjects ?? [],
      ...(p.exam_date ? { exam_date: p.exam_date.toISOString() } : {}),
      ...(p.daily_hours !== undefined ? { daily_hours: p.daily_hours } : {}),
      total_weeks: p.total_weeks ?? p.weeks?.length ?? 0,
      total_tasks: p.total_tasks ?? 0,
      milestones: p.milestones ?? [],
    })),
  };
}

export const aiHistoryService = { getAIHistory };
