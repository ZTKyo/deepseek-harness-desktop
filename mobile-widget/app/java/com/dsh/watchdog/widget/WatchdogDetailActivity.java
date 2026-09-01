package com.dsh.watchdog.widget;

import android.app.Activity;
import android.appwidget.AppWidgetManager;
import android.content.Intent;
import android.graphics.Typeface;
import android.os.AsyncTask;
import android.os.Bundle;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

/**
 * R5：只读 Detail Activity。点击 widget 主体打开；严格 READ ONLY（无任何写/恢复调用）。
 * 复用 WatchdogWidgetProvider 的 fetch()/Snapshot/TaskInfo（同包），实时拉取并渲染
 * Host/Connectivity、主机状态、当前任务、最近完成 + 诊断字段（gen/rev/sessionId/goalId 等）。
 */
public class WatchdogDetailActivity extends Activity {

	private LinearLayout body;
	private String baseUrl = "";
	private String token = "";

	@Override
	protected void onCreate(Bundle savedInstanceState) {
		super.onCreate(savedInstanceState);
		setContentView(R.layout.activity_detail);

		body = (LinearLayout) findViewById(R.id.detailBody);
		baseUrl = WatchdogWidgetProvider.prefs(this).getString("baseUrl", "");
		token = WatchdogWidgetProvider.prefs(this).getString("token", "");

		findViewById(R.id.btnDetailRefresh).setOnClickListener(new View.OnClickListener() {
			@Override public void onClick(View v) { refresh(); }
		});

		refresh();
	}

	private void refresh() {
		body.removeAllViews();
		if (baseUrl == null || baseUrl.trim().isEmpty()) {
			addText("未配置主机地址（请先在 Widget 设置页填入）", 16, 0xFFF2B344, 24, 8);
			return;
		}
		head("主机 / 连接");
		addText("地址： " + baseUrl, 13, 0xFF9AA7B4, 0, 2);
		addText("通道： 只读 GET /watchdog/status", 13, 0xFF9AA7B4, 0, 2);
		// 顶部「设备」相对状态区
		new LoadTask().execute();
	}

	private void render(WatchdogWidgetProvider.Snapshot s) {
		if (s.error != null) {
			addText("错误： " + s.error, 14, 0xFFE06A5A, 8, 6);
		}
		head("主机状态");
		TextView st = new TextView(this);
		st.setText(WatchdogWidgetProvider.zhState(s.state));
		st.setTextColor(WatchdogWidgetProvider.colorFor(s.state));
		st.setTextSize(16);
		st.setTypeface(null, Typeface.BOLD);
		body.addView(st);
		if (s.stateReason != null && !s.stateReason.isEmpty()) {
			addText(s.stateReason, 12, 0xFF8A9AA6, 0, 2);
		}
		if (!s.modelLine.isEmpty()) {
			addText("默认模型： " + s.modelLine, 12, 0xFF8A9AA6, 4, 2);
		}
		if (!s.watchdogVersion.isEmpty()) {
			addText("watchdog 版本： " + s.watchdogVersion, 12, 0xFF8A9AA6, 0, 2);
		}
		if (!s.generatedAt.isEmpty()) {
			addText("最近同步： " + isoToLocal(s.generatedAt), 12, 0xFF8A9AA6, 0, 2);
		}
		if (s.pollMs > 0) {
			addText("刷新策略： poll+" + (s.pollMs / 1000) + "s", 12, 0xFF8A9AA6, 0, 2);
		}

		// 当前任务（非终端）
		head("当前任务");
		int current = 0;
		for (WatchdogWidgetProvider.TaskInfo t : s.tasks) {
			if (t.terminal) continue;
			taskBlock(t, false);
			current++;
		}
		if (current == 0) addText("（无进行中任务）", 12, 0xFF8A9AA6, 0, 4);

		// 最近完成（终端）
		head("最近完成");
		int done = 0;
		for (WatchdogWidgetProvider.TaskInfo t : s.tasks) {
			if (!t.terminal) continue;
			taskBlock(t, true);
			done++;
		}
		if (done == 0) addText("（无最近完成）", 12, 0xFF8A9AA6, 0, 4);
	}

