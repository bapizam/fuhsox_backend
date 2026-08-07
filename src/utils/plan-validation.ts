/**
 * Validate a generated resource-anchored study plan.
 *
 * The existing multi-subject planner parses its AI output with `JSON.parse` and
 * trusts it — which is why `recommended_question_set` is a string pointing at
 * nothing, and why tasks are free-text topics that no longer resolve to anything
 * real. This module is the boundary that stops the same thing happening again.
 *
 * Three rules carry the weight:
 *
 * 1. **A task must name a chapter that exists.** `node_id` is checked against an
 *    allow-list built from the resource's own `SyllabusNode` rows, so the model
 *    cannot invent a chapter or point at another student's.
 * 2. **Only `node_id` is taken from the model.** Chapter titles and page ranges
 *    are filled in by the caller from the database. A model that hallucinates
 *    "pp. 340–356" of a 200-page book therefore cannot mislead anyone — it can
 *    only pick a chapter, never describe one.
 * 3. **New material is read in the book's own order.** See {@link orderReading}.
 *
 * Pure — no I/O, no AI — so it is unit-tested directly.
 */
import { z } from 'zod';
import { MAX_PARTS } from '@utils/page-windows';
import { chapterRank, type PrereqEdge } from '@utils/chapter-order';

/** Longer than a study session anyone actually does in one sitting. */
const MAX_TASK_MINS = 600;

/** How long a synthesised checkpoint is scheduled for. */
const VERIFY_MINS = 15;

