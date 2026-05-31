/**
 * Serve — Type Definitions
 *
 * Platform-agnostic serve contract. Defines the handler shape,
 * context, options, and result that all serve adapters implement.
 *
 * These types are used by application code (e.g. ua_proxy)
 * to avoid coupling to a specific serve implementation.
 */

/** Context passed to the handler alongside each request. */
export interface ServeContext {
    /** Upgrade an HTTP request to a WebSocket connection. */
    upgradeWebSocket?: (options?: {
        protocol?: string;
        idleTimeout?: number;
    }) => {
        socket: WebSocket;
        response: Response;
    };

    /** Upgrade a CONNECT request to a bidirectional byte stream.
     *  Only available when req.method === "CONNECT". */
    upgradeConnect?: () => ConnectInfo;
}

/** Bidirectional byte streams for a CONNECT tunnel. */
export interface ConnectInfo {
    /** Data from the client. */
    readable: ReadableStream<Uint8Array>;
    /** Data to the client. */
    writable: WritableStream<Uint8Array>;
}

/** TLS configuration for HTTPS servers. */
export interface TlsConfig {
    /** Default certificate PEM. */
    cert: string;
    /** Default private key PEM. */
    key: string;
    /** Dynamic certificate selection based on SNI hostname. */
    SNICallback?: (hostname: string) => Promise<{ cert: string; key: string }>;
}

/** Options for starting a server. */
export interface ServeOptions {
    /** Listen addresses as URL strings (e.g. "http://127.0.0.1:0").
     *  Port 0 allocates an ephemeral port. */
    listen?: (string | URL)[];
    /** TLS configuration. When provided, creates an HTTPS server. */
    tls?: TlsConfig;
    /** Abort signal for graceful shutdown. */
    signal?: AbortSignal;
}

/** Result of starting a server. */
export interface ServeResult {
    /** Resolved listen URLs with actual ports. */
    urls: URL[];
    /** Shut down the server. */
    shutdown: () => Promise<void>;
}

/** Handler function: receives a Request, returns a Response. */
export type ServeHandler = (
    req: Request,
    ctx: ServeContext,
) => Response | Promise<Response>;

/** The serve function contract. */
export type ServeFn = (
    handler: ServeHandler,
    options?: ServeOptions,
) => Promise<ServeResult>;
