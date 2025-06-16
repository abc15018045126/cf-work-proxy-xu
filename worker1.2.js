import { connect } from 'cloudflare:sockets';

const DEFAULT_USER_ID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
const DEFAULT_PROXY_IPS = ['cdn.xn--b6gac.eu.org:443', 'cdn-all.xn--b6gac.eu.org:443'];
const DEFAULT_SOCKS5_ADDRESS = '';
const DEFAULT_SOCKS5_RELAY = false;

const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;

function selectRandomAddress(addresses) {
    const addrs = addresses.split(',').map(a => a.trim());
    return addrs[Math.floor(Math.random() * addrs.length)];
}

function parseEncodedQueryParams(pathname) {
    return {};
}

function handleProxyConfig(proxyIpConfig) {
    const ips = Array.isArray(proxyIpConfig) ? proxyIpConfig : proxyIpConfig.split(',').map(addr => addr.trim());
    const selected = ips[Math.floor(Math.random() * ips.length)];
    const parts = selected.split(':');
    return {
        ip: parts[0],
        port: parts[1] || '443'
    };
}

function socks5AddressParser(socks5Addr) {
    const parts = socks5Addr.split('@');
    let auth = null;
    let hostPort = socks5Addr;

    if (parts.length > 1) {
        auth = parts[0].split(':');
        hostPort = parts[1];
    }

    const hp = hostPort.split(':');
    return {
        username: auth ? auth[0] : undefined,
        password: auth ? auth[1] : undefined,
        host: hp[0],
        port: parseInt(hp[1] || '1080')
    };
}

async function socks5Connect(addressType, address, port, log, parsedSocks5Address) {
    log(`Connecting via SOCKS5 to ${address}:${port}`);
    const socket = await connect({ hostname: parsedSocks5Address.host, port: parsedSocks5Address.port });
    return socket;
}

async function handleDNSQuery(chunk, webSocket, protocolResponseHeader, log) {
    log('Handling DNS Query (placeholder)');
    if (webSocket.readyState === WS_READY_STATE_OPEN) {
        webSocket.send(new Uint8Array([0, 0, 0, 0]));
    }
}

function GenSub(uuid, host, proxyAddresses) {
    const address = Array.isArray(proxyAddresses) ? proxyAddresses[0] : proxyAddresses;
    return `vless://${uuid}@${host}:${address.split(':')[1] || '443'}?encryption=none&security=tls&type=ws&host=${host}&path=%2F#${host}-Cloudflare`;
}

function getConfig(uuid, host, proxyAddresses) {
    const address = Array.isArray(proxyAddresses) ? proxyAddresses[0] : proxyAddresses;
    return `
    <html>
        <body>
            <h1>VLESS Configuration</h1>
            <p>UUID: ${uuid}</p>
            <p>Host: ${host}</p>
            <p>Proxy Address: ${address}</p>
            <pre>
                {
                    "outbounds": [
                        {
                            "protocol": "vless",
                            "settings": {
                                "vnext": [
                                    {
                                        "address": "${host}",
                                        "port": ${address.split(':')[1] || '443'},
                                        "users": [
                                            {
                                                "id": "${uuid}",
                                                "encryption": "none"
                                            }
                                        ]
                                    }
                                ]
                            },
                            "streamSettings": {
                                "network": "ws",
                                "security": "tls",
                                "wsSettings": {
                                    "path": "/"
                                }
                            }
                        }
                    ]
                }
            </pre>
        </body>
    </html>
    `;
}

