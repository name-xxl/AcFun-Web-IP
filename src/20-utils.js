  // ============================================================
  //  日志
  // ============================================================
  const logs = [];
  const DEBUG = false; // 调试模式：设为 true 可输出详细日志

  const log = (...args) => console.log('%c[AcFunReveal]', 'color:#4caf50;font-weight:bold', ...args);

  const LOG_ICONS = { debug: '🔍', info: 'ℹ️', success: '✅', error: '❌', warn: '⚠️' };

  function addLog(level, ...args) {
    const message = args.map(x => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ');
    logs.push(`[${new Date().toLocaleTimeString()}] [${level}] ${message}`);
    if (logs.length > CONFIG.CACHE.logLimit) logs.shift();
    // debug 级别只在调试模式下输出
    if (level === 'debug' && !DEBUG) return;
    log(LOG_ICONS[level] || LOG_ICONS.info, ...args);
  }

  // 导入数据的键可能来自外部 JSON/文本：__proto__ 这类键走原型链 setter，
  // 赋值不会写入自身属性，静默丢失，必须跳过
  function isSafeKey(key) {
    return key !== '__proto__' && key !== 'constructor' && key !== 'prototype';
  }
