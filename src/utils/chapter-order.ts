/**
 * The order a book's chapters have to be read in.
 *
 * Until now that order was the book's own — `SyllabusNode.ordinal`, front to
 * back — which is right far more often than it is wrong and is wrong in exactly
 * the cases that matter: the foundations chapter printed as an appendix, the
 * "background" chapter placed after the material it is background for, the
 * textbook whose part II is a prerequisite for part I's exercises. A plan built
 * on ordinal alone cannot know any of that.
 *
 * So a model proposes dependency edges from the chapters' own text (see
 * `ai.service → getChapterPrerequisites`) and this module decides what to do
 * with them. Both halves are here and both are pure, because a graph produced by
 * an LLM is adversarial input: it will propose cycles, self-edges, chapters that
 * do not exist, and occasionally three hundred edges for a twelve-chapter book.
 * None of that may reach a student's timetable, and none of it needs a database
 * to test.
 */
import { wouldCreateCycle } from '@utils/kc-graph';

export interface PrereqEdge {
  /** The chapter that must be read FIRST. */
  from: string;
  /** The chapter that depends on it. */
  to: string;
  /** 0..1 confidence. Ranks the edge; never gates it. */
  strength: number;
}

/**
 * How many edges a book is allowed, as a multiple of its chapter count.
 *
 * A dependency graph over chapters is naturally sparse — most chapters depend on
 * one or two others. A response proposing far more than that has not found
 * structure, it has listed every pair it could think of, and a dense graph
 * constrains the order so tightly that the plan is no longer schedulable.
 */
const MAX_EDGES_PER_CHAPTER = 3;

/**
 * Accept as many proposed edges as are safe, in the order proposed.
 *
 * Rejected: anything naming a chapter outside `allowedIds` (the model inventing
 * or borrowing an id), self-edges, exact duplicates, and — the one that actually
 * matters — any edge that would close a cycle, checked against the edges
 * accepted **so far** with `kc-graph`'s `wouldCreateCycle`. A cycle is trivially
 * producible whenever two chapters genuinely reinforce each other, and it is
 * what would make the topological sort below drop chapters on the floor.
 *
 * Order-dependent by design: the model lists its most confident dependencies
 * first, so when two edges conflict the earlier one wins.
 */
export function acceptPrerequisites(
  proposed: readonly { from: string; to: string; strength?: number }[],
  allowedIds: Iterable<string>,
): PrereqEdge[] {
  const allowed = new Set(allowedIds);
  const cap = allowed.size * MAX_EDGES_PER_CHAPTER;
  const seen = new Set<string>();
  const accepted: PrereqEdge[] = [];

  for (const edge of proposed) {
    if (accepted.length >= cap) break;
    if (!allowed.has(edge.from) || !allowed.has(edge.to)) continue;
    if (edge.from === edge.to) continue;

    const key = `${edge.from}->${edge.to}`;
    if (seen.has(key)) continue;

    // `wouldCreateCycle` speaks in KC ids; the shape is the only thing it needs.
    const asKcEdges = accepted.map((e) => ({ from_kc_id: e.from, to_kc_id: e.to }));
    if (wouldCreateCycle(asKcEdges, edge.from, edge.to)) continue;

    seen.add(key);
    accepted.push({
      from:     edge.from,
      to:       edge.to,
      strength: clampStrength(edge.strength),
    });
  }

  return accepted;
}

function clampStrength(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

/**
 * Rank every chapter so that nothing is read before what it depends on.
 *
 * Depth-first post-order, walking the chapters in the book's own order: take
 * each chapter in turn, and immediately before placing it, place anything it
 * depends on that has not been placed yet. **Which is to say: when the plan
 * reaches a chapter that needs something the student has not read, it goes and
 * gets it, then carries on where it was.**
 *
 * That "then carries on where it was" is the whole reason this is a DFS and not
 * Kahn's algorithm. Kahn would have placed every unblocked chapter first — so a
 * "Linear Algebra Review" printed as chapter 12 but needed by chapters 3–8 would
 * push 3–8 behind 9, 10 and 11, scattering the book to satisfy one dependency.
 * Here it produces 1, 2, **12**, 3, 4 … which is what a person would have done.
 *
 * With no edges the walk never recurses and the result is byte-for-byte the
 * book's own order — so a book whose derivation failed, or was never paid for,
 * behaves exactly as it did before the graph existed.
 *
 * Iterative rather than recursive, for the reason `kc-graph` gives: the input
 * originates with an LLM, and a stack overflow is just a different way to take
 * the request down. A prerequisite already on the stack is a cycle and is
 * skipped, which drops precisely the back-edge and nothing else — every chapter
 * is still placed by the outer loop, because this map decides what a student
 * reads and it must never be able to lose one.
 */
export function chapterRank(
  idsInBookOrder: readonly string[],
  edges: readonly PrereqEdge[] = [],
): Map<string, number> {
  const position = new Map(idsInBookOrder.map((id, i) => [id, i]));

  const prereqsOf = new Map<string, string[]>();
  for (const edge of edges) {
    if (!position.has(edge.from) || !position.has(edge.to)) continue;
    const bucket = prereqsOf.get(edge.to);
    if (bucket) bucket.push(edge.from);
    else prereqsOf.set(edge.to, [edge.from]);
  }
  // Book order among a chapter's own prerequisites, so the result is stable and
  // does not depend on which order the model happened to list its edges in.
  for (const bucket of prereqsOf.values()) {
    bucket.sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0));
  }

  const rank = new Map<string, number>();
  const placed = new Set<string>();
  const onStack = new Set<string>();

  for (const root of idsInBookOrder) {
    if (placed.has(root)) continue;
    const stack = [root];
    onStack.add(root);

    while (stack.length > 0) {
      const id = stack[stack.length - 1];
      const pending = (prereqsOf.get(id) ?? []).find(
        (p) => !placed.has(p) && !onStack.has(p),
      );

      if (pending !== undefined) {
        stack.push(pending);
        onStack.add(pending);
        continue;
      }

      stack.pop();
      onStack.delete(id);
      placed.add(id);
      rank.set(id, rank.size);
    }
  }

  return rank;
}
