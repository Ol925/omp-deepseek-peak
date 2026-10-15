// 更新检查自检：npm test
//
// 含一次真实 registry 查询（网络不可用时自动跳过该项）。
import {
  checkHolidayDataUpdate,
  compareVersions,
  getCachedUpdateCheck,
  getUpdateCheckError,
  isUpdateCheckDisabled,
  updateHint,
} from "../update-check.ts";
import { DATA_SOURCE } from "../holidays.ts";

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

console.log("=== 版本号比较 ===");
check("1.6.0 > 1.5.9", compareVersions("1.6.0", "1.5.9"), 1);
check("1.5.9 == 1.5.9", compareVersions("1.5.9", "1.5.9"), 0);
check("1.5.9 < 1.6.0", compareVersions("1.5.9", "1.6.0"), -1);
// 字符串比较会在这里出错：'1.5.10' < '1.5.9' 按字典序成立，按语义化版本不成立
check("1.5.10 > 1.5.9（字典序陷阱）", compareVersions("1.5.10", "1.5.9"), 1);
check("1.10.0 > 1.9.0（字典序陷阱）", compareVersions("1.10.0", "1.9.0"), 1);
check("2.0.0 < 10.0.0", compareVersions("2.0.0", "10.0.0"), -1);
check("预发布标签按主版本比较", compareVersions("1.5.9-beta.1", "1.5.9"), 0);

console.log("\n=== 开关 ===");
delete process.env.OMP_DEEPSEEK_NO_UPDATE_CHECK;
check("默认未禁用", isUpdateCheckDisabled(), false);
process.env.OMP_DEEPSEEK_NO_UPDATE_CHECK = "1";
check("设为 1 时禁用", isUpdateCheckDisabled(), true);
process.env.OMP_DEEPSEEK_NO_UPDATE_CHECK = "off";
check("设为 off 时不生效", isUpdateCheckDisabled(), false);
delete process.env.OMP_DEEPSEEK_NO_UPDATE_CHECK;

console.log("\n=== 提示文案 ===");
check("无结果时无提示", updateHint(undefined), undefined);
check(
  "无更新时无提示",
  updateHint({ current: "1.5.9", latest: "1.5.9", hasUpdate: false, checkedAt: 0 }),
  undefined,
);
check(
  "有更新时给出提示",
  updateHint({ current: "1.5.9", latest: "1.6.0", hasUpdate: true, checkedAt: 0 }),
  "节假日数据可更新：chinese-days 1.5.9 → 1.6.0",
);

console.log("\n=== 禁用时不发请求 ===");
process.env.OMP_DEEPSEEK_NO_UPDATE_CHECK = "1";
const disabled = await checkHolidayDataUpdate(true);
check("禁用时返回 undefined", disabled, undefined);
check("禁用时缓存仍为空", getCachedUpdateCheck(), undefined);
delete process.env.OMP_DEEPSEEK_NO_UPDATE_CHECK;

console.log("\n=== 真实 registry 查询（需要网络）===");
const live = await checkHolidayDataUpdate(true);
if (live === undefined) {
  console.log(`skip  网络不可用或接口异常：${getUpdateCheckError() ?? "未知原因"}`);
} else {
  check("本地记录版本与 holidays.ts 一致", live.current, DATA_SOURCE.version);
  check("拿到 registry 版本号", typeof live.latest, "string");
  check("hasUpdate 与版本比较一致", live.hasUpdate, compareVersions(live.latest, live.current) > 0);
  console.log(`      本地 ${live.current} / registry ${live.latest}`);
  check("结果已进缓存", getCachedUpdateCheck()?.latest, live.latest);
}

console.log(`\n${failures === 0 ? "全部通过" : `${failures} 项失败`}`);
// 不用 process.exit()：Windows 上 undici 的 keep-alive socket 尚在关闭中，
// 强行退出会触发 libuv 断言。设置 exitCode 让事件循环自然排空。
process.exitCode = failures === 0 ? 0 : 1;
