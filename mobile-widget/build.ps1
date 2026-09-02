# DSH Watchdog Widget - Gradle 构建（R2 C：官方 Firebase Messaging SDK 集成）
# 用法: pwsh -File mobile-widget\build.ps1
#
# R2 C 背景：Widget APK 引入官方 Firebase BoM/firebase-messaging，其传递依赖树
# （15+ AAR：play-services-* / firebase-common/installations/datatransport/transport-* 等）
# 含 manifest 与资源合并，自建 aapt2/javac/d8 链无法可靠解析 → 本目录引入最小 Gradle
# build（仅服务本 APK；不触碰 Harness 主工程 build，不建立第二 Harness build authority）。
#
# 行为保留：JobScheduler 15min + Widget 30min + 手动刷新 fallback 不变（R3 B 语义）。
# APK 稳定输出路径 = mobile-widget\dsh-watchdog-widget.apk（签名沿用既有本地 keystore）。
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$apkName = 'dsh-watchdog-widget.apk'
$gradleVer = '8.10.2'

# --- JDK 17（Temurin 默认安装位；与旧链一致） ---
$jdkDir = (Get-ChildItem 'C:\Program Files\Eclipse Adoptium' -Directory -ErrorAction SilentlyContinue |
	Where-Object Name -like 'jdk-17*' | Sort-Object Name -Descending | Select-Object -First 1).FullName
if (-not ($jdkDir -and (Test-Path "$jdkDir\bin\javac.exe"))) { throw 'JDK 17 not found (javac)' }
$env:JAVA_HOME = $jdkDir
$jdkBin = Join-Path $jdkDir 'bin'
Write-Host "JDK: $jdkDir"

# --- Gradle 8.10.2（本机缓存 %USERPROFILE%\gradle-8.10.2；缺则自动下载，代理优先直连兜底） ---
$gradleBat = "$env:USERPROFILE\gradle-$gradleVer\bin\gradle.bat"
if (-not (Test-Path $gradleBat)) {
	$zip = "$env:USERPROFILE\gradle-$gradleVer-bin.zip"
	$url = "https://services.gradle.org/distributions/gradle-$gradleVer-bin.zip"
	$ok = $false
	foreach ($px in @('http://192.168.168.1:7890', $null)) {
		$cargs = @('-sSL', '--ssl-no-revoke', '-o', $zip)
		if ($px) { $cargs += @('-x', $px) }
		$cargs += $url
		& curl.exe @cargs 2>&1 | Out-Null
		if ($LASTEXITCODE -eq 0 -and (Test-Path $zip) -and (Get-Item $zip).Length -gt 100MB) { $ok = $true; break }
	}
	if (-not $ok) { throw "gradle $gradleVer download failed" }
	Expand-Archive -Path $zip -DestinationPath $env:USERPROFILE -Force
	Remove-Item $zip -Force
}
Write-Host "Gradle: $gradleBat"

# --- Android SDK 定位 + local.properties（gitignore；属性文件用正斜杠避免转义问题） ---
$sdk = "$env:LOCALAPPDATA\Android\Sdk"
if (-not (Test-Path "$sdk\platforms")) { throw "Android SDK not found: $sdk" }
$lp = Join-Path $root 'local.properties'
if (-not (Test-Path $lp)) {
	[System.IO.File]::WriteAllText($lp, "sdk.dir=$($sdk.Replace('\','/'))`n")
}

# --- 构建（首次运行会从 google()/mavenCentral() 解析 AGP+Firebase 依赖，耐心等待） ---
& $gradleBat -p $root copyFinalApk
if ($LASTEXITCODE -ne 0) { throw 'gradle build failed' }

# --- 签名验证（build-tools apksigner，与旧链同一验证口径） ---
$bt = Get-ChildItem (Join-Path $sdk 'build-tools') -Directory | Sort-Object Name -Descending | Select-Object -First 1
$apksigner = Join-Path $bt.FullName 'lib\apksigner.jar'
& (Join-Path $jdkBin 'java.exe') -jar $apksigner verify --print-certs (Join-Path $root $apkName)
if ($LASTEXITCODE -ne 0) { throw 'apksigner verify failed' }

$size = [math]::Round((Get-Item (Join-Path $root $apkName)).Length / 1MB, 2)
Write-Host "BUILD OK -> $apkName ($size MB)"
