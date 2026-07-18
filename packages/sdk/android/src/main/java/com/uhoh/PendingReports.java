package com.uhoh;

import android.content.Context;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.WritableArray;
import com.facebook.react.bridge.WritableMap;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.DataInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Scans <cacheDir>/uh-oh/pending/ for JSON crash reports.
 * Each file is read and returned as {@code { id, payload }} WITHOUT deletion;
 * the JS layer deletes it via {@link #ack(Context, String)} only after the
 * report has been durably spooled or sent, so a kill mid-handoff cannot lose a
 * report. Call once per app launch from UhOhNativeModule.getPendingReports().
 */
public final class PendingReports {

    private PendingReports() {}

    /**
     * Returns all pending reports as a WritableArray of {@code { id, payload }}
     * maps. Files are NOT deleted here — deletion happens later via
     * {@link #ack(Context, String)} once JS confirms durable handoff. Files that
     * fail to parse are deleted immediately (corrupt data is not worth retrying).
     */
    public static WritableArray collect(Context context) {
        WritableArray result = Arguments.createArray();
        File dir = CrashWriter.getPendingDir(context);
        if (!dir.exists()) return result;

        File[] files = dir.listFiles((d, name) -> name.endsWith(".json"));
        if (files == null) return result;

        for (File file : files) {
            try {
                String json = readFile(file);
                JSONObject obj = new JSONObject(json);
                WritableMap payload = jsonObjectToWritableMap(obj);

                WritableMap entry = Arguments.createMap();
                entry.putString("id", reportId(file));
                entry.putMap("payload", payload);
                result.pushMap(entry);
            } catch (Exception ignored) {
                // Corrupt or unreadable — delete immediately (not worth retrying).
                //noinspection ResultOfMethodCallIgnored
                file.delete();
            }
        }

        return result;
    }

    /**
     * Deletes the pending report file for {@code id}. Called from JS only after
     * the report has been durably spooled (or successfully sent), so a crash
     * between {@link #collect(Context)} and this call cannot lose a report.
     */
    public static void ack(Context context, String id) {
        if (id == null || id.isEmpty()) return;
        // id is a report file's base name (a UUID). Strip path separators
        // defensively so a malformed id can't escape the pending directory.
        String safe = id.replace("/", "").replace("\\", "").replace("..", "");
        if (safe.isEmpty()) return;
        File file = new File(CrashWriter.getPendingDir(context), safe + ".json");
        if (file.exists()) {
            //noinspection ResultOfMethodCallIgnored
            file.delete();
        }
    }

    /** Derives the ack id (the base file name without the {@code .json} suffix). */
    private static String reportId(File file) {
        String name = file.getName();
        if (name.endsWith(".json")) {
            return name.substring(0, name.length() - ".json".length());
        }
        return name;
    }

    private static String readFile(File file) throws Exception {
        try (DataInputStream in = new DataInputStream(new FileInputStream(file))) {
            byte[] bytes = new byte[(int) file.length()];
            // readFully loops until the buffer is filled — a single read() is
            // not guaranteed to return all bytes and can short-read.
            in.readFully(bytes);
            return new String(bytes, StandardCharsets.UTF_8);
        }
    }

    /** Recursively convert a JSONObject to a React Native WritableMap. */
    public static WritableMap jsonObjectToWritableMap(JSONObject obj) throws Exception {
        WritableMap map = Arguments.createMap();
        for (String key : toList(obj.keys())) {
            Object val = obj.get(key);
            if (val instanceof JSONObject) {
                map.putMap(key, jsonObjectToWritableMap((JSONObject) val));
            } else if (val instanceof JSONArray) {
                map.putArray(key, jsonArrayToWritableArray((JSONArray) val));
            } else if (val instanceof Boolean) {
                map.putBoolean(key, (Boolean) val);
            } else if (val instanceof Integer) {
                map.putInt(key, (Integer) val);
            } else if (val instanceof Long) {
                map.putDouble(key, ((Long) val).doubleValue());
            } else if (val instanceof Double || val instanceof Float) {
                map.putDouble(key, ((Number) val).doubleValue());
            } else if (val == JSONObject.NULL) {
                map.putNull(key);
            } else {
                map.putString(key, val.toString());
            }
        }
        return map;
    }

    /** Recursively convert a JSONArray to a React Native WritableArray. */
    public static com.facebook.react.bridge.WritableArray jsonArrayToWritableArray(JSONArray arr)
            throws Exception {
        com.facebook.react.bridge.WritableArray result = Arguments.createArray();
        for (int i = 0; i < arr.length(); i++) {
            Object val = arr.get(i);
            if (val instanceof JSONObject) {
                result.pushMap(jsonObjectToWritableMap((JSONObject) val));
            } else if (val instanceof JSONArray) {
                result.pushArray(jsonArrayToWritableArray((JSONArray) val));
            } else if (val instanceof Boolean) {
                result.pushBoolean((Boolean) val);
            } else if (val instanceof Integer) {
                result.pushInt((Integer) val);
            } else if (val instanceof Long) {
                result.pushDouble(((Long) val).doubleValue());
            } else if (val instanceof Double || val instanceof Float) {
                result.pushDouble(((Number) val).doubleValue());
            } else if (val == JSONObject.NULL) {
                result.pushNull();
            } else {
                result.pushString(val.toString());
            }
        }
        return result;
    }

    private static List<String> toList(java.util.Iterator<String> it) {
        List<String> list = new ArrayList<>();
        while (it.hasNext()) list.add(it.next());
        return list;
    }
}
