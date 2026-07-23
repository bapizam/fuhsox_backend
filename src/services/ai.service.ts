import type { Socket } from 'socket.io';
import { callAI, streamFeedback } from '@lib/ai-provider';
import prisma from '@config/database';
import { AIQuestion, AIFeedback, StudyPlan } from '../../mongo/schemas';
import { REDIS_KEYS } from '@config/constants';
import { incrWithExpiry, getCount, getEndOfDayTTL, getTodayWAT } from '@lib/redis';
import { AppError, type GeneratedQuestion, type AIGenerationResult } from '@typings/models';
import { partitionValidItems, type RawItem } from '@utils/item-validation';
import logger from '@lib/logger';

// ─── System Prompts ────────────────────────────────────────────────────────────

const QUESTION_GENERATION_SYSTEM_PROMPT = `You are an expert academic question setter for Nigerian university health science students at the Federal University of Health Sciences, Otukpo (FUHSO).
Generate exam-quality questions that test deep understanding, critical thinking, and clinical application — not rote memorisation.
For MCQs: provide one clearly correct answer and three plausible, educationally valuable distractors. No trick questions.
For short answer: provide a concise model answer.
CRITICAL: Always respond with VALID JSON ONLY — no markdown fences, no preamble, no explanation outside JSON.
JSON format strictly: { "questions": [{ "question_text": string, "options"?: [{"key": string, "text": string}], "correct_answer": string, "explanation": string, "quality_flag": "good" }] }`;

const FEEDBACK_SYSTEM_PROMPT = `You are a supportive and knowledgeable academic tutor for Nigerian university health science students.
When a student answers a question incorrectly, provide:
1. A brief, encouraging acknowledgement (not dismissive)
2. A clear explanation of WHY the correct answer is right
3. WHY the student's chosen answer is wrong (address their specific misconception)
4. A memorable clinical/conceptual tip to help them remember
Keep responses concise (150-250 words), warm, and pedagogically sound.
Respond in plain text — no markdown formatting.`;

const STUDY_PLAN_SYSTEM_PROMPT = `You are an expert academic coach for Nigerian university health sciences students.
Generate a structured, realistic, week-by-week study plan in strict JSON format.
JSON format: { "weeks": [{ "week_number": number, "days": [{ "day": string, "date": string, "tasks": [{ "subject": string, "topic": string, "duration_mins": number, "activity_type": string, "recommended_question_set": string, "completed": false }] }] }], "milestones": [string] }
No markdown, no preamble. Valid JSON only.`;

// ─── Question Generation ───────────────────────────────────────────────────────

export async function generateQuestions(params: {
  topic:          string;
  question_type:  'mcq' | 'short_answer' | 'fill_blank';
  difficulty:     'easy' | 'medium' | 'hard';
  count:          number;
  userId:         string;
  institutionId:  string;
}): Promise<AIGenerationResult> {
  // Check daily rate limit
  const institution = await prisma.institution.findUnique({
    where:  { id: params.institutionId },
    select: { ai_daily_limit: true },
  });

  const dailyLimit   = institution?.ai_daily_limit ?? 20;
  const redisKey     = REDIS_KEYS.AI_DAILY(params.userId, getTodayWAT());
  const currentUsage = await getCount(redisKey);

  if (currentUsage >= dailyLimit) {
    throw new AppError(
      429,
      'AI_LIMIT_REACHED',
      `Daily AI question limit of ${dailyLimit} reached. Resets at midnight WAT.`,
    );
  }

  const prompt = buildGenerationPrompt(params);

  // ── Call whichever provider is active (Claude or Gemini) ────────────────────
  const response = await callAI({
    system:     QUESTION_GENERATION_SYSTEM_PROMPT,
    messages:   [{ role: 'user', content: prompt }],
    max_tokens: 4096,
  });

  const questions  = parseGeneratedQuestions(response.text, params.question_type);
  const tokensUsed = response.input_tokens + response.output_tokens;

  // Increment daily counter
  await incrWithExpiry(redisKey, getEndOfDayTTL());

  // Log usage
  await prisma.aIUsageLog.create({
    data: {
      user_id:        params.userId,
      institution_id: params.institutionId,
      feature:        'question_generation',
      tokens_used:    tokensUsed,
      model:          response.model,
    },
  });

  // Save to MongoDB AIQuestion collection
  const savedQuestions = await AIQuestion.insertMany(
    questions.map((q) => ({
      user_id:        params.userId,
      institution_id: params.institutionId,
      topic:          params.topic,
      question_type:  params.question_type,
      question_text:  q.question_text,
      options:        q.options,
      correct_answer: q.correct_answer,
      explanation:    q.explanation,
      difficulty:     params.difficulty,
      quality_flag:   q.quality_flag ?? 'good',
    })),
  );

  const newCount  = currentUsage + 1;
  const remaining = Math.max(0, dailyLimit - newCount);

  logger.info(
    { userId: params.userId, count: questions.length, tokensUsed, provider: response.provider },
    'AI questions generated',
  );

  return {
    questions: savedQuestions.map((q) => ({
      _id:            q._id.toString(),
      question_text:  q.question_text,
      options:        q.options,
      correct_answer: q.correct_answer,
      explanation:    q.explanation,
      quality_flag:   q.quality_flag,
    })),
    daily_remaining: remaining,
  };
}

