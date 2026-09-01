# MIUI 小部件库找不到自定义 AppWidget —— 调试报告（交 AI 分析）

> 本文是一份自包含、面向外部 AI（如 ChatGPT）的现象陈述与分析请求。
> 所有观测均来自真机 adb 实测，非推断。请据此判断根因并给出下一步实验建议。

---

## 0. 一句话问题

一个**已正常注册进 Android AppWidgetService** 的自定义 AppWidget（包名 `com.dsh.watchdog.widget`，应用名 `DSH Watchdog`，小部件名 `DSH 看板`），在 **小米 MIUI（HyperOS）的「添加小部件」界面里完全找不到**——无论是「全部应用」分类列表（共 39 个应用）还是搜索框（搜 `DSH` / `watchdog` / `baidu`）都无结果。

---

## 1. 设备与环境

| 项 | 值 |
|---|---|
| 设备 | 小米平板/折叠屏（屏幕 1200×2670，疑似 MIUI/HyperOS 平板或折叠内屏） |
| 桌面/系统 | MIUI / HyperOS，`com.miui.home`（桌面）、`com.miui.personalassistant`（小部件库） |
| 小部件库组件 | `com.miui.personalassistant/.picker.business.home.pages.PickerHomeActivity` |
| 接入方式 | PC adb：`adb install` 侧载安装（非小米应用商店） |
| 签名 | 本地 debug keystore `keystore/dsh-widget-debug.jks` |

---

## 2. 应用技术栈（从 build.gradle / manifest 读取）

- Gradle `8.10.2` / AGP `8.7.3`
- `compileSdk 35`，`buildToolsVersion 35.0.0`
- `minSdk 26`，`targetSdk 34`
- `applicationId` = `com.dsh.watchdog.widget`
- `versionCode 4`，`versionName 0.3.1`
- 依赖：Firebase BoM `33.7.0` + `firebase-messaging`
- 源码布局：`app/java`、`app/res`、`app/AndroidManifest.xml`

---

## 3. 代码层事实（已逐字核对）

### 3.1 `AndroidManifest.xml` 组件清单

| 组件 | 类型 | 行为/注释 |
|---|---|---|
| `MainActivity` | activity | `LAUNCHER`，`exported=true`，label=`app_name`。**注释明确写**：「MIUI 小部件选择器不索引无桌面图标的 widget-only 应用，此入口让本应用在小部件选择器中可见可添加」。即：开发者在之前就踩过「widget-only 应用被 MIUI 忽略」的坑，刻意加了一个占位 launcher 入口。 |
| `WatchdogConfigActivity` | activity | `android.appwidget.action.APPWIDGET_CONFIGURE`，`exported=true` |
| `WatchdogWidgetProvider` | `AppWidgetProvider` receiver | `exported=true`，label=`widget_label`；intent-filter：`APPWIDGET_UPDATE` + 自定义 `com.dsh.watchdog.widget.ACTION_FETCH`；meta-data `android.appwidget.provider` → `@xml/widget_info` |
| `WatchdogPollReceiver` | service | `BIND_JOB_SERVICE` 权限，`exported=false`（JobScheduler 15 分钟只读轮询） |
| `WatchdogFcmReceiver` | service | `com.google.firebase.MESSAGING_EVENT`，`exported=false`（FCM data-message 唤醒） |

- 权限仅两条：`INTERNET`、`RECEIVE_BOOT_COMPLETED`（注释说明已主动移除 FOREGROUND_SERVICE / POST_NOTIFICATIONS 等）。

### 3.2 `res/xml/widget_info.xml`（AppWidget provider 定义）

```xml
<appwidget-provider xmlns:android="http://schemas.android.com/apk/res/android"
    android:minWidth="250dp"
    android:minHeight="85dp"
    android:resizeMode="horizontal|vertical"
    android:targetCellWidth="4"
    android:targetCellHeight="2"
    android:updatePeriodMillis="1800000"
    android:initialLayout="@layout/widget_dsh_watchdog"
    android:configure="com.dsh.watchdog.widget.WatchdogConfigActivity"
    android:description="@string/widget_desc"
    android:widgetCategory="home_screen" />
```

### 3.3 `res/values/strings.xml`（相关）

