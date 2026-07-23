/**
 * Knowledge components + prerequisite diagnosis (reformation Phase 4, Workstream A).
 *
 * The model maths lives in `utils/bkt.ts` and `utils/kc-graph.ts` — both pure and
 * unit-tested, in the same style as `utils/mastery.ts`. This file is only the I/O
 * around them: load rows, hand them to the pure functions, persist the one thing
 * that has to be persisted (the objective→KC mapping).
 *
 * **`p_known` is derived on read, never stored.** There is no `kc_mastery` table
 * and no write path to keep in sync: every belief is recomputed from the
 * `MasteryAttempt` rows that already exist. That is the same call `effectiveState`
 * makes, and it has the same payoff — a tuning change to `BKT` takes effect
 * everywhere immediately instead of requiring a backfill of stale probabilities.
 *
 * Costs **zero AI calls** except `proposeGraphForSubject`, which is explicitly the
 * one budgeted entry point.
 */
import prisma from '@config/database';
import { AppError } from '@typings/models';
import { BKT, kcMastery, type KcEvidence, type KcMastery } from '@utils/bkt';
import {
  MAX_UPSTREAM_DEPTH,
  prerequisiteGaps,
  wouldCreateCycle,
  type KcEdgeLike,
  type PrerequisiteGap,
} from '@utils/kc-graph';
import { aiService } from './ai.service';
import logger from '@lib/logger';

/** How many prerequisite gaps a diagnosis will name at once. */
const MAX_GAPS_SHOWN = 3;

// ─── Reading the graph ────────────────────────────────────────────────────────

export async function listKnowledgeComponents(institutionId: string, subject?: string) {
  return prisma.knowledgeComponent.findMany({
    where:   { institution_id: institutionId, ...(subject ? { subject } : {}) },
    orderBy: [{ subject: 'asc' }, { name: 'asc' }],
  });
}

/** Every edge among a set of KCs — the subgraph a walk needs, in one query. */
async function edgesAmong(kcIds: string[]): Promise<KcEdgeLike[]> {
  if (kcIds.length === 0) return [];
  return prisma.kCEdge.findMany({
    where:  { from_kc_id: { in: kcIds }, to_kc_id: { in: kcIds } },
    select: { from_kc_id: true, to_kc_id: true, strength: true },
  });
}

/**
 * This student's `p_known` for every KC they have been assessed on.
 *
 * **The evidence unit is a mastery CHECK, not an item.** `MasteryAttempt.passed`
 * is already scored against the threshold in force at the time, so it is a clean
 * binary observation with the institution's policy baked in — and it is the same
 * unit the rest of the engine reasons about. Per-item evidence would be finer, but
 * it lives in Mongo behind a session join, which is the cross-store cost the
 * objective→KC design decision exists to avoid.
 *
 * Attempts on objectives with no `kc_id` are simply absent — an unmapped objective
 * contributes nothing and breaks nothing.
 */
export async function kcMasteryForUser(userId: string, subject?: string): Promise<KcMastery[]> {
  const attempts = await prisma.masteryAttempt.findMany({
    where: {
      user_id:   userId,
      objective: { kc_id: { not: null }, ...(subject ? { subject } : {}) },
    },
    // Oldest first: BKT is a recursive filter, so newest-first would model a
    // student who un-learns. `kcMastery` re-sorts defensively, but handing it the
    // right order keeps the intent visible at the query.
    orderBy: { created_at: 'asc' },
    select:  { passed: true, created_at: true, objective: { select: { kc_id: true } } },
  });

  const evidence: KcEvidence[] = attempts.flatMap((attempt) =>
    attempt.objective.kc_id
      ? [{ kc_id: attempt.objective.kc_id, correct: attempt.passed, at: attempt.created_at }]
      : [],
  );

  return kcMastery(evidence);
}

