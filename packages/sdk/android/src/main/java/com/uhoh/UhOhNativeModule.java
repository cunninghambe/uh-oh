package com.uhoh;

import android.content.Context;

import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.ReadableMap;
import com.facebook.react.bridge.WritableArray;

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
     * Each file is read, returned as a map, and then deleted.
     *
     * @param promise resolved with a WritableArray of report maps
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

    // -------------------------------------------------------------------------

    private void installXCrash(Context context, boolean debug) {
        ICrashCallback callback = (logPath, emergency) -> {
            String mechanism = logPath != null && logPath.contains("anr")
                ? "android-anr"
                : "android-ndk-signal";
            CrashWriter.writeXCrashReport(context, mechanism, logPath != null ? logPath : "");
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
}