// ─── Quiz Feedback Streaming ───────────────────────────────────────────────────

export async function streamAnswerFeedback(
  socket: Socket,
  params: {
    sessionId:     string;
    questionId:    string;
    question:      {
      question_text:  string;
      correct_answer: string;
      explanation?:   string;
      course_code:    string;
      topic:          string;
    };
    chosenAnswer:  string;
    userId:        string;
    institutionId: string;
  },
): Promise<string> {
  // Feedback now shares the same daily AI budget as generation + study plans
  // (it used to be free). Check before spending; if the budget is exhausted,
  // stream a friendly notice in place of feedback and do NOT charge.
  const institution = await prisma.institution.findUnique({
    where:  { id: params.institutionId },
    select: { ai_daily_limit: true },
  });
  const dailyLimit   = institution?.ai_daily_limit ?? 20;
  const redisKey     = REDIS_KEYS.AI_DAILY(params.userId, getTodayWAT());
  const currentUsage = await getCount(redisKey);

  if (currentUsage >= dailyLimit) {
    const notice = `You've used all ${dailyLimit} of today's AI credits, so automatic feedback is paused. It resets at midnight WAT.`;
    socket.emit('quiz:answer_feedback', {
      token:       notice,
      session_id:  params.sessionId,
      question_id: params.questionId,
      is_done:     false,
    });
    socket.emit('quiz:answer_feedback', {
      token:       '',
      session_id:  params.sessionId,
      question_id: params.questionId,
      is_done:     true,
    });
    logger.info({ userId: params.userId, dailyLimit }, 'AI feedback skipped — daily budget reached');
    return notice;
  }

  const prompt = buildFeedbackPrompt(params.question, params.chosenAnswer);

  let fullText = '';

  try {
    // ── Stream feedback via active provider ─────────────────────────────────
    const result = await streamFeedback(socket, {
      system:      FEEDBACK_SYSTEM_PROMPT,
      messages:    [{ role: 'user', content: prompt }],
      max_tokens:  500,
      session_id:  params.sessionId,
      question_id: params.questionId,
    });

    fullText = result.text;

    // Persist feedback to MongoDB
    const feedbackDoc = await AIFeedback.create({
      user_id:        params.userId,
      institution_id: params.institutionId,
      session_id:     params.sessionId,
      question_id:    params.questionId,
      question_text:  params.question.question_text,
      course_code:    params.question.course_code,
      topic:          params.question.topic,
      chosen_answer:  params.chosenAnswer,
      correct_answer: params.question.correct_answer,
      ai_explanation: fullText,
      model_used:     result.model,
      tokens_used:    result.input_tokens + result.output_tokens,
    });

    // Log AI usage
    await prisma.aIUsageLog.create({
      data: {
        user_id:        params.userId,
        institution_id: params.institutionId,
        feature:        'quiz_feedback',
        tokens_used:    result.input_tokens + result.output_tokens,
        model:          result.model,
      },
    });

    // Link feedback to the SessionAnswer record
    await prisma.sessionAnswer.updateMany({
      where: {
        session_id:  params.sessionId,
        question_id: params.questionId,
      },
      data: { ai_feedback_id: feedbackDoc._id.toString() },
    });

    // Charge one AI credit — only on a successful, delivered feedback.
    await incrWithExpiry(redisKey, getEndOfDayTTL());

    logger.debug(
      { sessionId: params.sessionId, provider: result.provider },
      'AI feedback streamed and saved',
    );

  } catch (err) {
    logger.error({ err, sessionId: params.sessionId }, 'AI feedback streaming failed');

    socket.emit('quiz:answer_feedback', {
      token:       '',
      session_id:  params.sessionId,
      question_id: params.questionId,
      is_done:     true,
      error:       'AI feedback temporarily unavailable',
    });
  }

  return fullText;
}

// ─── Study Plan Generation ─────────────────────────────────────────────────────

export async function generateStudyPlan(params: {
  userId:        string;
  institutionId: string;
  subjects:      string[];
  examDate:      Date;
  dailyHours:    number;
}): Promise<Record<string, unknown>> {
  // Same daily budget as question generation (plan generation used to be
  // unmetered — anyone could burn tokens without touching the limit).
  const institution = await prisma.institution.findUnique({
    where:  { id: params.institutionId },
    select: { ai_daily_limit: true },
  });

  const dailyLimit   = institution?.ai_daily_limit ?? 20;
  const redisKey     = REDIS_KEYS.AI_DAILY(params.userId, getTodayWAT());
  const currentUsage = await getCount(redisKey);

  if (currentUsage >= dailyLimit) {
    throw new AppError(
      429,
      'AI_LIMIT_REACHED',
      `Daily AI limit of ${dailyLimit} reached. Resets at midnight WAT.`,
    );
  }

  const prompt = buildStudyPlanPrompt(params);

  // ── Call whichever provider is active ────────────────────────────────────
  const response = await callAI({
    system:     STUDY_PLAN_SYSTEM_PROMPT,
    messages:   [{ role: 'user', content: prompt }],
    max_tokens: 8192,
  });

  let planData: Record<string, unknown>;
  try {
    const cleaned = response.text
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/g, '')
      .trim();
    planData = JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    throw new AppError(500, 'INTERNAL_ERROR', 'AI returned malformed study plan data');
  }

  // Count the successful generation against today's budget
  await incrWithExpiry(redisKey, getEndOfDayTTL());

  await prisma.aIUsageLog.create({
    data: {
      user_id:        params.userId,
      institution_id: params.institutionId,
      feature:        'study_plan',
      tokens_used:    response.input_tokens + response.output_tokens,
      model:          response.model,
    },
  });

  logger.info(
    { userId: params.userId, provider: response.provider },
    'Study plan generated',
  );

  return planData;
}