export interface KcGraphNode {
  id: string;
  name: string;
  subject: string;
  description: string | null;
  /** Null = LLM-proposed and unreviewed. Present this as a hypothesis, not fact. */
  curated_by: string | null;
  /** 0..1 from BKT. Null when the student has never been assessed on it. */
  p_known: number | null;
  opportunities: number;
  /** This student's objectives mapped to this KC. */
  objective_ids: string[];
}

export interface KcGraphEdge {
  from_kc_id: string;
  to_kc_id: string;
  strength: number;
  curated_by: string | null;
}

/**
 * The graph for one subject, annotated with this student's beliefs.
 *
 * Zero AI calls — it is joins and arithmetic, so it is affordable to render on an
 * always-on screen against a 20/day budget, exactly like the rest of the analytics.
 */
export async function getGraphForUser(params: {
  userId:        string;
  institutionId: string;
  subject?:      string;
}): Promise<{ nodes: KcGraphNode[]; edges: KcGraphEdge[] }> {
  const components = await prisma.knowledgeComponent.findMany({
    where:   { institution_id: params.institutionId, ...(params.subject ? { subject: params.subject } : {}) },
    orderBy: [{ subject: 'asc' }, { name: 'asc' }],
  });
  if (components.length === 0) return { nodes: [], edges: [] };

  const kcIds = components.map((c) => c.id);

  const [objectives, edges, mastery] = await Promise.all([
    prisma.learningObjective.findMany({
      where:  { user_id: params.userId, kc_id: { in: kcIds } },
      select: { id: true, kc_id: true },
    }),
    prisma.kCEdge.findMany({
      where:  { from_kc_id: { in: kcIds }, to_kc_id: { in: kcIds } },
      select: { from_kc_id: true, to_kc_id: true, strength: true, curated_by: true },
    }),
    kcMasteryForUser(params.userId, params.subject),
  ]);

  const objectivesByKc = new Map<string, string[]>();
  for (const objective of objectives) {
    if (!objective.kc_id) continue;
    const bucket = objectivesByKc.get(objective.kc_id);
    if (bucket) bucket.push(objective.id);
    else objectivesByKc.set(objective.kc_id, [objective.id]);
  }

  const masteryByKc = new Map(mastery.map((m) => [m.kc_id, m]));

  return {
    nodes: components.map((component) => {
      const belief = masteryByKc.get(component.id);
      return {
        id:          component.id,
        name:        component.name,
        subject:     component.subject,
        description: component.description,
        curated_by:  component.curated_by,
        // Null rather than the BKT prior: "never assessed" and "assessed, and we
        // think you are at the prior" are different claims, and collapsing them
        // would let the UI show a confident-looking 0.25 for a KC nobody has
        // touched.
        p_known:       belief ? belief.p_known : null,
        opportunities: belief?.opportunities ?? 0,
        objective_ids: objectivesByKc.get(component.id) ?? [],
      };
    }),
    edges,
  };
}

// ─── The diagnosis ────────────────────────────────────────────────────────────

export interface DiagnosedGap extends PrerequisiteGap {
  name: string;
  subject: string;
  /** Whether a human vouched for the KC itself. Null = LLM-proposed. */
  curated_by: string | null;
}

/**
 * Why this objective keeps going wrong — the payoff for the whole workstream.
 *
 * Walks `KCEdge` upstream from the objective's KC and returns the prerequisites
 * whose `p_known` is low, so a failure becomes *"Membrane Potentials isn't solid —
 * start there"* rather than a dead end.
 *
 * Returns `[]` — never throws — in every case where it cannot speak: the objective
 * has no KC, the graph has no edges into it, or no prerequisite has enough
 * evidence to accuse. That silence is deliberate. A confident-sounding diagnosis
 * built on a KC the student was never assessed on is worse than saying nothing,
 * and this is the same bar `utils/misconception-quality.ts` holds micro-lessons to.
 *
 * Zero AI calls.
 */
