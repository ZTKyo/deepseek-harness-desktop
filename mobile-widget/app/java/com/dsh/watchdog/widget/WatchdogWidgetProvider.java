package com.dsh.watchdog.widget;

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
import java.util.Date;
import java.util.Locale;

/**
 * DSH Watchdog Widget — 纯只读消费端（Phase 02.8 → R3 B 无常驻连接改造）。
 * 数据面：GET {baseUrl}/watchdog/status，Authorization: Bearer {token}
 * （baseUrl 通常为既有 p275 tunnel → supervisor-mcp-adapter:8091 的公网地址；
 *  adapter 侧 WATCHDOG token 独立鉴权后透传到 3080 同名路由）。
 *
 * R3 B（External Review B）：取消 R1 B1 的 SSE 前台服务长连接——
 *  - 周期更新 = JobScheduler 每 15 分钟只读轮询（WatchdogPollReceiver，系统
 *    在 Doze/网络受限时自动推迟，无前台通知、无常驻进程）；
 *  - 兜底 = widget_info updatePeriodMillis 30 分钟 + 点击手动刷新；
 *  - 近实时状态告警由服务端承担（watchdog 插件 R2 B：Telegram 旁路 / 可选 FCM）。
 * 零 mutation：本类没有任何写/恢复调用；恢复仅由宿主 watchdog 插件执行。
 *
 * R2 C（Firebase 前置就绪）：新增 FCM 唤醒入口——
 *  - requestFetch(ctx, trigger)：WatchdogFcmReceiver 收到 data-message 后调用的
 *    显式广播（静默刷新，不渲染「拉取中」占位）；触发源记录到本地诊断；
 *  - markDiag：最小本地诊断（时间戳/事件 id/触发源；不含 token，不上报远端）；
 *  - 15min JobScheduler / 30min widget / 手动刷新三路 fallback 语义全部保留。
 */
public class WatchdogWidgetProvider extends AppWidgetProvider {

	public static final String ACTION_FETCH = "com.dsh.watchdog.widget.ACTION_FETCH";
	/** R2 C：ACTION_FETCH 触发源 extra（"fcm"=推送唤醒；缺省=小组件点击手动刷新）。 */
	public static final String EXTRA_TRIGGER = "trigger";
	private static final String PREFS = "dsh_watchdog_widget";
	/** R2 C：最小本地诊断独立 prefs（只记时间戳/事件 id/触发源；不含 token）。 */
	private static final String PREFS_DIAG = "dsh_watchdog_diag";
	private static final String KEY_BASE_URL = "baseUrl";
	private static final String KEY_TOKEN = "token";
	private static final int POLL_JOB_ID = 1001;
	private static final long POLL_INTERVAL_MS = 15 * 60_000L; // R3 B：15 分钟只读轮询

