package main

import (
	"fmt"
	"time"
)

func main() {
	fmt.Println("Hello from Go! This program will run for 10 seconds.")
	time.Sleep(10 * time.Second) // Make it run for 10 seconds
	fmt.Println("Test program finished.")
}
