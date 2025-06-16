import { connect } from 'cloudflare:sockets';

let userID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';

const proxyIPs = ['cdn.xn--b6gac.eu.org:443', 'cdn-all.xn--b6gac.eu.org:443'];

let proxyIP = proxyIPs[Math.floor(Math.random() * proxyIPs.length)];
let proxyPort = proxyIP.includes(':') ? proxyIP.split(':')[1] : '443';

let socks5Address = '';

let socks5Relay = false;

if (!isValidUUID(userID)) {
    throw new Error('uuid is not valid');
}

let parsedSocks5Address = {};
let enableSocks = false;

export default {
    async fetch(request, env, _ctx) {
        try {
            const { UUID, PROXYIP, SOCKS5, SOCKS5_RELAY } = env;
            const url = new URL(request.url);

            const requestConfig = {
                userID: UUID || userID,
                socks5Address: SOCKS5 || socks5Address,
                socks5Relay: SOCKS5_RELAY === 'true' || socks5Relay,
                proxyIP: null,
                proxyPort: null,
                enableSocks: false,
                parsedSocks5Address: {}
            };

            let urlPROXYIP = url.searchParams.get('proxyip');
            let urlSOCKS5 = url.searchParams.get('socks5');
            let urlSOCKS5_RELAY = url.searchParams.get('socks5_relay');

            if (!urlPROXYIP && !urlSOCKS5 && !urlSOCKS5_RELAY) {
                const encodedParams = parseEncodedQueryParams(url.pathname);
                urlPROXYIP = urlPROXYIP || encodedParams.proxyip;
                urlSOCKS5 = urlSOCKS5 || encodedParams.socks5;
                urlSOCKS5_RELAY = urlSOCKS5_RELAY || encodedParams.socks5_relay;
            }

            if (urlPROXYIP) {
                const proxyPattern = /^([a-zA-Z0-9][-a-zA-Z0-9.]*(\.[a-zA-Z0-9][-a-zA-Z0-9.]*)+|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[[0-9a-fA-F:]+\]):\d{1,5}$/;
                const proxyAddresses = urlPROXYIP.split(',').map(addr => addr.trim());
                const isValid = proxyAddresses.every(addr => proxyPattern.test(addr));
                if (!isValid) {
                    console.warn('无效的proxyip格式:', urlPROXYIP);
                    urlPROXYIP = null;
                }
            }

            if (urlSOCKS5) {
                const socks5Pattern = /^(([^:@]+:[^:@]+@)?[a-zA-Z0-9][-a-zA-Z0-9.]*(\.[a-zA-Z0-9][-a-zA-Z0-9.]*)+|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):\d{1,5}$/;
                const socks5Addresses = urlSOCKS5.split(',').map(addr => addr.trim());
                const isValid = socks5Addresses.every(addr => socks5Pattern.test(addr));
                if (!isValid) {
                    console.warn('无效的socks5格式:', urlSOCKS5);
                    urlSOCKS5 = null;
                }
            }

            requestConfig.socks5Address = urlSOCKS5 || requestConfig.socks5Address;
            requestConfig.socks5Relay = urlSOCKS5_RELAY === 'true' || requestConfig.socks5Relay;

            console.log('配置参数:', requestConfig.userID, requestConfig.socks5Address, requestConfig.socks5Relay, urlPROXYIP);

            const proxyConfig = handleProxyConfig(urlPROXYIP || PROXYIP);
            requestConfig.proxyIP = proxyConfig.ip;
            requestConfig.proxyPort = proxyConfig.port;

            console.log('使用代理:', requestConfig.proxyIP, requestConfig.proxyPort);

            if (requestConfig.socks5Address) {
                try {
                    const selectedSocks5 = selectRandomAddress(requestConfig.socks5Address);
                    requestConfig.parsedSocks5Address = socks5AddressParser(selectedSocks5);
                    requestConfig.enableSocks = true;
                } catch (err) {
                    console.log(err.toString());
                    requestConfig.enableSocks = false;
                }
            }

            const userIDs = requestConfig.userID.includes(',') ? requestConfig.userID.split(',').map(id => id.trim()) : [requestConfig.userID];
            const host = request.headers.get('Host');
            const requestedPath = url.pathname.substring(1);
            const matchingUserID = userIDs.length === 1 ?
                (requestedPath === userIDs[0] ||
                 requestedPath === `sub/${userIDs[0]}` ||
                 requestedPath === `bestip/${userIDs[0]}` ? userIDs[0] : null) :
                userIDs.find(id => {
                    const patterns = [id, `sub/${id}`, `bestip/${id}`];
                    return patterns.some(pattern => requestedPath.startsWith(pattern));
                });

            if (request.headers.get('Upgrade') !== 'websocket') {
                if (url.pathname === '/cf') {
                    return new Response(JSON.stringify(request.cf, null, 4), {
                        status: 200,
                        headers: { "Content-Type": "application/json;charset=utf-8" },
                    });
                }

                if (matchingUserID) {
                    if (url.pathname === `/${matchingUserID}` || url.pathname === `/sub/${matchingUserID}`) {
                        const isSubscription = url.pathname.startsWith('/sub/');
                        const proxyAddresses = PROXYIP ? PROXYIP.split(',').map(addr => addr.trim()) : requestConfig.proxyIP;
                        const content = isSubscription ?
                            GenSub(matchingUserID, host, proxyAddresses) :
                            getConfig(matchingUserID, host, proxyAddresses);

                        return new Response(content, {
                            status: 200,
                            headers: {
                                "Content-Type": isSubscription ?
                                    "text/plain;charset=utf-8" :
                                    "text/html; charset=utf-8"
                            },
                        });
                    } else if (url.pathname === `/bestip/${matchingUserID}`) {
                        return fetch(`https://bestip.06151953.xyz/auto?host=${host}&uuid=${matchingUserID}&path=/`, { headers: request.headers });
                    }
                }
                return handleDefaultPath(url, request);
            } else {
                return await ProtocolOverWSHandler(request, requestConfig);
            }
        } catch (err) {
            return new Response(err.toString());
        }
    },
};