// ─── PDF Question Parsing ──────────────────────────────────────────────────────

export async function parseQuestionsFromText(
  extractedText:  string,
  institutionId:  string,
  courseContext?: string,
): Promise<GeneratedQuestion[]> {
  const prompt = `Extract all exam questions from the following text.
${courseContext ? `Context: ${courseContext}` : ''}
For each question, identify: question text, options (if MCQ), correct answer (if available), and explanation.
Return ONLY valid JSON: { "questions": [...] }

TEXT:
${extractedText.substring(0, 15000)}`;

  const response = await callAI({
    system:     QUESTION_GENERATION_SYSTEM_PROMPT,
    messages:   [{ role: 'user', content: prompt }],
    max_tokens: 8192,
  });

  return parseGeneratedQuestions(response.text, 'mcq');
}

// ─── Retrieve Study Plan ───────────────────────────────────────────────────────

export async function getStudyPlan(userId: string): Promise<Record<string, unknown> | null> {
  const plan = await StudyPlan.findOne({ user_id: userId }).lean();
  return plan;
}

// ─── Update Study-Plan Task Completion ─────────────────────────────────────────

/**
 * Toggle one task's `completed` flag (mobile-additive; the plan previously had
 * no write path besides full regeneration). Tasks are addressed positionally —
 * week_number + day date + task index — because regeneration replaces the
 * whole document anyway.
 */
export async function updateStudyPlanTask(
  userId: string,
  target: { week_number: number; date: string; task_index: number; completed: boolean },
): Promise<Record<string, unknown>> {
  const plan = await StudyPlan.findOne({ user_id: userId });
  if (!plan) throw new AppError(404, 'NOT_FOUND', 'No study plan found — generate one first');

  const week = plan.weeks.find((w) => w.week_number === target.week_number);
  const day  = week?.days.find((d) => d.date === target.date);
  const task = day?.tasks[target.task_index];
  if (!task) throw new AppError(404, 'NOT_FOUND', 'Task not found in the study plan');

  task.completed = target.completed;
  plan.markModified('weeks');
  await plan.save();

  return plan.toObject() as unknown as Record<string, unknown>;
}

// ─── Get AI Feedback History ──────────────────────────────────────────────────

export async function getAIFeedbackHistory(
  userId:        string,
  institutionId: string,
  page:          number = 1,
  limit:         number = 20,
  filters: {
    course_code?: string;
    search?:      string;
  } = {},
) {
  const skip  = (page - 1) * limit;
  const query: Record<string, unknown> = {
    user_id:        userId,
    institution_id: institutionId,
  };

  if (filters.course_code) {
    query['course_code'] = filters.course_code;
  }

  if (filters.search) {
    query['$or'] = [
      { question_text:  { $regex: filters.search, $options: 'i' } },
      { ai_explanation: { $regex: filters.search, $options: 'i' } },
      { topic:          { $regex: filters.search, $options: 'i' } },
    ];
  }

  const [items, total] = await Promise.all([
    AIFeedback.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    AIFeedback.countDocuments(query),
  ]);

  return {
    feedback_items: items,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      hasMore:    page * limit < total,
    },
  };
}

// ─── Flag AI Question ──────────────────────────────────────────────────────────

export async function flagAIQuestion(
  questionId: string,
  userId:     string,
  reason?:    string,
): Promise<{ flagged: boolean }> {
  const question = await AIQuestion.findOne({ _id: questionId, user_id: userId });
  if (!question) {
    throw new AppError(404, 'NOT_FOUND', 'AI question not found or not owned by you');
  }

  await AIQuestion.findByIdAndUpdate(questionId, {
    quality_flag: 'flagged',
    flag_reason:  reason ?? 'Flagged by user',
  });

  return { flagged: true };
}

// ─── Prompt Builders ───────────────────────────────────────────────────────────

function buildGenerationPrompt(params: {
  topic: string; question_type: string; difficulty: string; count: number;
}): string {
  return `Generate exactly ${params.count} ${params.difficulty}-difficulty ${params.question_type} questions on the following topic:

Topic: "${params.topic}"

Context: Nigerian university health sciences curriculum (Federal University of Health Sciences, Otukpo — FUHSO).

Requirements:
- Questions must test real understanding and clinical application
- Each question must have a detailed explanation of the correct answer
- For MCQs: exactly 4 options (A, B, C, D) with one correct answer
- Difficulty calibration: ${
  params.difficulty === 'hard'   ? 'complex scenarios, multi-step reasoning' :
  params.difficulty === 'medium' ? 'application of concepts, moderate complexity' :
                                   'fundamental concepts, straightforward'
}

Return valid JSON matching the specified schema. Count must be exactly ${params.count}.`;
}

