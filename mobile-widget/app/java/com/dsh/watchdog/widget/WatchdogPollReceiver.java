package com.dsh.watchdog.widget;

import android.app.job.JobParameters;
import android.app.job.JobService;

/**
 * DSH Watchdog Widget — R3 B（External Review B）：无常驻连接轮询器。
 *
 * 取代 R1 B1 的 SSE 前台服务（WatchdogEventService，已删除）：不再持有任何
 * 长连接/前台通知，改由 JobScheduler 每 15 分钟触发一次只读拉取
 * （GET /watchdog/status 脱敏投影），系统在 Doze/网络受限时自动推迟，合规省电。
 *
 * - 周期由 WatchdogWidgetProvider.schedulePoll 注册（setPersisted 跨重启保活，
 *   所需 RECEIVE_BOOT_COMPLETED 仅服务于此，无 BOOT receiver 组件）。
 * - 系统兜底：widget_info updatePeriodMillis 30 分钟 + 点击手动刷新。
 * - 近实时状态告警由服务端承担（watchdog 插件 R2 B：Telegram 旁路 /
 *   可选 FCM），手机侧零长连接。
 * - 仍纯只读：无任何 mutation 调用。
 */
public class WatchdogPollReceiver extends JobService {

	@Override
	public boolean onStartJob(final JobParameters params) {
		// 注意：android.jar 的 LambdaMetafactory 是剥离 stub，本项目禁用 lambda/方法引用
		new Thread(new Runnable() {
			@Override public void run() {
				try {
					WatchdogWidgetProvider.fetchAllSync(WatchdogPollReceiver.this);
				} finally {
					jobFinished(params, false);
				}
			}
		}, "dsh-watchdog-poll").start();
		return true; // 异步工作未完成，保持 job 至 jobFinished
	}

	@Override
	public boolean onStopJob(JobParameters params) {
		return false; // 不需要重排（下个 15 分钟周期自然再触发）
	}
}
