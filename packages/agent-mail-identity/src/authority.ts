import { IdentityError, validateTarget } from "./identity.ts";
import type { IdentityTarget } from "./identity.ts";

export class BindingAuthority {
	#grants = new Map<number, IdentityTarget>();
	#line: Promise<void> = Promise.resolve();

	#serial<T>(change: () => T | Promise<T>): Promise<T> {
		const next = this.#line.then(change);
		this.#line = next.then(() => {}, () => {});
		return next;
	}

	grant(conversationId: number, target: IdentityTarget): Promise<void> {
		const checked = validateTarget(target);
		if (!Number.isSafeInteger(conversationId) || conversationId < 1) throw new IdentityError("invalid_conversation_id");
		return this.#serial(() => { this.#grants.set(conversationId, checked); });
	}

	revoke(conversationId: number): Promise<void> {
		return this.#serial(() => { this.#grants.delete(conversationId); });
	}

	admit(conversationId: number, target: IdentityTarget, commit: () => Promise<void>, signal?: AbortSignal): Promise<void> {
		const checked = validateTarget(target);
		return this.#serial(async () => {
			if (signal?.aborted) throw new IdentityError("binding_aborted");
			const grant = this.#grants.get(conversationId);
			if (!grant || grant.projectKey !== checked.projectKey || grant.agentName !== checked.agentName) throw new IdentityError("binding_not_authorized");
			await commit();
		});
	}
}
