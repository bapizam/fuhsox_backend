import type { Socket } from 'socket.io';
import { callAI, streamFeedback } from '@lib/ai-provider';
import prisma from '@config/database';
import { AIQuestion, AIFeedback, StudyPlan } from '../../mongo/schemas';
import { REDIS_KEYS } from '@config/constants';
import { incrWithExpiry, getCount, getEndOfDayTTL, getTodayWAT } from '@lib/redis';
import { AppError, type GeneratedQuestion, type AIGenerationResult } from '@typings/models';
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
};