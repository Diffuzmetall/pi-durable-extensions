import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { defineExtension, wrapTool } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
const MAX_INPUT_BYTES = 65_536;
const MAX_STDOUT_BYTES = 1_048_576;
const MAX_STDERR_BYTES = 65_536;
const EVALUATOR_DEADLINE_MS = 2_000;
const TERM_GRACE_MS = 100;
const KILL_OBSERVE_MS = 1_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
function unavailable(code) {
    return new Error(`DCG_UNAVAILABLE:${code}`);
}
function invalidOptions() {
    return new Error("DCG_INVALID_OPTIONS");
}
function copyPlainStringMap(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        throw invalidOptions();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
        throw invalidOptions();
    if (Reflect.ownKeys(value).some(key => typeof key !== "string"))
        throw invalidOptions();
    const copy = Object.create(null);
    for (const [key, entry] of Object.entries(value)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || key.includes("\0") || typeof entry !== "string" || entry.includes("\0"))
            throw invalidOptions();
        copy[key] = entry;
    }
    return copy;
}
function validateOptions(value) {
    try {
        if (typeof value !== "object" || value === null || Array.isArray(value))
            throw invalidOptions();
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null)
            throw invalidOptions();
        const keys = Reflect.ownKeys(value);
        if (keys.length !== 2 || !keys.includes("binaryPath") || !keys.includes("evaluatorEnv"))
            throw invalidOptions();
        const options = value;
        const binaryPath = options.binaryPath;
        if (typeof binaryPath !== "string" || binaryPath.length === 0 || binaryPath.includes("\0") || !isAbsolute(binaryPath))
            throw invalidOptions();
        const evaluatorEnv = copyPlainStringMap(options.evaluatorEnv);
        for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME"]) {
            const path = evaluatorEnv[key];
            if (typeof path !== "string" || path.length === 0 || !isAbsolute(path))
                throw invalidOptions();
        }
        if (evaluatorEnv.DCG_CONFIG !== undefined && evaluatorEnv.DCG_CONFIG !== "" && !isAbsolute(evaluatorEnv.DCG_CONFIG))
            throw invalidOptions();
        return { binaryPath, evaluatorEnv };
    }
    catch {
        throw invalidOptions();
    }
}
function capturedOptions(options, fallbackCwd) {
    const source = options ?? {};
    const cwd = source.cwd ?? fallbackCwd;
    const env = source.env === undefined ? undefined : { ...source.env };
    const spill = source.spill === undefined ? undefined : { ...source.spill };
    const window = source.window === undefined ? undefined : { ...source.window };
    return {
        ...(cwd === undefined ? {} : { cwd }),
        ...(env === undefined ? {} : { env }),
        ...(source.inheritEnv === undefined ? {} : { inheritEnv: source.inheritEnv }),
        ...(source.timeout === undefined ? {} : { timeout: source.timeout }),
        ...(source.onOutput === undefined ? {} : { onOutput: source.onOutput }),
        ...(spill === undefined ? {} : { spill }),
        ...(window === undefined ? {} : { window }),
    };
}
function captureCall(command, options, fallbackCwd) {
    if (typeof command !== "string" || command.length === 0 || command.includes("\0"))
        throw unavailable("invalid_input");
    const originalBytes = encoder.encode(command);
    if (decoder.decode(originalBytes) !== command)
        throw unavailable("invalid_input");
    const captured = capturedOptions(options, fallbackCwd);
    const cwd = captured.cwd;
    if (typeof cwd !== "string" || !isAbsolute(cwd))
        throw unavailable("invalid_cwd");
    let normalizedCwd;
    try {
        normalizedCwd = resolve(cwd);
    }
    catch {
        throw unavailable("invalid_cwd");
    }
    return { command, cwd: normalizedCwd, options: { ...captured, cwd: normalizedCwd } };
}
function isAborted(...signals) {
    return signals.some(signal => signal?.aborted === true);
}
function framedInput(command) {
    if (!command || command.includes("\0"))
        return "invalid_input";
    const bytes = encoder.encode(command);
    if (decoder.decode(bytes) !== command)
        return "invalid_input";
    if (bytes.byteLength + 2 > MAX_INPUT_BYTES)
        return "invalid_input";
    return Buffer.concat([Buffer.from(bytes), Buffer.from("\r\n")]);
}
function parseProtocol(stdout, exitCode, signal, command) {
    let text;
    try {
        text = decoder.decode(stdout).trim();
    }
    catch {
        return { kind: "unavailable", code: "protocol_error" };
    }
    let value;
    try {
        value = JSON.parse(text);
    }
    catch {
        return { kind: "unavailable", code: "protocol_error" };
    }
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return { kind: "unavailable", code: "protocol_error" };
    const result = value;
    if (typeof result.dcg_version === "string" && result.dcg_version !== "0.15.3") {
        return { kind: "unavailable", code: "unsupported_version" };
    }
    if (result.schema_version !== 1 || result.dcg_version !== "0.15.3" || result.robot_mode !== true || result.command !== command) {
        return { kind: "unavailable", code: "protocol_error" };
    }
    if (signal !== null)
        return { kind: "unavailable", code: "protocol_error" };
    if (result.decision === "allow" && (exitCode === 0) && (!Object.hasOwn(result, "mode") || result.mode === null))
        return { kind: "allow" };
    if (result.decision === "deny" && result.mode === "deny" && exitCode === 1)
        return { kind: "deny" };
    return { kind: "unavailable", code: "protocol_error" };
}
function signalGroup(child, signal) {
    if (!child.pid)
        return true;
    try {
        process.kill(-child.pid, signal);
        return true;
    }
    catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH")
            return true;
        return false;
    }
}
function processGroupExists(child) {
    if (!child.pid)
        return false;
    try {
        process.kill(-child.pid, 0);
        return true;
    }
    catch (error) {
        if (typeof error === "object" && error !== null && "code" in error) {
            if (error.code === "ESRCH")
                return false;
            if (error.code === "EPERM")
                return true;
        }
        return undefined;
    }
}
async function waitForGroupExit(child, timeoutMs) {
    if (!child.pid)
        return true;
    const deadline = Date.now() + timeoutMs;
    while (true) {
        const exists = processGroupExists(child);
        if (exists === false)
            return true;
        if (exists === undefined || Date.now() >= deadline)
            return false;
        await new Promise(resolve => setTimeout(resolve, Math.min(20, deadline - Date.now())));
    }
}
async function stopOwnedGroup(child) {
    if (!child.pid)
        return true;
    const termSent = signalGroup(child, "SIGTERM");
    if (await waitForGroupExit(child, TERM_GRACE_MS))
        return termSent;
    const killSent = signalGroup(child, "SIGKILL");
    const groupExited = await waitForGroupExit(child, KILL_OBSERVE_MS);
    return termSent && killSent && groupExited;
}
async function evaluate(binaryPath, evaluatorEnv, command, cwd, signals) {
    const input = framedInput(command);
    if (typeof input === "string")
        return { kind: "unavailable", code: input };
    if (process.platform === "win32")
        return { kind: "unavailable", code: "unsupported_environment" };
    if (isAborted(...signals))
        return { kind: "unavailable", code: "aborted" };
    try {
        const directory = await stat(cwd);
        await access(cwd, fsConstants.X_OK);
        if (!directory.isDirectory())
            return { kind: "unavailable", code: "invalid_cwd" };
    }
    catch {
        return { kind: "unavailable", code: "invalid_cwd" };
    }
    try {
        const binary = await stat(binaryPath);
        await access(binaryPath, fsConstants.X_OK);
        if (!binary.isFile())
            return { kind: "unavailable", code: "spawn_failed" };
    }
    catch {
        return { kind: "unavailable", code: "spawn_failed" };
    }
    if (isAborted(...signals))
        return { kind: "unavailable", code: "aborted" };
    return await new Promise(resolve => {
        const startedAt = Date.now();
        let child;
        try {
            child = spawn(binaryPath, ["--robot", "test", "--dialect", "posix", "--enforce-budget", "--stdin"], {
                cwd,
                env: { ...evaluatorEnv },
                stdio: ["pipe", "pipe", "pipe"],
                shell: false,
                detached: true,
                windowsHide: true,
            });
        }
        catch {
            resolve({ kind: "unavailable", code: "spawn_failed" });
            return;
        }
        let stdout = Buffer.alloc(0);
        let stderr = Buffer.alloc(0);
        let settled = false;
        let closeSeen = false;
        let finishComplete = false;
        let failure;
        let exitCode = null;
        let exitSignal = null;
        let inputError = false;
        const removeAbortListeners = () => signals.forEach(signal => signal?.removeEventListener("abort", onAbort));
        const cleanupListeners = () => {
            if (!closeSeen || !finishComplete)
                return;
            child.removeAllListeners();
            child.stdin?.removeAllListeners();
            child.stdout?.removeAllListeners();
            child.stderr?.removeAllListeners();
        };
        const finish = async (verdict, terminate) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(deadline);
            removeAbortListeners();
            if (terminate && !await stopOwnedGroup(child) && verdict.kind !== "unavailable") {
                verdict = { kind: "unavailable", code: "protocol_error" };
            }
            finishComplete = true;
            cleanupListeners();
            resolve(verdict);
        };
        const fail = (code) => {
            if (failure === undefined)
                failure = code;
            void finish({ kind: "unavailable", code: failure }, true);
        };
        const onAbort = () => fail("aborted");
        const deadline = setTimeout(() => fail("timeout"), Math.max(0, EVALUATOR_DEADLINE_MS - (Date.now() - startedAt)));
        for (const signal of signals) {
            if (!signal)
                continue;
            if (signal.aborted) {
                fail("aborted");
                break;
            }
            signal.addEventListener("abort", onAbort, { once: true });
        }
        child.stdout?.on("data", (chunk) => {
            if (settled)
                return;
            if (stdout.length + chunk.length > MAX_STDOUT_BYTES)
                return fail("output_limit");
            stdout = Buffer.concat([stdout, chunk]);
        });
        child.stderr?.on("data", (chunk) => {
            if (settled)
                return;
            if (stderr.length + chunk.length > MAX_STDERR_BYTES)
                return fail("output_limit");
            stderr = Buffer.concat([stderr, chunk]);
        });
        child.stdin?.on("error", () => { inputError = true; fail("protocol_error"); });
        child.on("error", () => fail("spawn_failed"));
        child.on("close", (code, signal) => {
            closeSeen = true;
            exitCode = code;
            exitSignal = signal;
            if (settled) {
                cleanupListeners();
                return;
            }
            if (processGroupExists(child) !== false)
                return fail("protocol_error");
            if (failure !== undefined)
                return void finish({ kind: "unavailable", code: failure }, false);
            if (inputError || isAborted(...signals))
                return fail(isAborted(...signals) ? "aborted" : "protocol_error");
            try {
                decoder.decode(stderr);
            }
            catch {
                return fail("protocol_error");
            }
            const verdict = parseProtocol(stdout, exitCode, exitSignal, command);
            if (verdict.kind === "allow" && isAborted(...signals))
                return fail("aborted");
            void finish(verdict, false);
        });
        try {
            child.stdin?.end(input);
        }
        catch {
            fail("protocol_error");
        }
    });
}
function guardError(verdict) {
    return verdict.kind === "deny" ? new Error("DCG_DENIED") : unavailable(verdict.code);
}
export function createDcgGuard(options) {
    const validated = validateOptions(options);
    const binaryPath = validated.binaryPath;
    const evaluatorEnv = validated.evaluatorEnv;
    const bashTool = CodingTools.tools?.find(tool => tool.name === "bash");
    if (!bashTool)
        throw unavailable("unsupported_environment");
    return defineExtension({
        name: "dcg-guard",
        wraps: [wrapTool(bashTool, selected => {
                const original = selected;
                if (original.replay === "safe")
                    throw unavailable("unsupported_environment");
                if (typeof original.execute !== "function")
                    throw unavailable("unsupported_environment");
                return {
                    ...original,
                    replay: "unsafe",
                    async execute(args, api, context) {
                        const invocationEnv = api.env;
                        if (!(invocationEnv instanceof NodeExecutionEnv) || invocationEnv.id !== "node:local" || process.platform === "win32") {
                            throw unavailable("unsupported_environment");
                        }
                        const boundExec = invocationEnv.exec.bind(invocationEnv);
                        const guardedExec = async (command, options, execContext) => {
                            let call;
                            try {
                                call = captureCall(command, options, invocationEnv.cwd);
                            }
                            catch (error) {
                                if (error instanceof Error && error.message.startsWith("DCG_UNAVAILABLE:"))
                                    throw error;
                                throw unavailable("invalid_input");
                            }
                            const verdict = await evaluate(binaryPath, evaluatorEnv, call.command, call.cwd, [context.abortSignal, execContext.abortSignal]);
                            if (verdict.kind !== "allow")
                                throw guardError(verdict);
                            if (isAborted(context.abortSignal, execContext.abortSignal))
                                throw unavailable("aborted");
                            return await boundExec(call.command, call.options, execContext);
                        };
                        const view = new Proxy(invocationEnv, {
                            get(target, property) {
                                if (property === "exec")
                                    return guardedExec;
                                const value = Reflect.get(target, property, target);
                                return typeof value === "function" ? value.bind(target) : value;
                            },
                            set() { throw unavailable("unsupported_environment"); },
                            defineProperty() { throw unavailable("unsupported_environment"); },
                            deleteProperty() { throw unavailable("unsupported_environment"); },
                            setPrototypeOf() { throw unavailable("unsupported_environment"); },
                            preventExtensions() { throw unavailable("unsupported_environment"); },
                        });
                        const guardedApi = { ...api, env: view };
                        const copiedArgs = typeof args === "object" && args !== null ? { ...args } : args;
                        return await original.execute.call(original, copiedArgs, guardedApi, context);
                    },
                };
            })],
    });
}
