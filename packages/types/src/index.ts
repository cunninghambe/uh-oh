import { z } from 'zod';

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const PlatformSchema = z.enum(['ios', 'android', 'web', 'node']);
export type Platform = z.infer<typeof PlatformSchema>;

export const LevelSchema = z.enum(['fatal', 'error', 'warning', 'info']);
export type Level = z.infer<typeof LevelSchema>;

export const BreadcrumbLevelSchema = z.enum(['debug', 'info', 'warning', 'error', 'fatal']);
export type BreadcrumbLevel = z.infer<typeof BreadcrumbLevelSchema>;

export const MechanismSchema = z.enum([
  'js-global',
  'js-promise',
  'js-manual',
  'android-java-ueh',
  'android-ndk-signal',
  'android-anr',
]);
export type Mechanism = z.infer<typeof MechanismSchema>;

const HEX_ADDR = /^0x[0-9a-fA-F]+$/;

export const StackFrameSchema = z.object({
  function: z.string().max(512).optional(),
  module: z.string().max(512).optional(),
  filename: z.string().max(1024).optional(),
  lineno: z.number().int().nonnegative().optional(),
  colno: z.number().int().nonnegative().optional(),
  instructionAddr: z.string().regex(HEX_ADDR).optional(),
  imageAddr: z.string().regex(HEX_ADDR).optional(),
  inApp: z.boolean(),
});
export type StackFrame = z.infer<typeof StackFrameSchema>;

export const BreadcrumbSchema = z.object({
  category: z.string().min(1).max(64),
  message: z.string().max(1024),
  level: BreadcrumbLevelSchema.default('info'),
  ts: z.iso.datetime(),
  data: z.record(z.string(), JsonValueSchema).optional(),
});
export type Breadcrumb = z.infer<typeof BreadcrumbSchema>;

export const DeviceInfoSchema = z.object({
  osName: z.string().min(1).max(64),
  osVersion: z.string().min(1).max(64),
  deviceModel: z.string().max(128).optional(),
  deviceManufacturer: z.string().max(128).optional(),
  arch: z.string().max(32).optional(),
  locale: z.string().max(32).optional(),
  timezone: z.string().max(64).optional(),
  memoryTotal: z.number().int().nonnegative().optional(),
  diskFree: z.number().int().nonnegative().optional(),
});
export type DeviceInfo = z.infer<typeof DeviceInfoSchema>;

export const UserSchema = z.object({
  id: z.string().min(1).max(256),
  email: z.email().optional(),
  username: z.string().max(256).optional(),
});
export type User = z.infer<typeof UserSchema>;

export const ExceptionSchema = z.object({
  type: z.string().min(1).max(256),
  value: z.string().max(4096),
  stacktrace: z.array(StackFrameSchema).max(500),
  mechanism: MechanismSchema,
});
export type Exception = z.infer<typeof ExceptionSchema>;

export const ReleaseInfoSchema = z.object({
  version: z.string().min(1).max(64),
  build: z.string().min(1).max(64),
});
export type ReleaseInfo = z.infer<typeof ReleaseInfoSchema>;

export const SdkInfoSchema = z.object({
  name: z.string().min(1).max(64),
  version: z.string().min(1).max(32),
});
export type SdkInfo = z.infer<typeof SdkInfoSchema>;

export const EventEnvelopeSchema = z
  .object({
    sdk: SdkInfoSchema,
    timestamp: z.iso.datetime(),
    platform: PlatformSchema,
    release: ReleaseInfoSchema,
    level: LevelSchema,
    exception: ExceptionSchema,
    breadcrumbs: z.array(BreadcrumbSchema).max(100).default([]),
    user: UserSchema.optional(),
    context: z.record(z.string(), JsonValueSchema).optional(),
    tags: z.record(z.string(), z.string()).optional(),
    device: DeviceInfoSchema,
    fingerprint: z.array(z.string().min(1).max(256)).min(1).max(8).optional(),
  })
  .loose();
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

export const PACKAGE_NAME = '@uh-oh/types';
