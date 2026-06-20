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

export const getStatusSchema = z.object({ type: z.literal("get-status") });
export const getConfigSchema = z.object({ type: z.literal("get-config") });

export const getAgentsSchema = z.object({ type: z.literal("get-agents") });
export const pauseSchema = z.object({ type: z.literal("pause") });
export const resumeSchema = z.object({ type: z.literal("resume") });
export const startSchema = z.object({ type: z.literal("start") });
export const stopSchema = z.object({ type: z.literal("stop") });

// Store the private key as plaintext in chrome.storage.local. There is
// no master password — distribution is controlled out-of-band.
export const setPrivateKeySchema = z.object({
  type: z.literal("set-private-key"),
  privateKey: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
});

export const clearPrivateKeySchema = z.object({
  type: z.literal("clear-private-key"),
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
    gasPriceJitterPercent: z.number().min(0).max(100).default(10),
    dryRun: z.boolean(),
    cooldownSeconds: z.number().int().min(0).max(300).default(0),
    stopAtRemaining: z.number().int().min(0).max(1000).default(10),
    agentId: z.number().int().min(0).default(0),
  }),
});

export const exportLogSchema = z.object({ type: z.literal("export-log") });

export const messageSchema = z.discriminatedUnion("type", [
  rpcRequestSchema,
  rpcResponseSchema,
  getStatusSchema,
  getConfigSchema,
  pauseSchema,
  resumeSchema,
  startSchema,
  stopSchema,
  setPrivateKeySchema,
  clearPrivateKeySchema,
  setConfigSchema,
  exportLogSchema,
  getAgentsSchema,
]);

export type Message = z.infer<typeof messageSchema>;
export type RpcRequest = z.infer<typeof rpcRequestSchema>;
export type RpcResponse = z.infer<typeof rpcResponseSchema>;

export function parseMessage(raw: unknown): Message {
  return messageSchema.parse(raw);
}
