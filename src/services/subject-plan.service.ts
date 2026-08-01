/**
 * Study plans anchored to ONE uploaded resource.
 *
 * The existing planner produces a single document per user covering up to ten
 * free-text subjects, grounded in chapter titles and nothing else. This one is
 * scoped to a resource, which turns every downstream question into a lookup
 * instead of a guess: its chapters are `SyllabusNode` rows, its content is
 * `ResourceChunk`, its objectives carry its `resource_id`, and a task's chapter
 * is a real id rather than a paraphrase the model invented.
 *
 * The two live side by side deliberately — `POST /ai/generate-plan` is untouched,
 * so nothing a student already has stops working.
 */
import prisma from '@config/database';
import { SubjectStudyPlan, SubjectStudyPlanVersion } from '../../mongo/schemas';
import type { ISubjectPlanWeek, ISubjectStudyPlan } from '../../mongo/schemas';
import * as aiService from '@services/ai.service';
import { AppError } from '@typings/models';
import type { ValidatedPlan } from '@utils/plan-validation';
import { pageWindow } from '@utils/page-windows';
import logger from '@lib/logger';

/**
 * Turn validated tasks into stored ones by filling in what the MODEL was never
 * allowed to supply: chapter titles and page ranges come from the database, so a
 * hallucinated page number cannot reach the student.
 *
 * The model may say a chapter takes three sittings; `pageWindow` decides which
 * pages each of those sittings covers, from the range the database holds.
 */
function materialiseWeeks(
  plan: ValidatedPlan,
  nodes: { id: string; title: string; page_start: number | null; page_end: number | null }[],
): ISubjectPlanWeek[] {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  return plan.weeks.map((week) => ({
    week_number: week.week_number,
    days: week.days.map((day) => ({
      day:  day.day,
      date: day.date,
      tasks: day.tasks.flatMap((task) => {
        const node = nodeById.get(task.node_id);
        if (!node) return [];
        const window = pageWindow(node.page_start, node.page_end, task.part, task.parts);
        return [
          {
            node_id:       task.node_id,
            chapter_title: node.title,
            ...window,
            part:          task.part,
            parts:         task.parts,
            activity:      task.activity,
            duration_mins: task.duration_mins,
            ...(task.detail ? { detail: task.detail } : {}),
            completed:     false,
          },
        ];
      }),
    })),
  }));
}

function countTasks(weeks: ISubjectPlanWeek[]): number {
  return weeks.reduce(
    (total, week) => total + week.days.reduce((sum, day) => sum + day.tasks.length, 0),
    0,
  );
}

export async function generateSubjectPlan(params: {
  userId:        string;
  institutionId: string;
  resourceId:    string;
  examDate:      Date | null;
  dailyHours:    number;
  /** Weekdays the student agreed to study, `0` = Sunday. Never empty. */
  studyDays:     number[];
}): Promise<ISubjectStudyPlan> {
  const resource = await prisma.learningResource.findFirst({
    where: { id: params.resourceId, user_id: params.userId },
  });
  if (!resource) throw new AppError(404, 'NOT_FOUND', 'Resource not found');

  const subject = resource.course_code ?? resource.title;

  const plan = await aiService.generateResourcePlan({
    resourceId:    params.resourceId,
    subject,
    resourceTitle: resource.title,
    examDate:      params.examDate,
    dailyHours:    params.dailyHours,
    studyDays:     params.studyDays,
    userId:        params.userId,
    institutionId: params.institutionId,
  });

  const nodes = await prisma.syllabusNode.findMany({
    where:  { resource_id: params.resourceId, depth: 0 },
    select: { id: true, title: true, page_start: true, page_end: true },
  });

  const weeks = materialiseWeeks(plan, nodes);

  const fields = {
    user_id:        params.userId,
    institution_id: params.institutionId,
    resource_id:    params.resourceId,
    subject,
    exam_date:      params.examDate,
    daily_hours:    params.dailyHours,
    study_days:     params.studyDays,
    weeks,
    milestones:     plan.milestones,
  };

  const saved = await SubjectStudyPlan.findOneAndUpdate(
    { user_id: params.userId, resource_id: params.resourceId },
    fields,
    { upsert: true, new: true },
  );

  // Append-only history. Best-effort exactly like the multi-subject planner's
  // snapshot: the student has already paid an AI credit, so a history write must
  // never be what fails the request.
  try {
    await SubjectStudyPlanVersion.create({
      ...fields,
      total_weeks: weeks.length,
      total_tasks: countTasks(weeks),
    });
  } catch (err) {
    logger.warn({ err, userId: params.userId }, 'Failed to snapshot subject plan version');
  }

  logger.info(
    {
      resourceId: params.resourceId,
      weeks:      weeks.length,
      tasks:      countTasks(weeks),
      dropped:    plan.dropped,
    },
    'Subject study plan generated',
  );

  // Pre-build objectives for the scheduled chapters IN THE BACKGROUND, so the
  // student never meets "build objectives" as a chore and the first Verify tap
  // is instant. Not awaited: each chapter is its own AI call, and making the
  // plan request carry six of them would take minutes and risk the gateway
  // timeout. Bounded and best-effort — whatever isn't built here is built on
  // demand by node-check, exactly as before.
  void prebuildScheduledObjectives({
    userId:        params.userId,
    institutionId: params.institutionId,
    weeks,
  });

  return saved;
}

export interface ScheduledCheck {
  nodeId:    string;
  pageStart: number | null;
  pageEnd:   number | null;
}