function buildFeedbackPrompt(
  question: { question_text: string; correct_answer: string; explanation?: string },
  chosenAnswer: string,
): string {
  return `QUESTION: ${question.question_text}

STUDENT'S ANSWER: ${chosenAnswer}
CORRECT ANSWER: ${question.correct_answer}
${question.explanation ? `OFFICIAL EXPLANATION: ${question.explanation}` : ''}

The student got this wrong. Please provide helpful, encouraging feedback explaining the correct answer and addressing their specific misconception.`;
}

function buildStudyPlanPrompt(params: {
  subjects: string[]; examDate: Date; dailyHours: number;
}): string {
  const today     = new Date();
  const weeksLeft = Math.max(1, Math.ceil(
    (params.examDate.getTime() - today.getTime()) / (7 * 86400000),
  ));

  return `Create a ${weeksLeft}-week study plan for a Nigerian health science student.

Subjects: ${params.subjects.join(', ')}
Exam date: ${params.examDate.toISOString().split('T')[0]}
Available study hours per day: ${params.dailyHours}
Starting date: ${today.toISOString().split('T')[0]}
Weeks available: ${weeksLeft}

Create a realistic, balanced plan that allocates time proportionally across subjects, includes practice question sessions, and has clear weekly milestones. Format as specified JSON.`;
}

// ─── Response Parser ───────────────────────────────────────────────────────────

function parseGeneratedQuestions(
  rawText:       string,
  _questionType: string,
): GeneratedQuestion[] {
  try {
    const cleaned = rawText
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/g, '')
      .trim();

    const parsed = JSON.parse(cleaned) as { questions?: GeneratedQuestion[] };
    if (!Array.isArray(parsed.questions)) {
      logger.warn('AI response missing questions array');
      return [];
    }

    return parsed.questions.filter((q): q is GeneratedQuestion =>
      typeof q.question_text === 'string' &&
      typeof q.correct_answer === 'string',
    );
  } catch (err) {
    logger.error({ err, rawText: rawText.substring(0, 200) }, 'Failed to parse AI question response');
    return [];
  }
}

// ─── Adaptive Learning Engine (M7 item 4) ──────────────────────────────────────

const SYLLABUS_SYSTEM_PROMPT = `You are an academic librarian who extracts the structure of study material.
You return ONLY valid JSON. You never invent chapters that are not present in the text.`;

const OBJECTIVES_SYSTEM_PROMPT = `You are an expert curriculum designer for Nigerian university health sciences students.
You write granular, ASSESSABLE learning objectives — each one must be provable by a question.
Never write vague objectives like "understand the topic". Start each with an action verb
appropriate to its Bloom level (define, explain, calculate, derive, differentiate, evaluate).
You return ONLY valid JSON.`;

/** Charge one AI call against the shared daily budget, or throw AI_LIMIT_REACHED. */
async function consumeAIBudget(userId: string, institutionId: string): Promise<void> {
  const institution = await prisma.institution.findUnique({
    where:  { id: institutionId },
    select: { ai_daily_limit: true },
  });

  const dailyLimit   = institution?.ai_daily_limit ?? 20;
  const redisKey     = REDIS_KEYS.AI_DAILY(userId, getTodayWAT());
  const currentUsage = await getCount(redisKey);

  if (currentUsage >= dailyLimit) {
    throw new AppError(
      429,
      'AI_LIMIT_REACHED',
      `Daily AI limit of ${dailyLimit} reached. Resets at midnight WAT.`,
    );
  }

  await incrWithExpiry(redisKey, getEndOfDayTTL());
}

/** Strip markdown fences the models sometimes wrap JSON in. */
function parseJSONResponse<T>(text: string, what: string): T {
  try {
    const cleaned = text
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/g, '')
      .trim();
    return JSON.parse(cleaned) as T;
  } catch {
    throw new AppError(500, 'INTERNAL_ERROR', `AI returned malformed ${what}`);
  }
}

/**
 * Chapter/section structure from a document's text. ONE call per resource —
 * `learning.service` caches the result as SyllabusNode rows and never re-asks.
 */