- `app_name` = `DSH Watchdog`
- `widget_label` = `DSH 看板`

---

## 4. 系统层事实（dumpsys appwidget 实测）

`adb shell dumpsys appwidget` 中找到（provider 注册于 AppWidgetService）：

```
[220] provider:
  ProviderId{user:0, app:11009, cmp:ComponentInfo{com.dsh.watchdog.widget/com.dsh.watchdog.widget.WatchdogWidgetProvider}}
  min=(64001x21761) minResize=(64001x21761) updatePeriodMillis=1800000 resizeMode=3 widgetCategory=1
  autoAdvanceViewId=-1 initialLayout=#7f050128 initialKeyguardLayout=#0 zombie=false
```

**结论**：系统已把该 provider 正确解析并注册，`zombie=false`（非僵尸），`widgetCategory=1`（home_screen），`resizeMode=3`（水平+垂直），`updatePeriodMillis=1800000`。尺寸 `64001x21761`（约 4×2 格）。**系统层面完全正常**。

---

## 5. 现象复现过程（每一步均为 adb 实测）

### 5.1 打开小部件库主页

`am start -n com.miui.personalassistant/.picker.business.home.pages.PickerHomeActivity`

uiautomator dump 到的文本（主页）：
```
最大化，拖动手柄，向下滑动即可关闭
已购清单
添加小部件
搜索
推荐
分类
趣味
全部应用
系统工具
米家 · 手动控制
时钟 · 双时钟
相册 · 精选回忆
小米天气 · 自定义天气
```

### 5.2 进入「全部应用」分类列表

点「全部应用」后，出现「支持小部件应用」分组，共 39 个应用，包括：
```
小红书 · 共6个
小米商城 · 共3个
小米社区 · 共2个
小米设置 · 共2个
小米天气 · 共7个
西窗烛 · 共2个
应用商店 · 共2个
…（后续滚动见 抖音/火山/京东/快手/快看/微博/支付宝/知乎/米家/时钟/相册/系统工具 等）
```

**关键**：这 39 个应用里 **没有** `DSH Watchdog`。

### 5.3 搜索框搜索（试图精确定位）

点搜索（`搜索想要的小部件` placeholder），依次输入：

| 输入 | 结果 |
|---|---|
| `DSH` | **「暂未找到相关内容」** |
| `watchdog` | **「暂未找到相关内容」** |
| 清空后输入 `Dbaidu`（清空失败残留 D+baidu） | **「暂未找到相关内容」** |

**重点观察**：输入 `baidu` 也搜不到「百度」——即使「百度」明明是一个**已收录**（第 1 个，且有小部件）的应用。这说明**这个搜索框并不按 package/英文名搜索**，很可能只索引「中文显示名」或某个独立的在线索引表。

### 5.4 尝试刷新缓存

- `am force-stop com.miui.personalassistant` 后重新打开 → 搜索仍无结果。
- `am force-stop com.miui.home`（桌面）后重新打开 → 仍无结果。
- 未做整机重启。

---

## 6. 关键观察（这个界面的「性质」判断）

复查这个界面出现的文本，强烈提示**这不是系统本地 widget picker，而是 MIUI 的「在线小部件商店/推荐库」**：

- 出现「**已购清单**」「**猜您想搜**」「**搜索想要的小部件**」这类**电商/商店性质**的词。
- 「推荐 / 分类 / 趣味 / 全部应用 / 系统工具」是**内容分类 tab**。
- 「支持小部件应用」列表（39 个）混排了**系统级 widget**（米家/时钟/相册/小米天气/小米设置）与**小米生态或厂商合作应用**（小红书/西窗烛/应用商店/小米商城/微博/支付宝等），**但独独没有侧载的第三方应用**。

上述特征与 Android 系统标准的 `AppWidgetHostView` picker（长按桌面 → 添加小部件，列出本地 AppWidgetService 全部 provider）**不同**。系统标准 picker 会无脑列出所有已注册 provider，不会出现「已购清单 / 猜您想搜 / 搜索想要的小部件」。

---

## 7. 已排除的方向

