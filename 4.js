import { connect } from 'cloudflare:sockets';
const ID = "23e0a1ab-f173-443c-ae26-1e3391a6ed4e";
if (!isValidID(ID)) {
    throw new Error('ID is not valid');
}
const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;
export default {
    async fetch(request, env, ctx) {
        try {
            const upgradeHeader = request.headers.get('Upgrade');
            if (!upgradeHeader || upgradeHeader !== 'websocket') {
                const url = new URL(request.url);
                const currentHost = url.host;
                switch (url.pathname) {
                    case '/':
                        return new Response(
                            `Hello from Cloudflare Workers NLESS Server!\n\n` +
                            `Access https://${currentHost}/${ID} for NLESS configuration.`,
                            { status: 200, headers: { 'Content-Type': 'text/plain;charset=utf-8' } }
                        );
                    case `/${ID}`: {
                        const nlessConfig = getNLESSConfig(ID, currentHost);
                        return new Response(`${nlessConfig}`, {
                            status: 200,
                            headers: {
                                "Content-Type": "text/plain;charset=utf-8",
                            }
                        });
                    }
                    default:
                        return new Response('Not found', { status: 404 });
                }
            } else {
                return await nlessOverWSHandler(request);
            }
        } catch (err) {
            let e = err;
            return new Response(`Worker Error: ${e.message || e}`, { status: 500 });
        }
    },
};

async function nlessOverWSHandler(request) {
    const webSocketPair = new WebSocketPair();
    const [client, webSocket] = Object.values(webSocketPair);
    webSocket.accept();
    let remoteSocket = null;
    let nlessResponseHeader = null;
    const readableWebSocketStream = new ReadableStream({
        start(controller) {
            webSocket.addEventListener('message', event => {
                if (event.data instanceof ArrayBuffer) {
                    controller.enqueue(event.data);
                }
            });
            webSocket.addEventListener('close', () => {
                controller.close();
            });
            webSocket.addEventListener('error', err => {
                controller.error(err);
            });
        },
        cancel(reason) {
            safeCloseSocket(webSocket);
            if (remoteSocket) safeCloseSocket(remoteSocket);
        }
    });
    readableWebSocketStream.pipeTo(new WritableStream({
        async write(chunk) {
            if (!remoteSocket) {
                const {
                    hasError,
                    message,
                    portRemote,
                    addressRemote,
                    rawDataIndex,
                    nlessVersion,
                    isUDP,
                } = processNlessHeader(chunk, ID);

                if (hasError) {
                    throw new Error(message);
                }
                if (isUDP) {
                    throw new Error("UDP is not supported in this simplified worker.");
                }
                nlessResponseHeader = new Uint8Array([nlessVersion[0], 0]);
                const rawClientData = chunk.slice(rawDataIndex);

                remoteSocket = connect({ hostname: addressRemote, port: portRemote });
                const writer = remoteSocket.writable.getWriter();
                await writer.write(await new Blob([nlessResponseHeader, rawClientData]).arrayBuffer());
                writer.releaseLock();
                remoteSocket.readable.pipeTo(new WritableStream({
                    write(remoteChunk) {
                        if (webSocket.readyState === WS_READY_STATE_OPEN) {
                            webSocket.send(remoteChunk);
                        }
                    },
                    close() {
                        safeCloseSocket(webSocket);
                    },
                    abort(reason) {
                        safeCloseSocket(webSocket);
                    }
                })).catch(e => {
                    safeCloseSocket(webSocket);
                });

            } else {
                const writer = remoteSocket.writable.getWriter();
                await writer.write(chunk);
                writer.releaseLock();
            }
        },
        close() {
            if (remoteSocket) safeCloseSocket(remoteSocket);
        },
        abort(reason) {
            if (remoteSocket) safeCloseSocket(remoteSocket);
        }
    })).catch(e => {
        safeCloseSocket(webSocket);
        if (remoteSocket) safeCloseSocket(remoteSocket);
    });

    return new Response(null, { status: 101, webSocket: client });
}

function isValidID(id) {
    const idRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return idRegex.test(id);
}

const byteToHex = [];
for (let i = 0; i < 256; ++i) {
    byteToHex.push((i + 256).toString(16).slice(1));
}

