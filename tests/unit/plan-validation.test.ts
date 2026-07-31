import { validateResourcePlan } from '@utils/plan-validation';

const NODES = ['n1', 'n2', 'n3'];

function task(overrides: Record<string, unknown> = {}) {
  return { node_id: 'n1', activity: 'read', duration_mins: 45, ...overrides };
}

function plan(tasks: unknown[]) {
  return {
    weeks: [{ week_number: 1, days: [{ day: 'Monday', date: '2026-08-03', tasks }] }],
    milestones: ['Finish chapter 1'],
  };
}

describe('validateResourcePlan', () => {
  it('keeps well-formed tasks and counts them', () => {
    const result = validateResourcePlan(plan([task(), task({ node_id: 'n2', activity: 'practice' })]), NODES);
    expect(result.taskCount).toBe(2);
    expect(result.dropped).toBe(0);
    expect(result.weeks[0]?.days[0]?.tasks.map((t) => t.node_id)).toEqual(['n1', 'n2']);
  });

  it('drops a task naming a chapter that does not exist', () => {
    // The whole point of the allow-list: a model cannot invent a chapter, nor
    // point at one belonging to a different resource.
    const result = validateResourcePlan(plan([task(), task({ node_id: 'not-a-real-node' })]), NODES);
    expect(result.taskCount).toBe(1);
    expect(result.dropped).toBe(1);
    expect(result.reasons.join(' ')).toMatch(/does not exist/);
  });

  it('drops tasks with a missing or nonsense duration', () => {
    const result = validateResourcePlan(
      plan([
        task({ duration_mins: 0 }),
        task({ duration_mins: -30 }),
        task({ duration_mins: 99999 }),
        task({ duration_mins: 'about an hour' }),
        task(),
      ]),
      NODES,
    );
    expect(result.taskCount).toBe(1);
    expect(result.dropped).toBe(4);
  });

  it('drops a task with an activity outside the allowed set', () => {
    const result = validateResourcePlan(plan([task({ activity: 'meditate' })]), NODES);
    expect(result.taskCount).toBe(0);
    expect(result.dropped).toBe(1);
  });

  it('ignores page numbers the model tries to supply', () => {
    // Pages are filled in from the database precisely so a hallucinated range can
    // never reach the student — the validator must not carry them through.
    const result = validateResourcePlan(
      plan([task({ page_start: 900, page_end: 950, chapter_title: 'Invented Chapter' })]),
      NODES,
    );
    const kept = result.weeks[0]?.days[0]?.tasks[0];
    expect(kept).toBeDefined();
    expect(kept).not.toHaveProperty('page_start');
    expect(kept).not.toHaveProperty('chapter_title');
  });

  it('drops a day left with no usable tasks, and a week left with no days', () => {
    const result = validateResourcePlan(
      {
        weeks: [
          { week_number: 1, days: [{ day: 'Mon', date: '2026-08-03', tasks: [task({ node_id: 'ghost' })] }] },
          { week_number: 2, days: [{ day: 'Tue', date: '2026-08-04', tasks: [task()] }] },
        ],
      },
      NODES,
    );
    expect(result.weeks).toHaveLength(1);
    expect(result.taskCount).toBe(1);
  });

  it('renumbers weeks so dropping one leaves no gap', () => {
    const result = validateResourcePlan(
      {
        weeks: [
          { week_number: 1, days: [{ date: 'd1', tasks: [task({ node_id: 'ghost' })] }] },
          { week_number: 2, days: [{ date: 'd2', tasks: [task()] }] },
          { week_number: 3, days: [{ date: 'd3', tasks: [task({ node_id: 'n2' })] }] },
        ],
      },
      NODES,
    );
    // Week 1 vanished; what remains must read as weeks 1 and 2, not 2 and 3.
    expect(result.weeks.map((w) => w.week_number)).toEqual([1, 2]);
  });

  it('reports zero tasks rather than throwing when nothing survives', () => {
    const result = validateResourcePlan(plan([task({ node_id: 'ghost' })]), NODES);
    expect(result.taskCount).toBe(0);
    expect(result.weeks).toEqual([]);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('survives junk where a plan should be', () => {
    for (const junk of [null, undefined, 'a plan', 42, [], { weeks: 'soon' }]) {
      const result = validateResourcePlan(junk, NODES);
      expect(result.taskCount).toBe(0);
      expect(result.weeks).toEqual([]);
    }
  });

  it('keeps milestones as strings and discards anything else', () => {
    const result = validateResourcePlan(
      { weeks: [], milestones: ['Real one', '', 42, null, '  spaced  '] },
      NODES,
    );
    expect(result.milestones).toEqual(['Real one', 'spaced']);
  });

  describe('past days', () => {
    // Generated on a Friday, the model lays week 1 out Monday-to-Sunday and tells
    // the student to study days that have already gone. The prompt asks it not
    // to; this is what makes sure.
    const friday = new Date('2026-07-31T09:00:00Z');

    const week = (dates: string[]) => ({
      weeks: [
        {
          week_number: 1,
          days: dates.map((date) => ({ day: 'D', date, tasks: [task()] })),
        },
      ],
    });

    it('drops days before the start date', () => {
      const result = validateResourcePlan(
        week(['2026-07-29', '2026-07-30', '2026-07-31', '2026-08-01']),
        NODES,
        friday,
      );
      expect(result.weeks[0]?.days.map((d) => d.date)).toEqual(['2026-07-31', '2026-08-01']);
      expect(result.dropped).toBe(2);
      expect(result.reasons.join(' ')).toMatch(/past/);
    });

    it('keeps today, even generated later the same day', () => {
      const result = validateResourcePlan(week(['2026-07-31']), NODES, friday);
      expect(result.weeks[0]?.days).toHaveLength(1);
    });

    it('keeps a day whose date it cannot parse rather than binning it', () => {
      const result = validateResourcePlan(week(['Week 1, Day 2']), NODES, friday);
      expect(result.weeks[0]?.days).toHaveLength(1);
    });

    it('drops a week left empty by past days, without leaving a gap', () => {
      const result = validateResourcePlan(
        {
          weeks: [
            { week_number: 1, days: [{ date: '2026-07-28', tasks: [task()] }] },
            { week_number: 2, days: [{ date: '2026-08-04', tasks: [task()] }] },
          ],
        },
        NODES,
        friday,
      );
      expect(result.weeks).toHaveLength(1);
      expect(result.weeks[0]?.week_number).toBe(1);
    });

    it('keeps every day when no start date is given', () => {
      const result = validateResourcePlan(week(['2020-01-01']), NODES);
      expect(result.weeks[0]?.days).toHaveLength(1);
    });
  });

  it('rounds a fractional duration rather than storing it', () => {
    const result = validateResourcePlan(plan([task({ duration_mins: 42.7 })]), NODES);
    expect(result.weeks[0]?.days[0]?.tasks[0]?.duration_mins).toBe(43);
  });
});
