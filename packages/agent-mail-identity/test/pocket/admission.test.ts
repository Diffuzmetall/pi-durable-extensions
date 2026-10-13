import { test } from "node:test";
import assert from "node:assert/strict";
import type { ConversationId } from "@earendil-works/pi-durable";
import { createPocketWakeAdmission, revalidateWake, WAKE_SCHEMA_VERSION } from "../../pocket/index.ts";
import type { BindingLookup, HostAdmission, PocketContext, PocketHostSurface, WakeAdmissionContract, WakeFacts } from "../../pocket/index.ts";
import { barrier } from "../repair-extra.inc.ts";

/**
 * AM3 unit evidence for the wake admission, with no Durable harness and no Pocket process: the host surface and the
 * embedding contract below are fakes that model the real contract (an input binding keyed by request id, a submit that
 * is deduplicated by the host, a conversation whose requester, role, visibility, driver, held-back state and limit can
 * change between two reads). `test/pocket/install.test.ts` covers composition, installation and migration.
 */

const CONVERSATION = 7 as unknown as ConversationId;
const ctx = undefined as unknown as PocketContext;

type State = {
	requester: string | null;
	personExists: boolean;
	maySteer: boolean;
	canSee: boolean;
	driver: string | null;
	heldBack: string | null;
	limit: string | null;
	present: boolean;
	schemaVersion: number;
	busy: boolean;
	/** Force the public binding lookup to answer `unknown`, as a contract that cannot prove the booking would. */
	unprovenLookup: boolean;
};

function fixture(options: { hindsight?: boolean; onAdmitInput?: () => Promise<void>; onAdmissionOf?: () => Promise<void> | void } = {}) {
	const state: State = {
		requester: "person-1", personExists: true, maySteer: true, canSee: true, driver: "person-1",
		heldBack: null, limit: null, present: true, schemaVersion: WAKE_SCHEMA_VERSION, busy: false, unprovenLookup: false,
	};
	const calls = { requesterOf: 0, heldBack: 0, admitInput: 0, charges: 0, submit: 0 };
	/** The host's own input binding, keyed by request id: a second write of the same id books nothing again. */
	const owners = new Map<string, string | null>();
	const turns: { requestId: string; content: string; personId: string }[] = [];
	const host: PocketHostSurface = {
		requesterOf() { calls.requesterOf += 1; return state.requester ?? undefined; },
		heldBack() { calls.heldBack += 1; return state.heldBack ?? undefined; },
		...(options.hindsight === false ? {} : {
			hindsight: {
				async admitInput(_conversationId, requestId: string) {
					calls.admitInput += 1;
					await options.onAdmitInput?.();
					if (owners.has(requestId)) return;
					owners.set(requestId, state.requester);
					calls.charges += 1;
				},
			},
		}),
	};
	const authority: WakeAdmissionContract = {
		extensionPresent: () => state.present,
		personExists: () => state.personExists,
		maySteer: () => state.maySteer,
		canSee: () => state.canSee,
		currentDriver: () => state.driver ?? undefined,
		limitReached: () => state.limit ?? undefined,
		watchSchemaVersion: () => state.schemaVersion,
		admissionOf(_conversationId, requestId): BindingLookup {
			void options.onAdmissionOf?.();
			if (state.unprovenLookup) return { state: "unknown" };
			return owners.has(requestId) ? { state: "bound", owner: owners.get(requestId) ?? "" } : { state: "absent" };
		},
		async submitAsBoundPerson(_conversationId, input) {
			calls.submit += 1;
			if (state.busy) return "busy";
			if (!owners.has(input.requestId)) { owners.set(input.requestId, input.personId); calls.charges += 1; }
			if (!turns.some(turn => turn.requestId === input.requestId)) turns.push({ requestId: input.requestId, content: input.content, personId: input.personId });
			return "admitted";
		},
	};
	const wake = createPocketWakeAdmission(host, { authority, retryAfterMs: 4321 });
	return { state, calls, owners, turns, host, authority, wake };
}

const delivery = { conversationId: CONVERSATION, requestId: "am2:key-1", payload: "Agent Mail delivery for BlueLake in project /fixture/project" };

