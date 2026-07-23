import {
  MAX_UPSTREAM_DEPTH,
  prerequisiteGaps,
  upstreamPrerequisites,
  wouldCreateCycle,
  type KcEdgeLike,
} from '@utils/kc-graph';

/**
 * A → B → C, plus D as a second prerequisite of C.
 *
 *   membrane ─┐
 *             ├─> action_potential ─> cardiac_output
 *   ions ─────┘                     ↑
 *                        haemodynamics
 */
const GRAPH: KcEdgeLike[] = [
  { from_kc_id: 'membrane',          to_kc_id: 'action_potential', strength: 0.9 },
  { from_kc_id: 'ions',              to_kc_id: 'action_potential', strength: 0.4 },
  { from_kc_id: 'action_potential',  to_kc_id: 'cardiac_output',   strength: 0.8 },
  { from_kc_id: 'haemodynamics',     to_kc_id: 'cardiac_output',   strength: 0.7 },
];

describe('wouldCreateCycle', () => {
  it('rejects a self-edge — nothing is its own prerequisite', () => {
    expect(wouldCreateCycle(GRAPH, 'membrane', 'membrane')).toBe(true);
  });

  it('allows an edge that keeps the graph acyclic', () => {
    expect(wouldCreateCycle(GRAPH, 'ions', 'cardiac_output')).toBe(false);
  });

  it('rejects a direct reversal', () => {
    expect(wouldCreateCycle(GRAPH, 'action_potential', 'membrane')).toBe(true);
  });

  it('rejects a transitive cycle several hops long', () => {
    // cardiac_output already depends on membrane via action_potential, so making
    // membrane depend on cardiac_output closes a 3-hop loop.
    expect(wouldCreateCycle(GRAPH, 'cardiac_output', 'membrane')).toBe(true);
  });

  it('terminates on an ALREADY cyclic graph instead of hanging', () => {
    // A bad migration or a direct DB edit can leave a cycle in place. Validating
    // new edges must still work — and must still return.
    const cyclic: KcEdgeLike[] = [
      { from_kc_id: 'a', to_kc_id: 'b' },
      { from_kc_id: 'b', to_kc_id: 'c' },
      { from_kc_id: 'c', to_kc_id: 'a' },
    ];
    expect(wouldCreateCycle(cyclic, 'b', 'a')).toBe(true);
    expect(wouldCreateCycle(cyclic, 'a', 'd')).toBe(false);
  });

  it('handles an empty graph', () => {
    expect(wouldCreateCycle([], 'a', 'b')).toBe(false);
  });

  it('does not stack-overflow on a long chain', () => {
    const chain: KcEdgeLike[] = Array.from({ length: 5000 }, (_, i) => ({
      from_kc_id: `n${i}`,
      to_kc_id:   `n${i + 1}`,
    }));
    expect(wouldCreateCycle(chain, 'n5000', 'n0')).toBe(true);
  });
});

