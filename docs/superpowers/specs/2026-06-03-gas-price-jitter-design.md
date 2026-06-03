# Gas Price Jitter Design

Date: 2026-06-03

## Goal

Add a small reliability-oriented gas price jitter to direct-mode EvoEvo submissions so transactions are priced slightly above the current RPC gas price while still respecting the existing fee cap.

This change is not intended to bypass platform abuse detection. It is a transaction pricing policy for reducing stuck transactions under normal network movement.

## Scope

- Direct-mode submissions in `extension/src/background/direct-runner.ts`.
- Legacy gas pricing path that currently uses `eth_gasPrice`.
- Configuration, UI, and tests needed to control and verify the jitter.

Out of scope:

- EIP-1559 fee fields.
- Randomizing nonce, calldata, wallet identity, timing identity, or any platform-visible behavior unrelated to transaction pricing.
- Lowering gas price below the RPC-provided value.

## Behavior

The runner will fetch `baseGasPrice` from `eth_gasPrice` as it does today. Before guard evaluation and signing, it will compute:

```text
jitterPercent = random value from 0 through configured max
jitteredGasPrice = baseGasPrice * (100 + jitterPercent) / 100
```

The default maximum jitter is `10`, which produces a gas price in the range `1.00x` through `1.10x` of the RPC gas price.

`gasLimit` remains unchanged:

- Use `eth_estimateGas * 1.2` when estimation succeeds.
- Use the existing `400_000` fallback when estimation fails.

The estimated native fee used by the guard will be calculated from `gasLimit * jitteredGasPrice / 1e18`. The existing `maxFeeNative` guard remains authoritative. If jitter pushes a transaction over the configured cap, the runner rejects the transaction before signing.

## Configuration

Add `gasPriceJitterPercent` to extension config.

- Type: non-negative number.
- Default: `10`.
- Suggested UI label: `Gas jitter (%)`.
- A value of `0` disables jitter and preserves current behavior.

The popup should parse invalid or blank input back to the default value, following the existing config input pattern.

## Logging

Existing `walletRequest.estimatedFeeNative` should represent the fee after jitter because that is the fee guard and signing path actually use.

No separate log field is required for v1. Tests should verify the signed transaction receives the jittered gas price.

## Error Handling

- If `eth_gasPrice` fails, keep the current failure behavior; do not invent a gas price.
- If `gasPriceJitterPercent` is `0`, use `baseGasPrice` exactly.
- If jittered fee exceeds `maxFeeNative`, reject through the existing guard.
- The jitter function should never return a value below `baseGasPrice`.

## Testing

Add focused tests for:

- `gasPriceJitterPercent: 0` signs with the exact RPC gas price.
- Positive jitter signs with a gas price between `baseGasPrice` and the configured maximum.
- Fee cap rejection uses the post-jitter estimated fee.
- Existing direct-runner happy path still signs and broadcasts successfully.

Tests should avoid brittle randomness by injecting or isolating the random source where practical.