test("the default Pocket host refuses enable with missing_host_capability and touches nothing", async () => {
	// `requesterOf`/`heldBack` exist on the current PocketHost, but no submit-as-bound-person and no live reader do.
	const host: PocketHostSurface = { requesterOf: () => "person-1", heldBack: () => undefined, hindsight: { async admitInput() {} } };
	const wake = createPocketWakeAdmission(host);
	assert.deepEqual(wake.capabilities().missing, ["submit_as_bound_person", "live_registry_reader", "admission_lookup"]);
	const enabled = await wake.enable({ conversationId: CONVERSATION });
	assert.equal(enabled.result, "denied");
	assert.equal(enabled.result === "denied" ? enabled.reason : null, "missing_host_capability");
	assert.deepEqual(enabled.result === "denied" ? enabled.missing : null, ["submit_as_bound_person", "live_registry_reader", "admission_lookup"]);
	// A delivery is refused the same way, and no submit is ever attempted without the mandatory capabilities.
	const submitted = await wake.submit(delivery, ctx);
	assert.equal(submitted.result, "denied");
	assert.equal(submitted.result === "denied" ? submitted.reason : null, "missing_host_capability");
	// Without a hindsight admission the lookup is not required: only the two mandatory capabilities are.
	const lean = createPocketWakeAdmission({ requesterOf: () => "person-1", heldBack: () => undefined });
	assert.deepEqual(lean.capabilities().missing, ["submit_as_bound_person", "live_registry_reader"]);
	console.log(JSON.stringify({ refused: "missing_host_capability", missing: wake.capabilities().missing.length }));
});

test("a complete contract admits an idle conversation whose person may still steer", async () => {
	const f = fixture();
	assert.equal(f.wake.capabilities().complete, true);
	const enabled = await f.wake.enable({ conversationId: CONVERSATION });
	assert.deepEqual(enabled, { result: "allowed", requestId: null });
	assert.equal(f.calls.admitInput, 0, "an enable binds nothing");
	assert.equal(f.calls.submit, 0, "an enable submits nothing");
	assert.equal(f.calls.charges, 0);
	// The full delivery path admits once and books once.
	const submitted = await f.wake.submit(delivery, ctx);
	assert.deepEqual(submitted, { result: "allowed", requestId: "am2:key-1" });
	assert.equal(f.turns.length, 1);
	assert.equal(f.calls.admitInput, 1);
	assert.equal(f.calls.charges, 1);
	assert.equal(f.turns[0].personId, "person-1", "the input is submitted for the bound person");
	console.log(JSON.stringify({ admitted: 1, charges: 1 }));
});

test("a busy conversation is a result, not a delivery: the pending delivery stays", async () => {
	const f = fixture();
	f.state.busy = true;
	const submitted = await f.wake.submit(delivery, ctx);
	assert.deepEqual(submitted, { result: "busy", requestId: "am2:key-1", retryAfterMs: 4321 });
	assert.equal(f.turns.length, 0, "nothing was delivered while the conversation is busy");
	assert.equal(f.calls.charges, 1, "the input binding was still booked once: it is its own admission");
	f.state.busy = false;
	const retried = await f.wake.submit(delivery, ctx);
	assert.deepEqual(retried, { result: "allowed", requestId: "am2:key-1" });
	assert.equal(f.turns.length, 1);
	assert.equal(f.calls.charges, 1, "the retry books nothing again");
	console.log(JSON.stringify({ busy: 1, turnsAfterIdle: f.turns.length, charges: f.calls.charges }));
});

test("held-back work pauses and a spend limit denies, and neither submits", async () => {
	const held = fixture();
	held.state.heldBack = "the session reached its spend limit";
	const paused = await held.wake.submit(delivery, ctx);
	assert.equal(paused.result, "paused");
	assert.equal(paused.result === "paused" ? paused.reason : null, "held_back");
	assert.equal(held.calls.submit, 0, "a held-back conversation is never submitted to");
	const limited = fixture();
	limited.state.limit = "background spend limit reached";
	const denied = await limited.wake.submit(delivery, ctx);
	assert.equal(denied.result, "denied");
	assert.equal(denied.result === "denied" ? denied.reason : null, "budget_denied");
	assert.equal(limited.calls.submit, 0, "and the extension changes no host budget on a refusal");
	assert.equal(limited.calls.charges, 0, "no admission is booked for a denied delivery");
	const enabled = await limited.wake.enable({ conversationId: CONVERSATION });
	assert.equal(enabled.result, "denied", "an enable is refused for the same reason");
	console.log(JSON.stringify({ paused: "held_back", denied: "budget_denied" }));
});

