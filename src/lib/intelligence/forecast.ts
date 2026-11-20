import type { MarketId } from "../../config/markets.ts";
import { shiftCalendarDay } from "../market-calendar.ts";

export type DemandObservation = {
  day: string;
  bookedUnits: number;
  availability: "available" | "stockout" | "partial" | "unknown";
  promotion: "none" | "active" | "unknown";
  returnedUnits?: number;
};

export type ForecastIdentity = { marketId: MarketId; productId: string; variantId?: string; group?: string };
export const forecastModels = ["recent-mean", "weekly-naive", "croston-sba"] as const;
export type ForecastModel = typeof forecastModels[number];

export type ForecastInterval = {
  lowerUnits: number;
  upperUnits: number;
  nominalCoverage: number;
  calibrationWindows: number;
};

export type ForecastEvaluation = {
  model: ForecastModel;
  windows: number;
  meanAbsoluteError: number | null;
  meanSignedError: number | null;
  wape: number | null;
  intervalCoverage: number | null;
  intervalWindows: number;
  coveredWindows: number;
  totalActual: number;
  totalAbsoluteError: number;
  totalSignedError: number;
};

export type DemandForecast = {
  status: "ready" | "analogue" | "insufficient";
  identity: ForecastIdentity;
  asOfDay: string;
  horizonDays: number;
  model: ForecastModel | null;
  pointUnits: number | null;
  interval: ForecastInterval | null;
  comparisons: ForecastEvaluation[];
  evidence: {
    from: string | null;
    through: string | null;
    availableUnpromotedDays: number;
    positiveDays: number;
    stockoutDays: number;
    partialDays: number;
    unknownAvailabilityDays: number;
    promotedDays: number;
    unknownPromotionDays: number;
    observedReturnedUnits: number;
  };
  limitations: string[];
  analogue: { identity: ForecastIdentity; rationale: string; unitsRatio: number;
    scenarioRangeUnits: { lowerUnits: number; upperUnits: number } } | null;
};

export type ForecastAnalogue = {
  forecast: DemandForecast;
  comparable: "same-product-variant" | "same-market-product-group";
  rationale: string;
  unitsRatio: number;
  ratioRange: readonly [lower: number, upper: number];
};

const historyLimit = 364;
const trainingDays = 56;
const minimumTrainingDays = 21;
const minimumPositiveDays = 4;
const intervalMinimum = 8;
const alpha = 0.2;

const known = (row: DemandObservation) => row.availability === "available" && row.promotion === "none";
const nonnegative = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const weekday = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay();
const average = (values: readonly number[]) => values.reduce((total, value) => total + value, 0) / values.length;
const round = (value: number) => Math.round(value * 100) / 100;

function observationsBefore(input: readonly DemandObservation[], asOfDay: string) {
  const dated = new Map<string, DemandObservation>();
  const duplicates = new Set<string>();
  const earliest = shiftCalendarDay(asOfDay, -historyLimit);
  if (!earliest) return [];
  for (const row of input) {
    if (!shiftCalendarDay(row.day, 0) || row.day < earliest || row.day >= asOfDay || !nonnegative(row.bookedUnits)) continue;
    if (dated.has(row.day)) duplicates.add(row.day);
    dated.set(row.day, row);
  }
  const first = [...dated.keys()].sort()[0];
  if (!first) return [];
  const result: DemandObservation[] = [];
  for (let day: string | null = first; day && day < asOfDay; day = shiftCalendarDay(day, 1)) {
    const row = duplicates.has(day) ? null : dated.get(day);
    result.push(row ?? { day, bookedUnits: 0, availability: "unknown", promotion: "unknown" });
  }
  return result;
}

