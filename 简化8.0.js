// <!--GAMFC-->version base on commit 58686d5d125194d34a1137913b3a64ddcf55872f, time is 2024-11-27 09:26:01 UTC<!--GAMFC-END-->.
import { connect } from 'cloudflare:sockets';

// Global configuration
let id = '23e0a1ab-f173-443c-ae26-1e3391a6ed4e';
let proxyIP = '';

/**
 * Handles incoming WebSocket connections by creating a new ConnectionHandler instance for each.
 */
class ConnectionHandler {
	constructor(webSocket, earlyDataHeader) {
		this.webSocket = webSocket;
		this.earlyDataHeader = earlyDataHeader;
		this.remoteSocket = null;
		this.udpStreamWrite = null;
		this.isDns = false;
		this.isClosed = false;
	}

	/**
	 * Initializes the connection, attaches event listeners, and processes any early data.
	 */
	async handle() {
		this.webSocket.accept();
		this.webSocket.addEventListener('message', this.onMessage.bind(this));
		this.webSocket.addEventListener('close', this.onClose.bind(this));
		this.webSocket.addEventListener('error', this.onError.bind(this));

		const { earlyData, error } = base64ToArrayBuffer(this.earlyDataHeader);
		if (error) {
			this.onError(error);
		} else if (earlyData) {
			await this.onMessage({ data: earlyData });
		}
	}

	/**
	 * Handles incoming messages from the WebSocket client.
	 * @param {MessageEvent} event The WebSocket message event.
	 */
	async onMessage(event) {
		if (this.isClosed) return;

		try {
			const chunk = event.data;
			// If a connection is established, forward data.
			if (this.isDns && this.udpStreamWrite) {
				return this.udpStreamWrite(chunk);
			}
			if (this.remoteSocket) {
				const writer = this.remoteSocket.writable.getWriter();
				await writer.write(chunk);
				writer.releaseLock();
				return;
			}
			// Otherwise, it's the first chunk; process the NLESS header.
			await this.processFirstChunk(chunk);
		} catch (e) {
			console.error("Error in onMessage:", e.stack || e);
			this.close();
		}
	}

	/**
	 * Processes the initial data chunk to establish the proxy connection.
	 * @param {ArrayBuffer} chunk The initial data chunk.
	 */
	async processFirstChunk(chunk) {
		const {
			hasError, message, portRemote = 443, addressRemote = '',
			rawDataIndex, nlessVersion = new Uint8Array([0, 0]), isUDP,
		} = processNlessHeader(chunk, id);

		if (hasError) { throw new Error(message); }

		if (isUDP) {
			if (portRemote === 53) {
				this.isDns = true;
			} else {
				throw new Error('UDP proxy only enabled for DNS (port 53)');
			}
		}

		const nlessResponseHeader = new Uint8Array([nlessVersion[0], 0]);
		const rawClientData = chunk.slice(rawDataIndex);

		if (this.isDns) {
			const { write } = await handleUDPOutBound(this.webSocket, nlessResponseHeader);
			this.udpStreamWrite = write;
			this.udpStreamWrite(rawClientData);
		} else {
			await this.handleTCPOutBound(addressRemote, portRemote, rawClientData, nlessResponseHeader);
		}
	}

	/**
	 * Establishes a TCP connection to the destination and pipes data.
	 */
	async handleTCPOutBound(addressRemote, portRemote, rawClientData, nlessResponseHeader) {
		const connectAndWrite = async (address, port) => {
			const tcpSocket = connect({ hostname: address, port: port });
			this.remoteSocket = tcpSocket;
			const writer = tcpSocket.writable.getWriter();
			await writer.write(rawClientData);
			writer.releaseLock();
			return tcpSocket;
		};

		const retry = async () => {
			console.log(`Retrying connection to ${proxyIP || addressRemote}:${portRemote}`);
			const tcpSocket = await connectAndWrite(proxyIP || addressRemote, portRemote);
			this.pipeRemoteSocketToWS(tcpSocket, nlessResponseHeader, null); // Don't retry a retry
		};

		try {
			const tcpSocket = await connectAndWrite(proxyIP || addressRemote, portRemote);
			this.pipeRemoteSocketToWS(tcpSocket, nlessResponseHeader, retry);
		} catch (e) {
			console.error(`Failed to connect to ${proxyIP || addressRemote}:${portRemote}.`, e);
			this.close();
		}
	}

