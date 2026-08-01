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
    // The read gains its paired verify; practice does not (it claims nothing).
    expect(result.taskCount).toBe(3);
    expect(result.dropped).toBe(0);
    expect(result.weeks[0]?.days[0]?.tasks.map((t) => t.node_id)).toEqual(['n1', 'n2', 'n1']);
  });

  it('drops a task naming a chapter that does not exist', () => {
    // The whole point of the allow-list: a model cannot invent a chapter, nor
    // point at one belonging to a different resource.
    const result = validateResourcePlan(plan([task(), task({ node_id: 'not-a-real-node' })]), NODES);
    expect(result.taskCount).toBe(2); // the surviving read, plus its verify
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
    expect(result.taskCount).toBe(2); // the one survivor, plus its verify
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
    expect(result.taskCount).toBe(2); // read + paired verify
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
        { startDate: friday },
      );
      expect(result.weeks[0]?.days.map((d) => d.date)).toEqual(['2026-07-31', '2026-08-01']);
      expect(result.dropped).toBe(2);
      expect(result.reasons.join(' ')).toMatch(/past/);
    });

    it('keeps today, even generated later the same day', () => {
      const result = validateResourcePlan(week(['2026-07-31']), NODES, { startDate: friday });
      expect(result.weeks[0]?.days).toHaveLength(1);
    });

    it('keeps a day whose date it cannot parse rather than binning it', () => {
      const result = validateResourcePlan(week(['Week 1, Day 2']), NODES, { startDate: friday });
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
        { startDate: friday },
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

describe('paired verifies', () => {
  // Structural, not prompted: a reading day with nothing to prove is exactly the
  // day a student finishes and has no idea whether any of it went in.
  const day = (tasks: unknown[]) => ({
    weeks: [{ week_number: 1, days: [{ day: 'Mon', date: '2026-08-03', tasks }] }],
  });

  it('appends a verify for a read the model left unpaired', () => {
    const result = validateResourcePlan(day([task({ activity: 'read' })]), NODES);
    const kept = result.weeks[0]?.days[0]?.tasks ?? [];
    expect(kept.map((t) => t.activity)).toEqual(['read', 'verify']);
    expect(kept[1]?.node_id).toBe('n1');
  });

  it('does not duplicate a verify the model already wrote', () => {
    const result = validateResourcePlan(
      day([task({ activity: 'read' }), task({ activity: 'verify', duration_mins: 20 })]),
      NODES,
    );
    const kept = result.weeks[0]?.days[0]?.tasks ?? [];
    expect(kept.filter((t) => t.activity === 'verify')).toHaveLength(1);
    // The model's own duration survives — this only fills gaps.
    expect(kept[1]?.duration_mins).toBe(20);
  });

  it('pairs each SITTING separately, so two parts get two checks', () => {
    const result = validateResourcePlan(
      day([
        task({ activity: 'read', part: 1, parts: 2 }),
        task({ activity: 'read', part: 2, parts: 2 }),
      ]),
      NODES,
    );
    const verifies = (result.weeks[0]?.days[0]?.tasks ?? []).filter((t) => t.activity === 'verify');
    expect(verifies.map((v) => v.part)).toEqual([1, 2]);
  });

  it('treats a verify of a DIFFERENT sitting as not covering this read', () => {
    const result = validateResourcePlan(
      day([task({ activity: 'read', part: 2, parts: 3 }), task({ activity: 'verify', part: 1, parts: 3 })]),
      NODES,
    );
    const verifies = (result.weeks[0]?.days[0]?.tasks ?? []).filter((t) => t.activity === 'verify');
    expect(verifies.map((v) => v.part).sort()).toEqual([1, 2]);
  });

  it('leaves practice alone — it claims to have covered nothing', () => {
    const result = validateResourcePlan(day([task({ activity: 'practice' })]), NODES);
    expect(result.weeks[0]?.days[0]?.tasks.map((t) => t.activity)).toEqual(['practice']);
  });

  it('counts the tasks it added', () => {
    const result = validateResourcePlan(
      day([task({ activity: 'read' }), task({ activity: 'read', node_id: 'n2' })]),
      NODES,
    );
    expect(result.taskCount).toBe(4);
  });
});

describe('study days', () => {
  // The model was already told, in capitals, not to schedule days that had
  // passed — and did. A scheduling rule that only lives in the prompt is a
  // suggestion, so this is where "Mondays and Wednesdays" is actually kept.
  const week = (dates: string[]) => ({
    weeks: [{ week_number: 1, days: dates.map((date) => ({ day: 'D', date, tasks: [task()] })) }],
  });

  // 2026-08-03 is a Monday.
  const MON = '2026-08-03';
  const TUE = '2026-08-04';
  const WED = '2026-08-05';
  const SUN = '2026-08-09';

  it('keeps only the weekdays the student picked', () => {
    const result = validateResourcePlan(week([MON, TUE, WED, SUN]), NODES, {
      studyDays: [1, 3], // Monday, Wednesday
    });
    expect(result.weeks[0]?.days.map((d) => d.date)).toEqual([MON, WED]);
    expect(result.reasons.join(' ')).toMatch(/does not study/);
  });

  it('puts Sunday at 0', () => {
    const result = validateResourcePlan(week([SUN, MON]), NODES, { studyDays: [0] });
    expect(result.weeks[0]?.days.map((d) => d.date)).toEqual([SUN]);
  });

  it('keeps every weekday when none were given', () => {
    const result = validateResourcePlan(week([MON, TUE, WED, SUN]), NODES);
    expect(result.weeks[0]?.days).toHaveLength(4);
  });

  it('keeps a day whose date it cannot parse rather than binning it', () => {
    const result = validateResourcePlan(week(['Week 1, Day 2']), NODES, { studyDays: [1] });
    expect(result.weeks[0]?.days).toHaveLength(1);
  });

  it('applies alongside the start date, not instead of it', () => {
    const result = validateResourcePlan(week(['2026-07-27', MON]), NODES, {
      startDate: new Date('2026-07-31T09:00:00Z'),
      studyDays: [1], // both dates are Mondays; only one is in the future
    });
    expect(result.weeks[0]?.days.map((d) => d.date)).toEqual([MON]);
  });
});
