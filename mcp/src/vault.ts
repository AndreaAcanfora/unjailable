import {
  BaseError,
  ContractFunctionRevertedError,
  formatUnits,
  getAddress,
  parseAbi,
  parseUnits,
  type Account,
  type Address,
  type Chain,
  type Hash,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem';

export const VAULT_ABI = parseAbi([
  'function token() view returns (address)',
  'function owner() view returns (address)',
  'function agent() view returns (address)',
  'function agentExpiry() view returns (uint64)',
  'function paused() view returns (bool)',
  'function anyRecipient() view returns (bool)',
  'function perPaymentCap() view returns (uint128)',
  'function periodCap() view returns (uint128)',
  'function periodLength() view returns (uint64)',
  'function spentInPeriod() view returns (uint128)',
  'function periodStart() view returns (uint64)',
  'function allowedRecipient(address) view returns (bool)',
  'function available() view returns (uint256)',
  'function periodEnd() view returns (uint256)',
  'function pay(address to, uint256 amount, string memo)',
  'event Paid(address indexed to, uint256 amount, string memo)',
  'error NotOwner()',
  'error NotAgent()',
  'error AgentExpired()',
  'error IsPaused()',
  'error RecipientNotAllowed()',
  'error OverPaymentCap()',
  'error OverPeriodCap()',
  'error BadPolicy()',
  'error TransferFailed()',
]);

export const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);

/** What each contract error means, in words an agent (and its user) can act on. */
const REASONS: Record<string, string> = {
  NotAgent: 'this key is not the agent of the vault',
  AgentExpired: 'the agent key has expired; the owner must renew it',
  IsPaused: 'the owner has paused the vault',
  RecipientNotAllowed: 'the recipient is not on the allowlist',
  OverPaymentCap: 'the amount is above the per-payment cap',
  OverPeriodCap: 'the payment would go over what is left for this period',
  TransferFailed: 'the token transfer failed (is the vault funded?)',
};

export interface VaultStatus {
  vault: Address;
  token: { address: Address; symbol: string; decimals: number };
  balance: string;
  availableNow: string;
  perPaymentCap: string;
  periodCap: string;
  spentThisPeriod: string;
  periodLengthSeconds: number;
  periodEndsAt: string;
  agent: Address;
  agentExpiresAt: string;
  paused: boolean;
  anyRecipient: boolean;
}

type Reader = PublicClient<Transport, Chain | undefined>;
type Writer = WalletClient<Transport, Chain | undefined, Account>;

/** Latest instant a JavaScript Date can hold, in seconds. Later expiries mean "never". */
const MAX_DATE_SECONDS = 8_640_000_000_000n;
const iso = (seconds: bigint) => (seconds > MAX_DATE_SECONDS ? 'never' : new Date(Number(seconds) * 1000).toISOString());

export async function tokenInfo(client: Reader, vault: Address) {
  const address = await client.readContract({ address: vault, abi: VAULT_ABI, functionName: 'token' });
  const [symbol, decimals] = await Promise.all([
    client.readContract({ address, abi: ERC20_ABI, functionName: 'symbol' }),
    client.readContract({ address, abi: ERC20_ABI, functionName: 'decimals' }),
  ]);
  return { address, symbol, decimals };
}

export async function readStatus(client: Reader, vault: Address): Promise<VaultStatus> {
  const token = await tokenInfo(client, vault);
  const read = <F extends 'agent' | 'agentExpiry' | 'paused' | 'anyRecipient' | 'perPaymentCap' | 'periodCap' | 'periodLength' | 'spentInPeriod' | 'available' | 'periodEnd' | 'periodStart'>(functionName: F) =>
    client.readContract({ address: vault, abi: VAULT_ABI, functionName });
  const [balance, agent, expiry, paused, anyRecipient, perPayment, periodCap, periodLength, spent, available, periodEnd, periodStart] = await Promise.all([
    client.readContract({ address: token.address, abi: ERC20_ABI, functionName: 'balanceOf', args: [vault] }),
    read('agent'),
    read('agentExpiry'),
    read('paused'),
    read('anyRecipient'),
    read('perPaymentCap'),
    read('periodCap'),
    read('periodLength'),
    read('spentInPeriod'),
    read('available'),
    read('periodEnd'),
    read('periodStart'),
  ]);
  // spentInPeriod is only cleared on the next payment: it counts only if it belongs to the
  // window that contains the current block.
  const spentNow = periodStart >= periodEnd - periodLength ? spent : 0n;
  const fmt = (v: bigint) => formatUnits(v, token.decimals);
  return {
    vault,
    token,
    balance: fmt(balance),
    availableNow: fmt(available),
    perPaymentCap: fmt(perPayment),
    periodCap: fmt(periodCap),
    spentThisPeriod: fmt(spentNow),
    periodLengthSeconds: Number(periodLength),
    periodEndsAt: iso(periodEnd),
    agent,
    agentExpiresAt: iso(expiry),
    paused,
    anyRecipient,
  };
}

export type PayResult =
  | { ok: true; hash: Hash; amount: string; to: Address }
  | { ok: false; reason: string; error: string; hash?: Hash };

/** The contract error name inside a viem error, if the call reverted with one. */
export function revertName(err: unknown): string | undefined {
  if (!(err instanceof BaseError)) return undefined;
  const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
  return reverted instanceof ContractFunctionRevertedError ? reverted.data?.errorName : undefined;
}

export interface PayOptions {
  /**
   * Send the transaction even when the simulation says the vault will refuse it, so the
   * refusal is recorded on-chain (used by the public challenge). Costs gas for every refusal.
   */
  broadcastRefused?: boolean;
}

/**
 * Pays `amount` (in token units, like "1.5") to `to` as the agent. The chain has the last
 * word: the payment is simulated first, and a refusal comes back as a readable reason.
 */
export async function pay(reader: Reader, writer: Writer, vault: Address, to: string, amount: string, memo: string, options: PayOptions = {}): Promise<PayResult> {
  let recipient: Address;
  try {
    recipient = getAddress(to);
  } catch {
    return { ok: false, reason: 'the recipient is not a valid address', error: 'InvalidAddress' };
  }
  const { decimals } = await tokenInfo(reader, vault);
  let units: bigint;
  try {
    units = parseUnits(amount, decimals);
  } catch {
    return { ok: false, reason: `"${amount}" is not a valid amount`, error: 'InvalidAmount' };
  }
  if (units <= 0n) return { ok: false, reason: 'the amount must be above zero', error: 'InvalidAmount' };

  const call = { address: vault, abi: VAULT_ABI, functionName: 'pay', args: [recipient, units, memo], account: writer.account } as const;
  try {
    await reader.simulateContract(call);
  } catch (err) {
    const name = revertName(err) ?? 'Unknown';
    const refusal = { ok: false as const, reason: REASONS[name] ?? (err instanceof BaseError ? err.shortMessage : String(err)), error: name };
    if (!options.broadcastRefused || name === 'Unknown') return refusal;
    // Record the refusal on-chain: a fixed gas limit skips estimation, which would fail.
    const hash = await writer.writeContract({ ...call, chain: writer.chain, gas: 120_000n });
    await reader.waitForTransactionReceipt({ hash });
    return { ...refusal, hash };
  }
  const hash = await writer.writeContract({ ...call, chain: writer.chain });
  const receipt = await reader.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') return { ok: false, reason: 'the transaction reverted', error: 'Reverted', hash };
  return { ok: true, hash, amount, to: recipient };
}