export async function extractSyllabusStructure(params: {
  text:          string;
  title:         string;
  userId:        string;
  institutionId: string;
}): Promise<{ title: string; sections?: string[] }[]> {
  await consumeAIBudget(params.userId, params.institutionId);

  const response = await callAI({
    system:   SYLLABUS_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Extract the chapter structure of this study material titled "${params.title}".
Return ONLY JSON: { "chapters": [{ "title": "...", "sections": ["...", "..."] }] }
Use the document's own chapter titles. Omit "sections" when a chapter has none.
If the text has no discernible chapter structure, return { "chapters": [] }.

TEXT:
${params.text.substring(0, 15000)}`,
      },
    ],
    max_tokens: 4096,
  });

  const parsed = parseJSONResponse<{ chapters?: { title?: unknown; sections?: unknown }[] }>(
    response.text,
    'syllabus structure',
  );

  await prisma.aIUsageLog.create({
    data: {
      user_id:        params.userId,
      institution_id: params.institutionId,
      feature:        'study_plan',
      tokens_used:    response.input_tokens + response.output_tokens,
      model:          response.model,
    },
  });

  return (parsed.chapters ?? [])
    .filter((c): c is { title: string; sections?: unknown } => typeof c.title === 'string' && c.title.trim().length > 0)
    .map((c) => ({
      title: c.title.trim(),
      sections: Array.isArray(c.sections)
        ? c.sections.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
        : undefined,
    }));
}

/**
 * Assessable learning objectives for one chapter. ONE call per chapter, on first
 * open — `learning.service` caches the rows, so this is never charged twice.
 */
/**
 * Format retrieved passages as a grounding block for a prompt, or '' when there is
 * no grounding (un-ingested resource / manual outline) — in which case generation
 * cleanly degrades to the model's own knowledge (reformation Phase 1).
 */
function groundingBlock(chunks: { text: string; page?: number }[]): string {
  if (chunks.length === 0) return '';
  const passages = chunks
    .map((c, i) => `[Passage ${i + 1}${typeof c.page === 'number' ? `, p.${c.page}` : ''}]\n${c.text}`)
    .join('\n\n');
  return `\n\nUse ONLY these passages from the student's own material. Do not introduce facts that\naren't supported by them. If the passages don't cover something, leave it out.\n\n=== STUDENT MATERIAL ===\n${passages}\n=== END MATERIAL ===`;
}

export async function generateLearningObjectives(params: {
  chapterTitle:    string;
  resourceTitle:   string;
  subject:         string;
  /** Retrieved passages from the chapter; empty = ungrounded fallback. */
  groundingChunks?: string[];
  userId:          string;
  institutionId:   string;
}): Promise<{ statement: string; bloom_level: BloomLevelName }[]> {
  await consumeAIBudget(params.userId, params.institutionId);

  const grounding = groundingBlock((params.groundingChunks ?? []).map((text) => ({ text })));

  const response = await callAI({
    system:   OBJECTIVES_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Write 4-7 learning objectives for the chapter "${params.chapterTitle}" from "${params.resourceTitle}" (subject: ${params.subject}).
Each objective must be specific enough that a short exam question could prove it.
Spread them across Bloom levels, always including at least one at "apply" or above.${grounding}
${grounding ? 'Base every objective on the passages above — reflect what THIS chapter actually covers.' : ''}
Return ONLY JSON:
{ "objectives": [{ "statement": "...", "bloom_level": "remember|understand|apply|analyze|evaluate|create" }] }`,
      },
    ],
    max_tokens: 2048,
  });

  const parsed = parseJSONResponse<{ objectives?: { statement?: unknown; bloom_level?: unknown }[] }>(
    response.text,
    'learning objectives',
  );

  await prisma.aIUsageLog.create({
    data: {
      user_id:        params.userId,
      institution_id: params.institutionId,
      feature:        'study_plan',
      tokens_used:    response.input_tokens + response.output_tokens,
      model:          response.model,
    },
  });

  return (parsed.objectives ?? [])
    .filter((o): o is { statement: string; bloom_level?: unknown } =>
      typeof o.statement === 'string' && o.statement.trim().length > 0)
    .map((o) => ({
      statement:   o.statement.trim(),
      bloom_level: normalizeBloom(o.bloom_level),
    }));
}

type BloomLevelName = 'remember' | 'understand' | 'apply' | 'analyze' | 'evaluate' | 'create';

const BLOOM_LEVELS: readonly BloomLevelName[] = [
  'remember', 'understand', 'apply', 'analyze', 'evaluate', 'create',
];

function normalizeBloom(value: unknown): BloomLevelName {
  const found = BLOOM_LEVELS.find((level) => level === value);
  return found ?? 'understand';
}

/**
 * Coerce the model's `options` into `{ key, text, misconception? }[]`. A blank or
 * placeholder misconception (the "omit on the correct option" hint sometimes leaks
 * through) is dropped, so only real distractor diagnoses are stored.
 */
function normalizeOptions(value: unknown): { key: string; text: string; misconception?: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (typeof raw !== 'object' || raw === null) return [];
    const o = raw as Record<string, unknown>;
    if (typeof o.key !== 'string' || typeof o.text !== 'string') return [];
    const misconception =
      typeof o.misconception === 'string' && o.misconception.trim().length > 0
        ? o.misconception.trim()
        : undefined;
    return [{ key: o.key, text: o.text, ...(misconception ? { misconception } : {}) }];
  });
}

/**
 * A generated item, normalized into the shape `AIQuestion` stores. Kept separate
 * from the insert so validation (reformation Phase 2) can reject rows BEFORE they
 * are cached — a bad item in a cached pool poisons the objective for its lifetime.
 */
interface MasteryItemRow {
  user_id:        string;
  institution_id: string;
  topic:          string;
  question_type:  'mcq' | 'short_answer' | 'numeric';
  question_text:  string;
  options:        { key: string; text: string; misconception?: string }[];
  correct_answer: string;
  explanation?:   string;
  rubric?:        string;
  difficulty:     'easy' | 'medium' | 'hard';
  quality_flag:   'good';
  objective_id:   string;
  bloom_level:    string;
  source_page?:   number;
  seen_count:     number;
  correct_count:  number;
}

/** Only `mcq` and the two free-response kinds are generated for mastery pools. */
function normalizeItemType(value: unknown): 'mcq' | 'short_answer' | 'numeric' {
  if (value === 'short_answer' || value === 'numeric') return value;
  return 'mcq';
}

/**
 * A model field as a trimmed string, or '' when it isn't one. Anything non-string
 * is treated as absent rather than stringified — an object here would otherwise
 * become the literal "[object Object]" and sail through as a question stem.
 */
function textField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function toMasteryRow(
  raw: Record<string, unknown>,
  params: { userId: string; institutionId: string; subject: string; objectiveId: string },
): MasteryItemRow {
  const type = normalizeItemType(raw.question_type);
  return {
    user_id:        params.userId,
    institution_id: params.institutionId,
    topic:          params.subject,
    question_type:  type,
    question_text:  textField(raw.question_text),
    // Free-response items carry no options; a model that emits them anyway would
    // otherwise leak the answer set into a question meant to be produced, not picked.
    options:        type === 'mcq' ? normalizeOptions(raw.options) : [],
    correct_answer: textField(raw.correct_answer),
    explanation:    typeof raw.explanation === 'string' ? raw.explanation : undefined,
    rubric:         type !== 'mcq' && typeof raw.rubric === 'string' ? raw.rubric.trim() : undefined,
    difficulty:     raw.difficulty === 'easy' || raw.difficulty === 'hard' ? raw.difficulty : 'medium',
    quality_flag:   'good',
    objective_id:   params.objectiveId,
    bloom_level:    normalizeBloom(raw.bloom_level),
    source_page:    typeof raw.source_page === 'number' ? raw.source_page : undefined,
    seen_count:     0,
    correct_count:  0,
  };
}

/**
 * One generation call for `count` items. Split out from `generateMasteryQuestions`
 * so the repair pass (Phase 2) can re-ask for a shortfall with the same prompt
 * instead of duplicating it.
 */
async function requestMasteryItems(params: {
  objective:     string;
  subject:       string;
  count:         number;
  /** How many of `count` should be free-response rather than MCQ. */
  freeResponse:  number;
  grounding:     { text: string; page?: number }[];
  userId:        string;
  institutionId: string;
  objectiveId:   string;
  /** Appended when re-asking, so the repair pass doesn't repeat the same defect. */
  repairNote?:   string;
}): Promise<MasteryItemRow[]> {
  await consumeAIBudget(params.userId, params.institutionId);

  const grounding = groundingBlock(params.grounding);
  const mcqCount = Math.max(0, params.count - params.freeResponse);

  const response = await callAI({
    system:   QUESTION_GENERATION_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Write ${params.count} questions that test this single learning objective:
"${params.objective}" (subject: ${params.subject})

FORMAT MIX: exactly ${mcqCount} multiple-choice ("question_type":"mcq")${
  params.freeResponse > 0
    ? ` and ${params.freeResponse} free-response items at "apply" or "analyze" level —
use "question_type":"short_answer" for items answered in a phrase or sentence, and
"numeric" for items answered with a calculated value (state the units in the stem).
A free-response item has NO options; "correct_answer" is the model answer and
"rubric" states what a correct answer must contain, so it can be graded fairly.`
    : '.'
}

Spread them across Bloom levels — roughly a quarter each at "remember", "understand",
"apply" and "analyze". The "apply" and "analyze" questions must be exam-style problems,
not recall rephrased. Do not repeat the same fact across questions.

For MCQs: exactly one option is correct and "correct_answer" is that option's KEY (e.g. "B").
Every DISTRACTOR (wrong option) must carry a "misconception" naming the specific error a
student who picks it holds — e.g. "confuses preload with afterload". The correct option
has no misconception. Distractors must be plausible, must differ from each other, and must
NEVER be "all of the above", "none of the above" or any variant.${grounding}
${params.grounding.length ? 'Ground every question in the passages above, and set "source_page" to the passage page it came from.' : ''}${
  params.repairNote ? `\n${params.repairNote}` : ''
}
Return ONLY JSON:
{ "questions": [{ "question_text": "...", "question_type": "mcq|short_answer|numeric",
  "options": [{"key":"A","text":"...","misconception":"... (omit on the correct option)"}],
  "correct_answer": "A", "rubric": "... (free-response only)", "explanation": "...",
  "bloom_level": "remember|understand|apply|analyze",
  "difficulty": "easy|medium|hard", "source_page": 12 }] }`,
      },
    ],
    max_tokens: 8192,
  });

  const parsed = parseJSONResponse<{ questions?: Record<string, unknown>[] }>(
    response.text,
    'mastery questions',
  );

  await prisma.aIUsageLog.create({
    data: {
      user_id:        params.userId,
      institution_id: params.institutionId,
      feature:        'question_generation',
      tokens_used:    response.input_tokens + response.output_tokens,
      model:          response.model,
    },
  });

  return (parsed.questions ?? []).map((raw) =>
    toMasteryRow(raw, {
      userId:        params.userId,
      institutionId: params.institutionId,
      subject:       params.subject,
      objectiveId:   params.objectiveId,
    }),
  );
}