export async function diagnoseObjective(params: {
  objectiveId:   string;
  userId:        string;
  institutionId: string;
}): Promise<DiagnosedGap[]> {
  const objective = await prisma.learningObjective.findFirst({
    where:  { id: params.objectiveId, user_id: params.userId },
    select: { kc_id: true, subject: true },
  });
  if (!objective?.kc_id) return [];

  // The whole subject's KCs, so the walk can cross into prerequisites the student
  // has objectives for and ones they don't alike. Institution-scoped: two schools
  // can both teach "Human Physiology" with different graphs, and one must never
  // diagnose against the other's.
  const components = await prisma.knowledgeComponent.findMany({
    where:  { institution_id: params.institutionId, subject: objective.subject },
    select: { id: true, name: true, subject: true, curated_by: true },
  });
  const componentById = new Map(components.map((c) => [c.id, c]));

  const [edges, mastery] = await Promise.all([
    edgesAmong(components.map((c) => c.id)),
    kcMasteryForUser(params.userId, objective.subject),
  ]);

  const gaps = prerequisiteGaps({
    edges,
    kcId:       objective.kc_id,
    pKnownByKc: new Map(mastery.map((m) => [m.kc_id, m])),
    shakyBelow: BKT.SHAKY_BELOW,
    maxDepth:   MAX_UPSTREAM_DEPTH,
    limit:      MAX_GAPS_SHOWN,
  });

  return gaps.flatMap((gap) => {
    const component = componentById.get(gap.kc_id);
    return component
      ? [{ ...gap, name: component.name, subject: component.subject, curated_by: component.curated_by }]
      : [];
  });
}

// ─── Writing the graph ────────────────────────────────────────────────────────

/**
 * Upsert a KC by (institution, subject, name).
 *
 * The unique constraint is what makes the graph connect at all: without it every
 * proposal pass mints another "Membrane potentials" and no two objectives ever
 * share a node.
 */
async function upsertComponent(params: {
  institutionId: string;
  subject:       string;
  name:          string;
  description?:  string | null;
  curatedBy?:    string | null;
}) {
  return prisma.knowledgeComponent.upsert({
    where: {
      institution_id_subject_name: {
        institution_id: params.institutionId,
        subject:        params.subject,
        name:           params.name,
      },
    },
    // Never downgrade a curated KC back to unreviewed, and never let a later
    // proposal overwrite a human's description with the model's.
    update: params.curatedBy ? { curated_by: params.curatedBy } : {},
    create: {
      institution_id: params.institutionId,
      subject:        params.subject,
      name:           params.name,
      description:    params.description ?? null,
      curated_by:     params.curatedBy ?? null,
    },
  });
}

export async function createKnowledgeComponent(params: {
  institutionId: string;
  subject:       string;
  name:          string;
  description?:  string;
  /** The admin creating it — a human-created KC is curated by definition. */
  curatedBy:     string;
}) {
  return upsertComponent({ ...params, curatedBy: params.curatedBy });
}

/**
 * Add a prerequisite edge, refusing anything that would close a cycle.
 *
 * **The cycle check is the whole reason this is a service function and not a
 * `prisma.kCEdge.create` at the call site.** A cyclic prerequisite graph hangs a
 * naive upstream walk, and both an LLM proposing edges for mutually-reinforcing
 * topics and an admin curating by hand will produce one eventually. 409 CONFLICT
 * rather than a silent skip, because a curator who has just asserted something
 * false about their own syllabus should be told.
 */
