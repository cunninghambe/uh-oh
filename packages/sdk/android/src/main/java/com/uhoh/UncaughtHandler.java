package com.uhoh;

import android.content.Context;

/**
 * Installs as Thread.defaultUncaughtExceptionHandler.
 * On uncaught exception: writes a crash report to disk, then delegates to the
 * previously-installed handler so the app crashes naturally.
 *
 * IMPORTANT: we never swallow the exception. The previous handler is always called.
 */
public final class UncaughtHandler implements Thread.UncaughtExceptionHandler {

    private final Context context;
    private final Thread.UncaughtExceptionHandler previous;

    public UncaughtHandler(Context context, Thread.UncaughtExceptionHandler previous) {
        this.context = context.getApplicationContext();
        this.previous = previous;
    }

    @Override
    public void uncaughtException(Thread thread, Throwable throwable) {
        try {
            CrashWriter.writeJavaReport(context, thread, throwable);
        } catch (Throwable ignored) {
            // Never block the crash path — even OOM/StackOverflow raised while
            // building the report must not stop us chaining to the next handler.
        } finally {
            if (previous != null) {
                previous.uncaughtException(thread, throwable);
            } else {
                // No previous handler: terminate hard. Shutdown hooks can hang
                // mid-crash, so kill the process directly (Android convention)
                // rather than relying on a clean System.exit.
                android.os.Process.killProcess(android.os.Process.myPid());
                System.exit(10);
            }
        }
    }
}
