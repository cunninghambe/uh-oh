package com.uhoh;

import android.content.Context;

import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.ReadableMap;
import com.facebook.react.bridge.WritableArray;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.io.IOException;
import java.io.StringWriter;

import xcrash.XCrash;
import xcrash.ICrashCallback;

/**
 * React Native native module. Exposed to JS as NativeModules.UhOhNative.
 */
public final class UhOhNativeModule extends ReactContextBaseJavaModule {

    static final String MODULE_NAME = "UhOhNative";

    /** Guards against double-install across JS reloads in dev mode. */
    private static volatile boolean installed = false;

    UhOhNativeModule(ReactApplicationContext reactContext) {
        super(reactContext);
    }

    @Override
    public String getName() {
        return MODULE_NAME;
    }

    /**
     * Install xCrash (NDK + ANR) and the Java UncaughtExceptionHandler.
     * Idempotent: subsequent calls resolve true without re-installing.
     *
     * @param config  JS-side config (currently only { debug: boolean })
     * @param promise resolved with true on success; rejected on error
     */
    @ReactMethod
    public void install(ReadableMap config, Promise promise) {
        if (installed) {
            promise.resolve(true);
            return;
        }

        try {
            Context appContext = getReactApplicationContext().getApplicationContext();
            boolean debug = config != null && config.hasKey("debug") && config.getBoolean("debug");

            installXCrash(appContext, debug);
            installUncaughtHandler(appContext);

            installed = true;
            promise.resolve(true);
        } catch (Exception e) {
            promise.reject("INSTALL_FAILED", e.getMessage(), e);
        }
    }

    /**
     * Collect all pending crash reports from the cache directory.
     * Each file is read and returned as a {@code { id, payload }} map WITHOUT
     * being deleted; JS deletes it via {@link #ackReport} after durable handoff.
     *
     * @param promise resolved with a WritableArray of {@code { id, payload }} maps
     */
    @ReactMethod
    public void getPendingReports(Promise promise) {
        try {
            Context appContext = getReactApplicationContext().getApplicationContext();
            WritableArray reports = PendingReports.collect(appContext);
            promise.resolve(reports);
        } catch (Exception e) {
            promise.reject("READ_FAILED", e.getMessage(), e);
        }
    }

    /**
     * Delete a pending crash report file, called from JS only after the report
     * has been durably spooled (or successfully sent). This is the second half
     * of the crash-safe handoff started by {@link #getPendingReports}.
     *
     * @param id      the report id returned by getPendingReports
     * @param promise resolved once the file has been deleted
     */
    @ReactMethod
    public void ackReport(String id, Promise promise) {
        try {
            Context appContext = getReactApplicationContext().getApplicationContext();
            PendingReports.ack(appContext, id);
            promise.resolve(null);
        } catch (Exception e) {
            promise.reject("ACK_FAILED", e.getMessage(), e);
        }
    }

    // -------------------------------------------------------------------------

    private void installXCrash(Context context, boolean debug) {
        ICrashCallback callback = (logPath, emergency) -> {
            String mechanism = logPath != null && logPath.contains("anr")
                ? "android-anr"
                : "android-ndk-signal";
            // Prefer the in-memory emergency content (available synchronously during the crash
            // callback for fatal signals). Fall back to reading the file on disk for ANRs and
            // cases where emergency is null.
            String contents = emergency != null ? emergency : readFileQuietly(logPath);
            CrashWriter.writeXCrashReport(context, mechanism, logPath != null ? logPath : "", contents);
        };

        XCrash.InitParameters params = new XCrash.InitParameters()
            .setJavaCallback(null)        // we handle Java via UncaughtHandler
            .setNativeCallback(callback)
            .setAnrCallback(callback);

        if (debug) {
            params.setLogDir(new java.io.File(context.getCacheDir(), "uh-oh/xcrash").getAbsolutePath());
        }

        XCrash.init(context, params);
    }

    private void installUncaughtHandler(Context context) {
        Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        // Don't chain onto ourselves on double-call (safety; installed flag prevents this normally)
        if (previous instanceof UncaughtHandler) return;
        Thread.setDefaultUncaughtExceptionHandler(new UncaughtHandler(context, previous));
    }

    /** Reads a file to a string, returning an empty string on any I/O error. */
    private static String readFileQuietly(String path) {
        if (path == null || path.isEmpty()) return "";
        try {
            BufferedReader reader = new BufferedReader(new FileReader(new File(path)));
            StringWriter writer = new StringWriter();
            char[] buf = new char[4096];
            int n;
            while ((n = reader.read(buf)) != -1) {
                writer.write(buf, 0, n);
            }
            reader.close();
            return writer.toString();
        } catch (IOException e) {
            return "";
        }
    }
}
