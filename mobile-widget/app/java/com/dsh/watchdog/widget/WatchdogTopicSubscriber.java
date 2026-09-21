package com.dsh.watchdog.widget;

import android.content.Context;
import android.content.SharedPreferences;

import com.google.android.gms.tasks.OnCompleteListener;
import com.google.android.gms.tasks.Task;
import com.google.firebase.messaging.FirebaseMessaging;

/**
 * DSH Watchdog Widget — R2 C：topic=watchdog 幂等订阅（官方 Firebase Messaging API）。
 *
 *  - subscribeToTopic 对同一 topic 重复调用幂等（首次配置成功 / token 轮换 / 重装后
 *    重复订阅安全，服务端 fcmSendStateChange 目标即该 topic）；
 *  - 结果（成功/失败）仅记录到本地 SharedPreferences（dsh_watchdog_fcm），
 *    禁止记录/打印 registration token；
 *  - 订阅失败（如设备无 Google Play services、无网络）不影响既有 fallback：
 *    JobScheduler 15min + Widget 30min + 手动刷新照常；仅 AC3（FCM 近实时）不得 PASS。
 */
public final class WatchdogTopicSubscriber {

	public static final String TOPIC = "watchdog";
	private static final String PREFS = "dsh_watchdog_fcm";

	private WatchdogTopicSubscriber() { }

	public static void subscribe(final Context context) {
		try {
			FirebaseMessaging.getInstance()
					.subscribeToTopic(TOPIC)
					.addOnCompleteListener(new OnCompleteListener<Void>() {
						@Override
						public void onComplete(Task<Void> task) {
							SharedPreferences p =
									context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
							SharedPreferences.Editor e = p.edit();
							e.putLong("topic_attempted_at", System.currentTimeMillis());
							if (task != null && task.isSuccessful()) {
								e.putBoolean("topic_subscribed", true);
								e.putLong("topic_subscribed_at", System.currentTimeMillis());
								e.remove("topic_error");
							} else {
								e.putBoolean("topic_subscribed", false);
								e.putString("topic_error", safeMsg(task == null ? null : task.getException()));
							}
							e.apply();
						}
					});
		} catch (Throwable t) {
			// FirebaseApp 未初始化 / 设备无 Google Play services 等：记录失败即可，
			// fallback（JobScheduler 15min / Widget 30min / 手动刷新）不受影响
			SharedPreferences p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
			p.edit()
					.putBoolean("topic_subscribed", false)
					.putString("topic_error", safeMsg(t))
					.putLong("topic_attempted_at", System.currentTimeMillis())
					.apply();
		}
	}

	private static String safeMsg(Throwable t) {
		String m = t == null ? "unknown" : String.valueOf(t.getMessage());
		return m.length() > 80 ? m.substring(0, 80) : m;
	}
}