/**
 * The cached assessment pool for one objective, generated across the Bloom mix and
 * a format mix in ONE call. Every later attempt draws from these rows, so a student
 * can retry without spending more budget.
 *
 * **Reformation Phase 2** adds two things:
 *
 * - **Validation before caching.** Every item runs the structural rules in
 *   `utils/item-validation` and a failure is DROPPED, not stored. If that leaves
 *   fewer than `minKeep`, exactly ONE repair generation is attempted for the
 *   shortfall — never a loop, because an unbounded repair against a model that
 *   keeps producing the same defect burns the student's whole daily budget.
 * - **Format mix.** A minority of items are free-response, which breaks the
 *   recognition ceiling: picking the right option among four is not producing the
 *   answer. MCQ stays the majority so distractor→misconception diagnosis (Phase 1)
 *   still dominates, and so the AI grader's per-answer cost stays bounded.
 */
export async function generateMasteryQuestions(params: {
  objective:     string;
  subject:       string;
  poolSize:      number;
  /** Items to keep before a repair pass is considered. Defaults to half the pool. */
  minKeep?:      number;
  /** How many free-response items to ask for. Defaults to a quarter of the pool. */
  freeResponse?: number;
  /** Retrieved passages (with source page) to ground the questions; may be empty. */
  grounding?:    { text: string; page?: number }[];
  userId:        string;
  institutionId: string;
  objectiveId:   string;
}): Promise<{ id: string; bloom_level: string; difficulty: string; question_type: string }[]> {
  const grounding = params.grounding ?? [];
  const freeResponse = params.freeResponse ?? Math.floor(params.poolSize / 4);
  const minKeep = params.minKeep ?? Math.ceil(params.poolSize / 2);

  const request = {
    objective:     params.objective,
    subject:       params.subject,
    grounding,
    userId:        params.userId,
    institutionId: params.institutionId,
    objectiveId:   params.objectiveId,
  };

  const first = await requestMasteryItems({ ...request, count: params.poolSize, freeResponse });
  const { kept, rejected } = partitionValidItems<MasteryItemRow & RawItem>(first);

  if (rejected.length > 0) {
    logger.warn(
      {
        objectiveId: params.objectiveId,
        dropped:     rejected.length,
        reasons:     [...new Set(rejected.map((r) => r.reason))],
      },
      'Generated items failed validation and were discarded',
    );
  }

  const rows: MasteryItemRow[] = [...kept];

  // ONE repair pass, and only when the surviving pool is too thin to assess with.
  // A pool that lost two items of sixteen is fine; one that lost twelve is not.
  if (rows.length < minKeep) {
    const shortfall = params.poolSize - rows.length;
    const reasons = [...new Set(rejected.map((r) => r.reason))].join(', ');

    try {
      const repair = await requestMasteryItems({
        ...request,
        count:        shortfall,
        freeResponse: Math.min(freeResponse, Math.floor(shortfall / 4)),
        repairNote:   `A previous attempt was rejected for: ${reasons}. Avoid those defects exactly.`,
      });
      const repaired = partitionValidItems<MasteryItemRow & RawItem>(repair);
      rows.push(...repaired.kept);
      logger.info(
        { objectiveId: params.objectiveId, recovered: repaired.kept.length },
        'Repair generation completed',
      );
    } catch (err) {
      // A failed repair (budget exhausted, provider down) must not lose the items
      // that DID validate — the student can still be assessed on a thinner pool.
      logger.warn({ err, objectiveId: params.objectiveId }, 'Repair generation failed; keeping valid items');
    }
  }

  if (rows.length === 0) {
    throw new AppError(500, 'INTERNAL_ERROR', 'AI returned no usable questions for this objective');
  }

  const saved = await AIQuestion.insertMany(rows);

  logger.info(
    { objectiveId: params.objectiveId, count: saved.length, dropped: rejected.length },
    'Mastery question pool generated',
  );

  return saved.map((q) => ({
    id:            q._id.toString(),
    bloom_level:   q.bloom_level ?? 'understand',
    difficulty:    q.difficulty,
    question_type: q.question_type,
  }));
}

