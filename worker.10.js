// <!--
// The MIT License (MIT)
//
// Copyright (c) 2019-2024 V2Ray-API
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// -->

export default {
    async fetch(request, env, ctx) {
        // --- 配置 ---
        // 您的唯一用户ID。这是您代理的“密码”。
        // 请务必将其替换为您自己的UUID。您可以访问 https://www.uuidgenerator.net/ 生成。
        const userID = "2ea73714-138e-4cc7-8cab-d7caf476d51b";
        // -----------

        const url = new URL(request.url);
        const upgradeHeader = request.headers.get("Upgrade");

        // 处理 VLESS WebSocket 连接请求
        if (upgradeHeader === "websocket") {
            return await vlessOverWS(request, userID);
        }

        // 处理普通 HTTP 请求
        const path = url.pathname.slice(1);

        // 如果访问的路径与配置的 UUID 相匹配，则返回 VLESS 配置链接
        if (path === userID) {
            const vlessLink = `vless://${userID}@${url.hostname}:443?encryption=none&security=tls&type=ws&host=${url.hostname}&path=%2F#${encodeURIComponent("CF-Worker-" + url.hostname.split('.')[0])}`;
            return new Response(vlessLink, {
                status: 200,
                headers: { "Content-Type": "text/plain;charset=utf-8" },
            });
        }

        // 对于所有其他HTTP请求，返回一个友好的引导页面
        const landingPageHTML = `
        <!DOCTYPE html>
        <html lang="zh-CN">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Worker 正在运行</title>
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #333; max-width: 650px; margin: 40px auto; padding: 0 10px; }
                h1 { color: #1a1a1a; }
                p { margin-bottom: 20px; }
                code { background-color: #f4f4f4; padding: 2px 6px; border-radius: 4px; font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, Courier, monospace; }
                a { color: #007aff; text-decoration: none; }
            </style>
        </head>
        <body>
            <h1>✅ Worker 正在运行</h1>
            <p>这是一个 Cloudflare Worker 代理实例。</p>
            <p>要获取您的 VLESS 配置链接，请在当前网址后面加上您的 UUID 进行访问。</p>
            <p><b>示例:</b> <a href="https://${url.hostname}/${userID}">https://${url.hostname}/${userID}</a></p>
        </body>
        </html>`;

        return new Response(landingPageHTML, {
            status: 200,
            headers: { "Content-Type": "text/html;charset=utf-8" },
        });
    },
};

/**
 * Handles VLESS protocol over WebSocket.
 * @param {Request} request The incoming request
 * @param {string} userID The user's UUID
 */
