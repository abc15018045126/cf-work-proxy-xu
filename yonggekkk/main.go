package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/google/uuid"       // For UUID generation and parsing
	"github.com/gorilla/websocket" // For WebSocket handling
)

// Global configuration variables, populated from environment or user input
var (
	UUID   string
	PORT   string
	DOMAIN string
	NAME   string
)

// upgrader is used to upgrade HTTP connections to WebSocket connections
var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		// Allow all origins for simplicity in this example
		return true
	},
}

func init() {
	// Initialize NAME from environment or hostname
	NAME = os.Getenv("NAME")
	if NAME == "" {
		hostname, err := os.Hostname()
		if err != nil {
			log.Printf("Failed to get hostname: %v, using 'default-server'", err)
			NAME = "default-server"
		} else {
			NAME = hostname
		}
	}
}

func main() {
	printProjectInfo()

	// Get configuration values
	UUID = getVariableValue("UUID", "")
	log.Printf("你的UUID: %s", UUID)

	PORT = getVariableValue("PORT", "")
	log.Printf("你的端口: %s", PORT)

	DOMAIN = getVariableValue("DOMAIN", "")
	log.Printf("你的域名: %s", DOMAIN)

	// Create HTTP server
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			// Handle root path
			w.Header().Set("Content-Type", "text/plain")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("Hello, World-YGkkk\n"))
		} else if r.URL.Path == "/"+UUID {
			// Handle Vless configuration path
			vlessURL := generateVlessURL(UUID, DOMAIN, NAME)
			w.Header().Set("Content-Type", "text/plain")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(vlessURL + "\n"))
		} else {
			// Handle 404 for other paths
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte("Not Found\n"))
		}
	})

	// Handle WebSocket connections for Vless protocol
	http.HandleFunc("/ws", handleWebSocket) // Assuming Vless path is "/ws"

	log.Printf("HTTP Server is running on port %s", PORT)
	log.Printf("vless-ws-tls节点分享: vless://%s@%s:443?encryption=none&security=tls&sni=%s&fp=chrome&type=ws&host=%s&path=%%2Fws#Vl-ws-tls-%s",
		UUID, DOMAIN, DOMAIN, DOMAIN, NAME) // Updated path to /ws

	// Start the HTTP server
	err := http.ListenAndServe(":"+PORT, nil)
	if err != nil {
		log.Fatalf("Failed to start HTTP server: %v", err)
	}
}

// printProjectInfo prints information about the project
func printProjectInfo() {
	fmt.Println("~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~")
	fmt.Println("甬哥Github项目 ：github.com/yonggekkk")
	fmt.Println("甬哥Blogger博客 ：ygkkk.blogspot.com")
	fmt.Println("甬哥YouTube频道 ：www.youtube.com/@ygkkk")
	fmt.Println("Nodejs真一键无交互Vless代理脚本 (Go 重构版)")
	fmt.Println("当前版本：25.6.9")
	fmt.Println("~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~")
}

// getVariableValue gets a variable value from environment or prompts the user
func getVariableValue(variableName, defaultValue string) string {
	envValue := os.Getenv(variableName)
	if envValue != "" {
		return envValue
	}
	if defaultValue != "" {
		return defaultValue
	}

	reader := bufio.NewReader(os.Stdin)
	var input string
	for {
		fmt.Printf("请输入%s: ", variableName)
		line, _ := reader.ReadString('\n')
		input = strings.TrimSpace(line)
		if input != "" {
			return input
		}
		fmt.Printf("%s不能为空，请重新输入!\n", variableName)
	}
}

// generateVlessURL generates the Vless configuration URL(s)
func generateVlessURL(uuidStr, domain, name string) string {
	baseVlessURL := fmt.Sprintf("vless://%s@%s:443?encryption=none&security=tls&sni=%s&fp=chrome&type=ws&host=%s&path=%%2Fws#Vl-ws-tls-%s",
		uuidStr, domain, domain, domain, name) // Updated path to /ws

	if strings.Contains(strings.ToLower(name), "server") || strings.Contains(strings.ToLower(name), "hostypanel") {
		// List of Cloudflare CDN IPs and IPv6 addresses
		cloudflareIPs := []string{
			"104.16.0.0", "104.17.0.0", "104.18.0.0", "104.19.0.0", "104.20.0.0",
			"104.21.0.0", "104.22.0.0", "104.24.0.0", "104.25.0.0", "104.26.0.0",
			"104.27.0.0",
		}
		cloudflareIPv6s := []string{
			"[2606:4700::]", "[2400:cb00:2049::]",
		}

		var urls []string
		urls = append(urls, baseVlessURL) // Add the primary domain URL first
		for _, ip := range cloudflareIPs {
			urls = append(urls, fmt.Sprintf("vless://%s@%s:443?encryption=none&security=tls&sni=%s&fp=chrome&type=ws&host=%s&path=%%2Fws#Vl-ws-tls-%s",
				uuidStr, ip, domain, domain, name)) // Updated path to /ws
		}
		for _, ipv6 := range cloudflareIPv6s {
			urls = append(urls, fmt.Sprintf("vless://%s@%s:443?encryption=none&security=tls&sni=%s&fp=chrome&type=ws&host=%s&path=%%2Fws#Vl-ws-tls-%s",
				uuidStr, ipv6, domain, domain, name)) // Updated path to /ws
		}
		return strings.Join(urls, "\n")
	}
	return baseVlessURL
}