// ─── Free-response grading (reformation Phase 2) ───────────────────────────────

const GRADING_SYSTEM_PROMPT = `You are a fair, experienced examiner marking Nigerian university health science students' written answers.
You mark for UNDERSTANDING, not wording: a correct answer expressed differently from the model answer is CORRECT.
Accept synonyms, paraphrase, different word order, minor spelling errors, and abbreviations a marker would accept.
For numeric answers: accept any equivalent form (0.5 = 1/2 = 50%), accept correct answers with or without units, and accept
rounding within 1% of the model value. Mark wrong only if the VALUE or the reasoning is wrong.
Do NOT award credit for an answer that names the right topic without answering the question.
CRITICAL: respond with VALID JSON ONLY — no markdown fences, no preamble.
JSON format strictly: { "grades": [{ "index": number, "is_correct": boolean, "score": number, "feedback": string }] }
"score" is 0..1 partial credit; "feedback" is one short sentence addressed to the student.`;

export interface AnswerToGrade {
  question_text:  string;
  /** The model answer the response is judged against. */
  correct_answer: string;
  /** What a correct answer must contain, when the generator supplied one. */
  rubric?:        string;
  /** Numeric items are graded with unit/rounding tolerance. */
  question_type?: string;
  student_answer: string;
}

export interface AnswerGrade {
  is_correct: boolean;
  /** 0..1 partial credit. Currently informational — mastery counts whole items. */
  score:      number;
  feedback:   string;
}