export async function createEdge(params: {
  institutionId: string;
  fromKcId:      string;
  toKcId:        string;
  strength?:     number;
  curatedBy?:    string | null;
}) {
  const endpoints = await prisma.knowledgeComponent.findMany({
    where:  { id: { in: [params.fromKcId, params.toKcId] }, institution_id: params.institutionId },
    select: { id: true, subject: true },
  });
  if (endpoints.length !== 2) {
    throw new AppError(404, 'NOT_FOUND', 'One or both knowledge components were not found');
  }

  if (params.fromKcId === params.toKcId) {
    throw new AppError(409, 'CONFLICT', 'A knowledge component cannot be its own prerequisite');
  }

  // Validate against the whole subject's edges, not just this pair — a cycle is a
  // property of the graph, and checking anything narrower would miss every cycle
  // longer than two hops.
  const subjects = [...new Set(endpoints.map((e) => e.subject))];
  const components = await prisma.knowledgeComponent.findMany({
    where:  { institution_id: params.institutionId, subject: { in: subjects } },
    select: { id: true },
  });
  const existing = await edgesAmong(components.map((c) => c.id));

  if (wouldCreateCycle(existing, params.fromKcId, params.toKcId)) {
    throw new AppError(
      409,
      'CONFLICT',
      'That prerequisite would create a cycle — the two components already depend on each other the other way round',
    );
  }

  return prisma.kCEdge.upsert({
    where:  { from_kc_id_to_kc_id: { from_kc_id: params.fromKcId, to_kc_id: params.toKcId } },
    update: {
      ...(typeof params.strength === 'number' ? { strength: params.strength } : {}),
      ...(params.curatedBy ? { curated_by: params.curatedBy } : {}),
    },
    create: {
      from_kc_id: params.fromKcId,
      to_kc_id:   params.toKcId,
      strength:   params.strength ?? 0.5,
      curated_by: params.curatedBy ?? null,
    },
  });
}

export async function deleteEdge(edgeId: string, institutionId: string) {
  const edge = await prisma.kCEdge.findFirst({
    where:  { id: edgeId, from_kc: { institution_id: institutionId } },
    select: { id: true },
  });
  if (!edge) throw new AppError(404, 'NOT_FOUND', 'Edge not found');

  await prisma.kCEdge.delete({ where: { id: edgeId } });
  return { deleted: true as const };
}

/**
 * Mark a KC as reviewed by a human.
 *
 * `curated_by` is the difference between "an LLM guessed this is how the syllabus
 * hangs together" and "a person who teaches it says so", and the UI is expected to
 * treat those differently. Flipping it is therefore its own explicit action.
 */
export async function curateKnowledgeComponent(params: {
  kcId:          string;
  institutionId: string;
  curatedBy:     string;
  name?:         string;
  description?:  string;
}) {
  const component = await prisma.knowledgeComponent.findFirst({
    where:  { id: params.kcId, institution_id: params.institutionId },
    select: { id: true },
  });
  if (!component) throw new AppError(404, 'NOT_FOUND', 'Knowledge component not found');

  return prisma.knowledgeComponent.update({
    where: { id: params.kcId },
    data:  {
      curated_by: params.curatedBy,
      ...(params.name ? { name: params.name } : {}),
      ...(params.description !== undefined ? { description: params.description } : {}),
    },
  });
}

// ─── Mapping objectives onto the graph (the one budgeted path) ────────────────

export interface GraphProposalResult {
  /** How many of the student's objectives now carry a `kc_id`. */
  mapped:            number;
  components_created: number;
  edges_created:     number;
  /** Edges the model proposed that were refused for closing a cycle. */
  edges_rejected:    number;
  /** False when nothing could be proposed — see `reason`. Never an error. */
  available:         boolean;
  reason?:           string;
}

/**
 * Ask the model to name the knowledge component behind each objective and the
 * prerequisite links between them, then persist both.
 *
 * **ONE AI call for a whole subject**, charged through `consumeAIBudget` like every
 * other generation path, and it is idempotent in the way that matters: KCs upsert
 * on (institution, subject, name), so re-running maps newly-added objectives onto
 * the existing graph rather than duplicating it.
 *
 * **Degrades rather than throws.** Every failure mode — no objectives, budget
 * exhausted, a malformed response — comes back as `available: false` with a
 * reason. The prerequisite graph is an enhancement to a learner model that worked
 * without it, so nothing here is allowed to break a student's session. Same
 * contract as `gradeAnswers` and `getRemediation`.
 *
 * Cycles the model proposes are refused individually and counted, not fatal: an
 * LLM asked for prerequisites among mutually-reinforcing topics WILL suggest both
 * directions, and losing the rest of a good graph over it would be silly.
 */