function stringify(arr) {
    let hex = Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20, 32)}`;
}

function safeCloseWebSocket(ws) {
    if (ws && ws.readyState !== WS_READY_STATE_CLOSING && ws.readyState !== WS_READY_STATE_OPEN) {
        try {
            ws.close();
        } catch (error) {
            console.error("Error closing WebSocket:", error);
        }
    }
}

function isValidUUID(uuid) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
}

function base64ToArrayBuffer(base64Str) {
    if (!base64Str) {
        return { earlyData: null, error: null };
    }
    try {
        base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/');
        const binaryStr = atob(base64Str);
        const buffer = new ArrayBuffer(binaryStr.length);
        const view = new Uint8Array(buffer);
        for (let i = 0; i < binaryStr.length; i++) {
            view[i] = binaryStr.charCodeAt(i);
        }
        return { earlyData: buffer, error: null };
    } catch (error) {
        return { earlyData: null, error };
    }
}

function MakeReadableWebSocketStream(webSocketServer, earlyDataHeader, log) {
    const stream = new ReadableStream({
        start(controller) {
            webSocketServer.addEventListener('message', (event) => {
                controller.enqueue(event.data);
            });

            webSocketServer.addEventListener('close', () => {
                safeCloseWebSocket(webSocketServer);
                controller.close();
            });

            webSocketServer.addEventListener('error', (err) => {
                log('webSocketServer has error', err);
                controller.error(err);
            });

            const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
            if (error) {
                controller.error(error);
            } else if (earlyData) {
                controller.enqueue(earlyData);
            }
        },
        cancel(reason) {
            log(`ReadableStream was canceled, due to ${reason}`);
            safeCloseWebSocket(webSocketServer);
        }
    });
    return stream;
}

function ProcessProtocolHeader(protocolBuffer, userID) {
    if (protocolBuffer.byteLength < 24) {
        return { hasError: true, message: 'invalid data' };
    }

    const dataView = new DataView(protocolBuffer);
    const version = dataView.getUint8(0);
    const clientUUID = stringify(new Uint8Array(protocolBuffer.slice(1, 17)));

    const uuids = userID.split(',').map(id => id.trim());
    const isValidUser = uuids.includes(clientUUID);

    console.log(`Client UUID: ${clientUUID}`);

    if (!isValidUser) {
        return { hasError: true, message: 'invalid user' };
    }

    const optLength = dataView.getUint8(17);
    const command = dataView.getUint8(18 + optLength);

    if (command !== 1 && command !== 2) {
        return { hasError: true, message: `command ${command} is not supported (only 01-tcp, 02-udp)` };
    }

    const portIndex = 18 + optLength + 1;
    const portRemote = dataView.getUint16(portIndex);
    const addressType = dataView.getUint8(portIndex + 2);
    let addressValue = '';
    let addressLength = 0;
    let addressValueIndex = 0;

    switch (addressType) {
        case 1:
            addressLength = 4;
            addressValueIndex = portIndex + 3;
            addressValue = new Uint8Array(protocolBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join('.');
            break;
        case 2:
            addressLength = dataView.getUint8(portIndex + 3);
            addressValueIndex = portIndex + 4;
            addressValue = new TextDecoder().decode(protocolBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
            break;
        case 3:
            addressLength = 16;
            addressValueIndex = portIndex + 3;
            addressValue = Array.from({ length: 8 }, (_, i) => dataView.getUint16(addressValueIndex + i * 2).toString(16)).join(':');
            break;
        default:
            return { hasError: true, message: `invalid addressType: ${addressType}` };
    }

    if (!addressValue) {
        return { hasError: true, message: `addressValue is empty for addressType: ${addressType}` };
    }

    return {
        hasError: false,
        addressRemote: addressValue,
        addressType,
        portRemote,
        rawDataIndex: addressValueIndex + addressLength,
        protocolVersion: new Uint8Array([version]),
        isUDP: command === 2
    };
}

async function RemoteSocketToWS(remoteSocketWrapper, webSocket, protocolResponseHeader, retry, log) {
    let hasIncomingData = false;

    try {
        await remoteSocketWrapper.value.readable.pipeTo(
            new WritableStream({
                async write(chunk) {
                    if (webSocket.readyState !== WS_READY_STATE_OPEN) {
                        throw new Error('WebSocket is not open');
                    }
                    hasIncomingData = true;
                    const dataToSend = protocolResponseHeader ?
                        await new Blob([protocolResponseHeader, chunk]).arrayBuffer() :
                        chunk;
                    webSocket.send(dataToSend);
                    protocolResponseHeader = null;
                },
                close() {
                    log(`Remote connection readable closed. Had incoming data: ${hasIncomingData}`);
                },
                abort(reason) {
                    console.error(`Remote connection readable aborted:`, reason);
                },
            })
        );
    } catch (error) {
        console.error(`RemoteSocketToWS error:`, error.stack || error);
        safeCloseWebSocket(webSocket);
    }

    if (!hasIncomingData && retry) {
        log(`No incoming data, retrying`);
        await retry();
    }
}

async function HandleTCPOutBound(remoteSocketWrapper, addressType, addressRemote, portRemote, rawClientData, webSocket, protocolResponseHeader, log, config) {

    async function connectAndWrite(targetAddress, targetPort, useSocks) {
        let tcpSocket;
        if (config.socks5Relay || useSocks) {
            tcpSocket = await socks5Connect(addressType, targetAddress, targetPort, log, config.parsedSocks5Address);
        } else {
            tcpSocket = await connect({
                hostname: targetAddress,
                port: targetPort,
            });
        }
        remoteSocketWrapper.value = tcpSocket;
        log(`Connected to ${targetAddress}:${targetPort}`);
        const writer = tcpSocket.writable.getWriter();
        await writer.write(rawClientData);
        writer.releaseLock();
        return tcpSocket;
    }

    async function retryConnection() {
        let tcpSocket;
        if (config.enableSocks) {
            tcpSocket = await connectAndWrite(addressRemote, portRemote, true);
        } else {
            tcpSocket = await connectAndWrite(config.proxyIP || addressRemote, config.proxyPort || portRemote, false);
        }
        tcpSocket.closed.catch(error => {
            console.error('Retry tcpSocket closed error', error);
        }).finally(() => {
            safeCloseWebSocket(webSocket);
        });
        RemoteSocketToWS(remoteSocketWrapper, webSocket, protocolResponseHeader, null, log);
    }

    let tcpSocket = await connectAndWrite(addressRemote, portRemote, false);
    RemoteSocketToWS(remoteSocketWrapper, webSocket, protocolResponseHeader, retryConnection, log);
}

function getRequestConfig(request, env) {
    const url = new URL(request.url);

    const config = {
        userID: DEFAULT_USER_ID,
        socks5Address: DEFAULT_SOCKS5_ADDRESS,
        socks5Relay: DEFAULT_SOCKS5_RELAY,
        proxyIP: null,
        proxyPort: null,
        enableSocks: false,
        parsedSocks5Address: {},
    };

    config.userID = env.UUID || config.userID;
    config.socks5Address = env.SOCKS5 || config.socks5Address;
    config.socks5Relay = env.SOCKS5_RELAY === 'true' || config.socks5Relay;

    let urlPROXYIP = url.searchParams.get('proxyip');
    let urlSOCKS5 = url.searchParams.get('socks5');
    let urlSOCKS5_RELAY = url.searchParams.get('socks5_relay');

    if (!urlPROXYIP && !urlSOCKS5 && !urlSOCKS5_RELAY) {
        const encodedParams = parseEncodedQueryParams(url.pathname);
        urlPROXYIP = urlPROXYIP || encodedParams.proxyip;
        urlSOCKS5 = urlSOCKS5 || encodedParams.socks5;
        urlSOCKS5_RELAY = urlSOCKS5_RELAY || encodedParams.socks5_relay;
    }

    const proxyPattern = /^([a-zA-Z0-9][-a-zA-Z0-9.]*(\.[a-zA-Z0-9][-a-zA-Z0-9.]*)+|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[[0-9a-fA-F:]+\]):\d{1,5}$/;
    if (urlPROXYIP) {
        const proxyAddresses = urlPROXYIP.split(',').map(addr => addr.trim());
        const isValid = proxyAddresses.every(addr => proxyPattern.test(addr));
        if (!isValid) {
            console.warn('Invalid proxyip format:', urlPROXYIP);
            urlPROXYIP = null;
        }
    }

    const socks5Pattern = /^(([^:@]+:[^:@]+@)?[a-zA-Z0-9][-a-zA-Z0-9.]*(\.[a-zA-Z0-9][-a-zA-Z0-9.]*)+|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):\d{1,5}$/;
    if (urlSOCKS5) {
        const socks5Addresses = urlSOCKS5.split(',').map(addr => addr.trim());
        const isValid = socks5Addresses.every(addr => socks5Pattern.test(addr));
        if (!isValid) {
            console.warn('Invalid socks5 format:', urlSOCKS5);
            urlSOCKS5 = null;
        }
    }

    config.socks5Address = urlSOCKS5 || config.socks5Address;
    config.socks5Relay = urlSOCKS5_RELAY === 'true' || config.socks5Relay;

    const effectiveProxyIPs = (urlPROXYIP || env.PROXYIP || DEFAULT_PROXY_IPS.join(',')).split(',').map(ip => ip.trim());
    const proxyConfigResult = handleProxyConfig(effectiveProxyIPs);
    config.proxyIP = proxyConfigResult.ip;
    config.proxyPort = proxyConfigResult.port;

    if (config.socks5Address) {
        try {
            const selectedSocks5 = selectRandomAddress(config.socks5Address);
            config.parsedSocks5Address = socks5AddressParser(selectedSocks5);
            config.enableSocks = true;
        } catch (err) {
            console.error('SOCKS5 address parsing error:', err.toString());
            config.enableSocks = false;
        }
    }

    console.log('Final Request Config:', JSON.stringify(config, null, 2));
    return config;
}

export default {
    async fetch(request, env, _ctx) {
        try {
            const url = new URL(request.url);
            const requestConfig = getRequestConfig(request, env);

            const host = request.headers.get('Host');
            const requestedPath = url.pathname.substring(1);

            if (!isValidUUID(requestConfig.userID.split(',')[0])) {
                throw new Error('Initial UUID configuration is not valid');
            }

            const userIDs = requestConfig.userID.split(',').map(id => id.trim());
            let matchingUserID = null;

            for (const id of userIDs) {
                if (requestedPath === id || requestedPath === `sub/${id}` || requestedPath === `bestip/${id}`) {
                    matchingUserID = id;
                    break;
                }
            }

            if (request.headers.get('Upgrade') !== 'websocket') {
                if (url.pathname === '/cf') {
                    return new Response(JSON.stringify(request.cf, null, 4), {
                        status: 200,
                        headers: { "Content-Type": "application/json;charset=utf-8" },
                    });
                }

                if (matchingUserID) {
                    const isSubscription = requestedPath.startsWith('sub/');
                    const isBestIP = requestedPath.startsWith('bestip/');
                    const proxyAddressesForGen = (env.PROXYIP || DEFAULT_PROXY_IPS.join(',')).split(',').map(addr => addr.trim());

                    if (isBestIP) {
                        return fetch(`https://bestip.06151953.xyz/auto?host=${host}&uuid=${matchingUserID}&path=/`, { headers: request.headers });
                    } else {
                        const content = isSubscription ?
                            GenSub(matchingUserID, host, proxyAddressesForGen) :
                            getConfig(matchingUserID, host, proxyAddressesForGen);

                        return new Response(content, {
                            status: 200,
                            headers: {
                                "Content-Type": isSubscription ? "text/plain;charset=utf-8" : "text/html; charset=utf-8"
                            },
                        });
                    }
                }
                // If not a websocket upgrade and no matching path, return 404
                return new Response("Not Found", { status: 404 });
            } else {
                return await ProtocolOverWSHandler(request, requestConfig);
            }
        } catch (err) {
            console.error("Worker fetch error:", err.stack || err);
            return new Response(`Worker error: ${err.message || err}`, { status: 500 });
        }
    },
};