// handleWebSocket handles the WebSocket connection and Vless protocol
func handleWebSocket(w http.ResponseWriter, r *http.Request) {
	// Upgrade the HTTP connection to a WebSocket connection
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WebSocket upgrade failed: %v", err)
		return
	}
	defer conn.Close()

	// Read the first message which contains the Vless handshake
	_, msg, err := conn.ReadMessage()
	if err != nil {
		log.Printf("Failed to read initial WebSocket message: %v", err)
		return
	}

	// Parse Vless handshake
	reader := bytes.NewReader(msg)

	// Version
	version, err := reader.ReadByte()
	if err != nil {
		log.Printf("Failed to read Vless version: %v", err)
		return
	}
	if version != 0x01 { // Vless protocol version 1
		log.Printf("Unsupported Vless version: %x", version)
		return
	}

	// UUID
	var clientUUID [16]byte
	_, err = io.ReadFull(reader, clientUUID[:])
	if err != nil {
		log.Printf("Failed to read client UUID: %v", err)
		return
	}

	// Validate UUID
	parsedUUID, err := uuid.Parse(UUID)
	if err != nil {
		log.Printf("Server UUID parse error: %v", err)
		return
	}
	if !bytes.Equal(clientUUID[:], parsedUUID[:]) {
		log.Println("UUID mismatch, closing connection.")
		return
	}

	// Read additional info byte (usually 0x00 for Vless version 1, indicating no additional data)
	_, err = reader.ReadByte() // info byte, usually 0x00
	if err != nil {
		log.Printf("Failed to read Vless info byte: %v", err)
		return
	}

	// Command (usually 0x01 for TCP)
	command, err := reader.ReadByte()
	if err != nil {
		log.Printf("Failed to read Vless command: %v", err)
		return
	}
	if command != 0x01 { // Only support TCP command (0x01)
		log.Printf("Unsupported Vless command: %x", command)
		return
	}

	// Target Address Type (ATYP)
	atyp, err := reader.ReadByte()
	if err != nil {
		log.Printf("Failed to read ATYP: %v", err)
		return
	}

	var host string
	switch atyp {
	case 0x01: // IPv4
		var ip [4]byte
		_, err = io.ReadFull(reader, ip[:])
		if err != nil {
			log.Printf("Failed to read IPv4 address: %v", err)
			return
		}
		host = net.IPv4(ip[0], ip[1], ip[2], ip[3]).String()
	case 0x02: // Domain Name
		len, err := reader.ReadByte()
		if err != nil {
			log.Printf("Failed to read domain length: %v", err)
			return
		}
		domainBytes := make([]byte, len)
		_, err = io.ReadFull(reader, domainBytes)
		if err != nil {
			log.Printf("Failed to read domain name: %v", err)
			return
		}
		host = string(domainBytes)
	case 0x03: // IPv6
		var ip [16]byte
		_, err = io.ReadFull(reader, ip[:])
		if err != nil {
			log.Printf("Failed to read IPv6 address: %v", err)
			return
		}
		host = net.IP(ip[:]).String()
	default:
		log.Printf("Unsupported ATYP: %x", atyp)
		return
	}

	// Target Port
	var port uint16
	err = binary.Read(reader, binary.BigEndian, &port)
	if err != nil {
		log.Printf("Failed to read target port: %v", err)
		return
	}
	targetAddr := fmt.Sprintf("%s:%d", host, port)
	log.Printf("Connecting to target: %s", targetAddr)

	// Send confirmation (Vless version 0x01, success 0x00)
	err = conn.WriteMessage(websocket.BinaryMessage, []byte{version, 0x00})
	if err != nil {
		log.Printf("Failed to send Vless confirmation: %v", err)
		return
	}

	// Establish TCP connection to target
	targetConn, err := net.DialTimeout("tcp", targetAddr, 10*time.Second) // 10-second timeout
	if err != nil {
		log.Printf("Failed to connect to target %s: %v", targetAddr, err)
		return
	}
	defer targetConn.Close()

	// Read remaining data from WebSocket initial message and pipe to target TCP
	// Create a buffer for the remaining data
	remainingMsgBuffer := new(bytes.Buffer)
	_, err = io.Copy(remainingMsgBuffer, reader)
	if err != nil {
		log.Printf("Failed to read remaining data from initial WebSocket message: %v", err)
		return
	}

	// If there's remaining data, write it to the target connection
	if remainingMsgBuffer.Len() > 0 {
		_, err := targetConn.Write(remainingMsgBuffer.Bytes())
		if err != nil {
			log.Printf("Failed to write initial remaining data to target: %v", err)
			return
		}
	}

	// Use channels to wait for both goroutines to finish
	done := make(chan struct{})

	// Goroutine for WebSocket to TCP
	go func() {
		defer close(done)
		for {
			mt, message, err := conn.ReadMessage()
			if err != nil {
				if websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
					log.Println("WebSocket closed normally.")
				} else {
					log.Printf("WebSocket read error: %v", err)
				}
				return
			}
			if mt != websocket.BinaryMessage {
				log.Println("Received non-binary message, skipping.")
				continue
			}
			_, err = targetConn.Write(message)
			if err != nil {
				log.Printf("Failed to write to target connection: %v", err)
				return
			}
		}
	}()

	// Goroutine for TCP to WebSocket
	go func() {
		defer close(done)
		buf := make([]byte, 4096) // Buffer for reading from TCP
		for {
			n, err := targetConn.Read(buf)
			if err != nil {
				if err == io.EOF {
					log.Println("Target TCP connection closed.")
				} else {
					log.Printf("Target TCP read error: %v", err)
				}
				return
			}
			err = conn.WriteMessage(websocket.BinaryMessage, buf[:n])
			if err != nil {
				log.Printf("Failed to write to WebSocket: %v", err)
				return
			}
		}
	}()

	<-done // Wait for one of the goroutines to close the done channel
	<-done // Wait for the other goroutine to close the done channel (if it hasn't already)
	log.Println("Connection handled.")
}
