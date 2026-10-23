# GLM Coding Plan 桌面悬浮窗(Windows PowerShell 5.1+,零依赖)
# UI 逐项照抄 macOS ZCodeUsageHUD 规格:372 宽 / 18 内边距 / 16 圆角 / 6px 胶囊进度条 / macOS 标签色阶梯
# 配色与 ZCode 外观主题保持一致(探测 ZCode 窗口实际配色,深浅同步);ZCODE_WIDGET_THEME=light|dark 可强制
# 高峰期提醒横幅(周一至周五 14:00–18:00 常驻);调试:ZCODE_WIDGET_PEAK=on 强制显示,ZCODE_WIDGET_PEAK_SHIFT=<小时数> 平移模拟时钟
# 生命周期与插件绑定:由插件 SessionStart hook 拉起,插件卸载(本脚本被删)后自动退出
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

# 单实例保护 + 唤醒通道:必须放在 Add-Type/XAML 等耗时初始化之前,
# 否则主实例启动头几秒内到达的唤醒信号(事件尚未创建/轮询尚未开始)会被静默丢弃
$mutex = New-Object System.Threading.Mutex($false, 'Global\ZCode-Usage-Widget')
$ownsMutex = $false
try { $ownsMutex = $mutex.WaitOne(0) } catch { $ownsMutex = $true }
if (-not $ownsMutex) {
  if ($args -notcontains 'NoShowIfExists') {
    # 手动再次启动:唤醒已有窗口(事件由主实例拿到互斥量后立即创建,无需重试)
    try { [System.Threading.EventWaitHandle]::OpenExisting('Global\ZCode-Usage-Widget-Show').Set() | Out-Null } catch { }
  }
  exit
}
# 主实例:立即创建唤醒事件(initialState=false,不会误触发)
$showEvt = New-Object System.Threading.EventWaitHandle($false, [System.Threading.EventResetMode]::AutoReset, 'Global\ZCode-Usage-Widget-Show')

# 唤醒文件:SessionStart hook(新会话)touch 一次,运行中的实例轮询到 mtime 变化即唤回
$wakeFile = Join-Path $env:USERPROFILE '.zcode\scripts\zcode-usage-widget.wake'
$script:lastWake = if (Test-Path $wakeFile) { (Get-Item $wakeFile).LastWriteTimeUtc } else { [datetime]::MinValue }

# 错误/慢刷新日志:任何异常与超慢刷新都追加到 widget-error.log,用于排查"悬浮窗消失/未响应"
$script:errorLog = Join-Path $env:USERPROFILE '.zcode\scripts\widget-error.log'
function Write-WidgetLog([string]$msg) {
  try {
    # 简单轮转:超过 512KB 归档为 .old,防止诊断噪音无上限增长
    if ((Test-Path $script:errorLog) -and ((Get-Item $script:errorLog -ErrorAction Stop).Length -gt 512KB)) {
      Move-Item -Force -Path $script:errorLog -Destination ($script:errorLog + '.old') -ErrorAction Stop
    }
    Add-Content -Path $script:errorLog -Value ('{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'), $msg) -Encoding UTF8 -ErrorAction Stop
  } catch { }
}

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
Add-Type -Namespace GLMNative -Name Hotkey -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
[DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
'@
# 磨砂玻璃背景(Windows BlurBehind + 浅黑色调)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class GLMComposition {
  [StructLayout(LayoutKind.Sequential)]
  public struct AccentPolicy { public int AccentState; public int AccentFlags; public uint GradientColor; public int AnimationId; }
  [StructLayout(LayoutKind.Sequential)]
  public struct WCAD { public int Attrib; public IntPtr Data; public int SizeOfData; }
  [DllImport("user32.dll")]
  public static extern int SetWindowCompositionAttribute(IntPtr hwnd, ref WCAD data);
  public static bool EnableBlur(IntPtr hwnd, int gradient) {
    // GradientColor 是 DWORD(0xAABBGGRR):PS 里带高 alpha 位的颜色是负 Int32,
    // 用 uint 参数会在调用方转换阶段抛异常(悬浮窗凭空消失的真凶),这里统一 unchecked 收编
    uint g = unchecked((uint)gradient);
    var ap = new AccentPolicy { AccentState = 3, AccentFlags = 2, GradientColor = g };
    IntPtr p = Marshal.AllocHGlobal(Marshal.SizeOf(ap));
    Marshal.StructureToPtr(ap, p, false);
    var d = new WCAD { Attrib = 19, Data = p, SizeOfData = Marshal.SizeOf(ap) };
    int r = SetWindowCompositionAttribute(hwnd, ref d);
    Marshal.FreeHGlobal(p);
    return r != 0;
  }
}
'@

# ZCode 窗口像素探测:PrintWindow 截 ZCode 主窗口,采样最左侧栏亮度判断深浅
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace GLMNative -Name ZCodeProbe -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
'@

$scriptPath = Join-Path $env:USERPROFILE '.zcode\scripts\zcode-usage.mjs'
if (-not (Test-Path $scriptPath)) {
  $cached = Get-ChildItem "$env:USERPROFILE\.zcode\cli\plugins\cache\*\zcode-usage*\*\skills\zcode-usage\scripts\zcode-usage.mjs" |
    Sort-Object FullName -Descending | Select-Object -First 1
  if ($cached) { $scriptPath = $cached.FullName }
}

# node 解析:悬浮窗是独立进程,PATH 可能不完整;找不到 node 时探测常见安装位置,
# 全部失败则刷新时给出明确提示(而不是统一落到"查询失败"难以定位)
function Resolve-NodeExe {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) { return $cmd.Source }
  foreach ($cand in @(
    "$env:ProgramFiles\nodejs\node.exe",
    "${env:ProgramFiles(x86)}\nodejs\node.exe",
    "$env:ProgramW6432\nodejs\node.exe",
    "$env:LOCALAPPDATA\Programs\nodejs\node.exe",
    "D:\Node.js\node.exe"
  )) {
    if ($cand -and (Test-Path $cand)) { return $cand }
  }
  return $null
}
$script:nodeExe = Resolve-NodeExe

