# Use the Chromium remote debugger to proxify HTTP requests

_This script starts a local proxy server that forwards HTTP requests to a Chromium
browser through the remote debugger by executing consecutive `fetch` calls._

> Note : Remote debugger could be started by using the `--remote-debugging-port` flag.

## Usage

```sh
npm install
npm run build
chmod u+x proxy.js
./proxy.js
```

The following variables could be used as parameters for this script:

| Variable        | Description                                | Default value |
| --------------- | ------------------------------------------ | ------------- |
| `DEBUGGER_HOST` | The host of the remote debugger interface. | `127.0.0.1`   |
| `DEBUGGER_PORT` | The port of the remote debugger interface. | `9222`        |
| `PROXY_PORT`    | The port of the local proxy server.        | `9090`        |

## License

This project is licensed under the MIT License - see the LICENSE file for details.
