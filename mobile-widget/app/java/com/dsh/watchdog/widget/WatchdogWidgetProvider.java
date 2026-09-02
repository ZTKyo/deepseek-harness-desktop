package com.dsh.watchdog.widget;

import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.AsyncTask;
import android.view.View;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;

/**
 * DSH Watchdog Widget — 纯只读消费端（Phase 02.8 → R5 CORRECTION 多任务卡片 UI）。
 *
 * <p>数据面：GET {baseUrl}/watchdog/status，Authorization: Bearer {token}。
 * baseUrl 为稳定 HTTPS（R5：monitor.&lt;domain&gt; 命名隧道 → adapter:8091），非动态
 * trycloudflare；本类已知 baseUrl/token 仅为 SharedPreferences 配置值，绝不 hardcode
 * Windows path / hostname / Tailscale IP / ADB serial（P6 runtime-location-agnostic）。</p>
 *
 * <p>R5 多任务投影：tasks[] 为唯一权威任务来源。渲染「最多 3 当前 + 1 最近完成」独立卡片，
 * 中文状态，completion freeze（消费 completedAt/finalDurationMs/terminalCache；手机侧
 * 绝不重算，只在卡片上展示后端冻结的时刻与时长）——终端任务显示「完成于 HH:mm · 用时 Xm」，
 * 一经展示不随刷新漂移。主界面禁止 gen/rev/+N other（那些只在 Detail 页作为 diagnostics）。</p>
 *
 * <p>点击行为（R5）：widget 主体 → 打开只读 Detail Activity（WatchdogDetailActivity）；
 * 右上角独立 ↻ 按钮 → ACTION_FETCH 静默/手动刷新。</p>
 *
 * <p>保持旧版职责：JobScheduler 15min 只读轮询、FCM 唤醒、30min widget 兜底、手动点击。
 * 零 mutation：本类没有任何写/恢复调用。</p>
 */
public class WatchdogWidgetProvider extends AppWidgetProvider {

	public static final String ACTION_FETCH = "com.dsh.watchdog.widget.ACTION_FETCH";
	public static final String EXTRA_TRIGGER = "trigger";
	private static final String PREFS = "dsh_watchdog_widget";
	private static final String PREFS_DIAG = "dsh_watchdog_diag";
	private static final String KEY_BASE_URL = "baseUrl";
	private static final String KEY_TOKEN = "token";
	private static final int POLL_JOB_ID = 1001;
	private static final long POLL_INTERVAL_MS = 15 * 60_000L;
	// R5：最多 3 当前 + 1 最近完成 独立卡片（超出显示「还有 N 个任务」）
	private static final int MAX_ACTIVE_CARDS = 3;
	private static final int MAX_TERMINAL_CARDS = 1;