test("a revoked right denies at admission: gone person, downgraded role, revoked visibility, another driver", async () => {
	const cases: Array<[string, (state: ReturnType<typeof fixture>["state"]) => void, string]> = [
		["the person was removed", state => { state.personExists = false; }, "identity_mismatch"],
		["the person was downgraded to a viewer", state => { state.maySteer = false; }, "identity_mismatch"],
		["the person can no longer see the conversation", state => { state.canSee = false; }, "identity_mismatch"],
		["someone else drives now", state => { state.driver = "person-2"; }, "identity_mismatch"],
		["nobody works for this conversation now", state => { state.requester = null; }, "requester_unbound"],
	];
	for (const [label, change, reason] of cases) {
		const f = fixture();
		change(f.state);
		const decision: HostAdmission = await f.wake.submit(delivery, ctx);
		assert.equal(decision.result, "denied", label);
		assert.equal(decision.result === "denied" ? decision.reason : null, reason, label);
		assert.equal(f.calls.submit, 0, `${label}: no admission may reach the submit`);
		assert.equal(f.calls.charges, 0, `${label}: no budget may be booked`);
	}
	console.log(JSON.stringify({ denied: cases.length, reasons: ["identity_mismatch", "requester_unbound"] }));
});

test("losing live presence pauses, and a foreign watch schema denies poll and submit", async () => {
	const gone = fixture();
	gone.state.present = false;
	const paused = await gone.wake.submit(delivery, ctx);
	assert.equal(paused.result, "paused");
	assert.equal(paused.result === "paused" ? paused.reason : null, "extension_removed");
	assert.equal(gone.calls.submit, 0);
	const foreign = fixture();
	foreign.state.schemaVersion = WAKE_SCHEMA_VERSION + 1;
	const denied = await foreign.wake.submit(delivery, ctx);
	assert.equal(denied.result, "denied");
	assert.equal(denied.result === "denied" ? denied.reason : null, "schema_unsupported");
	assert.equal(JSON.stringify(foreign.wake.capabilities().complete), "true", "a schema this build does not know is not a capability");
	// The pure revalidation refuses the same document without any host at all.
	const base: WakeFacts = {
		capabilities: { complete: true, present: ["submit_as_bound_person", "live_registry_reader"], missing: [] },
		schemaVersion: 2, extensionPresent: true, requester: "person-1", personExists: true, requesterMaySteer: true,
		requesterSeesConversation: true, currentDriver: "person-1", heldBack: null, limitReached: null,
		binding: { state: "absent" }, hindsightAdmission: false, requestId: "am2:key-1",
	};
	assert.deepEqual(revalidateWake(base), { result: "denied", reason: "schema_unsupported" });
	assert.deepEqual(revalidateWake({ ...base, schemaVersion: WAKE_SCHEMA_VERSION }), { result: "allowed", requestId: "am2:key-1" });
	console.log(JSON.stringify({ paused: "extension_removed", denied: "schema_unsupported" }));
});

test("a repeated admission with the same request id admits and books once", async () => {
	const f = fixture();
	assert.equal((await f.wake.submit(delivery, ctx)).result, "allowed");
	const second = await f.wake.submit(delivery, ctx);
	assert.equal(second.result, "allowed", "the host deduplicates a repeated request id instead of delivering twice");
	assert.equal(f.turns.length, 1);
	assert.equal(f.owners.size, 1);
	assert.equal(f.calls.charges, 1, "the budget is booked exactly once for the request id");
	assert.equal(f.calls.admitInput, 1, "the input binding is written exactly once: the public lookup proves it exists");
	console.log(JSON.stringify({ submissions: f.calls.submit, turns: f.turns.length, charges: f.calls.charges, admitInput: f.calls.admitInput }));
});

test("a crash between the input binding and the submit recovers once, with the same owner", async () => {
	const f = fixture();
	f.state.busy = true;
	// The booking and the turn are the host's; the crash lands after the binding was booked and before any turn.
	const crashing = f.authority.submitAsBoundPerson;
	f.authority.submitAsBoundPerson = async () => { throw new Error("process died between the binding and the submit"); };
	await assert.rejects(f.wake.submit(delivery, ctx), /died between the binding and the submit/);
	assert.equal(f.calls.admitInput, 1, "the input binding was already booked when the process died");
	assert.equal(f.calls.charges, 1);
	assert.equal(f.turns.length, 0);
	const owner = f.owners.get("am2:key-1");
	assert.equal(owner, "person-1");
	// Recovery: the public lookup proves the binding, so it is not written again, and the submit is the only step left.
	f.authority.submitAsBoundPerson = crashing;
	f.state.busy = false;
	const recovered = await f.wake.submit(delivery, ctx);
	assert.equal(recovered.result, "allowed");
	assert.equal(f.calls.admitInput, 1, "the recovery did not write the input binding a second time");
	assert.equal(f.calls.charges, 1, "and did not book the budget a second time");
	assert.equal(f.owners.get("am2:key-1"), owner, "the input owner is unchanged");
	assert.equal(f.turns.length, 1, "exactly one turn came out of the crashed delivery");
	console.log(JSON.stringify({ admitInput: f.calls.admitInput, charges: f.calls.charges, owner }));
});