function estimates(history: readonly DemandObservation[], origin: string, horizon: number): Partial<Record<ForecastModel, number>> {
  const start = shiftCalendarDay(origin, -trainingDays)!;
  const recentStart = shiftCalendarDay(origin, -28)!;
  const training = history.filter(row => row.day >= start && row.day < origin && known(row));
  let previousPositive = -1;
  let gap = 1;
  let size = 0;
  let positive = 0;
  for (const [index, row] of training.entries()) {
    if (!row.bookedUnits) continue;
    const spacing = index - previousPositive;
    size = positive ? size + alpha * (row.bookedUnits - size) : row.bookedUnits;
    gap = positive ? gap + alpha * (spacing - gap) : spacing;
    positive++;
    previousPositive = index;
  }
  if (training.length < minimumTrainingDays || positive < minimumPositiveDays ||
      training.filter(row => row.day >= recentStart).length < 10) return {};
  const result: Partial<Record<ForecastModel, number>> = {
    "recent-mean": average(training.map(row => row.bookedUnits)) * horizon,
  };
  if (positive / training.length <= 0.6) result["croston-sba"] = (1 - alpha / 2) * size / gap * horizon;
  const seasonStart = shiftCalendarDay(origin, -21)!;
  const latestWeekdays = new Map(training.filter(row => row.day >= seasonStart).map(row => [weekday(row.day), row.bookedUnits]));
  const futureWeekdays = Array.from({ length: horizon }, (_, offset) => (weekday(origin) + offset) % 7);
  if (futureWeekdays.every(day => latestWeekdays.has(day))) {
    result["weekly-naive"] = futureWeekdays.reduce((total, day) => total + latestWeekdays.get(day)!, 0);
  }
  return result;
}

type Prediction = { point: number; actual: number; error: number; covered?: boolean };
type Backtest = Partial<Record<ForecastModel, Prediction>>;

function calibratedInterval(point: number, previous: readonly Prediction[], coverage: number): ForecastInterval | null {
  if (previous.length < intervalMinimum) return null;
  const residuals = previous.map(row => -row.error).sort((a, b) => a - b);
  const tail = (1 - coverage) / 2;
  const low = residuals[Math.max(0, Math.floor(tail * (residuals.length + 1)) - 1)];
  const high = residuals[Math.min(residuals.length - 1, Math.ceil((1 - tail) * (residuals.length + 1)) - 1)];
  return {
    lowerUnits: Math.max(0, Math.floor(Math.min(point, point + low))),
    upperUnits: Math.max(0, Math.ceil(Math.max(point, point + high))),
    nominalCoverage: coverage,
    calibrationWindows: previous.length,
  };
}

function historicalWindows(rows: readonly DemandObservation[], horizon: number, coverage: number) {
  const result: Backtest[] = [];
  const previous: Record<ForecastModel, Prediction[]> = { "recent-mean": [], "weekly-naive": [], "croston-sba": [] };
  // Align disjoint holdouts to the selected as-of day. Each training window and
  // interval use exclusively observations before that holdout's first day.
  for (let index = rows.length % horizon; index + horizon <= rows.length; index += horizon) {
    const values = rows.slice(index, index + horizon);
    if (!values.every(known)) continue;
    const anticipated = estimates(rows.slice(0, index), values[0].day, horizon);
    const actual = values.reduce((total, row) => total + row.bookedUnits, 0);
    const predictions: Backtest = {};
    for (const model of forecastModels) {
      const point = anticipated[model];
      if (point === undefined) continue;
      const interval = calibratedInterval(point, previous[model], coverage);
      const prediction = { point, actual, error: point - actual,
        covered: interval ? interval.lowerUnits <= actual && actual <= interval.upperUnits : undefined };
      predictions[model] = prediction;
      previous[model].push(prediction);
    }
    if (Object.keys(predictions).length) result.push(predictions);
  }
  return { result, previous };
}