async function handleDefaultPath(url, request) {
    const host = request.headers.get('Host');
    const DrivePage = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>${host} - Cloud Drive</title>
          <style>
              body {
                  font-family: Arial, sans-serif;
                  line-height: 1.6;
                  margin: 0;
                  padding: 20px;
                  background-color: #f4f4f4;
              }
              .container {
                  max-width: 800px;
                  margin: auto;
                  background: white;
                  padding: 20px;
                  border-radius: 5px;
                  box-shadow: 0 0 10px rgba(0,0,0,0.1);
              }
              h1 {
                  color: #333;
              }
              .file-list {
                  list-style-type: none;
                  padding: 0;
              }
              .file-list li {
                  background: #f9f9f9;
                  margin-bottom: 10px;
                  padding: 10px;
                  border-radius: 3px;
                  display: flex;
                  align-items: center;
              }
              .file-list li:hover {
                  background: #f0f0f0;
              }
              .file-icon {
                  margin-right: 10px;
                  font-size: 1.2em;
              }
              .file-link {
                  text-decoration: none;
                  color: #0066cc;
                  flex-grow: 1;
              }
              .file-link:hover {
                  text-decoration: underline;
              }
              .upload-area {
                  margin-top: 20px;
                  padding: 40px;
                  background: #e9e9e9;
                  border: 2px dashed #aaa;
                  border-radius: 5px;
                  text-align: center;
                  cursor: pointer;
                  transition: all 0.3s ease;
              }
              .upload-area:hover, .upload-area.drag-over {
                  background: #d9d9d9;
                  border-color: #666;
              }
              .upload-area h2 {
                  margin-top: 0;
                  color: #333;
              }
              #fileInput {
                  display: none;
              }
              .upload-icon {
                  font-size: 48px;
                  color: #666;
                  margin-bottom: 10px;
              }
              .upload-text {
                  font-size: 18px;
                  color: #666;
              }
              .upload-status {
                  margin-top: 20px;
                  font-style: italic;
                  color: #666;
              }
              .file-actions {
                  display: flex;
                  gap: 10px;
              }
              .delete-btn {
                  color: #ff4444;
                  cursor: pointer;
                  background: none;
                  border: none;
                  padding: 5px;
              }
              .delete-btn:hover {
                  color: #ff0000;
              }
              .clear-all-btn {
                  background-color: #ff4444;
                  color: white;
                  border: none;
                  padding: 10px 15px;
                  border-radius: 4px;
                  cursor: pointer;
                  margin-bottom: 20px;
              }
              .clear-all-btn:hover {
                  background-color: #ff0000;
              }
          </style>
      </head>
      <body>
          <div class="container">
              <h1>Cloud Drive</h1>
              <p>Welcome to your personal cloud storage. Here are your uploaded files:</p>
              <button id="clearAllBtn" class="clear-all-btn">Clear All Files</button>
              <ul id="fileList" class="file-list">
              </ul>
              <div id="uploadArea" class="upload-area">
                  <div class="upload-icon">📁</div>
                  <h2>Upload a File</h2>
                  <p class="upload-text">Drag and drop a file here or click to select</p>
                  <input type="file" id="fileInput" hidden>
              </div>
              <div id="uploadStatus" class="upload-status"></div>
          </div>
          <script>
              function loadFileList() {
                  const fileList = document.getElementById('fileList');
                  const savedFiles = JSON.parse(localStorage.getItem('uploadedFiles')) || [];
                  fileList.innerHTML = '';
                  savedFiles.forEach((file, index) => {
                      const li = document.createElement('li');
                      li.innerHTML = \`
                          <span class="file-icon">📄</span>
                          <a href="https://ipfs.io/ipfs/\${file.Url.split('/').pop()}" class="file-link" target="_blank">\${file.Name}</a>
                          <div class="file-actions">
                              <button class="delete-btn" onclick="deleteFile(\${index})">
                                  <span class="file-icon">❌</span>
                              </button>
                          </div>
                      \`;
                      fileList.appendChild(li);
                  });
              }

              function deleteFile(index) {
                  const savedFiles = JSON.parse(localStorage.getItem('uploadedFiles')) || [];
                  savedFiles.splice(index, 1);
                  localStorage.setItem('uploadedFiles', JSON.stringify(savedFiles));
                  loadFileList();
              }

              document.getElementById('clearAllBtn').addEventListener('click', () => {
                  if (confirm('Are you sure you want to clear all files?')) {
                      localStorage.removeItem('uploadedFiles');
                      loadFileList();
                  }
              });

              loadFileList();

              const uploadArea = document.getElementById('uploadArea');
              const fileInput = document.getElementById('fileInput');
              const uploadStatus = document.getElementById('uploadStatus');

              uploadArea.addEventListener('dragover', (e) => {
                  e.preventDefault();
                  uploadArea.classList.add('drag-over');
              });

              uploadArea.addEventListener('dragleave', () => {
                  uploadArea.classList.remove('drag-over');
              });

              uploadArea.addEventListener('drop', (e) => {
                  e.preventDefault();
                  uploadArea.classList.remove('drag-over');
                  const files = e.dataTransfer.files;
                  if (files.length) {
                      handleFileUpload(files[0]);
                  }
              });

              uploadArea.addEventListener('click', () => {
                  fileInput.click();
              });

              fileInput.addEventListener('change', (e) => {
                  const file = e.target.files[0];
                  if (file) {
                      handleFileUpload(file);
                  }
              });

              async function handleFileUpload(file) {
                  uploadStatus.textContent = \`Uploading: \${file.name}...\`;

                  const formData = new FormData();
                  formData.append('file', file);

                  try {
                      const response = await fetch('https://app.img2ipfs.org/api/v0/add', {
                          method: 'POST',
                          body: formData,
                          headers: {
                              'Accept': 'application/json',
                          },
                      });

                      if (!response.ok) {
                          throw new Error('Upload failed');
                      }

                      const result = await response.json();
                      uploadStatus.textContent = \`File uploaded successfully! IPFS Hash: \${result.Hash}\`;

                      const savedFiles = JSON.parse(localStorage.getItem('uploadedFiles')) || [];
                      savedFiles.push(result);
                      localStorage.setItem('uploadedFiles', JSON.stringify(savedFiles));

                      loadFileList();

                  } catch (error) {
                      console.error('Error:', error);
                      uploadStatus.textContent = 'Upload failed. Please try again.';
                  }
              }
          </script>
      </body>
      </html>
    `;

    return new Response(DrivePage, {
        headers: {
            "content-type": "text/html;charset=UTF-8",
        },
    });
}

async function ProtocolOverWSHandler(request, config = null) {
    if (!config) {
        config = {
            userID,
            socks5Address,
            socks5Relay,
            proxyIP,
            proxyPort,
            enableSocks,
            parsedSocks5Address
        };
    }

    const webSocketPair = new WebSocketPair();
    const [client, webSocket] = Object.values(webSocketPair);

    webSocket.accept();

    let address = '';
    let portWithRandomLog = '';
    const log = (info, event) => {
        console.log(`[${address}:${portWithRandomLog}] ${info}`, event || '');
    };
    const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';

    const readableWebSocketStream = MakeReadableWebSocketStream(webSocket, earlyDataHeader, log);

    let remoteSocketWapper = {
        value: null,
    };
    let isDns = false;

    readableWebSocketStream.pipeTo(new WritableStream({
        async write(chunk, controller) {
            if (isDns) {
                return await handleDNSQuery(chunk, webSocket, null, log);
            }
            if (remoteSocketWapper.value) {
                const writer = remoteSocketWapper.value.writable.getWriter()
                await writer.write(chunk);
                writer.releaseLock();
                return;
            }

            const {
                hasError,
                message,
                addressType,
                portRemote = 443,
                addressRemote = '',
                rawDataIndex,
                ProtocolVersion = new Uint8Array([0, 0]),
                isUDP,
            } = ProcessProtocolHeader(chunk, config.userID);
            address = addressRemote;
            portWithRandomLog = `${portRemote}--${Math.random()} ${isUDP ? 'udp ' : 'tcp '
                } `;
            if (hasError) {
                throw new Error(message);
            }
            if (isUDP) {
                if (portRemote === 53) {
                    isDns = true;
                } else {
                    throw new Error('UDP proxy is only enabled for DNS (port 53)');
                }
                return;
            }
            const ProtocolResponseHeader = new Uint8Array([ProtocolVersion[0], 0]);
            const rawClientData = chunk.slice(rawDataIndex);

            if (isDns) {
                return handleDNSQuery(rawClientData, webSocket, ProtocolResponseHeader, log);
            }
            HandleTCPOutBound(remoteSocketWapper, addressType, addressRemote, portRemote, rawClientData, webSocket, ProtocolResponseHeader, log, config);
        },
        close() {
            log(`readableWebSocketStream is close`);
        },
        abort(reason) {
            log(`readableWebSocketStream is abort`, JSON.stringify(reason));
        },
    })).catch((err) => {
        log('readableWebSocketStream pipeTo error', err);
    });

    return new Response(null, {
        status: 101,
        webSocket: client,
    });
}

async function HandleTCPOutBound(remoteSocket, addressType, addressRemote, portRemote, rawClientData, webSocket, protocolResponseHeader, log, config = null) {
    if (!config) {
        config = {
            userID,
            socks5Address,
            socks5Relay,
            proxyIP,
            proxyPort,
            enableSocks,
            parsedSocks5Address
        };
    }

    async function connectAndWrite(address, port, socks = false) {
        let tcpSocket;
        if (config.socks5Relay) {
            tcpSocket = await socks5Connect(addressType, address, port, log, config.parsedSocks5Address)
        } else {
            tcpSocket = socks ? await socks5Connect(addressType, address, port, log, config.parsedSocks5Address)
                : connect({
                    hostname: address,
                    port: port,
                });
        }
        remoteSocket.value = tcpSocket;
        log(`connected to ${address}:${port}`);
        const writer = tcpSocket.writable.getWriter();
        await writer.write(rawClientData);
        writer.releaseLock();
        return tcpSocket;
    }

    async function retry() {
        let tcpSocket;
        if (config.enableSocks) {
            tcpSocket = await connectAndWrite(addressRemote, portRemote, true);
        } else {
            tcpSocket = await connectAndWrite(config.proxyIP || addressRemote, config.proxyPort || portRemote, false);
        }
        tcpSocket.closed.catch(error => {
            console.log('retry tcpSocket closed error', error);
        }).finally(() => {
            safeCloseWebSocket(webSocket);
        })
        RemoteSocketToWS(tcpSocket, webSocket, protocolResponseHeader, null, log);
    }

    let tcpSocket = await connectAndWrite(addressRemote, portRemote);

    RemoteSocketToWS(tcpSocket, webSocket, protocolResponseHeader, retry, log);
}

function MakeReadableWebSocketStream(webSocketServer, earlyDataHeader, log) {
    let readableStreamCancel = false;
    const stream = new ReadableStream({
        start(controller) {
            webSocketServer.addEventListener('message', (event) => {
                const message = event.data;
                controller.enqueue(message);
            });

            webSocketServer.addEventListener('close', () => {
                safeCloseWebSocket(webSocketServer);
                controller.close();
            });

            webSocketServer.addEventListener('error', (err) => {
                log('webSocketServer has error');
                controller.error(err);
            });
            const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
            if (error) {
                controller.error(error);
            } else if (earlyData) {
                controller.enqueue(earlyData);
            }
        },

        pull(_controller) {
        },

        cancel(reason) {
            log(`ReadableStream was canceled, due to ${reason}`)
            readableStreamCancel = true;
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
    const slicedBufferString = stringify(new Uint8Array(protocolBuffer.slice(1, 17)));

    const uuids = userID.includes(',') ? userID.split(",") : [userID];
    const isValidUser = uuids.some(uuid => slicedBufferString === uuid.trim()) ||
        (uuids.length === 1 && slicedBufferString === uuids[0].trim());

    console.log(`userID: ${slicedBufferString}`);

    if (!isValidUser) {
        return { hasError: true, message: 'invalid user' };
    }

    const optLength = dataView.getUint8(17);
    const command = dataView.getUint8(18 + optLength);

    if (command !== 1 && command !== 2) {
        return { hasError: true, message: `command ${command} is not supported, command 01-tcp,02-udp,03-mux` };
    }

    const portIndex = 18 + optLength + 1;
    const portRemote = dataView.getUint16(portIndex);
    const addressType = dataView.getUint8(portIndex + 2);
    let addressValue, addressLength, addressValueIndex;

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
        return { hasError: true, message: `addressValue is empty, addressType is ${addressType}` };
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

async function RemoteSocketToWS(remoteSocket, webSocket, protocolResponseHeader, retry, log) {
    let hasIncomingData = false;

    try {
        await remoteSocket.readable.pipeTo(
            new WritableStream({
                async write(chunk) {
                    if (webSocket.readyState !== WS_READY_STATE_OPEN) {
                        throw new Error('WebSocket is not open');
                    }

                    hasIncomingData = true;

                    if (protocolResponseHeader) {
                        webSocket.send(await new Blob([protocolResponseHeader, chunk]).arrayBuffer());
                        protocolResponseHeader = null;
                    } else {
                        webSocket.send(chunk);
                    }
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

function isValidUUID(uuid) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
}

const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;