# —— 以下 XAML 与 ZCodeUsageHUD.swift 的 HUDMetrics/HUDContentView 布局一一对应 ——
# 面板 372 宽(高自适应,官方公式约 306;底部当日 高峰/非高峰 明细两行后约 330);pad 18;圆角 16;边框白 10%
# 字号阶梯:标题 14 bold / meta 10.5 / 行标题 12.5 semibold / 行数值 12 / sub 10.5 / footer 11.5 / hint 10
# 颜色(macOS 暗色标签阶梯):labelColor 白 / secondary 白65% / tertiary 白50% / quaternary 白30%
$xamlText = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="ZCode Usage" Topmost="True" WindowStyle="None" AllowsTransparency="True"
        Background="Transparent" ShowInTaskbar="False" ResizeMode="NoResize" ShowActivated="False"
        Width="372" SizeToContent="Height">
  <Window.Resources>
    <!-- 配色走 DynamicResource,Apply-Theme 按系统浅色/深色整体切换(对齐 macOS 版材质策略) -->
    <SolidColorBrush x:Key="LabelBrush" Color="#FFFFFF"/>
    <SolidColorBrush x:Key="SecondaryBrush" Color="#A6FFFFFF"/>
    <SolidColorBrush x:Key="ValueBrush" Color="#8CFFFFFF"/>
    <SolidColorBrush x:Key="TertiaryBrush" Color="#80FFFFFF"/>
    <SolidColorBrush x:Key="QuaternaryBrush" Color="#24FFFFFF"/>
    <SolidColorBrush x:Key="TrackBrush" Color="#24FFFFFF"/>
    <SolidColorBrush x:Key="SeparatorBrush" Color="#2EFFFFFF"/>
    <SolidColorBrush x:Key="BorderBrushR" Color="#1AFFFFFF"/>
    <SolidColorBrush x:Key="RootBgBrush" Color="#E014171C"/>
  </Window.Resources>
  <Border x:Name="Root" CornerRadius="16" Background="{DynamicResource RootBgBrush}" BorderBrush="{DynamicResource BorderBrushR}" BorderThickness="1"
          Margin="10" Padding="18">
    <StackPanel>
      <!-- 标题行:y=pad-2,h20;按钮 13pt medium secondaryLabel -->
      <Grid Height="20">
        <TextBlock Text="⚡ GLM Coding Plan" FontSize="14" FontWeight="Bold" Foreground="{DynamicResource LabelBrush}"
                   VerticalAlignment="Center"/>
        <StackPanel Orientation="Horizontal" HorizontalAlignment="Right" VerticalAlignment="Center">
          <TextBlock x:Name="BtnSettings" Text="⚙" FontSize="13" Foreground="{DynamicResource SecondaryBrush}" Cursor="Hand"
                     ToolTip="设置(刷新间隔 / 快捷键 / 各池告警阈值)" Margin="0,0,12,0"/>
          <TextBlock x:Name="BtnRefresh" Text="↻" FontSize="13" Foreground="{DynamicResource SecondaryBrush}" Cursor="Hand"
                     ToolTip="立即刷新" Margin="0,0,12,0"/>
          <TextBlock x:Name="BtnClose" Text="✕" FontSize="13" FontWeight="Medium" Foreground="{DynamicResource SecondaryBrush}"
                     Cursor="Hand" ToolTip="收起面板(Ctrl+G 唤回)"/>
        </StackPanel>
      </Grid>
      <!-- meta:14 高,+12 -->
      <TextBlock x:Name="Meta" Text="正在读取…" FontSize="10.5" Foreground="{DynamicResource TertiaryBrush}" Margin="0,1,0,12"/>

      <!-- 🔑 手动配置 API Key(查询失败兜底,与 macOS HUD 同布局):服务商下拉 + 粘贴 Key -->
      <StackPanel x:Name="SetupPanel" Visibility="Collapsed">
        <TextBlock Text="🔑 手动配置 API Key" FontSize="13" FontWeight="SemiBold" Foreground="{DynamicResource LabelBrush}"/>
        <TextBlock Text="未自动找到 Coding Plan 凭据,填一次即可,仅保存在本机" FontSize="10.5" Foreground="{DynamicResource TertiaryBrush}" Margin="0,3,0,12"/>
        <TextBlock Text="服务商" FontSize="11" FontWeight="Medium" Foreground="{DynamicResource LabelBrush}"/>
        <ComboBox x:Name="SetupBase" Height="24" FontSize="11.5" Margin="0,4,0,10">
          <ComboBoxItem Content="智谱开放平台（bigmodel.cn）" IsSelected="True"/>
          <ComboBoxItem Content="智谱国际（z.ai）"/>
        </ComboBox>
        <TextBlock Text="API Key" FontSize="11" FontWeight="Medium" Foreground="{DynamicResource LabelBrush}"/>
        <PasswordBox x:Name="SetupKey" Height="24" FontSize="12" Margin="0,4,0,12" ToolTip="粘贴 API Key 后回车,或点「保存并查询」"/>
        <StackPanel Orientation="Horizontal">
          <Border x:Name="BtnSaveKey" CornerRadius="6" Background="#0A84FF" Padding="14,5" Cursor="Hand" Margin="0,0,10,0">
            <TextBlock Text="保存并查询" FontSize="11.5" FontWeight="SemiBold" Foreground="White"/>
          </Border>
          <Border x:Name="BtnClearKey" CornerRadius="6" Background="{DynamicResource TrackBrush}" Padding="12,5" Cursor="Hand"
                  ToolTip="删掉已保存的 Key,恢复自动探测 ZCode 配置">
            <TextBlock Text="清除已存 Key" FontSize="11" Foreground="{DynamicResource SecondaryBrush}"/>
          </Border>
        </StackPanel>
        <TextBlock x:Name="SetupHint" Text="Key 来自智谱开放平台「API Keys」页;ZCode 用户也可在 ZCode 模型设置中查看"
                   FontSize="10" Foreground="{DynamicResource QuaternaryBrush}" Margin="0,12,0,0" TextWrapping="Wrap"/>
      </StackPanel>

      <!-- ⚙ 设置面板:显示格式 / 常规 / 额度告警(保存到 quota-guard-settings.json,与 guard 共用);各项说明见名字后的 ? -->
      <StackPanel x:Name="SettingsPanel" Visibility="Collapsed">
        <TextBlock Text="⚙ 设置" FontSize="13" FontWeight="SemiBold" Foreground="{DynamicResource LabelBrush}" Margin="0,0,0,4"/>
        <!-- 分组框:一种设置一类;? 悬浮显示该项说明 -->
        <Border CornerRadius="10" BorderBrush="{DynamicResource BorderBrushR}" BorderThickness="1" Padding="12,10" Margin="0,4,0,0">
          <StackPanel>
            <TextBlock Text="显示格式" FontSize="10.5" FontWeight="SemiBold" Foreground="{DynamicResource QuaternaryBrush}" Margin="0,0,0,4"/>
            <Grid Height="26">
              <StackPanel Orientation="Horizontal" VerticalAlignment="Center">
                <TextBlock Text="模型名" FontSize="11.5" Foreground="{DynamicResource SecondaryBrush}" VerticalAlignment="Center"/>
                <TextBlock Text=" ?" FontSize="10.5" FontWeight="Bold" Foreground="#0A84FF" Cursor="Hand" VerticalAlignment="Center"
                           ToolTip="完整:GLM-5.3-flashx;短名:5.3-flashx(去掉 GLM- 前缀更省宽度)"/>
              </StackPanel>
              <ComboBox x:Name="SetModelName" Width="150" Height="24" FontSize="11.5" HorizontalAlignment="Right" VerticalAlignment="Center">
                <ComboBoxItem Content="完整 GLM-5.3-flashx"/>
                <ComboBoxItem Content="短名 5.3-flashx"/>
              </ComboBox>
            </Grid>
            <Grid Height="26" Margin="0,8,0,0">
              <StackPanel Orientation="Horizontal" VerticalAlignment="Center">
                <TextBlock Text="用量数字" FontSize="11.5" Foreground="{DynamicResource SecondaryBrush}" VerticalAlignment="Center"/>
                <TextBlock Text=" ?" FontSize="10.5" FontWeight="Bold" Foreground="#0A84FF" Cursor="Hand" VerticalAlignment="Center"
                           ToolTip="窗口内所有 token 数的格式:53.4M=紧凑,53,452,123=完整,5345.2万=中文"/>
              </StackPanel>
              <ComboBox x:Name="SetNumFmt" Width="150" Height="24" FontSize="11.5" HorizontalAlignment="Right" VerticalAlignment="Center">
                <ComboBoxItem Content="紧凑 53.4M"/>
                <ComboBoxItem Content="完整 53,452,123"/>
                <ComboBoxItem Content="中文 5345.2 万"/>
              </ComboBox>
            </Grid>
          </StackPanel>
        </Border>
        <Border CornerRadius="10" BorderBrush="{DynamicResource BorderBrushR}" BorderThickness="1" Padding="12,10" Margin="0,10,0,0">
          <StackPanel>
            <TextBlock Text="常规" FontSize="10.5" FontWeight="SemiBold" Foreground="{DynamicResource QuaternaryBrush}" Margin="0,0,0,4"/>
            <Grid Height="26">
              <StackPanel Orientation="Horizontal" VerticalAlignment="Center">
                <TextBlock Text="自动刷新间隔" FontSize="11.5" Foreground="{DynamicResource SecondaryBrush}" VerticalAlignment="Center"/>
                <TextBlock Text=" ?" FontSize="10.5" FontWeight="Bold" Foreground="#0A84FF" Cursor="Hand" VerticalAlignment="Center"
                           ToolTip="后台查询官方套餐用量的频率"/>
              </StackPanel>
              <ComboBox x:Name="SetRefresh" Width="110" Height="24" FontSize="11.5" HorizontalAlignment="Right" VerticalAlignment="Center">
                <ComboBoxItem Content="1 分钟"/>
                <ComboBoxItem Content="5 分钟"/>
                <ComboBoxItem Content="10 分钟"/>
                <ComboBoxItem Content="15 分钟"/>
                <ComboBoxItem Content="30 分钟"/>
              </ComboBox>
            </Grid>
            <Grid Height="26" Margin="0,8,0,0">
              <StackPanel Orientation="Horizontal" VerticalAlignment="Center">
                <TextBlock Text="唤出快捷键" FontSize="11.5" Foreground="{DynamicResource SecondaryBrush}" VerticalAlignment="Center"/>
                <TextBlock Text=" ?" FontSize="10.5" FontWeight="Bold" Foreground="#0A84FF" Cursor="Hand" VerticalAlignment="Center"
                           ToolTip="全局热键:任何界面按它收起/唤出悬浮窗"/>
              </StackPanel>
              <StackPanel Orientation="Horizontal" HorizontalAlignment="Right" VerticalAlignment="Center">
                <ComboBox x:Name="SetHotkeyMod" Width="76" Height="24" FontSize="11.5" Margin="0,0,8,0">
                  <ComboBoxItem Content="Ctrl"/>
                  <ComboBoxItem Content="Alt"/>
                  <ComboBoxItem Content="Shift"/>
                  <ComboBoxItem Content="Win"/>
                </ComboBox>
                <ComboBox x:Name="SetHotkeyKey" Width="76" Height="24" FontSize="11.5"/>
              </StackPanel>
            </Grid>
        <Grid Height="26" Margin="0,8,0,0">
          <StackPanel Orientation="Horizontal" VerticalAlignment="Center">
            <TextBlock Text="手动凭据" FontSize="11.5" Foreground="{DynamicResource SecondaryBrush}" VerticalAlignment="Center"/>
            <TextBlock Text=" ?" FontSize="10.5" FontWeight="Bold" Foreground="#0A84FF" Cursor="Hand" VerticalAlignment="Center"
                       ToolTip="查询失败或想手动指定服务商/Key 时使用;只存本机,悬浮窗与终端 CLI 共用"/>
          </StackPanel>
          <Border x:Name="BtnOpenSetup" CornerRadius="6" Background="{DynamicResource TrackBrush}" Padding="10,4" Cursor="Hand" HorizontalAlignment="Right" VerticalAlignment="Center">
            <TextBlock Text="🔑 配置 API Key…" FontSize="11" Foreground="{DynamicResource SecondaryBrush}"/>
          </Border>
        </Grid>
            <Grid Height="26" Margin="0,8,0,0">
              <StackPanel Orientation="Horizontal" VerticalAlignment="Center">
                <TextBlock Text="额度采样记录" FontSize="11.5" Foreground="{DynamicResource SecondaryBrush}" VerticalAlignment="Center"/>
                <TextBlock Text=" ?" FontSize="10.5" FontWeight="Bold" Foreground="#0A84FF" Cursor="Hand" VerticalAlignment="Center"
                           ToolTip="开启后每次成功查询把五小时池水位存入本地历史(~/.zcode/scripts/quota-samples.jsonl),📈 历史曲线才有数据;默认关——普通用户只查不记,零写盘"/>
              </StackPanel>
              <CheckBox x:Name="SetSamples" HorizontalAlignment="Right" VerticalAlignment="Center"/>
            </Grid>
          </StackPanel>
        </Border>
        <Border CornerRadius="10" BorderBrush="{DynamicResource BorderBrushR}" BorderThickness="1" Padding="12,10" Margin="0,10,0,0">
          <StackPanel>
            <CheckBox x:Name="SetAlertsOn" Content="额度告警" FontSize="10.5" FontWeight="SemiBold" Foreground="{DynamicResource QuaternaryBrush}" Margin="0,0,0,4">
              <CheckBox.ToolTip>
                <ToolTip MaxWidth="320">
                  <TextBlock TextWrapping="Wrap" Text="总开关(权限层级):关闭后,下面的阈值告警、会话注入、自动续跑三项全部锁定且不生效——无论它们各自的勾选状态,一键静默所有额度相关的主动介入。重新勾选后,各项按其勾选状态恢复生效。"/>
                </ToolTip>
              </CheckBox.ToolTip>
            </CheckBox>
            <StackPanel x:Name="AlertsPanel">
              <Grid Height="26">
                <StackPanel Orientation="Horizontal" VerticalAlignment="Center">
                  <TextBlock Text="5小时池阈值" FontSize="11.5" Foreground="{DynamicResource SecondaryBrush}" VerticalAlignment="Center"/>
                  <TextBlock Text=" ?" FontSize="10.5" FontWeight="Bold" Foreground="#0A84FF" Cursor="Hand" VerticalAlignment="Center"
                             ToolTip="该池「已用比例」达到阈值时告警;选「关闭」= 不监控该池"/>
                </StackPanel>
                <ComboBox x:Name="SetTh5h" Width="110" Height="24" FontSize="11.5" HorizontalAlignment="Right" VerticalAlignment="Center">
                  <ComboBoxItem Content="关闭"/>
                  <ComboBoxItem Content="80%"/>
                  <ComboBoxItem Content="85%"/>
                  <ComboBoxItem Content="90%"/>
                  <ComboBoxItem Content="95%"/>
                </ComboBox>
              </Grid>
              <Grid Height="26" Margin="0,8,0,0">
                <TextBlock Text="每周额度阈值" FontSize="11.5" Foreground="{DynamicResource SecondaryBrush}" VerticalAlignment="Center"/>
                <ComboBox x:Name="SetThWeekly" Width="110" Height="24" FontSize="11.5" HorizontalAlignment="Right" VerticalAlignment="Center">
                  <ComboBoxItem Content="关闭"/>
                  <ComboBoxItem Content="80%"/>
                  <ComboBoxItem Content="85%"/>
                  <ComboBoxItem Content="90%"/>
                  <ComboBoxItem Content="95%"/>
                </ComboBox>
              </Grid>
              <Grid Height="26" Margin="0,8,0,0">
                <TextBlock Text="MCP月度阈值" FontSize="11.5" Foreground="{DynamicResource SecondaryBrush}" VerticalAlignment="Center"/>
                <ComboBox x:Name="SetThMcp" Width="110" Height="24" FontSize="11.5" HorizontalAlignment="Right" VerticalAlignment="Center">
                  <ComboBoxItem Content="关闭"/>
                  <ComboBoxItem Content="80%"/>
                  <ComboBoxItem Content="85%"/>
                  <ComboBoxItem Content="90%"/>
                  <ComboBoxItem Content="95%"/>
                </ComboBox>
              </Grid>
            </StackPanel>
            <CheckBox x:Name="SetSessionInject" Content="会话启动注入用量摘要" FontSize="11.5" Foreground="{DynamicResource SecondaryBrush}" Margin="0,10,0,0">
              <CheckBox.ToolTip>
                <ToolTip MaxWidth="320">
                  <TextBlock TextWrapping="Wrap" Text="开启后,每次新会话开始时把「5小时池/每周/MCP 余量+重置时间」注入对话上下文,模型能主动感知额度、在额度紧张时主动提醒你。下次新会话生效;默认关闭,对对话零打扰。受上面「额度告警」总开关控制:总开关关闭时本项锁定且不生效。"/>
                </ToolTip>
              </CheckBox.ToolTip>
            </CheckBox>
            <CheckBox x:Name="SetResumeGuard" Content="对话收尾自动续跑(登记制)" FontSize="11.5" Foreground="{DynamicResource SecondaryBrush}" Margin="0,10,0,0">
              <CheckBox.ToolTip>
                <ToolTip MaxWidth="320">
                  <TextBlock TextWrapping="Wrap" Text="「额度守卫」的核心功能:对登记了守卫的会话,在对话收尾(Stop)时检查额度——若任一额度池已超阈值,自动保存当前工作进度、写入续跑标记(resume-armed.flag),并布置看门狗定时任务,等额度重置后自动唤醒会话继续未完成的任务,适合通宵/无人值守长跑。只对主动登记过的会话生效,普通对话零打扰。受上面「额度告警」总开关控制:总开关关闭时本项锁定且不生效。"/>
                </ToolTip>
              </CheckBox.ToolTip>
            </CheckBox>
          </StackPanel>
        </Border>
        <TextBlock x:Name="SetHint" Text="" FontSize="10" Foreground="#FFA94D" Margin="0,8,0,0" TextWrapping="Wrap"/>
        <StackPanel Orientation="Horizontal" Margin="0,10,0,0" HorizontalAlignment="Right">
          <Border x:Name="BtnSaveSettings" CornerRadius="6" Background="#0A84FF" Padding="14,5" Cursor="Hand" Margin="0,0,10,0">
            <TextBlock Text="保存" FontSize="11.5" FontWeight="SemiBold" Foreground="White"/>
          </Border>
          <Border x:Name="BtnCancelSettings" CornerRadius="6" Background="{DynamicResource TrackBrush}" Padding="12,5" Cursor="Hand">
            <TextBlock Text="取消" FontSize="11" Foreground="{DynamicResource SecondaryBrush}"/>
          </Border>
        </StackPanel>
      </StackPanel>

      <!-- 高峰期横幅(周一至周五 14:00–18:00 常驻,结束自动收起):橙色倒计时 + 时段进度条 -->
      <StackPanel x:Name="PeakBanner" Visibility="Collapsed" Margin="0,-4,0,8">
        <Grid Height="14">
          <TextBlock x:Name="PeakBannerLabel" Text="⚡ 高峰期进行中" FontSize="10.5" FontWeight="SemiBold" Foreground="#FFA94D" VerticalAlignment="Center"/>
          <TextBlock x:Name="PeakBannerValue" Text="" FontSize="10.5" HorizontalAlignment="Right" Foreground="#FFA94D" VerticalAlignment="Center"/>
        </Grid>
        <Border Height="4" CornerRadius="2" Background="{DynamicResource TrackBrush}" Margin="0,3,0,0" ClipToBounds="True">
          <Border x:Name="PeakBannerFill" Height="4" CornerRadius="2" HorizontalAlignment="Left" Width="0" Background="#FFA94D"/>
        </Border>
      </StackPanel>

      <!-- 额度行 = QuotaRowView(46):标题16 → +4 → 条6 → +4 → sub14,行间 8 -->
      <StackPanel x:Name="Row1">
        <Grid Height="16">
          <TextBlock x:Name="R1Label" Text="" FontSize="12.5" FontWeight="SemiBold" Foreground="{DynamicResource LabelBrush}"/>
          <TextBlock x:Name="R1Value" Text="" FontSize="12" FontWeight="Bold" HorizontalAlignment="Right" Foreground="{DynamicResource ValueBrush}"/>
        </Grid>
        <Border Height="6" CornerRadius="3" Background="{DynamicResource TrackBrush}" Margin="0,4,0,4" ClipToBounds="True">
          <Border x:Name="R1Fill" Height="6" CornerRadius="3" HorizontalAlignment="Left" Width="0" Background="#33B873"/>
        </Border>
        <TextBlock x:Name="R1Sub" Text="" FontSize="10.5" Foreground="{DynamicResource QuaternaryBrush}"/>
      </StackPanel>
      <StackPanel x:Name="Row2" Margin="0,8,0,0">
        <Grid Height="16">
          <TextBlock x:Name="R2Label" Text="" FontSize="12.5" FontWeight="SemiBold" Foreground="{DynamicResource LabelBrush}"/>
          <TextBlock x:Name="R2Value" Text="" FontSize="12" FontWeight="Bold" HorizontalAlignment="Right" Foreground="{DynamicResource ValueBrush}"/>
        </Grid>
        <Border Height="6" CornerRadius="3" Background="{DynamicResource TrackBrush}" Margin="0,4,0,4" ClipToBounds="True">
          <Border x:Name="R2Fill" Height="6" CornerRadius="3" HorizontalAlignment="Left" Width="0" Background="#33B873"/>
        </Border>
        <TextBlock x:Name="R2Sub" Text="" FontSize="10.5" Foreground="{DynamicResource QuaternaryBrush}"/>
      </StackPanel>
      <StackPanel x:Name="Row3" Margin="0,8,0,0">
        <Grid Height="16">
          <TextBlock x:Name="R3Label" Text="" FontSize="12.5" FontWeight="SemiBold" Foreground="{DynamicResource LabelBrush}"/>
          <TextBlock x:Name="R3Value" Text="" FontSize="12" FontWeight="Bold" HorizontalAlignment="Right" Foreground="{DynamicResource ValueBrush}"/>
        </Grid>
        <Border Height="6" CornerRadius="3" Background="{DynamicResource TrackBrush}" Margin="0,4,0,4" ClipToBounds="True">
          <Border x:Name="R3Fill" Height="6" CornerRadius="3" HorizontalAlignment="Left" Width="0" Background="#33B873"/>
        </Border>
        <TextBlock x:Name="R3Sub" Text="" FontSize="10.5" Foreground="{DynamicResource QuaternaryBrush}"/>
      </StackPanel>

      <!-- +2 分隔线 +11 -->
      <Rectangle x:Name="Sep" Height="1" Fill="{DynamicResource SeparatorBrush}" Margin="0,10,0,10"/>
      <!-- footer:11.5 medium labelColor 当日总量;右侧 💹 悬浮本机/账号对比;失败态露出「🔑 配置 API Key」 -->
      <Grid x:Name="FooterGrid">
        <TextBlock x:Name="FLabel" Text="" FontSize="11.5" FontWeight="Medium" Foreground="{DynamicResource LabelBrush}" VerticalAlignment="Center"/>
        <TextBlock x:Name="BtnCurve" Text="📈" FontSize="12" Foreground="{DynamicResource SecondaryBrush}" Cursor="Hand" ToolTip="用量曲线(历史水位)"
                   HorizontalAlignment="Right" Margin="0,0,46,0" VerticalAlignment="Center"/>
        <TextBlock x:Name="BtnLocal" Text="💹" FontSize="12" Foreground="{DynamicResource SecondaryBrush}" Cursor="Hand" ToolTip="本机 / 账号消耗对比"
                   HorizontalAlignment="Right" Margin="0,0,26,0" VerticalAlignment="Center"/>
        <Border x:Name="BtnKey" CornerRadius="6" Background="#0A84FF" Padding="10,4" HorizontalAlignment="Right" Margin="26,0,0,0"
                Visibility="Collapsed" Cursor="Hand" ToolTip="手动选择服务商并粘贴 API Key">
          <TextBlock Text="🔑 配置 API Key" FontSize="11" FontWeight="Medium" Foreground="White"/>
        </Border>
      </Grid>
      <Popup x:Name="LocalPopup" StaysOpen="True" AllowsTransparency="True" PopupAnimation="Fade">
        <Border CornerRadius="10" Background="{DynamicResource RootBgBrush}" BorderBrush="{DynamicResource BorderBrushR}" BorderThickness="1" Padding="14,12" Width="310">
          <StackPanel>
            <Grid Height="16">
              <TextBlock Text="💻 本机 / 账号消耗(当日)" FontSize="11.5" FontWeight="SemiBold" Foreground="{DynamicResource LabelBrush}" VerticalAlignment="Center"/>
              <TextBlock x:Name="LPct" Text="" FontSize="11" FontWeight="Bold" HorizontalAlignment="Right" Foreground="#0A84FF" VerticalAlignment="Center"/>
            </Grid>
            <!-- 叠加条:整条=账号总量(浅色,100%),本机(蓝)从左端叠加,直观看出占比 -->
            <Grid Height="8" Margin="0,8,0,0" ClipToBounds="True">
              <Border Height="8" CornerRadius="4" Background="#40FFFFFF"/>
              <Border x:Name="LFill" Height="8" CornerRadius="4" HorizontalAlignment="Left" Width="0" Background="#0A84FF"/>
            </Grid>
            <TextBlock FontSize="9.5" Foreground="{DynamicResource TertiaryBrush}" Margin="0,4,0,0" Text="■ 本机(蓝) · □ 账号总量(整条,含所有设备)"/>
            <Rectangle Height="1" Fill="{DynamicResource SeparatorBrush}" Margin="0,8,0,6"/>
            <Grid Height="15">
              <TextBlock Text="本机调用" FontSize="10.5" Foreground="{DynamicResource TertiaryBrush}" VerticalAlignment="Center"/>
              <TextBlock x:Name="LCalls" Text="" FontSize="10.5" HorizontalAlignment="Right" Foreground="{DynamicResource SecondaryBrush}" VerticalAlignment="Center"/>
            </Grid>
            <Grid Height="15">
              <TextBlock Text="本机 tokens(输入 / 输出 / 合计)" FontSize="10.5" Foreground="{DynamicResource TertiaryBrush}" VerticalAlignment="Center"/>
              <TextBlock x:Name="LIO" Text="" FontSize="10.5" HorizontalAlignment="Right" Foreground="{DynamicResource SecondaryBrush}" VerticalAlignment="Center"/>
            </Grid>
            <Grid x:Name="LModelsRow" Height="15">
              <TextBlock Text="本机按模型" FontSize="10.5" Foreground="{DynamicResource TertiaryBrush}" VerticalAlignment="Center"/>
              <TextBlock x:Name="LModels" Text="" FontSize="10.5" HorizontalAlignment="Right" Foreground="{DynamicResource SecondaryBrush}" VerticalAlignment="Center"/>
            </Grid>
            <Grid Height="15" Margin="0,2,0,0">
              <TextBlock Text="账号(全部设备)" FontSize="10.5" Foreground="{DynamicResource TertiaryBrush}" VerticalAlignment="Center"/>
              <TextBlock x:Name="LTotalVal" Text="" FontSize="10.5" HorizontalAlignment="Right" Foreground="{DynamicResource SecondaryBrush}" VerticalAlignment="Center"/>
            </Grid>
            <TextBlock Text="本机 = 本电脑当日实际调用(本地模型日志);账号 = 官方监控口径(含所有设备)" FontSize="9.5" Foreground="{DynamicResource QuaternaryBrush}" Margin="0,8,0,0" TextWrapping="Wrap"/>
          </StackPanel>
        </Border>
      </Popup>
      <!-- 模型拆分紧贴当日行,左对齐;高峰/非高峰明细放其后 -->
      <TextBlock x:Name="FSub" Text="" FontSize="10.5" Foreground="{DynamicResource TertiaryBrush}" Margin="0,3,0,0" TextWrapping="Wrap"/>
      <!-- ⚡ 生成速度/缓存命中率:zcode-usage.mjs 从本机 rollout 日志自行计算,插件独立、无外部服务依赖 -->
      <TextBlock x:Name="SpeedRow" Text="" FontSize="10.5" Foreground="{DynamicResource TertiaryBrush}" Margin="0,3,0,0" Visibility="Collapsed"/>
      <Grid x:Name="PeakRow" Height="15" Margin="0,5,0,0">
        <TextBlock Text="高峰期(工作日 14–18 时)" FontSize="10.5" Foreground="{DynamicResource TertiaryBrush}" VerticalAlignment="Center"/>
        <TextBlock x:Name="PeakValue" Text="" FontSize="10.5" HorizontalAlignment="Right" Foreground="{DynamicResource SecondaryBrush}" VerticalAlignment="Center"/>
      </Grid>
      <Grid x:Name="OffPeakRow" Height="15" Margin="0,2,0,0">
        <TextBlock Text="非高峰期" FontSize="10.5" Foreground="{DynamicResource TertiaryBrush}" VerticalAlignment="Center"/>
        <TextBlock x:Name="OffPeakValue" Text="" FontSize="10.5" HorizontalAlignment="Right" Foreground="{DynamicResource SecondaryBrush}" VerticalAlignment="Center"/>
      </Grid>
      <TextBlock x:Name="Hint" Text="Ctrl+G 唤出 / 收起 · 拖拽面板可移动位置" FontSize="10" Foreground="{DynamicResource QuaternaryBrush}" Margin="0,2,0,0"/>
    </StackPanel>
  </Border>
