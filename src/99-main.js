  // ============================================================
  //  启动
  // ============================================================
  enabled = readStorage(CONFIG.CACHE.enabledKey, true);
  days = readStorage(CONFIG.CACHE.daysKey, 0);
  cache = readStorage(CONFIG.CACHE.key, {});
  uids = readStorage(CONFIG.CACHE.uidKey, {});

  pruneExpiredPages();
  save();
  loadPage();
  loadDeviceDB();
  processDeviceModels();

  hookFetch();
  hookXHR();
  startObserver();
  registerMenus();
  setTimeout(onDomChange, CONFIG.OBSERVER.urlChangeDelayMs);
  setTimeout(checkUrl, 100);

  // 暴露纯函数与内部状态，供控制台调试和单元测试使用
  window.ACFunReveal = {
    version: VERSION,
    config: CONFIG,
    // 纯函数（可直接单测）
    extractCommentList,
    extractUidFromComment,
    parseUidFromHref,
    isCommentUrl,
    isFailureCacheFresh,
    findFriendlyName,
    parseDeviceModelsText,
    processDeviceModels,
    importDeviceModels,
    // 内部状态（只读调试用）
    getState: () => ({
      enabled,
      days,
      pageId,
      cachePages: Object.keys(cache).length,
      pageDataSize: Object.keys(pageData).length,
      uidCacheSize: Object.keys(uids).length,
      deviceEnabled: deviceSettings.enabled,
      deviceModels: Object.keys(deviceDB).length,
    }),
    getLogs: () => logs.slice(),
  };

  log(`🚀 AcFunReveal v${VERSION} | ${pageId || '无缓存'} | ${enabled ? describeDays() : '关闭'} | ${Object.keys(pageData).length}条 | 设备库 ${Object.keys(deviceDB).length} 条${deviceSettings.enabled ? '' : ' (美化关闭)'}`);
})();