test("a contract that cannot prove the binding stays paused instead of submitting", async () => {
	const f = fixture();
	f.state.unprovenLookup = true;
	const decision = await f.wake.submit(delivery, ctx);
	assert.equal(decision.result, "paused");
	assert.equal(decision.result === "paused" ? decision.reason : null, "admission_unproven");
	assert.equal(f.calls.submit, 0, "an unproven booking is never submitted under");
	assert.equal(f.calls.admitInput, 0, "and nothing is written for it either: the whole admission stays paused");
	assert.equal(f.calls.charges, 0);
	console.log(JSON.stringify({ paused: "admission_unproven", submits: f.calls.submit }));
});

test("the authority is re-read immediately before the submit: a revocation cancels the admission", async () => {
	const entering = barrier(), release = barrier();
	const f = fixture({ onAdmitInput: async () => { entering.resolve(); await release.promise; } });
	const running = f.wake.submit(delivery, ctx);
	await entering.promise;
	// The rights change between the first check and the submit: the re-check right before the submit must see it.
	f.state.maySteer = false;
	release.resolve();
	const decision = await running;
	assert.equal(decision.result, "denied");
	assert.equal(decision.result === "denied" ? decision.reason : null, "identity_mismatch");
	assert.equal(f.turns.length, 0, "a revoked right cancels the admission and leaves the delivery pending");
	console.log(JSON.stringify({ cancelled: "identity_mismatch", turns: f.turns.length }));
});

test("the residual revocation window is real: a change after the last check is not revocable from here", async () => {
	// The re-check immediately before the submit is the last public barrier; a change that lands after it happens inside
	// the host's own submit, the same residual window AM2 reports for its disable. It is demonstrated, not promised.
	const entering = barrier(), release = barrier();
	const f = fixture();
	const original = f.authority.submitAsBoundPerson;
	let held = false;
	f.authority.submitAsBoundPerson = async (conversationId, input) => {
		if (!held) { held = true; entering.resolve(); await release.promise; }
		return original(conversationId, input);
	};
	const running = f.wake.submit(delivery, ctx);
	await entering.promise;
	f.state.canSee = false;
	release.resolve();
	assert.equal((await running).result, "allowed");
	assert.equal(f.turns.length, 1, "an admission already inside the host's submit is not revoked by this package");
	console.log(JSON.stringify({ residualWindow: "change-after-last-check", turns: f.turns.length }));
});

test("an identity that changes between the two reads cancels the admission instead of submitting as the earlier person", async () => {
	// The gate-fix case: a positive contract with no hindsight binding needs only `submit_as_bound_person` and
	// `live_registry_reader`, so nothing else stands between the two reads. The first read sees person-1; the confirming
	// read must decide, and the input must never be submitted for a person the confirmation did not validate.
	const f = fixture({ hindsight: false });
	let reads = 0;
	f.authority.admissionOf = () => {
		// Called once per read set, after that set's requester read and before the next one's.
		reads += 1;
		if (reads === 1) { f.state.requester = "person-2"; f.state.driver = "person-2"; }
		return { state: "unknown" };
	};
	const decision = await f.wake.submit(delivery, ctx);
	// The invariant that must hold however the admission is decided: the person the first read saw is never the input's
	// owner when the confirming read validated somebody else.
	assert.ok(!f.turns.some(turn => turn.personId === "person-1"), `the input must never be submitted for the person the admission replaced: ${JSON.stringify(f.turns)}`);
	assert.equal(decision.result, "denied", "a handover during the admission must not submit as the person who was replaced");
	assert.equal(decision.result === "denied" ? decision.reason : null, "identity_mismatch");
	assert.equal(f.calls.submit, 0, "no input is submitted for an identity the confirmation did not validate");
	assert.equal(f.turns.length, 0, "and no turn is started");
	// Control: the same second person, already in place before both reads, is admitted and is the person the input names.
	const handed = fixture({ hindsight: false });
	handed.state.requester = "person-2";
	handed.state.driver = "person-2";
	const clean = await handed.wake.submit(delivery, ctx);
	assert.equal(clean.result, "allowed");
	assert.equal(handed.turns.length, 1);
	assert.equal(handed.turns[0].personId, "person-2", "the confirming read's person is the input's owner");
	console.log(JSON.stringify({ changedDuringAdmission: "denied", ownerWhenStable: handed.turns[0].personId }));
});