</Window>
'@

$win = [Windows.Markup.XamlReader]::Parse($xamlText)
$el = { param($n) $win.FindName($n) }
$Meta = & $el 'Meta'
$BtnRefresh = & $el 'BtnRefresh'
$BtnClose = & $el 'BtnClose'
$FLabel = & $el 'FLabel'
$FSub = & $el 'FSub'
$SpeedRow = & $el 'SpeedRow'
$Hint = & $el 'Hint'
$PeakRow = & $el 'PeakRow'
$PeakValue = & $el 'PeakValue'
$OffPeakRow = & $el 'OffPeakRow'
$OffPeakValue = & $el 'OffPeakValue'
$PeakBanner = & $el 'PeakBanner'
$PeakBannerLabel = & $el 'PeakBannerLabel'
$PeakBannerValue = & $el 'PeakBannerValue'
$PeakBannerFill = & $el 'PeakBannerFill'
$Sep = & $el 'Sep'
$FooterGrid = & $el 'FooterGrid'
$BtnKey = & $el 'BtnKey'
$BtnLocal = & $el 'BtnLocal'
$BtnCurve = & $el 'BtnCurve'
$LocalPopup = & $el 'LocalPopup'
$LPct = & $el 'LPct'
$LFill = & $el 'LFill'
$LCalls = & $el 'LCalls'
$LIO = & $el 'LIO'
$LModels = & $el 'LModels'
$LModelsRow = & $el 'LModelsRow'
$LTotalVal = & $el 'LTotalVal'
$SetupPanel = & $el 'SetupPanel'
$SetupBase = & $el 'SetupBase'
$SetupKey = & $el 'SetupKey'
$BtnSaveKey = & $el 'BtnSaveKey'
$BtnClearKey = & $el 'BtnClearKey'
$SetupHint = & $el 'SetupHint'
$BtnSettings = & $el 'BtnSettings'
$SettingsPanel = & $el 'SettingsPanel'
$SetRefresh = & $el 'SetRefresh'
$SetHotkeyMod = & $el 'SetHotkeyMod'
$SetHotkeyKey = & $el 'SetHotkeyKey'
$SetTh5h = & $el 'SetTh5h'
$SetThWeekly = & $el 'SetThWeekly'
$SetThMcp = & $el 'SetThMcp'
$SetHint = & $el 'SetHint'
$SetModelName = & $el 'SetModelName'
$SetNumFmt = & $el 'SetNumFmt'
$SetSessionInject = & $el 'SetSessionInject'
$SetAlertsOn = & $el 'SetAlertsOn'
$AlertsPanel = & $el 'AlertsPanel'
$SetResumeGuard = & $el 'SetResumeGuard'
$BtnOpenSetup = & $el 'BtnOpenSetup'
$BtnSaveSettings = & $el 'BtnSaveSettings'
$BtnCancelSettings = & $el 'BtnCancelSettings'
$rows = @()
for ($i = 1; $i -le 3; $i++) {
  $rows += [pscustomobject]@{
    Panel = & $el "Row${i}"
    Label = & $el "R${i}Label"; Value = & $el "R${i}Value"
    Fill  = & $el "R${i}Fill";  Sub   = & $el "R${i}Sub"
  }
}

