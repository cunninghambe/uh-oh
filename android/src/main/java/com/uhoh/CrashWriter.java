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
     * Writes a full xCrash report to disk (NDK signal or ANR).
     *
     * <p>Reads and parses the tombstone file on-device so the JS layer receives a
     * structured exception with signal, cause, and parsed backtrace frames.
     * The raw tombstone path is preserved in {@code context.xcrash_tombstone_path}
     * so developers can inspect the original file.
     *
     * @param mechanism     {@code "android-ndk-signal"} or {@code "android-anr"}
     * @param tombstonePath absolute path to the xCrash-written tombstone file
     * @param tombstoneContents full text content of the tombstone file
     */
    public static File writeXCrashReport(
            Context context,
            String mechanism,
            String tombstonePath,
            String tombstoneContents) {
        try {
            TombstoneParser.ParsedTombstone parsed = TombstoneParser.parse(tombstoneContents);

            JSONObject exception = new JSONObject();
            exception.put("type", parsed.signal.isEmpty() ? mechanism : parsed.signal);
            exception.put("value", parsed.cause.isEmpty() ? parsed.signal : parsed.cause);
            exception.put("mechanism", mechanism);
            exception.put("stacktrace", buildNativeStacktrace(parsed.frames));

            JSONObject ctx = new JSONObject();
            ctx.put("xcrash_tombstone_path", tombstonePath);

            JSONObject report = new JSONObject();
            report.put("mechanism", mechanism);
            report.put("timestamp", isoNow());
            report.put("exception", exception);
            report.put("context", ctx);
            report.put("device", buildDeviceInfo());

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

    private static JSONArray buildNativeStacktrace(java.util.List<TombstoneParser.NativeFrame> frames)
            throws Exception {
        JSONArray arr = new JSONArray();
        for (TombstoneParser.NativeFrame frame : frames) {
            JSONObject f = new JSONObject();
            f.put("instructionAddr", frame.instructionAddr);
            f.put("module", frame.module);
            f.put("function", frame.function);
            f.put("inApp", frame.inApp);
            arr.put(f);
        }
        return arr;
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
        device.put("deviceManufacturer", Build.MANUFACTURER);
        device.put("deviceModel", Build.MODEL);
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
