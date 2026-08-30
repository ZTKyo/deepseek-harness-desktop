package com.dsh.watchdog.widget;

import android.app.Activity;
import android.appwidget.AppWidgetManager;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;

/** 小组件配置页：填 adapter 公网地址 + WATCHDOG token（保存于本机 SharedPreferences）。 */
public class WatchdogConfigActivity extends Activity {

	private int appWidgetId = AppWidgetManager.INVALID_APPWIDGET_ID;

	@Override
	protected void onCreate(Bundle savedInstanceState) {
		super.onCreate(savedInstanceState);
		setResult(RESULT_CANCELED);
		Bundle ext = getIntent() != null ? getIntent().getExtras() : null;
		if (ext != null) {
			appWidgetId = ext.getInt(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID);
		}
		if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) { finish(); return; }

		setContentView(R.layout.activity_config);
		SharedPreferences p = WatchdogWidgetProvider.prefs(this);
		EditText url = findViewById(R.id.etBaseUrl);
		EditText tok = findViewById(R.id.etToken);
		url.setText(p.getString("baseUrl", ""));
		tok.setText(p.getString("token", ""));
		((TextView) findViewById(R.id.tvHint)).setText(
				"地址填 supervisor-mcp-adapter 的公网地址（如 https://xxx.trycloudflare.com），\n"
				+ "token 填 ~/.dsh/watchdog/token 的内容（与 MCP/bridge token 三分离）。\n"
				+ "本小组件为纯只读：只调用 GET /watchdog/status。");
		Button ok = findViewById(R.id.btnSave);
		ok.setOnClickListener(new View.OnClickListener() {
			@Override public void onClick(View v) {
				p.edit().putString("baseUrl", url.getText().toString().trim())
						.putString("token", tok.getText().toString().trim()).apply();
				WatchdogWidgetProvider.refreshOne(WatchdogConfigActivity.this,
						AppWidgetManager.getInstance(WatchdogConfigActivity.this), appWidgetId);
				Intent out = new Intent();
				out.putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId);
				setResult(RESULT_OK, out);
				finish();
			}
		});
	}
}
