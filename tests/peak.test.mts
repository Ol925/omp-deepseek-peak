// 峰谷规则自检：npm test
//
// 用 .mts 而非 .ts：omp 的扩展扫描按 .ts/.js 找文件，把测试排除在这个名单之外，
// 万一有人把仓库直接 clone 进 ~/.omp/agent/extensions/ 也不会被误当成扩展加载。
import {
  beijingStamp,
  classifyAt,
  daySegments,
  formatMinuteOfDay,
  nextTransition,
  peakMinutesOfDay,
  weekdayOf,
} from "../peak.ts";
import { HOLIDAYS, MAKEUP_WORKDAYS } from "../holidays.ts";

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures += 1;
    console.log(`FAIL  ${label}\n      期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  } else {
    console.log(`ok    ${label}  → ${JSON.stringify(actual)}`);
  }
}

/** 构造一个北京时间时刻（北京 = UTC+8）。 */
function bjAt(dateKey: string, hour: number, minute = 0): Date {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, hour - 8, minute));
}

console.log("=== 星期推算 ===");
check("2026-10-15 是周四", weekdayOf("2026-10-15"), 4);
check("2026-10-01 是周四", weekdayOf("2026-10-01"), 4);
check("2026-10-17 是周六", weekdayOf("2026-10-17"), 6);
check("2026-10-10 是周六", weekdayOf("2026-10-10"), 6);
check("2026-01-04 是周日", weekdayOf("2026-01-04"), 0);

console.log("\n=== 普通工作日 2026-10-15（周四）===");
check("08:30 空闲(窗口外)", classifyAt(bjAt("2026-10-15", 8, 30)).kind, "offpeak");
check("09:00 高峰", classifyAt(bjAt("2026-10-15", 9, 0)).kind, "peak");
check("11:59 高峰", classifyAt(bjAt("2026-10-15", 11, 59)).kind, "peak");
check("12:00 空闲(午休)", classifyAt(bjAt("2026-10-15", 12, 0)).kind, "offpeak");
check("13:59 空闲(午休)", classifyAt(bjAt("2026-10-15", 13, 59)).kind, "offpeak");
check("14:00 高峰", classifyAt(bjAt("2026-10-15", 14, 0)).kind, "peak");
check("17:59 高峰", classifyAt(bjAt("2026-10-15", 17, 59)).kind, "peak");
check("18:00 空闲", classifyAt(bjAt("2026-10-15", 18, 0)).kind, "offpeak");
check("23:30 空闲", classifyAt(bjAt("2026-10-15", 23, 30)).kind, "offpeak");
check("当日高峰 7 小时", peakMinutesOfDay("2026-10-15") / 60, 7);

console.log("\n=== 国庆假期 2026-10-01（周四，法定节假日）===");
const nationalDay = classifyAt(bjAt("2026-10-01", 10, 0));
check("10:00 空闲", nationalDay.kind, "offpeak");
check("原因为节假日", nationalDay.reason, "holiday");
check("节假日名称", nationalDay.holiday, "国庆节");
check("当日高峰 0 小时", peakMinutesOfDay("2026-10-01") / 60, 0);

console.log("\n=== 普通周末 2026-10-17（周六）===");
check("10:00 空闲", classifyAt(bjAt("2026-10-17", 10, 0)).kind, "offpeak");
check("原因为周末", classifyAt(bjAt("2026-10-17", 10, 0)).reason, "weekend");

console.log("\n=== 调休上班日 2026-10-10（周六）===");
const makeupDay = classifyAt(bjAt("2026-10-10", 10, 0));
check("默认按字面规则仍为空闲", makeupDay.kind, "offpeak");
check("标记为调休上班日", makeupDay.makeupWorkday, "国庆节");
check(
  "开启 makeupWorkdaysArePeak 后为高峰",
  classifyAt(bjAt("2026-10-10", 10, 0), { makeupWorkdaysArePeak: true }).kind,
  "peak",
);

console.log("\n=== 春节长假边界 2026-02-15 ~ 02-23 ===");
check("02-15 (周日) 空闲", classifyAt(bjAt("2026-02-15", 10, 0)).kind, "offpeak");
check("02-20 (周五) 假期内 空闲", classifyAt(bjAt("2026-02-20", 10, 0)).reason, "holiday");
check("02-23 (周一) 假期最后一天 空闲", classifyAt(bjAt("2026-02-23", 10, 0)).reason, "holiday");
check("02-24 (周二) 恢复高峰", classifyAt(bjAt("2026-02-24", 10, 0)).kind, "peak");
check("02-14 (周六) 调休上班", MAKEUP_WORKDAYS["2026-02-14"], "春节");

console.log("\n=== 自定义休息日/调休覆盖 ===");
check(
  "自定义休息日生效",
  classifyAt(bjAt("2026-10-15", 10, 0), { extraHolidays: new Set(["2026-10-15"]) }).reason,
  "holiday",
);
check(
  "自定义调休 + 视为高峰",
  classifyAt(bjAt("2026-10-17", 10, 0), {
    extraMakeupWorkdays: new Set(["2026-10-17"]),
    makeupWorkdaysArePeak: true,
  }).kind,
  "peak",
);

console.log("\n=== 切换点与倒计时 ===");
const t1 = nextTransition(bjAt("2026-10-15", 8, 30));
check("08:30 的下一次切换进入高峰", t1?.phase.kind, "peak");
check("切换时刻 09:00", t1 && formatMinuteOfDay(beijingStamp(t1.at).minutesOfDay), "09:00");
check("倒计时 30 分钟", t1 && Math.round(t1.inMs / 60_000), 30);

const t2 = nextTransition(bjAt("2026-10-15", 11, 30));
check("11:30 的下一次切换进入空闲", t2?.phase.kind, "offpeak");
check("切换时刻 12:00", t2 && formatMinuteOfDay(beijingStamp(t2.at).minutesOfDay), "12:00");

const t3 = nextTransition(bjAt("2026-10-15", 17, 0));
check("17:00 的下一次切换进入空闲", t3?.phase.kind, "offpeak");
check("切换时刻 18:00", t3 && formatMinuteOfDay(beijingStamp(t3.at).minutesOfDay), "18:00");

const t4 = nextTransition(bjAt("2026-10-15", 18, 30));
check("18:30 的下一次切换进入高峰（次日 09:00）", t4?.phase.kind, "peak");
check("切换日期为次日", t4 && beijingStamp(t4.at).dateKey, "2026-10-16");
check("切换时刻 09:00", t4 && formatMinuteOfDay(beijingStamp(t4.at).minutesOfDay), "09:00");

const t5 = nextTransition(bjAt("2026-09-30", 20, 0));
check("国庆前夜 20:00 之后长期空闲，无 4 天内切换", t5, undefined);

console.log("\n=== 时间轴分段 ===");
const segments = daySegments("2026-10-15");
check("工作日分段数", segments.length, 5);
check(
  "分段边界",
  segments.map((s) => `${formatMinuteOfDay(s.startMin)}-${formatMinuteOfDay(s.endMin)}:${s.kind}`),
  ["00:00-09:00:offpeak", "09:00-12:00:peak", "12:00-14:00:offpeak", "14:00-18:00:peak", "18:00-24:00:offpeak"],
);
check("节假日只有一段", daySegments("2026-10-01").length, 1);

console.log("\n=== 数据完整性（2026 官方通知逐条核对）===");
check("2026 元旦 3 天", Object.keys(HOLIDAYS).filter((d) => d.startsWith("2026-01")).length, 3);
check("2026 春节 9 天", Object.keys(HOLIDAYS).filter((d) => d.startsWith("2026-02")).length, 9);
check("2026 国庆 7 天", Object.keys(HOLIDAYS).filter((d) => d.startsWith("2026-10") && d !== "2026-10-10").length, 7);
for (const date of ["2026-01-04", "2026-02-14", "2026-02-28", "2026-05-09", "2026-09-20", "2026-10-10"]) {
  check(`官方调休日 ${date} 已收录`, MAKEUP_WORKDAYS[date] !== undefined, true);
}

console.log(`\n${failures === 0 ? "全部通过" : `${failures} 项失败`}`);
process.exitCode = failures === 0 ? 0 : 1;