/**
 * Exact-match grading — the rule used everywhere before Phase 2, and still the
 * right one for MCQ letters. Exported so the grader's fallback and the client's
 * offline verdict provably use the same rule.
 */
export function exactMatchGrade(studentAnswer: string, correctAnswer: string): boolean {
  return studentAnswer.trim().toUpperCase() === correctAnswer.trim().toUpperCase();
}

/**
 * Grade free-response answers with the AI (reformation Phase 2, critique #1).
 *
 * Grading used to be `trim().toUpperCase()` equality EVERYWHERE. That is correct
 * for an MCQ letter and simply wrong for anything a student writes: "increases
 * cardiac output" and "raises CO" are the same answer and only one of them matched.
 *
 * **Graded as a BATCH in one call, deliberately.** A per-answer call would put an
 * 8-item check with 2 free-response items at 2 credits against a 20/day budget
 * shared with generation, planning and tutor feedback; one call for the whole batch
 * keeps a silent exam or mastery check at one.
 *
 * **Never throws and never blocks a submit.** If the budget is exhausted, the
 * provider is down, or the response doesn't parse, every item falls back to exact
 * match. A student who has finished their paper must always be able to submit it —
 * degrading the grading is acceptable, losing the answers is not.
 */
export async function gradeAnswers(params: {
  items:         AnswerToGrade[];
  userId:        string;
  institutionId: string;
}): Promise<AnswerGrade[]> {
  const fallback = (): AnswerGrade[] =>
    params.items.map((item) => {
      const is_correct = exactMatchGrade(item.student_answer, item.correct_answer);
      return {
        is_correct,
        score:    is_correct ? 1 : 0,
        feedback: '',
      };
    });

  if (params.items.length === 0) return [];

  try {
    await consumeAIBudget(params.userId, params.institutionId);
  } catch {
    logger.info({ userId: params.userId }, 'AI grading skipped — daily budget reached; exact match used');
    return fallback();
  }

  try {
    const block = params.items
      .map((item, index) => {
        const parts = [
          `[${index}] TYPE: ${item.question_type === 'numeric' ? 'numeric' : 'short answer'}`,
          `QUESTION: ${item.question_text}`,
          `MODEL ANSWER: ${item.correct_answer}`,
        ];
        if (item.rubric) parts.push(`RUBRIC: ${item.rubric}`);
        parts.push(`STUDENT ANSWER: ${item.student_answer || '(left blank)'}`);
        return parts.join('\n');
      })
      .join('\n\n');

    const response = await callAI({
      system:   GRADING_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Mark each answer below. Return one grade per item, using the same "index".

${block}

Return ONLY JSON: { "grades": [{ "index": 0, "is_correct": true, "score": 1, "feedback": "..." }] }`,
        },
      ],
      max_tokens: 2048,
    });

    const parsed = parseJSONResponse<{
      grades?: { index?: unknown; is_correct?: unknown; score?: unknown; feedback?: unknown }[];
    }>(response.text, 'answer grades');

    await prisma.aIUsageLog.create({
      data: {
        user_id:        params.userId,
        institution_id: params.institutionId,
        feature:        'quiz_feedback',
        tokens_used:    response.input_tokens + response.output_tokens,
        model:          response.model,
      },
    });

    const byIndex = new Map<number, AnswerGrade>();
    for (const grade of parsed.grades ?? []) {
      if (typeof grade.index !== 'number' || typeof grade.is_correct !== 'boolean') continue;
      byIndex.set(grade.index, {
        is_correct: grade.is_correct,
        score:      typeof grade.score === 'number' ? Math.min(1, Math.max(0, grade.score)) : (grade.is_correct ? 1 : 0),
        feedback:   typeof grade.feedback === 'string' ? grade.feedback.trim() : '',
      });
    }

    // An item the model skipped falls back rather than being silently marked wrong.
    return params.items.map((item, index) => {
      const graded = byIndex.get(index);
      if (graded) return graded;
      const is_correct = exactMatchGrade(item.student_answer, item.correct_answer);
      return { is_correct, score: is_correct ? 1 : 0, feedback: '' };
    });
  } catch (err) {
    logger.error({ err, userId: params.userId }, 'AI grading failed; falling back to exact match');
    return fallback();
  }
}

/** Single-item convenience wrapper over `gradeAnswers`. One AI call. */
export async function gradeAnswer(params: {
  item:          AnswerToGrade;
  userId:        string;
  institutionId: string;
}): Promise<AnswerGrade> {
  const [grade] = await gradeAnswers({
    items:         [params.item],
    userId:        params.userId,
    institutionId: params.institutionId,
  });
  return grade;
}

// ─── Service export ────────────────────────────────────────────────────────────

export const aiService = {
  generateQuestions,
  streamAnswerFeedback,
  generateStudyPlan,
  updateStudyPlanTask,
  parseQuestionsFromText,
  getStudyPlan,
  getAIFeedbackHistory,
  flagAIQuestion,
  extractSyllabusStructure,
  generateLearningObjectives,
  generateMasteryQuestions,
  gradeAnswer,
  gradeAnswers,
};