# 内容宽 372 - 36 = 336;条填充最小宽度 = 条高(极小比例也显示圆点,同 BarView)
$trackWidth = 336.0

# 初始位置:主屏右上角;有保存位置且在屏幕范围内则恢复
$posFile = Join-Path $env:USERPROFILE '.zcode\scripts\zcode-usage-widget.pos.json'
$wa = [System.Windows.SystemParameters]::WorkArea
$win.Left = $wa.Right - $win.Width - 26
$win.Top  = $wa.Top + 16
if (Test-Path $posFile) {
  try {
    $pos = Get-Content $posFile -Raw | ConvertFrom-Json
    if ($pos.Left -is [double] -and $pos.Top -is [double] -and
        $pos.Left -ge ($wa.Left - 20) -and ($pos.Left + $win.Width) -le ($wa.Right + 20) -and
        $pos.Top -ge ($wa.Top - 20) -and ($pos.Top + 260) -le ($wa.Bottom + 20)) {
      $win.Left = $pos.Left
      $win.Top = $pos.Top
    }
  } catch { }
}
function Save-Pos {
  try {
    @{ Left = $win.Left; Top = $win.Top } | ConvertTo-Json | Set-Content -Path $posFile -Encoding ASCII
  } catch { }
}

# —— 设置读写(quota-guard-settings.json,与 quota-guard.mjs 共用;guard 只关心 threshold/warnIntervalMinutes)——
# 顶层加载一次,供 定时器间隔/全局热键/阈值 toast 使用;⚙ 面板保存后回写此文件
$settingsFile = Join-Path $env:USERPROFILE '.zcode\scripts\quota-guard-settings.json'
function Read-SettingsJson {
  try {
    if (Test-Path $settingsFile) {
      $raw = Get-Content $settingsFile -Raw
      if ($null -ne $raw) { $raw = $raw.TrimStart([char]0xFEFF) }  # 剥 BOM:PS5.1 的 Set-Content -Encoding UTF8 会带 BOM
      return ($raw | ConvertFrom-Json)
    }
  } catch { }
  return $null
}
$script:refreshChoices = @(1, 5, 10, 15, 30)
$script:thresholdChoices = @(80, 85, 90, 95)
$script:modChoices = @( @{ V = 2; Name = 'Ctrl' }, @{ V = 1; Name = 'Alt' }, @{ V = 4; Name = 'Shift' }, @{ V = 8; Name = 'Win' } )
function ModsName([int]$m) { $hit = @($script:modChoices | Where-Object { $_.V -eq $m }); if ($hit.Count) { $hit[0].Name } else { "?$m" } }
# 底部提示/收起按钮 ToolTip 用:显示当前实际注册的快捷键,改键后随之刷新
function HotkeyName { return "$(ModsName $script:hotkeyModifiers)+$([char]$script:hotkeyKey)" }
function Update-HotkeyHints {
  $Hint.Text = "$(HotkeyName) 唤出 / 收起 · 拖拽面板可移动位置"
  $BtnClose.ToolTip = "收起面板($(HotkeyName) 唤回)"
}
$_cfg = Read-SettingsJson
$script:refreshMinutes = if ($_cfg -and ($script:refreshChoices -contains [int]$_cfg.refreshMinutes)) { [int]$_cfg.refreshMinutes } else { 10 }
$script:hotkeyModifiers = if ($_cfg -and ($script:modChoices.V -contains [int]$_cfg.hotkeyModifiers)) { [int]$_cfg.hotkeyModifiers } else { 2 }
$script:hotkeyKey = if ($_cfg -and ([int]$_cfg.hotkeyKey -ge 0x30) -and ([int]$_cfg.hotkeyKey -le 0x5A)) { [int]$_cfg.hotkeyKey } else { 0x47 }
# 显示格式:模型名 full=GLM-5.3-flashx / short=5.3-flashx;数字 compact=53.4M / full=53,452,123 / cn=5345.2万
$script:modelNameFmt = if ($_cfg -and $_cfg.modelNameFmt) { [string]$_cfg.modelNameFmt } else { 'short' }
$script:tokenFmt = if ($_cfg -and $_cfg.tokenFmt) { [string]$_cfg.tokenFmt } else { 'compact' }
# 额度告警总开关(默认开);会话注入默认关——用户不一定想要对话被注入上下文;
# 续跑总开关默认开(登记制本身已保证普通会话零打扰)
$script:alertsEnabled = if ($_cfg -and $null -ne $_cfg.alertsEnabled) { [bool]$_cfg.alertsEnabled } else { $true }
$script:sessionInject = if ($_cfg -and $null -ne $_cfg.sessionInject) { [bool]$_cfg.sessionInject } else { $false }
$script:resumeGuard = if ($_cfg -and $null -ne $_cfg.resumeGuard) { [bool]$_cfg.resumeGuard } else { $true }
# 额度采样记录(默认关):普通用户零写盘;开启后每次查询记录水位,📈 历史曲线才有数据
$script:quotaSamples = if ($_cfg -and $null -ne $_cfg.quotaSamples) { [bool]$_cfg.quotaSamples } else { $false }
$_cfg = $null
Update-HotkeyHints  # 底部提示与实际注册的快捷键一致(此前 XAML 里写死 Ctrl+G,改键后不刷新)

# —— 手动凭据兜底:查询失败时在面板里选服务商 + 粘贴 Key ——
# 与 macOS HUD 共用 ~/.zcode/zcode-usage-manual.json,zcode-usage.mjs 的 CLI 查询同样读它
$manualFile = Join-Path $env:USERPROFILE '.zcode\zcode-usage-manual.json'
function Read-ManualCred {
  try {
    if (Test-Path $manualFile) {
      $m = Get-Content $manualFile -Raw | ConvertFrom-Json
      if ($m.apiKey -and $m.apiBase) { return $m }
    }
  } catch { }
  return $null
}
function Save-ManualCred([string]$key, [string]$base) {
  try {
    # Key/URL 都是 ASCII,用 ASCII 编码避免 PowerShell 5.1 的 UTF8 BOM
    @{ apiKey = $key; apiBase = $base } | ConvertTo-Json | Set-Content -Path $manualFile -Encoding ASCII
  } catch { }
}
function Clear-ManualCred {
  try { if (Test-Path $manualFile) { Remove-Item $manualFile } } catch { }
}

$bc = New-Object System.Windows.Media.BrushConverter
function Brush($hex) { $script:bc.ConvertFromString($hex) }

# —— 主题:与 ZCode 外观保持一致(像素探测 ZCode 主窗口侧边栏),不读写任何 Windows 主题设置 ——
# 探测失败(窗口最小化/截取失败)沿用最近一次结果;从未成功过才回退 Windows 应用模式(只读)
# 浅色 = macOS 浅色标签阶梯(#3C3C43 系);ZCODE_WIDGET_THEME=light|dark 强制指定(调试用)
$themeOverride = $env:ZCODE_WIDGET_THEME
$themes = @{
  dark = @{ Label='#FFFFFF'; Secondary='#A6FFFFFF'; Value='#8CFFFFFF'; Tertiary='#80FFFFFF'
            Quaternary='#24FFFFFF'; Track='#24FFFFFF'; Separator='#2EFFFFFF'; Border='#1AFFFFFF'
            RootSemi='#E014171C'; RootOpaque='#F01C1F24'; BlurTint=0x991A1A18 }
  light = @{ Label='#FF1D1D1F'; Secondary='#A63C3C43'; Value='#A63C3C43'; Tertiary='#803C3C43'
             Quaternary='#993C3C43'; Track='#293C3C43'; Separator='#2E3C3C43'; Border='#1A000000'
             RootSemi='#E0F2F2F4'; RootOpaque='#F0F2F2F5'; BlurTint=0x99E9EAEC }
}
$script:lastKnownDark = $null
function Get-IsDarkTheme {
  if ($themeOverride -eq 'dark') { return $true }
  if ($themeOverride -eq 'light') { return $false }
  try {
    $z = Get-Process -Name 'ZCode' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if ($z) {
      $r = New-Object GLMNative.ZCodeProbe+RECT
      [GLMNative.ZCodeProbe]::GetWindowRect($z.MainWindowHandle, [ref]$r) | Out-Null
      $w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
      if ($w -gt 100 -and $h -gt 100) {
        $bmp = New-Object System.Drawing.Bitmap($w, $h)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $hdc = $g.GetHdc()
        $ok = [GLMNative.ZCodeProbe]::PrintWindow($z.MainWindowHandle, $hdc, 2)
        $g.ReleaseHdc($hdc); $g.Dispose()
        if ($ok) {
          # 采 9 个点的亮度,同时记录极差:ZCode 弹出纯白对话框/窗口未渲染时,
          # PrintWindow 会采到一片均匀的白色——那是无效样本,不能据此切换主题
          $lum = 0.0; $n = 0; $minL = 255.0; $maxL = 0.0
          foreach ($fx in @(0.012, 0.018, 0.024)) {
            foreach ($fy in @(0.3, 0.5, 0.7)) {
              $c = $bmp.GetPixel([int]($w * $fx), [int]($h * $fy))
              $lv = 0.299 * $c.R + 0.587 * $c.G + 0.114 * $c.B
              $lum += $lv; $n++
              if ($lv -lt $minL) { $minL = $lv }
              if ($lv -gt $maxL) { $maxL = $lv }
            }
          }
          $bmp.Dispose()
          if (($maxL - $minL) -lt 8 -and $null -ne $script:lastKnownDark) {
            return $script:lastKnownDark # 全平 = 无效样本:沿用上次结论,防止整窗被带成白色
          }
          $script:lastKnownDark = (($lum / $n) -lt 110)
          return $script:lastKnownDark
        }
        $bmp.Dispose()
      }
    }
  } catch { }
  if ($null -ne $script:lastKnownDark) { return $script:lastKnownDark }
  try {
    $v = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Themes\Personalize').GetValue('AppsUseLightTheme')
    return ($v -eq 0)
  } catch { return $true }
}
# 磨砂玻璃(EnableBlur)已停用:v0.3.0 起外观恒定为普通半透明卡片(RootSemi),
# 不再调用 BlurBehind——它曾因配色 Tint 为负 Int32 抛异常导致进程崩溃、悬浮窗消失
function Apply-Theme {
  $script:theme = if (Get-IsDarkTheme) { $themes.dark } else { $themes.light }
  $map = @{ Label='LabelBrush'; Secondary='SecondaryBrush'; Value='ValueBrush'
            Tertiary='TertiaryBrush'; Quaternary='QuaternaryBrush'; Track='TrackBrush'
            Separator='SeparatorBrush'; Border='BorderBrushR' }
  foreach ($k in $map.Keys) {
    $b = $win.Resources[$map[$k]]
    # 注意:改 .Color 必须用 ColorConverter(返回 Color);BrushConverter 返回 Brush 会抛异常
    if ($b) { $b.Color = [System.Windows.Media.ColorConverter]::ConvertFromString($script:theme[$k]) }
  }
  $rootBrush = $win.Resources['RootBgBrush']
  if ($rootBrush) {
    # 固定半透明底(不开 BlurBehind):外观恒定,不随配色 Tint 漂移
    $rootBrush.Color = [System.Windows.Media.ColorConverter]::ConvertFromString($script:theme.RootSemi)
  }
}
# Fmt.tint:>=85 红,>=60 橙,其余绿(0.20,0.72,0.45)
function RateColor([double]$p) {
  if ($p -ge 85) { '#FF5A5A' } elseif ($p -ge 60) { '#FFA94D' } else { '#33B873' }
}
function Set-Row($row, $label, $value, $pct, $sub) {
  $p = [double]$pct
  $col = RateColor $p
  $row.Label.Text = $label
  $row.Value.Text = $value
  $row.Fill.Background = Brush $col
  # 进度条语义 = 剩余量:满条绿,随额度消耗缩短并变橙(用量≥60)变红(用量≥85);
  # 颜色仍按使用量分档(保持 60/85 两个告警点),长度按剩余绘制,所见即所剩
  $rem = 100 - [Math]::Min(100, [Math]::Max(0, $p))
  $w = [Math]::Round($trackWidth * $rem / 100)
  $row.Fill.Width = [Math]::Max($w, 6)
  $row.Sub.Text = $sub
}
function Format-Clock($ms) {
  if (-not $ms -or $ms -le 0) { return '' }
  [DateTimeOffset]::FromUnixTimeMilliseconds($ms).LocalDateTime.ToString('MM/dd HH:mm')
}
# Fmt.countdown:"5 天 3 小时 13 分钟后";<=0 即将重置
function Format-Reset($ms) {
  if (-not $ms -or $ms -le 0) { return '即将重置' }
  $span = [DateTimeOffset]::FromUnixTimeMilliseconds($ms) - [DateTimeOffset]::Now
  if ($span.TotalSeconds -le 0) { return '即将重置' }
  $parts = @()
  if ($span.Days) { $parts += ("{0} 天" -f $span.Days) }
  if ($span.Hours) { $parts += ("{0} 小时" -f $span.Hours) }
  if ($span.Minutes -or ($span.Days -eq 0 -and $span.Hours -eq 0)) { $parts += ("{0} 分钟" -f $span.Minutes) }
  if (-not $parts) { $parts += '不到 1 分钟' }
  return ($parts -join ' ') + '后'
}
# Fmt.tokens,单位风格由 ⚙ 设置里的 $script:tokenFmt 决定:compact=1.25B/53.4M/9.2K;full=1,234,567;cn=1.25 亿/9.2 万
function Format-Tokens([double]$v) {
  switch ($script:tokenFmt) {
    'full' { return '{0:N0}' -f $v }
    'cn' {
      if ($v -ge 1e8) { return '{0:F2} 亿' -f ($v / 1e8) }
      if ($v -ge 1e4) { return '{0:F1} 万' -f ($v / 1e4) }
      return '{0:N0}' -f $v
    }
    default {
      if ($v -ge 1e9) { return '{0:F2}B' -f ($v / 1e9) }
      if ($v -ge 1e6) { return '{0:F1}M' -f ($v / 1e6) }
      if ($v -ge 1e3) { return '{0:F1}K' -f ($v / 1e3) }
      return '{0:N0}' -f $v
    }
  }
}
# 模型名显示,由 ⚙ 设置里的 $script:modelNameFmt 决定:full=GLM-5.3-flashx;short=5.3-flashx
function Format-ModelName([string]$n) {
  if ($script:modelNameFmt -eq 'full') { return $n }
  return ($n -replace '^GLM-', '')
}

