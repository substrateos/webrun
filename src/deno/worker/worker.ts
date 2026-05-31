/**
 * Worker Web Worker entrypoint.
 *
 * This is the code that runs inside the Deno Web Worker spawned by
 * the sandbox. It exposes the WorkerAPI for the sandbox to call.
 */
import { exposeSelf } from "../../ipc/worker.ts";
import createWorkerAPI from "./worker_api.ts";

exposeSelf(createWorkerAPI());
