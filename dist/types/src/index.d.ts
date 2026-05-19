import { z } from 'zod';
export type JsonValue = string | number | boolean | null | JsonValue[] | {
    [key: string]: JsonValue;
};
export declare const JsonValueSchema: z.ZodType<JsonValue>;
export declare const PlatformSchema: z.ZodEnum<{
    ios: "ios";
    android: "android";
}>;
export type Platform = z.infer<typeof PlatformSchema>;
export declare const LevelSchema: z.ZodEnum<{
    error: "error";
    fatal: "fatal";
    warning: "warning";
    info: "info";
}>;
export type Level = z.infer<typeof LevelSchema>;
export declare const BreadcrumbLevelSchema: z.ZodEnum<{
    error: "error";
    fatal: "fatal";
    warning: "warning";
    info: "info";
    debug: "debug";
}>;
export type BreadcrumbLevel = z.infer<typeof BreadcrumbLevelSchema>;
export declare const MechanismSchema: z.ZodEnum<{
    "js-global": "js-global";
    "js-promise": "js-promise";
    "js-manual": "js-manual";
    "android-java-ueh": "android-java-ueh";
    "android-ndk-signal": "android-ndk-signal";
    "android-anr": "android-anr";
}>;
export type Mechanism = z.infer<typeof MechanismSchema>;
export declare const StackFrameSchema: z.ZodObject<{
    function: z.ZodOptional<z.ZodString>;
    module: z.ZodOptional<z.ZodString>;
    filename: z.ZodOptional<z.ZodString>;
    lineno: z.ZodOptional<z.ZodNumber>;
    colno: z.ZodOptional<z.ZodNumber>;
    instructionAddr: z.ZodOptional<z.ZodString>;
    imageAddr: z.ZodOptional<z.ZodString>;
    inApp: z.ZodBoolean;
}, z.core.$strip>;
export type StackFrame = z.infer<typeof StackFrameSchema>;
export declare const BreadcrumbSchema: z.ZodObject<{
    category: z.ZodString;
    message: z.ZodString;
    level: z.ZodDefault<z.ZodEnum<{
        error: "error";
        fatal: "fatal";
        warning: "warning";
        info: "info";
        debug: "debug";
    }>>;
    ts: z.ZodISODateTime;
    data: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>>>;
}, z.core.$strip>;
export type Breadcrumb = z.infer<typeof BreadcrumbSchema>;
export declare const DeviceInfoSchema: z.ZodObject<{
    osName: z.ZodString;
    osVersion: z.ZodString;
    deviceModel: z.ZodOptional<z.ZodString>;
    deviceManufacturer: z.ZodOptional<z.ZodString>;
    arch: z.ZodOptional<z.ZodString>;
    locale: z.ZodOptional<z.ZodString>;
    timezone: z.ZodOptional<z.ZodString>;
    memoryTotal: z.ZodOptional<z.ZodNumber>;
    diskFree: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export type DeviceInfo = z.infer<typeof DeviceInfoSchema>;
export declare const UserSchema: z.ZodObject<{
    id: z.ZodString;
    email: z.ZodOptional<z.ZodEmail>;
    username: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type User = z.infer<typeof UserSchema>;
export declare const ExceptionSchema: z.ZodObject<{
    type: z.ZodString;
    value: z.ZodString;
    stacktrace: z.ZodArray<z.ZodObject<{
        function: z.ZodOptional<z.ZodString>;
        module: z.ZodOptional<z.ZodString>;
        filename: z.ZodOptional<z.ZodString>;
        lineno: z.ZodOptional<z.ZodNumber>;
        colno: z.ZodOptional<z.ZodNumber>;
        instructionAddr: z.ZodOptional<z.ZodString>;
        imageAddr: z.ZodOptional<z.ZodString>;
        inApp: z.ZodBoolean;
    }, z.core.$strip>>;
    mechanism: z.ZodEnum<{
        "js-global": "js-global";
        "js-promise": "js-promise";
        "js-manual": "js-manual";
        "android-java-ueh": "android-java-ueh";
        "android-ndk-signal": "android-ndk-signal";
        "android-anr": "android-anr";
    }>;
}, z.core.$strip>;
export type Exception = z.infer<typeof ExceptionSchema>;
export declare const ReleaseInfoSchema: z.ZodObject<{
    version: z.ZodString;
    build: z.ZodString;
}, z.core.$strip>;
export type ReleaseInfo = z.infer<typeof ReleaseInfoSchema>;
export declare const SdkInfoSchema: z.ZodObject<{
    name: z.ZodString;
    version: z.ZodString;
}, z.core.$strip>;
export type SdkInfo = z.infer<typeof SdkInfoSchema>;
export declare const EventEnvelopeSchema: z.ZodObject<{
    sdk: z.ZodObject<{
        name: z.ZodString;
        version: z.ZodString;
    }, z.core.$strip>;
    timestamp: z.ZodISODateTime;
    platform: z.ZodEnum<{
        ios: "ios";
        android: "android";
    }>;
    release: z.ZodObject<{
        version: z.ZodString;
        build: z.ZodString;
    }, z.core.$strip>;
    level: z.ZodEnum<{
        error: "error";
        fatal: "fatal";
        warning: "warning";
        info: "info";
    }>;
    exception: z.ZodObject<{
        type: z.ZodString;
        value: z.ZodString;
        stacktrace: z.ZodArray<z.ZodObject<{
            function: z.ZodOptional<z.ZodString>;
            module: z.ZodOptional<z.ZodString>;
            filename: z.ZodOptional<z.ZodString>;
            lineno: z.ZodOptional<z.ZodNumber>;
            colno: z.ZodOptional<z.ZodNumber>;
            instructionAddr: z.ZodOptional<z.ZodString>;
            imageAddr: z.ZodOptional<z.ZodString>;
            inApp: z.ZodBoolean;
        }, z.core.$strip>>;
        mechanism: z.ZodEnum<{
            "js-global": "js-global";
            "js-promise": "js-promise";
            "js-manual": "js-manual";
            "android-java-ueh": "android-java-ueh";
            "android-ndk-signal": "android-ndk-signal";
            "android-anr": "android-anr";
        }>;
    }, z.core.$strip>;
    breadcrumbs: z.ZodDefault<z.ZodArray<z.ZodObject<{
        category: z.ZodString;
        message: z.ZodString;
        level: z.ZodDefault<z.ZodEnum<{
            error: "error";
            fatal: "fatal";
            warning: "warning";
            info: "info";
            debug: "debug";
        }>>;
        ts: z.ZodISODateTime;
        data: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>>>;
    }, z.core.$strip>>>;
    user: z.ZodOptional<z.ZodObject<{
        id: z.ZodString;
        email: z.ZodOptional<z.ZodEmail>;
        username: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    context: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>>>;
    tags: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    device: z.ZodObject<{
        osName: z.ZodString;
        osVersion: z.ZodString;
        deviceModel: z.ZodOptional<z.ZodString>;
        deviceManufacturer: z.ZodOptional<z.ZodString>;
        arch: z.ZodOptional<z.ZodString>;
        locale: z.ZodOptional<z.ZodString>;
        timezone: z.ZodOptional<z.ZodString>;
        memoryTotal: z.ZodOptional<z.ZodNumber>;
        diskFree: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>;
    fingerprint: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$loose>;
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;
export declare const PACKAGE_NAME = "../../_uh_oh_types";
//# sourceMappingURL=index.d.ts.map