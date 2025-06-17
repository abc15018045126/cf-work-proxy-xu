// server.js

// Node.js built-in modules
const http = require('http');
const net = require('net');
const {
    createHash
} = require('crypto');

// External dependency for WebSocket handling
const {
    WebSocketServer,
    WebSocket
} = require('ws');

// --- Configuration ---
// How to generate your own UUID:
// In Node.js: require('crypto').randomUUID()
let userID = process.env.UUID || '23e0a1ab-f173-443c-ae26-1e3391a6ed4e';

const proxyIPs = ['time.cloudflare.com', 'cdn-all.xn--b6gac.eu.org', 'cdn.xn--b6gac.eu.org', 'cdn-b100.xn--b6gac.eu.org', 'edgetunnel.anycast.eu.org', 'cdn.anycast.eu.org'];
let proxyIP = process.env.PROXYIP || proxyIPs[Math.floor(Math.random() * proxyIPs.length)];

const port = process.env.PORT || 443;

if (!isValidUUID(userID)) {
    throw new Error('UUID is not valid');
}

// --- HTTP Server Setup ---
const server = http.createServer((req, res) => {
    // This handles non-WebSocket requests
    const url = new URL(req.url, `http://${req.headers.host}`);
    switch (url.pathname) {
        case '/':
            // Simple health check or info endpoint
            res.writeHead(200, {
                'Content-Type': 'application/json'
            });
            res.end(JSON.stringify({
                status: 'ok',
                message: 'VLESS server is running.'
            }));
            break;
        case `/${userID}`:
            {
                const vlessConfig = getVLESSConfig(userID, req.headers.host);
                res.writeHead(200, {
                    'Content-Type': 'text/plain;charset=utf-8'
                });
                res.end(vlessConfig);
                break;
            }
        default:
            res.writeHead(404);
            res.end('Not found');
    }
});

// --- WebSocket Server Setup ---
const wss = new WebSocketServer({
    server
});

wss.on('connection', (ws, req) => {
    // This is the equivalent of the vlessOverWSHandler function
    console.log('WebSocket connection established.');

    let address = '';
    let portWithRandomLog = '';
    const log = (info, event) => {
        console.log(`[${address}:${portWithRandomLog}] ${info}`, event || '');
    };

    let remoteSocket = null;
    let isDns = false;
    let udpStreamWrite = null;

    let earlyData = [];
    const earlyDataHeader = req.headers['sec-websocket-protocol'] || '';
    if (earlyDataHeader) {
        const {
            earlyData: data,
            error
        } = base64ToArrayBuffer(earlyDataHeader);
        if (data) {
            earlyData.push(data);
        }
    }


    ws.on('message', async (data) => {
        if (isDns && udpStreamWrite) {
            return udpStreamWrite(data);
        }

        if (remoteSocket) {
            remoteSocket.write(data);
            return;
        }

        // Combine early data (if any) with the first message
        const chunk = earlyData.length > 0 ? Buffer.concat([earlyData.pop(), data]) : data;

        const {
            hasError,
            message,
            portRemote = 443,
            addressRemote = '',
            rawDataIndex,
            vlessVersion = new Uint8Array([0, 0]),
            isUDP,
        } = processVlessHeader(chunk, userID);

        address = addressRemote;
        portWithRandomLog = `${portRemote}--${Math.random()} ${isUDP ? 'udp ' : 'tcp '}`;

        if (hasError) {
            log(`Error processing VLESS header: ${message}`);
            ws.close(1000, message);
            return;
        }

        // if UDP but port not DNS port, close it
        if (isUDP) {
            if (portRemote === 53) {
                isDns = true;
            } else {
                const errorMsg = 'UDP proxy only enabled for DNS port 53';
                log(errorMsg);
                ws.close(1000, errorMsg);
                return;
            }
        }

        const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
        const rawClientData = chunk.slice(rawDataIndex);

        if (isDns) {
            const {
                write
            } = await handleUDPOutBound(ws, vlessResponseHeader, log);
            udpStreamWrite = write;
            udpStreamWrite(rawClientData);
            return;
        }

        // Establish TCP connection to the remote host
        remoteSocket = net.createConnection({
            host: addressRemote,
            port: portRemote
        }, () => {
            log(`Connected to ${addressRemote}:${portRemote}`);

            // Send VLESS response header and initial data to client
            ws.send(Buffer.concat([vlessResponseHeader, rawClientData]));

            // Pipe data between client and remote
            remoteSocket.on('data', (remoteData) => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(remoteData);
                }
            });

            // ws 'message' event will now write directly to remoteSocket
        });

        remoteSocket.on('error', (err) => {
            log('Remote socket error:', err.message);
            ws.close(1011, 'Remote connection error');
        });

        remoteSocket.on('close', () => {
            log('Remote socket closed.');
            ws.close();
        });
    });

    ws.on('close', () => {
        log('WebSocket connection closed.');
        if (remoteSocket) {
            remoteSocket.end();
        }
    });

    ws.on('error', (err) => {
        log('WebSocket error:', err.message);
        if (remoteSocket) {
            remoteSocket.destroy();
        }
    });
});

