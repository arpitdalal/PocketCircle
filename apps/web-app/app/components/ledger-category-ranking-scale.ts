/** Compress the largest empty magnitude range, keeping zero and both signs symmetric. */
export function categoryRankingScale(values: number[]) {
  const magnitudes = [...new Set(values.map(Math.abs).filter((value) => value > 0))].sort(
    (a, b) => a - b,
  );
  let gap: { low: number; high: number } | undefined;
  let ratio = 20;
  for (const [index, low] of magnitudes.entries()) {
    const high = magnitudes[index + 1];
    if (high !== undefined && high / low >= ratio) {
      gap = { low, high };
      ratio = high / low;
    }
  }
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  if (!gap) {
    return { project: (value: number) => value, domain: [min, max], ticks: undefined, breaks: [] };
  }

  const lowStep = 10 ** Math.floor(Math.log10(gap.low));
  const highStep = 10 ** (Math.floor(Math.log10(gap.high)) - 1);
  const lower = Math.ceil(gap.low / lowStep) * lowStep;
  const upper = (Math.ceil(gap.high / highStep) - 1) * highStep;
  const largest = Math.max(-min, max);
  const gapSize = lower * 0.3;
  const upperSize = lower * 0.5;
  const project = (value: number) => {
    const magnitude = Math.abs(value);
    const position =
      magnitude <= lower
        ? magnitude
        : magnitude < upper
          ? lower + ((magnitude - lower) / (upper - lower)) * gapSize
          : lower + gapSize + ((magnitude - upper) / (largest - upper)) * upperSize;
    return Math.sign(value) * position;
  };
  // Pad the unbroken side to the same low-range checkpoints; no tiny endpoint ticks.
  const step = Math.ceil(lower / 3 / lowStep) * lowStep;
  const bound = (value: number) =>
    Math.abs(value) <= lower ? Math.sign(value) * Math.ceil(Math.abs(value) / step) * step : value;
  const domainMin = project(bound(min));
  const domainMax = project(bound(max));
  const domain = [domainMin, domainMax];
  const ticks = [0];
  const breaks = [];
  for (const sign of [-1, 1]) {
    const extent = sign < 0 ? -min : max;
    for (const value of new Set([step, step * 2, lower])) {
      if (value <= Math.min(lower, Math.abs(bound(extent)))) ticks.push(sign * value);
    }
    if (extent >= upper) {
      ticks.push(sign * upper, sign * largest);
      breaks.push({ lower: sign * lower, upper: sign * upper });
    }
  }
  return {
    project,
    domain,
    ticks: ticks
      .filter((value) => project(value) >= domainMin && project(value) <= domainMax)
      .sort((a, b) => a - b),
    breaks,
  };
}
