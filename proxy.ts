#!/usr/bin/env node
/**
 * Use the Chromium remote debugger to proxify HTTP requests.
 */
import CDP from "chrome-remote-interface";
import { readFileSync } from "fs";
import kl from "kleur";
import { generateCACertificate, getLocal, type CompletedRequest, type Mockttp } from "mockttp";
import path from "path";

const DEBUGGER_HOST = process.env.CHROME_DEBUGGER_HOST || "127.0.0.1";
const DEBUGGER_PORT = Number(process.env.CHROME_DEBUGGER_PORT || 9222);
const PROXY_PORT = Number(process.env.PROXY_PORT || 9090);

interface BrowserTarget {
    targetId: string;
    sessionId?: string;
}

const PAYLOAD = readFileSync(path.join(__dirname, "payload.js"), "utf8");

// The following headers shouldn't be transmitted by the proxy to the browser.
// https://developer.mozilla.org/en-US/docs/Glossary/Forbidden_request_header
const IGNORED_HEADERS = [
    "accept-charset",
    "accept-encoding",
    "access-control-request-headers",
    "access-control-request-method",
    "connection",
    "content-length",
    "cookie",
    "date",
    "dnt",
    "expect",
    "host",
    "keep-alive",
    "origin",
    "permissions-policy",
    "referer",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "via",
];

const IGNORED_HEADER_PREFIXES = ["proxy-", "sec-"];

const filterHeaders = (headers: { [K: string]: any }) =>
    Object.fromEntries(
        Object.entries(headers).filter(
            ([header, value]) =>
                typeof value === "string" &&
                !IGNORED_HEADERS.includes(header) &&
                !IGNORED_HEADER_PREFIXES.some((prefix) => header.startsWith(prefix))
        )
    );

//### UTILS
function parseURL(url: string): URL {
    try {
        const parsed = URL.parse(url);
        if (!parsed) {
            throw new Error();
        }
        return parsed;
    } catch (err) {
        throw new Error(`Failed to parse url: ${url}`);
    }
}

const truncate = (s: string, maxLength: number) => (s.length > maxLength ? s.slice(0, maxLength - 3) + "..." : s);
//###

class ChromeDebuggerProxy {
    debuggerClient: CDP.Client;
    proxyServer: Mockttp;
    targets: { [K: string /* (host) */]: BrowserTarget };

    constructor(public debuggerOptions: CDP.Options, public proxyPort: number) {}

    public async connectToDebugger() {
        this.debuggerClient = await CDP(this.debuggerOptions);
        await this.loadTargets();
    }

    public async startProxy() {
        const https = await generateCACertificate();
        this.proxyServer = getLocal({ https });
        this.proxyServer.forAnyRequest().thenCallback(this.proxyHandler.bind(this));
        await this.proxyServer.start(this.proxyPort);
    }

    public async loadTargets() {
        this.targets = await this.debuggerClient.Target.getTargets()
            .then((response) =>
                response.targetInfos
                    .filter(({ url }) => url.startsWith("https://"))
                    .map(({ url, targetId }) => [parseURL(url).host, { targetId }])
            )
            .then(Object.fromEntries);
    }

    private async getTarget(url: URL): Promise<BrowserTarget> {
        let target: BrowserTarget;
        if (url.host in this.targets) {
            target = this.targets[url.host];
        } else {
            const { targetId } = await this.debuggerClient.Target.createTarget({ url: url.href });
            await new Promise((r) => setTimeout(r, 1000));
            target = { targetId };
        }
        if (!target.sessionId) {
            const { targetId } = target;
            const { sessionId } = await this.debuggerClient.Target.attachToTarget({ targetId, flatten: true });
            target.sessionId = sessionId;
            this.targets[url.host] = target;
        }
        return target;
    }

    public async debuggerFetch(method: string, url: URL, headers: object | null = null, body: string | null = null) {
        const { sessionId } = await this.getTarget(url);

        const fetchOptions = { method, credentials: "include", headers: headers || undefined, body: body || undefined };
        const expression = PAYLOAD.replace("{{URL}}", url.href).replace(
            "{{OPTIONS_JSON}}",
            JSON.stringify(fetchOptions)
        );
        const { result } = await this.debuggerClient.send(
            "Runtime.evaluate",
            { expression, awaitPromise: true, returnByValue: true },
            sessionId
        );
        if (result.subtype === "error") {
            throw new Error(`An error has occured during payload execution: ${result.description}`);
        }
        return result.value;
    }

    private async proxyHandler(request: CompletedRequest) {
        const url = parseURL(request.url);
        url.protocol = "https://"; // avoid 'mixed content' errors.
        if (url.href !== request.url) {
            console.log(kl.yellow(`Redirecting ${request.url} to ${url.href}`));
            return { statusCode: 302, headers: { location: url.href } };
        }

        const { method } = request;
        const headers = filterHeaders(request.headers);
        const body = await request.body.getText();
        const requestRepr = `--> [${method}] ${truncate(url.href, 80)}`;
        try {
            const {
                status: statusCode,
                statusText: statusMessage,
                headers: responseHeaders,
                body: responseBodyBytes,
            } = await this.debuggerFetch(method, url, headers, body);

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
    console.log(kl.yellow("Note: 'www' subdomain should be explicitly specified in web requests."));
    console.log(kl.blue("Connecting to the debugger..."));
    const proxy = new ChromeDebuggerProxy({ host: DEBUGGER_HOST, port: DEBUGGER_PORT }, PROXY_PORT);
    await proxy.connectToDebugger();

    process.stdin.setRawMode(true);
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    process.stdin.on("data", async (key: string) => {
        switch (key) {
            case "r":
                await proxy.loadTargets();
                const hosts = Object.keys(proxy.targets);
                console.log(kl.green(`Loaded targets: ${hosts.toString()}`));
                break;
            case "\u0003":
                process.exit();
        }
    });

    console.log(kl.blue("Press [r] to reload targets."));
    console.log(kl.blue("Starting the proxy server..."));
    await proxy.startProxy();
})();
