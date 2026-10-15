/**
 * DeepSeek 峰谷时段计算。
 *
 * 规则来源：DeepSeek 官方价格页「模型 & 价格」
 *   「空闲时段价格为高峰时段价格的一半。北京时间周一至周五（不含中国法定节假日）
 *     9:00 - 12:00、14:00 - 18:00 为高峰时段；其余时段，包括周末及中国法定节假日
 *     全天均为空闲时段。」
 *
 * 所有时间一律按北京时间 (UTC+8，无夏令时) 计算，与本机时区无关。
 */
import { COVERED_YEARS, HOLIDAYS, MAKEUP_WORKDAYS } from "./holidays.ts";

const BEIJING_OFFSET_MINUTES = 8 * 60;

/** 高峰时段窗口，单位：北京时间当天第几分钟，区间为 [起, 止)。 */
export const PEAK_WINDOWS: ReadonlyArray<readonly [number, number]> = [
  [9 * 60, 12 * 60],
  [14 * 60, 18 * 60],
];

export type PhaseKind = "peak" | "offpeak";

export type PhaseReason =
  /** 落在工作日的两个高峰窗口内。 */
  | "peak-window"
  /** 周末（且未被按高峰处理的调休工作日）。 */
  | "weekend"
  /** 法定节假日。 */
  | "holiday"
  /** 工作日但处于高峰窗口之外（含午休）。 */
  | "outside-window";

export interface Phase {
  kind: PhaseKind;
  reason: PhaseReason;
  /** 节假日名称，仅当 reason 为 "holiday"。 */
  holiday?: string;
  /** 该日为调休上班日时，对应的节日名称。 */
  makeupWorkday?: string;
}

export interface PeakOptions {
  /** 额外补充的休息日 (YYYY-MM-DD)，叠加在内置日历之上。 */
  extraHolidays?: ReadonlySet<string>;
  /** 额外补充的调休上班日 (YYYY-MM-DD)，叠加在内置日历之上。 */
  extraMakeupWorkdays?: ReadonlySet<string>;
  /**
   * 把调休上班的周末当作工作日处理，使其可能落入高峰窗口。
   *
   * 官方措辞是「其余时段，包括周末…均为空闲时段」，按字面理解调休周末仍算空闲，
   * 因此默认 false。如需按「实际上班日」理解，设为 true。
   */
  makeupWorkdaysArePeak?: boolean;
}

