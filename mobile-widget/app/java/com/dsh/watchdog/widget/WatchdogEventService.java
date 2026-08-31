package com.dsh.watchdog.widget;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * DSH Watchdog Widget — 事件驱动近实时更新（Phase 02.8 R1 Blocker 1）。
 *
 * 链路：Watchdog 状态变化 → 服务端 SSE GET /watchdog/events（Bearer WATCHDOG token，
 * 只推 state/revision/event-id 元数据，不含 prompt/log/secret/snapshot）
 * → 本前台服务收到 state_change → 广播 ACTION_FETCH → WatchdogWidgetProvider
 * → GET /watchdog/status（脱敏投影）→ AppWidgetManager.updateAppWidget。
 *
 * - 30 分钟 updatePeriodMillis 保留为 stale/fallback，本服务才是近实时通道。
 * - 纯只读：本服务没有任何 mutation 调用；恢复仅由宿主 watchdog 插件执行。
 * - 零第三方依赖：HttpURLConnection 手写最小 SSE 解析；断线指数退避重连（1s→60s）。
 * - 凭据只从本机 SharedPreferences 读取，不进日志、不进 intent extra、不进通知。
 * - Doze 深度休眠可能暂停长连接；心跳超时后自动重连，30 分钟 fallback 兜底（如实标注）。
 */
public class WatchdogEventService extends Service {

	public static final String ACTION_START = "com.dsh.watchdog.widget.event.START";
	public static final String ACTION_STOP = "com.dsh.watchdog.widget.event.STOP";
	private static final String CHANNEL_ID = "dsh_watchdog_event";
	private static final int NOTIF_ID = 42;
	private static final int READ_TIMEOUT_MS = 40_000; // 服务端 15s 心跳；40s 静默判定死连
	private static final int CONNECT_TIMEOUT_MS = 10_000;
	private static final long REFRESH_MIN_INTERVAL_MS = 2_000; // 事件风暴节流

	private volatile Thread loopThread;
	private volatile boolean shouldRun = false;

	@Override
	public IBinder onBind(Intent intent) { return null; }

	@Override
	public int onStartCommand(Intent intent, int flags, int startId) {
		String action = intent != null ? intent.getAction() : ACTION_START;
		if (ACTION_STOP.equals(action)) {
			stopLoop();
			stopForeground(true);
			stopSelf();
			return START_NOT_STICKY;
		}
		startForegroundWithType();
		shouldRun = true;
		if (loopThread == null || !loopThread.isAlive()) {
			// 注意：android.jar 的 LambdaMetafactory 是剥离 stub，本项目禁用 lambda/方法引用
			loopThread = new Thread(new Runnable() {
				@Override public void run() { sseLoop(); }
			}, "dsh-watchdog-sse");
			loopThread.setDaemon(true);
			loopThread.start();
		}
		return START_STICKY;
	}

	@Override
	public void onDestroy() {
		stopLoop();
		super.onDestroy();
	}

	private void stopLoop() {
		shouldRun = false;
		Thread t = loopThread;
		if (t != null) t.interrupt();
	}

	private void startForegroundWithType() {
		NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
		if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL_ID) == null) {
			nm.createNotificationChannel(new NotificationChannel(CHANNEL_ID, "DSH Watchdog 实时监控",
					NotificationManager.IMPORTANCE_MIN));
		}
		Notification.Builder b = Build.VERSION.SDK_INT >= 26
				? new Notification.Builder(this, CHANNEL_ID)
				: new Notification.Builder(this);
		Notification n = b.setContentTitle("DSH Watchdog 实时监控")
				.setContentText("事件推送运行中（纯只读）")
				.setSmallIcon(R.drawable.ic_widget_icon)
				.setOngoing(true)
				.build();
		if (Build.VERSION.SDK_INT >= 29) {
			startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
		} else {
			startForeground(NOTIF_ID, n);
		}
	}

	/** SSE 长连接主循环：连接 → 解析事件 → 触发 Widget 刷新；断线指数退避重连。 */
	private void sseLoop() {
		long backoffMs = 1_000;
		long lastRefreshAt = 0;
		while (shouldRun) {
			SharedPreferences p = WatchdogWidgetProvider.prefs(this);
			String baseUrl = p.getString("baseUrl", "");
			String token = p.getString("token", "");
			if (baseUrl.isEmpty() || token.isEmpty()) {
				sleepQuiet(5_000);
				continue;
			}
			HttpURLConnection conn = null;
			try {
				URL url = new URL(baseUrl.replaceAll("/+$", "") + "/watchdog/events");
				conn = (HttpURLConnection) url.openConnection();
				conn.setRequestMethod("GET");
				conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
				conn.setReadTimeout(READ_TIMEOUT_MS);
				conn.setRequestProperty("Authorization", "Bearer " + token);
				conn.setRequestProperty("Accept", "text/event-stream");
				conn.setRequestProperty("Cache-Control", "no-store");
				int code = conn.getResponseCode();
				if (code != 200) throw new java.io.IOException("sse_status_" + code);
				backoffMs = 1_000; // 连接成功 → 重置退避
				BufferedReader in = new BufferedReader(
						new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8));
				String line;
				boolean stateChange = false;
				while (shouldRun && (line = in.readLine()) != null) {
					if (line.startsWith(":")) continue; // 心跳注释
					if (line.startsWith("event:")) {
						stateChange = line.substring(6).trim().equals("state_change");
						continue;
					}
					if (line.startsWith("data:") && stateChange) {
						stateChange = false;
						String data = line.substring(5).trim();
						long now = System.currentTimeMillis();
						if (now - lastRefreshAt >= REFRESH_MIN_INTERVAL_MS) {
							lastRefreshAt = now;
							triggerWidgetRefresh();
						}
						// data 只含 {state, revision, eventId} 元数据；丢弃即可，真相以 status 拉取为准
						if (data.isEmpty()) continue;
						try { new JSONObject(data); } catch (Exception ignore) { /* 形状宽容 */ }
					}
					if (line.isEmpty()) stateChange = false;
				}
				if (shouldRun) throw new java.io.IOException("sse_stream_closed");
			} catch (Exception e) {
				// 网络抖动/超时/服务重启 → 指数退避重连；不写日志（无敏感信息输出面）
			} finally {
				if (conn != null) try { conn.disconnect(); } catch (Exception ignore) { }
			}
			if (shouldRun) sleepQuiet(backoffMs);
			backoffMs = Math.min(backoffMs * 2, 60_000);
		}
	}

	/** 事件到达 → 广播 ACTION_FETCH → Provider 拉取 /watchdog/status 并更新 Widget。 */
	private void triggerWidgetRefresh() {
		Intent i = new Intent(this, WatchdogWidgetProvider.class);
		i.setAction(WatchdogWidgetProvider.ACTION_FETCH);
		sendBroadcast(i);
	}

	private static void sleepQuiet(long ms) {
		try { Thread.sleep(ms); } catch (InterruptedException ie) { Thread.currentThread().interrupt(); }
	}
}
