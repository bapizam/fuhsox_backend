import prisma from '@config/database';
import { AppError } from '@typings/models';
import logger from '@lib/logger';

// ─── List Students ─────────────────────────────────────────────────────────────

export async function listStudents(
  institutionId: string,
  filter: {
    search?:     string;
    faculty?:    string;
    department?: string;
    risk_flag?:  boolean;
    page:        number;
    limit:       number;
    sort:        'xp_desc' | 'xp_asc' | 'active_desc' | 'recent';
  },
) {
  const skip = (filter.page - 1) * filter.limit;

  const where: Record<string, unknown> = {
    institution_id: institutionId,
    role:           'student',
    ...(filter.risk_flag !== undefined && { risk_flag: filter.risk_flag }),
    ...(filter.faculty               && { faculty:    filter.faculty }),
    ...(filter.department            && { department: filter.department }),
    ...(filter.search                && {
      OR: [
        { full_name: { contains: filter.search, mode: 'insensitive' } },
        { email:     { contains: filter.search, mode: 'insensitive' } },
        { faculty:   { contains: filter.search, mode: 'insensitive' } },
      ],
    }),
  };

  const orderBy: Record<string, unknown> =
    filter.sort === 'xp_desc'     ? { xp_points:     'desc' }
    : filter.sort === 'xp_asc'   ? { xp_points:     'asc'  }
    : filter.sort === 'active_desc' ? { last_active_at: 'desc' }
    : { created_at: 'desc' }; // recent

  const [students, total] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy,
      skip,
      take:    filter.limit,
      select: {
        id:             true,
        email:          true,
        full_name:      true,
        faculty:        true,
        department:     true,
        avatar_url:     true,
        xp_points:      true,
        streak_count:   true,
        last_active_at: true,
        risk_flag:      true,
        risk_reason:    true,
        created_at:     true,
        _count: { select: { badges: true, sessions: true } },
      },
    }),
    prisma.user.count({ where }),
  ]);

  return {
    students: students.map((s: Record<string, unknown> & { _count: { badges: number; sessions: number } }) => ({
      ...s,
      badge_count:   s._count.badges,
      session_count: s._count.sessions,
    })),
    pagination: { total, page: filter.page, limit: filter.limit, totalPages: Math.ceil(total / filter.limit), hasMore: filter.page * filter.limit < total },
  };
}

// ─── Get Student Detail ────────────────────────────────────────────────────────

export async function getStudentDetail(studentId: string, institutionId: string) {
  const student = await prisma.user.findFirst({
    where: { id: studentId, institution_id: institutionId, role: 'student' },
    include: {
      badges:           { include: { badge: true }, orderBy: { awarded_at: 'desc' } },
      notification_pref: true,
      _count: {
        select: {
          sessions:            true,
          bookmarks:           true,
          connections_sent:    true,
          connections_received: true,
        },
      },
    },
  });

  if (!student) throw new AppError(404, 'NOT_FOUND', 'Student not found');

  // Quiz stats
  const sessionStats = await prisma.quizSession.aggregate({
    where: { user_id: studentId, completed_at: { not: null } },
    _avg:   { score_percent: true },
    _count: { id: true },
    _sum:   { correct_count: true, total_questions: true },
  });

  // Recent sessions
  const recentSessions = await prisma.quizSession.findMany({
    where:   { user_id: studentId },
    orderBy: { started_at: 'desc' },
    take:    10,
    select: {
      id:            true,
      mode:          true,
      score_percent: true,
      total_questions: true,
      completed_at:  true,
      started_at:    true,
    },
  });

  const { password_hash: _, google_id: __, ...safeStudent } = student;

  return {
    ...safeStudent,
    stats: {
      total_sessions:   sessionStats._count.id,
      average_score:    sessionStats._avg.score_percent ?? 0,
      total_correct:    sessionStats._sum.correct_count ?? 0,
      total_answered:   sessionStats._sum.total_questions ?? 0,
      accuracy_rate:    sessionStats._sum.total_questions
        ? Math.round(((sessionStats._sum.correct_count ?? 0) / sessionStats._sum.total_questions) * 10000) / 100
        : 0,
    },
    recent_sessions: recentSessions,
    connection_count: student._count.connections_sent + student._count.connections_received,
  };
}

// ─── Flag / Unflag Student ────────────────────────────────────────────────────

export async function setRiskFlag(
  studentId:     string,
  institutionId: string,
  flagged:       boolean,
  reason?:       string,
) {
  const student = await prisma.user.findFirst({
    where: { id: studentId, institution_id: institutionId, role: 'student' },
  });

  if (!student) throw new AppError(404, 'NOT_FOUND', 'Student not found');

  await prisma.user.update({
    where: { id: studentId },
    data: {
      risk_flag:   flagged,
      risk_reason: flagged ? (reason ?? 'Manually flagged by admin') : null,
    },
  });

  logger.info({ studentId, flagged, reason }, 'Risk flag updated by admin');

  return { flagged, reason: flagged ? reason : null };
}

// ─── Suspend / Unsuspend Student ──────────────────────────────────────────────

export async function setStudentRole(
  studentId:     string,
  institutionId: string,
  role:          'student' | 'admin',
) {
  const student = await prisma.user.findFirst({
    where: { id: studentId, institution_id: institutionId },
  });

  if (!student) throw new AppError(404, 'NOT_FOUND', 'User not found');
  if (student.role === 'superadmin') {
    throw new AppError(403, 'FORBIDDEN', 'Cannot modify a superadmin\'s role');
  }

  return prisma.user.update({
    where: { id: studentId },
    data:  { role },
  });
}

// ─── Get At-Risk Students ─────────────────────────────────────────────────────

export async function getAtRiskStudents(institutionId: string, limit: number = 50) {
  return prisma.user.findMany({
    where: { institution_id: institutionId, role: 'student', risk_flag: true },
    orderBy: { last_active_at: 'asc' }, // Most inactive first
    take:    limit,
    select: {
      id:             true,
      full_name:      true,
      email:          true,
      faculty:        true,
      risk_reason:    true,
      last_active_at: true,
      xp_points:      true,
    },
  });
}

export const studentService = {
  listStudents,
  getStudentDetail,
  setRiskFlag,
  setStudentRole,
  getAtRiskStudents,
};