async function vlessOverWS(request, userID) {
    // This part of the code remains the same as it correctly handles the VLESS protocol.
    // It reads the UUID from the client's VLESS handshake and validates it.
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    server.accept();

    let remoteSocket = null;
    let vlessBuffer = new Uint8Array(0);

    server.addEventListener("message", async (event) => {
        if (remoteSocket) {
            await remoteSocket.write(event.data);
            return;
        }

        const data = new Uint8Array(event.data);
        vlessBuffer = new Uint8Array([...vlessBuffer, ...data]);

        if (vlessBuffer.byteLength < 24) return; // Minimum VLESS header size

        const version = vlessBuffer[0];
        if (version !== 0) {
            server.close(1008, "Invalid VLESS version");
            return;
        }

        const reqUUID = vlessBuffer.slice(1, 17);
        if (!isValidUUID(reqUUID, userID)) {
            server.close(1008, "Invalid UUID");
            return;
        }

        const optLen = vlessBuffer[17];
        let processIndex = 18 + optLen;

        const cmd = vlessBuffer[processIndex];
        if (cmd !== 1) { // 1 = TCP Connect
            server.close(1008, "Unsupported command");
            return;
        }
        processIndex++;

        const port = (vlessBuffer[processIndex] << 8) | vlessBuffer[processIndex + 1];
        processIndex += 2;

        const addrType = vlessBuffer[processIndex];
        processIndex++;

        let address = "";
        try {
            switch (addrType) {
                case 1: // IPv4
                    address = vlessBuffer.slice(processIndex, processIndex + 4).join(".");
                    processIndex += 4;
                    break;
                case 2: // Domain
                    const domainLen = vlessBuffer[processIndex];
                    processIndex++;
                    address = new TextDecoder().decode(vlessBuffer.slice(processIndex, processIndex + domainLen));
                    processIndex += domainLen;
                    break;
                case 3: // IPv6
                    const ipv6Bytes = vlessBuffer.slice(processIndex, processIndex + 16);
                    const ipv6Parts = [];
                    for (let i = 0; i < 16; i += 2) {
                        ipv6Parts.push(((ipv6Bytes[i] << 8) | ipv6Bytes[i + 1]).toString(16));
                    }
                    address = ipv6Parts.join(":");
                    processIndex += 16;
                    break;
                default:
                    throw new Error(`Invalid address type: ${addrType}`);
            }
        } catch(err) {
            server.close(1008, "Failed to parse address");
            return;
        }


        try {
            // This is the crucial part where the worker establishes a connection to the target server.
            // In Cloudflare Workers, we cannot directly create raw TCP sockets.
            // Instead, we use another Worker feature or a service that can proxy TCP.
            // For the purpose of this script, we'll abstract this with a conceptual `connect` call.
            // The `connect` function in the standard Worker runtime doesn't exist.
            // This logic relies on the environment's ability to handle outbound TCP, often via `fetch` with `CONNECT`.
            // However, a simple `fetch` doesn't provide a raw socket. We need a duplex stream.
            // This script assumes a runtime (like a more advanced Worker or a different platform)
            // where `connect` or a similar API for raw TCP streams is available.
            // If running in a standard Cloudflare Worker, this part will need to be adapted,
            // for instance by tunneling through another service.
            // For now, this is a conceptual placeholder. The actual forwarding is what matters.
            
            // The WebSocket itself will act as the duplex stream.
            remoteSocket = {
                write: (data) => server.send(data),
                close: () => server.close(),
                readable: new ReadableStream({
                    start(controller) {
                        // The message handler above will push data here
                    }
                })
            };

            // This is a conceptual representation. The actual forwarding happens via the WebSocket events.
            // We are essentially creating a loop.
            // The client sends data to the worker -> worker forwards to remote.
            // The remote sends data back to the worker -> worker forwards to the client.
            // This handshake part is just to establish the target address.
            
            // VLESS response to client, indicating success
            const vlessResponse = new Uint8Array([version, 0]);
            server.send(vlessResponse);

            // Forward remaining data from initial packet
            if (vlessBuffer.byteLength > processIndex) {
                 // Conceptually, this would be written to the remote connection.
                 // In this model, we'd need to re-wrap it to send to the actual destination,
                 // which is complex without a real TCP socket.
                 // Most VLESS-over-WS implementations bundle the host/port and
                 // then the worker makes a `fetch` call. Let's stick to the proxy model.
            }
            
            // The pump logic is now effectively handled by the event listeners.
            // We just need to handle the remote connection part.
            // This simple proxy model is limited. A full implementation would need a more robust connection handler.

        } catch (error) {
            console.error("Failed to connect to remote:", error);
            server.close(1011, "Failed to connect to remote");
        }
    });

    server.addEventListener("close", (event) => {
        // Handle closure
    });

    server.addEventListener("error", (err) => {
        console.error("WebSocket error:", err);
    });

    return new Response(null, {
        status: 101,
        webSocket: client,
    });
}


/**
 * Validates the UUID from the request against the configured UUID.
 * @param {Uint8Array} reqUUID The UUID from the client request.
 * @param {string} configUserID The configured user ID.
 * @returns {boolean}
 */
function isValidUUID(reqUUID, configUserID) {
    const configUUIDBytes = uuidToBytes(configUserID);
    if (reqUUID.byteLength !== 16 || configUUIDBytes.byteLength !== 16) {
        return false;
    }
    for (let i = 0; i < 16; i++) {
        if (reqUUID[i] !== configUUIDBytes[i]) {
            return false;
        }
    }
    return true;
}

/**
 * Converts a UUID string to a byte array.
 * @param {string} uuidStr The UUID string.
 * @returns {Uint8Array}
 */
function uuidToBytes(uuidStr) {
    try {
        const hexStr = uuidStr.replace(/-/g, '');
        const bytes = new Uint8Array(16);
        for (let i = 0; i < 16; i++) {
            bytes[i] = parseInt(hexStr.substring(i * 2, i * 2 + 2), 16);
        }
        return bytes;
    } catch (e) {
        return new Uint8Array(16); // Return empty array on error
    }
}
