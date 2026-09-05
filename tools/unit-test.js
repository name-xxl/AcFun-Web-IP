// 单元测试：对纯逻辑函数做输入→输出验证
// 用法：node tools/unit-test.js
//
// 原理：在 Node 里模拟油猴/浏览器全局，按构建顺序加载 src/，
//        然后对 window.ACFunReveal 暴露的纯函数做断言。

const fs = require('fs');
const path = require('path');

// ── 1. 模拟油猴 & 浏览器全局 ──────────────────────────────
const storage = {};
global.GM_getValue = (key, fallback) => (key in storage ? storage[key] : fallback);
global.GM_setValue = (key, val) => { storage[key] = val; };
global.GM_registerMenuCommand = () => {};
global.GM_notification = () => {};

// 最小 DOM 模拟：只需要 querySelector / querySelectorAll / createElement 等
class FakeElement {
  constructor(tag, attrs = {}, children = []) {
    this.tagName = tag.toUpperCase();
    this.attrs = { ...attrs };
    this.children = children;
    this.dataset = {};
    this.className = attrs.class || '';
    this.classList = { contains: () => false };
    this.style = {};
    this._acrObserved = false;
    // 常用 DOM 属性直接映射到 attrs
    this.href = attrs.href || '';
    this.src = attrs.src || '';
    for (const [k, v] of Object.entries(attrs)) {
      if (k.startsWith('data-')) this.dataset[k.slice(5)] = v;
    }
  }
  getAttribute(name) { return this.attrs[name] ?? null; }
  setAttribute(name, v) { this.attrs[name] = v; }
  querySelector(sel) { return queryOne(this, sel); }
  querySelectorAll(sel) { return queryAll(this, sel); }
  closest() { return null; }
  appendChild(child) { this.children.push(child); return child; }
}

// 极简选择器匹配：支持本项目用到的子集，包括复合选择器如 a[data-userid]
function matches(el, sel) {
  if (!el || el.tagName === undefined) return false;

  // 逗号分隔（多选择器）
  if (sel.includes(',')) {
    return sel.split(',').map(s => s.trim()).some(s => matchesSingle(el, s));
  }
  return matchesSingle(el, sel);
}

function matchesSingle(el, sel) {
  // 解析复合选择器：tag、.class、[attr]、[attr=val]
  let remaining = sel;
  let expectTag = null, expectClass = null, expectAttrs = [];

  // 提取 tag
  const tagMatch = remaining.match(/^([a-z][a-z0-9]*)/i);
  if (tagMatch) {
    expectTag = tagMatch[1].toUpperCase();
    remaining = remaining.slice(tagMatch[0].length);
  }

  // 提取 .class 和 [attr] 部分
  while (remaining.length > 0) {
    const classMatch = remaining.match(/^\.([a-zA-Z0-9_-]+)/);
    if (classMatch) {
      expectClass = classMatch[1];
      remaining = remaining.slice(classMatch[0].length);
      continue;
    }
    const attrMatch = remaining.match(/^\[([^\]=~*^$|]+)(?:([~*^$|]?=)"?([^"\]]*)"?)?\]/);
    if (attrMatch) {
      expectAttrs.push({ name: attrMatch[1], op: attrMatch[2] || '=', value: attrMatch[3] });
      remaining = remaining.slice(attrMatch[0].length);
      continue;
    }
    break;
  }

  // 检查 tag
  if (expectTag && el.tagName !== expectTag) return false;
  // 检查 class
  if (expectClass && !(el.className || '').split(/\s+/).includes(expectClass)) return false;
  // 检查属性
  for (const { name, op, value } of expectAttrs) {
    if (!(name in el.attrs)) return false;
    if (value === undefined) continue;
    const attrVal = String(el.attrs[name]);
    if (op === '=' && attrVal !== value) return false;
    if (op === '*=' && !attrVal.includes(value)) return false;
  }
  return true;
}

function queryOne(root, sel) {
  // 逗号分隔（多选择器）
  if (sel.includes(',')) {
    for (const s of sel.split(',').map(s => s.trim())) {
      const found = queryOne(root, s);
      if (found) return found;
    }
    return null;
  }
  for (const child of root.children || []) {
    if (matches(child, sel)) return child;
    const found = queryOne(child, sel);
    if (found) return found;
  }
  return null;
}

function queryAll(root, sel) {
  const results = [];
  if (sel.includes(',')) {
    const seen = new Set();
    for (const s of sel.split(',').map(s => s.trim())) {
      for (const el of queryAll(root, s)) {
        if (!seen.has(el)) { seen.add(el); results.push(el); }
      }
    }
    return results;
  }
  for (const child of root.children || []) {
    if (matches(child, sel)) results.push(child);
    results.push(...queryAll(child, sel));
  }
  return results;
}

