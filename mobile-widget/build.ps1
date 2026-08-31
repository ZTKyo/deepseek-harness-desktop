# DSH Watchdog Widget - 零依赖构建（aapt2 + javac + d8 + zipalign + apksigner）
# 用法: pwsh -File mobile-widget\build.ps1
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$app  = Join-Path $root 'app'
$out  = Join-Path $root 'build'
$apkName = 'dsh-watchdog-widget.apk'

# --- 定位工具链 ---
$sdk = $env:ANDROID_SDK_ROOT; if (-not $sdk) { $sdk = "$env:LOCALAPPDATA\Android\Sdk" }
$platform = Join-Path $sdk 'platforms\android-36'
$bt = Join-Path $sdk 'build-tools\36.0.0'
if (-not (Test-Path "$platform\android.jar")) { throw "android.jar not found: $platform" }
if (-not (Test-Path "$bt\aapt2.exe")) { throw "build-tools 36.0.0 not found: $bt" }
$aapt2 = Join-Path $bt 'aapt2.exe'
$zipalign = Join-Path $bt 'zipalign.exe'
$d8jar = Join-Path $bt 'lib\d8.jar'

# JDK: PATH 优先，其次 Temurin 17 默认安装位
$javac = Get-Command javac.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if ($javac) { $jdkBin = Split-Path $javac.Source -Parent }
else {
  $jdkBin = (Get-ChildItem 'C:\Program Files\Eclipse Adoptium' -Directory -ErrorAction SilentlyContinue |
    Where-Object Name -like 'jdk-17*' | Sort-Object Name -Descending |
    Select-Object -First 1).FullName + '\bin'
}
if (-not ($jdkBin -and (Test-Path "$jdkBin\javac.exe"))) { throw 'JDK 17 not found (javac)' }
$java = Join-Path $jdkBin 'java.exe'
$jar  = Join-Path $jdkBin 'jar.exe'
$keytool = Join-Path $jdkBin 'keytool.exe'
Write-Host "JDK: $jdkBin"

# --- 清理/准备 ---
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Path "$out\gen","$out\classes","$out\dex" -Force | Out-Null

# --- 1. aapt2 compile + link ---
& $aapt2 compile --dir (Join-Path $app 'res') -o "$out\res.zip"
if ($LASTEXITCODE -ne 0) { throw 'aapt2 compile failed' }
& $aapt2 link -I "$platform\android.jar" --manifest (Join-Path $app 'AndroidManifest.xml') `
  --java "$out\gen" -o "$out\base.apk" "$out\res.zip" --auto-add-overlay
if ($LASTEXITCODE -ne 0) { throw 'aapt2 link failed' }

# --- 2. javac（对 android.jar 编译，8 级字节码，d8 desugar）---
$sources = @(Get-ChildItem (Join-Path $app 'java') -Recurse -Filter '*.java' | ForEach-Object { $_.FullName })
$rJava = "$out\gen\com\dsh\watchdog\widget\R.java"
if (Test-Path $rJava) { $sources += $rJava } else { throw "R.java not generated at $rJava" }
& "$jdkBin\javac.exe" -source 8 -target 8 -bootclasspath "$platform\android.jar" `
  -classpath "$platform\android.jar" -d "$out\classes" -encoding UTF-8 @sources
if ($LASTEXITCODE -ne 0) { throw 'javac failed' }

# --- 3. d8 → classes.dex ---
& $java -cp $d8jar com.android.tools.r8.D8 --release --min-api 26 --lib "$platform\android.jar" `
  --output "$out\dex" (Get-ChildItem "$out\classes" -Recurse -Filter '*.class' | ForEach-Object { $_.FullName })
if ($LASTEXITCODE -ne 0) { throw 'd8 failed' }

# --- 4. dex 入包 ---
& $jar uf "$out\base.apk" -C "$out\dex" classes.dex
if ($LASTEXITCODE -ne 0) { throw 'jar uf failed' }

# --- 5. zipalign ---
& $zipalign -f 4 "$out\base.apk" "$out\aligned.apk"
if ($LASTEXITCODE -ne 0) { throw 'zipalign failed' }

# --- 6. 签名（本地 debug keystore，首次自动生成）---
$ksDir = Join-Path $root 'keystore'
$ks = Join-Path $ksDir 'dsh-widget-debug.jks'
New-Item -ItemType Directory -Path $ksDir -Force | Out-Null
if (-not (Test-Path $ks)) {
  $oldEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  & $keytool -genkeypair -v -keystore $ks -alias dshwidget -keyalg RSA -keysize 2048 `
    -validity 10950 -storepass dshwidget -keypass dshwidget `
    -dname 'CN=DSH Watchdog Widget, OU=Local, O=DSH, C=CN' 2>&1 | Out-Null
  $ErrorActionPreference = $oldEap
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $ks)) { throw 'keytool keystore generation failed' }
  Write-Host 'keystore: 生成新 debug keystore (pass=dshwidget)'
}
$apksigner = Join-Path $bt 'lib\apksigner.jar'
& $java -jar $apksigner sign --ks $ks --ks-pass pass:dshwidget --key-pass pass:dshwidget `
  --out (Join-Path $root $apkName) "$out\aligned.apk"
if ($LASTEXITCODE -ne 0) { throw 'apksigner failed' }

# --- 7. 验签 ---
& $java -jar $apksigner verify --print-certs (Join-Path $root $apkName)
if ($LASTEXITCODE -ne 0) { throw 'apksigner verify failed' }
$size = [math]::Round((Get-Item (Join-Path $root $apkName)).Length / 1KB)
Write-Host "BUILD OK -> $apkName ($size KB)"