function evaluate(model: ForecastModel, values: readonly Prediction[]): ForecastEvaluation {
  const windows = values.length;
  const intervalWindows = values.filter(row => row.covered !== undefined).length;
  const coveredWindows = values.filter(row => row.covered).length;
  const totalActual = values.reduce((total, row) => total + row.actual, 0);
  const totalAbsoluteError = values.reduce((total, row) => total + Math.abs(row.error), 0);
  const totalSignedError = values.reduce((total, row) => total + row.error, 0);
  return {
    model, windows, intervalWindows, coveredWindows, totalActual, totalAbsoluteError, totalSignedError,
    meanAbsoluteError: windows ? round(totalAbsoluteError / windows) : null,
    meanSignedError: windows ? round(totalSignedError / windows) : null,
    wape: totalActual ? round(totalAbsoluteError / totalActual) : null,
    intervalCoverage: intervalWindows >= 5 ? round(coveredWindows / intervalWindows) : null,
  };
}

function selectedBaseline(anticipated: Partial<Record<ForecastModel, number>>, earlier: readonly Backtest[]) {
  let selected: ForecastModel = "recent-mean";
  let improvement = 0;
  for (const model of ["weekly-naive", "croston-sba"] as const) {
    if (anticipated[model] === undefined) continue;
    const matched = earlier.filter(row => row[model] && row["recent-mean"]);
    if (matched.length < 4) continue;
    const baseline = average(matched.map(row => Math.abs(row["recent-mean"]!.error)));
    const contender = average(matched.map(row => Math.abs(row[model]!.error)));
    // Avoid switching for negligible differences and compare only common windows.
    const relative = baseline > 0 ? (baseline - contender) / baseline : 0;
    if (relative >= 0.1 && relative > improvement) {
      improvement = relative;
      selected = model;
    }
  }
  return selected;
}

function validAnalogue(identity: ForecastIdentity, asOfDay: string, horizonDays: number, analogue: ForecastAnalogue) {
  const peer = analogue.forecast;
  const [lower, upper] = analogue.ratioRange;
  if (peer.status !== "ready" || peer.pointUnits === null || !peer.interval || peer.identity.marketId !== identity.marketId ||
      peer.asOfDay !== asOfDay || peer.horizonDays !== horizonDays || !analogue.rationale.trim() ||
      ![lower, upper, analogue.unitsRatio].every(Number.isFinite) || lower < 0.25 || upper > 4 ||
      lower > analogue.unitsRatio || upper < analogue.unitsRatio) return false;
  if (analogue.comparable === "same-product-variant") {
    return peer.identity.productId === identity.productId && Boolean(peer.identity.variantId && identity.variantId && peer.identity.variantId !== identity.variantId);
  }
  return Boolean(peer.identity.group && peer.identity.group === identity.group && peer.identity.productId !== identity.productId);
}

