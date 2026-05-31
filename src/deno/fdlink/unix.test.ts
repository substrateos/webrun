import { makeFdlink } from "./unix.ts";
import { getFd, type TransferHandle } from "../../core/fdlink/mod.ts";

export type FdlinkStep =
    | { action: "create_pipe"; actor: "client" | "server"; pipeId: string }
    | { action: "send"; actor: "client" | "server"; payload: Uint8Array; passFds: string[]; expectError?: boolean }
    | { action: "recv_all"; actor: "client" | "server"; expectPayload: Uint8Array; assignFds: string[]; expectError?: boolean }
    | { action: "recv_async"; actor: "client" | "server"; expectPayload: Uint8Array; assignFds: string[] }
    | { action: "write_fd"; actor: "client" | "server"; fd: string; payload: Uint8Array }
    | { action: "read_fd"; actor: "client" | "server"; fd: string; expectPayload: Uint8Array }
    | { action: "close_connection"; actor: "client" | "server" }
    | { action: "assert_fd_closed"; actor: "client" | "server"; fd: string };

export type FdlinkSemanticTestCase = {
    name: string;
    steps: FdlinkStep[];
};

// ─── Helpers ───
const enc = new TextEncoder();
const encode = (s: string) => enc.encode(s);

export function transfer(from: "client" | "server", payload: string): FdlinkStep[] {
    const to = from === "client" ? "server" : "client";
    const data = encode(payload);
    return [
        { action: "send", actor: from, payload: data, passFds: [] },
        { action: "recv_all", actor: to, expectPayload: data, assignFds: [] }
    ];
}

export function verifyPipeTransfer(pipeId: string, remoteFdName: string): FdlinkStep[] {
    return [
        { action: "create_pipe", actor: "client", pipeId },
        { action: "send", actor: "client", payload: encode("pass_pipe"), passFds: [`${pipeId}.tx`] },
        { action: "recv_all", actor: "server", expectPayload: encode("pass_pipe"), assignFds: [remoteFdName] },
        { action: "write_fd", actor: "server", fd: remoteFdName, payload: encode("ping") },
        { action: "read_fd", actor: "client", fd: `${pipeId}.rx`, expectPayload: encode("ping") }
    ];
}

export function staggeredTransfer(chunks: { payload: string, passFds: string[] }[]): FdlinkStep[] {
    const sends = chunks.map(c => ({ action: "send" as const, actor: "client" as const, payload: encode(c.payload), passFds: c.passFds }));
    const recvs = chunks.map((c, i) => ({ 
        action: "recv_all" as const, 
        actor: "server" as const, 
        expectPayload: encode(c.payload), 
        assignFds: c.passFds.length > 0 ? [`staggered_fd_${i}`] : [] 
    }));
    return [...sends, ...recvs];
}