# —— 高峰期提醒:周一至周五 14:00–18:00 期间橙色横幅常驻,结束自动收起 ——
# 调试:ZCODE_WIDGET_PEAK=on 无视日期强制显示;ZCODE_WIDGET_PEAK_SHIFT=<小时,可带小数> 把时钟整体平移(演示用)
# 刷新挂在 zcodeTimer(2s)上,状态切换和倒计时都不需要新增定时器
function Get-PeakNow {
  $now = Get-Date
  if ($env:ZCODE_WIDGET_PEAK_SHIFT) {
    $h = 0.0
    if ([double]::TryParse($env:ZCODE_WIDGET_PEAK_SHIFT, [Globalization.NumberStyles]::Float, $null, [ref]$h)) { $now = $now.AddHours($h) }
  }
  return $now
}
function Get-PeakWindow {
  $now = Get-PeakNow
  $dow = [int]$now.DayOfWeek
  if ($env:ZCODE_WIDGET_PEAK -ne 'on' -and ($dow -eq 0 -or $dow -eq 6)) { return $null }
  $start = $now.Date.AddHours(14)
  $end = $start.AddHours(4)
  if ($env:ZCODE_WIDGET_PEAK -eq 'on' -or ($now -ge $start -and $now -lt $end)) {
    return @{ Start = $start; End = $end }
  }
  return $null
}
function Update-PeakBanner {
  # 设置/配置面板打开时收起横幅:2s 定时器会反复刷新横幅,不收起会顶到「保存/取消」按钮上
  if ($SettingsPanel.Visibility -eq 'Visible' -or $SetupPanel.Visibility -eq 'Visible') {
    $PeakBanner.Visibility = 'Collapsed'; return
  }
  $w = Get-PeakWindow
  if (-not $w) { $PeakBanner.Visibility = 'Collapsed'; return }
  $now = Get-PeakNow
  $left = $w.End - $now
  $PeakBannerValue.Text = if ($left.TotalMinutes -lt 1) { '即将结束' }
    elseif ($left.TotalHours -ge 1) { '还剩 {0} 小时 {1} 分' -f [int][Math]::Floor($left.TotalHours), $left.Minutes }
    else { '还剩 {0} 分' -f $left.Minutes }
  # 进度 = 高峰已进行时长 / 4h(14:00 起算,进入即至少画一个圆点)
  $p = ($now - $w.Start).TotalHours / 4.0 * 100
  $fillW = [Math]::Round($trackWidth * [Math]::Min(100, [Math]::Max(0, $p)) / 100)
  $PeakBannerFill.Width = [Math]::Max($fillW, 4)
  $PeakBanner.Visibility = 'Visible'
}