export function forecastDemand(observations: readonly DemandObservation[], options: {
  identity: ForecastIdentity;
  asOfDay: string;
  horizonDays: number;
  coverage?: number;
  analogues?: readonly ForecastAnalogue[];
}): DemandForecast {
  const { identity, asOfDay, horizonDays, analogues = [] } = options;
  const coverage = options.coverage ?? 0.8;
  if (!shiftCalendarDay(asOfDay, 0) || !Number.isInteger(horizonDays) || horizonDays < 1 || horizonDays > 56 ||
      !Number.isFinite(coverage) || coverage < 0.5 || coverage > 0.99) throw new RangeError("Choose a local date, a 1–56 day horizon and 50–99% coverage.");
  const rows = observationsBefore(observations, asOfDay);
  const evidence = {
    from: rows[0]?.day ?? null, through: rows.at(-1)?.day ?? null,
    availableUnpromotedDays: rows.filter(known).length,
    positiveDays: rows.filter(row => known(row) && row.bookedUnits > 0).length,
    stockoutDays: rows.filter(row => row.availability === "stockout").length,
    partialDays: rows.filter(row => row.availability === "partial").length,
    unknownAvailabilityDays: rows.filter(row => row.availability === "unknown").length,
    promotedDays: rows.filter(row => row.promotion === "active").length,
    unknownPromotionDays: rows.filter(row => row.promotion === "unknown").length,
    observedReturnedUnits: rows.reduce((sum, row) => sum + (nonnegative(row.returnedUnits) ? row.returnedUnits : 0), 0),
  };
  const limitations = ["Forecasts ordinary booked units during available, unpromoted periods. Returns are reported separately."];
  if (evidence.stockoutDays || evidence.partialDays || evidence.unknownAvailabilityDays || evidence.unknownPromotionDays || evidence.promotedDays) {
    limitations.push("Stockouts, limited or unknown availability, and promoted or unknown price days were excluded from model training and evaluation.");
  }
  const anticipated = estimates(rows, asOfDay, horizonDays);
  const historical = historicalWindows(rows, horizonDays, coverage);
  const selection = historical.result.length >= 8 ? Math.floor(historical.result.length * 0.6) : 0;
  const scores = historical.result.slice(selection);
  const comparisons = forecastModels.map(model => evaluate(model, scores.flatMap(row => row[model] ?? [])));
  const base = { identity, asOfDay, horizonDays, comparisons, evidence, limitations };
  if (anticipated["recent-mean"] === undefined) {
    const peer = analogues.find(analogue => validAnalogue(identity, asOfDay, horizonDays, analogue));
    if (peer) {
      limitations.push("The estimate uses an explicitly reviewed same-market analogue. Its scenario range and errors have no validation for this product.");
      return { ...base, status: "analogue", model: null, pointUnits: round(peer.forecast.pointUnits! * peer.unitsRatio), interval: null,
        analogue: { identity: peer.forecast.identity, rationale: peer.rationale, unitsRatio: peer.unitsRatio,
          scenarioRangeUnits: { lowerUnits: Math.floor(peer.forecast.interval!.lowerUnits * peer.ratioRange[0]),
            upperUnits: Math.ceil(peer.forecast.interval!.upperUnits * peer.ratioRange[1]) } } };
    }
    limitations.push("A baseline needs 21 usable days in the last 56, 10 in the last 28, and four positive days in training.");
    return { ...base, status: "insufficient", model: null, pointUnits: null, interval: null, analogue: null };
  }
  const model = selectedBaseline(anticipated, historical.result.slice(0, selection));
  const point = anticipated[model]!;
  const interval = calibratedInterval(point, historical.previous[model], coverage);
  if (!interval) limitations.push(`This horizon needs ${intervalMinimum} usable historical holdout windows before a range can be estimated.`);
  return { ...base, status: "ready", model, pointUnits: round(point), interval, analogue: null };
}

export function summarizeForecastBacktests(forecasts: readonly DemandForecast[]) {
  const groups = new Map<string, { marketId: MarketId; group: string; horizonDays: number; model: ForecastModel; level: "variant" | "product"; evaluatedSeries: number;
    windows: number; intervalWindows: number; covered: number; actual: number; absolute: number; signed: number }>();
  for (const forecast of forecasts) {
    const { marketId, group = "Uncategorized", variantId } = forecast.identity;
    for (const row of forecast.comparisons) {
      if (!row.windows) continue;
      const key = JSON.stringify([marketId, group, forecast.horizonDays, row.model, Boolean(variantId)]);
      const summary = groups.get(key) ?? { marketId, group, horizonDays: forecast.horizonDays, model: row.model,
        level: variantId ? "variant" as const : "product" as const, evaluatedSeries: 0,
        windows: 0, intervalWindows: 0, covered: 0, actual: 0, absolute: 0, signed: 0 };
      summary.evaluatedSeries++;
      summary.windows += row.windows;
      summary.intervalWindows += row.intervalWindows;
      summary.covered += row.coveredWindows;
      summary.actual += row.totalActual;
      summary.absolute += row.totalAbsoluteError;
      summary.signed += row.totalSignedError;
      groups.set(key, summary);
    }
  }
  return [...groups.values()].map(summary => ({ ...summary, meanAbsoluteError: round(summary.absolute / summary.windows),
    meanSignedError: round(summary.signed / summary.windows), wape: summary.actual ? round(summary.absolute / summary.actual) : null,
    intervalCoverage: summary.intervalWindows >= 5 ? round(summary.covered / summary.intervalWindows) : null }));
}
