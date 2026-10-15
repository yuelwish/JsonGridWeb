// 大整数保真回归验证：formatJSON / compressJSON 不改写超出双精度的整数字面量。
// 用法：node scripts/verify-bigint.mjs   （全绿退出码 0，任何不一致非 0）
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// —— 从 src/main.ts 抽取 worker 模板字符串并在沙箱里实例化 ——
const mainTs = readFileSync(join(ROOT, 'src/main.ts'), 'utf8');
const startMarker = 'function getWorkerCode(): string {';
const start = mainTs.indexOf('return `', mainTs.indexOf(startMarker));
const openTick = start + 'return '.length;
const closeTick = mainTs.indexOf('`;', openTick);
if (start < 0 || closeTick < 0) throw new Error('未找到 getWorkerCode 模板字符串');
const workerCode = (0, eval)('`' + mainTs.slice(openTick + 1, closeTick) + '`');

const shim = { onmessage: null, postMessage() {} };
const worker = new Function('self', workerCode + '\n;return { formatJSON: formatJSON, compressJSON: compressJSON };')(shim);

// —— 检查工具 ——
let failures = 0, checks = 0;
function fail(msg) { failures++; console.error('FAIL: ' + msg); }
function check(name, condition, detail) {
  checks++;
  if (!condition) fail(name + (detail ? ' -- ' + detail : ''));
}

// —— 辅助：提取格式化/压缩结果 ——
function format(text, compact) {
  return worker.formatJSON({ text: text, compact: !!compact });
}
function compress(text) {
  return worker.compressJSON(text);
}

// —— 用例 1：票据中的三个核心例子 ——
{
  const input = '{"a":1791973727783794676}';
  const fr = format(input, false);
  check('格式化: 1791973727783794676 保真',
    fr.result.indexOf('1791973727783794676') !== -1,
    '实际输出: ' + fr.result);
  const cr = compress(input);
  check('压缩: 1791973727783794676 保真',
    cr.result.indexOf('1791973727783794676') !== -1,
    '实际输出: ' + cr.result);
}
{
  const input = '{"a":12345678901234567890}';
  const fr = format(input, false);
  check('格式化: 12345678901234567890 保真',
    fr.result.indexOf('12345678901234567890') !== -1,
    '实际输出: ' + fr.result);
  const cr = compress(input);
  check('压缩: 12345678901234567890 保真',
    cr.result.indexOf('12345678901234567890') !== -1,
    '实际输出: ' + cr.result);
}
{
  const input = '{"a":9007199254740991}';
  const fr = format(input, false);
  check('格式化: 9007199254740991 (MAX_SAFE_INTEGER) 保真',
    fr.result.indexOf('9007199254740991') !== -1,
    '实际输出: ' + fr.result);
}

// —— 用例 2：负大整数 ——
{
  const input = '{"a":-1791973727783794676}';
  const fr = format(input, false);
  check('格式化: -1791973727783794676 负数保真',
    fr.result.indexOf('-1791973727783794676') !== -1,
    '实际输出: ' + fr.result);
  const cr = compress(input);
  check('压缩: -1791973727783794676 负数保真',
    cr.result.indexOf('-1791973727783794676') !== -1,
    '实际输出: ' + cr.result);
}

// —— 用例 3：紧凑格式化与全量格式化一致 ——
{
  const input = '{"a":1791973727783794676,"b":[12345678901234567890,-9999999999999999999]}';
  const fr = format(input, false);
  const frc = format(input, true);
  const cr = compress(input);
  check('紧凑格式化: 大整数保真',
    frc.result.indexOf('1791973727783794676') !== -1 &&
    frc.result.indexOf('12345678901234567890') !== -1 &&
    frc.result.indexOf('-9999999999999999999') !== -1,
    '实际输出: ' + frc.result);
}

// —— 用例 4：安全整数不被影响 ——
{
  const input = '{"a":42,"b":-1,"c":0,"d":9007199254740991}';
  const fr = format(input, false);
  const expected = JSON.stringify(JSON.parse(input), null, 2);
  check('安全整数格式化不变',
    fr.result === expected,
    '期望: ' + expected + ' 实际: ' + fr.result);
}

// —— 用例 5：非数字类型不受影响 ——
{
  const input = '{"s":"hello","b":true,"n":null,"f":3.14,"u":"\\u4e2d\\u6587"}';
  const fr = format(input, false);
  const expected = JSON.stringify(JSON.parse(input), null, 2);
  check('非数字类型序列化不变',
    fr.result === expected,
    '期望: ' + expected + ' 实际: ' + fr.result);
  const cr = compress(input);
  const expectedC = JSON.stringify(JSON.parse(input));
  check('非数字类型压缩不变',
    cr.result === expectedC,
    '期望: ' + expectedC + ' 实际: ' + cr.result);
}