describe('upstreamPrerequisites', () => {
  it('finds direct and transitive prerequisites with their depth', () => {
    const upstream = upstreamPrerequisites(GRAPH, 'cardiac_output');
    const byId = new Map(upstream.map((u) => [u.kc_id, u]));

    expect(byId.get('action_potential')?.depth).toBe(1);
    expect(byId.get('haemodynamics')?.depth).toBe(1);
    expect(byId.get('membrane')?.depth).toBe(2);
    expect(byId.get('ions')?.depth).toBe(2);
  });

  it('returns nothing for a leaf with no prerequisites', () => {
    expect(upstreamPrerequisites(GRAPH, 'membrane')).toEqual([]);
  });

  it('carries the WEAKEST link on the path — a chain is only as good as its worst edge', () => {
    const upstream = upstreamPrerequisites(GRAPH, 'cardiac_output');
    // ions → action_potential is 0.4, action_potential → cardiac_output is 0.8.
    expect(upstream.find((u) => u.kc_id === 'ions')?.strength).toBeCloseTo(0.4);
    // membrane's path is min(0.8, 0.9) = 0.8.
    expect(upstream.find((u) => u.kc_id === 'membrane')?.strength).toBeCloseTo(0.8);
  });

  it('honours the depth bound', () => {
    const shallow = upstreamPrerequisites(GRAPH, 'cardiac_output', 1);
    expect(shallow.map((u) => u.kc_id).sort()).toEqual(['action_potential', 'haemodynamics']);
  });

  it('reports a diamond ancestor once, at its SHORTEST depth', () => {
    const diamond: KcEdgeLike[] = [
      { from_kc_id: 'root', to_kc_id: 'left' },
      { from_kc_id: 'root', to_kc_id: 'target' },
      { from_kc_id: 'left', to_kc_id: 'target' },
    ];
    const upstream = upstreamPrerequisites(diamond, 'target');
    const root = upstream.filter((u) => u.kc_id === 'root');
    expect(root).toHaveLength(1);
    expect(root[0].depth).toBe(1);
  });

  it('terminates on a cyclic graph — the read-time bound is the second guard', () => {
    const cyclic: KcEdgeLike[] = [
      { from_kc_id: 'a', to_kc_id: 'b' },
      { from_kc_id: 'b', to_kc_id: 'c' },
      { from_kc_id: 'c', to_kc_id: 'a' },
    ];
    const upstream = upstreamPrerequisites(cyclic, 'a');
    expect(upstream.map((u) => u.kc_id).sort()).toEqual(['b', 'c']);
  });

  it('defaults to a depth bound that keeps a diagnosis actionable', () => {
    const chain: KcEdgeLike[] = Array.from({ length: 10 }, (_, i) => ({
      from_kc_id: `n${i}`,
      to_kc_id:   `n${i + 1}`,
    }));
    expect(upstreamPrerequisites(chain, 'n10')).toHaveLength(MAX_UPSTREAM_DEPTH);
  });
});

describe('prerequisiteGaps', () => {
  const mastery = (rows: [string, number, number][]) =>
    new Map(rows.map(([kc, p, n]) => [kc, { p_known: p, opportunities: n }]));

  it('names only prerequisites that are BOTH assessed and weak', () => {
    const gaps = prerequisiteGaps({
      edges:      GRAPH,
      kcId:       'cardiac_output',
      pKnownByKc: mastery([
        ['action_potential', 0.2, 3],
        ['haemodynamics',    0.9, 2],
      ]),
    });
    expect(gaps.map((g) => g.kc_id)).toEqual(['action_potential']);
  });

  it('never accuses a prerequisite the student has never been assessed on', () => {
    // "We have no idea" must not be dressed as "this is your problem" — the exact
    // over-claiming the reformation exists to remove.
    const gaps = prerequisiteGaps({
      edges:      GRAPH,
      kcId:       'cardiac_output',
      pKnownByKc: mastery([['action_potential', 0.05, 0]]),
    });
    expect(gaps).toEqual([]);
  });

  it('says nothing when there is no mastery data at all', () => {
    expect(
      prerequisiteGaps({ edges: GRAPH, kcId: 'cardiac_output', pKnownByKc: new Map() }),
    ).toEqual([]);
  });

  it('says nothing for a KC with no prerequisites', () => {
    expect(
      prerequisiteGaps({
        edges:      GRAPH,
        kcId:       'membrane',
        pKnownByKc: mastery([['ions', 0.1, 5]]),
      }),
    ).toEqual([]);
  });

  it('ranks the most confident causal story first', () => {
    const gaps = prerequisiteGaps({
      edges:      GRAPH,
      kcId:       'cardiac_output',
      pKnownByKc: mastery([
        ['ions',             0.1, 4],  // strength 0.4
        ['action_potential', 0.3, 4],  // strength 0.8
      ]),
    });
    expect(gaps.map((g) => g.kc_id)).toEqual(['action_potential', 'ions']);
  });

  it('respects the limit', () => {
    const gaps = prerequisiteGaps({
      edges:      GRAPH,
      kcId:       'cardiac_output',
      pKnownByKc: mastery([
        ['action_potential', 0.1, 2],
        ['haemodynamics',    0.1, 2],
        ['membrane',         0.1, 2],
        ['ions',             0.1, 2],
      ]),
      limit: 2,
    });
    expect(gaps).toHaveLength(2);
  });

  it('carries p_known and the sample size through to the caller', () => {
    const [gap] = prerequisiteGaps({
      edges:      GRAPH,
      kcId:       'cardiac_output',
      pKnownByKc: mastery([['action_potential', 0.12, 5]]),
    });
    expect(gap).toMatchObject({ p_known: 0.12, opportunities: 5, depth: 1 });
  });
});