class FakeDocument {
  constructor() { this.body = new FakeElement('body'); }
  querySelector(sel) { return queryOne(this.body, sel); }
  querySelectorAll(sel) { return queryAll(this.body, sel); }
  createElement(tag) { return new FakeElement(tag); }
  addEventListener() {}
}

global.document = new FakeDocument();
global.IntersectionObserver = class { observe() {} unobserve() {} };
global.MutationObserver = class { observe() {} disconnect() {} };
global.XMLHttpRequest = class {};
global.fetch = async () => {};
global.location = { href: 'https://www.acfun.cn/v/ac12345', pathname: '/v/ac12345' };
global.history = { pushState: () => {}, replaceState: () => {} };
global.window = {
  fetch: global.fetch,
  addEventListener: () => {},
  IntersectionObserver: global.IntersectionObserver,
  MutationObserver: global.MutationObserver,
  location: global.location,
};

// ── 2. 按构建顺序拼接并加载 src/ ─────────────────────────
const SRC_DIR = path.join(__dirname, '..', 'src');
const FILES = [
  '00-header.js', '10-constants.js', '20-utils.js', '30-storage.js',
  '40-api.js', '50-inject.js', '55-device-data.js', '56-device.js',
  '60-intercept.js', '70-observers.js',
  '80-panel.js', '85-cache-actions.js', '90-menu.js', '99-main.js',
];

let combined = '';
for (const f of FILES) {
  combined += fs.readFileSync(path.join(SRC_DIR, f), 'utf8');
}

// 整体执行：源码是一个 IIFE，最终会执行 window.ACFunReveal = {...}
new Function(combined)();

const api = global.window.ACFunReveal;
if (!api) {
  console.error('✗ window.ACFunReveal 未暴露，加载失败');
  process.exit(1);
}

// ── 3. 测试框架 ──────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    期望: ${JSON.stringify(expected)}`);
    console.log(`    实际: ${JSON.stringify(actual)}`);
  }
}

function group(name) {
  console.log(`\n${name}`);
}

// ── 4. parseUidFromHref ──────────────────────────────────
group('parseUidFromHref');
assert('普通用户链接', api.parseUidFromHref('/u/12345'), 12345);
assert('直播链接', api.parseUidFromHref('/live/67890'), 67890);
assert('完整 URL', api.parseUidFromHref('https://www.acfun.cn/u/999'), 999);
assert('空字符串', api.parseUidFromHref(''), null);
assert('null', api.parseUidFromHref(null), null);
assert('无关链接', api.parseUidFromHref('/v/ac12345'), null);
assert('带路径的用户链接', api.parseUidFromHref('/u/100/follow'), 100);

// ── 5. extractCommentList ────────────────────────────────
group('extractCommentList');
assert('rootComments + subComments',
  api.extractCommentList({
    rootComments: [{ commentId: 1 }, { commentId: 2 }],
    subComments: [{ commentId: 3 }],
  }).length,
  3
);
assert('rootComments + comments',
  api.extractCommentList({
    rootComments: [{ commentId: 1 }],
    comments: [{ commentId: 2 }, { commentId: 3 }],
  }).length,
  3
);
assert('空数据', api.extractCommentList({}).length, 0);
assert('undefined 输入', api.extractCommentList(undefined).length, 0);

// ── 6. isCommentUrl ──────────────────────────────────────
group('isCommentUrl');
assert('匹配 /comment/list', api.isCommentUrl('https://www.acfun.cn/rest/pc-direct/comment/list?postId=123'), true);
assert('匹配 /comment/sublist', api.isCommentUrl('/rest/pc-direct/comment/sublist?rootCommentId=1'), true);
assert('匹配 /comment/subComment', api.isCommentUrl('/comment/subComment?foo=bar'), true);
assert('匹配 /comment/reply', api.isCommentUrl('/comment/reply'), true);
assert('不匹配无关 URL', api.isCommentUrl('https://www.acfun.cn/v/ac12345'), false);
assert('不匹配空字符串', api.isCommentUrl(''), false);
assert('不匹配部分关键字', api.isCommentUrl('https://example.com/comment'), false);

// ── 7. isFailureCacheFresh ───────────────────────────────
group('isFailureCacheFresh');
const now = Date.now();
assert('无 failedAt 不算', Boolean(api.isFailureCacheFresh({ ip: null })), false);
assert('刚失败算新鲜', Boolean(api.isFailureCacheFresh({ failedAt: now })), true);
assert('超过 TTL 不算', Boolean(api.isFailureCacheFresh({ failedAt: now - 7 * 3600 * 1000 })), false);
assert('边界：刚好在 TTL 内', Boolean(api.isFailureCacheFresh({ failedAt: now - 5 * 3600 * 1000 })), true);
assert('null 输入', Boolean(api.isFailureCacheFresh(null)), false);
assert('undefined 输入', Boolean(api.isFailureCacheFresh(undefined)), false);

