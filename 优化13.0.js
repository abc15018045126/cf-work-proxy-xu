const userID = '23e0a1ab-f173-443c-ae26-1e3391a6ed4e';
const proxyIP = '';
const userIDValidationLevel = null;

import { connect } from 'cloudflare:sockets';

const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;

const byteToHex = [];
for (let i = 0; i < 256; ++i) {
	byteToHex.push((i + 256).toString(16).slice(1));
}

export default {
	async fetch(request, env, ctx) {
		try {
			const id = env.ID || userID;
			let currentProxyIP = env.PROXYIP || proxyIP;
			const idyesEnv = env.IDYES;
			const idyes = idyesEnv !== undefined ? (parseInt(idyesEnv, 10) || null) : userIDValidationLevel;

			const url = new URL(request.url);
			if (url.pathname.toLowerCase().startsWith('/proxyip=')) {
				currentProxyIP = url.pathname.substring(9);
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
			}

			const [client, server] = Object.values(new WebSocketPair());
			const handler = new ConnectionHandler(server, request.headers.get('sec-websocket-protocol') || '', id, currentProxyIP, idyes);
			handler.handle();
			return new Response(null, { status: 101, webSocket: client });

		} catch (err) {
			return new Response('Internal Server Error', { status: 500 });
		}
	},
};

class ConnectionHandler {
	constructor(webSocket, earlyDataHeader, id, proxyIP, idyes) {
		this.webSocket = webSocket;
		this.earlyDataHeader = earlyDataHeader;
		this.id = id;
		this.proxyIP = proxyIP;
		this.idyes = idyes;
		this.remoteSocket = null;
		this.udpStreamWrite = null;
		this.isDns = false;
		this.isClosed = false;
	}

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

	async onMessage(event) {
		if (this.isClosed) return;
		try {
			const chunk = event.data;
			if (this.isDns && this.udpStreamWrite) {
				return this.udpStreamWrite(chunk);
			}
			if (this.remoteSocket) {
				const writer = this.remoteSocket.writable.getWriter();
				await writer.write(chunk);
				writer.releaseLock();
				return;
			}
			await this.processFirstChunk(chunk);
		} catch (e) {
			this.close();
		}
	}

	async processFirstChunk(chunk) {
		const {
			hasError, message, portRemote = 443, addressRemote = '',
			rawDataIndex, nlessVersion = new Uint8Array([0, 0]), isUDP,
		} = processNlessHeader(chunk, this.id, this.idyes);

		if (hasError) { throw new Error(message); }

		if (isUDP) {
			if (portRemote === 53) { this.isDns = true; }
			else { throw new Error('UDP proxy only enabled for DNS (port 53)'); }
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

	async handleTCPOutBound(addressRemote, portRemote, rawClientData, nlessResponseHeader) {
		const connectAndWrite = async (address, port) => {
			const tcpSocket = connect({ hostname: address, port });
			this.remoteSocket = tcpSocket;
			const writer = tcpSocket.writable.getWriter();
			await writer.write(rawClientData);
			writer.releaseLock();
			return tcpSocket;
		};

		const retry = async () => {
			const tcpSocket = await connectAndWrite(this.proxyIP || addressRemote, portRemote);
			this.pipeRemoteSocketToWS(tcpSocket, nlessResponseHeader, null);
		};

		try {
			const tcpSocket = await connectAndWrite(this.proxyIP || addressRemote, portRemote);
			this.pipeRemoteSocketToWS(tcpSocket, nlessResponseHeader, retry);
		} catch (e) {
			this.close();
		}
	}

	async pipeRemoteSocketToWS(remoteSocket, nlessResponseHeader, retry) {
		let hasIncomingData = false;
		let nlessHeader = nlessResponseHeader;

		await remoteSocket.readable.pipeTo(
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
				close: () => { this.close(); },
				abort: () => { },
			})
		).catch(() => { this.close(); });

		if (hasIncomingData === false && retry) {
			await retry();
		}
	}

	onClose() { if (!this.isClosed) this.close(); }
	onError() { if (!this.isClosed) this.close(); }

	close() {
		if (this.isClosed) return;
		this.isClosed = true;
		safeCloseWebSocket(this.webSocket);
		if (this.remoteSocket) {
			try { this.remoteSocket.close(); }
			catch (e) { }
		}
	}
}

function processNlessHeader(nlessBuffer, id, idyes) {
	if (nlessBuffer.byteLength < 24) {
		return { hasError: true, message: 'invalid data: header too short' };
	}
	const version = new Uint8Array(nlessBuffer.slice(0, 1));

	if (idyes !== 0) {
		const receivedId = stringify(new Uint8Array(nlessBuffer.slice(1, 17)));
		let isValidUser = false;
		if (idyes > 0) {
			isValidUser = receivedId.substring(0, idyes) === id.substring(0, idyes);
		} else {
			isValidUser = receivedId === id;
		}
		if (!isValidUser) {
			return { hasError: true, message: 'invalid user' };
		}
	}

	const optLength = new Uint8Array(nlessBuffer.slice(17, 18))[0];
	const commandIndex = 18 + optLength;
	const command = new Uint8Array(nlessBuffer.slice(commandIndex, commandIndex + 1))[0];

	if (command !== 1 && command !== 2) {
		return { hasError: true, message: `command ${command} is not supported` };
	}

	const portIndex = commandIndex + 1;
	const portRemote = new DataView(nlessBuffer.slice(portIndex, portIndex + 2)).getUint16(0);

	let addressIndex = portIndex + 2;
	const addressType = new Uint8Array(nlessBuffer.slice(addressIndex, addressIndex + 1))[0];
	let addressLength = 0;
	let addressValueIndex = addressIndex + 1;
	let addressValue = '';

	switch (addressType) {
		case 1:
			addressLength = 4;
			addressValue = new Uint8Array(nlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join('.');
			break;
		case 2:
			addressLength = new Uint8Array(nlessBuffer.slice(addressValueIndex, addressValueIndex + 1))[0];
			addressValueIndex += 1;
			addressValue = new TextDecoder().decode(nlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
			break;
		case 3:
			addressLength = 16;
			const dataView = new DataView(nlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
			const ipv6 = [];
			for (let i = 0; i < 8; i++) {
				ipv6.push(dataView.getUint16(i * 2).toString(16));
			}
			addressValue = ipv6.join(':');
			break;
		default:
			return { hasError: true, message: `invalid addressType: ${addressType}` };
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
				const udpData = new Uint8Array(chunk.slice(index + 2, index + 2 + udpPakcetLength));
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
				let dataToSend;
				if (isNlessHeaderSent) {
					dataToSend = new Uint8Array(udpSizeBuffer.length + dnsQueryUint8.length);
					dataToSend.set(udpSizeBuffer, 0);
					dataToSend.set(dnsQueryUint8, udpSizeBuffer.length);
				} else {
					dataToSend = new Uint8Array(nlessResponseHeader.length + udpSizeBuffer.length + dnsQueryUint8.length);
					dataToSend.set(nlessResponseHeader, 0);
					dataToSend.set(udpSizeBuffer, nlessResponseHeader.length);
					dataToSend.set(dnsQueryUint8, nlessResponseHeader.length + udpSizeBuffer.length);
					isNlessHeaderSent = true;
				}
				webSocket.send(dataToSend);
			}
		}
	})).catch(() => { });

	const writer = transformStream.writable.getWriter();
	return {
		write(chunk) {
			writer.write(chunk).catch(() => { });
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

function safeCloseWebSocket(socket) {
	try {
		if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
			socket.close();
		}
	} catch (error) {
	}
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