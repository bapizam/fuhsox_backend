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
import logger from '@lib/logger';

/**
 * Turn validated tasks into stored ones by filling in what the MODEL was never
 * allowed to supply: chapter titles and page ranges come from the database, so a
 * hallucinated page number cannot reach the student.
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
        return [
          {
            node_id:       task.node_id,
            chapter_title: node.title,
            ...(node.page_start !== null ? { page_start: node.page_start } : {}),
            ...(node.page_end !== null ? { page_end: node.page_end } : {}),
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

  return saved;
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
