  // ============================================================
  //  设备型号美化：把评论设备标签里的内部代号换成友好名称
  //  A 站会显示 RMX3619 / iPhone3,1 等代号，这里查表转换为"真我 V30"等
  //  内置表见 55-device-data.js（由 tools/gen-device-data.js 生成），
  //  用户可在面板导入 MobileModels 的 .md / Apple 表 .txt 扩充
  // ============================================================
  let deviceDB = {};
  let deviceSettings = { enabled: true, clickToToggle: true };

  const deviceIndexExact = new Map();   // 精确索引: code → name
  const deviceIndexUpper = new Map();   // 大写索引: CODE → name
  const deviceIndexBase = new Map();    // 去尾字母索引: V1821A → V1821
  const deviceIndexPrefix = new Map();  // 前缀索引: prefix → [{code, name}]
  const deviceSearchCache = new Map();  // 查找结果缓存（含未命中的 null）

  function loadDeviceDB() {
    deviceSettings = { ...deviceSettings, ...readStorage(CONFIG.DEVICE.settingsKey, {}) };
    const saved = readStorage(CONFIG.DEVICE.storageKey, null);
    deviceDB = (saved && typeof saved === 'object' && Object.keys(saved).length > 0)
      ? saved
      : { ...DEVICE_BUILTIN };
    buildDeviceIndexes();
    addLog('info', `📱 设备型号库: ${Object.keys(deviceDB).length} 条`);
  }

  function saveDeviceDB() {
    writeStorage(CONFIG.DEVICE.storageKey, deviceDB);
    writeStorage(CONFIG.DEVICE.metaKey, {
      count: Object.keys(deviceDB).length,
      lastUpdate: new Date().toISOString(),
    });
    buildDeviceIndexes();
  }

  function buildDeviceIndexes() {
    deviceIndexExact.clear();
    deviceIndexUpper.clear();
    deviceIndexBase.clear();
    deviceIndexPrefix.clear();
    deviceSearchCache.clear();

    for (const [code, name] of Object.entries(deviceDB)) {
      deviceIndexExact.set(code, name);
      const upper = code.toUpperCase();
      if (!deviceIndexUpper.has(upper)) deviceIndexUpper.set(upper, name);
      // 去掉末尾单个字母：V1821A → V1821（覆盖 A/B 区分的市场变体）
      const base = code.replace(/[A-Za-z]$/, '');
      if (base.length >= 3 && base !== code && !deviceIndexBase.has(base)) {
        deviceIndexBase.set(base, name);
        const baseUpper = base.toUpperCase();
        if (!deviceIndexBase.has(baseUpper)) deviceIndexBase.set(baseUpper, name);
      }
      for (let len = 4; len <= Math.min(6, code.length); len++) {
        const prefix = code.substring(0, len).toUpperCase();
        if (!deviceIndexPrefix.has(prefix)) deviceIndexPrefix.set(prefix, []);
        deviceIndexPrefix.get(prefix).push({ code, name });
      }
    }
  }

  function cacheDeviceResult(code, result) {
    if (deviceSearchCache.size >= CONFIG.DEVICE.cacheMaxSize) {
      // 淘汰最早写入的 20%，避免每次全量清理
      const drop = Math.floor(CONFIG.DEVICE.cacheMaxSize * 0.2);
      const keys = deviceSearchCache.keys();
      for (let i = 0; i < drop; i++) deviceSearchCache.delete(keys.next().value);
    }
    deviceSearchCache.set(code, result);
  }

  // 四级匹配：精确 → 大小写不敏感 → 去尾字母 → 前缀包含
  function findFriendlyName(code) {
    if (!code || code.length < 3) return null;
    if (deviceSearchCache.has(code)) return deviceSearchCache.get(code);

    let result = deviceIndexExact.get(code);
    if (!result) result = deviceIndexUpper.get(code.toUpperCase());
    if (!result) {
      const base = code.replace(/[A-Za-z]$/, '');
      if (base.length >= 3 && base !== code) {
        result = deviceIndexBase.get(base) || deviceIndexBase.get(base.toUpperCase());
      }
    }
    if (!result) {
      for (let len = Math.min(6, code.length); len >= 4 && !result; len--) {
        const candidates = deviceIndexPrefix.get(code.substring(0, len).toUpperCase());
        if (!candidates) continue;
        for (const { code: k, name: v } of candidates) {
          if (k.includes(code) || code.includes(k)) { result = v; break; }
        }
      }
    }
    cacheDeviceResult(code, result || null);
    return result || null;
  }

  // 解析导入文本，支持三种格式：
  // ① MobileModels: `RMX3700`: 真我 GT Neo5 SE（可一行多个代码）
  // ② Apple gist:   iPhone3,1 : iPhone 4
  // ③ Apple 无冒号:  iPhone3,1 iPhone 4（仅 Apple 前缀行）
  function parseDeviceModelsText(text) {
    const models = {};
    for (const raw of String(text).split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith('//')) continue;

      let m = line.match(/^((?:`[^`]+`\s*)+):\s*(.+?)\s*$/);
      if (m) {
        const name = m[2].trim();
        for (const code of [...m[1].matchAll(/`([^`]+)`/g)].map(x => x[1])) {
          if (code && name) models[code] = name;
        }
        continue;
      }

      m = line.match(/^([A-Za-z0-9_,.\-]+(?:\s+[A-Za-z0-9_,.\-]+)*)\s*:\s*(.+?)\s*$/);
      if (m) {
        const code = m[1].trim();
        const name = m[2].trim();
        if (code && name && code.length >= 2) models[code] = name;
        continue;
      }

      if (/^(iPhone|iPad|iPod|Watch|Mac|Apple)[\d,]/i.test(line)) {
        const spaceIdx = line.indexOf(' ');
        if (spaceIdx > 0) {
          const code = line.substring(0, spaceIdx).trim();
          const name = line.substring(spaceIdx + 1).trim();
          if (code && name) models[code] = name;
        }
      }
    }
    return models;
  }

  // 导入合并。skipExisting=true 时已存在的代号不覆盖
  function importDeviceModels(entries, skipExisting) {
    let added = 0;
    let skipped = 0;
    for (const [code, name] of Object.entries(entries)) {
      if (!code || !name || !isSafeKey(code)) continue;
      if (deviceDB[code] && skipExisting) { skipped++; continue; }
      deviceDB[code] = name;
      added++;
    }
    if (added) saveDeviceDB();
    return { added, skipped };
  }

  function exportDeviceDB() {
    GM_setClipboard?.(JSON.stringify(deviceDB, null, 2), 'text');
    showToast(`已复制 ${Object.keys(deviceDB).length} 条设备型号数据`);
  }

  // 重置为内置表（导入的数据清掉，避免误操作不可恢复）
  function resetDeviceDB(btn) {
    if (btn.dataset.acrConfirming) {
      delete btn.dataset.acrConfirming;
      deviceDB = { ...DEVICE_BUILTIN };
      saveDeviceDB();
      btn.textContent = '重置';
      processDeviceModels();
      showToast(`已重置为内置数据（${Object.keys(deviceDB).length} 条）`);
      return;
    }
    btn.dataset.acrConfirming = '1';
    btn.textContent = '确认重置?';
    setTimeout(() => { delete btn.dataset.acrConfirming; if (btn.isConnected) btn.textContent = '重置'; }, 3000);
  }

  // ============================================================
  //  DOM 处理：替换 .deviceModel 文本，点击可切换回原始显示
  //  A 站可能原地重渲染（元素保留、文本被重置回代号），所以不能只靠
  //  "处理过就跳过"：文本不再等于替换后的名称时需要重新替换；
  //  用户手动点击切换的（manual 标记）尊重其选择不再动
  // ============================================================
  function handleDeviceToggleClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    const showingFriendly = el.textContent === (el.dataset.friendly || '');
    el.textContent = showingFriendly ? (el.dataset.original || '') : (el.dataset.friendly || '');
    el.setAttribute(CONFIG.DEVICE.manualAttr, '1');
    el.title = showingFriendly
      ? `原始型号: ${el.dataset.original || ''}\n点击可切换显示`
      : `${el.dataset.friendly || ''}\n点击可切换显示`;
  }

  function processDeviceModels() {
    if (!deviceSettings.enabled) return;
    const elements = document.querySelectorAll(CONFIG.DEVICE.selector);
    if (!elements.length) return;

    let replaced = 0;
    for (const el of elements) {
      if (el.hasAttribute(CONFIG.DEVICE.manualAttr)) continue;
      const text = (el.textContent || '').trim();
      if (!text) continue;
      if (el.dataset.friendly && text === el.dataset.friendly) continue;
      // 设备标签形如 "realme RMX3619"，取最后一段作为代号
      const code = text.split(/\s+/).pop();
      const friendly = findFriendlyName(code);
      if (!friendly) continue;

      el.setAttribute(CONFIG.DEVICE.processedAttr, '1');
      el.dataset.original = text;
      el.dataset.friendly = friendly;
      el.title = `原始型号: ${text}\n点击可切换显示`;
      el.textContent = friendly;
      el.style.cursor = 'pointer';
      if (deviceSettings.clickToToggle && !el._acrDeviceBound) {
        el._acrDeviceBound = true;
        el.addEventListener('click', handleDeviceToggleClick);
      }
      replaced++;
      addLog('debug', `📱 ${text} → ${friendly}`);
    }
    if (replaced) addLog('debug', `📱 设备型号替换 ${replaced} 个`);
  }

  // 清除替换与手动切换标记，全部按当前文本重新匹配
  function forceReprocessDevices() {
    document.querySelectorAll(`[${CONFIG.DEVICE.processedAttr}], [${CONFIG.DEVICE.manualAttr}]`).forEach(el => {
      el.removeAttribute(CONFIG.DEVICE.processedAttr);
      el.removeAttribute(CONFIG.DEVICE.manualAttr);
      delete el.dataset.friendly;
      delete el.dataset.original;
    });
    deviceSearchCache.clear();
    processDeviceModels();
    showToast('设备型号已重新处理');
  }

  // ============================================================
  //  面板：设备型号区块（开关 + 数据管理 + 导入视图）
  // ============================================================
  function buildDeviceRows(body) {
    const row = document.createElement('div');
    row.className = 'acr-row';
    const label = document.createElement('span');
    label.textContent = '设备型号美化';
    const toggle = document.createElement('span');
    toggle.className = 'acr-switch' + (deviceSettings.enabled ? ' on' : '');
    toggle.addEventListener('click', () => {
      deviceSettings.enabled = !deviceSettings.enabled;
      writeStorage(CONFIG.DEVICE.settingsKey, deviceSettings);
      toggle.classList.toggle('on', deviceSettings.enabled);
      showToast(deviceSettings.enabled ? '设备型号美化已开启' : '设备型号美化已关闭');
      if (deviceSettings.enabled) processDeviceModels();
    });
    row.append(label, toggle);
    body.appendChild(row);

    const dataRow = document.createElement('div');
    dataRow.className = 'acr-row';
    const dataLabel = document.createElement('span');
    dataLabel.textContent = `设备数据 ${Object.keys(deviceDB).length} 条`;
    const dataActions = document.createElement('span');
    dataActions.className = 'acr-actions';
    dataActions.append(
      mkPanelBtn('导入', openDeviceImport),
      mkPanelBtn('导出', exportDeviceDB),
      mkPanelBtn('重置', function () { resetDeviceDB(this); }, 'acr-danger'),
    );
    dataRow.append(dataLabel, dataActions);
    body.appendChild(dataRow);
  }

  // 与 IP 缓存导入同一套交互：临时替换面板内容，完成后重建面板
  function openDeviceImport() {
    const panel = document.querySelector('.acr-panel');
    if (!panel) return;
    const body = panel.querySelector('.acr-panel-body');
    body.innerHTML = `
      <div style="margin:8px 0 4px">
        <div style="font-size:13px;color:#333;margin-bottom:6px">选择文件（.md / .txt，可多选）或粘贴文本：</div>
        <input type="file" accept=".md,.txt" multiple class="acr-device-file"
          style="width:100%;padding:6px;border:1px dashed #e5e5e5;border-radius:3px;font-size:12px;box-sizing:border-box">
        <textarea class="acr-device-input" rows="5" placeholder='支持格式：
① \`RMX3700\`: 真我 GT Neo5 SE
② iPhone3,1 : iPhone 4'
          style="width:100%;margin-top:6px;resize:vertical;border:1px solid #e5e5e5;border-radius:3px;padding:6px;font:12px/1.4 monospace;color:#333;box-sizing:border-box"></textarea>
        <label style="display:flex;align-items:center;gap:6px;margin-top:6px;cursor:pointer">
          <input type="checkbox" class="acr-device-skip" checked>
          <span style="font-size:12px">跳过已存在的型号（不覆盖）</span>
        </label>
      </div>
      <div style="display:flex;gap:6px;justify-content:flex-end;margin-top:8px">
        <button class="acr-device-cancel" style="border:1px solid #999;background:#f4f4f4;color:#666;font-size:12px;padding:3px 12px;border-radius:3px;cursor:pointer">取消</button>
        <button class="acr-device-confirm" style="border:none;background:#fd4c5d;color:#fff;font-size:12px;padding:3px 12px;border-radius:3px;cursor:pointer">导入</button>
      </div>`;

    body.querySelector('.acr-device-cancel').addEventListener('click', () => openPanel());
    body.querySelector('.acr-device-confirm').addEventListener('click', async () => {
      const entries = {};
      for (const file of body.querySelector('.acr-device-file').files) {
        try {
          Object.assign(entries, parseDeviceModelsText(await file.text()));
        } catch (e) {
          addLog('warn', `读取文件失败: ${file.name}`, e.message);
        }
      }
      const pasted = body.querySelector('.acr-device-input').value.trim();
      if (pasted) Object.assign(entries, parseDeviceModelsText(pasted));

      const total = Object.keys(entries).length;
      if (!total) { showToast('❌ 未解析出有效数据，请检查文件格式'); return; }

      const skip = body.querySelector('.acr-device-skip').checked;
      const { added, skipped } = importDeviceModels(entries, skip);
      addLog('info', `📱 设备数据导入: 新增 ${added}，跳过 ${skipped}`);
      showToast(`导入 ${added} 条，跳过 ${skipped} 条，共 ${Object.keys(deviceDB).length} 条`);
      processDeviceModels();
      openPanel();
    });
  }
