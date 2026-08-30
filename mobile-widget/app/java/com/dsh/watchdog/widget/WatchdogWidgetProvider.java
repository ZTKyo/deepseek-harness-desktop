package com.dsh.watchdog.widget;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.AsyncTask;
import android.widget.RemoteViews;

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
 * DSH Watchdog Widget — 纯只读消费端（Phase 02.8）。
 * 数据面：GET {baseUrl}/watchdog/status，Authorization: Bearer {token}
 * （baseUrl 通常为既有 p275 tunnel → supervisor-mcp-adapter:8091 的公网地址；
 *  adapter 侧 WATCHDOG token 独立鉴权后透传到 3080 同名路由）。
 * 零 mutation：本类没有任何写/恢复调用；恢复仅由宿主 watchdog 插件执行。
 */
public class WatchdogWidgetProvider extends AppWidgetProvider {

	public static final String ACTION_FETCH = "com.dsh.watchdog.widget.ACTION_FETCH";
	private static final String PREFS = "dsh_watchdog_widget";
	private static final String KEY_BASE_URL = "baseUrl";
	private static final String KEY_TOKEN = "token";

	@Override
	public void onUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
		for (int id : ids) refreshOne(ctx, mgr, id);
	}

	@Override
	public void onReceive(Context ctx, Intent intent) {
		super.onReceive(ctx, intent);
		if (ACTION_FETCH.equals(intent.getAction())) {
			AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
			int[] ids = mgr.getAppWidgetIds(new ComponentName(ctx, WatchdogWidgetProvider.class));
			for (int id : ids) refreshOne(ctx, mgr, id);
		}
	}

	static SharedPreferences prefs(Context ctx) {
		return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
	}

	static void refreshOne(Context ctx, AppWidgetManager mgr, int appWidgetId) {
		SharedPreferences p = prefs(ctx);
		String baseUrl = p.getString(KEY_BASE_URL, "");
		String token = p.getString(KEY_TOKEN, "");
		// 先渲染「拉取中」占位，防止点刷新后界面无反馈
		render(ctx, mgr, appWidgetId, "…", "拉取中", "", "", 0xFF8A9AA6, "点击重试");
		new FetchTask(ctx, mgr, appWidgetId, baseUrl, token).executeOnExecutor(AsyncTask.THREAD_POOL_EXECUTOR);
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
				render(ctx, mgr, appWidgetId, "OFFLINE", "无法连接", s.error, "", 0xFFD05050,
						"点击重试");
				return;
			}
			int color = colorFor(s.state);
			String task = s.taskName == null ? "" : trunc(s.taskName, 72);
			StringBuilder meta = new StringBuilder();
			if (!s.genShort.isEmpty()) meta.append("gen ").append(s.genShort);
			if (s.rev > 0) {
				if (meta.length() > 0) meta.append("  ·  ");
				meta.append("rev ").append(s.rev);
			}
			if (s.otherGoals > 0) {
				if (meta.length() > 0) meta.append("  ·  ");
				meta.append('+').append(s.otherGoals).append(" other");
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
			s.otherGoals = o.optJSONArray("otherGoals") == null ? 0 : o.optJSONArray("otherGoals").length();
			String gen = o.optString("generatedAt", null);
			if (gen != null) {
				try {
					SimpleDateFormat iso = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US);
					// generatedAt 为 UTC ISO（带 Z 或 +00:00），解析后转本地 HH:mm
					String z = gen.replace("Z", "").replace("+00:00", "");
					Date d = iso.parse(z.length() > 19 ? z.substring(0, 19) : z);
					if (d != null) {
						SimpleDateFormat hhmm = new SimpleDateFormat("HH:mm", Locale.getDefault());
						hhmm.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
						s.updatedAt = "更新 " + hhmm.format(d) + " UTC";
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
		int otherGoals = 0;
		String updatedAt = "";
		String error = null;
	}
}