1. ❌ **provider 未注册 / 僵尸**：`dumpsys appwidget` 明确 `zombie=false`，注册成功。
2. ❌ **widget_info 缺字段 / 语法错**：含 minWidth/minHeight/resizeMode/targetCell/updatePeriod/initialLayout/configure/description/widgetCategory，字段齐全且 app 能正常安装（无解析崩溃）。
3. ❌ **无 launcher 图标被忽略**：`MainActivity` 有 `LAUNCHER` intent-filter（且 manifest 注释表明正是为此加的占位入口），应用在桌面有图标。
4. ❌ **widgetCategory 不符**：`home_screen`（=1）正确。
5. ❌ **是「系统标准 picker 就是不列它」**：系统标准 AppWidgetHost picker 本应列出所有注册 provider；此处看不到，是因为**我们很可能根本不在系统标准 picker 里，而是在 MIUI 在线小部件商店页面**。
6. ❌ **targetSdk 过高**：`targetSdk 34` 是 Android 14，`compileSdk 35`，均属正常；未收到系统针对 targetSdk 的 widget 安装警告。

---

## 8. 候选根因假设（按可能性排序，供分析确认）

### H1（最可能）：我们找错了界面 —— PickerHomeActivity 是「在线小部件商店」，不是「本地 system picker」

证据：界面出现「已购清单 / 猜您想搜 / 搜索想要的小部件」；「支持小部件应用」是 MIUI 云端/合作收录名单；侧载应用不在其中；且连 `baidu` 都搜不到（索引不匹配英文/包名）。

推论：**本地自定义 widget 应从「桌面长按空白 → 添加小部件」进入**（那里走系统 AppWidgetHost 接口，列出所有本地 provider，包括 `DSH Watchdog`），而非 `PickerHomeActivity`。

### H2（次可能）：MIUI 对小部件库列表做了**侧载白名单**过滤

MIUI 小部件库的「全部应用 / 支持小部件应用」可能是**服务端下发**的收录名单，本地 `adb install` 的应用不在名单里；即便从系统 picker 能加，在线商店页也永远不显示。若用户从不打开系统 picker，就会误以为「找不到」。

### H3（较低可能）：搜索索引 bug / 索引未更新

新装应用的小部件未进入搜索索引，需整机重启或等待重建索引。但连 `baidu`（已收录应用）都搜不到，说明问题不在「仅新应用漏掉」，而是**搜索框语义/索引范围不同**（佐证 H1/H2）。

### H4（可基本排除）：镜像 / 屏显异常导致 provider 未真正可见

不成立——`dumpsys` 已确认注册。

---

## 9. 交给 AI 的具体问题

1. 依据第 5/6 节证据，`PickerHomeActivity` 究竟是不是**系统标准 AppWidget picker**？还是 MIUI 的**在线小部件商店/推荐库**？判断依据是什么（欢迎补充我遗漏的判据）？
2. 真实路径是否为**「长按桌面空白 → 添加小部件」**？若是，应如何通过 adb 把这一步精确触达（例如：是否需要 `am start` 某个 activity / 还是必须先模拟长按桌面拉出系统 picker）？
3. 若确认侧载应用**不在 MIUI 小部件库在线名单**，那么**侧载的第三方 AppWidget 到底能否被 MIUI 桌面添加**？在 HyperOS 上对侧载（非商店）app 的 widget 是否有额外校验（如签名、targetSdk、权限、跨桌面白名单）？
4. 我们**是否需要**在 `widget_info.xml` 加 `android:previewImage` / `android:description` / `android:previewLayout`，或者给 provider 加 `android:resource` 之外的必要属性，才能让 MIUI 收录？还是说 MIUI 压根不以这些属性作为收录依据？
5. 有没有可能这是**平板/折叠屏横竖屏**导致的 widget 尺寸显示问题（`min=(64001x21761)` 在 1200 宽屏幕上=53 个 cell，是否被 MIUI 判定为「超大/非法」而不展示）？

---

## 10. 建议的下一步验证（优先级）

1. **找到真正的系统 widget picker 入口**（长按桌面 → 添加小部件），确认 `DSH Watchdog` 是否出现在本地列表。这是整件事的分水岭。
2. 若系统 picker 能加 → 问题只在「在线商店不收录」，不影响实际使用，可把「添加小部件」指引改为走系统 picker。
3. 若系统 picker 也不能加 → 深入查 MIUI 对 side-load widget 的过滤规则。
