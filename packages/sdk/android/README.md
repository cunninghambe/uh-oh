# @uh-oh/react-native — Android native module

Captures Java/Kotlin uncaught exceptions (UEH), NDK signals, and ANRs via
[xCrash 3.1.0](https://github.com/iqiyi/xCrash). Reports are buffered to the
app cache directory and drained on the next JS launch.

---

## Requirements

- React Native **0.77+** (the SDK depends on `com.facebook.react:react-android:0.77.+`, which is the first version published to Maven Central that the SDK has been verified against).
- AndroidX must be enabled in your app's root `gradle.properties`:

  ```
  android.useAndroidX=true
  ```

  This is the default for all RN 0.71+ apps, so most consumers won't need to add it.

- Android `compileSdk` 34+ and Java 17 in your app's `build.gradle`.

## Installation

### 1. Link the Gradle module

In your app's **root `settings.gradle`**, add:

```groovy
include ':uh-oh'
project(':uh-oh').projectDir = file('../node_modules/@uh-oh/react-native/android')
```

### 2. Add the dependency

In your **app `build.gradle`** `dependencies` block:

```groovy
implementation project(':uh-oh')
```

### 3. Register the package

In **`MainApplication.java`** (or `MainApplication.kt`):

```java
// Java
@Override
protected List<ReactPackage> getPackages() {
    List<ReactPackage> packages = new PackageList(this).getPackages();
    packages.add(new UhOhPackage());   // <-- add this line
    return packages;
}
```

```kotlin
// Kotlin
override fun getPackages(): List<ReactPackage> =
    PackageList(this).packages.apply {
        add(UhOhPackage())             // <-- add this line
    }
```

Import at the top of the file:

```java
import com.uhoh.UhOhPackage;
```

### 4. Initialize the SDK in JS

```ts
import { init } from '@uh-oh/react-native';

init({
  dsn: 'https://<publicKey>@<your-server>',
  release: '1.2.3+47', // version+build
  enableNative: true, // default true
});
```

`init` calls `NativeModules.UhOhNative.install()` automatically on Android.
Pending reports from previous crashes are drained into the spool on the same
call and flushed to the server.

---

## How it works

1. **Java UEH** — `UncaughtHandler` is set as the default uncaught exception
   handler. On any uncaught Java/Kotlin exception it writes a JSON report to
   `<cacheDir>/uh-oh/pending/<uuid>.json`, then **re-invokes the previous
   handler** so the app crashes naturally (stack trace still appears in
   logcat / Play Console).

2. **xCrash** — captures NDK signal crashes and ANRs. Its callback reads the
   xCrash tombstone file on-device and parses the backtrace into a full event
   with signal type, cause, and structured native stack frames. The raw tombstone
   path is preserved in `context.xcrash_tombstone_path` for manual inspection.
   The parsed event JSON is written to the same pending directory.

3. **On next launch** — `getPendingReports()` scans `<cacheDir>/uh-oh/pending/`,
   reads each file, deletes it, and returns the payloads to JS, which builds
   full `EventEnvelope`s and spools them for delivery.

---

## Manual on-device verification

These steps require a real device or emulator with your app installed.

### Trigger a Java uncaught exception

```bash
# Replace com.example.myapp with your app's package name
adb shell am crash com.example.myapp
```

1. App crashes (expected).
2. Relaunch the app.
3. Watch logcat or your uh-oh dashboard for an event with
   `mechanism: "android-java-ueh"`.

### Trigger a Java crash via test button

Add a button in a debug build:

```ts
import { TouchableOpacity, Text } from 'react-native';
import { NativeModules } from 'react-native';

<TouchableOpacity onPress={() => { throw new Error('test crash'); }}>
  <Text>Crash JS</Text>
</TouchableOpacity>
```

### Trigger an NDK signal crash

In a C/C++ layer:

```c
// Force SIGSEGV
volatile int* p = NULL;
*p = 1;
```

Or via `adb` with a SIGABRT to the process:

```bash
# Get PID
adb shell pidof com.example.myapp
# Send signal
adb shell kill -SIGABRT <pid>
```

After relaunch, look for `mechanism: "android-ndk-signal"` in the dashboard.

### Trigger an ANR

Block the main thread for >5 s in a debug build:

```ts
// WARNING: dev only — never ship this
setTimeout(() => {
  while (true) {}
}, 0);
```

After the ANR dialog dismiss and relaunch, look for
`mechanism: "android-anr"` in the dashboard.

### Verify offline spooling

1. Put the device in airplane mode.
2. Trigger a crash.
3. Re-enable network.
4. Relaunch the app.
5. Confirm the event appears in the dashboard (flushed from spool on reconnect).

---

## Troubleshooting

**No reports showing up after crash**

- Confirm `UhOhPackage` is in `getPackages()`.
- Check logcat for `UhOhNativeModule` tags.
- Verify `enableNative` is not set to `false` in `init()`.

**Double-install warning**

If you call `init()` more than once (e.g., fast-refresh in dev), the native
module is idempotent — the second call to `install()` returns `true` without
re-installing any handlers.

**ProGuard / R8**

Add to your `proguard-rules.pro`:

```
-keep class com.uhoh.** { *; }
-keep class xcrash.** { *; }
```
