package com.dsh.watchdog.widget;

import android.app.Activity;
import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.os.Bundle;
import android.view.View;
import android.widget.Button;
import android.widget.Toast;

/**
 * 占位主页（launcher entry）。
 *
 * <p>背景：MIUI 的小部件选择器不索引"无桌面图标"的 widget-only 应用，
 * 导致 PR #79 的 DSH 看板小部件无法通过系统 UI 添加到桌面。
 * 本 Activity 仅提供图标入口，让 MIUI 将本应用识别为普通应用，
 * 从而在小部件选择器中可见、可添加。功能全部由小部件提供。</p>
 *
 * <p>零状态、零权限扩展：不读写任何数据，不申请新权限。</p>
 *
 * <p>R2 D（2026-09-01）：新增「添加到桌面」按钮。MIUI/HyperOS 的小部件选择器
 * （PickerHomeActivity 在线商店 + 系统 AppWidgetPickActivity 被劫持）均无法
 * 可靠列出侧载的自定义 widget，故采用 Android 8.0（API 26）官方
 * {@link AppWidgetManager#requestPinAppWidget(ComponentName, android.os.Bundle,
 * android.app.PendingIntent)} 机制：按键时先经
 * {@link AppWidgetManager#isRequestPinAppWidgetSupported()} 真实 API 判断系统是否支持，
 * 支持则直接请求 Launcher 把 DSH 看板 widget 钉到桌面，绕过小部件收录/筛选。
 * 随后的「固定确认」对话框由系统 Launcher 弹出（MIUI 弹「是否添加小部件」，用户点确认
 * 即添加到桌面）。本应用不强依赖系统回调结果（结果常量/回调类在 API 31+ 才存在，
 * 为兼容 minSdk 26 概不引用），仅给出引导式 Toast，行为跨版本最稳健。</p>
 */
public class MainActivity extends Activity {

	@Override
	protected void onCreate(Bundle savedInstanceState) {
		super.onCreate(savedInstanceState);
		setContentView(R.layout.activity_main);

		Button btnPin = findViewById(R.id.btnPinWidget);
		btnPin.setOnClickListener(new View.OnClickListener() {
			@Override
			public void onClick(View v) {
				pinWidgetToHome();
			}
		});
	}

	/** 请求系统把 DSH 看板 widget 钉到桌面（Android 8.0+ 官方机制，无需任何新权限）。 */
	private void pinWidgetToHome() {
		AppWidgetManager awm = AppWidgetManager.getInstance(this);
		if (!awm.isRequestPinAppWidgetSupported()) {
			Toast.makeText(this, R.string.pin_not_supported, Toast.LENGTH_LONG).show();
			return;
		}

		ComponentName provider = new ComponentName(this, WatchdogWidgetProvider.class);
		// successCallback 传 null：结果由系统 Launcher 弹出「固定确认」对话框自行流转，
		// 本应用不读取结果，避免跨版本语义差异（兼容 minSdk 26）。
		awm.requestPinAppWidget(provider, null, null);

		Toast.makeText(this, R.string.pin_requested, Toast.LENGTH_LONG).show();
	}
}
