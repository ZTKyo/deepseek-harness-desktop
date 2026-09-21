package com.dsh.watchdog.widget;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

/**
 * DSH Watchdog Widget — R2 C：FCM data-message 唤醒接收器（官方 Firebase Messaging SDK）。
 *
 * 安全模型（与服务端 watchdog-core.buildFcmPushPayload 白名单对齐）：
 *  - push 只是 wake signal，不是状态真值：收到后一律走既有只读链
 *    GET {baseUrl}/watchdog/status（Bearer token）→ 拉取脱敏快照 → 更新 Widget；
 *  - data 白名单 = 服务端 {v, ev, eid, rev, gen, wake, ts}，仅作本地诊断记录，
 *    不解析为状态、不渲染进 Widget；
 *  - 客户端不信任 push 承载任何状态内容；超白名单字段一律忽略；
 *  - 本地诊断（SharedPreferences dsh_watchdog_diag）只记 receivedAt / eventId /
 *    updatedAt / 触发源，不记录 token，不上报远端；
 *  - 仍零 mutation：本类没有任何写/恢复调用（Dispatch/Correction/Retry/Cancel/
 *    Review/Model Switch 均不存在）。
 *
 * Manifest 注册：&lt;service android:name=".WatchdogFcmReceiver"&gt; +
 * intent-filter action com.google.firebase.MESSAGING_EVENT（AndroidManifest.xml R2 C）。
 */
public class WatchdogFcmReceiver extends FirebaseMessagingService {

	@Override
	public void onMessageReceived(RemoteMessage message) {
		Map<String, String> data = message == null ? null : message.getData();
		WatchdogWidgetProvider.markDiag(this, "last_push_received_at",
				String.valueOf(System.currentTimeMillis()));
		if (data != null && data.get("eid") != null) {
			WatchdogWidgetProvider.markDiag(this, "last_push_event_id", data.get("eid"));
		}
		// 唤醒既有只读拉取链：显式广播 → WatchdogWidgetProvider（静默刷新，不渲染「拉取中」占位）
		WatchdogWidgetProvider.requestFetch(this, "fcm");
	}

	@Override
	public void onNewToken(String token) {
		// topic 订阅模式下 token 无需上报服务端；禁止打印/存储 token 本身
		WatchdogWidgetProvider.markDiag(this, "last_token_rotated_at",
				String.valueOf(System.currentTimeMillis()));
		// token 轮换后重订阅（subscribeToTopic 幂等）
		WatchdogTopicSubscriber.subscribe(this);
	}
}
