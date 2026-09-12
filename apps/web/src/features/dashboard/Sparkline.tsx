/**
 * A small multi-series line for a panel, drawn as plain SVG.
 *
 * No chart library: one polyline against a shared scale is the whole
 * requirement, and a dependency would bring its own colours and animation into
 * a surface whose rule is that motion means state change.
 *
 * Two properties are deliberate rather than incidental:
 *
 * - **Gaps stay gaps.** A `null` reading breaks the line instead of joining the
 *   points either side of it. Those are the samples where a counter reset or a
 *   failed read means the rate is unknown, and a straight line across them would
 *   draw traffic that was never measured.
 * - **The scale is shared across series and stated by the caller.** Drawing
 *   upload and download against separate maxima would make a trickle look like a
 *   flood next to it.
 */
export type SparklineSeries = {
  values: readonly (number | null)[];
  /** Class name carrying the colour, so tone stays in the stylesheet. */
  className: string;
};

export function Sparkline({
  series,
  ariaLabel,
  height = 32,
}: {
  series: readonly SparklineSeries[];
  ariaLabel: string;
  height?: number;
}) {
  const width = 100;
  const readings = series.flatMap((entry) =>
    entry.values.filter((value): value is number => value !== null),
  );
  const peak = readings.length === 0 ? 0 : Math.max(...readings);
  const length = Math.max(...series.map((entry) => entry.values.length), 0);

  if (length < 2 || peak <= 0) {
    return (
      <div className="sparkline is-empty" role="img" aria-label={`${ariaLabel}：暂无足够样本`}>
        <span aria-hidden="true">—</span>
      </div>
    );
  }

  const x = (index: number): number => (index / (length - 1)) * width;
  // Inset by a pixel so a line sitting at the peak is not clipped by the edge.
  const y = (value: number): number => height - 1 - (value / peak) * (height - 2);

  return (
    <svg
      className="sparkline"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={ariaLabel}
    >
      {series.map((entry, seriesIndex) =>
        segmentsOf(entry.values).map((segment, segmentIndex) => (
          <polyline
            key={`${seriesIndex}-${segmentIndex}`}
            className={entry.className}
            points={segment.map(({ index, value }) => `${x(index)},${y(value)}`).join(' ')}
            fill="none"
            vectorEffect="non-scaling-stroke"
          />
        )),
      )}
    </svg>
  );
}

/** Splits a series into runs of consecutive known readings. */
function segmentsOf(
  values: readonly (number | null)[],
): Array<Array<{ index: number; value: number }>> {
  const segments: Array<Array<{ index: number; value: number }>> = [];
  let current: Array<{ index: number; value: number }> = [];

  values.forEach((value, index) => {
    if (value === null) {
      if (current.length > 0) segments.push(current);
      current = [];
      return;
    }
    current.push({ index, value });
  });
  if (current.length > 0) segments.push(current);

  // A lone point has no line to draw, but dropping it would hide a reading; it
  // is rendered as a zero-length polyline, which the round line cap shows as a dot.
  return segments.map((segment) =>
    segment.length === 1
      ? [
          segment[0] as { index: number; value: number },
          segment[0] as { index: number; value: number },
        ]
      : segment,
  );
}