# —— 额度阈值 toast(quota-guard):任一池超阈值弹 Windows 原生通知 ——
# 每个重置周期只弹一次(以 "池key:resetAt" 为键,周期翻篇自动重新武装);
# 阈值读 quota-guard-settings.json(与 quota-guard.mjs 共用),缺省 95。
# 零依赖:直接调 WinRT ToastNotificationManager(Win10 内置),不引入 BurntToast。
# 已告警周期表必须先初始化:$null 上调 ContainsKey 会抛异常被 catch 吞掉,导致永远弹不出
$script:toastWarned = @{}
$script:poolLabels = @{ mcp = 'MCP月度'; prompt5h = '5小时池'; weekly = '每周额度' }
function Show-Toast([string]$title, [string]$body) {
  try {
    [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
    [void][Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime]
    $xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
    $texts = $xml.GetElementsByTagName('text')
    $texts.Item(0).AppendChild($xml.CreateTextNode($title)) | Out-Null
    $texts.Item(1).AppendChild($xml.CreateTextNode($body)) | Out-Null
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('ZCode-Usage').Show(
      [Windows.UI.Notifications.ToastNotification]::new($xml))
  } catch { }
}
# 池的有效阈值:thresholds.<key> 覆盖全局 threshold;0 = 关闭该池
function Get-EffectiveThreshold([string]$key) {
  $th = 95.0
  try {
    $cfgPath = Join-Path $env:USERPROFILE '.zcode\scripts\quota-guard-settings.json'
    if (Test-Path $cfgPath) {
      $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
      if ($cfg.threshold -gt 0 -and $cfg.threshold -lt 100) { $th = [double]$cfg.threshold }
      if ($cfg.thresholds) {
        $v = $cfg.thresholds.$key
        if ($null -ne $v) { return [double]$v }
      }
    }
  } catch { }
  return $th
}
function Update-QuotaToast {
  if (-not $script:alertsEnabled) { return }  # 总开关:关闭后不弹任何额度告警
  try {
    foreach ($l in $script:lastLimits) {
      $p = [double]$l.percentage
      $key = if ($l.type -eq 'TIME_LIMIT') { 'mcp' }
        elseif ($l.unit -eq 3) { 'prompt5h' }
        elseif ($l.unit -eq 6) { 'weekly' } else { "unit$($l.unit)" }
      $th = Get-EffectiveThreshold $key
      if ($th -le 0 -or $p -lt $th) { continue }
      $cycleKey = "{0}:{1}" -f $key, [long]$l.nextResetTime
      if ($script:toastWarned.ContainsKey($cycleKey)) { continue }
      $script:toastWarned[$cycleKey] = $true
      $label = if ($script:poolLabels.ContainsKey($key)) { $script:poolLabels[$key] } else { $key }
      $resetTxt = if ($l.nextResetTime -gt 0) { (Format-Clock $l.nextResetTime) + ' 重置' } else { '' }
      Show-Toast '⚡ GLM 额度警报' ("{0} 已用 {1:F0}%,{2}。可按「额度守卫」协议布置续跑。" -f $label, $p, $resetTxt)
    }
  } catch { }
}

function Invoke-RefreshImpl {
  # 从手动配置/设置回到数据视图:恢复各区块可见性(配置态把它们全部收起了)
  Hide-Setup
  Hide-Settings
        $Meta.Visibility = 'Visible'
  $Sep.Visibility = 'Visible'
  $FooterGrid.Visibility = 'Visible'
  $FSub.Visibility = 'Visible'; $Hint.Visibility = 'Visible'
  $FLabel.Margin = '0,0,0,0'
  $BtnKey.Visibility = 'Collapsed'
  $Meta.Text = '正在读取…'
  # 手动凭据走环境变量传给本次 node 子进程(脚本的 env 来源),不写命令行参数——ps 看不到 Key
  $mc = Read-ManualCred
  if ($mc) {
    $env:ANTHROPIC_AUTH_TOKEN = $mc.apiKey
    $env:ANTHROPIC_BASE_URL = $mc.apiBase
  }
  # --state 落盘额度快照、--history 补录每周期用量(跨周期才发请求),供 guard/统计零网络读取
  if (-not $script:nodeExe) { $script:nodeExe = Resolve-NodeExe }
  if (-not $script:nodeExe) {
    $script:failReason = '未找到 Node 运行时:请安装 Node.js ≥18 并确认 node 在 PATH,装好后重启悬浮窗'
    $raw = ''
  } else {
    $script:failReason = $null
    $raw = (& $script:nodeExe $scriptPath --json --state (Join-Path $env:USERPROFILE '.zcode\scripts\usage-state.json') --history (Join-Path $env:USERPROFILE '.zcode\scripts\usage-history.jsonl') 2>&1 | Out-String).Trim()
  }
  if ($mc) {
    Remove-Item Env:\ANTHROPIC_AUTH_TOKEN -ErrorAction SilentlyContinue
    Remove-Item Env:\ANTHROPIC_BASE_URL -ErrorAction SilentlyContinue
  }
  $d = $null
  if ($raw) { try { $d = $raw | ConvertFrom-Json } catch { $d = $null } }
  if (-not $d -or -not $d.quota) {
    # renderError:⚠️ 查询失败 + 消息放 sub,footer 提示重试,右侧露出「🔑 配置 API Key」
    $Meta.Text = '读取失败'
    $msg = if ($script:failReason) { $script:failReason }
      elseif ($raw -match '401') { 'API Key 已失效或被更换,点右下按钮更新' }
      elseif ($raw -match '内部服务器错误|HTTP 5\d\d') { '智谱服务端错误,稍后点 ↻ 重试' }
      elseif ($raw -match '请求超时|网络错误') { '网络错误,点右上角 ↻ 重试' }
      elseif ($raw -match '未找到 Coding Plan API Key') { '未配置 API Key,点右下按钮手动填写' }
      elseif ($raw) { ($raw -split "`r?`n")[0] } else { '网络错误,点右上角 ↻ 重试' }
    Set-Row $rows[0] '⚠️  查询失败' '' 0 $msg
    foreach ($r in $rows | Select-Object -Skip 1) { $r.Panel.Visibility = 'Collapsed' }
    $FLabel.Text = '点 ↻ 重试，或手动配置 Key'
    $FLabel.Margin = '0,0,146,0'
    $BtnKey.Visibility = 'Visible'
    $FSub.Text = ''
    $SpeedRow.Visibility = 'Collapsed'
    $PeakRow.Visibility = 'Collapsed'; $OffPeakRow.Visibility = 'Collapsed'
    return
  }
  foreach ($r in $rows) { $r.Panel.Visibility = 'Visible' }
  $q = $d.quota
  # 记录各额度池对应的行;套餐没有的池(如 V1 Pro 无周限额)把对应行收起,避免留空白行
  $rowByPool = @{}
  foreach ($l in $q.limits) {
    $p = [double]$l.percentage
    if ($l.type -eq 'TIME_LIMIT') {
      $rowByPool['mcp'] = $rows[2]
      Set-Row $rows[2] '🔧  MCP 工具调用(1个月)' ('{0:N0} / {1:N0} 次' -f $l.currentValue, $l.usage) $p `
        ('剩余 {0:N0} · ↻ {1} 重置 · {2}' -f $l.remaining, (Format-Clock $l.nextResetTime), (Format-Reset $l.nextResetTime))
    } elseif ($l.unit -eq 3) {
      $rowByPool['prompt5h'] = $rows[0]
      Set-Row $rows[0] '🕐  5 小时 Prompt 池' ('剩余 {0:F1}%' -f (100 - $p)) $p `
        ('↻ {0} 重置 · {1}' -f (Format-Clock $l.nextResetTime), (Format-Reset $l.nextResetTime))
    } elseif ($l.unit -eq 6) {
      $rowByPool['weekly'] = $rows[1]
      Set-Row $rows[1] '📅  每周额度' ('剩余 {0:F1}%' -f (100 - $p)) $p `
        ('↻ {0} 重置 · {1}' -f (Format-Clock $l.nextResetTime), (Format-Reset $l.nextResetTime))
    }
  }
  for ($i = 0; $i -lt 3; $i++) {
    if (-not ($rowByPool.Values -contains $rows[$i])) { $rows[$i].Panel.Visibility = 'Collapsed' }
  }
  # 记录限额数据并做阈值 toast 检查(quota-guard)
  $script:lastLimits = @($q.limits)
  Update-QuotaToast
  $t = $d.modelUsage.totalUsage
  $FLabel.Text = ('📊  当日　{0:N0} 次 · {1} tokens' -f $t.totalModelCallCount, (Format-Tokens ([double]$t.totalTokensUsage)))
  # 高峰(工作日 14–18 时)/非高峰拆分由脚本算好放进 usageSplit;缺省(拆分查询失败)时收起两行明细
  if ($d.usageSplit) {
    $PeakRow.Visibility = 'Visible'; $OffPeakRow.Visibility = 'Visible'
    $PeakValue.Text = ('{0:N0} 次 · {1} tokens' -f [double]$d.usageSplit.peak.calls, (Format-Tokens ([double]$d.usageSplit.peak.tokens)))
    $OffPeakValue.Text = ('{0:N0} 次 · {1} tokens' -f [double]$d.usageSplit.offPeak.calls, (Format-Tokens ([double]$d.usageSplit.offPeak.tokens)))
  } else {
    $PeakRow.Visibility = 'Collapsed'; $OffPeakRow.Visibility = 'Collapsed'
  }
  # 模型名去掉 GLM- 前缀(FSub 已允许换行兜底),避免长名把用量数字挤出窗口
  $models = @($t.modelSummaryList | ForEach-Object { '{0} {1}' -f (Format-ModelName $_.modelName), (Format-Tokens ([double]$_.totalTokens)) })
  $FSub.Text = $models -join ' · '
  # 窗口宽度自适应(两步,以真实布局为准):
  # 1) 用独立 NoWrap TextBlock 估一个初值(58 = Margin 10×2 + 边框 1×2 + Padding 18×2,再留 10 富余);
  # 2) 实测 FSub 是否仍换行(ActualHeight 超过单行≈17px),换行就逐步加宽,直到单行或屏幕上限 80%。
  #    不盲信测量值——字体回退/度量差异会让估宽偏窄,末尾数字曾被挤到第二行。
  $m = New-Object System.Windows.Controls.TextBlock
  $m.FontSize = 10.5
  $m.TextWrapping = 'NoWrap'
  $m.Text = $FSub.Text
  $m.Measure([Windows.Size]::new(10000, 100))
  $need = [Math]::Ceiling($m.DesiredSize.Width) + 58
  $cap = [Math]::Max(560, [Math]::Floor([System.Windows.SystemParameters]::WorkArea.Width * 0.8))
  $win.Width = [Math]::Min($cap, [Math]::Max(372, $need))
  $win.UpdateLayout()
  $tries = 0
  while (($FSub.ActualHeight -gt 19) -and ($win.Width -lt $cap) -and ($tries -lt 20)) {
    $win.Width = [Math]::Min($cap, $win.Width + 16)
    $win.UpdateLayout()
    $tries++
  }
  # 诊断:只在发生换行修正(tries>0)或修正后仍未单行时记录,避免成功路径刷屏
  if ($tries -gt 0) {
    Write-WidgetLog ('宽度自适应: +' + (16 * $tries) + 'px → ' + $win.Width + 'px(估宽偏窄,已由换行检测修正)')
  } elseif ($FSub.ActualHeight -gt 19) {
    Write-WidgetLog ('宽度自适应放弃: 仍换行 @ ' + $win.Width + 'px, ActualHeight=' + [Math]::Round($FSub.ActualHeight, 1))
  }
  # 加宽后若超出屏幕右缘,左移回工作区内
  $wa = [System.Windows.SystemParameters]::WorkArea
  if ($win.Left + $win.Width -gt $wa.Width) { $win.Left = [Math]::Max(0, $wa.Width - $win.Width - 12) }
  # ⚡ 生成速度/缓存/首字:由 zcode-usage.mjs 自行计算(独立数据源)。速度优先用 sqlite 纯解码口径
  # (输出/(时长-首字),与输入框状态条一致);sqlite 不可用时回退 JSONL 的含预填充口径
  $ls = $d.localSpeed
  if ($ls -and ($null -ne $ls.medianDecodeRate -or $null -ne $ls.medianRate -or $null -ne $ls.medianTtftMs)) {
    $sbits = @()
    if ($null -ne $ls.medianDecodeRate) { $sbits += ('⚡ 速度 {0:N0} tok/s' -f [double]$ls.medianDecodeRate) }
    elseif ($null -ne $ls.medianRate) { $sbits += ('⚡ 速度 {0:N0} tok/s' -f [double]$ls.medianRate) }
    if ($null -ne $ls.cacheHitRate) { $sbits += ('缓存 {0:F1}%' -f ([double]$ls.cacheHitRate * 100)) }
    if ($null -ne $ls.medianTtftMs) { $sbits += ('首字 {0:F1}s' -f ([double]$ls.medianTtftMs / 1000)) }
    $SpeedRow.Text = $sbits -join ' · '
    $SpeedRow.Visibility = 'Visible'
  } else {
    $SpeedRow.Visibility = 'Collapsed'
  }
  # 本机/账号对比数据(💹 悬浮弹窗用)
  $script:lastLocal = $d.localUsage
  $script:lastTotalTokens = [double]$t.totalTokensUsage
  $script:lastTotalCalls = [double]$t.totalModelCallCount
  $Meta.Text = ('{0} 套餐 · 更新于 {1}' -f $q.level.ToUpper(), (Get-Date -Format 'HH:mm:ss'))
}

# 带兜底的刷新入口:任何异常只记日志并显示"刷新异常",绝不带崩进程/窗口(窗口在 Show 之前崩溃的最常见死法)
function Invoke-Refresh {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    Invoke-RefreshImpl
    # 慢刷新记录:内存紧张/网络慢时刷新会拖长,期间窗口可能短暂"未响应",留证据便于排查
    if ($sw.Elapsed.TotalSeconds -gt 8) { Write-WidgetLog ('慢刷新 ' + [int]$sw.Elapsed.TotalSeconds + 's') }
  } catch {
    Write-WidgetLog ('刷新异常: ' + $_.Exception.Message)
    if ($_.ScriptStackTrace) { Write-WidgetLog ('  at ' + ($_.ScriptStackTrace -replace "`r?`n", ' | ')) }
    try {
      $Meta.Text = '刷新异常'
      $FLabel.Text = '点 ↻ 重试'
      $PeakBanner.Visibility = 'Collapsed'
      foreach ($r in $rows) { $r.Panel.Visibility = 'Collapsed' }
      $PeakRow.Visibility = 'Collapsed'; $OffPeakRow.Visibility = 'Collapsed'
      $SpeedRow.Visibility = 'Collapsed'; $FSub.Visibility = 'Collapsed'
    } catch { }
  }
}

# —— 🔑 手动配置表单:面板内切换(收起数据区,展示 服务商下拉 + Key 输入),窗口高度自适应 ——
function Show-Setup {
  $Meta.Text = '手动配置'
  $PeakBanner.Visibility = 'Collapsed'
  foreach ($r in $rows) { $r.Panel.Visibility = 'Collapsed' }
  $Sep.Visibility = 'Collapsed'
  $FooterGrid.Visibility = 'Collapsed'
  $PeakRow.Visibility = 'Collapsed'; $OffPeakRow.Visibility = 'Collapsed'
  $FSub.Visibility = 'Collapsed'; $SpeedRow.Visibility = 'Collapsed'; $Hint.Visibility = 'Collapsed'
  $BtnKey.Visibility = 'Collapsed'
  # 回填:域名按已存 apiBase 预选;Key 不回显(安全),已存时才可清除
  $mc = Read-ManualCred
  $SetupBase.SelectedIndex = if ($mc -and $mc.apiBase -like '*z.ai*') { 1 } else { 0 }
  $SetupKey.Password = ''
  $BtnClearKey.IsEnabled = [bool]$mc
  $BtnClearKey.Opacity = if ($mc) { 1.0 } else { 0.4 }
  $SetupHint.Text = 'Key 来自智谱开放平台「API Keys」页;ZCode 用户也可在 ZCode 模型设置中查看'
  $SetupPanel.Visibility = 'Visible'
}
function Hide-Setup { $SetupPanel.Visibility = 'Collapsed' }

function Save-Setup {
  $key = $SetupKey.Password.Trim()
  if (-not $key) { $SetupHint.Text = '请先粘贴 API Key 再保存'; return }
  # Key 格式校验:智谱 Key 形如 id.secret(无空格的字母数字/点/横线组合)。
  # 曾有用户把 shell 命令误粘进来,Key 优先级最高,直接屏蔽有效凭据导致持续"查询失败"
  if ($key -match '[\s;；,，]' -or $key -notmatch '^[A-Za-z0-9._\-]{16,}$') {
    $SetupHint.Text = '内容不像有效的 API Key(应为无空格的字母数字/点/横线组合,长度 ≥16),请检查后重新粘贴'
    return
  }
  $base = if ($SetupBase.SelectedIndex -eq 1) { 'https://api.z.ai/api/anthropic' } else { 'https://open.bigmodel.cn/api/anthropic' }
  Save-ManualCred $key $base
  Hide-Setup
  Invoke-Refresh
}

# —— ⚙ 设置面板:刷新间隔 / 唤出快捷键 / 额度阈值 ——
# 保存到 quota-guard-settings.json(与 guard 共用,guard 的 threshold/warnIntervalMinutes 原样保留);
# 保存后即时生效:定时器改间隔,热键解旧注新(被占用则回退并提示)
$script:keyItems = @()
$script:keyVks = @()
foreach ($c in ([int][char]'A'..[int][char]'Z')) {
  $script:keyItems += [string][char]$c
  $script:keyVks += $c
}
foreach ($d in 0..9) {
  $script:keyItems += [string]$d
  $script:keyVks += (0x30 + $d)
}
foreach ($it in $script:keyItems) { [void]$SetHotkeyKey.Items.Add($it) }

function Hide-Settings { $SettingsPanel.Visibility = 'Collapsed' }
# 每池阈值下拉回填:thresholds.<key> 覆盖全局;0 → 「关闭」(索引 0)
function Set-ThresholdCombo($combo, [string]$key, $cfg) {
  $v = 95
  if ($cfg) {
    if ($cfg.threshold -ge 80 -and $cfg.threshold -le 95) { $v = [int]$cfg.threshold }
    if ($cfg.thresholds) {
      $pv = $cfg.thresholds.$key
      if ($null -ne $pv) { $v = [int]$pv }
    }
  }
  if ($v -le 0) { $combo.SelectedIndex = 0; return }
  $idx = [Array]::IndexOf($script:thresholdChoices, $v)
  if ($idx -ge 0) { $combo.SelectedIndex = $idx + 1; return }
  # 界外合法值(如手工编辑过 settings 的 87%):补一个自定义项并选中,避免打开面板即被改写成 95
  $label = [string]$v + '%(自定义)'
  $hit = $null
  foreach ($it in $combo.Items) { if ($it.Content -eq $label) { $hit = $it } }
  if (-not $hit) {
    $hit = New-Object System.Windows.Controls.ComboBoxItem
    $hit.Content = $label
    $combo.Items.Add($hit) | Out-Null
  }
  $combo.SelectedItem = $hit
}
function Show-Settings {
        $Meta.Visibility = 'Collapsed' # 面板自带「⚙ 设置」标题,状态行不重复显示
  $PeakBanner.Visibility = 'Collapsed'
  foreach ($r in $rows) { $r.Panel.Visibility = 'Collapsed' }
  $Sep.Visibility = 'Collapsed'; $FooterGrid.Visibility = 'Collapsed'
  $PeakRow.Visibility = 'Collapsed'; $OffPeakRow.Visibility = 'Collapsed'
  $FSub.Visibility = 'Collapsed'; $SpeedRow.Visibility = 'Collapsed'; $Hint.Visibility = 'Collapsed'
  $BtnKey.Visibility = 'Collapsed'
  Hide-Setup
  $cfg = Read-SettingsJson
  $curRefresh = if ($cfg -and ($script:refreshChoices -contains [int]$cfg.refreshMinutes)) { [int]$cfg.refreshMinutes } else { $script:refreshMinutes }
  $curMods = if ($cfg -and ($script:modChoices.V -contains [int]$cfg.hotkeyModifiers)) { [int]$cfg.hotkeyModifiers } else { $script:hotkeyModifiers }
  $curKeyVk = if ($cfg -and ([int]$cfg.hotkeyKey -ge 0x30) -and ([int]$cfg.hotkeyKey -le 0x5A)) { [int]$cfg.hotkeyKey } else { $script:hotkeyKey }
  $SetRefresh.SelectedIndex = [Math]::Max(0, [Array]::IndexOf($script:refreshChoices, $curRefresh))
  # 每池独立阈值:thresholds.<key> 覆盖全局;0 = 关闭(下拉第 0 项)
  Set-ThresholdCombo $SetTh5h 'prompt5h' $cfg
  Set-ThresholdCombo $SetThWeekly 'weekly' $cfg
  Set-ThresholdCombo $SetThMcp 'mcp' $cfg
  $mi = 0
  for ($i = 0; $i -lt $script:modChoices.Count; $i++) { if ($script:modChoices[$i].V -eq $curMods) { $mi = $i } }
  $SetHotkeyMod.SelectedIndex = $mi
  $SetHotkeyKey.SelectedIndex = [Math]::Max(0, [Array]::IndexOf($script:keyVks, $curKeyVk))
  # 显示格式回填:模型名 full/short,数字 compact/full/cn
  $SetModelName.SelectedIndex = if ($script:modelNameFmt -eq 'full') { 0 } else { 1 }
  $SetNumFmt.SelectedIndex = switch ($script:tokenFmt) { 'full' { 0 } 'cn' { 2 } default { 1 } }
  # 开关回填:告警总开关(联动组内 阈值/注入/续跑 可用性)与 会话注入(默认关)、续跑总开关
  $SetAlertsOn.IsChecked = if ($cfg -and $null -ne $cfg.alertsEnabled) { [bool]$cfg.alertsEnabled } else { $script:alertsEnabled }
  $AlertsPanel.IsEnabled = $SetAlertsOn.IsChecked
  $SetSessionInject.IsEnabled = $SetAlertsOn.IsChecked
  $SetResumeGuard.IsEnabled = $SetAlertsOn.IsChecked
  $SetSessionInject.IsChecked = if ($cfg -and $null -ne $cfg.sessionInject) { [bool]$cfg.sessionInject } else { $script:sessionInject }
  $SetResumeGuard.IsChecked = if ($cfg -and $null -ne $cfg.resumeGuard) { [bool]$cfg.resumeGuard } else { $script:resumeGuard }
  $SetSamples.IsChecked = if ($cfg -and $null -ne $cfg.quotaSamples) { [bool]$cfg.quotaSamples } else { $script:quotaSamples }
  $SetHint.Text = ''
  $win.Width = 372  # 设置视图内容窄,恢复默认宽;回到数据视图时按模型名单行宽度自适应
  $SettingsPanel.Visibility = 'Visible'
}
function Save-Settings {
  try { Add-Content -Path (Join-Path $env:USERPROFILE '.zcode\scripts\save-settings.log') -Value ("ENTER " + (Get-Date -Format 'HH:mm:ss')) } catch { }
  Write-WidgetLog ('保存设置: 采样=' + [bool]$SetSamples.IsChecked + ' 告警=' + [bool]$SetAlertsOn.IsChecked + ' 注入=' + [bool]$SetSessionInject.IsChecked + ' 续跑=' + [bool]$SetResumeGuard.IsChecked)
  $refresh = $script:refreshChoices[[Math]::Max(0, $SetRefresh.SelectedIndex)]
  # 每池独立阈值:下拉索引 0 = 关闭(0);其余按所选百分比解析,含 Set-ThresholdCombo 补的自定义项(如 87%(自定义))
  $ths = @{}
  foreach ($pair in @(@('prompt5h', $SetTh5h), @('weekly', $SetThWeekly), @('mcp', $SetThMcp))) {
    $cb = $pair[1]
    $i = [Math]::Max(0, $cb.SelectedIndex)
    if ($i -eq 0) { $ths[$pair[0]] = 0; continue }
    $label = if ($cb.SelectedItem) { [string]$cb.SelectedItem.Content } else { '' }
    $num = if ($label -match '^(\d+)(?:\.\d+)?%') { [int]$Matches[1] } else { 95 }
    if ($num -lt 0 -or $num -gt 99) { $num = 95 }
    $ths[$pair[0]] = $num
  }
  $mods = $script:modChoices[[Math]::Max(0, $SetHotkeyMod.SelectedIndex)].V
  $vk = $script:keyVks[[Math]::Max(0, $SetHotkeyKey.SelectedIndex)]
  # 显示格式:模型名(0=full,1=short);数字(0=full,1=compact,2=cn)
  $modelNameFmt = if ($SetModelName.SelectedIndex -eq 0) { 'full' } else { 'short' }
  $tokenFmt = switch ([Math]::Max(0, $SetNumFmt.SelectedIndex)) { 0 { 'full' } 2 { 'cn' } default { 'compact' } }
  # 开关:告警总开关(联动阈值区);会话注入(默认关,由 SessionStart 钩子读配置决定是否注入);续跑总开关
  $alertsEnabled = [bool]$SetAlertsOn.IsChecked
  $sessionInject = [bool]$SetSessionInject.IsChecked
  $resumeGuard = [bool]$SetResumeGuard.IsChecked
  $quotaSamples = [bool]$SetSamples.IsChecked
  # 合并保留 guard 的其它配置键(如 warnIntervalMinutes)
  $cfg = Read-SettingsJson
  $obj = @{
    threshold = $ths['prompt5h']
    thresholds = $ths
    warnIntervalMinutes = if ($cfg -and $cfg.warnIntervalMinutes) { [int]$cfg.warnIntervalMinutes } else { 10 }
    refreshMinutes = $refresh
    hotkeyModifiers = $mods
    hotkeyKey = $vk
    modelNameFmt = $modelNameFmt
    tokenFmt = $tokenFmt
    alertsEnabled = $alertsEnabled
    sessionInject = $sessionInject
    resumeGuard = $resumeGuard
    quotaSamples = $quotaSamples
  }
  try {
    # -ErrorAction Stop:全局 SilentlyContinue 会吞掉非终止错误,导致"看起来保存了其实没写"
    $obj | ConvertTo-Json | Set-Content -Path $settingsFile -Encoding ASCII -ErrorAction Stop
    try { Add-Content -Path (Join-Path $env:USERPROFILE '.zcode\scripts\save-settings.log') -Value ("WROTE " + $settingsFile) } catch { }
  } catch {
    try { Add-Content -Path (Join-Path $env:USERPROFILE '.zcode\scripts\save-settings.log') -Value ("ERR " + $_.Exception.Message) } catch { }
    $SetHint.Text = "保存失败: $($_.Exception.Message)"; return
  }
  # 定时器:改间隔即生效
  $script:refreshMinutes = $refresh
  $timer.Interval = [TimeSpan]::FromMinutes($refresh)
  # 显示格式:改完即生效(保存后的 Invoke-Refresh 会按新格式重渲染;💹 弹窗悬停时重算)
  $script:modelNameFmt = $modelNameFmt
  $script:tokenFmt = $tokenFmt
  # 开关:告警总开关立即生效;会话注入由 SessionStart 钩子每次启动时读配置文件,下次会话生效;
  # 续跑总开关由 Stop 钩子读配置,同样下次收尾生效
  $script:alertsEnabled = $alertsEnabled
  $script:sessionInject = $sessionInject
  $script:resumeGuard = $resumeGuard
  $script:quotaSamples = $quotaSamples
  # 快捷键:解旧注新;被占用则回退原键并留在面板提示
  if ($mods -ne $script:hotkeyModifiers -or $vk -ne $script:hotkeyKey) {
    $ok = $false
    try {
      [void][GLMNative.Hotkey]::UnregisterHotKey($script:helper.Handle, 0xB001)
      $ok = [GLMNative.Hotkey]::RegisterHotKey($script:helper.Handle, 0xB001, $mods, $vk)
    } catch { }
    if ($ok) {
      $script:hotkeyModifiers = $mods
      $script:hotkeyKey = $vk
    } else {
      try { [void][GLMNative.Hotkey]::RegisterHotKey($script:helper.Handle, 0xB001, $script:hotkeyModifiers, $script:hotkeyKey) } catch { }
      $SetHint.Text = "新快捷键 $(ModsName $mods)+$([char]$vk) 已被其他软件占用,已保留原键 $(ModsName $script:hotkeyModifiers)+$([char]$script:hotkeyKey)"
      return
    }
  }
  Update-HotkeyHints  # 快捷键可能已变,底部提示同步
  Hide-Settings
  Invoke-Refresh
}

# 自动刷新间隔:来自 quota-guard-settings.json(⚙ 面板可改,保存即生效)
$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMinutes($script:refreshMinutes)
$timer.Add_Tick({ if ($SetupPanel.Visibility -ne 'Visible' -and $SettingsPanel.Visibility -ne 'Visible') { Invoke-Refresh } })

# ⚙ 设置,↻ 刷新,✕ 收起(隐藏不退出);悬停变亮
$BtnSettings.Add_MouseEnter({ $BtnSettings.Foreground = Brush $script:theme.Label })
$BtnSettings.Add_MouseLeave({ $BtnSettings.Foreground = Brush $script:theme.Secondary })
$BtnSettings.Add_MouseLeftButtonUp({ Show-Settings })
$BtnSaveSettings.Add_MouseEnter({ $BtnSaveSettings.Background = Brush '#3D9BFF' })
$BtnSaveSettings.Add_MouseLeave({ $BtnSaveSettings.Background = Brush '#0A84FF' })
$BtnSaveSettings.Add_MouseLeftButtonUp({ Save-Settings })
# 🔑 API Key 手动配置入口(右键菜单已移除,归入 ⚙ 设置)
$BtnOpenSetup.Add_MouseEnter({ $BtnOpenSetup.Background = Brush '#3D9BFF' })
$BtnOpenSetup.Add_MouseLeave({ $BtnOpenSetup.Background = Brush $script:theme.Secondary })
$BtnOpenSetup.Add_MouseLeftButtonUp({ Show-Setup })
# 额度告警总开关联动:取消勾选时,组内下面的阈值/注入/续跑全部置灰锁定(实时预览,保存才落盘)
$SetAlertsOn.Add_Click({
  $on = [bool]$SetAlertsOn.IsChecked
  $AlertsPanel.IsEnabled = $on
  $SetSessionInject.IsEnabled = $on
  $SetResumeGuard.IsEnabled = $on
})
$BtnCancelSettings.Add_MouseLeftButtonUp({ Hide-Settings; Invoke-Refresh })
$BtnRefresh.Add_MouseEnter({ $BtnRefresh.Foreground = Brush $script:theme.Label })
$BtnRefresh.Add_MouseLeave({ $BtnRefresh.Foreground = Brush $script:theme.Secondary })
$BtnRefresh.Add_MouseLeftButtonUp({ Invoke-Refresh })
$BtnClose.Add_MouseEnter({ $BtnClose.Foreground = Brush '#FF5A5A' })
$BtnClose.Add_MouseLeave({ $BtnClose.Foreground = Brush $script:theme.Secondary })
$BtnClose.Add_MouseLeftButtonUp({ $win.Hide() })

# 拖动(避开交互控件),记忆位置。
# 命中测试:从点击处沿祖先链找,落在任何交互控件(下拉框/按钮/输入框)内就放行给控件自己,
# 其余区域(标题/标签/空白)任何时候都可拖拽——包括设置面板打开时(标签和空白处拖,不挡控件)。
# 🔑/⚙/↻/✕ 按钮必须排除:Down 一旦触发 DragMove 会吞掉 Up,按钮点击就"没反应"
$script:interactive = @(
  $SetRefresh, $SetHotkeyMod, $SetHotkeyKey, $SetTh5h, $SetThWeekly, $SetThMcp,
  $BtnSaveSettings, $BtnCancelSettings, $SetupBase, $SetupKey, $BtnSaveKey, $BtnClearKey,
  $BtnSettings, $BtnRefresh, $BtnClose, $BtnKey, $BtnLocal, $BtnOpenSetup, $BtnCurve, $BtnCurve
)
function Test-OnInteractive($el) {
  $cur = $el
  while ($null -ne $cur) {
    foreach ($c in $script:interactive) { if ([object]::ReferenceEquals($cur, $c)) { return $true } }
    $cur = $cur.Parent
  }
  return $false
}
$win.Add_MouseLeftButtonDown({
  $src = $_.OriginalSource
  if (Test-OnInteractive $src) { return } # 交互控件自己处理点击(下拉框/按钮/输入框)
  $win.DragMove(); Save-Pos
})
$win.Add_Closing({ Save-Pos })

# 全局快捷键(⚙ 面板可改):0x2=Ctrl,0x1=Alt,0x4=Shift 可组合;G=0x47
# 初值来自 quota-guard-settings.json(见顶部设置读取),保存即解旧注新
$script:helper = $null
$win.Add_SourceInitialized({
  $script:helper = New-Object System.Windows.Interop.WindowInteropHelper($win)
  $hkOk = [GLMNative.Hotkey]::RegisterHotKey($script:helper.Handle, 0xB001, $script:hotkeyModifiers, $script:hotkeyKey)
  if (-not $hkOk) {
    # 全局热键被其他软件占用:醒目提示,避免"按了没反应"无从排查
    $mods = (@{ 1 = 'Alt'; 2 = 'Ctrl'; 4 = 'Shift'; 8 = 'Win' }[[int]$script:hotkeyModifiers])
    $key = [char]$script:hotkeyKey
    $Hint.Text = "⚠ ${mods}+$key 已被其他软件占用,快捷键不可用(改键:⚙ 设置 → 唤出快捷键)"
    $Hint.Foreground = Brush '#FFA94D'
  }
  # 💹 本机/账号对比弹窗:悬停即开,移开即关
  $LocalPopup.PlacementTarget = $BtnLocal
  $LocalPopup.Placement = 'Bottom'
  $BtnLocal.Add_MouseEnter({
    try {
      if ($script:lastLocal) {
        $loc = [double]$script:lastLocal.totalTokens
        $tot = $script:lastTotalTokens
        $pct = if ($tot -gt 0) { [Math]::Round($loc / $tot * 100, 1) } else { 0 }
        $LPct.Text = '本机 {0}%' -f $pct
        $LCalls.Text = '{0:N0} 次' -f [double]$script:lastLocal.calls
        $LIO.Text = '{0} / {1} / {2}' -f (Format-Tokens ([double]$script:lastLocal.inputTokens)), (Format-Tokens ([double]$script:lastLocal.outputTokens)), (Format-Tokens $loc)
        $ms = @($script:lastLocal.byModel.PSObject.Properties | ForEach-Object { '{0} {1}' -f (Format-ModelName $_.Name), (Format-Tokens ([double]$_.Value.tokens)) })
        if ($ms.Count) { $LModels.Text = $ms -join ' · '; $LModelsRow.Visibility = 'Visible' } else { $LModelsRow.Visibility = 'Collapsed' }
        $LTotalVal.Text = '{0:N0} 次 · {1}' -f [double]$script:lastTotalCalls, (Format-Tokens $tot)
        $w = [Math]::Round(282 * [Math]::Min(100, [Math]::Max(0, $pct)) / 100)
        $LFill.Width = [Math]::Max($w, 6)
      } else {
        $LPct.Text = ''; $LCalls.Text = ''; $LIO.Text = ''; $LModels.Text = ''; $LTotalVal.Text = ''
        $LFill.Width = 0; $LModelsRow.Visibility = 'Collapsed'
      }
    } catch { }
    $LocalPopup.IsOpen = $true
  })
  $BtnLocal.Add_MouseLeave({ $LocalPopup.IsOpen = $false })
  $src = [System.Windows.Interop.HwndSource]::FromHwnd($script:helper.Handle)
  $src.AddHook({
    param($hwnd, $msg, $wParam, $lParam, [ref]$handled)
    if ($msg -eq 0x0312 -and $wParam.ToInt64() -eq 0xB001) {
      if ($win.IsVisible) { $win.Hide() } else { $win.Show() }
      $handled.Value = $true
    }
    [IntPtr]::Zero
  })
})

# ZCode 启动检测:none→running 才算启动(避免 Electron 子进程重建误唤起)
$script:zcodeWasRunning = [bool](Get-Process -Name 'ZCode' -ErrorAction SilentlyContinue)
# 主题切换去抖:连续两次探测一致才换肤——单次坏采样(纯白弹窗/未渲染的新窗口)不触发
$script:darkStreak = 0
$script:pendingDark = $null
$zcodeTimer = New-Object System.Windows.Threading.DispatcherTimer
$zcodeTimer.Interval = [TimeSpan]::FromMilliseconds(2000)
$zcodeTimer.Add_Tick({
  # ZCode 外观跟随:探测 ZCode 主窗口配色,变化即整体换肤(并记日志便于排查)
  $dark = Get-IsDarkTheme
  if ($dark -ne $script:isDark) {
    $script:darkStreak = 1 + [int]($script:pendingDark -eq $dark)
    $script:pendingDark = $dark
    if ($script:darkStreak -ge 2) {
      $script:isDark = $dark
      Apply-Theme
      try {
        Add-Content -Path (Join-Path $env:USERPROFILE '.zcode\scripts\widget-theme.log') `
          -Value ("{0} -> {1}" -f (Get-Date -Format 'MM/dd HH:mm:ss'), $(if ($dark) { 'dark' } else { 'light' }))
      } catch { }
      $script:darkStreak = 0
    }
  } else {
    $script:darkStreak = 0
  }
  # 高峰横幅:进入/退出高峰与倒计时刷新(2s 粒度)
  Update-PeakBanner
  # 自存活检测:本脚本被删(= 插件已卸载)则自行退出
  if ($PSCommandPath -and -not (Test-Path $PSCommandPath)) { [Environment]::Exit(0) }
  $running = [bool](Get-Process -Name 'ZCode' -ErrorAction SilentlyContinue)
  if ($running -and -not $script:zcodeWasRunning) {
    # ZCode 启动:唤起
    if (-not $win.IsVisible) { $win.Show() }
    $win.Activate()
  }
  elseif (-not $running -and $script:zcodeWasRunning) {
    # ZCode 完全退出:悬浮窗随之退出(生命周期完全绑定)
    try { if ($script:helper) { [GLMNative.Hotkey]::UnregisterHotKey($script:helper.Handle, 0xB001) | Out-Null } } catch { }
    $timer.Stop()
    $win.Close()
    [Environment]::Exit(0)
  }
  $script:zcodeWasRunning = $running
})
$zcodeTimer.Start()

