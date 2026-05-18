package com.uhoh;

import android.content.Context;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import java.util.UUID;

/**
 * Writes crash reports as JSON files to <cacheDir>/uh-oh/pending/.
 * Methods are designed to be called from a crash handler — they are synchronous
 * and do not allocate excessively beyond what is needed for the JSON output.
 */
public final class CrashWriter {

    /** Package prefixes that are NOT considered in-app frames. */
    private static final String[] SYSTEM_PREFIXES = {
        "android.", "androidx.", "java.", "javax.", "kotlin.", "kotlinx.",
        "com.facebook.react.", "com.facebook.jni.", "dalvik.", "sun.",
        "com.android.", "libcore."
    };

    private CrashWriter() {}

    public static File getPendingDir(Context context) {
        return new File(context.getCacheDir(), "uh-oh/pending");
    }

    /**
     * Writes a Java uncaught exception report to disk.
     * Returns the file written, or null on failure.
     */
    public static File writeJavaReport(Context context, Thread thread, Throwable throwable) {
        try {
            JSONObject report = buildJavaReport(thread, throwable);
            return writeReport(context, report);
        } catch (Exception ignored) {
            return null;
        }
    }

    /**
     * Writes an xCrash tombstone-path report to disk (NDK signal or ANR).
     * The JS layer will read the tombstone path and construct the full envelope.
     */
    public static File writeXCrashReport(Context context, String mechanism, String tombstonePath) {
        try {
            JSONObject report = new JSONObject();
            report.put("mechanism", mechanism);
            report.put("timestamp", isoNow());
            report.put("xcrash_tombstone", tombstonePath);

            JSONObject device = buildDeviceInfo();
            report.put("device", device);

            return writeReport(context, report);
        } catch (Exception ignored) {
            return null;
        }
    }

    private static JSONObject buildJavaReport(Thread thread, Throwable throwable) throws Exception {
        JSONObject report = new JSONObject();
        report.put("mechanism", "android-java-ueh");
        report.put("timestamp", isoNow());

        JSONObject exception = new JSONObject();
        exception.put("type", throwable.getClass().getName());
        exception.put("value", throwable.getMessage() != null ? throwable.getMessage() : "");
        exception.put("stacktrace", buildStacktrace(throwable.getStackTrace()));
        report.put("exception", exception);

        report.put("device", buildDeviceInfo());

        if (thread != null) {
            JSONObject threadInfo = new JSONObject();
            threadInfo.put("name", thread.getName());
            threadInfo.put("id", thread.getId());
            report.put("thread", threadInfo);
        }

        return report;
    }

    private static JSONArray buildStacktrace(StackTraceElement[] elements) throws Exception {
        JSONArray frames = new JSONArray();
        for (StackTraceElement el : elements) {
            JSONObject frame = new JSONObject();
            frame.put("module", el.getClassName());
            frame.put("function", el.getMethodName());
            frame.put("filename", el.getFileName() != null ? el.getFileName() : "");
            frame.put("lineno", el.getLineNumber());
            frame.put("inApp", isInApp(el.getClassName()));
            frames.put(frame);
        }
        return frames;
    }

    private static boolean isInApp(String className) {
        for (String prefix : SYSTEM_PREFIXES) {
            if (className.startsWith(prefix)) return false;
        }
        return true;
    }

    private static JSONObject buildDeviceInfo() throws Exception {
        JSONObject device = new JSONObject();
        device.put("osName", "Android");
        device.put("osVersion", Build.VERSION.RELEASE);
        device.put("manufacturer", Build.MANUFACTURER);
        device.put("model", Build.MODEL);
        device.put("sdkInt", Build.VERSION.SDK_INT);
        return device;
    }

    private static String isoNow() {
        SimpleDateFormat sdf = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        sdf.setTimeZone(TimeZone.getTimeZone("UTC"));
        return sdf.format(new Date());
    }

    private static File writeReport(Context context, JSONObject report) throws IOException {
        File dir = getPendingDir(context);
        if (!dir.exists() && !dir.mkdirs()) {
            throw new IOException("Cannot create pending dir: " + dir);
        }
        File file = new File(dir, UUID.randomUUID().toString() + ".json");
        byte[] bytes = report.toString().getBytes(StandardCharsets.UTF_8);
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write(bytes);
            out.flush();
        }
        return file;
    }
}
