import { Schema, model, Document, Types } from 'mongoose';

export interface IPost extends Document {
  _id: Types.ObjectId;
  institution_id: string;
  author_id: string;
  type: 'post' | 'achievement' | 'trending' | 'news';
  content?: string;
  topic_tag?: string;
  likes: string[];
  comments_count: number;
  is_deleted: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const PostSchema = new Schema<IPost>(
  {
    institution_id: { type: String, required: true, index: true },
    author_id:      { type: String, required: true, index: true },
    type:           { type: String, enum: ['post', 'achievement', 'trending', 'news'], default: 'post' },
    content:        { type: String, maxlength: 500 },
    topic_tag:      { type: String, index: true },
    likes:          [{ type: String }],
    comments_count: { type: Number, default: 0, min: 0 },
    is_deleted:     { type: Boolean, default: false },
  },
  { timestamps: true },
);

PostSchema.index({ institution_id: 1, createdAt: -1 });
PostSchema.index({ author_id: 1, createdAt: -1 });
PostSchema.index({ topic_tag: 1, createdAt: -1 });
PostSchema.index({ institution_id: 1, is_deleted: 1, createdAt: -1 });

export const Post = model<IPost>('Post', PostSchema);


export interface IComment extends Document {
  _id: Types.ObjectId;
  post_id: Types.ObjectId;
  author_id: string;
  parent_comment_id: Types.ObjectId | null;
  body: string;
  likes: string[];
  is_deleted: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const CommentSchema = new Schema<IComment>(
  {
    post_id:           { type: Schema.Types.ObjectId, ref: 'Post', required: true, index: true },
    author_id:         { type: String, required: true },
    parent_comment_id: { type: Schema.Types.ObjectId, ref: 'Comment', default: null },
    body:              { type: String, required: true, maxlength: 1000 },
    likes:             [{ type: String }],
    is_deleted:        { type: Boolean, default: false },
  },
  { timestamps: true },
);

CommentSchema.index({ post_id: 1, createdAt: 1 });
CommentSchema.index({ parent_comment_id: 1 });

export const Comment = model<IComment>('Comment', CommentSchema);


export interface IMessage extends Document {
  _id: Types.ObjectId;
  institution_id: string;
  sender_id: string;
  receiver_id: string;
  body: string;
  is_deleted: boolean;
  read_at: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const MessageSchema = new Schema<IMessage>(
  {
    institution_id: { type: String, required: true, index: true },
    sender_id:      { type: String, required: true },
    receiver_id:    { type: String, required: true },
    body:           { type: String, required: true, maxlength: 2000 },
    is_deleted:     { type: Boolean, default: false },
    read_at:        { type: Date, default: null },
  },
  { timestamps: true },
);

MessageSchema.index({ sender_id: 1, receiver_id: 1, createdAt: -1 });
MessageSchema.index({ receiver_id: 1, read_at: 1 });

export const Message = model<IMessage>('Message', MessageSchema);


// Study-room chat (M5). Deliberately separate from the DM `Message` schema —
// that one is DM-shaped (required receiver_id, sender/receiver indexes) and is
// NOT overloaded for rooms. `room_id` references the PostgreSQL study_rooms uuid.
export interface IRoomMessage extends Document {
  _id: Types.ObjectId;
  room_id: string;
  institution_id: string;
  sender_id: string;
  body: string;
  is_deleted: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const RoomMessageSchema = new Schema<IRoomMessage>(
  {
    room_id:        { type: String, required: true, index: true },
    institution_id: { type: String, required: true, index: true },
    sender_id:      { type: String, required: true },
    body:           { type: String, required: true, maxlength: 2000 },
    is_deleted:     { type: Boolean, default: false },
  },
  { timestamps: true },
);

RoomMessageSchema.index({ room_id: 1, createdAt: -1 });

export const RoomMessage = model<IRoomMessage>('RoomMessage', RoomMessageSchema);


export interface IAIFeedback extends Document {
  _id: Types.ObjectId;
  user_id: string;
  institution_id: string;
  session_id?: string;
  question_id?: string;
  question_text?: string;
  course_code?: string;
  topic?: string;
  chosen_answer?: string;
  correct_answer?: string;
  /**
   * The option list as it was shown, plus both answers resolved to their TEXT.
   *
   * `chosen_answer` / `correct_answer` hold bare MCQ letters, which makes a
   * feedback record unreadable on its own — "you chose A" means nothing months
   * later, and the option order is shuffled per question anyway. Stored at write
   * time because the source question can be edited or deleted afterwards; the
   * history screen renders these directly. Absent on legacy rows and on
   * free-response items (where `chosen_answer` is already the text).
   */
  options?: Array<{ key: string; text: string; misconception?: string }>;
  chosen_answer_text?: string;
  correct_answer_text?: string;
  /** The misconception tagged on the distractor they picked, when there was one. */
  misconception?: string;
  ai_explanation?: string;
  model_used?: string;
  tokens_used?: number;
  createdAt: Date;
  updatedAt: Date;
}

const AIFeedbackSchema = new Schema<IAIFeedback>(
  {
    user_id:             { type: String, required: true, index: true },
    institution_id:      { type: String, required: true },
    session_id:          { type: String },
    question_id:         { type: String },
    question_text:       { type: String },
    course_code:         { type: String },
    topic:               { type: String },
    chosen_answer:       { type: String },
    correct_answer:      { type: String },
    options:             [{ key: String, text: String, misconception: String }],
    chosen_answer_text:  { type: String },
    correct_answer_text: { type: String },
    misconception:       { type: String },
    ai_explanation:      { type: String },
    model_used:          { type: String },
    tokens_used:         { type: Number },
  },
  { timestamps: true },
);

AIFeedbackSchema.index({ user_id: 1, createdAt: -1 });
AIFeedbackSchema.index({ session_id: 1 });

export const AIFeedback = model<IAIFeedback>('AIFeedback', AIFeedbackSchema);

export interface IAIQuestion extends Document {
  _id: Types.ObjectId;
  user_id: string;
  institution_id: string;
  topic: string;
  /**
   * `numeric` is Phase-2 additive: a free-response item whose answer is a value,
   * graded with unit/formatting tolerance rather than string equality. Everything
   * that is not `mcq` is free-response and needs the AI grader.
   */
  question_type: 'mcq' | 'short_answer' | 'fill_blank' | 'numeric';
  question_text: string;
  /**
   * `misconception` (reformation Phase 1) tags a DISTRACTOR with the specific
   * error it represents, so choosing it diagnoses a real concept — not a Bloom
   * level. Absent on the correct option and on legacy rows.
   */
  options?: Array<{ key: string; text: string; misconception?: string }>;
  correct_answer: string;
  explanation?: string;
  difficulty: 'easy' | 'medium' | 'hard';
  quality_flag: 'good' | 'flagged';
  flag_reason?: string;
  /**
   * Set only for adaptive mastery-check questions (M7 item 4). Tags this doc as
   * part of one LearningObjective's cached assessment pool, so repeat attempts
   * draw from it instead of paying another generation call.
   */
  objective_id?: string;
  /**
   * The `SyllabusNode` this item was written from, when it is chapter-scoped.
   * Node-addressed mastery checks use it to find the pool for a chapter without
   * going through the objective.
   */
  node_id?: string;
  /** Bloom level this question targets — drives the per-level partial credit. */
  bloom_level?: string;
  /** Source page in the student's material this was grounded on (reformation P1). */
  source_page?: number;
  /**
   * What a correct free-response answer must demonstrate — the criteria the AI
   * grader judges against (reformation Phase 2). Only set on non-MCQ items;
   * `correct_answer` holds the model answer itself.
   */
  rubric?: string;
  /**
   * Empirical difficulty counters (reformation Phase 2). `difficulty` above is the
   * LLM's SELF-LABEL; these are what actually happened. Incremented from the
   * grading path, so `correct_count / seen_count` is a real p-value once
   * `seen_count` is meaningful — see `utils/pool.ts`.
   */
  seen_count?: number;
  correct_count?: number;
  createdAt: Date;
  updatedAt: Date;
}

const AIQuestionSchema = new Schema<IAIQuestion>(
  {
    user_id:        { type: String, required: true, index: true },
    institution_id: { type: String, required: true },
    topic:          { type: String, required: true },
    question_type:  { type: String, enum: ['mcq', 'short_answer', 'fill_blank', 'numeric'], required: true },
    question_text:  { type: String, required: true },
    options:        [{ key: String, text: String, misconception: String }],
    correct_answer: { type: String, required: true },
    explanation:    { type: String },
    difficulty:     { type: String, enum: ['easy', 'medium', 'hard'], required: true },
    quality_flag:   { type: String, enum: ['good', 'flagged'], default: 'good' },
    flag_reason:    { type: String },
    objective_id:   { type: String, index: true },
    node_id:        { type: String, index: true },
    bloom_level:    { type: String },
    source_page:    { type: Number },
    rubric:         { type: String },
    seen_count:     { type: Number, default: 0, min: 0 },
    correct_count:  { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

AIQuestionSchema.index({ user_id: 1, createdAt: -1 });
AIQuestionSchema.index({ institution_id: 1, topic: 1 });

export const AIQuestion = model<IAIQuestion>('AIQuestion', AIQuestionSchema);

// ─── Resource Chunks (RAG grounding — reformation Phase 1) ──────────────────────

export interface IResourceChunk extends Document {
  _id: Types.ObjectId;
  /** LearningResource.id (Postgres uuid) this chunk was extracted from. */
  resource_id: string;
  user_id: string;
  /** Position in the document, for stable ordering + citation. */
  ordinal: number;
  text: string;
  /** Best-effort source page, when the extractor can attribute one. */
  page?: number;
  /** Gemini text-embedding-004 vector (768-dim). Retrieval is brute-force cosine
   *  over a single resource's chunks in Node — no vector DB at this scale. */
  embedding: number[];
  createdAt: Date;
  updatedAt: Date;
}

const ResourceChunkSchema = new Schema<IResourceChunk>(
  {
    resource_id: { type: String, required: true, index: true },
    user_id:     { type: String, required: true },
    ordinal:     { type: Number, required: true },
    text:        { type: String, required: true },
    page:        { type: Number },
    embedding:   { type: [Number], required: true },
  },
  { timestamps: true },
);

export const ResourceChunk = model<IResourceChunk>('ResourceChunk', ResourceChunkSchema);


// ─── Micro-lessons (test-explain-retest — reformation Phase 3C) ────────────────

export interface IMicroLessonSection {
  /** The specific misconception this section addresses. */
  misconception: string;
  /** Why the student's belief is wrong, addressed to them. */
  correction: string;
  /** A concrete worked example drawn from the student's own material. */
  worked_example?: string;
  tip?: string;
}

export interface IMicroLesson extends Document {
  _id: Types.ObjectId;
  user_id: string;
  objective_id: string;
  /**
   * Order-independent key over the misconception set (`utils/misconception-quality`
   * `misconceptionSetKey`). This is what makes a re-failed check reuse the lesson
   * the student was already shown instead of paying to regenerate it.
   */
  misconception_key: string;
  misconceptions: string[];
  sections: IMicroLessonSection[];
  /** Pages from the student's material the lesson was grounded in. */
  source_pages: number[];
  createdAt: Date;
  updatedAt: Date;
}

const MicroLessonSchema = new Schema<IMicroLesson>(
  {
    user_id:           { type: String, required: true, index: true },
    objective_id:      { type: String, required: true, index: true },
    misconception_key: { type: String, required: true },
    misconceptions:    [String],
    sections: [
      {
        misconception:  String,
        correction:     String,
        worked_example: String,
        tip:            String,
      },
    ],
    source_pages: [Number],
  },
  { timestamps: true },
);

// The cache lookup: this objective, this exact set of misconceptions, this user.
MicroLessonSchema.index({ objective_id: 1, misconception_key: 1, user_id: 1 });

export const MicroLesson = model<IMicroLesson>('MicroLesson', MicroLessonSchema);

export interface IStudyPlanTask {
  subject: string;
  topic: string;
  duration_mins: number;
  activity_type: string;
  recommended_question_set?: string;
  completed: boolean;
}

export interface IStudyPlanDay {
  day: string;
  date: string;
  tasks: IStudyPlanTask[];
}

export interface IStudyPlanWeek {
  week_number: number;
  days: IStudyPlanDay[];
}

export interface IStudyPlan extends Document {
  _id: Types.ObjectId;
  user_id: string;
  institution_id: string;
  subjects: string[];
  exam_date?: Date;
  daily_hours?: number;
  weeks: IStudyPlanWeek[];
  milestones: string[];
  createdAt: Date;
  updatedAt: Date;
}

/**
 * An immutable snapshot of one study-plan generation.
 *
 * `StudyPlan` is upserted per user (`user_id` is `unique`), so regenerating
 * overwrites the previous plan and its history was simply lost — the student had
 * no way to see what the planner told them last week, or that it had changed. A
 * separate append-only collection keeps the live plan's single-document read path
 * exactly as it was while making the history available.
 *
 * Snapshots are never edited: task completion is written to `StudyPlan` only, so a
 * version records what the AI produced, not what the student then did with it.
 */
export interface IStudyPlanVersion extends Document {
  _id: Types.ObjectId;
  user_id: string;
  institution_id: string;
  subjects: string[];
  exam_date?: Date;
  daily_hours?: number;
  weeks: IStudyPlanWeek[];
  milestones: string[];
  /** Denormalised so the history list needs no per-row aggregation. */
  total_tasks: number;
  total_weeks: number;
  createdAt: Date;
  updatedAt: Date;
}

const StudyPlanSchema = new Schema<IStudyPlan>(
  {
    user_id:        { type: String, required: true, unique: true },
    institution_id: { type: String, required: true },
    subjects:       [String],
    exam_date:      { type: Date },
    daily_hours:    { type: Number },
    weeks: [
      {
        week_number: Number,
        days: [
          {
            day:  String,
            date: String,
            tasks: [
              {
                subject:                  String,
                topic:                    String,
                duration_mins:            Number,
                activity_type:            String,
                recommended_question_set: String,
                completed:                { type: Boolean, default: false },
              },
            ],
          },
        ],
      },
    ],
    milestones: [String],
  },
  { timestamps: true },
);

export const StudyPlan = model<IStudyPlan>('StudyPlan', StudyPlanSchema);

/**
 * Append-only plan snapshots. Shares `StudyPlanSchema`'s nested shape but WITHOUT
 * the `unique` constraint on `user_id`, which is the whole point.
 */
const StudyPlanVersionSchema = new Schema<IStudyPlanVersion>(
  {
    user_id:        { type: String, required: true, index: true },
    institution_id: { type: String, required: true },
    subjects:       [String],
    exam_date:      { type: Date },
    daily_hours:    { type: Number },
    weeks: [
      {
        week_number: Number,
        days: [
          {
            day:  String,
            date: String,
            tasks: [
              {
                subject:                  String,
                topic:                    String,
                duration_mins:            Number,
                activity_type:            String,
                recommended_question_set: String,
                completed:                { type: Boolean, default: false },
              },
            ],
          },
        ],
      },
    ],
    milestones:  [String],
    total_tasks: { type: Number, default: 0 },
    total_weeks: { type: Number, default: 0 },
  },
  { timestamps: true },
);

StudyPlanVersionSchema.index({ user_id: 1, createdAt: -1 });

export const StudyPlanVersion = model<IStudyPlanVersion>(
  'StudyPlanVersion',
  StudyPlanVersionSchema,
);

// ─── Per-resource study plan (single-subject plan, Phase 2) ────────────────────

/**
 * One task in a resource-anchored plan.
 *
 * The difference that matters versus `IStudyPlanTask` is `node_id`: a task points
 * at a REAL `SyllabusNode`, not a free-text topic string. The old plan's tasks
 * were paraphrases the model invented, so verifying one had to string-match an
 * objective and, on a miss, mint an orphan with no `resource_id` — which meant
 * the questions that then set the student's mastery were ungrounded. A node id
 * makes that whole failure mode impossible.
 */
export interface ISubjectPlanTask {
  node_id: string;
  chapter_title: string;
  /**
   * The pages THIS task covers — the chapter's own range when it is read in one
   * sitting, and one slice of it when the planner split it. Computed from the
   * node at generation time (never from the model), so rendering needs no join
   * and a hallucinated page number cannot reach a student.
   */
  page_start?: number;
  page_end?: number;
  /** Which sitting of the chapter this is, and how many there are. */
  part: number;
  parts: number;
  activity: 'read' | 'practice' | 'verify';
  duration_mins: number;
  /** What to actually do — the model's own words, one sentence. */
  detail?: string;
  /**
   * When the student said they had done the reading. **Self-reported, and
   * deliberately not the same thing as `completed`.**
   *
   * `completed` is evidence — it becomes true only by passing the mastery check,
   * which is what replaced the plan's old "I've studied" checkbox. Reintroducing
   * a tick that claimed mastery would undo that. This claims something much
   * smaller and entirely checkable by the student themselves: I have read these
   * pages. It is what unlocks the paired verify.
   */
  read_at?: Date;
  completed: boolean;
}

export interface ISubjectPlanDay {
  day: string;
  date: string;
  tasks: ISubjectPlanTask[];
}

export interface ISubjectPlanWeek {
  week_number: number;
  days: ISubjectPlanDay[];
}

export interface ISubjectStudyPlan extends Document {
  _id: Types.ObjectId;
  user_id: string;
  institution_id: string;
  /** The LearningResource this plan is anchored to. */
  resource_id: string;
  /** Denormalised for display; the resource remains the source of truth. */
  subject: string;
  exam_date?: Date;
  daily_hours?: number;
  /**
   * Weekdays the student agreed to study, `0` = Sunday. Stored so the plan can
   * say which days it was built for, and so rebuilding it starts from the same
   * answer rather than asking again.
   */
  study_days: number[];
  weeks: ISubjectPlanWeek[];
  milestones: string[];
  createdAt: Date;
  updatedAt: Date;
}

const subjectPlanWeeks = [
  {
    week_number: Number,
    days: [
      {
        day:  String,
        date: String,
        tasks: [
          {
            node_id:       String,
            chapter_title: String,
            page_start:    Number,
            page_end:      Number,
            part:          { type: Number, default: 1 },
            parts:         { type: Number, default: 1 },
            activity:      { type: String, enum: ['read', 'practice', 'verify'] },
            duration_mins: Number,
            detail:        String,
            read_at:       { type: Date, default: null },
            completed:     { type: Boolean, default: false },
          },
        ],
      },
    ],
  },
];

const SubjectStudyPlanSchema = new Schema<ISubjectStudyPlan>(
  {
    user_id:        { type: String, required: true },
    institution_id: { type: String, required: true },
    resource_id:    { type: String, required: true },
    subject:        { type: String, required: true },
    exam_date:      { type: Date },
    daily_hours:    { type: Number },
    study_days:     { type: [Number], default: [] },
    weeks:          subjectPlanWeeks,
    milestones:     [String],
  },
  { timestamps: true },
);

// One live plan PER RESOURCE, not per user — that is what makes a student able to
// hold a plan for each subject at once, which the single per-user `StudyPlan`
// could never do.
SubjectStudyPlanSchema.index({ user_id: 1, resource_id: 1 }, { unique: true });

export const SubjectStudyPlan = model<ISubjectStudyPlan>(
  'SubjectStudyPlan',
  SubjectStudyPlanSchema,
);

export interface ISubjectStudyPlanVersion extends Omit<ISubjectStudyPlan, '_id'> {
  _id: Types.ObjectId;
  total_tasks: number;
  total_weeks: number;
}

/** Append-only snapshots, same shape without the uniqueness constraint. */
const SubjectStudyPlanVersionSchema = new Schema<ISubjectStudyPlanVersion>(
  {
    user_id:        { type: String, required: true, index: true },
    institution_id: { type: String, required: true },
    resource_id:    { type: String, required: true },
    subject:        { type: String, required: true },
    exam_date:      { type: Date },
    daily_hours:    { type: Number },
    study_days:     { type: [Number], default: [] },
    weeks:          subjectPlanWeeks,
    milestones:     [String],
    total_tasks:    { type: Number, default: 0 },
    total_weeks:    { type: Number, default: 0 },
  },
  { timestamps: true },
);

SubjectStudyPlanVersionSchema.index({ user_id: 1, createdAt: -1 });

export const SubjectStudyPlanVersion = model<ISubjectStudyPlanVersion>(
  'SubjectStudyPlanVersion',
  SubjectStudyPlanVersionSchema,
);