	@Override
	public void onUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
		// 系统周期 onUpdate（30min 兜底）：静默刷新，不渲染「拉取中」占位
		for (int id : ids) refreshOne(ctx, mgr, id, false);
		schedulePoll(ctx); // 幂等：确保 15min JobScheduler 任务已注册（覆盖重装/恢复场景）
	}

	@Override
	public void onReceive(Context ctx, Intent intent) {
		super.onReceive(ctx, intent);
		if (ACTION_FETCH.equals(intent.getAction())) {
			// R3 B：小组件点击（PendingIntent，无 trigger extra）→ 手动刷新，渲染「拉取中」反馈；
			// R2 C：FCM 唤醒（trigger="fcm"）→ 静默刷新（推送即状态变化信号，不打扰界面）
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
			js.schedule(job); // 同 ID 重调度 = 覆盖，天然幂等
		} catch (Exception ignore) { /* 部分厂商调度限制时不致崩溃；仍有 30min 兜底 */ }
	}

	/**
	 * R2 C：外部唤醒入口（WatchdogFcmReceiver 等后台组件调用）。
	 * 显式组件广播（API 26+ 显式广播不受 implicit-broadcast 限制）；
	 * 带 trigger extra → onReceive 静默刷新，与手动点击（渲染占位）区分。
	 */
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
		// 仅用户主动触发时渲染「拉取中」占位（防止点刷新后界面无反馈）；
		// 后台周期轮询/FCM 唤醒静默拉取，避免每 15 分钟闪一次占位
		if (showFetching) {
			render(ctx, mgr, appWidgetId, "…", "拉取中", "", "", 0xFF8A9AA6, "点击重试");
		}
		new FetchTask(ctx, mgr, appWidgetId, baseUrl, token)
				.executeOnExecutor(AsyncTask.THREAD_POOL_EXECUTOR);
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
				render(ctx, mgr, appWidgetId, "OFFLINE", "无法连接", s.error, "", 0xFFD05050,
						"点击重试");
				return;
			}
			WatchdogWidgetProvider.markDiag(ctx, "last_fetch_updated_at",
					String.valueOf(System.currentTimeMillis()));
			int color = colorFor(s.state);
			// R4：多任务投影。tasks[] 为权威列表；tvTask 显示主任务名，meta 汇总任务状态矩阵。
			String task = s.taskName == null ? "" : trunc(s.taskName, 72);
			StringBuilder meta = new StringBuilder();
			if (!s.taskStates.isEmpty()) meta.append(s.taskStates);
			if (!s.genShort.isEmpty()) {
				if (meta.length() > 0) meta.append("  ·  ");
				meta.append("gen ").append(s.genShort);
			}
			if (s.rev > 0) {
				if (meta.length() > 0) meta.append("  ·  ");
				meta.append("rev ").append(s.rev);
			}
			if (s.taskCount > 0) {
				if (meta.length() > 0) meta.append("  ·  ");
				meta.append(s.taskCount).append(" 任务");
			}
			render(ctx, mgr, appWidgetId, s.state,
					task.isEmpty() ? "(无活跃任务)" : task,
					meta.toString(), s.modelLine, color, s.updatedAt);
		}
	}

	// ---- 只读 HTTP ----
	private static Snapshot fetch(String baseUrl, String token) {
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
			JSONObject task = o.optJSONObject("task");
			if (task != null) {
				s.taskName = task.optString("name", null);
				s.genShort = shortGen(task.optString("generation", ""));
				s.rev = task.optInt("revision", 0);
			}
			JSONObject model = o.optJSONObject("model");
			if (model != null) {
				s.modelLine = model.optString("provider", "?") + "/" + model.optString("model", "?");
			}
			// R4：多任务投影。tasks[] 为权威来源；主任务仍走 task shim（兼容 v1 消费方）。
			JSONArray tasks = o.optJSONArray("tasks");
			if (tasks != null) {
				s.taskCount = tasks.length();
				s.taskStates = summarizeTasks(tasks);
			} else {
				// 兼容旧快照（无 tasks[]）：退回 otherGoals 计数。
				JSONArray og = o.optJSONArray("otherGoals");
				s.taskCount = og == null ? 0 : og.length();
				if (s.taskCount > 0) s.taskStates = "+" + s.taskCount + " other";
			}
			String gen = o.optString("generatedAt", null);
			if (gen != null) {
				try {
					// timezone 修复：generatedAt 为 UTC ISO（带 Z 或 +00:00）。
					// 显式按 UTC 解析（否则 SimpleDateFormat 会按 JVM 本地时区误读），
					// 再转设备本地时区显示，避免「错误时刻标 UTC」的偏移问题。
					SimpleDateFormat iso = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US);
					iso.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
					String z = gen.replace("Z", "").replace("+00:00", "");
					Date d = iso.parse(z.length() > 19 ? z.substring(0, 19) : z);
					if (d != null) {
						SimpleDateFormat local = new SimpleDateFormat("HH:mm", Locale.getDefault());
						s.updatedAt = "更新 " + local.format(d);
					}
				} catch (Exception ignore) { s.updatedAt = ""; }
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

	// ---- 渲染 ----
	private static void render(Context ctx, AppWidgetManager mgr, int appWidgetId,
			String state, String task, String meta, String modelLine, int stateColor, String foot) {
		RemoteViews rv = new RemoteViews(ctx.getPackageName(), R.layout.widget_dsh_watchdog);
		rv.setTextViewText(R.id.tvState, state);
		rv.setTextColor(R.id.tvState, stateColor);
		rv.setTextViewText(R.id.tvTask, task);
		rv.setTextViewText(R.id.tvMeta, meta);
		rv.setTextViewText(R.id.tvModel, modelLine);
		rv.setTextViewText(R.id.tvFoot, foot);
		Intent it = new Intent(ctx, WatchdogWidgetProvider.class);
		it.setAction(ACTION_FETCH);
		it.setData(Uri.parse("dsh://fetch/" + appWidgetId)); // 区分 intent，确保 PendingIntent 生效
		rv.setOnClickPendingIntent(R.id.root,
				android.app.PendingIntent.getBroadcast(ctx, appWidgetId, it,
						android.app.PendingIntent.FLAG_UPDATE_CURRENT | android.app.PendingIntent.FLAG_IMMUTABLE));
		mgr.updateAppWidget(appWidgetId, rv);
	}

	private static String summarizeTasks(JSONArray tasks) {
		int running = 0, waiting = 0, stalled = 0, terminal = 0;
		for (int i = 0; i < tasks.length(); i++) {
			JSONObject t = tasks.optJSONObject(i);
			if (t == null) continue;
			String st = t.optString("state", "");
			if (st == null) st = "";
			switch (st) {
				case "RUNNING": running++; break;
				case "AWAITING_REVIEW": case "WAITING_USER": case "BLOCKED": waiting++; break;
				case "STALLED": stalled++; break;
				case "VERIFIED": case "CANCELLED": terminal++; break;
				default: break;
			}
		}
		StringBuilder sb = new StringBuilder();
		if (running > 0) sb.append("R x").append(running);
		if (waiting > 0) { if (sb.length() > 0) sb.append(' '); sb.append("W x").append(waiting); }
		if (stalled > 0) { if (sb.length() > 0) sb.append(' '); sb.append("S x").append(stalled); }
		if (terminal > 0) { if (sb.length() > 0) sb.append(' '); sb.append("Done x").append(terminal); }
		return sb.toString();
	}

	private static int colorFor(String st) {
		if (st == null) return 0xFF8A9AA6;
		switch (st) {
			case "RUNNING": return 0xFF4CC38A;
			case "STALLED": return 0xFFE06A5A;
			case "AWAITING_REVIEW": return 0xFFF2B344;
			case "RECOVERING": return 0xFF66B2E8;
			case "VERIFIED": return 0xFF4CC38A;
			case "BLOCKED": return 0xFFE06A5A;
			case "IDLE": return 0xFF8A9AA6;
			default: return 0xFF8A9AA6;
		}
	}

	private static String trunc(String s, int n) {
		if (s == null) return "";
		return s.length() <= n ? s : s.substring(0, n - 1) + "…";
	}

	private static String shortGen(String g) {
		if (g == null || g.isEmpty()) return "";
		// sg-xxxxxxxx-… / gen-… → 取前段可辨识部分
		String t = g.replaceFirst("^sg-", "").replaceFirst("^gen-", "");
		return t.length() > 8 ? t.substring(0, 8) : t;
	}

	private static final class Snapshot {
		String state = "UNKNOWN";
		String taskName = "";
		String genShort = "";
		int rev = 0;
		String modelLine = "";
		int taskCount = 0;      // R4：tasks[] 长度（权威多任务数）
		String taskStates = ""; // R4：状态矩阵摘要，如 "R x2  W x1"
		String updatedAt = "";
		String error = null;
	}
}
