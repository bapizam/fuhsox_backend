/**
 * Prerequisite graph over knowledge components (reformation Phase 4, Workstream A).
 *
 * Two jobs, both of which are the reason this file is pure and heavily tested:
 *
 * 1. **Keep the graph acyclic.** A prerequisite cycle (A needs B needs C needs A)
 *    makes a naive upstream walk loop forever. It is trivially producible — an LLM
 *    proposing edges for a syllabus where two topics genuinely reinforce each other
 *    will suggest both directions — and it is exactly the class of bug that is
 *    invisible in testing and catastrophic in production. So insertion is gated by
 *    `wouldCreateCycle` AND traversal is depth-bounded, because one guard on a
 *    hang is not a guard.
 *
 * 2. **Walk upstream from a failure to its causes.** This is the payoff: turning
 *    "you failed Cardiac Output" into "…because Membrane Potentials is not solid".
 *
 * No Prisma, no AI, no clock. Edges come in as plain rows so the whole policy is
 * unit-testable against a hand-built graph.
 */

export interface KcEdgeLike {
  from_kc_id: string;
  to_kc_id: string;
  /** 0..1 confidence in the dependency. Ranks gaps; never gates them. */
  strength?: number;
}

/**
 * How far upstream a diagnosis may reach.
 *
 * A bound, not a performance tweak. Three hops is already at the edge of useful:
 * telling a student their cardiac-output failure traces back four concepts is a
 * true statement that is no longer actionable advice. It also means a cycle that
 * somehow got past `wouldCreateCycle` — a bad migration, a direct DB edit —
 * terminates instead of hanging a request.
 */
export const MAX_UPSTREAM_DEPTH = 3;

/** Adjacency in the "what does this depend on" direction: to → [from…]. */
function buildUpstreamIndex(edges: KcEdgeLike[]): Map<string, KcEdgeLike[]> {
  const index = new Map<string, KcEdgeLike[]>();
  for (const edge of edges) {
    const bucket = index.get(edge.to_kc_id);
    if (bucket) bucket.push(edge);
    else index.set(edge.to_kc_id, [edge]);
  }
  return index;
}

/**
 * Would adding `from → to` close a cycle?
 *
 * True when `from` is already reachable downstream of `to` — i.e. `to` is already
 * (transitively) a prerequisite of `from`, so declaring the reverse would make each
 * a prerequisite of the other. Self-edges are cycles by definition and are caught
 * first, since a KC cannot be its own prerequisite.
 *
 * Iterative rather than recursive: the traversal runs over adversarial input (an
 * LLM's proposals) and a stack overflow is just a different way to take the request
 * down.
 */
export function wouldCreateCycle(
  edges: KcEdgeLike[],
  fromKcId: string,
  toKcId: string,
): boolean {
  if (fromKcId === toKcId) return true;

  // Downstream adjacency: from → [to…]. Walking forward from `to` asks "what
  // eventually depends on `to`?" — if that set contains `from`, the new edge closes
  // a loop.
  const downstream = new Map<string, string[]>();
  for (const edge of edges) {
    const bucket = downstream.get(edge.from_kc_id);
    if (bucket) bucket.push(edge.to_kc_id);
    else downstream.set(edge.from_kc_id, [edge.to_kc_id]);
  }

  const seen = new Set<string>([toKcId]);
  const stack = [toKcId];

  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const next of downstream.get(current) ?? []) {
      if (next === fromKcId) return true;
      // `seen` also makes this terminate on a graph that is ALREADY cyclic, so a
      // pre-existing bad edge cannot stop new ones being validated.
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }

  return false;
}

export interface UpstreamKc {
  kc_id: string;
  /** 1 = a direct prerequisite, 2 = a prerequisite of that, … */
  depth: number;
  /**
   * Confidence in the weakest link on the path to this KC — a chain is only as
   * believable as its least certain edge, so a 0.9 edge behind a 0.3 edge is not a
   * 0.9 claim.
   */
  strength: number;
}

/**
 * Every KC that `kcId` transitively depends on, breadth-first and depth-bounded.
 *
 * Breadth-first so a KC reachable by both a short and a long path is reported at
 * its SHORTEST depth — the most direct explanation is the one worth showing a
 * student. Visited-tracking makes a diamond (two paths to one ancestor) yield one
 * row rather than two, and makes an already-cyclic graph terminate.
 */
export function upstreamPrerequisites(
  edges: KcEdgeLike[],
  kcId: string,
  maxDepth: number = MAX_UPSTREAM_DEPTH,
): UpstreamKc[] {
  const index = buildUpstreamIndex(edges);
  const visited = new Set<string>([kcId]);
  const found: UpstreamKc[] = [];

  let frontier: { kc_id: string; strength: number }[] = [{ kc_id: kcId, strength: 1 }];

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: { kc_id: string; strength: number }[] = [];

    for (const node of frontier) {
      for (const edge of index.get(node.kc_id) ?? []) {
        if (visited.has(edge.from_kc_id)) continue;
        visited.add(edge.from_kc_id);

        const strength = Math.min(node.strength, edge.strength ?? 0.5);
        found.push({ kc_id: edge.from_kc_id, depth, strength });
        next.push({ kc_id: edge.from_kc_id, strength });
      }
    }

    frontier = next;
  }

  return found;
}

export interface PrerequisiteGap extends UpstreamKc {
  /** 0..1 from BKT. */
  p_known: number;
  /** Assessed opportunities behind `p_known` — a belief with no sample is not a claim. */
  opportunities: number;
}

/**
 * The diagnosis: which of a failed KC's prerequisites are themselves weak.
 *
 * Two filters do the honest work here, and both are the point rather than
 * defensive noise:
 *
 * - **`opportunities > 0`.** A prerequisite the student has never been assessed on
 *   is unknown, not weak. Reporting it would dress "we have no idea" as "this is
 *   your problem" — the exact over-claiming the reformation exists to remove.
 * - **`p_known < shakyBelow`.** Set above the BKT prior, so evidence has to have
 *   actually moved the belief downward before the KC is named.
 *
 * Ranked by how confident the causal story is (`strength`), then by how weak the
 * prerequisite is, then by how near it is — a shaky direct prerequisite is a better
 * thing to say than a slightly shakier one three hops away.
 */
export function prerequisiteGaps(params: {
  edges: KcEdgeLike[];
  kcId: string;
  pKnownByKc: Map<string, { p_known: number; opportunities: number }>;
  shakyBelow?: number;
  maxDepth?: number;
  limit?: number;
}): PrerequisiteGap[] {
  const shakyBelow = params.shakyBelow ?? 0.4;
  const upstream = upstreamPrerequisites(params.edges, params.kcId, params.maxDepth);

  const gaps: PrerequisiteGap[] = [];
  for (const node of upstream) {
    const mastery = params.pKnownByKc.get(node.kc_id);
    if (!mastery || mastery.opportunities === 0) continue;
    if (mastery.p_known >= shakyBelow) continue;

    gaps.push({ ...node, p_known: mastery.p_known, opportunities: mastery.opportunities });
  }

  gaps.sort(
    (a, b) => b.strength - a.strength || a.p_known - b.p_known || a.depth - b.depth,
  );

  return typeof params.limit === 'number' ? gaps.slice(0, params.limit) : gaps;
}
