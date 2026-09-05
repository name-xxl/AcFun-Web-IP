// 生成 src/55-device-data.js 的内置设备型号表
// 用法: node tools/gen-device-data.js <MobileModels 数据目录>
// 数据目录即 KHwang9883/MobileModels 仓库的内容（含 *.md 与 Apple_mobile_device_types.txt）
// 数据许可: CC BY-NC-SA 4.0 (MobileModels) — 需在 README 致谢中保留
//
// 策略:
// - Apple 型号取 gist 全量（i386 等模拟器条目除外）
// - 安卓品牌文件按 `## 章节` 切分，剔除平板/穿戴/笔记本/智慧屏/早期产品等非手机章节
// - 旗舰系列章节保留最近 TAIL_FULL 条，其他手机系列保留最近 TAIL_OTHER 条
//   （章节内按年代排序，取尾部即"近年机型"；旗舰系列在前部，不能只看文件尾部）
// - 一行多个代码（如 `ALN-AL00` `ALN-AL80`: HUAWEI Mate 60 Pro）逐个展开
// - 海外双语言文件（oneplus/meizu）只保留中文行，并去掉"国行版"后缀

const fs = require('fs');
const path = require('path');

const dir = process.argv[2];
if (!dir || !fs.existsSync(dir)) {
  console.error('用法: node tools/gen-device-data.js <MobileModels 数据目录>');
  process.exit(1);
}
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');

// 解析一行中的全部代码 + 名称: `CODE1` `CODE2`: 名称
function parseLine(line) {
  const m = line.match(/^((?:`[^`]+`\s*)+):\s*(.+?)\s*$/);
  if (!m) return null;
  const codes = [...m[1].matchAll(/`([^`]+)`/g)].map(x => x[1]);
  return { codes, name: m[2] };
}

// 品牌md 解析：按 `## 章节` 切分，非手机章节剔除，旗舰章节多留、其他少留
const TAIL_FULL = 16;
const TAIL_OTHER = 4;
const DROP_RE = /平板|穿戴|手表|笔记本|智慧屏|电脑|Paper|耳机|手环|Watch|Band|IoT|早期|成立前|路由|音箱|学习机|眼镜|电视/;
// 章节尾部常堆积区域变体（国际版/定制版等），对国行用户无用，剔除后尾部才是真旗舰
const VARIANT_RE = /国际版|海外版|欧洲版|北美版|印度版|日本版|韩国版|澳洲版|港版|台版|美版|欧版|T-Mobile|定制版|校园|演示机|工程机/;

function parseBrand(file, opts = {}) {
  const { full = null, tailFull = TAIL_FULL, chinaOnly = false, stripSuffix = '' } = opts;
  const out = {};
  const sections = read(file).split(/^## /m).slice(1);
  for (const sec of sections) {
    const nl = sec.indexOf('\n');
    const head = sec.slice(0, nl).trim();
    if (DROP_RE.test(head)) continue;
    const limit = full && full.test(head) ? tailFull : TAIL_OTHER;
    const entries = [];
    for (const raw of sec.split('\n')) {
      const line = raw.trim();
      if (!line.startsWith('`')) continue;
      const parsed = parseLine(line);
      if (!parsed) continue;
      let { codes, name } = parsed;
      if (chinaOnly && !/[\u4e00-\u9fa5]/.test(name)) continue;
      if (stripSuffix && name.endsWith(stripSuffix)) {
        name = name.slice(0, -stripSuffix.length).trim();
      }
      if (name && !VARIANT_RE.test(name)) entries.push([codes, name]);
    }
    for (const [codes, name] of entries.slice(-limit)) {
      for (const code of codes) {
        if (code && !out[code]) out[code] = name;
      }
    }
  }
  return out;
}

// Apple gist: `iPhone3,1 : iPhone 4`，跳过模拟器条目
function parseApple(file) {
  const out = {};
  for (const raw of read(file).split('\n')) {
    const line = raw.trim();
    const m = line.match(/^([A-Za-z0-9_,.\-]+)\s*:\s*(.+?)\s*$/);
    if (!m) continue;
    if (/^(i386|x86_64|arm64)$/.test(m[1])) continue;
    if (m[1] && m[2] && !out[m[1]]) out[m[1]] = m[2];
  }
  return out;
}

// 各品牌配置: [文件, 解析选项, 说明]
const SOURCES = [
  ['Apple_mobile_device_types.txt', () => parseApple('Apple_mobile_device_types.txt'), 'Apple'],
  ['xiaomi_cn.md', { full: /数字系列|Civi|MIX|REDMI K|Note 系列|Turbo/ }, '小米/Redmi'],
  ['huawei_cn.md', { full: /Mate 系列|P \/ Pura|Pocket|nova/, tailFull: 32 }, '华为'],
  ['honor_cn.md', { full: /Magic 系列|数字系列|V 系列|GT 系列|X 系列/ }, '荣耀'],
  ['oppo_cn.md', { full: /Find X|Find N|Reno|Ace/ }, 'OPPO'],
  ['vivo_cn.md', { full: /X 系列|NEX|iQOO 旗舰|iQOO Neo/, tailFull: 26 }, 'vivo/iQOO'],
  ['oneplus.md', { full: /./, tailFull: 40, chinaOnly: true, stripSuffix: ' 国行版' }, '一加'],
  ['realme_cn.md', { full: /./ }, 'realme'],
  ['samsung_cn.md', { full: /Galaxy S 系列|Galaxy Note|Galaxy Z|心系天下/ }, '三星'],
  ['meizu.md', { full: /魅族手机/, chinaOnly: true }, '魅族'],
];

const db = {};
let conflict = 0;
for (const [file, opts, label] of SOURCES) {
  const part = typeof opts === 'function' ? opts() : parseBrand(file, opts);
  for (const [code, name] of Object.entries(part)) {
    if (db[code] && db[code] !== name) conflict++;
    db[code] = name;
  }
  console.log(`${file}: ${Object.keys(part).length} 条 (${label})`);
}

// 抽查已知映射，防止解析走样
const SPOT = ['iPhone3,1', 'iPhone14,5', 'RMX3700', 'V2324A', 'SM-S9280', 'ALN-AL00', 'm2381', 'PJZ110'];
console.log('\n抽查:');
for (const code of SPOT) console.log(`  ${code} → ${db[code] || '(缺失)'}`);
if (conflict) console.log(`\n⚠️ 跨品牌代码冲突 ${conflict} 处（后者覆盖前者）`);

const out = `// ============================================================
//  设备型号内置数据 — 由 tools/gen-device-data.js 自动生成，勿手改
//  数据来源:
//  - KHwang9883/MobileModels (CC BY-NC-SA 4.0) — 安卓各品牌国行数据
//  - adamawolf/Apple_mobile_device_types — Apple 全系型号
//  更新数据: node tools/gen-device-data.js <MobileModels 数据目录>
// ============================================================
const DEVICE_BUILTIN = ${JSON.stringify(db, null, 2)};
`;

const dst = path.join(__dirname, '..', 'src', '55-device-data.js');
fs.writeFileSync(dst, out, 'utf8');
console.log(`\n生成 ${dst}: ${Object.keys(db).length} 条, ${out.length} 字符`);
