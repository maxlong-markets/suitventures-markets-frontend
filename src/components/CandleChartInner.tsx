"use client";

import { useEffect, useRef } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineStyle,
  createChart,
  createTextWatermark,
  type IChartApi,
  type ISeriesApi,
  type ITextWatermarkPluginApi,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Candle, Interval } from "@/lib/types";
import { fmtHHMM, fmtMonthDay, fmtPlainPrice, priceMinMove } from "@/lib/format";

/**
 * TradingView Lightweight Charts in the handoff's dress: void background,
 * 6% grid, up/down candles with matching wicks, a dashed last-price line
 * with a filled axis tag, dashed crosshair with #2A2A31 tags, volume
 * histogram in the bottom 60px, and the pair name as a 4.5% watermark.
 *
 * The pane is 306px of the 332px box; the time axis takes the rest, which
 * puts the plot at y 70→270 and the volume base at y 306 like the design.
 */

const UP = "#6FDF9C";
const DOWN = "#FFB0A6";
const UP_VOL = "rgba(111,223,156,0.45)";
const DOWN_VOL = "rgba(255,176,166,0.45)";
const GRID = "rgba(12,13,16,0.18)";
const AXIS = "rgba(12,13,16,0.32)";
const TEXT = "rgba(250,248,244,0.8)";
const CROSSHAIR = "rgba(252,251,247,0.85)";
const TAG = "#2A2A31";
const WATERMARK = "rgba(252,251,247,0.1)";
const MONO =
  '"SF Mono", SFMono-Regular, ui-monospace, Menlo, Consolas, monospace';
const SANS = '"Helvetica Neue", Helvetica, Arial, sans-serif';
const PANE_HEIGHT = 306;
const PLOT_TOP = 70;
const PLOT_BOTTOM = 270;
const VOLUME_HEIGHT = 60;

interface Props {
  candles: Candle[];
  interval: Interval;
  pairLabel: string;
  onHover(candle: Candle | null): void;
}

function toTime(ms: number): UTCTimestamp {
  return Math.floor(ms / 1000) as UTCTimestamp;
}

function formatTime(time: Time, interval: Interval): string {
  const ms = (typeof time === "number" ? time : 0) * 1000;
  return interval === "1d" ? fmtMonthDay(ms) : fmtHHMM(ms);
}

function watermarkLines(text: string) {
  return {
    lines: [
      { text, color: WATERMARK, fontSize: 38, fontFamily: SANS, fontStyle: "500" },
    ],
  };
}

export default function CandleChartInner({
  candles,
  interval,
  pairLabel,
  onHover,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const watermarkRef = useRef<ITextWatermarkPluginApi<Time> | null>(null);
  // Latest values for callbacks registered once, without resubscribing.
  const intervalRef = useRef(interval);
  const onHoverRef = useRef(onHover);
  const candlesRef = useRef(candles);
  useEffect(() => {
    intervalRef.current = interval;
    onHoverRef.current = onHover;
    candlesRef.current = candles;
  }, [interval, onHover, candles]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "#727478" },
        textColor: TEXT,
        fontFamily: MONO,
        fontSize: 10,
      },
      grid: { vertLines: { color: GRID }, horzLines: { color: GRID } },
      rightPriceScale: {
        borderColor: AXIS,
        minimumWidth: 64,
        scaleMargins: {
          top: PLOT_TOP / PANE_HEIGHT,
          bottom: (PANE_HEIGHT - PLOT_BOTTOM) / PANE_HEIGHT,
        },
      },
      timeScale: {
        borderColor: AXIS,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 0,
        fixLeftEdge: true,
        fixRightEdge: true,
        tickMarkFormatter: (time: Time) => formatTime(time, intervalRef.current),
      },
      localization: {
        timeFormatter: (time: Time) => formatTime(time, intervalRef.current),
        priceFormatter: (p: number) => fmtPlainPrice(p),
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: CROSSHAIR,
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: TAG,
        },
        horzLine: {
          color: CROSSHAIR,
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: TAG,
        },
      },
      // The wheel keeps scrolling the page; pan by drag, zoom by axis drag or pinch.
      handleScale: { axisPressedMouseMove: true, mouseWheel: false, pinch: true },
      handleScroll: {
        mouseWheel: false,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: false,
      },
    });

    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    volume.priceScale().applyOptions({
      scaleMargins: { top: (PANE_HEIGHT - VOLUME_HEIGHT) / PANE_HEIGHT, bottom: 0 },
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
      borderVisible: false,
      priceLineVisible: true,
      priceLineStyle: LineStyle.Dashed,
      priceLineWidth: 1,
      lastValueVisible: true,
    });

    const watermark = createTextWatermark(chart.panes()[0], {
      horzAlign: "center",
      vertAlign: "center",
      ...watermarkLines(pairLabel),
    });

    const onMove = (param: MouseEventParams<Time>) => {
      if (param.time === undefined || !param.point) {
        onHoverRef.current(null);
        return;
      }
      const t = typeof param.time === "number" ? param.time : NaN;
      const hit = candlesRef.current.find((c) => Math.floor(c.t / 1000) === t) ?? null;
      onHoverRef.current(hit);
    };
    chart.subscribeCrosshairMove(onMove);

    chartRef.current = chart;
    candleSeriesRef.current = series;
    volumeSeriesRef.current = volume;
    watermarkRef.current = watermark;

    return () => {
      chart.unsubscribeCrosshairMove(onMove);
      onHoverRef.current(null);
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      watermarkRef.current = null;
    };
    // The chart is created once; data, interval and label update below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    watermarkRef.current?.applyOptions(watermarkLines(pairLabel));
  }, [pairLabel]);

  useEffect(() => {
    const chart = chartRef.current;
    const series = candleSeriesRef.current;
    const volume = volumeSeriesRef.current;
    if (!chart || !series || !volume) return;
    if (candles.length === 0) {
      series.setData([]);
      volume.setData([]);
      return;
    }
    const last = candles[candles.length - 1].c;
    series.applyOptions({
      priceFormat: {
        type: "custom",
        formatter: (p: number) => fmtPlainPrice(p),
        minMove: priceMinMove(last),
      },
    });
    series.setData(
      candles.map((c) => ({
        time: toTime(c.t),
        open: c.o,
        high: c.h,
        low: c.l,
        close: c.c,
      })),
    );
    volume.setData(
      candles.map((c) => ({
        time: toTime(c.t),
        value: c.v,
        color: c.c >= c.o ? UP_VOL : DOWN_VOL,
      })),
    );
    // Re-apply so cached tick labels pick up the interval's format.
    chart.applyOptions({
      timeScale: {
        tickMarkFormatter: (time: Time) => formatTime(time, interval),
      },
    });
    chart.timeScale().fitContent();
  }, [candles, interval]);

  return <div ref={containerRef} className="h-full w-full cursor-crosshair" />;
}