	/**
	 * Pipes data from the remote TCP socket back to the WebSocket client.
	 */
	async pipeRemoteSocketToWS(remoteSocket, nlessResponseHeader, retry) {
		let hasIncomingData = false;
		let nlessHeader = nlessResponseHeader;

		await remoteSocket.readable
			.pipeTo(
				new WritableStream({
					write: (chunk) => {
						hasIncomingData = true;
						if (this.webSocket.readyState !== WS_READY_STATE_OPEN) {
							throw new Error('WebSocket is not open');
						}
						if (nlessHeader) {
							const dataToSend = new Uint8Array(nlessHeader.length + chunk.byteLength);
							dataToSend.set(nlessHeader, 0);
							dataToSend.set(chunk, nlessHeader.length);
							this.webSocket.send(dataToSend);
							nlessHeader = null;
						} else {
							this.webSocket.send(chunk);
						}
					},
					close: () => {
						console.log('Remote socket readable stream closed.');
						this.close();
					},
					abort: (reason) => {
						console.error(`Remote socket readable aborted:`, reason);
					},
				})
			)
			.catch((error) => {
				console.error(`pipeRemoteSocketToWS failed:`, error.stack || error);
				this.close();
			});

		if (hasIncomingData === false && retry) {
			console.log("No incoming data from remote socket, retrying connection...");
			await retry();
		}
	}

	onClose(event) {
		if (this.isClosed) return;
		console.log('WebSocket closed', event.code, event.reason);
		this.close();
	}

	onError(err) {
		if (this.isClosed) return;
		console.error("Connection error:", err.stack || err);
		this.close();
	}

	/**
	 * Closes and cleans up all resources associated with the connection.
	 */
	close() {
		if (this.isClosed) return;
		this.isClosed = true;
		safeCloseWebSocket(this.webSocket);
		if (this.remoteSocket) {
			try {
				this.remoteSocket.close();
			} catch (e) {
				console.error("Error closing remote socket:", e);
			}
		}
	}
}

export default {
	async fetch(request, env, ctx) {
		try {
			id = env.ID || id;
			proxyIP = env.PROXYIP || proxyIP;
			const url = new URL(request.url);
			if (url.pathname.toLowerCase().startsWith('/proxyip=')) {
				proxyIP = url.pathname.substring(9);
			}

			const upgradeHeader = request.headers.get('Upgrade');
			if (upgradeHeader !== 'websocket') {
				switch (url.pathname) {
					case '/':
						return new Response(JSON.stringify(request.cf, null, 2), { 
							status: 200,
							headers: { "Content-Type": "application/json" }
						});
					case `/${id}`: {
						const nlessConfig = getNLESSConfig(id, request.headers.get('Host'));
						return new Response(nlessConfig, {
							status: 200,
							headers: { "Content-Type": "text/plain;charset=utf-8" },
						});
					}
					default:
						return new Response('Not found', { status: 404 });
				}
			} else {
				const [client, server] = Object.values(new WebSocketPair());
				const handler = new ConnectionHandler(server, request.headers.get('sec-websocket-protocol') || '');
				handler.handle();
				return new Response(null, { status: 101, webSocket: client });
			}
		} catch (err) {
			const e = err;
			return new Response(e.stack || e.toString(), { status: 500 });
		}
	},
};


function processNlessHeader(
	nlessBuffer,
	id
) {
	if (nlessBuffer.byteLength < 24) {
		return { hasError: true, message: 'invalid data' };
	}
	const version = new Uint8Array(nlessBuffer.slice(0, 1));
	let isValidUser = false;
	if (stringify(new Uint8Array(nlessBuffer.slice(1, 17))) === id) {
		isValidUser = true;
	}
	if (!isValidUser) {
		return { hasError: true, message: 'invalid user' };
	}

	const optLength = new Uint8Array(nlessBuffer.slice(17, 18))[0];
	const command = new Uint8Array(
		nlessBuffer.slice(18 + optLength, 18 + optLength + 1)
	)[0];

	if (command !== 1 && command !== 2) { // 1: TCP, 2: UDP
		return { hasError: true, message: `command ${command} is not supported` };
	}

	const portIndex = 18 + optLength + 1;
	const portRemote = new DataView(nlessBuffer.slice(portIndex, portIndex + 2)).getUint16(0);

	let addressIndex = portIndex + 2;
	const addressType = new Uint8Array(nlessBuffer.slice(addressIndex, addressIndex + 1))[0];
	let addressLength = 0;
	let addressValueIndex = addressIndex + 1;
	let addressValue = '';

	switch (addressType) {
		case 1: // IPv4
			addressLength = 4;
			addressValue = new Uint8Array(
				nlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
			).join('.');
			break;
		case 2: // Domain
			addressLength = new Uint8Array(
				nlessBuffer.slice(addressValueIndex, addressValueIndex + 1)
			)[0];
			addressValueIndex += 1;
			addressValue = new TextDecoder().decode(
				nlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
			);
			break;
		case 3: // IPv6
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
			return { hasError: true, message: `invalid addressType is ${addressType}` };
	}

	if (!addressValue) {
		return { hasError: true, message: `addressValue is empty for addressType ${addressType}` };
	}

	return {
		hasError: false,
		addressRemote: addressValue,
		portRemote,
		rawDataIndex: addressValueIndex + addressLength,
		nlessVersion: version,
		isUDP: command === 2,
	};
}


