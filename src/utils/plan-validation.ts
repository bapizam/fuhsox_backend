/**
 * Validate a generated resource-anchored study plan.
 *
 * The existing multi-subject planner parses its AI output with `JSON.parse` and
 * trusts it — which is why `recommended_question_set` is a string pointing at
 * nothing, and why tasks are free-text topics that no longer resolve to anything
 * real. This module is the boundary that stops the same thing happening again.
 *
 * Two rules carry the weight:
 *
 * 1. **A task must name a chapter that exists.** `node_id` is checked against an
 *    allow-list built from the resource's own `SyllabusNode` rows, so the model
 *    cannot invent a chapter or point at another student's.
 * 2. **Only `node_id` is taken from the model.** Chapter titles and page ranges
 *    are filled in by the caller from the database. A model that hallucinates
 *    "pp. 340–356" of a 200-page book therefore cannot mislead anyone — it can
 *    only pick a chapter, never describe one.
 *
 * Pure — no I/O, no AI — so it is unit-tested directly.
 */
import { z } from 'zod';

/** Longer than a study session anyone actually does in one sitting. */
const MAX_TASK_MINS = 600;

const taskSchema = z.object({
  node_id:       z.string().trim().min(1),
  activity:      z.enum(['read', 'practice', 'verify']),
  duration_mins: z.number().finite().positive().max(MAX_TASK_MINS),
  detail:        z.string().trim().max(300).optional(),
});

const daySchema = z.object({
  day:   z.string().trim().max(40).optional(),
  date:  z.string().trim().max(40).optional(),
  tasks: z.array(z.unknown()).optional(),
});

const weekSchema = z.object({
  week_number: z.number().finite().optional(),
  days:        z.array(z.unknown()).optional(),
});

const planSchema = z.object({
  weeks:      z.array(z.unknown()).optional(),
  milestones: z.array(z.unknown()).optional(),
});

export interface ValidatedTask {
  node_id:       string;
  activity:      'read' | 'practice' | 'verify';
  duration_mins: number;
  detail?:       string;
}

export interface ValidatedDay {
  day:   string;
  date:  string;
  tasks: ValidatedTask[];
}

export interface ValidatedWeek {
  week_number: number;
  days:        ValidatedDay[];
}

export interface ValidatedPlan {
  weeks:      ValidatedWeek[];
  milestones: string[];
  /** Tasks that survived — the number that decides whether a repair is needed. */
  taskCount:  number;
  /** Tasks thrown away, and why, for the repair prompt and the logs. */
  dropped:    number;
  reasons:    string[];
}

/**
 * Coerce a raw AI plan into one that is safe to store.
 *
 * Nothing here throws: a malformed task is dropped, a day left with no tasks is
 * dropped, and a week left with no days is dropped. The caller decides what to do
 * about an empty result, because "the model produced nothing usable" is a
 * different problem from "the model produced a slightly thin plan".
 */
export function validateResourcePlan(
  raw: unknown,
  allowedNodeIds: Iterable<string>,
): ValidatedPlan {
  const allowed = new Set(allowedNodeIds);
  const reasons = new Set<string>();
  let dropped = 0;
  let taskCount = 0;

  const parsedPlan = planSchema.safeParse(raw);
  if (!parsedPlan.success) {
    return { weeks: [], milestones: [], taskCount: 0, dropped: 0, reasons: ['plan was not an object'] };
  }

  const weeks: ValidatedWeek[] = [];

  for (const rawWeek of parsedPlan.data.weeks ?? []) {
    const week = weekSchema.safeParse(rawWeek);
    if (!week.success) {
      dropped += 1;
      reasons.add('malformed week');
      continue;
    }

    const days: ValidatedDay[] = [];

    for (const rawDay of week.data.days ?? []) {
      const day = daySchema.safeParse(rawDay);
      if (!day.success) {
        dropped += 1;
        reasons.add('malformed day');
        continue;
      }

      const tasks: ValidatedTask[] = [];

      for (const rawTask of day.data.tasks ?? []) {
        const task = taskSchema.safeParse(rawTask);
        if (!task.success) {
          dropped += 1;
          reasons.add('task missing node_id, activity or a sane duration');
          continue;
        }
        if (!allowed.has(task.data.node_id)) {
          dropped += 1;
          reasons.add('task referenced a chapter that does not exist in this resource');
          continue;
        }

        tasks.push({
          node_id:       task.data.node_id,
          activity:      task.data.activity,
          duration_mins: Math.round(task.data.duration_mins),
          ...(task.data.detail ? { detail: task.data.detail } : {}),
        });
        taskCount += 1;
      }

      // A day with nothing left to do is not a day.
      if (tasks.length === 0) continue;

      days.push({
        day:   day.data.day ?? '',
        date:  day.data.date ?? '',
        tasks,
      });
    }

    if (days.length === 0) continue;

    // Renumber rather than trusting the model's own week numbers: dropping an
    // empty week would otherwise leave a gap ("Week 1, Week 3") in the UI.
    weeks.push({ week_number: weeks.length + 1, days });
  }

  const milestones = (parsedPlan.data.milestones ?? [])
    .filter((m): m is string => typeof m === 'string')
    .map((m) => m.trim())
    .filter((m) => m.length > 0)
    .slice(0, 20);

  return { weeks, milestones, taskCount, dropped, reasons: [...reasons] };
}