	@Override
	public void onUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
		for (int id : ids) refreshOne(ctx, mgr, id, false);
		schedulePoll(ctx);
	}

	@Override
	public void onReceive(Context ctx, Intent intent) {
		super.onReceive(ctx, intent);
		if (ACTION_FETCH.equals(intent.getAction())) {
			String trigger = intent.getStringExtra(EXTRA_TRIGGER);
			WatchdogWidgetProvider.markDiag(ctx, "last_fetch_trigger",
					trigger == null ? "manual" : trigger);
			boolean manual = trigger == null;
			AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
			int[] ids = mgr.getAppWidgetIds(new ComponentName(ctx, WatchdogWidgetProvider.class));
			for (int id : ids) refreshOne(ctx, mgr, id, manual);
		}
	}

	/** R3 B：注册 15 分钟周期 JobScheduler 任务（幂等；setPersisted 跨重启保活）。 */
	static void schedulePoll(Context ctx) {
		try {
			JobScheduler js = (JobScheduler) ctx.getSystemService(Context.JOB_SCHEDULER_SERVICE);
			if (js == null) return;
			JobInfo job = new JobInfo.Builder(POLL_JOB_ID,
					new ComponentName(ctx, WatchdogPollReceiver.class))
					.setPeriodic(POLL_INTERVAL_MS)
					.setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
					.setPersisted(true)
					.build();
			js.schedule(job);
		} catch (Exception ignore) { /* 部分厂商调度限制时不致崩溃；仍有 30min 兜底 */ }
	}

	/** R2 C：外部唤醒入口（WatchdogFcmReceiver 等后台组件调用）。 */
	public static void requestFetch(Context ctx, String trigger) {
		Intent i = new Intent(ACTION_FETCH);
		i.setClassName(ctx.getPackageName(), WatchdogWidgetProvider.class.getName());
		i.putExtra(EXTRA_TRIGGER, trigger == null ? "manual" : trigger);
		ctx.sendBroadcast(i);
	}

	/** R2 C：最小本地诊断（时间戳/事件 id/触发源；不含 token，不上报远端；失败静默）。 */
	static void markDiag(Context ctx, String key, String value) {
		try {
			ctx.getSharedPreferences(PREFS_DIAG, Context.MODE_PRIVATE)
					.edit().putString(key, value).apply();
		} catch (Exception ignore) { }
	}

	static SharedPreferences prefs(Context ctx) {
		return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
	}

	static void refreshOne(Context ctx, AppWidgetManager mgr, int appWidgetId, boolean showFetching) {
		SharedPreferences p = prefs(ctx);
		String baseUrl = p.getString(KEY_BASE_URL, "");
		String token = p.getString(KEY_TOKEN, "");
		if (showFetching) render(ctx, mgr, appWidgetId, placeholderSnapshot());
		new FetchTask(ctx, mgr, appWidgetId, baseUrl, token)
				.executeOnExecutor(AsyncTask.THREAD_POOL_EXECUTOR);
	}

	/** 拉取中占位（用户主动点击后才显示，周期/FCM 静默不打断界面）。 */
	private static Snapshot placeholderSnapshot() {
		Snapshot s = new Snapshot();
		s.state = "FETCHING";
		return s;
	}

	/** 后台只读拉取 + JSON 解析（org.json 为 Android 内置，零第三方依赖）。 */
	private static final class FetchTask extends AsyncTask<Void, Void, Snapshot> {
		private final Context ctx;
		private final AppWidgetManager mgr;
		private final int appWidgetId;
		private final String baseUrl;
		private final String token;

		FetchTask(Context c, AppWidgetManager m, int id, String base, String tok) {
			ctx = c; mgr = m; appWidgetId = id; baseUrl = base; token = tok;
		}

		@Override
		protected Snapshot doInBackground(Void... none) {
			return fetch(baseUrl, token);
		}

		@Override
		protected void onPostExecute(Snapshot s) {
			if (s.error != null) {
				WatchdogWidgetProvider.markDiag(ctx, "last_fetch_error_at",
						String.valueOf(System.currentTimeMillis()));
				s.state = "OFFLINE";
				render(ctx, mgr, appWidgetId, s);
				return;
			}
			WatchdogWidgetProvider.markDiag(ctx, "last_fetch_updated_at",
					String.valueOf(System.currentTimeMillis()));
			render(ctx, mgr, appWidgetId, s);
		}
	}

	// ---- 只读 HTTP ----
	static Snapshot fetch(String baseUrl, String token) {
		Snapshot s = new Snapshot();
		if (baseUrl == null || baseUrl.trim().isEmpty()) {
			s.error = "未配置地址（长按小组件 → 设置）";
			return s;
		}
		HttpURLConnection conn = null;
		try {
			String url = baseUrl.trim();
			if (!url.endsWith("/")) url = url + "/";
			url = url + "watchdog/status";
			conn = (HttpURLConnection) new URL(url).openConnection();
			conn.setConnectTimeout(10000);
			conn.setReadTimeout(10000);
			conn.setRequestMethod("GET");
			if (token != null && !token.trim().isEmpty()) {
				conn.setRequestProperty("Authorization", "Bearer " + token.trim());
			}
			int code = conn.getResponseCode();
			if (code == 401) { s.error = "token 无效（401）"; return s; }
			if (code != 200) { s.error = "HTTP " + code; return s; }
			InputStream in = conn.getInputStream();
			BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
			StringBuilder sb = new StringBuilder();
			String line;
			while ((line = r.readLine()) != null) sb.append(line);
			r.close();
			JSONObject o = new JSONObject(sb.toString());
			s.state = o.optString("state", "UNKNOWN");
			s.stateReason = o.optString("stateReason", null);
			s.generatedAt = o.optString("generatedAt", "");
			JSONObject wd = o.optJSONObject("watchdog");
			if (wd != null) s.watchdogVersion = wd.optString("version", "");
			JSONObject model = o.optJSONObject("model");
			if (model != null) {
				JSONObject dflt = model.optJSONObject("default");
				if (dflt != null) {
					s.modelLine = dflt.optString("provider", "?") + "/" + dflt.optString("model", "?");
				}
			}
			JSONObject fresh = o.optJSONObject("freshness");
			if (fresh != null) s.pollMs = fresh.optLong("pollMs", 0L);
			// R5：tasks[] 为唯一权威来源。
			JSONArray tasks = o.optJSONArray("tasks");
			if (tasks != null) {
				s.tasks = parseTasks(tasks);
			}
		} catch (JSONException je) {
			s.error = "响应异常: " + trunc(je.getMessage(), 40);
		} catch (Exception e) {
			s.error = trunc(String.valueOf(e.getMessage()), 48);
		} finally {
			if (conn != null) conn.disconnect();
		}
		return s;
	}

	private static List<TaskInfo> parseTasks(JSONArray arr) {
		List<TaskInfo> out = new ArrayList<>();
		for (int i = 0; i < arr.length(); i++) {
			JSONObject t = arr.optJSONObject(i);
			if (t == null) continue;
			TaskInfo ti = new TaskInfo();
			ti.taskId = t.optString("taskId", "");
			ti.sessionId = t.optString("sessionId", "");
			ti.goalId = t.optString("goalId", "");
			ti.title = t.optString("title", "");
			ti.state = t.optString("state", "UNKNOWN");
			ti.currentStep = t.optString("currentStep", null);
			ti.reviewState = t.optString("reviewState", null);
			ti.waitingReason = t.optString("waitingReason", null);
			ti.terminal = t.optBoolean("terminal", false);
			ti.startedAt = optLong(t, "startedAt");
			ti.lastProgressAt = optLong(t, "lastProgressAt");
			ti.completedAt = optLong(t, "completedAt");
			ti.finalDurationMs = optLong(t, "finalDurationMs");
			ti.generation = t.optString("generation", "");
			ti.revision = t.optInt("revision", 0);
			ti.updatedAt = optLong(t, "updatedAt");
			out.add(ti);
		}
		return out;
	}

	private static long optLong(JSONObject o, String key) {
		long v = o.optLong(key, 0L);
		return v;
	}

	// ---- 渲染（多任务卡片） ----
	private static void render(Context ctx, AppWidgetManager mgr, int appWidgetId, Snapshot s) {
		RemoteViews rv = new RemoteViews(ctx.getPackageName(), R.layout.widget_dsh_watchdog);
		boolean offline = "OFFLINE".equals(s.state);
		boolean fetching = "FETCHING".equals(s.state);

		rv.setTextViewText(R.id.tvState, zhState(s.state));
		rv.setTextColor(R.id.tvState, colorFor(s.state));

		String foot;
		if (s.error != null) foot = s.error;
		else if (fetching) foot = "拉取中…";
		else foot = s.generatedAt.isEmpty() ? "" : ("更新 " + isoToLocalHm(s.generatedAt));
		rv.setTextViewText(R.id.tvFoot, foot);
		rv.setViewVisibility(R.id.tvFoot, foot.isEmpty() ? View.GONE : View.VISIBLE);

		rv.removeAllViews(R.id.llTasks);
		if (!offline && !fetching) {
			int shown = appendTaskCards(ctx, rv, s.tasks);
			int overflow = s.tasks.size() - shown;
			if (overflow > 0) {
				rv.setTextViewText(R.id.tvOverflow, "还有 " + overflow + " 个任务");
				rv.setViewVisibility(R.id.tvOverflow, View.VISIBLE);
			} else {
				rv.setViewVisibility(R.id.tvOverflow, View.GONE);
			}
		} else {
			rv.setViewVisibility(R.id.tvOverflow, View.GONE);
		}

		// 主体点击 → 只读 Detail Activity（自己从 prefs 读取 baseUrl/token，实时拉取）。
		Intent body = new Intent(ctx, WatchdogDetailActivity.class);
		PendingIntent bodyPi = PendingIntent.getActivity(ctx, 3000 + appWidgetId, body,
				PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
		rv.setOnClickPendingIntent(R.id.root, bodyPi);

		// 右上独立 ↻ → ACTION_FETCH 刷新。
		Intent fetchI = new Intent(ctx, WatchdogWidgetProvider.class);
		fetchI.setAction(ACTION_FETCH);
		fetchI.setData(Uri.parse("dsh://fetch/" + appWidgetId));
		PendingIntent fetchPi = PendingIntent.getBroadcast(ctx, 4000 + appWidgetId, fetchI,
				PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
		rv.setOnClickPendingIntent(R.id.btnRefresh, fetchPi);

		mgr.updateAppWidget(appWidgetId, rv);
	}

	/** R5：最多 3 当前 + 1 最近完成 独立卡片；返回实际渲染卡片数。 */
	private static int appendTaskCards(Context ctx, RemoteViews rv, List<TaskInfo> tasks) {
		int shown = 0, active = 0, terminal = 0;
		for (TaskInfo ti : tasks) {
			if (ti.terminal) {
				if (terminal >= MAX_TERMINAL_CARDS) continue;
				terminal++;
			} else {
				if (active >= MAX_ACTIVE_CARDS) continue;
				active++;
			}
			RemoteViews card = new RemoteViews(ctx.getPackageName(), R.layout.widget_task_card);
			card.setTextViewText(R.id.tvBadge, zhState(ti.state));
			card.setTextColor(R.id.tvBadge, colorFor(ti.state));
			String title = ti.title == null ? "" : trunc(ti.title, 90);
			card.setTextViewText(R.id.tvTitle, title.isEmpty() ? "(无标题)" : title);
			String step = ti.currentStep == null ? "" : trunc(ti.currentStep, 64);
			card.setTextViewText(R.id.tvStep, step);
			card.setViewVisibility(R.id.tvStep, step.isEmpty() ? View.GONE : View.VISIBLE);
			String meta = taskMeta(ti);
			card.setTextViewText(R.id.tvMeta, meta);
			card.setViewVisibility(R.id.tvMeta, meta.isEmpty() ? View.GONE : View.VISIBLE);
			rv.addView(R.id.llTasks, card);
			shown++;
		}
		return shown;
	}

	/** 任务卡 meta：终端 = 完成时刻 + 用时（消费后端冻结值）；进行 = 最近进展时刻。 */
	private static String taskMeta(TaskInfo ti) {
		StringBuilder sb = new StringBuilder();
		if (ti.terminal) {
			if (ti.completedAt > 0) {
				sb.append("完成于 ").append(fmtTime(ti.completedAt));
				if (ti.finalDurationMs > 0) sb.append(" · 用时 ").append(fmtDur(ti.finalDurationMs));
			} else {
				sb.append("已完成");
			}
		} else if (ti.lastProgressAt > 0) {
			sb.append("进展 ").append(fmtTime(ti.lastProgressAt));
		}
		return sb.toString();
	}

	// ---- 中文状态 + 颜色 ----
	static String zhState(String st) {
		if (st == null) return "未知";
		switch (st) {
			case "RUNNING": return "运行中";
			case "STALLED": return "卡住";
			case "WAITING_USER": return "等待你";
			case "RECOVERING": return "恢复中";
			case "AWAITING_REVIEW": return "待确认";
			case "BLOCKED": return "受阻";
			case "COMPLETED": return "已完成";
			case "VERIFIED": return "已验证";
			case "FAILED": return "失败";
			case "PAUSED": return "暂停";
			case "FETCHING": return "拉取中…";
			case "OFFLINE": return "离线";
			default: return st.isEmpty() ? "未知" : st;
		}
	}

	static int colorFor(String st) {
		if (st == null) return 0xFF8A9AA6;
		switch (st) {
			case "RUNNING": case "COMPLETED": case "VERIFIED": return 0xFF4CC38A;
			case "STALLED": case "BLOCKED": case "FAILED": case "OFFLINE": return 0xFFE06A5A;
			case "WAITING_USER": case "AWAITING_REVIEW": return 0xFFF2B344;
			case "RECOVERING": return 0xFF66B2E8;
			case "PAUSED": return 0xFF9AA7B4;
			default: return 0xFF8A9AA6;
		}
	}

	// ---- 时间/时长格式化 ----
	static String fmtTime(long ms) {
		if (ms <= 0) return "";
		return new SimpleDateFormat("HH:mm", Locale.getDefault()).format(new Date(ms));
	}

	static String fmtDur(long ms) {
		if (ms <= 0) return "";
		long totalMin = ms / 60000L;
		long h = totalMin / 60L;
		long m = totalMin % 60L;
		if (h > 0) return h + "h" + (m > 0 ? (" " + m + "m") : "");
		return Math.max(1, m) + "m";
	}

	private static String isoToLocalHm(String iso) {
		try {
			// generatedAt 为 UTC ISO（可带 Z / +00:00）；显式按 UTC 解析再转本地显示。
			String z = iso.replace("Z", "").replace("+00:00", "");
			if (z.length() > 19) z = z.substring(0, 19);
			SimpleDateFormat isoF = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US);
			isoF.setTimeZone(TimeZone.getTimeZone("UTC"));
			Date d = isoF.parse(z);
			if (d != null) {
				SimpleDateFormat local = new SimpleDateFormat("HH:mm", Locale.getDefault());
				return local.format(d);
			}
		} catch (Exception ignore) { }
		return "";
	}

	private static String trunc(String s, int n) {
		if (s == null) return "";
		return s.length() <= n ? s : s.substring(0, Math.max(0, n - 1)) + "…";
	}

	static final class Snapshot {
		String state = "UNKNOWN";
		String stateReason = null;
		String generatedAt = "";
		String modelLine = "";
		String watchdogVersion = "";
		long pollMs = 0L;
		List<TaskInfo> tasks = new ArrayList<>();
		String error = null;
	}

	/** R5：单个任务投影（唯一来源 = 后端 tasks[]，手机不重算）。 */
	static final class TaskInfo {
		String taskId = "", sessionId = "", goalId = "", title = "", state = "UNKNOWN";
		String currentStep, reviewState, waitingReason, generation = "";
		boolean terminal = false;
		long startedAt = 0, lastProgressAt = 0, completedAt = 0, finalDurationMs = 0, updatedAt = 0;
		int revision = 0;
	}
}