function unsafeStringify(arr, offset = 0) {
    return (byteToHex[arr[offset + 0]] + byteToHex[arr[offset + 1]] + byteToHex[arr[offset + 2]] + byteToHex[arr[offset + 3]] + "-" + byteToHex[arr[offset + 4]] + byteToHex[arr[offset + 5]] + "-" + byteToHex[arr[offset + 6]] + byteToHex[arr[offset + 7]] + "-" + byteToHex[arr[offset + 8]] + byteToHex[arr[offset + 9]] + "-" + byteToHex[arr[offset + 10]] + byteToHex[arr[offset + 11]] + byteToHex[arr[offset + 12]] + byteToHex[arr[offset + 13]] + byteToHex[arr[offset + 14]] + byteToHex[arr[offset + 15]]).toLowerCase();
}

function stringify(arr, offset = 0) {
    const id = unsafeStringify(arr, offset);
    if (!isValidID(id)) {
        throw TypeError("Stringified ID is invalid");
    }
    return id;
}

function processNlessHeader(nlessBuffer, id) {
    if (nlessBuffer.byteLength < 24) {
        return {
            hasError: true,
            message: 'invalid data: buffer too short',
        };
    }
    const version = new Uint8Array(nlessBuffer.slice(0, 1));
    let isValidUser = false;
    let isUDP = false;
    if (stringify(new Uint8Array(nlessBuffer.slice(1, 17))) === id) {
        isValidUser = true;
    }
    if (!isValidUser) {
        return {
            hasError: true,
            message: 'invalid user ID',
        };
    }
    const optLength = new Uint8Array(nlessBuffer.slice(17, 18))[0];
    const command = new Uint8Array(
        nlessBuffer.slice(18 + optLength, 18 + optLength + 1)
    )[0];
    if (command === 1) {
    } else if (command === 2) {
        isUDP = true;
    } else {
        return {
            hasError: true,
            message: `command ${command} is not supported (only 01-tcp, 02-udp, 03-mux)`,
        };
    }
    const portIndex = 18 + optLength + 1;
    const portBuffer = nlessBuffer.slice(portIndex, portIndex + 2);
    const portRemote = new DataView(portBuffer).getUint16(0);

    let addressIndex = portIndex + 2;
    const addressBuffer = new Uint8Array(
        nlessBuffer.slice(addressIndex, addressIndex + 1)
    );
    const addressType = addressBuffer[0];
    let addressLength = 0;
    let addressValueIndex = addressIndex + 1;
    let addressValue = '';
    switch (addressType) {
        case 1:
            addressLength = 4;
            addressValue = new Uint8Array(
                nlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
            ).join('.');
            break;
        case 2:
            addressLength = new Uint8Array(
                nlessBuffer.slice(addressValueIndex, addressValueIndex + 1)
            )[0];
            addressValueIndex += 1;
            addressValue = new TextDecoder().decode(
                nlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
            );
            break;
        case 3:
            addressLength = 16;
            const dataView = new DataView(
                nlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
            );
            const ipv6 = [];
            for (let i = 0; i < 8; i++) {
                ipv6.push(dataView.getUint16(i * 2).toString(16));
            }
            addressValue = ipv6.join(':');
            break;
        default:
            return {
                hasError: true,
                message: `invalid addressType: ${addressType}`,
            };
    }
    if (!addressValue) {
        return {
            hasError: true,
            message: `addressValue is empty for addressType: ${addressType}`,
        };
    }
    return {
        hasError: false,
        addressRemote: addressValue,
        addressType,
        portRemote,
        rawDataIndex: addressValueIndex + addressLength,
        nlessVersion: version,
        isUDP,
    };
}

function safeCloseSocket(socket) {
    try {
        if ('readyState' in socket) {
            if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
                socket.close();
            }
        } else {
            socket.close();
        }
    } catch (error) {}
}

function getNLESSConfig(id, hostName) {
    const nlessMain = `nless://${id}\u0040${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2048#${hostName}`
    return `
################################################################
NLESS Configuration for Cloudflare Worker
---------------------------------------------------------------
${nlessMain}
---------------------------------------------------------------
################################################################

---------------------------------------------------------------
- type: nless
  name: ${hostName}
  server: ${hostName}
  port: 443
  id: ${id}
  network: ws
  tls: true
  udp: false
  sni: ${hostName}
  client-fingerprint: chrome
  ws-opts:
    path: "/?ed=2048"
    headers:
      host: ${hostName}
---------------------------------------------------------------
################################################################
`;
}
