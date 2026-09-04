  // ============================================================
  //  油猴菜单（只保留只读入口 + 面板兜底入口）
  // ============================================================
  function registerMenus() {
    if (typeof GM_registerMenuCommand === 'undefined') return;
    const commands = [
      { title: () => '⚙️ 设置面板', run: () => openPanel() },
      { title: () => '📋 复制全部日志', run: copyLogs },
      { title: () => '📊 查看本页缓存', run: copyPageCache },
    ];
    for (const command of commands) GM_registerMenuCommand(command.title(), command.run);
  }
