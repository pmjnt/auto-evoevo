import { z } from "zod";

const HEX = /^0x[0-9a-fA-F]*$/;

export const rpcRequestSchema = z.object({
  type: z.literal("rpc-request"),
  id: z.string().min(1),
  method: z.string().min(1),
  params: z.array(z.unknown()).default([]),
});

export const rpcResponseSchema = z.object({
  type: z.literal("rpc-response"),
  id: z.string().min(1),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z
    .object({ code: z.number().int(), message: z.string() })
    .optional(),
});

export const unlockSchema = z.object({
  type: z.literal("unlock"),
  password: z.string().min(1),
});

export const lockSchema = z.object({ type: z.literal("lock") });
export const getStatusSchema = z.object({ type: z.literal("get-status") });
export const getConfigSchema = z.object({ type: z.literal("get-config") });
export const pauseSchema = z.object({ type: z.literal("pause") });
export const resumeSchema = z.object({ type: z.literal("resume") });
export const startSchema = z.object({ type: z.literal("start") });
export const stopSchema = z.object({ type: z.literal("stop") });
export const automationEventSchema = z.object({
  type: z.literal("automation-event"),
  event: z.object({
    type: z.string().min(1),
    reason: z.string().optional(),
    txHash: z.string().optional(),
    index: z.number().int().optional(),
  }),
});

export const importKeySchema = z.object({
  type: z.literal("import-key"),
  privateKey: z.string().regex(HEX),
  password: z.string().min(8),
});

export const setConfigSchema = z.object({
  type: z.literal("set-config"),
  config: z.object({
    allowedOrigin: z.string().url(),
    allowedChain: z.string().min(1),
    chainId: z.number().int().positive(),
    rpcUrl: z.string().url(),
    allowedContracts: z.array(z.string().regex(HEX)),
    allowedFunctionSelectors: z.array(z.string().regex(HEX)),
    maxFeeNative: z.number().positive(),
    dryRun: z.boolean(),
    idleLockMinutes: z.number().int().positive(),
    cooldownSeconds: z.number().int().min(0).max(300).default(0),
    stopAtRemaining: z.number().int().min(0).max(1000).default(10),
  }),
});

export const exportLogSchema = z.object({ type: z.literal("export-log") });

export const messageSchema = z.discriminatedUnion("type", [
  rpcRequestSchema,
  rpcResponseSchema,
  unlockSchema,
  lockSchema,
  getStatusSchema,
  getConfigSchema,
  pauseSchema,
  resumeSchema,
  startSchema,
  stopSchema,
  automationEventSchema,
  importKeySchema,
  setConfigSchema,
  exportLogSchema,
]);

export type Message = z.infer<typeof messageSchema>;
export type RpcRequest = z.infer<typeof rpcRequestSchema>;
export type RpcResponse = z.infer<typeof rpcResponseSchema>;

export function parseMessage(raw: unknown): Message {
  return messageSchema.parse(raw);
}