async function handleUDPOutBound(webSocket, nlessResponseHeader) {
	let isNlessHeaderSent = false;
	const transformStream = new TransformStream({
		transform(chunk, controller) {
			for (let index = 0; index < chunk.byteLength;) {
				const lengthBuffer = chunk.slice(index, index + 2);
				const udpPakcetLength = new DataView(lengthBuffer).getUint16(0);
				const udpData = new Uint8Array(
					chunk.slice(index + 2, index + 2 + udpPakcetLength)
				);
				index = index + 2 + udpPakcetLength;
				controller.enqueue(udpData);
			}
		},
	});

	transformStream.readable.pipeTo(new WritableStream({
		async write(chunk) {
			const resp = await fetch('https://1.1.1.1/dns-query', {
				method: 'POST',
				headers: { 'content-type': 'application/dns-message' },
				body: chunk,
			});
			const dnsQueryResult = await resp.arrayBuffer();
			const udpSize = dnsQueryResult.byteLength;
			const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);
			if (webSocket.readyState === WS_READY_STATE_OPEN) {
				const dnsQueryUint8 = new Uint8Array(dnsQueryResult);
				if (isNlessHeaderSent) {
					const dataToSend = new Uint8Array(udpSizeBuffer.length + dnsQueryUint8.length);
					dataToSend.set(udpSizeBuffer, 0);
					dataToSend.set(dnsQueryUint8, udpSizeBuffer.length);
					webSocket.send(dataToSend);
				} else {
					const dataToSend = new Uint8Array(nlessResponseHeader.length + udpSizeBuffer.length + dnsQueryUint8.length);
					dataToSend.set(nlessResponseHeader, 0);
					dataToSend.set(udpSizeBuffer, nlessResponseHeader.length);
					dataToSend.set(dnsQueryUint8, nlessResponseHeader.length + udpSizeBuffer.length);
					webSocket.send(dataToSend);
					isNlessHeaderSent = true;
				}
			}
		}
	})).catch(console.error);

	const writer = transformStream.writable.getWriter();
	return {
		write(chunk) {
			writer.write(chunk).catch(console.error);
		}
	};
}


function base64ToArrayBuffer(base64Str) {
	if (!base64Str) {
		return { earlyData: null, error: null };
	}
	try {
		base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/');
		const decode = atob(base64Str);
		const arryBuffer = Uint8Array.from(decode, (c) => c.charCodeAt(0));
		return { earlyData: arryBuffer.buffer, error: null };
	} catch (error) {
		return { earlyData: null, error };
	}
}

const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;
function safeCloseWebSocket(socket) {
	try {
		if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
			socket.close();
		}
	} catch (error) {
		console.error('safeCloseWebSocket error', error);
	}
}

const byteToHex = [];
for (let i = 0; i < 256; ++i) {
	byteToHex.push((i + 256).toString(16).slice(1));
}

function stringify(arr, offset = 0) {
	return (
		byteToHex[arr[offset + 0]] + byteToHex[arr[offset + 1]] +
		byteToHex[arr[offset + 2]] + byteToHex[arr[offset + 3]] + "-" +
		byteToHex[arr[offset + 4]] + byteToHex[arr[offset + 5]] + "-" +
		byteToHex[arr[offset + 6]] + byteToHex[arr[offset + 7]] + "-" +
		byteToHex[arr[offset + 8]] + byteToHex[arr[offset + 9]] + "-" +
		byteToHex[arr[offset + 10]] + byteToHex[arr[offset + 11]] +
		byteToHex[arr[offset + 12]] + byteToHex[arr[offset + 13]] +
		byteToHex[arr[offset + 14]] + byteToHex[arr[offset + 15]]
	).toLowerCase();
}

function getNLESSConfig(id, hostName) {
	return `nless://${id}@${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2048#${hostName}`;
}