// —— 用例 6：混合文档（大整数 + 普通值） ——
{
  const input = '{"id":1791973727783794676,"name":"test","score":3.14,"active":true,"tags":["a","b"],"count":42}';
  const fr = format(input, false);
  check('混合格式化: 大整数保真且其他值正常',
    fr.result.indexOf('1791973727783794676') !== -1 &&
    fr.result.indexOf('"name": "test"') !== -1 &&
    fr.result.indexOf('"score": 3.14') !== -1 &&
    fr.result.indexOf('"active": true') !== -1 &&
    fr.result.indexOf('"count": 42') !== -1,
    '实际输出: ' + fr.result);
  const cr = compress(input);
  check('混合压缩: 大整数保真且其他值正常',
    cr.result.indexOf('1791973727783794676') !== -1 &&
    cr.result.indexOf('"name":"test"') !== -1 &&
    cr.result.indexOf('"score":3.14') !== -1,
    '实际输出: ' + cr.result);
}

// —— 用例 7：嵌套大整数 ——
{
  const input = '{"data":{"items":[{"id":12345678901234567890},{"id":9876543210987654321}]}}';
  const fr = format(input, false);
  check('嵌套格式化: 大整数保真',
    fr.result.indexOf('12345678901234567890') !== -1 &&
    fr.result.indexOf('9876543210987654321') !== -1,
    '实际输出: ' + fr.result);
}

// —— 用例 8：大整数数组 ——
{
  const input = '[1791973727783794676,12345678901234567890,42]';
  const fr = format(input, false);
  check('数组格式化: 大整数保真',
    fr.result.indexOf('1791973727783794676') !== -1 &&
    fr.result.indexOf('12345678901234567890') !== -1 &&
    fr.result.indexOf('42') !== -1,
    '实际输出: ' + fr.result);
}

// —— 用例 9：真实样例——雪花 ID 文档 ——
{
  const samplePath = join(ROOT, 'test-data', 'bigint-snowflake.json');
  let sampleText;
  try {
    sampleText = readFileSync(samplePath, 'utf8');
  } catch (e) {
    // 如果样例文件不存在，跳过这组用例（会在另一个检查里报错）
    sampleText = null;
  }
  if (sampleText) {
    const fr = format(sampleText, false);
    const cr = compress(sampleText);
    // 提取所有大整数并验证
    const bigintRegex = /\d{16,}/g;
    const literals = sampleText.match(bigintRegex) || [];
    for (const lit of literals) {
      check('雪花样例格式化保真: ' + lit,
        fr.result.indexOf(lit) !== -1,
        '格式化输出中未找到: ' + lit);
      check('雪花样例压缩保真: ' + lit,
        cr.result.indexOf(lit) !== -1,
        '压缩输出中未找到: ' + lit);
    }
  } else {
    checks++;
    fail('test-data/bigint-snowflake.json 样例文件不存在');
  }
}

// —— 用例 10：超大整数（30+ 位） ——
{
  const input = '{"a":123456789012345678901234567890}';
  const fr = format(input, false);
  check('格式化: 30位大整数保真',
    fr.result.indexOf('123456789012345678901234567890') !== -1,
    '实际输出: ' + fr.result);
}

// —— 用例 11：多个大整数在同一层 ——
{
  const input = '{"a":1111111111111111111,"b":2222222222222222222,"c":3333333333333333333}';
  const fr = format(input, false);
  check('格式化: 多个大整数同层保真',
    fr.result.indexOf('1111111111111111111') !== -1 &&
    fr.result.indexOf('2222222222222222222') !== -1 &&
    fr.result.indexOf('3333333333333333333') !== -1,
    '实际输出: ' + fr.result);
}

// —— 用例 12：字符串中的数字不被影响 ——
{
  const input = '{"s":"1791973727783794676","n":1791973727783794676}';
  const fr = format(input, false);
  // 字符串中的数字应该保持为带引号的字符串
  check('格式化: 字符串中的数字不被误改',
    fr.result.indexOf('"s": "1791973727783794676"') !== -1,
    '实际输出: ' + fr.result);
  // 真正的数字应该保持原始字面量
  check('格式化: 同名大整数值保真',
    fr.result.indexOf('"n": 1791973727783794676') !== -1,
    '实际输出: ' + fr.result);
}

// —— 汇报 ——
console.log('\n共 ' + checks + ' 个用例，' + (failures === 0 ? '全部通过' : failures + ' 个失败'));
process.exit(failures === 0 ? 0 : 1);
