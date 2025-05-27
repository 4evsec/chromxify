#!/usr/bin/env -S npx ts-node
/**
 * Use the Chrome remote debugger to proxify HTTP requests through any Chromium-based browser
 *
 * This script starts a local proxy server that forwards HTTP requests to a Chromium browser
 * through the remote debugger by executing consecutive `fetch` calls.
 */
import CDP from "chrome-remote-interface";
import { readFileSync } from "fs";
import kl from "kleur";
import {
    generateCACertificate,
    getLocal,
    type CompletedRequest,
    type Headers,
    type Mockttp,
} from "mockttp";
import { type CallbackResponseResult } from "mockttp/dist/rules/requests/request-handler-definitions";
import path from "path";

const DEBUGGER_HOST = process.env.CHROME_DEBUGGER_HOST || "127.0.0.1";
const DEBUGGER_PORT = process.env.CHROME_DEBUGGER_PORT || 9222;
const PROXY_PORT = process.env.PROXY_PORT || 9090;
const REDIRECT_HTTPS = !(process.env.REDIRECT_HTTPS === "false"); // true by default

interface Target {
    targetId: string;
    sessionId?: string;
}

interface ProxyOptions {
    // This option avoids 'mixed content' errors in the target browser.
    redirectHTTPS: boolean;
}

namespace Fetch {
    export interface Options {
        method: string;
        headers?: object;
        body?: string;
        credentials?: "include";
    }

    export interface Result {
        status: number;
        statusText: string;
        headers: Headers;
        body: ArrayBuffer;
    }
}

const PAYLOAD = readFileSync(path.join(__dirname, "payload.js"), "utf8");

// The following headers shouldn't be transmitted by the proxy to the browser.
// https://developer.mozilla.org/en-US/docs/Glossary/Forbidden_request_header
const HEADERS_IGNORE = new RegExp(
    readFileSync(path.join(__dirname, "headers_ignore.txt"), "utf8").split(/\r?\n/).join("|"),
    "i",
);

const filterHeaders = (headers: Headers) =>
    Object.fromEntries(
        Object.entries(headers).filter(
            ([header, value]) => typeof value === "string" && !HEADERS_IGNORE.test(header),
        ),
    );

const isUrl = (url: string): boolean =>
    ["http://", "https://"].some((prefix) => url.startsWith(prefix));

class ChromeDebuggerProxy {
    debuggerClient: CDP.Client;
    proxyServer: Mockttp;
    targets: { [K: string]: Target };

    constructor(
        public debuggerOptions: CDP.Options,
        public proxyPort: number,
        public proxyOptions: ProxyOptions = { redirectHTTPS: true },
    ) {}

    async connectToDebugger() {
        console.log(kl.blue("Connecting to the debugger..."));
        this.debuggerClient = await CDP(this.debuggerOptions);
    }

    async startProxy() {
        console.log(kl.blue("Starting the proxy server..."));
        const https = await generateCACertificate();
        this.proxyServer = getLocal({ https });
        this.proxyServer.forAnyRequest().thenCallback(this.proxyHandler.bind(this));
        return await this.proxyServer.start(this.proxyPort);
    }

    async loadTargets() {
        console.log(kl.blue("Loading remote targets..."));
        this.targets = await this.debuggerClient.Target.getTargets()
            .then((response) =>
                response.targetInfos
                    .filter(({ url }) => isUrl(url))
                    .map(({ url, targetId }) => [URL.parse(url).host, { targetId }]),
            )
            .then(Object.fromEntries);
        console.log(Object.keys(this.targets).toString());
    }

    async getTarget(url: URL): Promise<Target> {
        let targetId: string, sessionId: string;
        if (url.host in this.targets) {
            ({ targetId, sessionId } = this.targets[url.host]);
        } else {
            ({ targetId } = await this.debuggerClient.Target.createTarget({ url: url.href }));
            await new Promise((r) => setTimeout(r, 1000));
        }
        if (!sessionId) {
            ({ sessionId } = await this.debuggerClient.Target.attachToTarget({
                targetId,
                flatten: true,
            }));
            this.targets[url.host] = { targetId, sessionId };
        }
        return { targetId, sessionId };
    }

    async debuggerFetch(url: URL, fetchOptions: Fetch.Options): Promise<Fetch.Result> {
        const { sessionId } = await this.getTarget(url);
        fetchOptions.credentials = "include";
        const expression = PAYLOAD.replace("{{URL}}", url.href).replace(
            "{{OPTIONS_JSON}}",
            JSON.stringify(fetchOptions),
        );
        const { result } = await this.debuggerClient.send(
            "Runtime.evaluate",
            { expression, awaitPromise: true, returnByValue: true },
            sessionId,
        );
        if (result.subtype === "error") {
            throw new Error(`An error has occured during payload execution: ${result.description}`);
        }
        return result.value;
    }

    async proxyHandler(request: CompletedRequest): Promise<CallbackResponseResult> {
        const url = URL.parse(request.url);

        // Redirect rules
        if (this.proxyOptions.redirectHTTPS) {
            url.protocol = "https://";
        }
        //...
        //

        if (url.href !== request.url) {
            console.log(kl.yellow(`Redirecting ${request.url} to ${url.href}`));
            return { statusCode: 302, headers: { location: url.href } };
        }

        const { method } = request;
        const headers = filterHeaders(request.headers) || undefined;
        const body = (await request.body.getText()) || undefined;
        const requestRepr = `--> [${method}] ${url.origin}${url.pathname}`;
        try {
            const {
                status: statusCode,
                statusText: statusMessage,
                headers: responseHeaders,
                body: responseBodyBytes,
            } = await this.debuggerFetch(url, { method, headers, body });

            const responseBody = Buffer.from(responseBodyBytes);

            console.log(kl.green(requestRepr));
            return { statusCode, statusMessage, headers: responseHeaders, body: responseBody };
        } catch (err) {
            console.log(kl.red(requestRepr));
            console.error(err);
            return { status: 500, body: String(err) };
        }
    }
}

(async () => {
    const proxy = new ChromeDebuggerProxy(
        { host: DEBUGGER_HOST, port: Number(DEBUGGER_PORT) },
        Number(PROXY_PORT),
        { redirectHTTPS: REDIRECT_HTTPS },
    );
    await proxy.connectToDebugger();
    await proxy.loadTargets();

    process.stdin.setRawMode(true);
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    process.stdin.on("data", async (key: string) => {
        switch (key) {
            case "r":
                await proxy.loadTargets();
                break;
            case "\u0003":
                process.exit();
        }
    });
    console.log(kl.yellow("Press [r] to reload targets."));

    await proxy.startProxy();
    console.log(
        kl.gray(
            "Note: subdomains (such as 'www') should be explicitly specified in web requests sent through the proxy.",
        ),
    );
})();