// ─── Test Declarations ───
export const testCases: FdlinkSemanticTestCase[] = [
    {
        name: "Basic transfer and FD verification",
        steps: [
            ...transfer("client", "Hello from client"),
            ...transfer("server", "Hello from server"),
            ...verifyPipeTransfer("pipe1", "server_rx")
        ]
    },
    {
        name: "OS halts recvmsg at SCM_RIGHTS boundaries",
        steps: [
            { action: "create_pipe", actor: "client", pipeId: "dummyA" },
            { action: "create_pipe", actor: "client", pipeId: "dummyB" },
            ...staggeredTransfer([
                { payload: "Chunk_A_with_FD", passFds: ["dummyA.tx"] },
                { payload: "Chunk_B_with_FD", passFds: ["dummyB.tx"] }
            ])
        ]
    },
    {
        name: "Zero-length payload with FDs is corrupted by dummy byte injection (Data corruption)",
        steps: [
            { action: "create_pipe", actor: "client", pipeId: "zero_data_pipe" },
            { action: "send", actor: "client", payload: new Uint8Array(0), passFds: ["zero_data_pipe.tx"], expectError: true }
        ]
    },
    {
        name: "Graceful disconnect (EOF)",
        steps: [
            ...transfer("client", "LastWords"),
            { action: "close_connection", actor: "client" },
            { action: "recv_all", actor: "server", expectPayload: new Uint8Array(0), assignFds: [] }
        ]
    },
    {
        name: "Extremely large payload fragmentation",
        steps: [
            ...staggeredTransfer([
                { payload: "x".repeat(1024 * 128), passFds: [] }
            ])
        ]
    },
    {
        name: "FDs leak on send error",
        steps: [
            { action: "create_pipe", actor: "client", pipeId: "leak_pipe" },
            { action: "close_connection", actor: "server" },
            { action: "send", actor: "client", payload: encode("boom"), passFds: ["leak_pipe.tx"], expectError: true },
            { action: "assert_fd_closed", actor: "client", fd: "leak_pipe.tx" }
        ]
    },
    {
        name: "receiveAsync silently drops FDs sent via SCM_RIGHTS (Data corruption/FD destruction)",
        steps: [
            { action: "create_pipe", actor: "client", pipeId: "async_pipe" },
            { action: "send", actor: "client", payload: encode("async_ping"), passFds: ["async_pipe.tx"] },
            { action: "recv_async", actor: "server", expectPayload: encode("async_ping"), assignFds: ["server_async_tx"] }
        ]
    },
    {
        name: "sendmsg silently drops payload data larger than socket buffer when passing FDs (Silent data loss)",
        steps: [
            { action: "create_pipe", actor: "client", pipeId: "large_pipe" },
            { action: "send", actor: "client", payload: new Uint8Array(1024 * 512).fill(65), passFds: ["large_pipe.tx"] },
            { action: "close_connection", actor: "client" },
            { action: "recv_all", actor: "server", expectPayload: new Uint8Array(1024 * 512).fill(65), assignFds: ["server_large_tx"] }
        ]
    },
    {
        name: "Truncated FDs are silently lost without error when receiving more than 4 FDs (Silent FD loss)",
        steps: [
            { action: "create_pipe", actor: "client", pipeId: "p1" },
            { action: "create_pipe", actor: "client", pipeId: "p2" },
            { action: "create_pipe", actor: "client", pipeId: "p3" },
            { action: "create_pipe", actor: "client", pipeId: "p4" },
            { action: "create_pipe", actor: "client", pipeId: "p5" },
            { 
                action: "send", 
                actor: "client", 
                payload: encode("lots of fds"), 
                passFds: ["p1.tx", "p2.tx", "p3.tx", "p4.tx", "p5.tx"] 
            },
            { 
                action: "recv_all", 
                actor: "server", 
                expectPayload: encode("lots of fds"), 
                assignFds: ["r1", "r2", "r3", "r4", "r5"],
                expectError: true
            }
        ]
    }
];

// ─── Execution Engine ───

// This function processes a filtered subset of steps for a specific actor.
async function executeActorSteps(steps: FdlinkStep[], actor: "client" | "server", sockPath: string, DenoDeps: any) {
    const transport = makeFdlink(DenoDeps);
    let conn;
    let listener;

    if (actor === "server") {
        listener = await transport.listen(sockPath);
        conn = await listener.accept();
    } else {
        // Wait briefly for server to bind
        await new Promise(r => setTimeout(r, 50));
        conn = await transport.connect(sockPath);
    }

    const stateFds = new Map<string, any>();
    const resolveFd = (name: string): any => {
        const fd = stateFds.get(name);
        if (!fd) {
            const keys = [...stateFds.keys()].join(", ");
            const stepsDump = JSON.stringify(steps, (k, v) => (v instanceof Uint8Array ? `Uint8Array(${v.length})` : v));
            throw new Error(`${actor} Missing FD: ${name}. Available keys: [${keys}]. Steps: ${stepsDump}`);
        }
        return fd;
    };

    for (const step of steps) {
        if (step.action === "create_pipe") {
            const pipe = transport.pipe();
            stateFds.set(`${step.pipeId}.rx`, pipe.readable);
            stateFds.set(`${step.pipeId}.tx`, pipe.writable);
        } 
        else if (step.action === "send") {
            const handles = step.passFds.map(resolveFd);
            try {
                conn.send(step.payload, handles);
                if (step.expectError) throw new Error(`${actor} Expected send to fail, but it succeeded`);
            } catch (e) {
                if (!step.expectError) throw e;
            }
        }
        else if (step.action === "recv_all" || step.action === "recv_async") {
            let totalRead = 0;
            const accumulated = new Uint8Array(step.expectPayload.byteLength);
            const receivedHandles: TransferHandle[] = [];

            try {
                while (totalRead < step.expectPayload.byteLength) {
                    const { data, transferred } = step.action === "recv_async" ? await conn.receiveAsync() : conn.receive();
                    if (data.length === 0) break; // EOF
                    accumulated.set(data, totalRead);
                    totalRead += data.length;
                    receivedHandles.push(...transferred);
                }

                if (step.expectPayload.byteLength === 0) {
                    const { data } = step.action === "recv_async" ? await conn.receiveAsync() : conn.receive();
                    if (data.length !== 0) throw new Error(`${actor} Expected EOF but got data`);
                } else {
                    const actual = accumulated.slice(0, totalRead);
                    if (actual.byteLength !== step.expectPayload.byteLength) throw new Error(`${actor} Payload length mismatch: got ${actual.byteLength}, expected ${step.expectPayload.byteLength}`);
                    for (let i = 0; i < actual.length; i++) {
                        if (actual[i] !== step.expectPayload[i]) throw new Error(`${actor} Payload mismatch at byte ${i}`);
                    }
                }

                if (receivedHandles.length !== step.assignFds.length) throw new Error(`${actor} FD count mismatch: got ${receivedHandles.length}, expected ${step.assignFds.length}`);
                for (let i = 0; i < step.assignFds.length; i++) {
                    stateFds.set(step.assignFds[i], receivedHandles[i]);
                }
                
                if (step.action === "recv_all" && step.expectError) {
                    throw new Error(`${actor} Expected recv_all to fail, but it succeeded`);
                }
            } catch (e) {
                if (!(step.action === "recv_all" && step.expectError)) throw e;
            }
        }
        else if (step.action === "write_fd") {
            const handle = resolveFd(step.fd);
            const stream = handle.writable || handle;
            const writer = stream.getWriter();
            await writer.write(step.payload);
            writer.releaseLock();
        }
        else if (step.action === "read_fd") {
            const handle = resolveFd(step.fd);
            const stream = handle.readable || handle;
            const reader = stream.getReader();
            const { value } = await reader.read();
            if (value === undefined) throw new Error(`${actor} Read FD yielded undefined`);
            if (value.byteLength !== step.expectPayload.byteLength) throw new Error(`${actor} Read FD payload length mismatch`);
            for (let i = 0; i < value.byteLength; i++) {
                if (value[i] !== step.expectPayload[i]) throw new Error(`${actor} Read FD payload mismatch at byte ${i}`);
            }
            reader.releaseLock();
        }
        else if (step.action === "close_connection") {
            conn.close();
        }
        else if (step.action === "assert_fd_closed") {
            const handle = resolveFd(step.fd);
            const stream = handle.writable || handle;
            const writer = stream.getWriter();
            let failed = false;
            try {
                await writer.write(new Uint8Array([0]));
            } catch (e) {
                failed = true;
            } finally {
                writer.releaseLock();
            }
            if (!failed) throw new Error(`${actor} FD ${step.fd} should be closed, but write succeeded`);
        }
    }

    conn.close();
    if (listener) listener.close();
}

