package com.uhoh;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Parses xCrash tombstone log files into structured crash data.
 *
 * <p>Tombstone format reference (xCrash 3.1.0):
 * <ul>
 *   <li>Signal line: {@code signal 11 (SIGSEGV), code 1 (SEGV_MAPERR), fault addr 0x0}</li>
 *   <li>Cause line: {@code Cause: null pointer dereference, address 0x0}</li>
 *   <li>Backtrace block: lines beginning with {@code backtrace:} followed by frame lines:
 *       {@code    #00 pc 000a1b2c  /data/app/com.example/lib/arm64/libnative.so (myFunc+8)}</li>
 * </ul>
 */
public final class TombstoneParser {

    /**
     * Matches the signal line, e.g. {@code signal 11 (SIGSEGV), code 1 ...}
     * Group 1: signal number, Group 2: signal name (e.g. SIGSEGV)
     */
    private static final Pattern SIGNAL_PATTERN =
            Pattern.compile("signal\\s+(\\d+)\\s+\\(([A-Z0-9]+)\\)");

    /**
     * Matches the Cause line, e.g. {@code Cause: null pointer dereference, address 0x0}
     * Group 1: the cause description
     */
    private static final Pattern CAUSE_PATTERN =
            Pattern.compile("^Cause:\\s*(.+)$", Pattern.MULTILINE);

    /**
     * Matches a backtrace frame line, e.g.:
     * {@code     #00 pc 000a1b2c  /data/app/com.example/lib/arm64/libnative.so (myFunc+8)}
     * Group 1: frame number (e.g. 00)
     * Group 2: hex PC address (e.g. 000a1b2c)
     * Group 3: module path (e.g. /data/app/.../libnative.so)
     * Group 4 (optional): symbol+offset (e.g. myFunc+8)
     */
    private static final Pattern FRAME_PATTERN =
            Pattern.compile("^\\s+#(\\d+)\\s+pc\\s+([0-9a-fA-F]+)\\s+(\\S+)(?:\\s+\\(([^)]+)\\))?",
                    Pattern.MULTILINE);

    private TombstoneParser() {}

    /**
     * Parses the contents of an xCrash tombstone file.
     *
     * @param tombstoneContents full text of the tombstone file
     * @return a {@link ParsedTombstone} with signal, cause, and backtrace frames
     */
    public static ParsedTombstone parse(String tombstoneContents) {
        if (tombstoneContents == null || tombstoneContents.isEmpty()) {
            return new ParsedTombstone("", "", new ArrayList<>());
        }

        String signal = extractSignal(tombstoneContents);
        String cause = extractCause(tombstoneContents);
        List<NativeFrame> frames = extractFrames(tombstoneContents);

        return new ParsedTombstone(signal, cause, frames);
    }

    private static String extractSignal(String text) {
        Matcher m = SIGNAL_PATTERN.matcher(text);
        return m.find() ? m.group(2) : "";
    }

    private static String extractCause(String text) {
        Matcher m = CAUSE_PATTERN.matcher(text);
        return m.find() ? m.group(1).trim() : "";
    }

    private static List<NativeFrame> extractFrames(String text) {
        // Only parse lines that appear after the "backtrace:" header
        int backtraceStart = text.indexOf("backtrace:");
        String searchText = backtraceStart >= 0 ? text.substring(backtraceStart) : text;

        List<NativeFrame> frames = new ArrayList<>();
        Matcher m = FRAME_PATTERN.matcher(searchText);
        while (m.find()) {
            String instructionAddr = "0x" + m.group(2);
            String module = m.group(3);
            String symbolAndOffset = m.group(4);
            String function = symbolAndOffset != null ? symbolAndOffset : "";

            // inApp = true if the library lives in the app's own native lib directory.
            // /data/app/ = app-installed APK expanded libs; /system/ and /apex/ = OS.
            boolean inApp = module.contains("/data/app/");

            frames.add(new NativeFrame(instructionAddr, module, function, inApp));
        }
        return frames;
    }

    /** Structured result of parsing a tombstone file. */
    public static final class ParsedTombstone {
        /** Signal name, e.g. {@code SIGSEGV}. Empty string if not found. */
        public final String signal;
        /** Cause description from the {@code Cause:} line. Empty string if absent. */
        public final String cause;
        /** Ordered list of backtrace frames. */
        public final List<NativeFrame> frames;

        public ParsedTombstone(String signal, String cause, List<NativeFrame> frames) {
            this.signal = signal;
            this.cause = cause;
            this.frames = frames;
        }
    }

    /** A single native backtrace frame. */
    public static final class NativeFrame {
        /** Hex PC address including {@code 0x} prefix. */
        public final String instructionAddr;
        /** Path to the shared library or executable. */
        public final String module;
        /** Symbol name and offset, e.g. {@code myFunc+8}. Empty string if not present. */
        public final String function;
        /**
         * True when the frame is from the app's own native code ({@code /data/app/} path),
         * false for system libraries ({@code /system/}, {@code /apex/}, etc.).
         */
        public final boolean inApp;

        public NativeFrame(String instructionAddr, String module, String function, boolean inApp) {
            this.instructionAddr = instructionAddr;
            this.module = module;
            this.function = function;
            this.inApp = inApp;
        }
    }
}
