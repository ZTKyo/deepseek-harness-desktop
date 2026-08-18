// DSH Harness - native Windows desktop client for the DeepSeek Harness Web GUI.
// Compiled with the built-in .NET Framework csc (C# 5), WPF without XAML,
// hosting a WebView2 control (SDK 1.0.2151.40 assemblies, WebView2 Runtime).
//
// Behavior:
//   1. Checks whether the DSH web server (127.0.0.1:3080) is up.
//   2. If not, starts `dsh web` (detached, output to a log file) and polls until ready.
//   3. Opens the GUI in a dedicated WebView2 window with an isolated profile.
//   4. Closing the window does NOT stop the server.
using System;
using System.IO;
using System.Net;
using System.Diagnostics;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace DSHHarness
{
    public class DSHClient : Application
    {
        private const string ServerUrl = "http://127.0.0.1:3080/";
        private const string AppTitle = "DeepSeek Harness";

        private Window _win;
        private WebView2 _web;
        private TextBlock _status;
        private bool _probeMode;

        [STAThread]
        public static void Main()
        {
            bool createdNew;
            using (new Mutex(true, "DSHHarness.SingleInstance", out createdNew))
            {
                if (!createdNew)
                {
                    // Another instance is already running; bring it to the front.
                    try { NativeMethods.BringExistingToFront(); } catch { }
                    return;
                }
                string[] args = Environment.GetCommandLineArgs();
                for (int i = 1; i < args.Length; i++)
                {
                    if (String.Equals(args[i], "-probe", StringComparison.OrdinalIgnoreCase))
                    {
                        DSHClient probe = new DSHClient();
                        probe.RunProbe();
                        return;
                    }
                }
                DSHClient app = new DSHClient();
                app.RunWindow();
            }
        }

        // Diagnostic mode: load the page, record the navigation result to probe-result.json, exit.
        private void RunProbe()
        {
            BuildUi();
            _status.Text = "probe: connecting…";
            _win.Width = 900;
            _win.Height = 600;
            _win.ShowInTaskbar = false;
            _probeMode = true;
            this.Run(_win);
        }

        private void RunWindow()
        {
            BuildUi();
            this.Run(_win);
        }

        private void BuildUi()
        {
            Color bg = Color.FromRgb(13, 17, 28);
            System.Drawing.Color wvBg = System.Drawing.Color.FromArgb(255, 13, 17, 28);

            _win = new Window();
            _win.Title = AppTitle;
            _win.Width = 1500;
            _win.Height = 950;
            _win.WindowStartupLocation = WindowStartupLocation.CenterScreen;
            _win.Background = new SolidColorBrush(bg);
            _win.UseLayoutRounding = true;

            Grid grid = new Grid();

            _web = new WebView2();
            _web.DefaultBackgroundColor = wvBg;
            Grid.SetZIndex(_web, 0);

            _status = new TextBlock();
            _status.Text = "正在连接 DSH 服务 (127.0.0.1:3080) …";
            _status.Foreground = new SolidColorBrush(Colors.White);
            _status.FontSize = 16;
            _status.HorizontalAlignment = HorizontalAlignment.Center;
            _status.VerticalAlignment = VerticalAlignment.Center;
            Grid.SetZIndex(_status, 1);

            grid.Children.Add(_web);
            grid.Children.Add(_status);
            _win.Content = grid;

            _win.Loaded += OnLoaded;
        }

        private async void OnLoaded(object sender, RoutedEventArgs e)
        {
            try
            {
                StepLog("OnLoaded: start");
                bool up = IsServerUp();
                StepLog("OnLoaded: server up = " + up);
                if (!up)
                {
                    _status.Text = "DSH 服务未运行，正在尝试启动…";
                    StepLog("OnLoaded: starting server");
                    StartServer();
                    DateTime deadline = DateTime.UtcNow.AddSeconds(120);
                    int waited = 0;
                    while (!IsServerUp())
                    {
                        if (DateTime.UtcNow > deadline)
                        {
                            _status.Text = "无法启动 DSH 服务，仍将尝试打开页面。";
                            StepLog("OnLoaded: server start timed out");
                            break;
                        }
                        waited += 1;
                        if (waited % 5 == 0)
                        {
                            _status.Text = "正在等待 DSH 服务启动… (" + waited + "s)";
                        }
                        await Task.Delay(1000);
                    }
                }

                _status.Text = "正在加载界面…";
                StepLog("OnLoaded: creating WebView2 env");

                string dataDir = GetWritableDir("WebView2");
                StepLog("OnLoaded: dataDir = " + dataDir);
                CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(null, dataDir, null);
                StepLog("OnLoaded: env created");
                await _web.EnsureCoreWebView2Async(env);
                StepLog("OnLoaded: webview2 ready, navigating");

                _web.CoreWebView2.Navigate(ServerUrl);
                _web.CoreWebView2.NavigationCompleted += OnNavigationCompleted;

                if (_probeMode)
                {
                    System.Windows.Threading.DispatcherTimer watchdog = new System.Windows.Threading.DispatcherTimer();
                    watchdog.Interval = TimeSpan.FromSeconds(30);
                    watchdog.Tick += delegate(object s2, EventArgs e2)
                    {
                        StepLog("PROBE TIMEOUT: no navigation completion within 30s");
                        WriteProbeResult(null);
                        this.Shutdown();
                    };
                    watchdog.Start();
                }
            }
            catch (Exception ex)
            {
                StepLog("OnLoaded EXCEPTION: " + ex.ToString());
                _status.Text = "初始化失败：" + ex.Message + "\n可尝试使用 DSH Harness.cmd（Edge 模式）打开。";
                if (_probeMode)
                {
                    WriteProbeResult(null);
                    this.Shutdown();
                }
            }
        }

        private void OnNavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            StepLog("NavigationCompleted: ok=" + e.IsSuccess + " status=" + e.HttpStatusCode + " err=" + e.WebErrorStatus + " url=" + _web.CoreWebView2.Source);
            _status.Visibility = Visibility.Collapsed;
            _win.Title = AppTitle;
            if (_probeMode)
            {
                WriteProbeResult(e);
                this.Shutdown();
            }
        }

        private void StepLog(string msg)
        {
            if (!_probeMode) return; // only log in diagnostic mode
            try
            {
                File.AppendAllText(
                    Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "probe-step.log"),
                    DateTime.Now.ToString("HH:mm:ss.fff") + "  " + msg + Environment.NewLine);
            }
            catch { }
        }

        private void WriteProbeResult(CoreWebView2NavigationCompletedEventArgs e)
        {
            try
            {
                string path = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "probe-result.json");
                string json = "{" +
                    "\"ok\":" + (e != null && e.IsSuccess ? "true" : "false") + "," +
                    "\"url\":\"" + JsonEscape(_web.CoreWebView2 != null ? _web.CoreWebView2.Source : "") + "\"," +
                    "\"title\":\"" + JsonEscape(_web.CoreWebView2 != null ? _web.CoreWebView2.DocumentTitle : "") + "\"," +
                    "\"status\":" + (e != null ? e.HttpStatusCode : 0) + "," +
                    "\"error\":" + (e != null ? (int)e.WebErrorStatus : -1) + "," +
                    "\"time\":\"" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "\"" +
                    "}";
                File.WriteAllText(path, json);
            }
            catch { }
        }

        private static string JsonEscape(string s)
        {
            if (s == null) return "";
            return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "").Replace("\n", "");
        }

        private static bool IsServerUp()
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(ServerUrl);
                req.Timeout = 1500;
                req.Method = "GET";
                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                {
                    return resp.StatusCode == HttpStatusCode.OK;
                }
            }
            catch
            {
                return false;
            }
        }

        private static void StartServer()
        {
            try
            {
                string dsh = ResolveDsh();
                string log = Path.Combine(GetWritableDir("logs"), "dsh-server-3080.log");
                // cmd /c ""<dsh>" web > "<log>" 2>&1"  (hidden window, output redirected)
                string inner = "\"" + dsh + "\" web > \"" + log + "\" 2>&1";
                ProcessStartInfo psi = new ProcessStartInfo("cmd.exe", "/c \"" + inner + "\"");
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.WorkingDirectory = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                Process.Start(psi);
            }
            catch
            {
                // If we cannot start the server, the UI still tries to navigate below.
            }
        }

        private static string ResolveDsh()
        {
            // 1) Resolve via PATH (where.exe dsh -> dsh.cmd shim).
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo("where.exe", "dsh");
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                using (Process p = Process.Start(psi))
                {
                    string line = p.StandardOutput.ReadLine();
                    p.WaitForExit(3000);
                    if (!String.IsNullOrEmpty(line))
                    {
                        line = line.Trim();
                        if (File.Exists(line)) return line;
                        if (line.IndexOf(".cmd", StringComparison.OrdinalIgnoreCase) >= 0) return line;
                    }
                }
            }
            catch { }

            // 2) Known npx caches.
            string[] roots = new string[] {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "npm-cache", "_npx"),

            };
            foreach (string root in roots)
            {
                try
                {
                    if (!Directory.Exists(root)) continue;
                    foreach (string dir in Directory.GetDirectories(root))
                    {
                        string cand = Path.Combine(dir, "node_modules", ".bin", "dsh.cmd");
                        if (File.Exists(cand)) return cand;
                    }
                }
                catch { }
            }

            // 3) Last resort: rely on PATH.
            return "dsh";
        }

        // Prefer %LOCALAPPDATA%\DSHHarness\<sub>; fall back to <exe-dir>\data\<sub>
        // if the per-user location is not writable (e.g. sandboxed/portable use).
        private static string GetWritableDir(string sub)
        {
            string baseDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "DSHHarness");
            try
            {
                Directory.CreateDirectory(baseDir);
                string probe = Path.Combine(baseDir, ".write-probe");
                File.WriteAllText(probe, "x");
                File.Delete(probe);
                return Path.Combine(baseDir, sub);
            }
            catch
            {
                string alt = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "data");
                Directory.CreateDirectory(alt);
                return Path.Combine(alt, sub);
            }
        }
    }

    internal static class NativeMethods
    {
        // Minimal Win32 interop to focus an already-running instance.
        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        public static void BringExistingToFront()
        {
            Process current = Process.GetCurrentProcess();
            foreach (Process p in Process.GetProcessesByName(current.ProcessName))
            {
                if (p.Id != current.Id && p.MainWindowHandle != IntPtr.Zero)
                {
                    ShowWindow(p.MainWindowHandle, 9); // SW_RESTORE
                    SetForegroundWindow(p.MainWindowHandle);
                    return;
                }
            }
        }
    }
}
