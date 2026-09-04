import { Box, Typography, useTheme } from "@mui/material";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { HorizonPoint } from "./horizonPoints";
import { currencyFormatter, formatDays } from "./format";

/** A horizon called out on the chart, such as the knee or the best cycle. */
export interface HorizonMark {
  label: string;
  point: HorizonPoint;
  color: string;
}

const MARGIN = { left: 76, right: 20, top: 24, gap: 36, axis: 32 };
const VALUE_HEIGHT = 190;
const PROFIT_HEIGHT = 120;
const HEIGHT =
  MARGIN.top + VALUE_HEIGHT + MARGIN.gap + PROFIT_HEIGHT + MARGIN.axis;
const X_TICK_CANDIDATES = [
  0.1, 0.3, 1, 3, 10, 30, 100, 365, 1000, 3000, 10000, 30000,
];

function niceTicks(minimum: number, maximum: number, count: number): number[] {
  const span = maximum - minimum;
  if (!(span > 0)) return [minimum];
  const rough = span / count;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step =
    [1, 2, 2.5, 5, 10]
      .map((unit) => unit * magnitude)
      .find((candidate) => candidate >= rough) ?? magnitude;
  const ticks: number[] = [];
  for (
    let tick = Math.ceil(minimum / step) * step;
    tick <= maximum + step / 1e6;
    tick += step
  ) {
    ticks.push(Math.round(tick / step) * step);
  }
  return ticks;
}

function useWidth(fallback: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) =>
      setWidth(entry.contentRect.width),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/**
 * Value and cycle profit per day against horizon on a log axis, with the
 * marked horizons labeled. A crosshair follows the pointer or the arrow keys
 * and reads every measure at that horizon.
 */
