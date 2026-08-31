package com.dsh.watchdog.widget;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

/** 开机自启：恢复事件推送前台服务（targetSdk 34 允许 BOOT_COMPLETED 启动 dataSync FGS）。 */
public class WatchdogBootReceiver extends BroadcastReceiver {
	@Override
	public void onReceive(Context ctx, Intent intent) {
		if (Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) {
			Intent svc = new Intent(ctx, WatchdogEventService.class);
			svc.setAction(WatchdogEventService.ACTION_START);
			if (Build.VERSION.SDK_INT >= 26) {
				ctx.startForegroundService(svc);
			} else {
				ctx.startService(svc);
			}
		}
	}
}
