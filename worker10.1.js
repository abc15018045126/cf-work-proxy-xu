import { connect } from 'cloudflare:sockets';
const UUID = "23e0a1ab-f173-443c-ae26-1e3391a6ed4e"; 
if (!isValidUUID(UUID)) {
    throw new Error('UUID is not valid');
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
                            `Hello from Cloudflare Workers VLESS Server!\n\n` +
                            `Access https://${currentHost}/${UUID} for VLESS configuration.`,
                            { status: 200, headers: { 'Content-Type': 'text/plain;charset=utf-8' } }
                        );
                    case `/${UUID}`: {
                        const vlessConfig = getVLESSConfig(UUID, currentHost);
                        return new Response(`${vlessConfig}`, {
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
                return await vlessOverWSHandler(request);
            }
        } catch (err) {
            /** @type {Error} */ let e = err;
            console.error("Worker fetch error:", e.stack || e.message || e);
            return new Response(`Worker Error: ${e.message || e}`, { status: 500 });
        }
    },
};
async function vlessOverWSHandler(request) {

    const webSocketPair = new WebSocketPair();
    const [client, webSocket] = Object.values(webSocketPair);
    webSocket.accept();
    let remoteSocket = null;
    let vlessResponseHeader = null;
    const readableWebSocketStream = new ReadableStream({
        start(controller) {
            webSocket.addEventListener('message', event => {
                if (event.data instanceof ArrayBuffer) {
                    controller.enqueue(event.data);
                } else {
                    console.warn("Received non-ArrayBuffer data from client, skipping:", event.data);
                }
            });
            webSocket.addEventListener('close', () => {
                console.log("Client WebSocket closed.");
                controller.close();
            });
            webSocket.addEventListener('error', err => {
                console.error("Client WebSocket error:", err);
                controller.error(err);
            });
        },
        cancel(reason) {
            console.log(`WebSocket readable stream canceled: ${reason}`);
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
                    vlessVersion,
                    isUDP,
                } = processVlessHeader(chunk, UUID);

                if (hasError) {
                    throw new Error(message);
                }
                if (isUDP) {
                    throw new Error("UDP is not supported in this simplified worker.");
                }
                vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
                const rawClientData = chunk.slice(rawDataIndex); 

                remoteSocket = connect({ hostname: addressRemote, port: portRemote });
                console.log(`Connected to remote: ${addressRemote}:${portRemote}`);
                const writer = remoteSocket.writable.getWriter();
                await writer.write(await new Blob([vlessResponseHeader, rawClientData]).arrayBuffer());
                writer.releaseLock();
                remoteSocket.readable.pipeTo(new WritableStream({
                    write(remoteChunk) {
                        if (webSocket.readyState === WS_READY_STATE_OPEN) {
                            webSocket.send(remoteChunk);
                        }
                    },
                    close() {
                        console.log("Remote socket readable closed.");
                        safeCloseSocket(webSocket); // 远程连接关闭，安全关闭 WebSocket
                    },
                    abort(reason) {
                        console.error("Remote socket readable aborted:", reason);
                        safeCloseSocket(webSocket); // 远程连接异常，安全关闭 WebSocket
                    }
                })).catch(e => {
                    console.error("Error piping remote to WS:", e.stack || e.message || e);
                    safeCloseSocket(webSocket);
                });

            } else {

                const writer = remoteSocket.writable.getWriter();
                await writer.write(chunk);
                writer.releaseLock();
            }
        },
        close() {
            console.log("WebSocket writable stream closed.");
            if (remoteSocket) safeCloseSocket(remoteSocket); // WebSocket 关闭，关闭远程连接
        },
        abort(reason) {
            console.error("WebSocket writable stream aborted:", reason);
            if (remoteSocket) safeCloseSocket(remoteSocket); // WebSocket 异常，关闭远程连接
        }
    })).catch(e => {
        console.error("Error in main pipe (WS to remote):", e.stack || e.message || e);
        safeCloseSocket(webSocket);
        if (remoteSocket) safeCloseSocket(remoteSocket);
    });

    return new Response(null, { status: 101, webSocket: client });
}
function isValidUUID(uuid) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
}
const byteToHex = [];
for (let i = 0; i < 256; ++i) {
    byteToHex.push((i + 256).toString(16).slice(1));
}
function unsafeStringify(arr, offset = 0) {
    return (byteToHex[arr[offset + 0]] + byteToHex[arr[offset + 1]] + byteToHex[arr[offset + 2]] + byteToHex[arr[offset + 3]] + "-" + byteToHex[arr[offset + 4]] + byteToHex[arr[offset + 5]] + "-" + byteToHex[arr[offset + 6]] + byteToHex[arr[offset + 7]] + "-" + byteToHex[arr[offset + 8]] + byteToHex[arr[offset + 9]] + "-" + byteToHex[arr[offset + 10]] + byteToHex[arr[offset + 11]] + byteToHex[arr[offset + 12]] + byteToHex[arr[offset + 13]] + byteToHex[arr[offset + 14]] + byteToHex[arr[offset + 15]]).toLowerCase();
}
function stringify(arr, offset = 0) {
    const uuid = unsafeStringify(arr, offset);
    if (!isValidUUID(uuid)) {
        throw TypeError("Stringified UUID is invalid");
    }
    return uuid;
}
function processVlessHeader(
    vlessBuffer,
    userID
) {
    if (vlessBuffer.byteLength < 24) {
        return {
            hasError: true,
            message: 'invalid data: buffer too short',
        };
    }
    const version = new Uint8Array(vlessBuffer.slice(0, 1));
    let isValidUser = false;
    let isUDP = false;
    if (stringify(new Uint8Array(vlessBuffer.slice(1, 17))) === userID) {
        isValidUser = true;
    }
    if (!isValidUser) {
        return {
            hasError: true,
            message: 'invalid user ID',
        };
    }
    const optLength = new Uint8Array(vlessBuffer.slice(17, 18))[0];
    const command = new Uint8Array(
        vlessBuffer.slice(18 + optLength, 18 + optLength + 1)
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
    const portBuffer = vlessBuffer.slice(portIndex, portIndex + 2);
    const portRemote = new DataView(portBuffer).getUint16(0);

    let addressIndex = portIndex + 2;
    const addressBuffer = new Uint8Array(
        vlessBuffer.slice(addressIndex, addressIndex + 1)
    );
    const addressType = addressBuffer[0];
    let addressLength = 0;
    let addressValueIndex = addressIndex + 1;
    let addressValue = '';
    switch (addressType) {
        case 1: 
            addressLength = 4;
            addressValue = new Uint8Array(
                vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
            ).join('.');
            break;
        case 2: // Domain Name
            addressLength = new Uint8Array(
                vlessBuffer.slice(addressValueIndex, addressValueIndex + 1)
            )[0];
            addressValueIndex += 1;
            addressValue = new TextDecoder().decode(
                vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
            );
            break;
        case 3: 
            addressLength = 16;
            const dataView = new DataView(
                vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
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
        vlessVersion: version,
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
    } catch (error) {
        console.error('safeCloseSocket error:', error);
    }
}
function getVLESSConfig(userID, hostName) {
    const vlessMain = `vless://${userID}\u0040${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2048#${hostName}`
    return `
################################################################
VLESS Configuration for Cloudflare Worker
---------------------------------------------------------------
${vlessMain}
---------------------------------------------------------------
################################################################
Clash-Meta Configuration
---------------------------------------------------------------
- type: vless
  name: ${hostName}
  server: ${hostName}
  port: 443
  uuid: ${userID}
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