export function HorizonChart({
  points,
  marks,
  label,
}: {
  points: HorizonPoint[];
  marks: HorizonMark[];
  label: string;
}) {
  const theme = useTheme();
  const [container, width] = useWidth(720);
  const [hovered, setHovered] = useState<number | null>(null);
  const plotWidth = Math.max(120, width - MARGIN.left - MARGIN.right);
  const first = points[0];
  const last = points[points.length - 1];
  const logMinimum = Math.log(first.horizonDays);
  const logSpan = Math.log(last.horizonDays) - logMinimum || 1;
  const x = (horizonDays: number) =>
    MARGIN.left + ((Math.log(horizonDays) - logMinimum) / logSpan) * plotWidth;
  const values = points.map((point) => point.value);
  const valueTicks = niceTicks(Math.min(...values), Math.max(...values), 4);
  const valueMinimum = Math.min(...values, ...valueTicks);
  const valueMaximum = Math.max(...values, ...valueTicks);
  const valueY = (value: number) =>
    MARGIN.top +
    VALUE_HEIGHT -
    ((value - valueMinimum) / (valueMaximum - valueMinimum || 1)) *
      VALUE_HEIGHT;
  const profits = points.map((point) => point.profitPerDay);
  const profitTicks = niceTicks(
    Math.min(0, ...profits),
    Math.max(0, ...profits),
    3,
  );
  const profitMinimum = Math.min(...profits, ...profitTicks);
  const profitMaximum = Math.max(...profits, ...profitTicks);
  const profitTop = MARGIN.top + VALUE_HEIGHT + MARGIN.gap;
  const profitY = (profit: number) =>
    profitTop +
    PROFIT_HEIGHT -
    ((profit - profitMinimum) / (profitMaximum - profitMinimum || 1)) *
      PROFIT_HEIGHT;
  const xTicks = X_TICK_CANDIDATES.filter(
    (tick) => tick >= first.horizonDays && tick <= last.horizonDays,
  );
  const nearestIndex = (horizonDays: number) =>
    Math.round(
      ((Math.log(horizonDays) - logMinimum) / logSpan) * (points.length - 1),
    );
  const valuePath = points
    .map(
      (point, index) =>
        `${index === 0 ? "M" : "L"}${x(point.horizonDays).toFixed(1)},${valueY(point.value).toFixed(1)}`,
    )
    .join(" ");
  const profitPath = points
    .map(
      (point, index) =>
        `${index === 0 ? "M" : "L"}${x(point.horizonDays).toFixed(1)},${profitY(point.profitPerDay).toFixed(1)}`,
    )
    .join(" ");
  const areaPath = `${valuePath} L${x(last.horizonDays).toFixed(1)},${(MARGIN.top + VALUE_HEIGHT).toFixed(1)} L${x(first.horizonDays).toFixed(1)},${(MARGIN.top + VALUE_HEIGHT).toFixed(1)} Z`;
  const surface = theme.palette.background.paper;
  const series = theme.palette.primary.main;
  const grid = theme.palette.divider;
  const ink = theme.palette.text.secondary;
  const hoveredPoint = hovered === null ? null : points[hovered];

  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const position = (event.clientX - bounds.left - MARGIN.left) / plotWidth;
    setHovered(
      Math.max(
        0,
        Math.min(points.length - 1, Math.round(position * (points.length - 1))),
      ),
    );
  };
  const onKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    const step =
      event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    setHovered((current) =>
      Math.max(
        0,
        Math.min(
          points.length - 1,
          (current ??
            nearestIndex(marks[0]?.point.horizonDays ?? first.horizonDays)) +
            step,
        ),
      ),
    );
  };

  return (
    <Box ref={container} sx={{ position: "relative" }}>
      <svg
        width={width}
        height={HEIGHT}
        role="img"
        aria-label={label}
        tabIndex={0}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHovered(null)}
        onFocus={() =>
          setHovered(
            (current) =>
              current ??
              nearestIndex(marks[0]?.point.horizonDays ?? first.horizonDays),
          )
        }
        onBlur={() => setHovered(null)}
        onKeyDown={onKeyDown}
        style={{ display: "block", outline: "none", fontSize: 12 }}
      >
        {valueTicks.map((tick) => (
          <g key={`value-${tick}`}>
            <line
              x1={MARGIN.left}
              x2={MARGIN.left + plotWidth}
              y1={valueY(tick)}
              y2={valueY(tick)}
              stroke={grid}
            />
            <text
              x={MARGIN.left - 8}
              y={valueY(tick)}
              dy="0.35em"
              textAnchor="end"
              fill={ink}
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {currencyFormatter.format(tick)}
            </text>
          </g>
        ))}
        {profitTicks.map((tick) => (
          <g key={`profit-${tick}`}>
            <line
              x1={MARGIN.left}
              x2={MARGIN.left + plotWidth}
              y1={profitY(tick)}
              y2={profitY(tick)}
              stroke={tick === 0 ? ink : grid}
            />
            <text
              x={MARGIN.left - 8}
              y={profitY(tick)}
              dy="0.35em"
              textAnchor="end"
              fill={ink}
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {currencyFormatter.format(tick)}
            </text>
          </g>
        ))}
        {xTicks.map((tick) => (
          <text
            key={`x-${tick}`}
            x={x(tick)}
            y={profitTop + PROFIT_HEIGHT + 20}
            textAnchor={
              x(tick) < MARGIN.left + 12
                ? "start"
                : x(tick) > MARGIN.left + plotWidth - 12
                  ? "end"
                  : "middle"
            }
            fill={ink}
          >
            {tick.toLocaleString()}
          </text>
        ))}
        <text x={MARGIN.left} y={MARGIN.top - 10} fill={ink}>
          Physical value by target horizon, days
        </text>
        <text x={MARGIN.left} y={profitTop - 10} fill={ink}>
          Cycle profit per day
        </text>
        <path d={areaPath} fill={series} fillOpacity={0.1} />
        <path
          d={valuePath}
          fill="none"
          stroke={series}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <path
          d={profitPath}
          fill="none"
          stroke={series}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {marks.map((mark) => {
          const { point } = mark;
          const markX = x(point.horizonDays);
          const onRight = markX > MARGIN.left + plotWidth * 0.7;
          return (
            <g key={mark.label}>
              <circle
                cx={markX}
                cy={valueY(point.value)}
                r={5}
                fill={mark.color}
                stroke={surface}
                strokeWidth={2}
              />
              <circle
                cx={markX}
                cy={profitY(point.profitPerDay)}
                r={5}
                fill={mark.color}
                stroke={surface}
                strokeWidth={2}
              />
              <text
                x={markX + (onRight ? -10 : 10)}
                y={valueY(point.value) - 10}
                textAnchor={onRight ? "end" : "start"}
                fill={theme.palette.text.primary}
                fontWeight={600}
              >
                {mark.label} · {formatDays(point.horizonDays)}
              </text>
            </g>
          );
        })}
        {hoveredPoint && (
          <g pointerEvents="none">
            <line
              x1={x(hoveredPoint.horizonDays)}
              x2={x(hoveredPoint.horizonDays)}
              y1={MARGIN.top}
              y2={profitTop + PROFIT_HEIGHT}
              stroke={ink}
            />
            <circle
              cx={x(hoveredPoint.horizonDays)}
              cy={valueY(hoveredPoint.value)}
              r={4}
              fill={series}
              stroke={surface}
              strokeWidth={2}
            />
            <circle
              cx={x(hoveredPoint.horizonDays)}
              cy={profitY(hoveredPoint.profitPerDay)}
              r={4}
              fill={series}
              stroke={surface}
              strokeWidth={2}
            />
          </g>
        )}
      </svg>
      {hoveredPoint && (
        <Box
          sx={{
            position: "absolute",
            top: MARGIN.top,
            ...(x(hoveredPoint.horizonDays) > MARGIN.left + plotWidth * 0.6
              ? { right: width - x(hoveredPoint.horizonDays) + 12 }
              : { left: x(hoveredPoint.horizonDays) + 12 }),
            pointerEvents: "none",
            bgcolor: "background.paper",
            border: 1,
            borderColor: "divider",
            borderRadius: 1,
            px: 1.5,
            py: 1,
            boxShadow: 2,
          }}
        >
          <Typography variant="body2" fontWeight={700}>
            {formatDays(hoveredPoint.horizonDays)}
          </Typography>
          <Typography variant="body2">
            {currencyFormatter.format(hoveredPoint.value)} value
          </Typography>
          <Typography variant="caption" color="text.secondary" display="block">
            {currencyFormatter.format(hoveredPoint.marginalValuePerDay)}/day
            marginal · e {hoveredPoint.elasticity.toFixed(2)}
          </Typography>
          <Typography
            variant="caption"
            display="block"
            color={hoveredPoint.profit >= 0 ? "text.secondary" : "error.main"}
          >
            {currencyFormatter.format(hoveredPoint.profitPerDay)}/day profit ·{" "}
            {currencyFormatter.format(hoveredPoint.netProceeds)} net
          </Typography>
        </Box>
      )}
    </Box>
  );
}