const taskSchema = z.object({
  node_id:       z.string().trim().min(1),
  activity:      z.enum(['read', 'practice', 'verify']),
  duration_mins: z.number().finite().positive().max(MAX_TASK_MINS),
  detail:        z.string().trim().max(300).optional(),
  /**
   * Which sitting of the chapter this is, and how many there are. The model
   * decides how to break a long chapter up; `utils/page-windows` turns that into
   * real pages. Absent means the whole chapter in one go.
   */
  part:          z.number().int().positive().max(MAX_PARTS).optional(),
  parts:         z.number().int().positive().max(MAX_PARTS).optional(),
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
  /** 1-based sitting within the chapter, and how many sittings there are. */
  part:          number;
  parts:         number;
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
/**
 * `YYYY-MM-DD` as a day number, or null when it is not a usable date.
 *
 * Compared as calendar days rather than timestamps so "today" is never dropped
 * for being a few hours old.
 */
function dayNumber(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!match) return null;
  const [, y, m, d] = match;
  const time = Date.UTC(Number(y), Number(m) - 1, Number(d));
  return Number.isFinite(time) ? Math.floor(time / 86400000) : null;
}

export interface PlanConstraints {
  /**
   * Days before this are dropped. The model is told week 1 starts today, but
   * told is not the same as done: given a mid-week start it lays the week out
   * Monday-to-Sunday and schedules days that have already passed, which is how a
   * plan generated on a Friday came back telling the student to study Thursday.
   * Omit to keep every day regardless of date.
   */
  startDate?: Date;
  /**
   * Weekdays the student agreed to study, `0` = Sunday. A day on any other
   * weekday is dropped.
   *
   * **Enforced here rather than trusted to the prompt** for the same reason the
   * start date is: the model was already told, in capitals, not to schedule days
   * that had passed, and did it anyway. A scheduling rule that only lives in the
   * prompt is a suggestion. Omit to accept every weekday.
   */
  studyDays?: Iterable<number>;
  /**
   * What this book says has to be read before what, from
   * `ai.service → getChapterPrerequisites`.
   *
   * The edges are turned into a rank here rather than taken as one, so a caller
   * cannot hand over an ordering inconsistent with the graph it came from. Omit
   * — or pass none, which is what a book whose derivation failed or was never
   * paid for gets — and {@link orderReading} falls back to the book's own order,
   * exactly as it behaved before the graph existed.
   */
  prerequisites?: readonly PrereqEdge[];
}

/** A task's identity for pairing: the same chapter AND the same sitting. */
function taskKey(task: ValidatedTask): string {
  return `${task.node_id}:${task.part}/${task.parts}`;
}

/**
 * Guarantee every reading task ends in a checkpoint on the same day.
 *
 * **Structural, not prompted.** Asking the model to pair them produces days where
 * it forgot, and a reading day with nothing to prove is exactly the day a student
 * finishes and has no idea whether any of it went in. Any read left unpaired gets
 * a verify appended for the same chapter and the same sitting, so its questions
 * come from the pages that were actually read.
 *
 * `practice` is left alone: it is optional extra work, not a claim to have
 * covered anything.
 *
 * `supplied` carries checkpoints the model wrote that {@link orderReading} had to
 * lift out of the schedule, keyed by sitting — the model's own duration and
 * wording survive being re-placed on the right day.
 */
function withPairedVerifies(
  tasks: ValidatedTask[],
  supplied: Map<string, ValidatedTask>,
): ValidatedTask[] {
  const verified = new Set(
    tasks.filter((t) => t.activity === 'verify').map(taskKey),
  );

  const missing: ValidatedTask[] = [];
  for (const task of tasks) {
    if (task.activity !== 'read') continue;
    const key = taskKey(task);
    if (verified.has(key)) continue;
    verified.add(key);
    const model = supplied.get(key);
    missing.push({
      node_id:       task.node_id,
      activity:      'verify',
      duration_mins: model?.duration_mins ?? VERIFY_MINS,
      ...(model?.detail ? { detail: model.detail } : {}),
      part:          task.part,
      parts:         task.parts,
    });
  }

  return missing.length > 0 ? [...tasks, ...missing] : tasks;
}

/** Where one reading task sits: the day's task array, and its index in it. */
interface ReadSlot {
  tasks: ValidatedTask[];
  index: number;
}

/**
 * Rewrite the reading order without touching the shape of the schedule.
 *
 * **This is the third prompt-only rule to have failed.** The model is told, and
 * was told about past dates and about study days before that, that a book is
 * worked through in the order it presents itself unless a chapter is known to be
 * weak. It does it most of the time — and then hands back a plan that reads
 * chapter 9 in week one and chapter 2 in week three, or the second half of a
 * chapter before the first. Sequence is not decoration in a textbook: chapter 9
 * is written on the assumption that chapter 2 has been read, so getting it wrong
 * does not make the plan slightly untidy, it makes the reading incomprehensible.
 *
 * So the model keeps everything it is actually good at — how many sittings a
 * chapter takes, which days carry work, how long each one runs, what to do in it
 * — and loses only the choice of WHICH chapter lands in each reading slot. The
 * slots are collected in schedule order, their payloads sorted by `rank` and
 * then by sitting, and put back.
 *
 * `rank` is the book's own order until the prerequisite graph says otherwise
 * (see `utils/chapter-order`), so on a book with no derived edges this is
 * front-to-back and nothing else.
 *
 * **Only `read` is touched.** `practice` is where revision lives — a short
 * return pass over a chapter the student is weak in — and revision is *supposed*
 * to be spaced through the plan rather than sorted into the reading sequence.
 * Leaving it alone is what lets the reading be strictly ordered without the plan
 * losing the ability to come back to things.
 *
 * Returns whether anything actually moved, because if it did, the checkpoints
 * the model wrote are now pinned to days that no longer hold the reading they
 * were checking, and have to be re-paired.
 */
function orderReading(weeks: ValidatedWeek[], rank: Map<string, number>): boolean {
  const slots: ReadSlot[] = [];

  for (const week of weeks) {
    for (const day of week.days) {
      day.tasks.forEach((task, index) => {
        if (task.activity === 'read') slots.push({ tasks: day.tasks, index });
      });
    }
  }

  return permute(
    slots,
    (a, b) => (rank.get(a.node_id) ?? 0) - (rank.get(b.node_id) ?? 0) || a.part - b.part,
  );
}

/**
 * Sort the payloads of `slots` among themselves and write them back in place.
 *
 * The whole task moves, not just its chapter id: a task's wording and its length
 * describe the chapter it is about, so leaving them behind would caption the
 * wrong reading. Ties keep their original order, so a sort that decides nothing
 * changes nothing.
 */
function permute(
  slots: ReadSlot[],
  compare: (a: ValidatedTask, b: ValidatedTask) => number,
): boolean {
  if (slots.length < 2) return false;

  const before = slots.map((slot) => slot.tasks[slot.index]);
  const after = before
    .map((task, i) => ({ task, i }))
    .sort((a, b) => compare(a.task, b.task) || a.i - b.i)
    .map((entry) => entry.task);

  let moved = false;
  slots.forEach((slot, i) => {
    if (after[i] !== before[i]) moved = true;
    slot.tasks[slot.index] = after[i];
  });
  return moved;
}

/**
 * Put a checkpoint after every sitting, in every day.
 *
 * When the reading has been reordered the model's own checkpoints are lifted out
 * first: each was written for whatever the model had scheduled that day, and the
 * day has since changed under it. What they said survives in `supplied` and is
 * re-attached to the sitting it belongs to, wherever that ended up.
 */
function pairVerifies(weeks: ValidatedWeek[], reordered: boolean): void {
  const supplied = new Map<string, ValidatedTask>();

  if (reordered) {
    for (const week of weeks) {
      for (const day of week.days) {
        for (const task of day.tasks) {
          if (task.activity === 'verify') supplied.set(taskKey(task), task);
        }
        day.tasks = day.tasks.filter((task) => task.activity !== 'verify');
      }
    }
  }

  for (const week of weeks) {
    for (const day of week.days) {
      day.tasks = withPairedVerifies(day.tasks, supplied);
    }
  }
}

function countTasks(weeks: ValidatedWeek[]): number {
  return weeks.reduce(
    (total, week) => total + week.days.reduce((sum, day) => sum + day.tasks.length, 0),
    0,
  );
}

/**
 * @param allowedNodeIds every chapter of the resource, **in the order the book
 * presents them**. Membership is the allow-list; position is the fallback
 * reading order, used wherever `constraints.prerequisites` says nothing.
 */
export function validateResourcePlan(
  raw: unknown,
  allowedNodeIds: Iterable<string>,
  constraints: PlanConstraints = {},
): ValidatedPlan {
  const allowed = new Set(allowedNodeIds);
  const rank = chapterRank([...allowed], constraints.prerequisites ?? []);
  const reasons = new Set<string>();
  const { startDate } = constraints;
  const studyDays = constraints.studyDays ? new Set(constraints.studyDays) : null;
  const startDay = startDate ? Math.floor(Date.UTC(
    startDate.getUTCFullYear(),
    startDate.getUTCMonth(),
    startDate.getUTCDate(),
  ) / 86400000) : null;
  let dropped = 0;

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

      // A day in the past cannot be studied. Only drop when the date actually
      // parses — an unrecognised format is left alone rather than binned.
      const parsedDay = day.data.date ? dayNumber(day.data.date) : null;
      if (startDay !== null && parsedDay !== null && parsedDay < startDay) {
        dropped += 1;
        reasons.add('day was scheduled in the past');
        continue;
      }

      // Day 0 of the Unix epoch was a Thursday, so `+4` puts Sunday at 0.
      if (studyDays !== null && parsedDay !== null) {
        const weekday = (((parsedDay + 4) % 7) + 7) % 7;
        if (!studyDays.has(weekday)) {
          dropped += 1;
          reasons.add('day fell on a weekday the student does not study');
          continue;
        }
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

        // A part beyond its own total is nonsense; clamp rather than drop, since
        // the task is otherwise fine and the page window is computed downstream.
        const parts = task.data.parts ?? 1;
        const part = Math.min(task.data.part ?? 1, parts);

        tasks.push({
          node_id:       task.data.node_id,
          activity:      task.data.activity,
          duration_mins: Math.round(task.data.duration_mins),
          ...(task.data.detail ? { detail: task.data.detail } : {}),
          part,
          parts,
        });
      }

      // A day with nothing left to do is not a day. Checkpoints are paired in a
      // second pass, once the reading order is settled — see `orderReading`.
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

  pairVerifies(weeks, orderReading(weeks, rank));
  const taskCount = countTasks(weeks);

  const milestones = (parsedPlan.data.milestones ?? [])
    .filter((m): m is string => typeof m === 'string')
    .map((m) => m.trim())
    .filter((m) => m.length > 0)
    .slice(0, 20);

  return { weeks, milestones, taskCount, dropped, reasons: [...reasons] };
}