// --- Start Server ---
server.listen(port, () => {
    console.log(`Server is listening on port ${port}`);
    console.log(`Your UUID is: ${userID}`);
});


// --- Helper Functions (Ported from Worker) ---

/**
 * Parses the VLESS header from the initial data chunk.
 * @param {Buffer} vlessBuffer
 * @param {string} userID
 */
function processVlessHeader(vlessBuffer, userID) {
    if (vlessBuffer.byteLength < 24) {
        return {
            hasError: true,
            message: 'invalid data'
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
            message: 'invalid user'
        };
    }

    const optLength = new Uint8Array(vlessBuffer.slice(17, 18))[0];
    const command = new Uint8Array(vlessBuffer.slice(18 + optLength, 18 + optLength + 1))[0];

    if (command === 1) { // TCP
    } else if (command === 2) { // UDP
        isUDP = true;
    } else {
        return {
            hasError: true,
            message: `command ${command} is not supported`
        };
    }

    const portIndex = 18 + optLength + 1;
    const portRemote = vlessBuffer.readUInt16BE(portIndex);

    let addressIndex = portIndex + 2;
    const addressType = vlessBuffer[addressIndex];

    let addressLength = 0;
    let addressValueIndex = addressIndex + 1;
    let addressValue = '';

    switch (addressType) {
        case 1: // IPv4
            addressLength = 4;
            addressValue = vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength).join('.');
            break;
        case 2: // Domain
            addressLength = vlessBuffer[addressValueIndex];
            addressValueIndex += 1;
            addressValue = new TextDecoder().decode(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
            break;
        case 3: // IPv6
            addressLength = 16;
            const ipv6 = [];
            for (let i = 0; i < 8; i++) {
                ipv6.push(vlessBuffer.readUInt16BE(addressValueIndex + i * 2).toString(16));
            }
            addressValue = ipv6.join(':');
            break;
        default:
            return {
                hasError: true,
                message: `invalid addressType: ${addressType}`
            };
    }

    if (!addressValue) {
        return {
            hasError: true,
            message: `addressValue is empty, addressType: ${addressType}`
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


/**
 * @param {string} base64Str
 * @returns {{earlyData: Buffer | null, error: Error | null}}
 */
function base64ToArrayBuffer(base64Str) {
    if (!base64Str) {
        return {
            error: null,
            earlyData: null
        };
    }
    try {
        base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/');
        const buffer = Buffer.from(base64Str, 'base64');
        return {
            earlyData: buffer,
            error: null
        };
    } catch (error) {
        return {
            error,
            earlyData: null
        };
    }
}


/**
 * @param {string} uuid
 */
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


/**
 * @param {WebSocket} webSocket
 * @param {ArrayBuffer} vlessResponseHeader
 * @param {(string, any) => void} log
 */
async function handleUDPOutBound(webSocket, vlessResponseHeader, log) {
    let isVlessHeaderSent = false;

    // This function will be returned to be called with incoming UDP data
    const write = async (chunk) => {
        // The chunk contains UDP packets prefixed with their length
        for (let index = 0; index < chunk.byteLength;) {
            const lengthBuffer = chunk.slice(index, index + 2);
            const udpPacketLength = new DataView(lengthBuffer.buffer, lengthBuffer.byteOffset).getUint16(0);
            const udpData = new Uint8Array(
                chunk.slice(index + 2, index + 2 + udpPacketLength)
            );
            index = index + 2 + udpPacketLength;

            // Forward to DNS-over-HTTPS
            try {
                const resp = await fetch('https://1.1.1.1/dns-query', {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/dns-message',
                    },
                    body: udpData,
                });
                const dnsQueryResult = await resp.arrayBuffer();
                const udpSize = dnsQueryResult.byteLength;
                const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);

                if (webSocket.readyState === WebSocket.OPEN) {
                    log(`DoH success, DNS message length is ${udpSize}`);
                    const dataToSend = [udpSizeBuffer, dnsQueryResult];
                    if (!isVlessHeaderSent) {
                        dataToSend.unshift(vlessResponseHeader);
                        isVlessHeaderSent = true;
                    }
                    webSocket.send(await new Blob(dataToSend).arrayBuffer());
                }
            } catch (error) {
                log('DNS UDP request failed: ' + error);
            }
        }
    };

    return {
        write
    };
}


/**
 * @param {string} userID
 * @param {string | null} hostName
 * @returns {string}
 */
function getVLESSConfig(userID, hostName) {
    const vlessMain = `vless://${userID}@${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2048#${hostName}`;
    return `
################################################################
v2ray
---------------------------------------------------------------
${vlessMain}
---------------------------------------------------------------
################################################################
clash-meta
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
