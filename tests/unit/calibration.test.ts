import {
  CALIBRATION_BUCKET_SIZE,
  MIN_CALIBRATION_SAMPLE,
  readinessCalibration,
  type ReadinessObservation,
} from '@utils/calibration';

/** n paired observations with a fixed optimistic bias. */
const biased = (n: number, bias: number, base = 60): ReadinessObservation[] =>
  Array.from({ length: n }, () => ({ predicted: base + bias, actual: base }));

describe('readinessCalibration — the refusal to fit', () => {
  it('refuses on an empty dataset', () => {
    const result = readinessCalibration([]);
    expect(result.sufficient).toBe(false);
    expect(result.observations).toBe(0);
  });

  it('refuses one short of the threshold', () => {
    const result = readinessCalibration(biased(MIN_CALIBRATION_SAMPLE - 1, 12));
    expect(result.sufficient).toBe(false);
    expect(result.observations).toBe(MIN_CALIBRATION_SAMPLE - 1);
  });

  it('reports the running count and the target, so the UI can say "12 of 30"', () => {
    const result = readinessCalibration(biased(12, 5));
    expect(result).toEqual({
      sufficient:     false,
      observations:   12,
      minimum_sample: MIN_CALIBRATION_SAMPLE,
    });
  });

  it('publishes nothing beyond the count when insufficient — no bias leaks out', () => {
    const result = readinessCalibration(biased(29, 40));
    expect(result).not.toHaveProperty('bias');
    expect(result).not.toHaveProperty('buckets');
  });

  it('fits exactly AT the threshold', () => {
    expect(readinessCalibration(biased(MIN_CALIBRATION_SAMPLE, 10)).sufficient).toBe(true);
  });

  it('honours an injected threshold, so tests and future tuning are not stuck at 30', () => {
    expect(readinessCalibration(biased(5, 10), 5).sufficient).toBe(true);
  });

  it('ignores non-finite rows when counting toward the threshold', () => {
    const dirty = [
      ...biased(MIN_CALIBRATION_SAMPLE - 1, 10),
      { predicted: Number.NaN, actual: 50 },
      { predicted: 60, actual: Number.POSITIVE_INFINITY },
    ];
    const result = readinessCalibration(dirty);
    expect(result.sufficient).toBe(false);
    expect(result.observations).toBe(MIN_CALIBRATION_SAMPLE - 1);
  });
});

describe('readinessCalibration — the numbers, once there is a sample', () => {
  it('reports a positive bias when the estimate runs optimistic', () => {
    const result = readinessCalibration(biased(30, 12));
    if (!result.sufficient) throw new Error('expected a sufficient sample');

    expect(result.bias).toBeCloseTo(12);
    expect(result.mean_predicted).toBeCloseTo(72);
    expect(result.mean_actual).toBeCloseTo(60);
  });

  it('reports a negative bias when it runs pessimistic', () => {
    const result = readinessCalibration(biased(30, -8));
    if (!result.sufficient) throw new Error('expected a sufficient sample');
    expect(result.bias).toBeCloseTo(-8);
  });

  it('separates a well-calibrated model from a wildly erratic one with zero mean error', () => {
    // Bias alone hides spread: +40 and −40 average to a perfect 0. This is why
    // mean_absolute_error is reported beside it.
    const erratic: ReadinessObservation[] = Array.from({ length: 30 }, (_, i) => ({
      predicted: i % 2 === 0 ? 90 : 10,
      actual:    50,
    }));
    const result = readinessCalibration(erratic);
    if (!result.sufficient) throw new Error('expected a sufficient sample');

    expect(result.bias).toBeCloseTo(0);
    expect(result.mean_absolute_error).toBeCloseTo(40);
  });

  it('buckets predictions and reports the mean actual per bucket', () => {
    const observations: ReadinessObservation[] = [
      ...Array.from({ length: 15 }, () => ({ predicted: 10, actual: 30 })),
      ...Array.from({ length: 15 }, () => ({ predicted: 85, actual: 80 })),
    ];
    const result = readinessCalibration(observations);
    if (!result.sufficient) throw new Error('expected a sufficient sample');

    expect(result.buckets).toHaveLength(2);
    expect(result.buckets[0]).toMatchObject({
      range_start:  0,
      range_end:    CALIBRATION_BUCKET_SIZE,
      observations: 15,
      mean_actual:  30,
    });
    expect(result.buckets[1].range_start).toBe(80);
  });

  it('omits empty buckets rather than zero-filling them into a false curve', () => {
    const result = readinessCalibration(biased(30, 0, 50));
    if (!result.sufficient) throw new Error('expected a sufficient sample');
    expect(result.buckets).toHaveLength(1);
  });

  it('puts a prediction of exactly 100 in the top bucket, not one of its own', () => {
    const result = readinessCalibration(
      Array.from({ length: 30 }, () => ({ predicted: 100, actual: 70 })),
    );
    if (!result.sufficient) throw new Error('expected a sufficient sample');

    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0].range_start).toBe(80);
    expect(result.buckets[0].range_end).toBe(100);
  });

  it('returns buckets in ascending order', () => {
    const observations: ReadinessObservation[] = [
      ...Array.from({ length: 10 }, () => ({ predicted: 75, actual: 60 })),
      ...Array.from({ length: 10 }, () => ({ predicted: 15, actual: 20 })),
      ...Array.from({ length: 10 }, () => ({ predicted: 45, actual: 40 })),
    ];
    const result = readinessCalibration(observations);
    if (!result.sufficient) throw new Error('expected a sufficient sample');

    expect(result.buckets.map((b) => b.range_start)).toEqual([0, 40, 60]);
  });
});
