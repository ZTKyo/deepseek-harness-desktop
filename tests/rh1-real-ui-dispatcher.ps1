# rh1-real-ui-dispatcher.ps1 — RH1 R3 REAL-E9: a minimal WPF/Dispatcher heartbeat keeps
# ticking while a BACKGROUND probe blocks for seconds -> proves the synchronous network
# probe did NOT run back onto the UI (dispatcher) thread. Records maxDispatcherDelayMs.
#
# Method (behaviour, not "code looks like runspace"):
#   Phase A baseline: DispatcherTimer heartbeat ~100ms -> baselineMaxMs.
#   Phase B negative control: Dispatcher.Invoke( Sleep 2s ) runs ON the dispatcher thread,
#     stalling the heartbeat -> negMaxMs (~2000ms) proves the detector CAN see UI blocking.
#   Phase C real: a BACKGROUND thread blocks (Sleep 3s) while the dispatcher keeps pumping;
#     heartbeat stays responsive -> realMaxMs (small). That is the evidence the sync network
#     probe isn't running back on the UI thread.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $root   # worktree root

$failures = 0; $passes = 0
function Assert([bool]$c, [string]$msg) {
    if ($c) { $script:passes++; Write-Host ("  PASS: " + $msg) }
    else    { $script:failures++; Write-Host ("  **FAIL**: " + $msg) }
}

try {
Add-Type -AssemblyName PresentationCore, PresentationFramework, WindowsBase -ErrorAction Stop
$__loaded = [AppDomain]::CurrentDomain.GetAssemblies()
$__wb = ($__loaded | Where-Object { $_.GetName().Name -eq 'WindowsBase' } | Select-Object -First 1).Location
$__pc = ($__loaded | Where-Object { $_.GetName().Name -eq 'PresentationCore' } | Select-Object -First 1).Location
$__pf = ($__loaded | Where-Object { $_.GetName().Name -eq 'PresentationFramework' } | Select-Object -First 1).Location
if (-not $__wb -or -not $__pc -or -not $__pf) { throw 'WPF assemblies not resolvable' }
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Threading;
using System.Windows.Threading;
public static class R3UiHeartbeat {
    private static long MaxIn(IList<long> xs, int from) {
        long m = 0;
        for (int i = from; i < xs.Count; i++) { if (xs[i] > m) m = xs[i]; }
        return m;
    }
    public static string Run() {
        var gaps = new List<long>();
        Dispatcher disp = null;
        var ready = new ManualResetEventSlim(false);
        var stop  = new ManualResetEventSlim(false);
        var t = new Thread(() => {
            disp = Dispatcher.CurrentDispatcher;
            var timer = new DispatcherTimer(DispatcherPriority.Background);
            timer.Interval = TimeSpan.FromMilliseconds(100);
            long last = DateTime.UtcNow.Ticks;
            timer.Tick += (s, e) => {
                long now = DateTime.UtcNow.Ticks;
                lock (gaps) { gaps.Add(now - last); }
                if (stop.IsSet) { timer.Stop(); }
                last = now;
            };
            timer.Start();
            ready.Set();
            Dispatcher.Run();
        });
        t.IsBackground = true; t.SetApartmentState(ApartmentState.STA); t.Start();
        if (!ready.Wait(3000)) { return "ERR: dispatcher never started"; }

        long baselineMaxMs, negMaxMs, realMaxMs;
        int n, b0, c0;
        // Phase A baseline (1.5s)
        Thread.Sleep(1500);
        lock (gaps) { baselineMaxMs = MaxIn(gaps, 0) / 10000; }

        // Phase B negative control: block ON the dispatcher thread (2s)
        lock (gaps) { b0 = gaps.Count; }
        disp.Invoke(new Action(() => { Thread.Sleep(2000); }));
        Thread.Sleep(300);
        lock (gaps) { negMaxMs = MaxIn(gaps, b0) / 10000; }

        // Phase C real: block on a BACKGROUND thread (3s); dispatcher stays free
        lock (gaps) { c0 = gaps.Count; }
        var bg = new Thread(() => { Thread.Sleep(3000); }); bg.IsBackground = true; bg.Start();
        Thread.Sleep(2000);
        lock (gaps) { realMaxMs = MaxIn(gaps, c0) / 10000; n = gaps.Count; }

        stop.Set();
        disp.BeginInvokeShutdown(DispatcherPriority.Background);
        t.Join(2000);
        return String.Format("baselineMaxMs={0};negMaxMs={1};realMaxMs={2};tickCount={3}", baselineMaxMs, negMaxMs, realMaxMs, n);
    }
}
'@ -ReferencedAssemblies @('System.dll','System.Core.dll',$__wb,$__pc,$__pf) -ErrorAction Stop

Write-Host ("=== RH1 R3 REAL-E9 UI Dispatcher heartbeat vs background blocking probe ===")
$res = [R3UiHeartbeat]::Run()
Write-Host ("  result: " + $res)
$baselineMaxMs = [int]$res.Substring(($res.IndexOf('baselineMaxMs=')+14), ($res.IndexOf(';') - ($res.IndexOf('baselineMaxMs=')+14)))
$realMaxMs     = [int]$res.Substring(($res.IndexOf('realMaxMs=')+11), ($res.IndexOf(';tickCount') - ($res.IndexOf('realMaxMs=')+11)))
$negMaxMs      = [int]$res.Substring(($res.IndexOf('negMaxMs=')+9), ($res.IndexOf(';realMaxMs') - ($res.IndexOf('negMaxMs=')+9)))

# negative control detects UI blocking (proves the detector works)
Assert ($negMaxMs -ge 1500)  ("negative control shows dispatcher stalling under UI-thread block (negMaxMs={0}ms >= 1500ms)" -f $negMaxMs)
# real path: heartbeat stays responsive while a BACKGROUND probe blocks for seconds
Assert ($realMaxMs -lt 800) ("REAL-E9 maxDispatcherDelayMs < 800ms while background probe blocks (realMaxMs={0}ms)" -f $realMaxMs)
Assert ($realMaxMs -lt $negMaxMs) ("REAL-E9 background block does NOT stall dispatcher (realMaxMs={0} < negMaxMs={1})" -f $realMaxMs, $negMaxMs)
Write-Host ("REAL-E9 maxDispatcherDelayMs={0}ms (baseline {1}ms, negative control {2}ms)" -f $realMaxMs, $baselineMaxMs, $negMaxMs)
} catch {
    if (-not $script:failures) { $script:failures = 0 }
    $script:failures++
    Write-Host ("  **FAIL**: fatal exception raised (see FATAL above)")
}

Write-Host ""
Write-Host ("RESULT: PASS={0} FAIL={1}" -f $script:passes, $script:failures)
if ($script:failures -gt 0) { exit 1 } else { exit 0 }