/**
 * The checkpoints in the order the student will actually reach them, which is
 * what makes an early budget cut-off safe — whatever the cap cuts off is the
 * furthest away.
 *
 * Keyed by chapter AND page window: a chapter split over three sittings has
 * three different checks with three different objective sets, so pre-building
 * "the chapter" would build objectives the first sitting's check never uses.
 */
function scheduledChecks(weeks: ISubjectPlanWeek[]): ScheduledCheck[] {
  const seen = new Set<string>();
  const ordered: ScheduledCheck[] = [];
  for (const week of weeks) {
    for (const day of week.days) {
      for (const task of day.tasks) {
        if (task.activity !== 'verify') continue;
        const pageStart = task.page_start ?? null;
        const pageEnd = task.page_end ?? null;
        const key = `${task.node_id}:${pageStart}:${pageEnd}`;
        if (seen.has(key)) continue;
        seen.add(key);
        ordered.push({ nodeId: task.node_id, pageStart, pageEnd });
      }
    }
  }
  return ordered;
}

/**
 * At most this many checkpoints are pre-built per plan generation. Each is one AI
 * call against the shared 20/day budget, and the plan itself just spent one — an
 * uncapped pre-build would torch the student's whole day, and splitting chapters
 * into sittings multiplied how many there are. Everything past the cap builds on
 * first verify instead, which is now gated behind marking the reading done — so
 * the spend happens when the student is actually ready for it.
 */
const PREBUILD_MAX_CHECKS = 4;

async function prebuildScheduledObjectives(params: {
  userId:        string;
  institutionId: string;
  weeks:         ISubjectPlanWeek[];
}): Promise<void> {
  const { generateObjectivesForNode } = await import('@services/learning.service');

  for (const check of scheduledChecks(params.weeks).slice(0, PREBUILD_MAX_CHECKS)) {
    try {
      // Returns the cached rows untouched when this chapter+window already has
      // objectives, so re-planning a studied book costs nothing here.
      await generateObjectivesForNode({
        nodeId:        check.nodeId,
        userId:        params.userId,
        institutionId: params.institutionId,
        ...(check.pageStart !== null
          ? { pageStart: check.pageStart, pageEnd: check.pageEnd }
          : {}),
      });
    } catch (err) {
      // Budget spent or provider down — stop entirely rather than hammering a
      // wall three more times. Everything left builds on demand.
      logger.info({ err, nodeId: check.nodeId }, 'Objective pre-build stopped; the rest build on demand');
      return;
    }
  }
}

/** The live plan for one resource, or null when none has been generated. */
export async function getSubjectPlan(params: {
  userId:     string;
  resourceId: string;
}): Promise<ISubjectStudyPlan | null> {
  return SubjectStudyPlan.findOne({
    user_id:     params.userId,
    resource_id: params.resourceId,
  }).lean<ISubjectStudyPlan | null>();
}

/** Every live per-resource plan the student holds, newest first. */
export async function listSubjectPlans(userId: string): Promise<ISubjectStudyPlan[]> {
  return SubjectStudyPlan.find({ user_id: userId })
    .sort({ updatedAt: -1 })
    .lean<ISubjectStudyPlan[]>();
}

/**
 * Check a task off.
 *
 * Addressed positionally (week → date → index) exactly like the multi-subject
 * planner: regeneration replaces the whole document, so there is nothing stable
 * to address by id, and inventing one would imply a permanence tasks do not have.
 */
export async function setSubjectTaskCompleted(params: {
  userId:      string;
  resourceId:  string;
  weekNumber:  number;
  date:        string;
  taskIndex:   number;
  completed:   boolean;
}): Promise<ISubjectStudyPlan> {
  const plan = await SubjectStudyPlan.findOne({
    user_id:     params.userId,
    resource_id: params.resourceId,
  });
  if (!plan) throw new AppError(404, 'NOT_FOUND', 'No plan for this resource');

  const week = plan.weeks.find((w) => w.week_number === params.weekNumber);
  const day = week?.days.find((d) => d.date === params.date);
  const task = day?.tasks[params.taskIndex];

  if (!task) {
    throw new AppError(404, 'NOT_FOUND', 'That task is not in the current plan');
  }

  task.completed = params.completed;
  plan.markModified('weeks');
  await plan.save();

  return plan;
}

/**
 * Say whether the reading was done.
 *
 * **Deliberately a different field from `completed`.** That one is evidence — it
 * becomes true only by passing the chapter's mastery check, which is what
 * replaced the plan's old "I've studied" checkbox, and giving it back a
 * self-reported route would undo the whole point. This one claims something much
 * smaller and entirely checkable by the student: I have read these pages. It is
 * what unlocks the paired verify, so nobody is asked to prove a chapter they
 * have not opened.
 */
export async function setSubjectTaskRead(params: {
  userId:      string;
  resourceId:  string;
  weekNumber:  number;
  date:        string;
  taskIndex:   number;
  read:        boolean;
}): Promise<ISubjectStudyPlan> {
  const plan = await SubjectStudyPlan.findOne({
    user_id:     params.userId,
    resource_id: params.resourceId,
  });
  if (!plan) throw new AppError(404, 'NOT_FOUND', 'No plan for this resource');

  const week = plan.weeks.find((w) => w.week_number === params.weekNumber);
  const day = week?.days.find((d) => d.date === params.date);
  const task = day?.tasks[params.taskIndex];

  if (!task) {
    throw new AppError(404, 'NOT_FOUND', 'That task is not in the current plan');
  }
  if (task.activity === 'verify') {
    throw new AppError(422, 'VALIDATION_ERROR', 'A checkpoint is passed, not marked as read');
  }

  task.read_at = params.read ? new Date() : undefined;
  plan.markModified('weeks');
  await plan.save();

  return plan;
}