	private void taskBlock(WatchdogWidgetProvider.TaskInfo t, boolean terminal) {
		LinearLayout card = new LinearLayout(this);
		card.setOrientation(LinearLayout.VERTICAL);
		card.setPadding(dp(10), dp(8), dp(10), dp(8));
		android.graphics.drawable.GradientDrawable bg = new android.graphics.drawable.GradientDrawable();
		bg.setCornerRadius(dp(10));
		bg.setColor(0x1AFFFFFF);
		card.setBackground(bg);
		LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
				LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
		lp.bottomMargin = dp(8);
		card.setLayoutParams(lp);

		// 状态 + 标题
		LinearLayout row = new LinearLayout(this);
		row.setOrientation(LinearLayout.HORIZONTAL);
		TextView state = new TextView(this);
		state.setText(WatchdogWidgetProvider.zhState(t.state));
		state.setTextColor(WatchdogWidgetProvider.colorFor(t.state));
		state.setTextSize(12);
		state.setTypeface(null, Typeface.BOLD);
		row.addView(state);
		TextView title = new TextView(this);
		title.setText(t.title == null || t.title.isEmpty() ? "(无标题)" : t.title);
		title.setTextColor(0xFFE6EDF3);
		title.setTextSize(13);
		LinearLayout.LayoutParams tlp = new LinearLayout.LayoutParams(0,
				LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
		tlp.leftMargin = dp(8);
		title.setLayoutParams(tlp);
		row.addView(title);
		card.addView(row);

		// 进度 / 完成信息
		if (terminal) {
			if (t.completedAt > 0) {
				addCardText(card, "完成于 " + WatchdogWidgetProvider.fmtTime(t.completedAt)
						+ (t.finalDurationMs > 0 ? " · 用时 " + WatchdogWidgetProvider.fmtDur(t.finalDurationMs) : ""), 12);
			} else {
				addCardText(card, "已完成", 12);
			}
		} else if (t.lastProgressAt > 0) {
			addCardText(card, "进展 " + WatchdogWidgetProvider.fmtTime(t.lastProgressAt), 12);
		}
		if (t.startedAt > 0) addCardText(card, "开始 " + WatchdogWidgetProvider.fmtTime(t.startedAt), 12);
		if (t.currentStep != null && !t.currentStep.isEmpty()) {
			addCardText(card, "步骤 " + t.currentStep, 12);
		}
		// 诊断字段（只读展示，不上报）
		String diag = "";
		if (t.generation != null && !t.generation.isEmpty()) diag += "gen " + t.generation;
		if (t.revision > 0) diag += (diag.isEmpty() ? "" : " · ") + "rev " + t.revision;
		if (!t.sessionId.isEmpty()) diag += (diag.isEmpty() ? "" : " · ") + "sid " + shortId(t.sessionId);
		if (!t.goalId.isEmpty()) diag += (diag.isEmpty() ? "" : " · ") + "goal " + shortId(t.goalId);
		if (diag.isEmpty()) diag = "diagnostics n/a";
		TextView dv = new TextView(this);
		dv.setText(diag);
		dv.setTextColor(0xFF6E7A85);
		dv.setTextSize(10);
		card.addView(dv);
		body.addView(card);
	}

	private void addCardText(LinearLayout card, String txt, int sp) {
		TextView tv = new TextView(this);
		tv.setText(txt);
		tv.setTextColor(0xFF9AA7B4);
		tv.setTextSize(sp);
		LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
				LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
		lp.topMargin = dp(2);
		tv.setLayoutParams(lp);
		card.addView(tv);
	}

	private void head(String txt) {
		TextView tv = new TextView(this);
		tv.setText(txt);
		tv.setTextColor(0xFF8A9AA6);
		tv.setTextSize(14);
		tv.setTypeface(null, Typeface.BOLD);
		LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
				LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
		lp.topMargin = dp(18);
		lp.bottomMargin = dp(6);
		tv.setLayoutParams(lp);
		body.addView(tv);
	}

	private void addText(String txt, int sp, int color, int topDp, int bottomDp) {
		TextView tv = new TextView(this);
		tv.setText(txt);
		tv.setTextColor(color);
		tv.setTextSize(sp);
		LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
				LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
		lp.topMargin = dp(topDp);
		lp.bottomMargin = dp(bottomDp);
		tv.setLayoutParams(lp);
		body.addView(tv);
	}

	private int dp(int v) { return Math.round(getResources().getDisplayMetrics().density * v); }

	private String shortId(String id) {
		if (id == null) return "";
		return id.length() > 10 ? id.substring(0, 10) + "…" : id;
	}

	private String isoToLocal(String iso) {
		try {
			String z = iso.replace("Z", "").replace("+00:00", "");
			if (z.length() > 19) z = z.substring(0, 19);
			SimpleDateFormat isoF = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US);
			isoF.setTimeZone(TimeZone.getTimeZone("UTC"));
			Date d = isoF.parse(z);
			if (d != null) {
				return new SimpleDateFormat("MM-dd HH:mm:ss", Locale.getDefault()).format(d);
			}
		} catch (Exception ignore) { }
		return iso;
	}

	private final class LoadTask extends AsyncTask<Void, Void, WatchdogWidgetProvider.Snapshot> {
		@Override
		protected WatchdogWidgetProvider.Snapshot doInBackground(Void... none) {
			return WatchdogWidgetProvider.fetch(baseUrl, token);
		}
		@Override
		protected void onPostExecute(WatchdogWidgetProvider.Snapshot s) {
			render(s);
		}
	}
}
