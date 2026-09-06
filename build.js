// 构建脚本：把 src/ 下的源文件按顺序拼接成 dist/acfun-reveal.user.js
// 用法：node build.js
const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, 'src');
const DIST_FILE = path.join(__dirname, 'dist', 'acfun-reveal.user.js');

// 顺序即最终脚本的拼接顺序
const FILES = [
    '00-header.js',
    '10-constants.js',
    '20-utils.js',
    '30-storage.js',
    '40-api.js',
    '50-inject.js',
    '55-device-data.js',
    '56-device.js',
    '60-intercept.js',
    '70-observers.js',
    '80-panel.js',
    '85-cache-actions.js',
    '90-menu.js',
    '99-main.js',
];

let out = '';
for (const f of FILES) {
    const p = path.join(SRC_DIR, f);
    if (!fs.existsSync(p)) {
        console.error('缺少源文件: ' + f);
        process.exit(1);
    }
    out += fs.readFileSync(p, 'utf8');
}

// 孤儿文件检测：src/ 下未登记到 FILES 的文件会被拼接静默遗漏，直接报错
const orphans = fs.readdirSync(SRC_DIR).filter(f => f.endsWith('.js') && !FILES.includes(f));
if (orphans.length) {
    console.error('src/ 下有未登记的文件（会被拼接遗漏）: ' + orphans.join(', ') + '，请加入 FILES');
    process.exit(1);
}

// 版本号单一来源：package.json。src 里的 __VERSION__ 占位符在此统一注入，
// 下面的校验改为验证注入结果，发版只需改 package.json 一处
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
out = out.replaceAll('__VERSION__', pkg.version);

// 注入校验：@version（Tampermonkey 识别）与 VERSION 常量（运行时日志/导出用）
// 必须等于 package.json，防止占位符被删改或注入遗漏
const vm = out.match(/@version\s+([^\s]+)/);
if (!vm || vm[1] !== pkg.version) {
    console.error(`版本不一致：header @version=${vm ? vm[1] : '(未找到)'} vs package.json=${pkg.version}，请检查 __VERSION__ 占位符`);
    process.exit(1);
}
const vc = out.match(/const VERSION = '([^']+)'/);
if (!vc || vc[1] !== pkg.version) {
    console.error(`版本不一致：src VERSION=${vc ? vc[1] : '(未找到)'} vs package.json=${pkg.version}，请检查 __VERSION__ 占位符`);
    process.exit(1);
}

fs.mkdirSync(path.dirname(DIST_FILE), { recursive: true });
fs.writeFileSync(DIST_FILE, out, 'utf8');
console.log('构建完成 -> ' + DIST_FILE);
console.log('拼接 ' + FILES.length + ' 个文件，' + out.length + ' 字符，版本 ' + pkg.version);
