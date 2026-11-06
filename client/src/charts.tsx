import { useState, type ReactNode } from 'react';

/** Trail blue and blaze orange. Validated for color vision deficiency and 3:1 contrast on white. */
export const SERIES = ['#2457a6', '#c7711f'] as const;

/** Round step (1, 2, 2.5 or 5 times a power of ten) giving about four intervals. */
function niceStep(max: number): number {
  const raw = Math.max(max, 1e-9) / 4;
  const exp = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / exp;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * exp;
}

/** Axis scale: a top value that is a whole number of round steps, plus the tick values. */
function scale(dataMax: number, minMax: number): { max: number; ticks: number[] } {
  const step = niceStep(Math.max(dataMax, minMax));
  const count = Math.max(1, Math.ceil(Math.max(dataMax, minMax) / step - 1e-9));
  const ticks = Array.from({ length: count + 1 }, (_, i) => Number((step * i).toPrecision(12)));
  return { max: step * count, ticks };
}

function Tooltip({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  // x and y are percentages of the chart box, so the tooltip tracks the responsive SVG.
  const flip = x > 60;
  return (
    <div
      className="tooltip"
      role="status"
      style={{
        left: `${x}%`,
        top: `${y}%`,
        transform: `translate(${flip ? 'calc(-100% - 12px)' : '12px'}, -50%)`,
      }}
    >
      {children}
    </div>
  );
}

function roundedTop(x: number, y: number, w: number, h: number): string {
  if (h <= 0) return '';
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

// ---------------------------------------------------------------------------

export interface RangeRow {
  label: string;
  value: number;
  low: number;
  high: number;
  tooltip: ReactNode;
  muted?: boolean;
}

/**
 * Horizontal range chart: a rate per category with its 95% interval, the rate marked with a blaze.
 * Rows with too little data are drawn muted so nobody reads a 1-of-2 as a real 50%.
 */
export function RangeDotChart({ rows, formatTick, label }: { rows: RangeRow[]; formatTick: (v: number) => string; label: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 720;
  const rowH = 34;
  const left = 132;
  const right = 24;
  const top = 8;
  const axisH = 26;
  const H = top + rows.length * rowH + axisH;
  const { max, ticks: t } = scale(Math.max(...rows.map((r) => r.high), 0), 0.01);
  const sx = (v: number) => left + (v / max) * (W - left - right);

  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} onMouseLeave={() => setHover(null)}>
        {t.map((v) => (
          <g key={v}>
            <line x1={sx(v)} x2={sx(v)} y1={top} y2={H - axisH} className="grid" />
            <text x={sx(v)} y={H - 8} className="tick" textAnchor="middle">
              {formatTick(v)}
            </text>
          </g>
        ))}
        {rows.map((r, i) => {
          const cy = top + i * rowH + rowH / 2;
          const active = hover === i;
          return (
            <g key={r.label} className={r.muted ? 'thin-row' : undefined}>
              {active && <rect x={0} y={cy - rowH / 2} width={W} height={rowH} className="hover-band" />}
              <text x={left - 12} y={cy} className="row-label" textAnchor="end" dominantBaseline="middle">
                {r.label}
              </text>
              <line x1={sx(r.low)} x2={sx(r.high)} y1={cy} y2={cy} stroke={SERIES[0]} strokeWidth={2} strokeLinecap="round" />
              <line x1={sx(r.low)} x2={sx(r.low)} y1={cy - 4} y2={cy + 4} stroke={SERIES[0]} strokeWidth={2} />
              <line x1={sx(r.high)} x2={sx(r.high)} y1={cy - 4} y2={cy + 4} stroke={SERIES[0]} strokeWidth={2} />
              <rect x={sx(r.value) - 3.5} y={cy - 10} width={7} height={20} rx={1.5} fill={SERIES[0]} stroke="#ffffff" strokeWidth={2} />
              <rect
                x={0}
                y={cy - rowH / 2}
                width={W}
                height={rowH}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                tabIndex={0}
                aria-label={r.label}
              />
            </g>
          );
        })}
      </svg>
      {hover !== null && rows[hover] && (
        <Tooltip x={(sx(rows[hover].high) / W) * 100} y={((top + hover * rowH + rowH / 2) / H) * 100}>
          {rows[hover].tooltip}
        </Tooltip>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

export interface BarSeries {
  name: string;
  color: string;
  values: number[];
}

/** Vertical bars, grouped when there is more than one series. One y axis, always. */
export function BarChart({
  categories,
  series,
  formatCategory,
  tooltip,
  label,
}: {
  categories: string[];
  series: BarSeries[];
  formatCategory: (c: string) => string;
  tooltip: (index: number) => ReactNode;
  label: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 720;
  const H = 240;
  const left = 44;
  const right = 8;
  const top = 10;
  const bottom = 28;
  const { max, ticks: yTicks } = scale(Math.max(0, ...series.flatMap((s) => s.values)), 1);
  const plotW = W - left - right;
  const plotH = H - top - bottom;
  const band = plotW / Math.max(1, categories.length);
  const groupW = Math.min(band * 0.7, 28 * series.length);
  const gap = series.length > 1 ? 2 : 0;
  const barW = (groupW - gap * (series.length - 1)) / series.length;
  const sy = (v: number) => top + plotH - (v / max) * plotH;
  const labelEvery = Math.max(1, Math.ceil(categories.length / 10));

  return (
    <div className="chart">
      {series.length > 1 && (
        <ul className="legend" aria-label="Legend">
          {series.map((s) => (
            <li key={s.name}>
              <span className="swatch" style={{ background: s.color }} />
              {s.name}
            </li>
          ))}
        </ul>
      )}
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} onMouseLeave={() => setHover(null)}>
        {yTicks.map((v) => (
          <g key={v}>
            <line x1={left} x2={W - right} y1={sy(v)} y2={sy(v)} className="grid" />
            <text x={left - 8} y={sy(v)} className="tick" textAnchor="end" dominantBaseline="middle">
              {Number.isInteger(v) ? v.toLocaleString('en-US') : v.toFixed(1)}
            </text>
          </g>
        ))}
        {categories.map((c, i) => {
          const gx = left + i * band + (band - groupW) / 2;
          return (
            <g key={c}>
              {hover === i && <rect x={left + i * band} y={top} width={band} height={plotH} className="hover-band" />}
              {series.map((s, j) => {
                const v = s.values[i] ?? 0;
                const y = sy(v);
                return <path key={s.name} d={roundedTop(gx + j * (barW + gap), y, barW, top + plotH - y)} fill={s.color} />;
              })}
              {i % labelEvery === 0 && (
                <text x={left + i * band + band / 2} y={H - 8} className="tick" textAnchor="middle">
                  {formatCategory(c)}
                </text>
              )}
              <rect
                x={left + i * band}
                y={top}
                width={band}
                height={plotH}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                tabIndex={0}
                aria-label={formatCategory(c)}
              />
            </g>
          );
        })}
        <line x1={left} x2={W - right} y1={top + plotH} y2={top + plotH} className="baseline" />
      </svg>
      {hover !== null && (
        <Tooltip x={((left + hover * band + band / 2) / W) * 100} y={40}>
          {tooltip(hover)}
        </Tooltip>
      )}
    </div>
  );
}
