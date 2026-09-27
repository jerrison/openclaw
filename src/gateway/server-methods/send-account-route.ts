import { resolveChannelDefaultAccountId } from "../../channels/plugins/helpers.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { validateExplicitMessageAccountSelection } from "../../infra/outbound/message-account-selection.js";
import { normalizeAccountId, normalizeOptionalAccountId } from "../../routing/session-key.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";

export async function resolveMessageOperationAccountRoute(params: {
  cfg: OpenClawConfig;
  channel: string;
  plugin: ChannelPlugin;
  accountIds: readonly unknown[];
  conflictMessage: string;
}): Promise<{ accountId: string | undefined; effectiveAccountId: string; requestScope: string }> {
  const accountIds: string[] = [];
  for (const requestedAccountId of params.accountIds) {
    const accountId = await validateExplicitMessageAccountSelection({
      cfg: params.cfg,
      channel: params.channel,
      accountId: requestedAccountId,
      plugin: params.plugin,
    });
    if (accountId !== undefined) {
      accountIds.push(accountId);
    }
  }
  const distinctAccountIds = [...new Set(accountIds)];
  if (distinctAccountIds.length > 1) {
    throw new Error(params.conflictMessage);
  }
  const accountId = distinctAccountIds[0];
  // Missing input remains host-derived authority; this value only canonicalizes
  // idempotency and is not forwarded as a caller-supplied explicit selection.
  const effectiveAccountId =
    accountId ??
    normalizeAccountId(resolveChannelDefaultAccountId({ plugin: params.plugin, cfg: params.cfg }));
  return {
    accountId,
    effectiveAccountId,
    requestScope: JSON.stringify([params.channel, effectiveAccountId]),
  };
}

export type MessageOperationRoute = {
  channel: string;
  accountId: string;
  requestScope: string;
};

export function parseMessageOperationRoute(
  requestScope: string | undefined,
): MessageOperationRoute | undefined {
  if (!requestScope) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(requestScope);
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== "string" ||
      typeof parsed[1] !== "string"
    ) {
      return undefined;
    }
    const channel = normalizeMessageChannel(parsed[0]);
    const accountId = normalizeOptionalAccountId(parsed[1]);
    if (!channel || channel !== parsed[0] || !accountId || accountId !== parsed[1]) {
      return undefined;
    }
    return { channel, accountId, requestScope };
  } catch {
    return undefined;
  }
}
