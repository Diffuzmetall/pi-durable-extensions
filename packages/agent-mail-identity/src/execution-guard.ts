import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";
import { MailIdentityDoc } from "./durable.ts";
import { publicError } from "./errors.ts";
import { IdentityError } from "./identity.ts";
import { AGENT_MAIL_PREFIX, guardMailCall } from "./tool-guard.ts";

const guardedExecutors = new WeakSet<ToolRegistration["execute"]>();
export function hasMailExecutionGuard(tool: ToolRegistration | undefined): boolean {
	return tool !== undefined && guardedExecutors.has(tool.execute);
}

/** Apply at host composition, not as a selectable extension wrap. */
export function guardAgentMailExtension(extension: Extension): Extension {
	return {
		...extension,
		tools: extension.tools?.map(tool => {
			if (!tool.name.startsWith(AGENT_MAIL_PREFIX) || hasMailExecutionGuard(tool)) return tool;
			const execute: ToolRegistration["execute"] = async (args, api, context) => {
				try {
					const finalArgs = structuredClone(args);
					const agent = await api.agent(context);
					if (!agent.extensions.some(each => each.name === "agent-mail-identity")) throw new IdentityError("identity_extension_not_selected");
					const state = await api.snapshot(MailIdentityDoc, api.conversationId, context);
					const block = guardMailCall(tool.name, finalArgs, state, api.conversationId);
					if (block) throw new IdentityError(block);
					context.abortSignal?.throwIfAborted();
					return await tool.execute(finalArgs, api, context);
				} catch (error) {
					throw publicError(error, "mail_execution_failed");
				}
			};
			guardedExecutors.add(execute);
			return {
				...tool,
				execute,
				...(tool.prepareArguments === undefined ? {} : {
					prepareArguments(args: unknown) {
						try { return tool.prepareArguments!(args); }
						catch { throw new IdentityError("invalid_mail_arguments"); }
					},
				}),
			};
		}),
	};
}
