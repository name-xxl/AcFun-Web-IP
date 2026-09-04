  // ============================================================
  //  日志
  // ============================================================
  const logs = [];

  const log = (...args) => console.log('%c[AcFunReveal]', 'color:#4caf50;font-weight:bold', ...args);

  const LOG_ICONS = { info: 'ℹ️', success: '✅', error: '❌', warn: '⚠️' };

  function addLog(level, ...args) {
    const message = args.map(x => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ');
    logs.push(`[${new Date().toLocaleTimeString()}] [${level}] ${message}`);
    if (logs.length > CONFIG.CACHE.logLimit) logs.shift();
    log(LOG_ICONS[level] || LOG_ICONS.info, ...args);
  }
