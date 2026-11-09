module example.com/sample

go 1.27.0

require (
	example.com/local v0.0.0
	github.com/gorilla/websocket v1.4.0
	github.com/sirupsen/logrus v1.8.0
	golang.org/x/text v0.3.5
)

require (
	github.com/magefile/mage v1.10.0 // indirect
	golang.org/x/sys v0.0.0-20191026070338-33540a1f6037 // indirect
)

replace example.com/local => ../local
