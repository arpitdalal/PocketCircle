/** Keep the smallest magnitude cluster readable, with a shared scale for both signs. */
export function categoryRankingScale(values: number[]) {
  const magnitudes = [...new Set(values.map(Math.abs).filter((value) => value > 0))].sort(
    (a, b) => a - b,
  );
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const smallest = magnitudes[0] ?? 0;
  // Aim for 5% of the scale for the smallest bar, about 10px in a 200px plot.
  const visibility = 0.05;
  const originalVisibility = smallest / (max - min);
  let selectedVisibility = originalVisibility;
  const gapShare = 0.3;
  const upperShare = 0.5;
  let gap: { lower: number; upper: number; tickStep: number } | undefined;
  for (const [index, low] of magnitudes.entries()) {
    const high = magnitudes[index + 1];
    if (high === undefined) break;
    const step = 10 ** Math.floor(Math.log10(low));
    const lower = Math.ceil(low / step) * step;
    const upperStep = 10 ** (Math.floor(Math.log10(high)) - 1);
    const upper = (Math.ceil(high / upperStep) - 1) * upperStep;
    const tickStep = Math.ceil(lower / 3 / step) * step;
    const otherExtent = Math.min(-min, max);
    const sideSpan = lower * (1 + gapShare + upperShare);
    const otherSpan =
      otherExtent <= lower ? Math.ceil(otherExtent / tickStep) * tickStep : sideSpan;
    const candidateVisibility = smallest / (sideSpan + otherSpan);
    // Keep as much of the original lower scale as possible without squeezing the
    // smallest total. Only cut meaningful empty ranges, never through observations.
    if (
      originalVisibility < visibility &&
      high / low >= 2 &&
      upper > lower &&
      (candidateVisibility >= visibility ||
        (selectedVisibility < visibility && candidateVisibility > selectedVisibility))
    ) {
      gap = { lower, upper, tickStep };
      selectedVisibility = candidateVisibility;
    }
  }
  if (!gap) {
    return { project: (value: number) => value, domain: [min, max], ticks: undefined, breaks: [] };
  }

  const { lower, upper, tickStep: step } = gap;
  const largest = Math.max(-min, max);
  const gapSize = lower * gapShare;
  const upperSize = lower * upperShare;
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
      ticks.push(sign * upper, sign * extent);
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
