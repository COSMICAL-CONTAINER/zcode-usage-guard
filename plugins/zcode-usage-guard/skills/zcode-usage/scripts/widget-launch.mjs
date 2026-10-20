#!/usr/bin/env node
/**
 * 跨平台悬浮窗启动器(插件 SessionStart hook 每会话调用一次)
 *
 * 按当前设备选择对应 UI 的悬浮窗:
 *   Windows → WPF 半透明卡片(zcode-usage-widget.ps1,经 widget-launch.vbs)
 *   macOS   → 原生 ZCodeUsageHUD.app(需先在 macos/ 目录执行一次 bash build.sh)
 *   其他    → 静默跳过
 *
 * 语义:已有实例在运行时,通过 touch 唤醒文件把它唤回显示(不抢焦点);没有则静默拉起。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));

if (process.platform === 'win32') {
  // 单实例兜底:先清掉历史实例再拉起。互斥量在"多会话钩子并发 + 历史实例被强制结束"的
  // 场景下曾出现双实例共存,两个实例的设置面板互相覆盖对方保存的值,故改为确定性清理
  try {
    const { spawnSync } = await import('node:child_process');
    spawnSync(
      'powershell',
      ['-NoProfile', '-Command',
        "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'powershell.exe' -and $_.CommandLine -like '*zcode-usage-widget.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"],
      { stdio: 'ignore', windowsHide: true, timeoutMs: 15000 },
    );
  } catch { }
  // 等旧进程完全退出(互斥量/句柄释放),再拉起新实例
  {
    const { execSync } = await import('node:child_process');
    try { execSync('ping -n 2 127.0.0.1', { stdio: 'ignore', windowsHide: true }); } catch { }
  }
  // 先 touch 唤醒文件:已在运行的悬浮窗 250ms 内轮询到 mtime 变化即唤回(毫秒级、不再新起 PowerShell)
  const wakeFile = path.join(os.homedir(), '.zcode', 'scripts', 'zcode-usage-widget.wake');
  const now = new Date();
  try { fs.utimesSync(wakeFile, now, now); } catch {
    try { fs.mkdirSync(path.dirname(wakeFile), { recursive: true }); fs.writeFileSync(wakeFile, ''); } catch { }
  }
  // 再拉起 VBS 兜底冷启动:无实例时启动并显示;已有实例在互斥量处快速静默退出(唤醒已由上面的文件完成)
  const vbs = path.join(dir, 'widget-launch.vbs');
  if (fs.existsSync(vbs)) {
    spawn('wscript.exe', [vbs], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }
  process.exit(0);
}

if (process.platform === 'darwin') {
  // macOS:优先找已编译的 ZCodeUsageHUD.app(插件内 build 产物 → 用户/系统应用目录)
  const pluginRoot = path.resolve(dir, '..', '..', '..');
  const candidates = [
    path.join(pluginRoot, 'macos', 'ZCodeUsageHUD.app'),
    path.join(os.homedir(), 'Applications', 'ZCodeUsageHUD.app'),
    path.join('/Applications', 'ZCodeUsageHUD.app'),
  ];
  const app = candidates.find((p) => fs.existsSync(p));
  if (app) {
    // open -g:后台打开,不抢焦点;若已在运行则等价于唤起
    spawn('open', ['-g', app], { detached: true, stdio: 'ignore' }).unref();
  }
  // 未编译时静默跳过——见 macos/README.md,执行一次 bash build.sh 即可
  process.exit(0);
}

process.exit(0);