// ── 8. extractUidFromComment ─────────────────────────────
group('extractUidFromComment');

// 默认模式：a[data-userid]
{
  const link = new FakeElement('a', { 'data-userid': '42' });
  const comment = new FakeElement('div', { 'data-commentid': '100' }, [link]);
  assert('默认模式 data-userid', api.extractUidFromComment(comment), 42);
}

// 盖楼模式：a.name[data-uid]
{
  const link = new FakeElement('a', { 'data-uid': '88', class: 'name' });
  link.className = 'name';
  const comment = new FakeElement('div', { 'data-cid': '200' }, [link]);
  assert('盖楼模式 data-uid', api.extractUidFromComment(comment), 88);
}

// 个人主页链接
{
  const link = new FakeElement('a', { href: '/u/777' });
  const comment = new FakeElement('div', {}, [link]);
  assert('个人主页链接 /u/', api.extractUidFromComment(comment), 777);
}

// 头像 src 提取（默认模式）
{
  const img = new FakeElement('img', { src: 'https://cdn.acfun.cn/newUpload/567_avatar.jpg' });
  img.className = 'avatar';
  const comment = new FakeElement('div', {}, [img]);
  assert('默认模式头像', api.extractUidFromComment(comment), 567);
}

// 头像 src 提取（盖楼模式）
{
  const img = new FakeElement('img', { src: 'https://cdn.acfun.cn/u/321' });
  img.className = 'fc-avatar';
  const comment = new FakeElement('div', {}, [img]);
  assert('盖楼模式头像', api.extractUidFromComment(comment), 321);
}

// 无法提取
{
  const comment = new FakeElement('div', {});
  assert('无 UID 信息', api.extractUidFromComment(comment), null);
}

// ── 9. parseDeviceModelsText ─────────────────────────────
group('parseDeviceModelsText');
assert('MobileModels 格式',
  api.parseDeviceModelsText('`RMX3700`: 真我 GT Neo5 SE'),
  { RMX3700: '真我 GT Neo5 SE' }
);
assert('一行多个代码',
  api.parseDeviceModelsText('`ALN-AL00` `ALN-AL80`: HUAWEI Mate 60 Pro'),
  { 'ALN-AL00': 'HUAWEI Mate 60 Pro', 'ALN-AL80': 'HUAWEI Mate 60 Pro' }
);
assert('Apple gist 冒号格式',
  api.parseDeviceModelsText('iPhone3,1 : iPhone 4'),
  { 'iPhone3,1': 'iPhone 4' }
);
assert('Apple 空格格式',
  api.parseDeviceModelsText('iPhone3,1 iPhone 4'),
  { 'iPhone3,1': 'iPhone 4' }
);
assert('跳过注释与空行',
  api.parseDeviceModelsText('# 注释\n\n// 斜杠注释\n`RMX3700`: 真我 GT Neo5 SE'),
  { RMX3700: '真我 GT Neo5 SE' }
);
assert('空输入', api.parseDeviceModelsText(''), {});
assert('混合格式多行',
  api.parseDeviceModelsText('`V2324A`: vivo X100 Pro\niPhone3,1 : iPhone 4'),
  { V2324A: 'vivo X100 Pro', 'iPhone3,1': 'iPhone 4' }
);

// ── 10. findFriendlyName ─────────────────────────────────
group('findFriendlyName');
assert('精确匹配 iPhone3,1', api.findFriendlyName('iPhone3,1'), 'iPhone 4');
assert('精确匹配 iPhone14,5', api.findFriendlyName('iPhone14,5'), 'iPhone 13');
assert('大小写不敏感', api.findFriendlyName('rmx3700'), '真我 GT Neo5 SE');
assert('去尾字母匹配 V2324B', api.findFriendlyName('V2324B'), 'vivo X100 Pro');
assert('前缀包含匹配 V2324AX', api.findFriendlyName('V2324AX'), 'vivo X100 Pro');
assert('未收录返回 null', api.findFriendlyName('ZZZZ9999X'), null);
assert('过短返回 null', api.findFriendlyName('ab'), null);
assert('空值返回 null', api.findFriendlyName(''), null);
assert('null 返回 null', api.findFriendlyName(null), null);

// ── 结果 ─────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`通过: ${passed}  失败: ${failed}`);
if (failed) {
  console.error(`${failed} 项未通过`);
  process.exit(1);
}
console.log('全部通过');
process.exit(0);