// Subprocess entrypoint for the client worker
if (typeof Deno !== "undefined" && Deno.args && Deno.args[0] === "fdlink_client_worker") {
    const sockPath = Deno.args[1];
    const testName = Deno.args[2];
    const tc = testCases.find(t => t.name === testName);
    if (!tc) {
        console.error(`Test ${testName} not found`);
        Deno.exit(1);
    }
    const clientSteps = tc.steps.filter(s => s.actor === "client");
    executeActorSteps(clientSteps, "client", sockPath, Deno).then(() => Deno.exit(0)).catch(e => {
        console.error(e.stack);
        Deno.exit(1);
    });
}

// Main test harness runner
export async function testFdlinkSemantics(t: any, ctx: any, DenoDeps: any) {
    for (const tc of testCases) {
        await t.run(tc.name, async () => {
            const tmpPath = await DenoDeps.makeTempDir() + "/fdlink.sock";
            
            // Spawn the client worker in a separate OS thread/process
            // This prevents deadlock on synchronous blocking FFI calls (sendmsg)
            const command = new DenoDeps.Command(DenoDeps.execPath(), {
                args: ["run", "-A", "--no-check", import.meta.url, "fdlink_client_worker", tmpPath, tc.name],
                stdout: "piped",
                stderr: "piped"
            });
            const clientProcess = command.spawn();

            const serverSteps = tc.steps.filter(s => s.actor === "server");
            
            let serverError: any;
            try {
                await executeActorSteps(serverSteps, "server", tmpPath, DenoDeps);
            } catch (e) {
                serverError = e;
            }

            if (serverError) {
                try {
                    clientProcess.kill("SIGKILL");
                } catch (e) {
                    // Process might have already exited
                }
            }

            const { code, stderr } = await clientProcess.output();
            const clientStderr = new TextDecoder().decode(stderr).trim();

            if (serverError) {
                if (clientStderr) {
                    throw new Error(`${serverError.message}\n\n--- CLIENT STDERR ---\n${clientStderr}\n---------------------`, { cause: serverError });
                }
                throw serverError;
            }
            
            if (code !== 0) {
                t.fail(`Client process failed (code ${code}):\n${clientStderr}`);
            }
        });
    }
}
