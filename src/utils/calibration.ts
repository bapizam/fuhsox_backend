/**
 * Readiness calibration — checking the estimate against reality (reformation
 * Phase 4, Workstream C · **the ungated read-only slice**).
 *
 * `exam_readiness` is the product's strongest claim and has never been checked
 * against a single real grade. Phase 2 started collecting `ExamOutcome` rows with
 * `predicted_readiness` snapshotted at report time; nothing has read them since,
 * by design.
 *
 * **This file reads them and, below a real sample, refuses to conclude anything.**
 * That refusal is the feature. With a handful of paired observations any "bias
 * correction" is noise wearing the costume of rigour, which is the precise failure
 * the whole reformation was written to remove — so `sufficient: false` comes back
 * with the count and the threshold, and every caller shows the student nothing.
 *
 * Two further constraints inherited from the roadmap and NOT re-litigated here:
 *
 * - **Nothing is silently corrected.** Even at n ≥ 30 this returns bias as
 *   *context on* the estimate ("our estimates have run ~12 points optimistic"),
 *   never as an adjustment applied invisibly to the number. Quietly moving
 *   readiness would break the honesty property Phase 2 was built for.
 * - **The readiness formula and decay model must not change while collecting.**
 *   Phase 3.5 deliberately moved readiness BEFORE any outcome existed so the
 *   dataset has one definition. Changing it mid-collection splits the dataset and
 *   silently invalidates everything below.
 *
 * Pure: no Prisma, no clock. The service hands it rows; it does arithmetic.
 */

/**
 * Minimum paired observations before any calibration figure is published.
 *
 * 30 is the conventional floor where a sample mean starts behaving, and it is
 * deliberately a hard gate rather than a confidence caveat: a number shown with a
 * hedge is still a number students will read and act on.
 */
export const MIN_CALIBRATION_SAMPLE = 30;

/** Width of each prediction bucket on the calibration curve, in readiness points. */
export const CALIBRATION_BUCKET_SIZE = 20;

export interface ReadinessObservation {
  /** What the model predicted, 0..100, snapshotted when the grade was reported. */
  predicted: number;
  /** What the student actually scored, 0..100, as they reported it. */
  actual: number;
}

export interface CalibrationBucket {
  /** Inclusive lower bound of the prediction bucket, 0..100. */
  range_start: number;
  /** Exclusive upper bound — except the top bucket, which includes 100. */
  range_end: number;
  observations: number;
  mean_predicted: number;
  mean_actual: number;
}

export type ReadinessCalibration =
  | {
      sufficient: false;
      observations: number;
      minimum_sample: number;
    }
  | {
      sufficient: true;
      observations: number;
      minimum_sample: number;
      /**
       * `mean(predicted) − mean(actual)`. **Positive = the estimate runs
       * optimistic** (we predicted more readiness than the grades bore out), which
       * is both the likelier direction and the more damaging one for a student
       * deciding whether to keep revising.
       */
      bias: number;
      mean_predicted: number;
      mean_actual: number;
      /** Mean |predicted − actual| — spread, which bias alone hides. A bias of 0 built
       *  from +40 and −40 is not a calibrated model. */
      mean_absolute_error: number;
      /** Bucketed curve. Buckets with no observations are omitted, not zero-filled. */
      buckets: CalibrationBucket[];
    };

function mean(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

const round1 = (value: number) => Math.round(value * 10) / 10;

/**
 * Compare predicted readiness against reported grades.
 *
 * Returns `sufficient: false` — carrying the count so the UI can say "12 of 30
 * results collected" rather than going blank — until there are enough pairs to
 * mean anything. Above the threshold it reports bias, spread and a curve, and
 * still applies no correction to anything.
 */
export function readinessCalibration(
  observations: ReadinessObservation[],
  minimumSample: number = MIN_CALIBRATION_SAMPLE,
): ReadinessCalibration {
  const usable = observations.filter(
    (o) => Number.isFinite(o.predicted) && Number.isFinite(o.actual),
  );

  if (usable.length < minimumSample) {
    return {
      sufficient: false,
      observations: usable.length,
      minimum_sample: minimumSample,
    };
  }

  const predicted = usable.map((o) => o.predicted);
  const actual = usable.map((o) => o.actual);
  const meanPredicted = mean(predicted);
  const meanActual = mean(actual);

  const buckets = new Map<number, ReadinessObservation[]>();
  for (const observation of usable) {
    // Clamped so a 100 lands in the top bucket rather than opening an empty one of
    // its own, and so an out-of-range value can never mint a phantom bucket.
    const clamped = Math.min(99.999, Math.max(0, observation.predicted));
    const start = Math.floor(clamped / CALIBRATION_BUCKET_SIZE) * CALIBRATION_BUCKET_SIZE;
    const bucket = buckets.get(start);
    if (bucket) bucket.push(observation);
    else buckets.set(start, [observation]);
  }

  return {
    sufficient: true,
    observations: usable.length,
    minimum_sample: minimumSample,
    bias: round1(meanPredicted - meanActual),
    mean_predicted: round1(meanPredicted),
    mean_actual: round1(meanActual),
    mean_absolute_error: round1(
      mean(usable.map((o) => Math.abs(o.predicted - o.actual))),
    ),
    buckets: [...buckets.entries()]
      .sort(([a], [b]) => a - b)
      .map(([start, rows]) => ({
        range_start: start,
        range_end: start + CALIBRATION_BUCKET_SIZE,
        observations: rows.length,
        mean_predicted: round1(mean(rows.map((r) => r.predicted))),
        mean_actual: round1(mean(rows.map((r) => r.actual))),
      })),
  };
}