export async function proposeGraphForSubject(params: {
  userId:        string;
  institutionId: string;
  subject:       string;
}): Promise<GraphProposalResult> {
  const empty = (reason: string): GraphProposalResult => ({
    mapped: 0, components_created: 0, edges_created: 0, edges_rejected: 0,
    available: false, reason,
  });

  const objectives = await prisma.learningObjective.findMany({
    where:  { user_id: params.userId, subject: params.subject },
    select: { id: true, statement: true, kc_id: true },
    orderBy: { created_at: 'asc' },
    // A cap, because the prompt has to carry every statement and a student with a
    // whole textbook's objectives would blow the context window.
    take:   60,
  });
  if (objectives.length === 0) return empty('no_objectives');

  const proposal = await aiService
    .proposeKnowledgeComponents({
      subject:       params.subject,
      objectives:    objectives.map((o) => ({ id: o.id, statement: o.statement })),
      userId:        params.userId,
      institutionId: params.institutionId,
    })
    .catch((error: unknown) => {
      const code = error instanceof AppError ? error.code : 'generation_failed';
      logger.warn({ err: error, subject: params.subject }, 'KC graph proposal failed');
      return { failed: code === 'AI_LIMIT_REACHED' ? 'budget_exhausted' : 'generation_failed' } as const;
    });

  if ('failed' in proposal) return empty(proposal.failed);
  if (proposal.components.length === 0) return empty('no_components_proposed');

  const knownObjectiveIds = new Set(objectives.map((o) => o.id));
  const beforeCount = await prisma.knowledgeComponent.count({
    where: { institution_id: params.institutionId, subject: params.subject },
  });

  // Upsert every proposed KC first, so edge resolution has ids to work with.
  const componentByName = new Map<string, string>();
  for (const component of proposal.components) {
    const row = await upsertComponent({
      institutionId: params.institutionId,
      subject:       params.subject,
      name:          component.name,
      description:   component.description,
      // NULL — nobody has reviewed this. The distinction is the point.
      curatedBy:     null,
    });
    componentByName.set(component.name.toLowerCase(), row.id);
  }

  let mapped = 0;
  for (const component of proposal.components) {
    const kcId = componentByName.get(component.name.toLowerCase());
    if (!kcId) continue;

    // Only this user's own objectives, and only ones we actually sent — the model
    // echoing back an id it invented must never write to another student's row.
    const ids = component.objective_ids.filter((id) => knownObjectiveIds.has(id));
    if (ids.length === 0) continue;

    const result = await prisma.learningObjective.updateMany({
      where: { id: { in: ids }, user_id: params.userId },
      data:  { kc_id: kcId },
    });
    mapped += result.count;
  }

  let edgesCreated = 0;
  let edgesRejected = 0;
  for (const edge of proposal.edges) {
    const fromId = componentByName.get(edge.from.toLowerCase());
    const toId = componentByName.get(edge.to.toLowerCase());
    if (!fromId || !toId || fromId === toId) continue;

    try {
      await createEdge({
        institutionId: params.institutionId,
        fromKcId:      fromId,
        toKcId:        toId,
        strength:      edge.strength,
        curatedBy:     null,
      });
      edgesCreated += 1;
    } catch (error) {
      if (error instanceof AppError && error.code === 'CONFLICT') {
        edgesRejected += 1;
        continue;
      }
      throw error;
    }
  }

  const afterCount = await prisma.knowledgeComponent.count({
    where: { institution_id: params.institutionId, subject: params.subject },
  });

  logger.info(
    { subject: params.subject, mapped, edgesCreated, edgesRejected },
    'Knowledge-component graph proposed',
  );

  return {
    available:          true,
    mapped,
    components_created: afterCount - beforeCount,
    edges_created:      edgesCreated,
    edges_rejected:     edgesRejected,
  };
}

export const kcService = {
  listKnowledgeComponents,
  kcMasteryForUser,
  getGraphForUser,
  diagnoseObjective,
  createKnowledgeComponent,
  createEdge,
  deleteEdge,
  curateKnowledgeComponent,
  proposeGraphForSubject,
};