# 唤醒轮询:双通道 —— 命名事件(手动再次启动)+ 唤醒文件(SessionStart hook touch)
$wakeTimer = New-Object System.Windows.Threading.DispatcherTimer
$wakeTimer.Interval = [TimeSpan]::FromMilliseconds(250)
$wakeTimer.Add_Tick({
  $wake = $showEvt.WaitOne(0)
  $wi = Get-Item $wakeFile -ErrorAction SilentlyContinue
  if ($wi -and $wi.LastWriteTimeUtc -gt $script:lastWake) {
    $script:lastWake = $wi.LastWriteTimeUtc
    $wake = $true
  }
  # 只负责唤回;已可见时不 Activate,避免抢焦点(Topmost 本就在最上层)
  if ($wake -and -not $win.IsVisible) { $win.Show() }
})
$wakeTimer.Start()

# 📈 用量曲线:拉起 quota-curve.mjs(本地只读服务 + 浏览器窗口;单实例,已有服务直接再开一窗)
# 采样(自动记录)默认关:未开启时不起服务,提示先到 ⚙ 设置开启
function Invoke-CurveLaunch {
  # 点 📈 即视为要用曲线:采样没开就自动开启并落盘(⚙ 里的勾选框下次打开会同步显示为已开)
  # 免去"先去 ⚙ 勾选"的流程,也不会出现开关状态错位导致的打不开
  try {
    $cfgObj = Read-SettingsJson
    if (-not $cfgObj -or $cfgObj.quotaSamples -ne $true) {
      $o = if ($cfgObj) { $cfgObj } else { @{} }
      $o.quotaSamples = $true
      $json = ConvertTo-Json $o -Depth 5
      [System.IO.File]::WriteAllText($settingsFile, $json)  # WriteAllText 不带 BOM,避免影响各处 JSON 读取
      $script:quotaSamples = $true
      Write-WidgetLog '采样记录已自动开启(点击 📈 触发)'
      $Hint.Text = '已为你开启额度采样记录'
      $Hint.Foreground = Brush '#3CB371'
    }
  } catch { }
  $curveScript = Join-Path $env:USERPROFILE '.zcode\scripts\quota-curve.mjs'
  if (-not (Test-Path $curveScript)) {
    $cached = Get-ChildItem "$env:USERPROFILE\.zcode\cli\plugins\cache\*\zcode-usage*\*\skills\zcode-usage\scripts\quota-curve.mjs" -ErrorAction SilentlyContinue |
      Sort-Object FullName -Descending | Select-Object -First 1
    if ($cached) { $curveScript = $cached.FullName }
  }
  if ((Test-Path $curveScript) -and $script:nodeExe) {
    Start-Process -WindowStyle Hidden -FilePath $script:nodeExe -ArgumentList "`"$curveScript`""
    return
  }
  $Hint.Text = '⚠ 未找到 quota-curve.mjs 或 Node 不可用(可重新 --install)'
  $Hint.Foreground = Brush '#FFA94D'
}
# 📈 可见入口:当日行右侧,点击打开曲线页
$BtnCurve.Add_MouseEnter({ $BtnCurve.Foreground = Brush $script:theme.Label })
$BtnCurve.Add_MouseLeave({ $BtnCurve.Foreground = Brush $script:theme.Secondary })
$BtnCurve.Add_MouseLeftButtonUp({ Invoke-CurveLaunch })

# 🔑 按钮与配置表单:悬停变亮、点击打开/保存/清除;密码框里回车 = 保存
$BtnKey.Add_MouseEnter({ $BtnKey.Background = Brush '#3D9BFF' })
$BtnKey.Add_MouseLeave({ $BtnKey.Background = Brush '#0A84FF' })
$BtnKey.Add_MouseLeftButtonUp({ Show-Setup })
$BtnSaveKey.Add_MouseEnter({ $BtnSaveKey.Background = Brush '#3D9BFF' })
$BtnSaveKey.Add_MouseLeave({ $BtnSaveKey.Background = Brush '#0A84FF' })
$BtnSaveKey.Add_MouseLeftButtonUp({ Save-Setup })
$BtnClearKey.Add_MouseLeftButtonUp({
  Clear-ManualCred
  Hide-Setup
  Invoke-Refresh
})
$SetupKey.Add_KeyDown({ if ($_.Key -eq 'Return') { Save-Setup } })

# 应用主题(与 ZCode 外观一致);此后 zcodeTimer 每 2 秒探测 ZCode 配色并跟随切换
$script:isDark = Get-IsDarkTheme
try { Apply-Theme } catch {
  try { Add-Content (Join-Path $env:USERPROFILE '.zcode\scripts\widget-theme.log') ("startup Apply-Theme THREW: " + $_.Exception.Message) } catch { }
}

# UI 线程未处理异常兜底:记日志并标记 Handled,避免任何漏网异常直接带走进程(窗口凭空消失的死法)
$win.Dispatcher.UnhandledException.Add({
  param($s, $e)
  try {
    Write-WidgetLog ('UI 未处理异常: ' + $e.Exception.Message)
    if ($e.Exception.StackTrace) { Write-WidgetLog ('  at ' + ($e.Exception.StackTrace -replace "`r?`n", ' | ')) }
    $e.Handled = $true
  } catch { }
})

try {
  Update-PeakBanner
  # 先 Show 再刷新:窗口未显示时布局引擎不给 ActualHeight(恒为 0),
  # 宽度自适应的换行检测会失效;先亮窗口,刷新期间面板显示"正在读取…"是正常状态
  $win.Show()
  Invoke-Refresh
  $timer.Start()
} catch {
  Write-WidgetLog ('启动失败: ' + $_.Exception.Message)
  if ($_.ScriptStackTrace) { Write-WidgetLog ('  at ' + ($_.ScriptStackTrace -replace "`r?`n", ' | ')) }
  # 即使启动期有异常也要把窗口亮出来、定时器跑起来,别让用户面对一个凭空消失的悬浮窗
  try { $timer.Start(); $win.Show() } catch { }
}
[System.Windows.Threading.Dispatcher]::Run()