export interface BeijingStamp {
  dateKey: string;
  year: number;
  month: number;
  day: number;
  /** 0 = 周日。 */
  weekday: number;
  /** 当天第几分钟，0..1439。 */
  minutesOfDay: number;
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** 把任意时刻转换为北京时间字段。 */
export function beijingStamp(at: Date): BeijingStamp {
  const shifted = new Date(at.getTime() + BEIJING_OFFSET_MINUTES * 60_000);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth() + 1;
  const day = shifted.getUTCDate();
  return {
    dateKey: `${year}-${pad2(month)}-${pad2(day)}`,
    year,
    month,
    day,
    weekday: shifted.getUTCDay(),
    minutesOfDay: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

/** 由 YYYY-MM-DD 求星期（0 = 周日）。 */
export function weekdayOf(dateKey: string): number {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function isValidDateKey(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** 判定某个北京时间日期 + 分钟数处于高峰还是空闲。 */
export function classify(
  dateKey: string,
  minutesOfDay: number,
  weekday: number,
  options: PeakOptions = {},
): Phase {
  const holiday = HOLIDAYS[dateKey];
  if (holiday !== undefined) {
    return { kind: "offpeak", reason: "holiday", holiday };
  }
  if (options.extraHolidays?.has(dateKey)) {
    return { kind: "offpeak", reason: "holiday", holiday: "自定义休息日" };
  }

  const nameFromCalendar = MAKEUP_WORKDAYS[dateKey];
  const isExtraMakeup = options.extraMakeupWorkdays?.has(dateKey) ?? false;
  const makeupWorkday =
    nameFromCalendar ?? (isExtraMakeup ? "自定义调休" : undefined);

  const isWeekend = weekday === 0 || weekday === 6;
  const treatAsWorkday =
    !isWeekend ||
    (makeupWorkday !== undefined && options.makeupWorkdaysArePeak === true);

  if (!treatAsWorkday) {
    return { kind: "offpeak", reason: "weekend", makeupWorkday };
  }

  for (const [start, end] of PEAK_WINDOWS) {
    if (minutesOfDay >= start && minutesOfDay < end) {
      return { kind: "peak", reason: "peak-window", makeupWorkday };
    }
  }
  return { kind: "offpeak", reason: "outside-window", makeupWorkday };
}

/** 判定某个具体时刻处于高峰还是空闲。 */
export function classifyAt(at: Date, options: PeakOptions = {}): Phase {
  const stamp = beijingStamp(at);
  return classify(stamp.dateKey, stamp.minutesOfDay, stamp.weekday, options);
}

export interface Transition {
  /** 切换发生的时刻。 */
  at: Date;
  /** 切换之后的状态。 */
  phase: Phase;
  /** 距切换还有多少毫秒。 */
  inMs: number;
}

/**
 * 找出下一次峰谷切换。按分钟向后探测，默认最多看 4 天（足以跨过任何连休）。
 */
export function nextTransition(
  at: Date,
  options: PeakOptions = {},
  horizonMinutes = 4 * 24 * 60,
): Transition | undefined {
  const currentKind = classifyAt(at, options).kind;
  const cursor = new Date(at.getTime());
  cursor.setUTCSeconds(0, 0);

  for (let step = 1; step <= horizonMinutes; step += 1) {
    const probe = new Date(cursor.getTime() + step * 60_000);
    const phase = classifyAt(probe, options);
    if (phase.kind !== currentKind) {
      return { at: probe, phase, inMs: Math.max(0, probe.getTime() - at.getTime()) };
    }
  }
  return undefined;
}

export interface DaySegment {
  startMin: number;
  endMin: number;
  kind: PhaseKind;
}

/** 某一天的峰谷分段，用于画时间轴。 */
export function daySegments(
  dateKey: string,
  options: PeakOptions = {},
): DaySegment[] {
  const weekday = weekdayOf(dateKey);
  const segments: DaySegment[] = [];
  let current: DaySegment | undefined;

  for (let minute = 0; minute < 1440; minute += 1) {
    const kind = classify(dateKey, minute, weekday, options).kind;
    if (current !== undefined && current.kind === kind) {
      current.endMin = minute + 1;
      continue;
    }
    current = { startMin: minute, endMin: minute + 1, kind };
    segments.push(current);
  }
  return segments;
}

/** 某一天的高峰总分钟数。 */
export function peakMinutesOfDay(
  dateKey: string,
  options: PeakOptions = {},
): number {
  const weekday = weekdayOf(dateKey);
  let total = 0;
  for (let minute = 0; minute < 1440; minute += 1) {
    if (classify(dateKey, minute, weekday, options).kind === "peak") total += 1;
  }
  return total;
}

/** 内置节假日日历是否覆盖该年份。 */
export function isYearCovered(year: number): boolean {
  return COVERED_YEARS.includes(year);
}

export function coveredYears(): readonly number[] {
  return COVERED_YEARS;
}

/** 把分钟数格式化为 HH:MM；1440 表示当日终点，输出 24:00。 */
export function formatMinuteOfDay(minutes: number): string {
  if (minutes === 1440) return "24:00";
  const clamped = ((minutes % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(clamped / 60))}:${pad2(clamped % 60)}`;
}

/** 人类可读的时长，用于倒计时。 */
export function formatDuration(ms: number): string {
  if (ms <= 0) return "0秒";
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}天${hours}小时`;
  if (hours > 0) return `${hours}小时${minutes}分`;
  if (minutes > 0) return `${minutes}分${pad2(seconds)}秒`;
  return `${seconds}秒`;
}

/** 状态栏用的紧凑倒计时，例如 1h23m / 23m / 45s。 */
export function formatDurationCompact(ms: number): string {
  if (ms <= 0) return "0s";
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${pad2(minutes)}m`;
  if (minutes > 0) return `${minutes}m${pad2(seconds)}s`;
  return `${seconds}s`;
}

const WEEKDAY_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export function weekdayLabel(weekday: number): string {
  return WEEKDAY_LABELS[weekday] ?? "";
}

/** 当前状态的中文短标签。 */
export function phaseLabel(phase: Phase): string {
  if (phase.kind === "peak") return "高峰";
  return "空闲·半价";
}

/** 当前状态的成因说明。 */
export function phaseReasonLabel(phase: Phase): string {
  switch (phase.reason) {
    case "peak-window":
      return "处于高峰窗口内";
    case "weekend":
      return "周末全天空闲";
    case "holiday":
      return `法定节假日（${phase.holiday ?? "未知"}）全天空闲`;
    case "outside-window":
      return "工作日但不在高峰窗口内";
  }
}
